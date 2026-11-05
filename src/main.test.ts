import { afterEach, expect, test } from "bun:test";
import { EventEmitter, on } from "node:events";
import { join } from "node:path";
import type { OpenCodeClient, RpcClient } from "@opencode/client/promise";
import type { IpcImpl, IpcProvider } from "@opencode/plugin/gui";
import type { MainContext } from "@opencode/plugin/gui/main";
import { Session } from "@opencode/schema/session";
import { Schema } from "effect";
import { DeviceBridge } from "./bridge.js";
import { DeviceIpc } from "./ipc.js";
import { createDeviceController } from "./controller.js";
import { createMainSetup, runOperation } from "./main.js";
import { HandleRegistry } from "./native/handle.js";
import type { DeviceRuntime } from "./native/runtime.js";
import { waitWithSignal } from "./cancellation.js";

const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of teardown.splice(0).reverse()) await cleanup();
});

function fixture() {
  const registry = new HandleRegistry();
  const calls: string[] = [];
  const streamToken = "renderer-only-secret";
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected device operation.");
  };
  const runtime: DeviceRuntime = {
    async list() {
      calls.push("list");
      return [];
    },
    async open(input) {
      calls.push("open");
      return {
        handle: registry.create(input.platform, input.deviceId),
        capabilities: { supported: ["apps", "stream"], unsupported: [] },
      };
    },
    async apps() {
      calls.push("apps");
      return [];
    },
    launch: unexpected,
    install: unexpected,
    snapshot: unexpected,
    press: unexpected,
    tap: unexpected,
    fill: unexpected,
    swipe: unexpected,
    key: unexpected,
    screenshot: unexpected,
    async stream(handle) {
      calls.push("stream");
      return {
        platform: handle.platform,
        deviceId: handle.deviceId,
        baseUrl: "http://127.0.0.1:3400",
        token: streamToken,
        protocol: "h264",
        loopback: true,
      };
    },
    async close() {
      calls.push("close");
    },
    async dispose() {
      calls.push("dispose");
    },
  };
  return { runtime, calls, streamToken };
}

test("routes operations through the controller and returns typed failures", async () => {
  const item = fixture();
  const controller = createDeviceController(item.runtime);
  const caller = { serverID: "desktop-connection", sessionID: "session" };
  const opened = await runOperation(
    controller,
    caller,
    { type: "open", platform: "android", deviceId: "phone" },
    "manual",
  );
  expect(opened.type).toBe("success");
  if (opened.type !== "success" || opened.value.type !== "attachment")
    throw new Error("expected attachment");
  expect(opened.value.attachment.agentAccess).toBe(true);
  controller.access(caller, false);
  const denied = await runOperation(
    controller,
    caller,
    { type: "apps", handle: opened.value.attachment.handle },
    "agent",
  );
  expect(denied).toMatchObject({ type: "failure", error: { code: "permission-denied" } });
  controller.access(caller, true);
  expect(
    await runOperation(
      controller,
      caller,
      { type: "apps", handle: opened.value.attachment.handle },
      "agent",
    ),
  ).toMatchObject({ type: "success", value: { type: "apps", apps: [] } });
  expect(item.calls).toEqual(["open", "apps"]);
  await expect(
    runOperation(
      controller,
      caller,
      { type: "open", platform: "ios", deviceId: "iphone" },
      "manual",
      AbortSignal.abort(),
    ),
  ).resolves.toMatchObject({ type: "failure", error: { code: "detached" } });
  await controller.dispose();
});

