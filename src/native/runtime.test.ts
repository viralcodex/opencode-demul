import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { waitWithSignal } from "../cancellation.js";
import { createDeviceController } from "../controller.js";
import { Device } from "../rpc.js";
import { createAutomation, type Automation } from "./automation.js";
import type { PlatformBackend } from "./backends.js";
import { deviceError } from "./errors.js";
import type { HubOptions, HubSession } from "./hub.js";
import { runCommand, type CommandResult } from "./process.js";
import { createNativeRuntime } from "./runtime.js";

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of teardown.splice(0).reverse()) await cleanup();
});

const ok = (stdout = ""): CommandResult => ({
  code: 0,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
});
const ref = Schema.decodeUnknownSync(Device.ElementRef)("@e1");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "device-runtime-test-"));
  const calls: string[] = [];
  const hubs: Array<{ session: HubSession; exit(): void }> = [];
  const state = {
    stopFailures: 0,
    closeFailures: 0,
    screenFailures: 0,
    bootedByUs: false,
    command: undefined as Automation["run"] | undefined,
    recovery: undefined as Promise<void> | undefined,
    installation: undefined as Promise<void> | undefined,
    helperSignal: undefined as AbortSignal | undefined,
  };
  const backend: PlatformBackend = {
    env: undefined,
    async list() {
      return [];
    },
    async ensureBooted(id) {
      calls.push(`boot:${id}`);
      return { deviceId: id, bootedByUs: state.bootedByUs };
    },
    async shutdown(id) {
      calls.push(`shutdown:${id}`);
    },
    async streamReady() {
      calls.push("screen");
      if (state.screenFailures > 0) {
        state.screenFailures--;
        throw deviceError("helper-failed", "capture unavailable");
      }
    },
    async tap(stream, _, signal) {
      signal?.throwIfAborted();
      calls.push(`tap:${stream.token}`);
    },
    async swipe(stream, _from, _to, signal) {
      signal?.throwIfAborted();
      calls.push(`swipe:${stream.token}`);
    },
    async pressKey(_stream, _key, signal) {
      signal?.throwIfAborted();
      return false;
    },
  };
  const hub = async (options: HubOptions): Promise<HubSession> => {
    if (hubs.length) await waitWithSignal(state.recovery ?? Promise.resolve(), options.signal);
    options.signal?.throwIfAborted();
    const index = hubs.length;
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    const session: HubSession = {
      descriptor: {
        platform: options.platform,
        deviceId: options.deviceId,
        token: `hub-${index}`,
        baseUrl: `http://127.0.0.1:${3400 + index}`,
        protocol: "h264",
        loopback: true,
      },
      process: { pid: undefined, exited: exited.promise, stop() {} },
      async stop() {
        calls.push(`stop:${index}`);
        if (state.stopFailures > 0) {
          state.stopFailures--;
          throw deviceError("timeout", "hub still running");
        }
        exited.resolve({ code: 0, signal: "SIGTERM" });
      },
    };
    hubs.push({ session, exit: () => exited.resolve({ code: 1, signal: null }) });
    return session;
  };
  const automation = (options: Parameters<typeof createAutomation>[0]): Automation => {
    const original = createAutomation(options);
    return {
      require: original.require,
      async run(args, timeout, signal) {
        calls.push(args[0]!);
        signal?.throwIfAborted();
        if (args[0] === "close") {
          if (state.closeFailures > 0) {
            state.closeFailures--;
            throw deviceError("timeout", "automation still running");
          }
          return ok();
        }
        if (state.command) return state.command(args, timeout, signal);
        if (args[0] === "capabilities")
          return ok(
            JSON.stringify({
              data: {
                availableCommands: [
                  "apps",
                  "open",
                  "install",
                  "snapshot",
                  "press",
                  "fill",
                  "swipe",
                  "home",
                  "screenshot",
                ],
              },
            }),
          );
        if (args[0] === "snapshot")
          return ok(JSON.stringify({ data: { nodes: [{ ref: "e1", kind: "button" }] } }));
        if (args[0] === "apps") return ok(JSON.stringify({ data: { apps: [] } }));
        return ok();
      },
    };
  };
  const runtime = createNativeRuntime(
    { stateRoot: directory },
    {
      backends: { android: backend },
      resolveNode: async () => process.execPath,
      helpers: async (_dir, _timeout, _node, signal) => {
        state.helperSignal = signal;
        await waitWithSignal(state.installation ?? Promise.resolve(), signal);
        return { dir: directory, agentDeviceBin: "/fixture.mjs", hubCli: "/fixture-hub.mjs" };
      },
      hub,
      automation,
    },
  );
  teardown.push(async () => {
    state.stopFailures = 0;
    state.closeFailures = 0;
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const open = () => runtime.open({ platform: "android", deviceId: "phone", boot: true });
  return { runtime, open, state, hubs, calls, directory, backend };
}

test.each(["press", "fill", "tap", "swipe", "key", "launch", "install"] as const)(
  "a failed %s invalidates references even when the helper may have changed the screen",
  async (type) => {
    const item = await fixture();
    const { handle } = await item.open();
    const snapshot = await item.runtime.snapshot({ handle });
    const reference = {
      token: handle.token,
      generation: handle.generation,
      revision: snapshot.revision,
      ref,
    };
    item.state.command = async () => ({ ...ok(), code: 1, stderr: "runner failed after dispatch" });
    const actions = {
      press: () => item.runtime.press({ handle, reference }),
      fill: () => item.runtime.fill({ handle, reference, text: "text" }),
      tap: () => item.runtime.tap({ handle, point: { x: 10, y: 20 } }),
      swipe: () => item.runtime.swipe({ handle, from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }),
      key: () => item.runtime.key({ handle, key: "home" }),
      launch: () => item.runtime.launch({ handle, app: "com.test" }),
      install: () => item.runtime.install({ handle, artifactPath: "/fixture.apk" }),
    };
    await expect(actions[type]()).rejects.toMatchObject({ data: { mayHaveExecuted: true } });
    const count = item.calls.length;
    await expect(item.runtime.press({ handle, reference })).rejects.toMatchObject({
      code: "stale-reference",
    });
    expect(item.calls).toHaveLength(count);
  },
);

test("unreadable snapshot output still invalidates the previous reference table", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  const snapshot = await item.runtime.snapshot({ handle });
  item.state.command = async () => ok("not JSON");
  await expect(item.runtime.snapshot({ handle })).rejects.toMatchObject({ code: "helper-failed" });
  await expect(
    item.runtime.press({ handle, reference: { ...snapshot, ref } }),
  ).rejects.toMatchObject({ code: "stale-reference" });
});

