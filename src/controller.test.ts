import { expect, test } from "bun:test";
import { createDeviceController } from "./controller.js";
import { Device } from "./rpc.js";
import { HandleRegistry } from "./native/handle.js";
import type { CloseInput, DeviceRuntime } from "./native/runtime.js";
import { deviceError } from "./native/errors.js";

const caller = { serverID: "server-a", sessionID: "session-a" };
const selection = { platform: "android", deviceId: "phone" } as const;

function fixture() {
  const registry = new HandleRegistry();
  const calls: string[] = [];
  const closes: CloseInput[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime: DeviceRuntime = {
    async list() {
      return [];
    },
    async open(input) {
      calls.push("open");
      return {
        handle: registry.create(input.platform, input.deviceId),
        capabilities: { supported: [], unsupported: [] },
      };
    },
    async apps(handle) {
      registry.require(handle);
      calls.push("apps");
      return [];
    },
    async launch(input) {
      return { app: input.app, state: "launched" };
    },
    async install() {
      return { installed: true };
    },
    async snapshot(input) {
      return {
        token: input.handle.token,
        generation: input.handle.generation,
        revision: registry.nextSnapshot(input.handle),
        interactiveOnly: true,
        complete: true,
        nodes: [],
      };
    },
    async press(input) {
      registry.resolveReference(input.reference, input.handle);
      registry.invalidate(input.handle);
      calls.push("press");
    },
    async tap(input) {
      registry.invalidate(input.handle);
      calls.push("tap");
    },
    async fill() {
      calls.push("fill");
    },
    async swipe() {
      calls.push("swipe");
    },
    async key(input) {
      registry.require(input.handle);
      calls.push("key");
      started.resolve();
      await release.promise;
    },
    async screenshot(handle) {
      registry.require(handle);
      return {
        data: new Uint8Array(),
        width: 1,
        height: 1,
        deviceId: handle.deviceId,
        platform: handle.platform,
      };
    },
    async stream(handle) {
      registry.require(handle);
      return {
        platform: handle.platform,
        deviceId: handle.deviceId,
        baseUrl: "http://127.0.0.1:3400",
        token: "private",
        protocol: "h264",
        loopback: true,
      };
    },
    async close(input) {
      registry.require(input.handle);
      registry.release(input.handle);
      calls.push("close");
      closes.push(input);
    },
    async dispose() {
      calls.push("dispose");
    },
  };
  return {
    controller: createDeviceController(runtime),
    runtime,
    calls,
    closes,
    started,
    release,
  };
}

test.each([false, true])(
  "cancelled opens request shutdown and retry failed rollback on disposal, failure=%s",
  async (failure) => {
    const item = fixture();
    const open = item.runtime.open;
    item.runtime.open = async (input) => {
      item.started.resolve();
      await item.release.promise;
      return open(input);
    };
    const abort = new AbortController();
    const close = item.runtime.close;
    if (failure)
      item.runtime.close = async () => {
        throw deviceError("timeout", "shutdown failed", true);
      };
    const opening = item.controller.open(
      caller,
      { ...selection, boot: true },
      "manual",
      abort.signal,
    );
    const outcome = opening.catch((error: unknown) => error);
    await item.started.promise;
    abort.abort();
    item.release.resolve();
    expect(await outcome).toMatchObject(
      failure ? { data: { code: "timeout" } } : { name: "AbortError" },
    );
    expect(item.controller.state(caller)).toBeNull();
    if (failure) {
      item.runtime.close = close;
      await item.controller.dispose();
      expect(item.calls).toEqual(["open", "close", "dispose"]);
      expect(item.closes[0]?.shutdown).toBe(true);
      return;
    }
    expect(item.calls).toEqual(["open", "close"]);
    expect(item.closes[0]?.shutdown).toBe(true);
    await item.controller.open(caller, selection, "manual");
    expect(item.calls).toEqual(["open", "close", "open"]);
    await item.controller.dispose();
  },
);

test("failed shutdown rejects close and preserves the session for retry", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  const close = item.runtime.close;
  item.runtime.close = async () => {
    throw deviceError("timeout", "Android shutdown timed out.", true);
  };
  await expect(
    item.controller.close(caller, { handle: opened.handle, shutdown: true }, "manual"),
  ).rejects.toMatchObject({ data: { code: "timeout", mayHaveExecuted: true } });
  expect(item.controller.state(caller)?.handle).toEqual(opened.handle);
  item.runtime.close = close;
  await item.controller.close(caller, { handle: opened.handle, shutdown: true }, "manual");
  expect(item.controller.state(caller)).toBeNull();
  await item.controller.dispose();
});

