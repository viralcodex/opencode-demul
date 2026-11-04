import { Device } from "./rpc.js";
import type { DeviceBridge } from "./bridge.js";
import { deviceError } from "./native/errors.js";
import type { CloseInput, DeviceRuntime, OpenInput, OpenResult } from "./native/runtime.js";

export interface DeviceCaller {
  serverID: string;
  sessionID: string;
}

export type DeviceOrigin = "manual" | "agent";
type BoundOperation = Exclude<
  DeviceBridge.Operation,
  { type: "list" | "state" | "open" | "close" }
>;
type Inspection = Extract<BoundOperation, { type: "apps" | "snapshot" | "screenshot" }>;
type Mutation = Exclude<BoundOperation, Inspection>;

interface Attachment {
  selection: OpenInput;
  device: OpenResult;
  pending: Promise<void>;
  agentAccess: boolean;
  closing: boolean;
}

export function createDeviceController(runtime: DeviceRuntime) {
  const sessions = new Map<string, Attachment>();
  const devices = new Map<string, Attachment>();
  const reservations = new Set<string>();
  const rollbacks = new Map<string, OpenResult>();
  const transitions = new Map<string, Promise<void>>();
  const opening = new Map<string, AbortController>();
  const preparing = new Map<Promise<void>, { session: string; device: string }>();
  const retiring = new Map<Attachment, { session: string; pending: Promise<void> }>();
  let disposed = false;

  const sessionKey = (caller: DeviceCaller) => JSON.stringify([caller.serverID, caller.sessionID]);
  const deviceKey = (platform: Device.Platform, deviceId: string) =>
    JSON.stringify([platform, deviceId]);
  const report = (entry: Attachment) => ({
    handle: entry.device.handle,
    selection: { platform: entry.selection.platform, deviceId: entry.selection.deviceId },
    capabilities: entry.device.capabilities,
    agentAccess: entry.agentAccess,
  });
  const requireSession = (caller: DeviceCaller) => {
    if (disposed) throw deviceError("detached", "The device controller has stopped.");
    const entry = sessions.get(sessionKey(caller));
    if (!entry) throw deviceError("detached", "Attach a device in the Device panel first.");
    if (entry.closing) throw deviceError("device-busy", "This session is changing its device.");
    return entry;
  };
  const requireHandle = (
    caller: DeviceCaller,
    handle: Device.DeviceHandle,
    origin: DeviceOrigin,
  ) => {
    const entry = requireSession(caller);
    const expected = entry.device.handle;
    if (!Device.sameHandle(expected, handle))
      throw deviceError(
        "permission-denied",
        "This handle does not belong to this session's attached device.",
      );
    if (origin === "agent" && !entry.agentAccess) {
      throw deviceError("permission-denied", "Enable agent access in the Device panel first.");
    }
    return entry;
  };
  const transition = <Result>(caller: DeviceCaller, action: () => Promise<Result>) => {
    const key = sessionKey(caller);
    const result = (transitions.get(key) ?? Promise.resolve()).then(action);
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    transitions.set(key, pending);
    void pending.then(() => {
      if (transitions.get(key) === pending) transitions.delete(key);
    });
    return result;
  };
  const prepare = <Result>(
    caller: DeviceCaller,
    input: OpenInput,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<Result>,
  ) => {
    const session = sessionKey(caller);
    const device = deviceKey(input.platform, input.deviceId);
    opening.get(session)?.abort();
    const abort = new AbortController();
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    opening.set(session, abort);
    const cleanup = [...preparing]
      .filter(([, previous]) => previous.session === session && previous.device === device)
      .map(([pending]) => pending);
    const result = Promise.all(cleanup).then(() => {
      combined.throwIfAborted();
      return action(combined);
    });
    const pending = result.then(
      () => undefined,
      () => undefined,
    );
    preparing.set(pending, { session, device });
    void pending.then(() => {
      preparing.delete(pending);
      if (opening.get(session) === abort) opening.delete(session);
    });
    return result;
  };
  const forget = (entry: Attachment) => {
    devices.forEach((value, key) => {
      if (value === entry) devices.delete(key);
    });
  };
  const release = async (entry: Attachment, shutdown?: boolean, signal?: AbortSignal) => {
    entry.closing = true;
    try {
      await entry.pending;
      signal?.throwIfAborted();
      await runtime.close({ handle: entry.device.handle, ...(shutdown ? { shutdown } : {}) });
      forget(entry);
    } catch (error) {
      entry.closing = false;
      throw error;
    }
  };
  const retire = (caller: DeviceCaller, entry: Attachment) => {
    const pending = release(entry).then(
      () => {
        retiring.delete(entry);
      },
      // Keep ownership until reopening or disposal retries failed cleanup.
      () => undefined,
    );
    retiring.set(entry, { session: sessionKey(caller), pending });
  };
  const finishRetirement = async (caller: DeviceCaller, input: OpenInput) => {
    const entry = devices.get(deviceKey(input.platform, input.deviceId));
    const cleanup = entry && retiring.get(entry);
    if (!entry || !cleanup || cleanup.session !== sessionKey(caller)) return;
    await cleanup.pending;
    if (!retiring.has(entry)) return;
    await release(entry);
    retiring.delete(entry);
  };
  const rollback = async (key: string, device: OpenResult) => {
    rollbacks.set(key, device);
    await runtime.close({ handle: device.handle, shutdown: true });
    rollbacks.delete(key);
  };
  const discard = async (entry: Attachment) => {
    try {
      await rollback(deviceKey(entry.selection.platform, entry.selection.deviceId), entry.device);
    } finally {
      forget(entry);
    }
  };
  const acquire = async (input: OpenInput, signal?: AbortSignal): Promise<Attachment> => {
    const key = deviceKey(input.platform, input.deviceId);
    if (devices.has(key) || reservations.has(key))
      throw deviceError("device-busy", "This device is controlled by another session.");
    reservations.add(key);
    try {
      const device = rollbacks.get(key) ?? (await runtime.open(input, signal));
      const physicalKey = deviceKey(device.handle.platform, device.handle.deviceId);
      if (devices.has(physicalKey)) {
        await runtime.close({ handle: device.handle });
        throw deviceError("device-busy", "This device is controlled by another session.");
      }
      if (signal?.aborted || disposed) {
        await rollback(key, device);
        signal?.throwIfAborted();
        throw deviceError("detached", "The device controller has stopped.");
      }
      const entry: Attachment = {
        selection: input,
        device,
        pending: Promise.resolve(),
        agentAccess: true,
        closing: false,
      };
      rollbacks.delete(key);
      devices.set(key, entry);
      devices.set(physicalKey, entry);
      return entry;
    } finally {
      reservations.delete(key);
    }
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
    const result = entry.pending.then(() => {
      signal?.throwIfAborted();
      requireHandle(caller, handle, origin);
      return action(entry);
    });
    entry.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const inspect = async (operation: Inspection): Promise<DeviceBridge.Value> => {
    switch (operation.type) {
      case "apps":
        return { type: "apps", apps: await runtime.apps(operation.handle) };
      case "snapshot":
        return { type: "snapshot", snapshot: await runtime.snapshot(operation) };
      case "screenshot":
        return { type: "screenshot", screenshot: await runtime.screenshot(operation.handle) };
    }
  };
  const mutate = async (operation: Mutation): Promise<DeviceBridge.Value> => {
    switch (operation.type) {
      case "launch":
        return { type: "launch", result: await runtime.launch(operation) };
      case "install":
        return { type: "install", result: await runtime.install(operation) };
      case "press":
        await runtime.press(operation);
        break;
      case "tap":
        await runtime.tap(operation);
        break;
      case "fill":
        await runtime.fill(operation);
        break;
      case "swipe":
        await runtime.swipe(operation);
        break;
      case "key":
        await runtime.key(operation);
    }
    return { type: "done" };
  };

  return {
    async list(platform?: Device.Platform, caller?: DeviceCaller, signal?: AbortSignal) {
      if (disposed) throw deviceError("detached", "The device controller has stopped.");
      const own = caller ? sessions.get(sessionKey(caller)) : undefined;
      const listed = await runtime.list(platform, signal);
      signal?.throwIfAborted();
      return listed.map((device) => {
        const key = deviceKey(device.platform, device.id);
        const owner = devices.get(key);
        if (owner)
          return {
            ...device,
            ownership:
              owner === own || (caller && retiring.get(owner)?.session === sessionKey(caller))
                ? ("owned-by-this-host" as const)
                : ("owned-by-other" as const),
          };
        return reservations.has(key) ? { ...device, ownership: "owned-by-other" as const } : device;
      });
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
      signal?.throwIfAborted();
      if (disposed) throw deviceError("detached", "The device controller has stopped.");
      const current = sessions.get(sessionKey(caller));
      if (current && devices.get(deviceKey(input.platform, input.deviceId)) === current) {
        requireHandle(caller, current.device.handle, origin);
        if (origin === "manual") opening.get(sessionKey(caller))?.abort();
        return report(current);
      }
      if (origin === "agent")
        throw deviceError(
          "permission-denied",
          "Attach a device and enable agent access in the Device panel first.",
        );
      return prepare(caller, input, signal, async (signal) => {
        await finishRetirement(caller, input);
        signal.throwIfAborted();
        const entry = await acquire(input, signal);
        try {
          return await transition(caller, async () => {
            signal.throwIfAborted();
            const current = sessions.get(sessionKey(caller));
            entry.agentAccess = current?.agentAccess ?? true;
            sessions.set(sessionKey(caller), entry);
            if (current) retire(caller, current);
            return report(entry);
          });
        } catch (error) {
          await discard(entry);
          throw error;
        }
      });
    },
    async stream(caller: DeviceCaller, handle: Device.DeviceHandle) {
      return execute(caller, handle, "manual", (entry) => runtime.stream(entry.device.handle));
    },
    async run(
      caller: DeviceCaller,
      operation: BoundOperation,
      origin: DeviceOrigin,
      signal?: AbortSignal,
    ): Promise<DeviceBridge.Value> {
      return execute(
        caller,
        operation.handle,
        origin,
        () => {
          switch (operation.type) {
            case "apps":
            case "snapshot":
            case "screenshot":
              return inspect(operation);
            default:
              return mutate(operation);
          }
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
      signal?.throwIfAborted();
      requireHandle(caller, input.handle, origin);
      opening.get(sessionKey(caller))?.abort();
      return transition(caller, async () => {
        signal?.throwIfAborted();
        const entry = requireHandle(caller, input.handle, origin);
        await release(entry, input.shutdown, signal);
        sessions.delete(sessionKey(caller));
      });
    },
    async detach(caller: DeviceCaller) {
      opening.get(sessionKey(caller))?.abort();
      return transition(caller, async () => {
        const entry = sessions.get(sessionKey(caller));
        if (!entry) return;
        await release(entry);
        sessions.delete(sessionKey(caller));
      });
    },
    async dispose() {
      disposed = true;
      for (const abort of opening.values()) abort.abort();
      await Promise.all(preparing.keys());
      await Promise.all(transitions.values());
      await Promise.all([...retiring.values()].map((cleanup) => cleanup.pending));
      await Promise.allSettled([...retiring.keys()].map((entry) => release(entry)));
      retiring.clear();
      await Promise.all([...new Set(devices.values())].map((entry) => entry.pending));
      sessions.clear();
      devices.clear();
      for (const [key, device] of rollbacks) {
        await runtime.close({ handle: device.handle, shutdown: true });
        rollbacks.delete(key);
      }
      await runtime.dispose();
    },
  };
}

export type DeviceController = ReturnType<typeof createDeviceController>;