test("pre-dispatch cancellation neither invokes automation nor invalidates references", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  const snapshot = await item.runtime.snapshot({ handle });
  const reference = { ...snapshot, ref };
  const count = item.calls.length;
  await expect(
    item.runtime.press({ handle, reference }, AbortSignal.abort()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(item.calls).toHaveLength(count);
  await item.runtime.press({ handle, reference });
});

test("running cancellation kills the actual command, preserves uncertainty, and unblocks the queue", async () => {
  const item = await fixture();
  const controller = createDeviceController(item.runtime);
  const caller = { serverID: "test", sessionID: "test" };
  const { handle } = await controller.open(
    caller,
    { platform: "android", deviceId: "phone" },
    "manual",
  );
  const marker = join(item.directory, "started");
  const script = join(item.directory, "pending.mjs");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  item.state.command = async (args, _timeout, signal) =>
    args[0] === "home"
      ? runCommand({ command: process.execPath, args: [script], timeoutMs: 5_000, signal })
      : ok(JSON.stringify({ data: { apps: [] } }));
  const abort = new AbortController();
  const pending = controller.run(
    caller,
    { type: "key", handle, key: "home" },
    "agent",
    abort.signal,
  );
  const outcome = pending.catch((error: unknown) => error);
  await eventually(async () => (await readFile(marker, "utf8").catch(() => "")).length > 0);
  const pid = Number(await readFile(marker, "utf8"));
  abort.abort();
  expect(await outcome).toMatchObject({ data: { code: "detached", mayHaveExecuted: true } });
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(controller.run(caller, { type: "apps", handle }, "agent")).resolves.toMatchObject({
    type: "apps",
  });
  await controller.dispose();
});

test("operation deadlines cancel the actual command and report a timeout, not a successful mutation", async () => {
  const item = await fixture();
  const controller = createDeviceController(item.runtime, 100);
  const caller = { serverID: "test", sessionID: "test" };
  const { handle } = await controller.open(
    caller,
    { platform: "android", deviceId: "phone" },
    "manual",
  );
  item.state.command = async (_args, _timeout, signal) =>
    runCommand({
      command: process.execPath,
      args: ["--eval", "setInterval(() => {}, 1000)"],
      timeoutMs: 5_000,
      signal,
    });
  await expect(
    controller.run(caller, { type: "key", handle, key: "home" }, "agent"),
  ).rejects.toMatchObject({ data: { code: "timeout", mayHaveExecuted: true } });
  await controller.dispose();
});

test("hub exits invalidate refs and recovery shares one startup without changing device ownership", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  const snapshot = await item.runtime.snapshot({ handle });
  const first = await item.runtime.stream(handle);
  item.hubs[0]!.exit();
  await Promise.resolve();
  await expect(
    item.runtime.press({ handle, reference: { ...snapshot, ref } }),
  ).rejects.toMatchObject({ code: "stale-reference" });
  const [second, shared] = await Promise.all([
    item.runtime.stream(handle),
    item.runtime.stream(handle),
  ]);
  expect(second).toEqual(shared);
  expect(second.token).not.toBe(first.token);
  expect(second.deviceId).toBe(handle.deviceId);
  expect(item.hubs).toHaveLength(2);
  await item.runtime.tap({
    handle,
    point: { x: 10, y: 20 },
    viewport: { width: 100, height: 200 },
  });
  expect(item.calls).toContain("tap:hub-1");
  expect(item.calls.filter((call) => call === "boot:phone")).toHaveLength(1);
});

