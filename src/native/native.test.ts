import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appsArgs,
  capabilitiesArgs,
  closeArgs,
  createAutomation,
  fillArgs,
  installArgs as automationInstallArgs,
  keyArgs,
  launchArgs,
  parseApps,
  parseCapabilities,
  parseSnapshotJson,
  pressArgs,
  screenshotArgs,
  snapshotArgs,
  swipeArgs,
  tapArgs,
} from "./automation.js";
import { adbState, androidDevices, parseAdbDevices, parseSimctlDevices } from "./discovery.js";
import { HandleRegistry } from "./handle.js";
import {
  installArgs as helperInstallArgs,
  MIN_NODE,
  nvmNodeCandidates,
  npmCliCandidates,
  parseNodeVersion,
  resolveExternalNode,
  satisfiesNode,
  ensureHelpers,
  PINS,
  resolveNpmCli,
} from "./helpers.js";
import { hubArgs, LOOPBACK_HOST, parseReady, sendGesture, streamDescriptor } from "./hub.js";
import { readPngDimensions } from "./png.js";
import { appendBounded } from "./process.js";
import { createNativeRuntime } from "./runtime.js";
import { androidHelperEnv, androidToolPath, resolveAndroidSdkRoot } from "./android.js";
import { Schema } from "effect";
import { Device } from "../rpc.js";

// Decode a branded element reference the way the runtime does, so tests never fabricate a brand by casting.
const ref = (value: string) => Schema.decodeUnknownSync(Device.ElementRef)(value);

test("unsupported platforms fail before resolving Node or installing helpers", async () => {
  const runtime = createNativeRuntime({ externalNode: "/missing/device-test-node" });
  await expect(runtime.list("ios")).rejects.toMatchObject({ data: { code: "unsupported" } });
  await expect(
    runtime.open({ platform: "ios", deviceId: "unsupported-device", boot: true }),
  ).rejects.toMatchObject({ data: { code: "unsupported" } });
  await runtime.dispose();
});

test("missing Android SDK tools report a prerequisite error rather than an empty device list", async () => {
  await expect(
    androidDevices({ androidSdkRoot: "/missing/device-test-sdk" }),
  ).rejects.toMatchObject({ data: { code: "missing-prerequisite" } });
});

