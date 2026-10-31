import { expect, test } from "bun:test";
import { createDeviceController } from "./controller.js";
import { Device } from "./rpc.js";
import { HandleRegistry } from "./native/handle.js";
import type { DeviceRuntime } from "./native/runtime.js";
import { deviceError } from "./native/errors.js";

const caller = { serverID: "server-a", sessionID: "session-a" };
const selection = { platform: "android", deviceId: "phone" } as const;

function fixture() {
  const registry = new HandleRegistry();
  const calls: string[] = [];
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
        protocol: "mjpeg",
        loopback: true,
      };
    },
    async close(input) {
      registry.require(input.handle);
      registry.release(input.handle);
      calls.push("close");
    },
    async dispose() {
      calls.push("dispose");
    },
  };
  return { controller: createDeviceController(runtime), runtime, calls, started, release };
}

test("cancelling an in-flight open releases native resources without attaching the session", async () => {
  const item = fixture();
  const open = item.runtime.open;
  item.runtime.open = async (input) => {
    item.started.resolve();
    await item.release.promise;
    return open(input);
  };
  const abort = new AbortController();
  const opening = item.controller.open(caller, selection, "manual", abort.signal);
  const outcome = opening.catch((error: unknown) => error);
  await item.started.promise;
  abort.abort();
  item.release.resolve();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(item.controller.state(caller)).toBeNull();
  expect(item.calls).toEqual(["open", "close"]);
  await item.controller.open(caller, selection, "manual");
  expect(item.calls).toEqual(["open", "close", "open"]);
  await item.controller.dispose();
});

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
  ).rejects.toMatchObject({ code: "device-busy" });
  expect(item.calls).toEqual(["open"]);
  await item.controller.dispose();
});

test("concurrent sessions share one physical device with separate handles and access grants", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const opened = await Promise.all([
    item.controller.open(caller, selection, "manual"),
    item.controller.open(other, selection, "manual"),
  ]);
  expect(opened[0].handle.token).not.toBe(opened[1].handle.token);
  expect(item.controller.state(caller)?.handle).toEqual(opened[0].handle);
  expect(item.controller.state(other)?.handle).toEqual(opened[1].handle);
  item.controller.access(caller, false);
  expect(item.controller.state(other)?.agentAccess).toBe(true);
  await expect(
    item.controller.run(other, { type: "screenshot", handle: opened[0].handle }, "agent"),
  ).rejects.toMatchObject({ code: "permission-denied" });
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

test("closing one session preserves the shared device until the last session detaches", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(other, selection, "manual");
  await item.controller.close(caller, { handle: first.handle }, "manual");
  expect(item.controller.state(caller)).toBeNull();
  expect(item.controller.state(other)?.handle).toEqual(second.handle);
  expect(item.calls).toEqual(["open"]);
  expect(await item.controller.stream(other, second.handle)).toMatchObject({
    deviceId: selection.deviceId,
  });
  expect(
    await item.controller.run(other, { type: "apps", handle: second.handle }, "agent"),
  ).toEqual({ type: "apps", apps: [] });
  const reopened = await item.controller.open(caller, selection, "manual");
  expect(reopened.handle.token).not.toBe(first.handle.token);
  await item.controller.close(other, { handle: second.handle }, "manual");
  expect(item.calls).toEqual(["open", "apps"]);
  await item.controller.close(caller, { handle: reopened.handle }, "manual");
  expect(item.calls).toEqual(["open", "apps", "close"]);
  await item.controller.dispose();
});

test("actions from different sessions share the device queue without sharing access grants", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(other, selection, "manual");
  const running = item.controller.run(
    caller,
    { type: "key", handle: first.handle, key: "home" },
    "agent",
  );
  await item.started.promise;
  const queued = item.controller.run(other, { type: "apps", handle: second.handle }, "agent");
  item.controller.access(caller, false);
  expect(item.calls).toEqual(["open", "key"]);
  item.release.resolve();
  await running;
  expect(await queued).toEqual({ type: "apps", apps: [] });
  expect(item.calls).toEqual(["open", "key", "apps"]);
  await item.controller.dispose();
});

test("shared snapshots keep session references isolated and invalidate after another session interacts", async () => {
  const item = fixture();
  const other = { ...caller, sessionID: "session-b" };
  const first = await item.controller.open(caller, selection, "manual");
  const second = await item.controller.open(other, selection, "manual");
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
  await expect(
    item.controller.run(
      other,
      {
        type: "press",
        handle: second.handle,
        reference: { ...reference, revision: fresh.snapshot.revision },
      },
      "agent",
    ),
  ).rejects.toMatchObject({ code: "stale-reference" });
  await item.controller.dispose();
});

test("shutdown cannot close a device still attached by another session", async () => {
  const item = fixture();
  const opened = await item.controller.open(caller, selection, "manual");
  const other = { ...caller, sessionID: "session-b" };
  const shared = await item.controller.open(other, selection, "manual");
  await expect(
    item.controller.close(caller, { handle: opened.handle, shutdown: true }, "manual"),
  ).rejects.toMatchObject({ code: "device-busy" });
  expect(item.controller.state(other)?.handle).toEqual(shared.handle);
  expect(item.calls).toEqual(["open"]);
  await item.controller.close(other, { handle: shared.handle }, "manual");
  await item.controller.close(caller, { handle: opened.handle, shutdown: true }, "manual");
  expect(item.calls).toEqual(["open", "close"]);
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