test("a cancelled recovery waiter does not cancel the shared capture startup", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  item.hubs[0]!.exit();
  await Promise.resolve();
  const release = Promise.withResolvers<void>();
  item.state.recovery = release.promise;
  const abort = new AbortController();
  const cancelled = item.runtime.stream(handle, abort.signal);
  const shared = item.runtime.stream(handle);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  release.resolve();
  await expect(shared).resolves.toMatchObject({ token: "hub-1" });
  expect(item.hubs).toHaveLength(2);
});

test("failed recovery cleanup must finish before another capture helper starts", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  item.hubs[0]!.exit();
  await Promise.resolve();
  item.state.screenFailures = 1;
  item.state.stopFailures = 1;
  await expect(item.runtime.stream(handle)).rejects.toMatchObject({ code: "timeout" });
  expect(item.hubs).toHaveLength(2);
  await expect(item.runtime.stream(handle)).resolves.toMatchObject({ token: "hub-2" });
  expect(item.calls.filter((call) => call === "stop:1")).toHaveLength(2);
  expect(item.hubs).toHaveLength(3);
});

test("capture exiting between readiness and publication is never returned as active", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  item.hubs[0]!.exit();
  await Promise.resolve();
  const ready = item.backend.streamReady;
  let exits = 0;
  item.backend.streamReady = async (stream, signal) => {
    await ready(stream, signal);
    if (exits++ === 0) queueMicrotask(() => item.hubs[1]!.exit());
  };
  await expect(item.runtime.stream(handle)).rejects.toMatchObject({ code: "helper-failed" });
  await expect(item.runtime.stream(handle)).resolves.toMatchObject({ token: "hub-2" });
});

test("closing during recovery aborts startup and cannot resurrect a capture connection", async () => {
  const item = await fixture();
  const { handle } = await item.open();
  item.hubs[0]!.exit();
  await Promise.resolve();
  item.state.recovery = new Promise(() => {});
  const recovery = item.runtime.stream(handle).catch((error: unknown) => error);
  await Promise.resolve();
  await item.runtime.close({ handle });
  expect(await recovery).toMatchObject({ name: "AbortError" });
  expect(item.hubs).toHaveLength(1);
  await expect(item.runtime.stream(handle)).rejects.toMatchObject({ code: "detached" });
});

test.each(["hub", "automation"] as const)(
  "failed %s cleanup retains state, blocks device actions, and retries only unfinished steps",
  async (failure) => {
    const item = await fixture();
    const { handle } = await item.open();
    const path = join(item.directory, handle.token);
    if (failure === "hub") item.state.stopFailures = 1;
    else item.state.closeFailures = 1;
    await expect(item.runtime.close({ handle })).rejects.toMatchObject({
      code: "helper-failed",
      message: expect.stringContaining("cleanup failed"),
    });
    await access(path);
    await expect(item.runtime.apps(handle)).rejects.toMatchObject({ code: "detached" });
    await item.runtime.close({ handle });
    await expect(access(path)).rejects.toThrow();
    expect(item.calls.filter((call) => call === "close")).toHaveLength(
      failure === "automation" ? 2 : 1,
    );
    expect(item.calls.filter((call) => call === "stop:0")).toHaveLength(failure === "hub" ? 2 : 1);
  },
);

test("failed startup cleanup is retried before booting or spawning another helper for the same device", async () => {
  const item = await fixture();
  item.state.bootedByUs = true;
  item.state.screenFailures = 1;
  item.state.stopFailures = 2;
  await expect(item.open()).rejects.toMatchObject({ code: "helper-failed" });
  await expect(item.open()).rejects.toMatchObject({ code: "helper-failed" });
  expect(item.hubs).toHaveLength(1);
  expect(item.calls.filter((call) => call === "boot:phone")).toHaveLength(1);
  const { handle } = await item.open();
  expect(item.hubs).toHaveLength(2);
  expect(item.calls.filter((call) => call === "shutdown:phone")).toHaveLength(1);
  await item.runtime.close({ handle });
});