test("Android SDK defaults and executable paths cover every desktop OS", () => {
  expect(resolveAndroidSdkRoot({ platform: "darwin", home: "/Users/test", env: {} })).toBe(
    "/Users/test/Library/Android/sdk",
  );
  expect(resolveAndroidSdkRoot({ platform: "linux", home: "/home/test", env: {} })).toBe(
    "/home/test/Android/Sdk",
  );
  expect(resolveAndroidSdkRoot({ platform: "win32", home: "C:\\Users\\test", env: {} })).toBe(
    "C:\\Users\\test\\AppData\\Local\\Android\\Sdk",
  );
  expect(resolveAndroidSdkRoot({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local" } })).toBe(
    "D:\\Local\\Android\\Sdk",
  );
  expect(resolveAndroidSdkRoot({ root: "/explicit", env: { ANDROID_HOME: "/home-sdk" } })).toBe(
    "/explicit",
  );
  expect(
    resolveAndroidSdkRoot({ env: { ANDROID_HOME: "/home-sdk", ANDROID_SDK_ROOT: "/root-sdk" } }),
  ).toBe("/home-sdk");
  expect(resolveAndroidSdkRoot({ env: { ANDROID_SDK_ROOT: "/root-sdk" } })).toBe("/root-sdk");
  expect(androidToolPath("adb", "C:\\Android SDK", "win32")).toBe(
    "C:\\Android SDK\\platform-tools\\adb.exe",
  );
  expect(androidToolPath("emulator", "C:\\Android SDK", "win32")).toBe(
    "C:\\Android SDK\\emulator\\emulator.exe",
  );
  expect(androidToolPath("adb", "/opt/android", "linux")).toBe("/opt/android/platform-tools/adb");
  expect(androidToolPath("adb", undefined, "win32")).toBe("adb.exe");
});

test("Android helper environments preserve desktop paths and Windows casing", () => {
  const inherited = { PATH: "/usr/bin:/bin", ANDROID_HOME: "/other-sdk" };
  expect(androidHelperEnv("/opt/Android SDK", inherited, "darwin")).toEqual({
    ANDROID_HOME: "/opt/Android SDK",
    ANDROID_SDK_ROOT: "/opt/Android SDK",
    PATH: "/opt/Android SDK/platform-tools:/opt/Android SDK/emulator:/usr/bin:/bin",
  });
  expect(inherited).toEqual({ PATH: "/usr/bin:/bin", ANDROID_HOME: "/other-sdk" });
  expect(androidHelperEnv("C:\\Android SDK", { Path: "C:\\Windows\\System32" }, "win32")).toEqual({
    ANDROID_HOME: "C:\\Android SDK",
    ANDROID_SDK_ROOT: "C:\\Android SDK",
    Path: "C:\\Android SDK\\platform-tools;C:\\Android SDK\\emulator;C:\\Windows\\System32",
  });
  expect(androidHelperEnv("C:\\SDK", { PATH: "C:\\Windows" }, "win32")?.["PATH"]).toBe(
    "C:\\SDK\\platform-tools;C:\\SDK\\emulator;C:\\Windows",
  );
  expect(androidHelperEnv("/sdk", {}, "linux")?.["PATH"]).toBe("/sdk/platform-tools:/sdk/emulator");
  expect(androidHelperEnv(undefined, inherited)).toBeUndefined();
});

test.skipIf(process.platform === "win32")(
  "Android helpers resolve adb with a restricted desktop PATH",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "device sdk path test "));
    const script = join(directory, "fixture.mjs");
    const originalPath = process.env["PATH"];
    const originalHome = process.env["ANDROID_HOME"];
    const originalRoot = process.env["ANDROID_SDK_ROOT"];
    try {
      await mkdir(join(directory, "platform-tools"));
      await writeFile(
        join(directory, "platform-tools", "adb"),
        "#!/bin/sh\nprintf 'sdk-adb\\n'\n",
        {
          mode: 0o755,
        },
      );
      await writeFile(
        script,
        'import { execFileSync } from "node:child_process"; console.log(process.env.ANDROID_HOME); console.log(process.env.ANDROID_SDK_ROOT); console.log(execFileSync("adb", ["version"], { encoding: "utf8" }).trim());',
      );
      const automation = createAutomation({
        externalNode: process.execPath,
        agentDeviceBin: script,
        platform: "android",
        deviceId: "emulator-5554",
        stateDir: directory,
        env: androidHelperEnv(directory, { PATH: "/usr/bin:/bin" }),
      });
      const result = await automation.run([]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim().split(/\r?\n/u)).toEqual([directory, directory, "sdk-adb"]);
      expect(process.env["PATH"]).toBe(originalPath);
      expect(process.env["ANDROID_HOME"]).toBe(originalHome);
      expect(process.env["ANDROID_SDK_ROOT"]).toBe(originalRoot);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "POSIX helper installation uses selected Node with restricted PATH, NVM=%s",
  async (nvm) => {
    const directory = await mkdtemp(join(tmpdir(), "device-node-toolchain-"));
    const saved = {
      PATH: process.env["PATH"],
      NVM_DIR: process.env["NVM_DIR"],
      OPENCODE_DEVICE_NODE: process.env["OPENCODE_DEVICE_NODE"],
      npm_execpath: process.env["npm_execpath"],
    };
    try {
      const prefix = join(directory, "versions", "node", "v24.1.0");
      const node = join(prefix, "bin", "node");
      const cli = join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
      await mkdir(join(prefix, "bin"), { recursive: true });
      await mkdir(join(prefix, "lib", "node_modules", "npm", "bin"), { recursive: true });
      await writeFile(
        node,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'v24.1.0\\n'; elif [ "$1" = "--print" ]; then printf '%s\\n' "$0"; else exec '${process.execPath}' "$@"; fi\n`,
        { mode: 0o755 },
      );
      await writeFile(
        cli,
        `const fs = require("node:fs"); const path = require("node:path"); if (process.argv.includes("--version")) { console.log("10.1.0"); } else { const root = process.argv[process.argv.indexOf("--prefix") + 1]; const child = require("node:child_process").spawnSync("node", ["--version"], {encoding:"utf8"}); if (child.stdout.trim() !== "v24.1.0") process.exit(1); for (const [pkg, version] of Object.entries(${JSON.stringify(PINS)})) { const dir = path.join(root, "node_modules", pkg); fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({version, bin:"cli.js"})); fs.writeFileSync(path.join(dir, "cli.js"), ""); } }`,
      );
      process.env["PATH"] = join(directory, "missing-path");
      process.env["NVM_DIR"] = directory;
      delete process.env["OPENCODE_DEVICE_NODE"];
      process.env["npm_execpath"] = join(directory, "unrelated", "npm-cli.js");
      const selected = await resolveExternalNode(nvm ? undefined : node);
      expect(selected).toBe(node);
      expect(await resolveNpmCli(selected)).toBe(cli);
      const paths = await ensureHelpers(join(directory, "helpers"), 10_000, selected);
      expect(paths.agentDeviceBin).toBe(
        join(directory, "helpers", "node_modules", "agent-device", "cli.js"),
      );
      await rm(cli);
      await expect(resolveNpmCli(selected)).rejects.toMatchObject({
        data: { code: "missing-prerequisite" },
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("Windows helper installation uses Node and npm CLI without a shell", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  expect(
    npmCliCandidates(node, { Path: "C:\\Users\\test\\AppData\\Roaming\\npm" }, "win32"),
  ).toContain(cli);
  expect(
    npmCliCandidates(node, { Path: "C:\\Users\\test\\AppData\\Roaming\\npm" }, "win32"),
  ).toContain("C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js");
  const invocation = helperInstallArgs("C:\\Device Helpers", node, cli);
  expect(invocation.command).toBe(node);
  expect(invocation.args[0]).toBe(cli);
  expect(invocation.args).toContain("C:\\Device Helpers");
  expect(invocation.args).toContain("--no-save");
  expect(invocation.args).toContain("--no-package-lock");
});

test("manual gestures use authenticated device-scoped routes and report rejection", async () => {
  const requests: {
    path: string;
    device: string | null;
    authorization: string | null;
    body: unknown;
  }[] = [];
  const state = { reject: false };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        device: url.searchParams.get("device"),
        authorization: request.headers.get("Authorization"),
        body: await request.json(),
      });
      return Response.json(
        {
          ok: !state.reject,
          ...(state.reject
            ? { error: "adb devices failed: spawn adb ENOENT (private-hub-token)" }
            : {}),
        },
        { status: state.reject ? 503 : 200 },
      );
    },
  });
  const stream = streamDescriptor(
    { baseUrl: server.url.origin, token: "private-hub-token" },
    "android",
    "emulator-5554",
  );
  try {
    await sendGesture(stream, { type: "tap", x: 0.25, y: 0.75 });
    await sendGesture(stream, {
      type: "swipe",
      x1: 0.5,
      y1: 0.8,
      x2: 0.5,
      y2: 0.2,
      durationMs: 300,
    });
    expect(requests).toEqual([
      {
        path: "/vendor/serve-emu/api/tap",
        device: "emulator-5554",
        authorization: "Bearer private-hub-token",
        body: { type: "tap", x: 0.25, y: 0.75 },
      },
      {
        path: "/vendor/serve-emu/api/swipe",
        device: "emulator-5554",
        authorization: "Bearer private-hub-token",
        body: { type: "swipe", x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, durationMs: 300 },
      },
    ]);
    state.reject = true;
    await expect(sendGesture(stream, { type: "tap", x: 0.5, y: 0.5 })).rejects.toMatchObject({
      data: {
        code: "helper-failed",
        message:
          "The device rejected the tap gesture (HTTP 503): adb devices failed: spawn adb ENOENT ([redacted])",
        mayHaveExecuted: true,
      },
    });
  } finally {
    await server.stop(true);
  }
});

test("appendBounded keeps the newest bytes once the cap is reached", () => {
  expect(appendBounded("abc", "de", 10)).toBe("abcde");
  expect(appendBounded("abcde", "fgh", 4)).toBe("efgh");
});

test("readPngDimensions reads the IHDR dimensions and rejects non-PNG bytes", () => {
  const png = new Uint8Array(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  png[12] = 0x49;
  png[13] = 0x48;
  png[14] = 0x44;
  png[15] = 0x52;
  new DataView(png.buffer).setUint32(16, 1080);
  new DataView(png.buffer).setUint32(20, 1920);
  expect(readPngDimensions(png)).toEqual({ width: 1080, height: 1920 });
  expect(readPngDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
});

test("parseNodeVersion and satisfiesNode gate on the minimum Node", () => {
  expect(parseNodeVersion("v22.13.1")).toBe("22.13.1");
  expect(parseNodeVersion("not a version")).toBeNull();
  expect(satisfiesNode("22.13.1")).toBe(false);
  expect(satisfiesNode("22.19.0")).toBe(true);
  expect(satisfiesNode(`${MIN_NODE.major}.${MIN_NODE.minor}.0`)).toBe(true);
  expect(satisfiesNode("22.11.9")).toBe(false);
  expect(satisfiesNode("21.99.0")).toBe(false);
  expect(satisfiesNode("23.0.0")).toBe(false);
  expect(satisfiesNode("24.0.0")).toBe(true);
});

test("NVM Node discovery filters unsupported versions and prefers the newest installed runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "device-nvm-"));
  try {
    const root = join(dir, "versions", "node");
    await Promise.all(
      ["v22.13.1", "v22.19.0", "v23.0.0", "v24.9.0", "v24.13.0", "invalid-v25.0.0"].map((version) =>
        mkdir(join(root, version), { recursive: true }),
      ),
    );
    await writeFile(join(root, "v26.0.0"), "not an installation");
    expect(await nvmNodeCandidates(dir)).toEqual(
      ["v24.13.0", "v24.9.0", "v22.19.0"].map((version) => join(root, version, "bin", "node")),
    );
    expect(await nvmNodeCandidates(join(dir, "missing"))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicit unsupported Node runtime is not replaced by automatic discovery", async () => {
  await expect(resolveExternalNode(process.execPath)).rejects.toMatchObject({
    data: { code: "missing-prerequisite" },
  });
});

test("hub arg builder pins host, token, the platform's served transport, platform, and single device", () => {
  const android = hubArgs({
    externalNode: "node",
    hubCli: "/h/cli.js",
    platform: "android",
    deviceId: "emulator-5554",
  });
  expect(android).toEqual([
    "/h/cli.js",
    "--host",
    LOOPBACK_HOST,
    "--require-token",
    "--transport",
    "h264",
    "--platform",
    "android",
    "--single-device",
    "emulator-5554",
  ]);
  const ios = hubArgs({
    externalNode: "node",
    hubCli: "/h/cli.js",
    platform: "ios",
    deviceId: "UDID",
  });
  expect(ios).toContain("mjpeg");
  expect(ios).not.toContain("h264");
});

test("parseReady extracts a loopback origin and token", () => {
  expect(parseReady("Local:   http://127.0.0.1:3400/?token=secret-123")).toEqual({
    baseUrl: "http://127.0.0.1:3400",
    token: "secret-123",
  });
  expect(
    parseReady("Local:   http://localhost:3400/?token=C9nr-nUuihp8gHCfnHpVISCL9oSphzhJI0TIPQzFZwM"),
  ).toEqual({
    baseUrl: "http://localhost:3400",
    token: "C9nr-nUuihp8gHCfnHpVISCL9oSphzhJI0TIPQzFZwM",
  });
  expect(parseReady("starting up with no url")).toBeNull();
});

test("automation arg builders produce the expected CLI invocations", () => {
  expect(launchArgs("com.android.settings")).toEqual(["open", "com.android.settings"]);
  expect(launchArgs("app", "myapp://x")).toEqual(["open", "app", "myapp://x"]);
  expect(launchArgs("app", undefined, true)).toEqual(["open", "app", "--relaunch"]);
  expect(snapshotArgs(true)).toEqual(["snapshot", "-i", "--json"]);
  expect(snapshotArgs(false)).toEqual(["snapshot", "--json"]);
  expect(pressArgs(ref("@e2"))).toEqual(["press", "@e2", "--settle"]);
  expect(tapArgs({ x: 120, y: 540 })).toEqual(["press", "120", "540", "--settle"]);
  expect(fillArgs(ref("@e3"), "hello")).toEqual(["fill", "@e3", "hello", "--settle"]);
  expect(swipeArgs({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual(["swipe", "1", "2", "3", "4"]);
  expect(keyArgs("home")).toEqual(["home"]);
  expect(keyArgs("back")).toEqual(["back", "--settle"]);
  expect(keyArgs("recents")).toEqual(["app-switcher"]);
  expect(keyArgs("volumeUp")).toEqual(["hardware-button", "volume-up"]);
  expect(keyArgs("lock")).toEqual(["hardware-button", "sleep"]);
  expect(screenshotArgs("/tmp/x.png")).toEqual(["screenshot", "/tmp/x.png"]);
  expect(appsArgs()).toEqual(["apps", "--all", "--json"]);
  expect(automationInstallArgs("/tmp/app.apk")).toEqual(["install", "/tmp/app.apk"]);
  expect(capabilitiesArgs()).toEqual(["capabilities", "--json"]);
  expect(closeArgs()).toEqual(["close"]);
});

test("parseSnapshotJson reads real nodes, drops structural placeholders, and reports truncation", () => {
  const report = JSON.stringify({
    success: true,
    data: {
      truncated: false,
      nodes: [
        { ref: "e2", kind: "button", label: "Add", enabled: true },
        { kind: "text", label: "label only" },
        { ref: "e7", kind: "text-field", enabled: false },
        { kind: "" },
      ],
    },
  });
  const parsed = parseSnapshotJson(report);
  expect(parsed).not.toBeNull();
  expect(parsed!.complete).toBe(true);
  expect(parsed!.nodes).toEqual([
    { role: "button", ref: ref("@e2"), name: "Add", enabled: true },
    { role: "text", name: "label only" },
    { role: "text-field", ref: ref("@e7"), enabled: false },
  ]);
  const truncated = parseSnapshotJson(JSON.stringify({ data: { truncated: true, nodes: [] } }));
  expect(truncated!.complete).toBe(false);
  expect(parseSnapshotJson("not json")).toBeNull();
});

test("parseApps reads the envelope string entries and parseCapabilities maps availableCommands", () => {
  const appsJson = JSON.stringify({
    success: true,
    data: { apps: ["Settings (com.android.settings)", "Chrome (com.android.chrome)"] },
  });
  expect(parseApps(appsJson)).toEqual([
    { id: "com.android.settings", name: "Settings" },
    { id: "com.android.chrome", name: "Chrome" },
  ]);
  const objectJson = JSON.stringify({
    success: true,
    data: { apps: [{ packageName: "com.a", label: "A" }, { bundleId: "com.b" }] },
  });
  expect(parseApps(objectJson)).toEqual([{ id: "com.a", name: "A" }, { id: "com.b" }]);
  expect(parseApps("not json")).toBeNull();
  const capsJson = JSON.stringify({
    success: true,
    data: { availableCommands: ["open", "press", "fill", "snapshot", "home", "screenshot"] },
  });
  expect(parseCapabilities(capsJson)).toEqual([
    "launch",
    "snapshot",
    "press",
    "fill",
    "key",
    "screenshot",
  ]);
  expect(parseCapabilities("not json")).toBeNull();
});

test("parseAdbDevices and adbState read running emulators", () => {
  const devices = parseAdbDevices(
    "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n",
  );
  expect(devices).toEqual([
    { serial: "emulator-5554", state: "device" },
    { serial: "emulator-5556", state: "offline" },
  ]);
  expect(adbState("device")).toBe("booted");
  expect(adbState("offline")).toBe("booting");
  expect(adbState("no device")).toBe("unavailable");
});

test("parseSimctlDevices reads available booted simulators", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
        { udid: "UDID-1", name: "iPhone 15", state: "Booted", isAvailable: true },
        { udid: "UDID-2", name: "iPhone SE", state: "Shutdown", isAvailable: false },
      ],
    },
  });
  const devices = parseSimctlDevices(json);
  expect(devices).toHaveLength(1);
  expect(devices[0]).toMatchObject({
    id: "UDID-1",
    name: "iPhone 15",
    platform: "ios",
    state: "booted",
  });
});

test("parseSimctlDevices reports the selected simulator's own state, not any booted device", () => {
  // The iOS boot check finds the selected udid in this parse rather than scanning the raw JSON for any "Booted"
  // string, so a different booted simulator never stands in for the shutdown device the caller named.
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
        { udid: "UDID-OTHER", name: "iPhone 15", state: "Booted", isAvailable: true },
        { udid: "UDID-WANTED", name: "iPhone SE", state: "Shutdown", isAvailable: true },
      ],
    },
  });
  const devices = parseSimctlDevices(json);
  expect(devices.find((device) => device.id === "UDID-WANTED")?.state).toBe("shutdown");
  expect(devices.find((device) => device.id === "UDID-OTHER")?.state).toBe("booted");
});

test("HandleRegistry mints handles, bumps revisions, and enforces reference validity", () => {
  let counter = 0;
  const registry = new HandleRegistry(() => `dh_00000000-0000-4000-8000-00000000000${counter++}`);
  const handle = registry.create("android", "emulator-5554");
  expect(handle.generation).toBe(1);
  expect(registry.revision(handle)).toBe(0);
  const revision = registry.nextSnapshot(handle);
  expect(revision).toBe(1);
  const good: Device.SnapshotReference = {
    token: handle.token,
    generation: handle.generation,
    revision,
    ref: ref("@e2"),
  };
  expect(registry.resolveReference(good)).toBe(ref("@e2"));
  registry.invalidate(handle);
  expect(() => registry.resolveReference(good)).toThrow();
  registry.release(handle);
  expect(() => registry.require(handle)).toThrow();
});

test("HandleRegistry rejects a reference from an older generation", () => {
  let counter = 0;
  const registry = new HandleRegistry(() => `dh_00000000-0000-4000-8000-00000000000${counter++}`);
  const first = registry.create("android", "emulator-5554");
  registry.nextSnapshot(first);
  const second = registry.create("android", "emulator-5554");
  const stale: Device.SnapshotReference = {
    token: second.token,
    generation: first.generation,
    revision: 1,
    ref: ref("@e1"),
  };
  expect(() => registry.resolveReference(stale)).toThrow();
});

test("HandleRegistry rejects a reference that belongs to a different handle than the one named", () => {
  let counter = 0;
  const registry = new HandleRegistry(() => `dh_00000000-0000-4000-8000-00000000000${counter++}`);
  const deviceA = registry.create("android", "emulator-5554");
  const deviceB = registry.create("android", "emulator-5556");
  const revision = registry.nextSnapshot(deviceA);
  const referenceOnA: Device.SnapshotReference = {
    token: deviceA.token,
    generation: deviceA.generation,
    revision,
    ref: ref("@e3"),
  };
  // Valid against its own device, so a snapshot ref keeps working for the device it came from.
  expect(registry.resolveReference(referenceOnA, deviceA)).toBe(ref("@e3"));
  // Rejected when dispatched against another device, so an element can never be tapped on the wrong device.
  expect(() => registry.resolveReference(referenceOnA, deviceB)).toThrow();
});
