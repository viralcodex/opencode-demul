import { Device } from "./rpc.js";
import type { DeviceBridge } from "./bridge.js";
import { cancellationError, deviceError, isDeviceFailure } from "./native/errors.js";
import type { CloseInput, DeviceRuntime, OpenInput, OpenResult } from "./native/runtime.js";
import { DEVICE_OPERATION_TIMEOUT_MS } from "./deadlines.js";
import { OperationQueue } from "./operation-queue.js";

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
const isInspection = (operation: BoundOperation): operation is Inspection =>
  ["apps", "snapshot", "screenshot"].includes(operation.type);

interface Attachment {
  session: string;
  selection: OpenInput;
  device: OpenResult;
  queue: OperationQueue;
  agentAccess: boolean;
  state: AttachmentState;
}

type CleanupReason = "close" | "retire" | "rollback";
type AttachmentState =
  | { type: "preparing" | "attached" | "released" }
  | { type: "cleanup"; reason: CleanupReason; shutdown: boolean; pending: Promise<void> }
  | { type: "cleanup-failed"; reason: CleanupReason; shutdown: boolean };
type Reservation = { session: string; state: { type: "reserved" } };

export function createDeviceController(
  runtime: DeviceRuntime,
  operationTimeoutMs = DEVICE_OPERATION_TIMEOUT_MS,
) {
  const sessions = new Map<string, Attachment>();
  const devices = new Map<string, Attachment | Reservation>();
  const transitions = new Map<string, Promise<void>>();
  const opening = new Map<string, AbortController>();
  const preparing = new Map<Promise<void>, { session: string; device: string }>();
  const lifetime = new AbortController();

  const sessionKey = (caller: DeviceCaller) => JSON.stringify([caller.serverID, caller.sessionID]);
  const deviceKey = (platform: Device.Platform, deviceId: string) =>
    JSON.stringify([platform, deviceId]);
  const attachmentFor = (key: string) => {
    const slot = devices.get(key);
    return slot && "device" in slot ? slot : undefined;
  };
  const occupied = (key: string, reservation: Reservation) =>
    devices.has(key) && devices.get(key) !== reservation;
  const report = (entry: Attachment) => ({
    handle: entry.device.handle,
    selection: { platform: entry.selection.platform, deviceId: entry.selection.deviceId },
    capabilities: entry.device.capabilities,
    agentAccess: entry.agentAccess,
  });
  const requireSession = (caller: DeviceCaller, cleanup = false) => {
    if (lifetime.signal.aborted)
      throw deviceError("detached", "The device controller has stopped.");
    const entry = sessions.get(sessionKey(caller));
    if (!entry) throw deviceError("detached", "Attach a device in the Device panel first.");
    if (entry.state.type === "cleanup-failed" && !cleanup)
      throw deviceError("detached", "Device cleanup is incomplete; retry closing this attachment.");
    if (entry.state.type === "cleanup")
      throw deviceError("device-busy", "This session is changing its device.");
    return entry;
  };
  const requireHandle = (
    caller: DeviceCaller,
    handle: Device.DeviceHandle,
    origin: DeviceOrigin,
    cleanup = false,
  ) => {
    const entry = requireSession(caller, cleanup);
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
    sessions.forEach((value, key) => {
      if (value === entry) sessions.delete(key);
    });
  };
  const release = (
    entry: Attachment,
    reason: CleanupReason,
    shutdown = false,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (entry.state.type === "released") return Promise.resolve();
    if (entry.state.type === "cleanup") return entry.state.pending;
    const previous = entry.state;
    if (previous.type === "cleanup-failed") {
      reason = previous.reason;
      shutdown ||= previous.shutdown;
    }
    const pending = entry.queue.drain().then(async () => {
      if (signal?.aborted) {
        entry.state = previous;
        signal.throwIfAborted();
      }
      try {
        await runtime.close({ handle: entry.device.handle, ...(shutdown ? { shutdown } : {}) });
        entry.state = { type: "released" };
        forget(entry);
      } catch (error) {
        entry.state = { type: "cleanup-failed", reason, shutdown };
        throw error;
      }
    });
    entry.state = { type: "cleanup", reason, shutdown, pending };
    return pending;
  };
  const finishCleanup = async (entry: Attachment) => {
    if (entry.state.type === "cleanup") await entry.state.pending.catch(() => undefined);
    if (entry.state.type === "cleanup-failed")
      await release(entry, entry.state.reason, entry.state.shutdown);
  };
  const finishPrevious = async (caller: DeviceCaller, input: OpenInput) => {
    const entry = attachmentFor(deviceKey(input.platform, input.deviceId));
    if (entry?.session === sessionKey(caller)) await finishCleanup(entry);
  };
  const acquire = async (
    caller: DeviceCaller,
    input: OpenInput,
    signal?: AbortSignal,
  ): Promise<Attachment> => {
    const key = deviceKey(input.platform, input.deviceId);
    if (devices.has(key))
      throw deviceError("device-busy", "This device is controlled by another session.");
    const reservation: Reservation = { session: sessionKey(caller), state: { type: "reserved" } };
    devices.set(key, reservation);
    try {
      signal?.throwIfAborted();
      const device = await runtime.open(input, signal);
      const entry: Attachment = {
        session: sessionKey(caller),
        selection: input,
        device,
        queue: new OperationQueue(),
        agentAccess: true,
        state: { type: "preparing" },
      };
      const physicalKey = deviceKey(device.handle.platform, device.handle.deviceId);
      const busy = occupied(physicalKey, reservation);
      devices.set(key, entry);
      if (busy) {
        await release(entry, "rollback");
        throw deviceError("device-busy", "This device is controlled by another session.");
      }
      devices.set(physicalKey, entry);
      if (signal?.aborted || lifetime.signal.aborted) {
        await release(entry, "rollback", true);
        signal?.throwIfAborted();
        throw deviceError("detached", "The device controller has stopped.");
      }
      return entry;
    } finally {
      if (devices.get(key) === reservation) devices.delete(key);
    }
  };
  const execute = <Result>(
    caller: DeviceCaller,
    handle: Device.DeviceHandle,
    origin: DeviceOrigin,
    action: (entry: Attachment, signal: AbortSignal) => Promise<Result>,
    signal?: AbortSignal,
    mutation = false,
  ) => {
    signal?.throwIfAborted();
    const entry = requireHandle(caller, handle, origin);
    const combined = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(operationTimeoutMs),
      ...(signal ? [signal] : []),
    ]);
    return entry.queue.run(async () => {
      requireHandle(caller, handle, origin);
      try {
        const result = await action(entry, combined);
        if (combined.aborted) throw cancellationError(combined, mutation);
        return result;
      } catch (error) {
        if (isDeviceFailure(error)) throw error;
        if (combined.aborted) throw cancellationError(combined, mutation);
        throw error;
      }
    }, combined);
  };
  const inspect = async (
    operation: Inspection,
    signal: AbortSignal,
  ): Promise<DeviceBridge.Value> => {
    switch (operation.type) {
      case "apps":
        return { type: "apps", apps: await runtime.apps(operation.handle, signal) };
      case "snapshot":
        return { type: "snapshot", snapshot: await runtime.snapshot(operation, signal) };
      case "screenshot":
        return {
          type: "screenshot",
          screenshot: await runtime.screenshot(operation.handle, signal),
        };
    }
  };
  const mutate = async (operation: Mutation, signal: AbortSignal): Promise<DeviceBridge.Value> => {
    switch (operation.type) {
      case "launch":
        return { type: "launch", result: await runtime.launch(operation, signal) };
      case "install":
        return { type: "install", result: await runtime.install(operation, signal) };
      case "press":
        await runtime.press(operation, signal);
        break;
      case "tap":
        await runtime.tap(operation, signal);
        break;
      case "fill":
        await runtime.fill(operation, signal);
        break;
      case "swipe":
        await runtime.swipe(operation, signal);
        break;
      case "key":
        await runtime.key(operation, signal);
    }
    return { type: "done" };
  };

  return {
    async list(platform?: Device.Platform, caller?: DeviceCaller, signal?: AbortSignal) {
      if (lifetime.signal.aborted)
        throw deviceError("detached", "The device controller has stopped.");
      const own = caller ? sessions.get(sessionKey(caller)) : undefined;
      const listed = await runtime.list(platform, signal);
      signal?.throwIfAborted();
      return listed.map((device) => {
        const key = deviceKey(device.platform, device.id);
        const owner = attachmentFor(key);
        if (owner)
          return {
            ...device,
            ownership:
              owner === own || (caller && owner.session === sessionKey(caller))
                ? ("owned-by-this-host" as const)
                : ("owned-by-other" as const),
          };
        return devices.has(key) ? { ...device, ownership: "owned-by-other" as const } : device;
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
      if (lifetime.signal.aborted)
        throw deviceError("detached", "The device controller has stopped.");
      const current = sessions.get(sessionKey(caller));
      if (
        current?.state.type === "attached" &&
        devices.get(deviceKey(input.platform, input.deviceId)) === current
      ) {
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
        await finishPrevious(caller, input);
        signal.throwIfAborted();
        const entry = await acquire(caller, input, signal);
        try {
          return await transition(caller, async () => {
            signal.throwIfAborted();
            const current = sessions.get(sessionKey(caller));
            entry.agentAccess = current?.agentAccess ?? true;
            entry.state = { type: "attached" };
            sessions.set(sessionKey(caller), entry);
            if (current) void release(current, "retire").catch(() => undefined);
            return report(entry);
          });
        } catch (error) {
          await release(entry, "rollback", true);
          throw error;
        }
      });
    },
    async stream(caller: DeviceCaller, handle: Device.DeviceHandle, signal?: AbortSignal) {
      return execute(
        caller,
        handle,
        "manual",
        (entry, signal) => runtime.stream(entry.device.handle, signal),
        signal,
      );
    },
    async run(
      caller: DeviceCaller,
      operation: BoundOperation,
      origin: DeviceOrigin,
      signal?: AbortSignal,
    ): Promise<DeviceBridge.Value> {
      const inspection = isInspection(operation);
      return execute(
        caller,
        operation.handle,
        origin,
        (_, signal) => (inspection ? inspect(operation, signal) : mutate(operation, signal)),
        signal,
        !inspection,
      );
    },
    async close(
      caller: DeviceCaller,
      input: CloseInput,
      origin: DeviceOrigin,
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      requireHandle(caller, input.handle, origin, true);
      opening.get(sessionKey(caller))?.abort();
      return transition(caller, async () => {
        signal?.throwIfAborted();
        const entry = requireHandle(caller, input.handle, origin, true);
        await release(entry, "close", input.shutdown, signal);
      });
    },
    async detach(caller: DeviceCaller) {
      opening.get(sessionKey(caller))?.abort();
      return transition(caller, async () => {
        const entry = sessions.get(sessionKey(caller));
        if (!entry) return;
        await release(entry, "close");
      });
    },
    async dispose() {
      lifetime.abort();
      for (const abort of opening.values()) abort.abort();
      await Promise.all(preparing.keys());
      await Promise.all(transitions.values());
      const entries = [...new Set(devices.values())].filter((slot) => "device" in slot);
      const results = await Promise.allSettled(entries.map(finishCleanup));
      await Promise.all(entries.map((entry) => entry.queue.drain()));
      sessions.clear();
      // Runtime disposal must still run when rollback cleanup fails.
      results.push(
        ...(await Promise.allSettled([
          runtime.dispose().then(() => {
            for (const entry of entries) {
              if (entry.state.type !== "attached") continue;
              entry.state = { type: "released" };
              forget(entry);
            }
          }),
        ])),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

export type DeviceController = ReturnType<typeof createDeviceController>;
