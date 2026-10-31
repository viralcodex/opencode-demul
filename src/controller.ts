import { Device } from "./rpc.js";
import type { DeviceBridge } from "./bridge.js";
import { deviceError } from "./native/errors.js";
import { HandleRegistry } from "./native/handle.js";
import type { CloseInput, DeviceRuntime, OpenInput, OpenResult } from "./native/runtime.js";

export interface DeviceCaller {
  serverID: string;
  sessionID: string;
}

export type DeviceOrigin = "manual" | "agent";

interface Attachment {
  selection: OpenInput;
  device: OpenResult;
  connection: SharedDevice;
  agentAccess: boolean;
}

interface SharedDevice {
  device: OpenResult;
  pending: Promise<void>;
  sessions: Set<Attachment>;
}

export function createDeviceController(runtime: DeviceRuntime) {
  const sessions = new Map<string, Attachment>();
  const devices = new Map<string, SharedDevice>();
  const handles = new HandleRegistry();
  let transitions = Promise.resolve();
  let disposed = false;

  const sessionKey = (caller: DeviceCaller) => JSON.stringify([caller.serverID, caller.sessionID]);
  const deviceKey = (platform: Device.Platform, deviceId: string) =>
    JSON.stringify([platform, deviceId]);
  const report = (entry: Attachment) => ({
    handle: entry.device.handle,
    capabilities: entry.device.capabilities,
    agentAccess: entry.agentAccess,
  });
  const requireSession = (caller: DeviceCaller) => {
    if (disposed) throw deviceError("detached", "The device controller has stopped.");
    const entry = sessions.get(sessionKey(caller));
    if (!entry) throw deviceError("detached", "Attach a device in the Device panel first.");
    return entry;
  };
  const requireHandle = (
    caller: DeviceCaller,
    handle: Device.DeviceHandle,
    origin: DeviceOrigin,
  ) => {
    const entry = requireSession(caller);
    const expected = entry.device.handle;
    if (
      expected.token !== handle.token ||
      expected.generation !== handle.generation ||
      expected.platform !== handle.platform ||
      expected.deviceId !== handle.deviceId
    )
      throw deviceError(
        "permission-denied",
        "This handle does not belong to this session's attached device.",
      );
    if (origin === "agent" && !entry.agentAccess) {
      throw deviceError("permission-denied", "Enable agent access in the Device panel first.");
    }
    return entry;
  };
  const reference = (entry: Attachment, value: Device.SnapshotReference) => {
    if (
      value.token !== entry.device.handle.token ||
      value.generation !== entry.device.handle.generation
    ) {
      throw deviceError(
        "stale-reference",
        "This element reference belongs to a different session; take a new snapshot.",
      );
    }
    return {
      ...value,
      token: entry.connection.device.handle.token,
      generation: entry.connection.device.handle.generation,
    };
  };
  const transition = <Result>(action: () => Promise<Result>) => {
    const result = transitions.then(action);
    transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const execute = <Result>(
    caller: DeviceCaller,
    handle: Device.DeviceHandle,
    origin: DeviceOrigin,
    action: (entry: Attachment) => Promise<Result>,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const entry = requireHandle(caller, handle, origin);
    const result = entry.connection.pending.then(() => {
      signal?.throwIfAborted();
      requireHandle(caller, handle, origin);
      return action(entry);
    });
    entry.connection.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async list(platform?: Device.Platform) {
      if (disposed) throw deviceError("detached", "The device controller has stopped.");
      return runtime.list(platform);
    },
    state(caller: DeviceCaller) {
      const entry = sessions.get(sessionKey(caller));
      return entry ? report(entry) : null;
    },
    access(caller: DeviceCaller, enabled: boolean) {
      const entry = requireSession(caller);
      entry.agentAccess = enabled;
      return report(entry);
    },
    async open(caller: DeviceCaller, input: OpenInput, origin: DeviceOrigin, signal?: AbortSignal) {
      return transition(async () => {
        signal?.throwIfAborted();
        if (disposed) throw deviceError("detached", "The device controller has stopped.");
        const current = sessions.get(sessionKey(caller));
        if (current) {
          if (
            current.selection.platform !== input.platform ||
            current.selection.deviceId !== input.deviceId
          ) {
            throw deviceError(
              "device-busy",
              "Close the attached device before selecting another device.",
            );
          }
          requireHandle(caller, current.device.handle, origin);
          return report(current);
        }
        if (origin === "agent")
          throw deviceError(
            "permission-denied",
            "Attach a device and enable agent access in the Device panel first.",
          );
        const key = deviceKey(input.platform, input.deviceId);
        const existing = devices.get(key);
        const device = existing?.device ?? (await runtime.open(input));
        if (signal?.aborted) {
          if (!existing) await runtime.close({ handle: device.handle });
          signal.throwIfAborted();
        }
        const physicalKey = deviceKey(device.handle.platform, device.handle.deviceId);
        if (!existing && devices.has(physicalKey)) {
          await runtime.close({ handle: device.handle });
          throw deviceError("device-busy", "Another session has attached this device.");
        }
        const connection: SharedDevice = existing ?? {
          device,
          pending: Promise.resolve(),
          sessions: new Set(),
        };
        const entry: Attachment = {
          selection: input,
          device: {
            ...device,
            handle: handles.create(device.handle.platform, device.handle.deviceId),
          },
          connection,
          agentAccess: true,
        };
        connection.sessions.add(entry);
        sessions.set(sessionKey(caller), entry);
        devices.set(key, connection);
        devices.set(physicalKey, connection);
        return report(entry);
      });
    },
    async stream(caller: DeviceCaller, handle: Device.DeviceHandle) {
      return execute(caller, handle, "manual", (entry) =>
        runtime.stream(entry.connection.device.handle),
      );
    },
    async run(
      caller: DeviceCaller,
      operation: Exclude<DeviceBridge.Operation, { type: "list" | "state" | "open" | "close" }>,
      origin: DeviceOrigin,
      signal?: AbortSignal,
    ): Promise<DeviceBridge.Value> {
      return execute(
        caller,
        operation.handle,
        origin,
        async (entry) => {
          const handle = entry.connection.device.handle;
          switch (operation.type) {
            case "apps":
              return { type: "apps", apps: await runtime.apps(handle) };
            case "launch":
              return { type: "launch", result: await runtime.launch({ ...operation, handle }) };
            case "install":
              return { type: "install", result: await runtime.install({ ...operation, handle }) };
            case "snapshot": {
              const snapshot = await runtime.snapshot({ ...operation, handle });
              return {
                type: "snapshot",
                snapshot: {
                  ...snapshot,
                  token: entry.device.handle.token,
                  generation: entry.device.handle.generation,
                },
              };
            }
            case "screenshot":
              return { type: "screenshot", screenshot: await runtime.screenshot(handle) };
            case "press":
              await runtime.press({
                ...operation,
                handle,
                reference: reference(entry, operation.reference),
              });
              break;
            case "tap":
              await runtime.tap({ ...operation, handle });
              break;
            case "fill":
              await runtime.fill({
                ...operation,
                handle,
                reference: reference(entry, operation.reference),
              });
              break;
            case "swipe":
              await runtime.swipe({ ...operation, handle });
              break;
            case "key":
              await runtime.key({ ...operation, handle });
          }
          return { type: "done" };
        },
        signal,
      );
    },
    async close(
      caller: DeviceCaller,
      input: CloseInput,
      origin: DeviceOrigin,
      signal?: AbortSignal,
    ) {
      return transition(async () => {
        await execute(
          caller,
          input.handle,
          origin,
          async (entry) => {
            if (input.shutdown && entry.connection.sessions.size > 1) {
              throw deviceError(
                "device-busy",
                "Detach other sessions before shutting down this device.",
              );
            }
            if (entry.connection.sessions.size === 1) {
              await runtime.close({ ...input, handle: entry.connection.device.handle });
            }
            sessions.delete(sessionKey(caller));
            handles.release(entry.device.handle);
            entry.connection.sessions.delete(entry);
            if (entry.connection.sessions.size) return;
            devices.forEach((connection, key) => {
              if (connection === entry.connection) devices.delete(key);
            });
          },
          signal,
        );
      });
    },
    async dispose() {
      return transition(async () => {
        disposed = true;
        await Promise.all([...new Set(devices.values())].map((connection) => connection.pending));
        sessions.forEach((entry) => handles.release(entry.device.handle));
        sessions.clear();
        devices.clear();
        await runtime.dispose();
      });
    },
  };
}

export type DeviceController = ReturnType<typeof createDeviceController>;