test("agent access defaults on, can be revoked, and never exposes the stream token in attachment state", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  expect(opened.agentAccess).toBe(true);
  expect(opened).not.toHaveProperty("stream");
  expect(item.controller.state(caller)).not.toHaveProperty("token");
  expect(
    await item.controller.run(caller, { type: "apps", handle: opened.handle }, "agent"),
  ).toEqual({ type: "apps", apps: [] });
  item.controller.access(caller, false);
  expect((await item.controller.open(caller, selection, "manual")).agentAccess).toBe(false);
  await expect(
    item.controller.run(caller, { type: "apps", handle: opened.handle }, "agent"),
  ).rejects.toMatchObject({ code: "permission-denied" });
  item.controller.access(caller, true);
  expect(
    await item.controller.run(caller, { type: "apps", handle: opened.handle }, "agent"),
  ).toEqual({ type: "apps", apps: [] });
  expect(item.calls).toEqual(["open", "apps", "apps"]);
  await item.controller.dispose();
});

test("handles are bound to both server and session and agents cannot attach a different device", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  item.controller.access(caller, true);
  await expect(
    item.controller.run(
      { ...caller, serverID: "server-b" },
      { type: "screenshot", handle: opened.handle },
      "agent",
    ),
  ).rejects.toMatchObject({ code: "detached" });
  await expect(
    item.controller.run(
      { ...caller, sessionID: "session-b" },
      { type: "screenshot", handle: opened.handle },
      "agent",
    ),
  ).rejects.toMatchObject({ code: "detached" });
  await expect(
    item.controller.run(
      caller,
      { type: "screenshot", handle: { ...opened.handle, deviceId: "other" } },
      "agent",
    ),
  ).rejects.toMatchObject({ code: "permission-denied" });
  await expect(
    item.controller.open(caller, { ...selection, deviceId: "other" }, "agent"),
  ).rejects.toMatchObject({ code: "permission-denied" });
  expect(item.calls).toEqual(["open"]);
  await item.controller.dispose();
});

test("concurrent sessions cannot control the same physical device", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const opened = await Promise.allSettled([
    item.controller.open(caller, selection, "manual"),
    item.controller.open(other, selection, "manual"),
  ]);
  expect(opened[0].status).toBe("fulfilled");
  expect(opened[1]).toMatchObject({ status: "rejected", reason: { code: "device-busy" } });
  expect(item.controller.state(other)).toBeNull();
  expect(item.calls).toEqual(["open"]);
  await item.controller.dispose();
});

test("revoking agent access rejects a queued action without replaying it", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  item.controller.access(caller, true);
  const first = item.controller.run(
    caller,
    { type: "key", handle: opened.handle, key: "home" },
    "agent",
  );
  await item.started.promise;
  const second = item.controller.run(
    caller,
    { type: "key", handle: opened.handle, key: "back" },
    "agent",
  );
  const outcome = second.then(
    () => null,
    (error: unknown) => error,
  );
  item.controller.access(caller, false);
  item.release.resolve();
  await first;
  expect(await outcome).toMatchObject({ code: "permission-denied" });
  expect(item.calls).toEqual(["open", "key"]);
  await item.controller.dispose();
});

test("closing one session preserves another session's device", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(
    other,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  await item.controller.close(caller, { handle: first.handle }, "manual");
  expect(item.controller.state(caller)).toBeNull();
  expect(item.controller.state(other)?.handle).toEqual(second.handle);
  expect(item.calls).toEqual(["open", "open", "close"]);
  expect(await item.controller.stream(other, second.handle)).toMatchObject({
    deviceId: "iphone",
  });
  expect(
    await item.controller.run(other, { type: "apps", handle: second.handle }, "agent"),
  ).toEqual({ type: "apps", apps: [] });
  const reopened = await item.controller.open(caller, selection, "manual");
  expect(reopened.handle.token).not.toBe(first.handle.token);
  await item.controller.close(other, { handle: second.handle }, "manual");
  expect(item.calls).toEqual(["open", "open", "close", "apps", "open", "close"]);
  await item.controller.close(caller, { handle: reopened.handle }, "manual");
  expect(item.calls).toEqual(["open", "open", "close", "apps", "open", "close", "close"]);
  await item.controller.dispose();
});