test("a failed controller rollback is cleaned up before reopening instead of reusing a partly closed handle", async () => {
  const item = await fixture();
  const controller = createDeviceController(item.runtime);
  const caller = { serverID: "test", sessionID: "test" };
  const abort = new AbortController();
  const originalOpen = item.runtime.open;
  let previous: Device.DeviceHandle | undefined;
  item.runtime.open = async (input, signal) => {
    const result = await originalOpen(input, signal);
    if (!previous) {
      previous = result.handle;
      abort.abort();
    }
    return result;
  };
  item.state.stopFailures = 1;
  await expect(
    controller.open(caller, { platform: "android", deviceId: "phone" }, "manual", abort.signal),
  ).rejects.toMatchObject({ code: "helper-failed" });
  expect(controller.state(caller)).toBeNull();
  const opened = await controller.open(
    caller,
    { platform: "android", deviceId: "phone" },
    "manual",
  );
  expect(opened.handle.token).not.toBe(previous!.token);
  expect(item.calls.filter((call) => call === "stop:0")).toHaveLength(2);
  await expect(controller.stream(caller, opened.handle)).resolves.toMatchObject({ token: "hub-1" });
  await controller.dispose();
});

test("a failed capture startup cancels the sibling automation task rather than waiting for its full deadline", async () => {
  const item = await fixture();
  let automationSignal: AbortSignal | undefined;
  item.state.command = async (_args, _timeout, signal) => {
    automationSignal = signal;
    await waitWithSignal(new Promise<void>(() => {}), signal);
    return ok();
  };
  item.state.screenFailures = 1;
  await expect(item.open()).rejects.toMatchObject({
    code: "helper-failed",
    message: "capture unavailable",
  });
  expect(automationSignal?.aborted).toBe(true);
  expect(item.calls).toContain("stop:0");
  expect(item.calls).toContain("close");
});

test("a hub exit during automation startup cancels initialization without spawning a replacement", async () => {
  const item = await fixture();
  const started = Promise.withResolvers<void>();
  item.state.command = async (_args, _timeout, signal) => {
    started.resolve();
    await waitWithSignal(new Promise<void>(() => {}), signal);
    return ok();
  };
  const opening = item.open().catch((error: unknown) => error);
  await started.promise;
  item.hubs[0]!.exit();
  expect(await opening).toMatchObject({
    code: "helper-failed",
    message: expect.stringContaining("exited during startup"),
  });
  expect(item.hubs).toHaveLength(1);
});

test("disposal cancels a pending open and waits for its cleanup before returning", async () => {
  const item = await fixture();
  const started = Promise.withResolvers<void>();
  item.state.command = async (_args, _timeout, signal) => {
    started.resolve();
    await waitWithSignal(new Promise<void>(() => {}), signal);
    return ok();
  };
  const opening = item.open().catch((error: unknown) => error);
  await started.promise;
  await item.runtime.dispose();
  expect(await opening).toMatchObject({ name: "AbortError" });
  expect(item.calls).toContain("close");
  expect(item.calls).toContain("stop:0");
  await expect(item.open()).rejects.toMatchObject({ name: "AbortError" });
});

test.each([undefined, "android"] as const)(
  "disposal cancels in-flight discovery, platform=%s",
  async (platform) => {
    const item = await fixture();
    const started = Promise.withResolvers<void>();
    item.backend.list = async (signal) => {
      started.resolve();
      await waitWithSignal(new Promise<void>(() => {}), signal);
      return [];
    };
    const listed = item.runtime.list(platform).catch((error: unknown) => error);
    await started.promise;
    await item.runtime.dispose();
    expect(await listed).toMatchObject({ name: "AbortError" });
  },
);

test("selection cancellation does not wait for shared helper installation, but disposal cancels the installer", async () => {
  const item = await fixture();
  item.state.installation = new Promise<void>(() => {});
  const abort = new AbortController();
  const opening = item.runtime
    .open({ platform: "android", deviceId: "phone" }, abort.signal)
    .catch((error: unknown) => error);
  await eventually(async () => !!item.state.helperSignal);
  abort.abort();
  expect(await opening).toMatchObject({ name: "AbortError" });
  expect(item.state.helperSignal!.aborted).toBe(false);
  expect(item.hubs).toHaveLength(0);
  await item.runtime.dispose();
  expect(item.state.helperSignal!.aborted).toBe(true);
});

test("disposal attempts every attachment even when one helper fails, and subsequent disposal retries it", async () => {
  const item = await fixture();
  const first = await item.open();
  const second = await item.runtime.open({ platform: "android", deviceId: "other" });
  item.state.stopFailures = 1;
  await expect(item.runtime.dispose()).rejects.toMatchObject({ code: "helper-failed" });
  await expect(access(join(item.directory, second.handle.token))).rejects.toThrow();
  await access(join(item.directory, first.handle.token));
  await item.runtime.dispose();
  await expect(access(join(item.directory, first.handle.token))).rejects.toThrow();
});

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The expected device operation never started.");
}