async function mainFixture(retryDelayMs = 1) {
  const item = fixture();
  const sessionID = Session.ID.create();
  const location = { directory: "/device-test-project" };
  const operations = new Map<string, DeviceBridge.Operation>();
  const outcomes = new Map<string, DeviceBridge.Outcome>();
  const commandFetches: string[] = [];
  const listeners = new Set<(data: DeviceBridge.Control) => void>();
  const control = (data: DeviceBridge.Control) => listeners.forEach((listener) => listener(data));
  const eventStarted = Promise.withResolvers<void>();
  const eventReady = Promise.withResolvers<void>();
  const events = new EventEmitter();
  const logs: string[] = [];
  const state = {
    subscriptions: 0,
    reportStarted: 0,
    report: undefined as Promise<void> | undefined,
    reportFailure: false,
  };
  let attachment: { sessionID: string; connectionID: string } | undefined;
  let implementation: IpcImpl<typeof DeviceIpc.Bridge.spec> | undefined;
  let constructions = 0;
  const cleanups: Array<() => void | Promise<void>> = [];

  const rpc: RpcClient<typeof DeviceBridge.ControlRpc> = {
    attach: async (input, options) => {
      if (input.sessionID === sessionID) expect(options?.location).toEqual(location);
      attachment = input;
      queueMicrotask(() =>
        control({ type: "attached", connectionID: input.connectionID, version: 1 }),
      );
      return new Promise((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve("closed"), { once: true }),
      );
    },
    state: async (input, options) => {
      state.reportStarted++;
      if (state.reportFailure) throw new Error("state reporting failed");
      if (state.report) await state.report;
      if (input.sessionID === sessionID) expect(options?.location).toEqual(location);
    },
    command: async (input, options) => {
      expect(options?.location).toEqual(location);
      commandFetches.push(input.requestID);
      const operation = operations.get(input.requestID);
      if (!operation) throw new Error("missing operation");
      return operation;
    },
    result: async (input, options) => {
      expect(options?.location).toEqual(location);
      outcomes.set(input.requestID, Schema.decodeSync(DeviceBridge.Outcome)(input.outcome));
    },
    events: {
      subscribe: () => ({ async *[Symbol.asyncIterator]() {} }),
      on: (_name, handler) => {
        const listener = (data: DeviceBridge.Control) =>
          void (handler as unknown as (event: { data: DeviceBridge.Control }) => void)({ data });
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  const provider = {
    changed: () => undefined,
    emit: () => undefined,
    dispose: () => undefined,
  } as IpcProvider<typeof DeviceIpc.Bridge.spec>;
  const context = {
    id: "demul.device",
    client: {
      rpc: () => rpc,
      event: {
        subscribe: (options?: { signal?: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            state.subscriptions++;
            eventStarted.resolve();
            await waitWithSignal(eventReady.promise, options?.signal);
            yield { type: "server.connected" };
            for await (const [event] of on(events, "event", {
              signal: options?.signal,
              close: ["end"],
            }))
              yield event;
          },
        }),
      },
    } as unknown as OpenCodeClient,
    serverEndpoints: {
      get: (id: string) => (id === "sidecar" ? { sameMachine: true } : { sameMachine: false }),
    },
    log: { write: (_level: string, message: string) => logs.push(message) },
    windows: {
      on: () => () => undefined,
    },
    provide: (_token: typeof DeviceIpc.Bridge, value: IpcImpl<typeof DeviceIpc.Bridge.spec>) => {
      implementation = value;
      return provider;
    },
    onCleanup: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
  } as unknown as MainContext;

  await createMainSetup(() => {
    constructions++;
    return item.runtime;
  }, retryDelayMs)(context);
  if (!implementation) throw new Error("IPC implementation was not provided");
  const ipc = implementation;
  const scope = { sessionID, serverID: "sidecar", location };
  const ipcCaller = { window: 7, signal: new AbortController().signal };
  const dispose = async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  };
  teardown.push(dispose);
  return {
    ...item,
    ipc,
    scope,
    ipcCaller,
    sessionID,
    eventStarted,
    eventReady,
    events,
    logs,
    state,
    operations,
    outcomes,
    commandFetches,
    control,
    dispose,
    get constructions() {
      return constructions;
    },
    get attachment() {
      return attachment;
    },
  };
}

test("main initializes only for a local connection and waits for its readiness announcement", async () => {
  const item = await mainFixture();
  const { ipc, scope, ipcCaller, eventStarted, eventReady, sessionID } = item;
  expect(item.constructions).toBe(0);
  await expect(ipc.connect({ sessionID, serverID: "remote" }, ipcCaller)).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(await ipc.list({ serverID: "remote" }, ipcCaller)).toMatchObject({
    type: "failure",
    error: { code: "unsupported" },
  });
  expect(item.constructions).toBe(0);
  const connecting = ipc.connect(scope, ipcCaller);
  await eventStarted.promise;
  expect(item.attachment).toBeUndefined();
  eventReady.resolve();
  await connecting;
  expect(item.constructions).toBe(1);
  const attachment = item.attachment;
  expect(attachment?.sessionID).toBe(sessionID);
  expect(attachment?.connectionID).toMatch(/^[a-f0-9-]{36}$/);
});

test("viewer proxies confine credentials, rotate with capture, and stop when the window unsubscribes", async () => {
  const item = await mainFixture();
  const handle = await attach(item);
  const { ipc, scope, ipcCaller } = item;
  const stream = await ipc.stream({ scope, handle }, ipcCaller);
  if (stream.type !== "success") throw new Error("expected proxy stream");
  expect(stream.stream.token).not.toBe(item.streamToken);
  expect(stream.stream.baseUrl).not.toBe("http://127.0.0.1:3400");
  expect((await fetch(`${stream.stream.baseUrl}/secret`)).status).toBe(404);

  const originalStream = item.runtime.stream;
  item.runtime.stream = async (handle, signal) => ({
    ...(await originalStream(handle, signal)),
    token: "recovered-hub-secret",
  });
  const recovered = await ipc.stream({ scope, handle }, ipcCaller);
  if (recovered.type !== "success") throw new Error("expected recovered proxy stream");
  expect(recovered.stream.baseUrl).not.toBe(stream.stream.baseUrl);
  expect(recovered.stream.token).not.toBe("recovered-hub-secret");
  await expect(fetch(`${stream.stream.baseUrl}/video`)).rejects.toThrow();
  expect((await fetch(`${recovered.stream.baseUrl}/video`)).status).toBe(426);
  await ipc.disconnect(scope, ipcCaller);
  await expect(fetch(`${recovered.stream.baseUrl}/video`)).rejects.toThrow();
  expect(item.calls).not.toContain("close");
  await item.dispose();
  expect(item.calls).toContain("dispose");
});

test("commands enforce access, preserve typed failures, and never dispatch a duplicate request", async () => {
  const item = await mainFixture();
  const handle = await attach(item);
  const { ipc, scope, ipcCaller, operations, outcomes, control, commandFetches } = item;
  const connectionID = item.attachment!.connectionID;
  const command = async (requestID: string, operation?: DeviceBridge.Operation) => {
    if (operation) operations.set(requestID, operation);
    control({ type: "command", connectionID, requestID });
    await eventually(() => outcomes.has(requestID));
    return outcomes.get(requestID);
  };
  await ipc.access({ scope, enabled: false }, ipcCaller);
  expect(await command("list", { type: "list", platform: "android" })).toMatchObject({
    type: "success",
    value: { type: "devices", devices: [] },
  });
  control({ type: "cancel", connectionID, requestID: "missing" });
  expect(await command("missing")).toMatchObject({
    type: "failure",
    error: { code: "internal", mayHaveExecuted: false },
  });
  expect(await command("denied", { type: "apps", handle })).toMatchObject({
    type: "failure",
    error: { code: "permission-denied" },
  });
  expect(JSON.stringify(outcomes.get("denied"))).not.toContain(item.streamToken);

  await ipc.access({ scope, enabled: true }, ipcCaller);
  operations.set("apps", { type: "apps", handle });
  control({ type: "command", connectionID, requestID: "apps" });
  control({ type: "command", connectionID, requestID: "apps" });
  await eventually(() => outcomes.has("apps"));
  expect(commandFetches.filter((requestID) => requestID === "apps")).toHaveLength(1);
  expect(item.calls.filter((call) => call === "apps")).toHaveLength(1);
});

test("window membership preserves device attachments without weakening session isolation", async () => {
  const item = await mainFixture();
  const handle = await attach(item);
  const { ipc, scope, ipcCaller } = item;
  const otherScope = { ...scope, sessionID: Session.ID.create() };
  const other = await attach(item, "other-phone", otherScope);
  expect(ipc.state(7)).toHaveLength(2);
  expect(
    await ipc.manual({ scope: otherScope, operation: { type: "apps", handle } }, ipcCaller),
  ).toMatchObject({ type: "failure", error: { code: "permission-denied" } });
  expect(await ipc.manual({ scope, operation: { type: "apps", handle } }, ipcCaller)).toMatchObject(
    { type: "success", value: { type: "apps" } },
  );
  await ipc.disconnect(otherScope, ipcCaller);
  expect(ipc.state(7)).toMatchObject([{ scope, state: { handle, agentAccess: true } }]);
  await ipc.connect(otherScope, ipcCaller);
  expect(ipc.state(7)).toContainEqual({
    scope: otherScope,
    state: expect.objectContaining({ handle: other }),
  });
  expect(item.calls).not.toContain("close");
  expect(item.calls.filter((call) => call === "open")).toHaveLength(2);
});

async function attach(
  item: Awaited<ReturnType<typeof mainFixture>>,
  deviceId = "phone",
  scope = item.scope,
) {
  item.eventReady.resolve();
  await item.ipc.connect(scope, item.ipcCaller);
  const result = await item.ipc.manual(
    { scope, operation: { type: "open", platform: "android", deviceId } },
    item.ipcCaller,
  );
  if (result.type !== "success" || result.value.type !== "attachment")
    throw new Error("expected attachment");
  expect(result.value.attachment.agentAccess).toBe(true);
  expect(JSON.stringify(result)).not.toContain(item.streamToken);
  return result.value.attachment.handle;
}

test("failed readiness reporting closes the connection and a fresh connection can retry", async () => {
  const item = await mainFixture();
  item.state.reportFailure = true;
  const connecting = item.ipc.connect(item.scope, item.ipcCaller);
  item.eventReady.resolve();
  await expect(connecting).rejects.toThrow("state reporting failed");
  const previous = item.attachment!.connectionID;
  expect(item.ipc.state(7)).toEqual([]);
  item.state.reportFailure = false;
  await item.ipc.connect(item.scope, item.ipcCaller);
  expect(item.attachment!.connectionID).not.toBe(previous);
  item.control({ type: "command", connectionID: previous, requestID: "obsolete" });
  expect(item.commandFetches).toEqual([]);
  expect(item.constructions).toBe(1);
});

test("cancelling connect during reporting cannot publish a late ready connection", async () => {
  const item = await mainFixture();
  const report = Promise.withResolvers<void>();
  teardown.push(() => report.resolve());
  item.state.report = report.promise;
  const abort = new AbortController();
  const connecting = item.ipc.connect(item.scope, { window: 7, signal: abort.signal });
  item.eventReady.resolve();
  await eventually(() => item.state.reportStarted > 0);
  abort.abort();
  await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
  await eventually(() => item.ipc.state(7).length === 0);
  report.resolve();
  item.state.report = undefined;
  await item.ipc.connect(item.scope, item.ipcCaller);
  expect(item.ipc.state(7)).toHaveLength(1);
  expect(item.logs).toEqual([]);
});

test.each([
  { ending: "error", type: "session.deleted" },
  { ending: "end", type: "session.moved" },
])("the watcher reconnects after $ending and handles $type", async ({ ending, type }) => {
  const item = await mainFixture();
  await attach(item);
  await eventually(() => item.events.listenerCount("event") === 1);
  item.events.emit(ending, new Error("event stream lost"));
  await eventually(
    () => item.state.subscriptions === 3 && item.events.listenerCount("event") === 1,
  );
  item.events.emit("event", { type, data: { sessionID: item.sessionID } });
  await eventually(() => item.calls.includes("close"));
  expect(item.ipc.state(7)).toEqual([]);
  expect(item.logs).toContain("device session events failed; reconnecting");
});

test("failed session cleanup retains ownership, retries, and does not block another session's cleanup", async () => {
  const item = await mainFixture();
  const first = await attach(item);
  const other = { ...item.scope, sessionID: Session.ID.create() };
  await attach(item, "other-phone", other);
  const release = Promise.withResolvers<void>();
  teardown.push(() => release.resolve());
  const close = item.runtime.close;
  let attempts = 0;
  item.runtime.close = async (input) => {
    if (input.handle.token === first.token) {
      if (++attempts === 1) throw new Error("cleanup failed");
      await release.promise;
    }
    await close(input);
  };
  for (const sessionID of [item.sessionID, other.sessionID])
    item.events.emit("event", { type: "session.deleted", data: { sessionID } });
  await eventually(
    () => attempts === 2 && item.calls.filter((call) => call === "close").length === 1,
  );
  const next = { ...item.scope, sessionID: Session.ID.create() };
  await item.ipc.connect(next, item.ipcCaller);
  await expect(
    item.ipc.manual(
      { scope: next, operation: { type: "open", platform: "android", deviceId: "phone" } },
      item.ipcCaller,
    ),
  ).resolves.toMatchObject({ type: "failure", error: { code: "device-busy" } });
  release.resolve();
  await eventually(() => item.calls.filter((call) => call === "close").length === 2);
  await attach(item, "phone", next);
  expect(item.logs).toContain("device session cleanup failed; retrying");
});

test("disposal cancels watcher backoff without leaving a subscription or retry timer", async () => {
  const item = await mainFixture(1_000);
  await attach(item);
  await eventually(() => item.events.listenerCount("event") === 1);
  item.events.emit("error", new Error("event stream lost"));
  await eventually(() => item.logs.includes("device session events failed; reconnecting"));
  const subscriptions = item.state.subscriptions;
  await item.dispose();
  expect(item.events.listenerCount("event")).toBe(0);
  expect(item.events.listenerCount("error")).toBe(0);
  expect(item.state.subscriptions).toBe(subscriptions);
  expect(item.calls.at(-1)).toBe("dispose");
  await expect(item.ipc.connect(item.scope, item.ipcCaller)).rejects.toMatchObject({
    name: "AbortError",
  });
});

test("the main WebSocket bundle decodes masked frames without native addons", async () => {
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      String.raw`
    import { build } from "vite"
    import { createRequire } from "node:module"
    import { once } from "node:events"
    import { dirname, join } from "node:path"
    const require = createRequire(import.meta.url)
    const result = await build({
      configFile: "vite.config.ts",
      configLoader: "runner",
      logLevel: "silent",
      plugins: [{
        name: "verify-ws-receiver",
        enforce: "pre",
        resolveId(source) {
          if (source.replaceAll("\\", "/").endsWith("/src/gui.tsx")) return "\0verify-ws-receiver"
        },
        load(id) {
          if (id !== "\0verify-ws-receiver") return
          return "export { Receiver } from " + JSON.stringify(join(dirname(require.resolve("ws/package.json")), "index.js"))
        },
      }],
      build: { write: false },
    })
    const output = Array.isArray(result) ? result[0] : result
    const chunk = output.output.find(item => item.type === "chunk" && item.isEntry)
    const module = { exports: {} }
    new Function("require", "module", "exports", chunk.code)(
      name => name === "bufferutil" ? {} : require(name), module, module.exports,
    )
    const receiver = new module.exports.Receiver({ isServer: true, maxPayload: 4096 })
    const payload = Buffer.alloc(128, 97)
    const mask = Buffer.from([7, 9, 11, 13])
    const encoded = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]))
    const received = once(receiver, "message")
    receiver.write(Buffer.concat([Buffer.from([129, 254, 0, payload.length]), mask, encoded]))
    const [message] = await received
    if (!message.equals(payload)) throw new Error("Bundled masked frame decoded incorrectly")
    receiver.destroy()
    console.log("decoded")
  `,
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  expect(stdout.trim()).toBe("decoded");
});

async function eventually(condition: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