test("actions on different session devices execute independently", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(
    other,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  const running = item.controller.run(
    caller,
    { type: "key", handle: first.handle, key: "home" },
    "agent",
  );
  await item.started.promise;
  const queued = item.controller.run(other, { type: "apps", handle: second.handle }, "agent");
  item.controller.access(caller, false);
  expect(await queued).toEqual({ type: "apps", apps: [] });
  expect(item.calls).toEqual(["open", "open", "key", "apps"]);
  item.release.resolve();
  await running;
  expect(item.calls).toEqual(["open", "open", "key", "apps"]);
  await item.controller.dispose();
});

test("snapshots remain isolated when another session interacts with its device", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(
    other,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  const value = await item.controller.run(
    other,
    { type: "snapshot", handle: second.handle },
    "agent",
  );
  if (value.type !== "snapshot") throw new Error("Expected a snapshot");
  expect(value.snapshot.token).toBe(second.handle.token);
  expect(value.snapshot.generation).toBe(second.handle.generation);
  const reference = {
    token: value.snapshot.token,
    generation: value.snapshot.generation,
    revision: value.snapshot.revision,
    ref: Device.ElementRef.make("e1"),
  };
  await expect(
    item.controller.run(caller, { type: "press", handle: first.handle, reference }, "agent"),
  ).rejects.toMatchObject({ code: "stale-reference" });
  expect(
    await item.controller.run(other, { type: "press", handle: second.handle, reference }, "agent"),
  ).toEqual({ type: "done" });
  const fresh = await item.controller.run(
    other,
    { type: "snapshot", handle: second.handle },
    "agent",
  );
  if (fresh.type !== "snapshot") throw new Error("Expected a snapshot");
  await item.controller.run(
    caller,
    { type: "tap", handle: first.handle, point: { x: 1, y: 1 } },
    "manual",
  );
  expect(
    await item.controller.run(
      other,
      {
        type: "press",
        handle: second.handle,
        reference: { ...reference, revision: fresh.snapshot.revision },
      },
      "agent",
    ),
  ).toEqual({ type: "done" });
  await item.controller.dispose();
});

test("shutdown cannot target another session's device", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  const other = { ...caller, sessionID: "session-b" };
  const separate = await item.controller.open(
    other,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  await expect(
    item.controller.close(caller, { handle: separate.handle, shutdown: true }, "manual"),
  ).rejects.toMatchObject({ code: "permission-denied" });
  expect(item.controller.state(other)?.handle).toEqual(separate.handle);
  expect(item.calls).toEqual(["open", "open"]);
  await item.controller.close(other, { handle: separate.handle }, "manual");
  await item.controller.close(caller, { handle: opened.handle, shutdown: true }, "manual");
  expect(item.calls).toEqual(["open", "open", "close", "close"]);
  await item.controller.dispose();
});

test("closing releases the device for another session and disposal prevents new attachments", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  await item.controller.close(caller, { handle: opened.handle }, "manual");
  expect(item.controller.state(caller)).toBeNull();
  await item.controller.open({ ...caller, sessionID: "session-b" }, selection, "manual");
  await item.controller.dispose();
  await expect(item.controller.open(caller, selection, "manual")).rejects.toMatchObject({
    code: "detached",
  });
  expect(item.calls).toEqual(["open", "close", "open", "dispose"]);
});

test("cancelling a queued action prevents dispatch while preserving the active action", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  item.controller.access(caller, true);
  const first = item.controller.run(
    caller,
    { type: "key", handle: opened.handle, key: "home" },
    "agent",
  );
  await item.started.promise;
  const abort = new AbortController();
  const second = item.controller.run(
    caller,
    { type: "key", handle: opened.handle, key: "back" },
    "agent",
    abort.signal,
  );
  const outcome = second.then(
    () => null,
    (error: unknown) => error,
  );
  abort.abort();
  item.release.resolve();
  await first;
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(item.calls).toEqual(["open", "key"]);
  await item.controller.dispose();
});

