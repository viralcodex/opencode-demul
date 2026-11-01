import { expect, test } from "bun:test";
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

function fixture() {
  const registry = new HandleRegistry();
  const calls: string[] = [];
  const streamToken = "renderer-only-secret";
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
    async launch(input) {
      calls.push("launch");
      return { app: input.app, state: "launched" };
    },
    async install() {
      calls.push("install");
      return { installed: true };
    },
    async snapshot(input) {
      calls.push("snapshot");
      return {
        token: input.handle.token,
        generation: input.handle.generation,
        revision: 1,
        interactiveOnly: true,
        complete: true,
        nodes: [],
      };
    },
    async press() {
      calls.push("press");
    },
    async tap() {
      calls.push("tap");
    },
    async fill() {
      calls.push("fill");
    },
    async swipe() {
      calls.push("swipe");
    },
    async key() {
      calls.push("key");
    },
    async screenshot(handle) {
      calls.push("screenshot");
      return {
        data: new Uint8Array(),
        width: 1,
        height: 1,
        deviceId: handle.deviceId,
        platform: handle.platform,
      };
    },
    async stream(handle) {
      calls.push("stream");
      return {
        platform: handle.platform,
        deviceId: handle.deviceId,
        baseUrl: "http://127.0.0.1:3400",
        token: streamToken,
        protocol: "mjpeg",
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

test("routes every operation through the controller and returns typed failures", async () => {
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
  await controller.dispose();
});

test("main is lazy, mints connection identity, confines stream tokens to IPC, and never replays requests", async () => {
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
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            eventStarted.resolve();
            await eventReady.promise;
            yield { type: "server.connected" };
          },
        }),
      },
    } as unknown as OpenCodeClient,
    serverEndpoints: {
      get: (id: string) => (id === "sidecar" ? { sameMachine: true } : { sameMachine: false }),
    },
    log: { write: () => undefined },
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
  })(context);
  expect(constructions).toBe(0);
  if (!implementation) throw new Error("IPC implementation was not provided");
  const ipc = implementation;
  const scope = { sessionID, serverID: "sidecar", location };
  await expect(
    ipc.connect(
      { sessionID, serverID: "remote" },
      { window: 7, signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(
    await ipc.list({ serverID: "remote" }, { window: 7, signal: new AbortController().signal }),
  ).toMatchObject({ type: "failure", error: { code: "unsupported" } });
  expect(constructions).toBe(0);
  const connecting = ipc.connect(scope, { window: 7, signal: new AbortController().signal });
  await eventStarted.promise;
  expect(attachment).toBeUndefined();
  eventReady.resolve();
  await connecting;
  expect(constructions).toBe(1);
  expect(attachment?.sessionID).toBe(sessionID);
  expect(attachment?.connectionID).toMatch(/^[a-f0-9-]{36}$/);
  if (!attachment) throw new Error("RPC attachment was not created");
  const connectionID = attachment.connectionID;

  operations.set("list", { type: "list", platform: "android" });
  control({ type: "command", connectionID, requestID: "list" });
  await eventually(() => outcomes.has("list"));
  expect(outcomes.get("list")).toMatchObject({
    type: "success",
    value: { type: "devices", devices: [] },
  });
  control({ type: "command", connectionID, requestID: "missing" });
  await eventually(() => outcomes.has("missing"));
  expect(outcomes.get("missing")).toMatchObject({
    type: "failure",
    error: { code: "internal", mayHaveExecuted: false },
  });

  const opened = await ipc.manual(
    { scope, operation: { type: "open", platform: "android", deviceId: "phone" } },
    { window: 7, signal: new AbortController().signal },
  );
  if (opened.type !== "success" || opened.value.type !== "attachment")
    throw new Error("expected attachment");
  expect(opened.value.attachment.agentAccess).toBe(true);
  expect(JSON.stringify(opened)).not.toContain(item.streamToken);
  const stream = await ipc.stream(
    { scope, handle: opened.value.attachment.handle },
    { window: 7, signal: new AbortController().signal },
  );
  if (stream.type !== "success") throw new Error("expected proxy stream");
  expect(stream.stream.token).not.toBe(item.streamToken);
  expect(stream.stream.baseUrl).not.toBe("http://127.0.0.1:3400");
  expect((await fetch(`${stream.stream.baseUrl}/secret`)).status).toBe(404);

  await ipc.access({ scope, enabled: false }, { window: 7, signal: new AbortController().signal });
  operations.set("denied", { type: "apps", handle: opened.value.attachment.handle });
  control({ type: "command", connectionID, requestID: "denied" });
  await eventually(() => outcomes.has("denied"));
  expect(outcomes.get("denied")).toMatchObject({
    type: "failure",
    error: { code: "permission-denied" },
  });
  expect(JSON.stringify(outcomes.get("denied"))).not.toContain(item.streamToken);

  await ipc.access({ scope, enabled: true }, { window: 7, signal: new AbortController().signal });
  operations.set("apps", { type: "apps", handle: opened.value.attachment.handle });
  control({ type: "command", connectionID, requestID: "apps" });
  control({ type: "command", connectionID, requestID: "apps" });
  await eventually(() => outcomes.has("apps"));
  expect(commandFetches.filter((requestID) => requestID === "apps")).toHaveLength(1);

  operations.set("cancelled", { type: "apps", handle: opened.value.attachment.handle });
  control({ type: "cancel", connectionID, requestID: "cancelled" });
  control({ type: "command", connectionID, requestID: "cancelled" });
  await Promise.resolve();
  expect(commandFetches).not.toContain("cancelled");

  const otherScope = { sessionID: Session.ID.create(), serverID: "sidecar" };
  const ipcCaller = { window: 7, signal: new AbortController().signal };
  await ipc.connect(otherScope, ipcCaller);
  const otherOpened = await ipc.manual(
    {
      scope: otherScope,
      operation: { type: "open", platform: "android", deviceId: "other-phone" },
    },
    ipcCaller,
  );
  expect(otherOpened).toMatchObject({
    type: "success",
    value: { type: "attachment", attachment: { agentAccess: true } },
  });
  expect(ipc.state(7)).toHaveLength(2);
  expect(
    await ipc.manual(
      { scope: otherScope, operation: { type: "apps", handle: opened.value.attachment.handle } },
      ipcCaller,
    ),
  ).toMatchObject({ type: "failure", error: { code: "permission-denied" } });
  expect(
    await ipc.manual(
      { scope, operation: { type: "apps", handle: opened.value.attachment.handle } },
      ipcCaller,
    ),
  ).toMatchObject({ type: "success", value: { type: "apps" } });
  await ipc.disconnect(otherScope, ipcCaller);
  expect(ipc.state(7)).toMatchObject([
    { scope, state: { handle: opened.value.attachment.handle, agentAccess: true } },
  ]);
  await ipc.disconnect(scope, ipcCaller);
  await expect(fetch(`${stream.stream.baseUrl}/video`)).rejects.toThrow();
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  expect(item.calls).toContain("dispose");
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