test("switches show the new device immediately, preserve ownership, and allow switching back during cleanup", async () => {
  const item = fixture();
  const first = await item.controller.open(caller, selection, "manual");
  item.controller.access(caller, false);
  const close = item.runtime.close;
  item.runtime.close = async (input) => {
    if (input.handle.token === first.handle.token) {
      item.started.resolve();
      await item.release.promise;
    }
    await close(input);
  };
  const second = await item.controller.open(
    caller,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  await item.started.promise;
  expect(item.controller.state(caller)?.handle).toEqual(second.handle);
  expect(second.agentAccess).toBe(false);
  expect(await item.controller.stream(caller, second.handle)).toMatchObject({ deviceId: "iphone" });
  await expect(item.controller.stream(caller, first.handle)).rejects.toMatchObject({
    code: "permission-denied",
  });
  await expect(
    item.controller.open({ ...caller, sessionID: "other" }, selection, "manual"),
  ).rejects.toMatchObject({ code: "device-busy" });
  const returning = item.controller.open(caller, selection, "manual");
  item.release.resolve();
  const returned = await returning;
  expect(returned.handle.platform).toBe("android");
  expect(returned.handle.token).not.toBe(first.handle.token);
  expect(returned.agentAccess).toBe(false);
  await item.controller.dispose();
  expect(item.calls).toEqual(["open", "open", "close", "open", "close", "dispose"]);
});

test("a failed switch preserves the current screen and attachment", async () => {
  const item = fixture();
  const first = await item.controller.open(caller, selection, "manual");
  item.runtime.open = async () => {
    throw deviceError("helper-failed", "capture failed");
  };
  await expect(
    item.controller.open(caller, { platform: "ios", deviceId: "iphone" }, "manual"),
  ).rejects.toMatchObject({ code: "helper-failed" });
  expect(item.controller.state(caller)?.handle).toEqual(first.handle);
  expect(await item.controller.stream(caller, first.handle)).toMatchObject({ deviceId: "phone" });
  await item.controller.dispose();
});

test("failed retired cleanup is retried on disposal without reverting the active device", async () => {
  const item = fixture();
  const first = await item.controller.open(caller, selection, "manual");
  const close = item.runtime.close;
  let failures = 0;
  item.runtime.close = async (input) => {
    if (input.handle.token === first.handle.token && failures++ === 0)
      throw deviceError("timeout", "cleanup failed");
    await close(input);
  };
  const second = await item.controller.open(
    caller,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  expect(item.controller.state(caller)?.handle).toEqual(second.handle);
  await item.controller.dispose();
  expect(item.calls).toEqual(["open", "open", "close", "dispose"]);
});

test("a switch does not wait for an old in-flight action and never replays queued input on the new device", async () => {
  const item = fixture();
  const first = await item.controller.open(caller, selection, "manual");
  const active = item.controller.run(
    caller,
    { type: "key", handle: first.handle, key: "home" },
    "agent",
  );
  await item.started.promise;
  const queued = item.controller
    .run(caller, { type: "key", handle: first.handle, key: "back" }, "agent")
    .catch((error: unknown) => error);
  const second = await item.controller.open(
    caller,
    { platform: "ios", deviceId: "iphone" },
    "manual",
  );
  expect(await item.controller.stream(caller, second.handle)).toMatchObject({ deviceId: "iphone" });
  expect(item.calls).toEqual(["open", "key", "open"]);
  item.release.resolve();
  await active;
  expect(await queued).toMatchObject({ code: "permission-denied" });
  await item.controller.dispose();
  expect(item.calls).toEqual(["open", "key", "open", "close", "dispose"]);
});

test("a newer selection does not wait for a cancelled boot's cleanup and the cancelled device never becomes active", async () => {
  const item = fixture();
  await item.controller.open(caller, selection, "manual");
  const open = item.runtime.open;
  let cancelled: AbortSignal | undefined;
  item.runtime.open = async (input, signal) => {
    if (input.platform === "ios") {
      cancelled = signal;
      item.started.resolve();
      await item.release.promise;
    }
    return open(input);
  };
  const previous = item.controller
    .open(caller, { platform: "ios", deviceId: "iphone" }, "manual")
    .catch((error: unknown) => error);
  await item.started.promise;
  item.controller.access(caller, false);
  expect(await item.controller.list()).toEqual([]);
  const latest = await item.controller.open(
    caller,
    { ...selection, deviceId: "other-phone" },
    "manual",
  );
  expect(cancelled?.aborted).toBe(true);
  expect(latest.agentAccess).toBe(false);
  expect(await item.controller.stream(caller, latest.handle)).toMatchObject({
    deviceId: "other-phone",
  });
  item.release.resolve();
  expect(await previous).toMatchObject({ name: "AbortError" });
  expect(item.controller.state(caller)?.handle).toEqual(latest.handle);
  expect(item.closes.find((input) => input.handle.deviceId === "iphone")?.shutdown).toBe(true);
  await item.controller.dispose();
});
