import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Device } from "../rpc.js";
import type { DeviceBridge } from "../bridge.js";
import {
  appsArgs,
  capabilitiesArgs,
  closeArgs,
  createAutomation,
  fillArgs,
  installArgs,
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
  type Automation,
} from "./automation.js";
import { deviceError } from "./errors.js";
import { resolveAndroidSdkRoot } from "./android.js";
import { androidBackend, iosBackend, type PlatformBackend } from "./backends.js";
import { HandleRegistry } from "./handle.js";
import {
  defaultHelperDir,
  ensureHelpers,
  resolveExternalNode,
  type HelperPaths,
} from "./helpers.js";
import { startHub, type HubSession } from "./hub.js";
import { readPngDimensions } from "./png.js";

export interface DeviceRuntime {
  list(platform?: Device.Platform, signal?: AbortSignal): Promise<Device.DeviceInfo[]>;
  open(input: OpenInput, signal?: AbortSignal): Promise<OpenResult>;
  apps(handle: Device.DeviceHandle): Promise<Device.AppInfo[]>;
  launch(input: LaunchInput): Promise<Device.LaunchResult>;
  install(input: InstallInput): Promise<Device.InstallResult>;
  snapshot(input: SnapshotInput): Promise<Device.Snapshot>;
  press(input: PressInput): Promise<void>;
  tap(input: TapInput): Promise<void>;
  fill(input: FillInput): Promise<void>;
  swipe(input: SwipeInput): Promise<void>;
  key(input: KeyInput): Promise<void>;
  screenshot(handle: Device.DeviceHandle): Promise<Device.Screenshot>;
  stream(handle: Device.DeviceHandle): Promise<Device.StreamDescriptor>;
  close(input: CloseInput): Promise<void>;
  // Release attachment resources without shutting down devices.
  dispose(): Promise<void>;
}

export type OpenInput = Omit<Extract<DeviceBridge.Operation, { type: "open" }>, "type">;
export type LaunchInput = Omit<Extract<DeviceBridge.Operation, { type: "launch" }>, "type">;
export type InstallInput = Omit<Extract<DeviceBridge.Operation, { type: "install" }>, "type">;
export type SnapshotInput = Omit<Extract<DeviceBridge.Operation, { type: "snapshot" }>, "type">;
export type PressInput = Omit<Extract<DeviceBridge.Operation, { type: "press" }>, "type">;
export type TapInput = Omit<Extract<DeviceBridge.Operation, { type: "tap" }>, "type">;
export type FillInput = Omit<Extract<DeviceBridge.Operation, { type: "fill" }>, "type">;
export type SwipeInput = Omit<Extract<DeviceBridge.Operation, { type: "swipe" }>, "type">;
export type KeyInput = Omit<Extract<DeviceBridge.Operation, { type: "key" }>, "type">;
export type CloseInput = Omit<Extract<DeviceBridge.Operation, { type: "close" }>, "type">;

export interface OpenResult {
  handle: Device.DeviceHandle;
  capabilities: Device.Capabilities;
}

export interface RuntimeOptions {
  externalNode?: string;
  // Where the pinned agent-device and hub helpers are installed. Defaults to a private user cache.
  helperDir?: string;
  // The base directory for per-attachment agent-device session directories.
  stateRoot?: string;
  // The Android SDK root. Defaults to the SDK environment variables, then the host OS's standard location.
  androidSdkRoot?: string;
}

// Every contract capability, used to report the complement of what a device supports.
const ALL_CAPABILITIES: readonly Device.Capability[] = [
  "apps",
  "launch",
  "install",
  "snapshot",
  "press",
  "fill",
  "swipe",
  "key",
  "screenshot",
  "stream",
];

interface Attachment {
  handle: Device.DeviceHandle;
  backend: PlatformBackend;
  hub: HubSession;
  automation: Automation;
  capabilities: Device.Capabilities;
  stateDir: string;
  // Shutdown is honored only for a device booted by this runtime.
  bootedByUs: boolean;
}

export function createNativeRuntime(options: RuntimeOptions = {}): DeviceRuntime {
  const helperDir = options.helperDir ?? defaultHelperDir();
  const stateRoot = options.stateRoot ?? join(tmpdir(), "opencode-device-sessions");
  const backends: Partial<Record<Device.Platform, PlatformBackend>> = {
    android: androidBackend(resolveAndroidSdkRoot({ root: options.androidSdkRoot })),
    ...(process.platform === "darwin" ? { ios: iosBackend() } : {}),
  };
  const attachments = new Map<string, Attachment>();
  let resolvedNode: Promise<string> | null = null;
  let installedHelpers: Promise<HelperPaths> | null = null;

  const node = () =>
    (resolvedNode ??= resolveExternalNode(options.externalNode).catch((error) => {
      resolvedNode = null;
      throw error;
    }));
  const helpers = (externalNode: string) =>
    (installedHelpers ??= ensureHelpers(helperDir, 300_000, externalNode).catch((error) => {
      installedHelpers = null;
      throw error;
    }));

  const attachment = (handle: Device.DeviceHandle, capability?: Device.Capability) => {
    registry.require(handle);
    const found = attachments.get(handle.token);
    if (!found)
      throw deviceError(
        "detached",
        "This device handle is no longer attached; open the device again.",
      );
    if (capability && !found.capabilities.supported.includes(capability)) {
      const reason = found.capabilities.unsupported.find(
        (entry) => entry.capability === capability,
      )?.reason;
      throw deviceError("unsupported", reason ?? `This device does not support ${capability}.`);
    }
    return found;
  };

  const registry = new HandleRegistry();

  const backendFor = (platform: Device.Platform) => {
    if (!["darwin", "linux", "win32"].includes(process.platform))
      throw deviceError("unsupported", "Device control supports macOS, Linux, and Windows.");
    const backend = backends[platform];
    if (!backend) throw deviceError("unsupported", "iOS simulators require a macOS host.");
    return backend;
  };

  return {
    async list(platform, signal) {
      signal?.throwIfAborted();
      if (platform) return backendFor(platform).list(signal);
      const platforms = Object.keys(backends) as Device.Platform[];
      // One platform's missing toolchain must not hide the other platform's devices.
      const results = await Promise.allSettled(
        platforms.map((entry) => backendFor(entry).list(signal)),
      );
      signal?.throwIfAborted();
      const listed = results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure && results.every((result) => result.status === "rejected")) throw failure.reason;
      return listed;
    },

    async open(input, signal) {
      signal?.throwIfAborted();
      const backend = backendFor(input.platform);
      const externalNode = await node();
      const paths = await helpers(externalNode);
      signal?.throwIfAborted();
      const { deviceId, bootedByUs } = await backend.ensureBooted(
        input.deviceId,
        input.boot ?? false,
        signal,
      );
      // Everything acquired past this point is torn down in reverse if a later step throws, so a failed open never
      // leaks the device we booted, the hub we spawned, the handle we minted, or the state directory we created.
      const cleanups: Array<() => Promise<void>> = [];
      if (bootedByUs) cleanups.push(() => backend.shutdown(deviceId));
      try {
        signal?.throwIfAborted();
        const env = backend.env;
        const hub = await startHub({
          externalNode,
          hubCli: paths.hubCli,
          platform: input.platform,
          deviceId,
          env,
          signal,
        });
        cleanups.push(() => hub.stop().catch(() => undefined));
        const handle = registry.create(input.platform, deviceId);
        cleanups.push(async () => registry.release(handle));
        const stateDir = join(stateRoot, handle.token);
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        cleanups.push(() => rm(stateDir, { recursive: true, force: true }).catch(() => undefined));
        const automation = createAutomation({
          externalNode,
          agentDeviceBin: paths.agentDeviceBin,
          platform: input.platform,
          deviceId,
          stateDir,
          env,
        });
        cleanups.push(async () => {
          await automation.run(closeArgs(), 10_000).catch(() => undefined);
        });
        const [screen, controls] = await Promise.allSettled([
          backend.streamReady(hub.descriptor, signal),
          openAutomation(automation, signal),
        ]);
        if (screen.status === "rejected") throw screen.reason;
        if (controls.status === "rejected") throw controls.reason;
        const capabilities = controls.value;
        attachments.set(handle.token, {
          handle,
          backend,
          hub,
          automation,
          capabilities,
          stateDir,
          bootedByUs,
        });
        return { handle, capabilities };
      } catch (error) {
        for (const cleanup of cleanups.reverse()) await cleanup();
        throw error;
      }
    },

    async apps(handle) {
      const found = attachment(handle, "apps");
      const result = found.automation.require(
        await found.automation.run(appsArgs()),
        "Listing apps",
      );
      const apps = parseApps(result.stdout);
      if (!apps) throw deviceError("helper-failed", "The app listing could not be read.");
      return apps;
    },

    async launch(input) {
      const found = attachment(input.handle, "launch");
      found.automation.require(
        await found.automation.run(launchArgs(input.app, input.deepLink, input.relaunch)),
        "Launching the app",
        true,
      );
      registry.invalidate(input.handle);
      return { app: input.app, state: "launched" };
    },

    async install(input) {
      const found = attachment(input.handle, "install");
      found.automation.require(
        await found.automation.run(installArgs(input.artifactPath)),
        "Installing the artifact",
        true,
      );
      return { installed: true };
    },

    async snapshot(input) {
      const found = attachment(input.handle, "snapshot");
      const interactiveOnly = input.interactiveOnly ?? true;
      const result = found.automation.require(
        await found.automation.run(snapshotArgs(interactiveOnly)),
        "Taking a snapshot",
      );
      const parsed = parseSnapshotJson(result.stdout);
      if (!parsed) throw deviceError("helper-failed", "The snapshot could not be read.");
      const revision = registry.nextSnapshot(input.handle);
      return {
        token: input.handle.token,
        generation: input.handle.generation,
        revision,
        interactiveOnly,
        complete: parsed.complete,
        nodes: parsed.nodes,
      };
    },

    async press(input) {
      const found = attachment(input.handle, "press");
      const ref = registry.resolveReference(input.reference, input.handle);
      found.automation.require(
        await found.automation.run(pressArgs(ref)),
        "Pressing the element",
        true,
      );
      registry.invalidate(input.handle);
    },

    async tap(input) {
      const found = attachment(input.handle, input.viewport ? "stream" : "press");
      if (input.viewport) {
        await found.backend.tap(found.hub.descriptor, {
          x: input.point.x / input.viewport.width,
          y: input.point.y / input.viewport.height,
        });
        registry.invalidate(input.handle);
        return;
      }
      found.automation.require(
        await found.automation.run(tapArgs(input.point)),
        "Tapping the point",
        true,
      );
      registry.invalidate(input.handle);
    },

    async fill(input) {
      const found = attachment(input.handle, "fill");
      const ref = registry.resolveReference(input.reference, input.handle);
      found.automation.require(
        await found.automation.run(fillArgs(ref, input.text)),
        "Filling the field",
        true,
      );
      registry.invalidate(input.handle);
    },

    async swipe(input) {
      const found = attachment(input.handle, input.viewport ? "stream" : "swipe");
      if (input.viewport) {
        const { width, height } = input.viewport;
        await found.backend.swipe(
          found.hub.descriptor,
          { x: input.from.x / width, y: input.from.y / height },
          { x: input.to.x / width, y: input.to.y / height },
        );
        registry.invalidate(input.handle);
        return;
      }
      found.automation.require(
        await found.automation.run(swipeArgs(input.from, input.to)),
        "Swiping",
        true,
      );
      registry.invalidate(input.handle);
    },

    async key(input) {
      const found = attachment(input.handle, "key");
      if (!(await found.backend.pressKey(found.hub.descriptor, input.key)))
        found.automation.require(
          await found.automation.run(keyArgs(input.key)),
          "Pressing the key",
          true,
        );
      registry.invalidate(input.handle);
    },

    async screenshot(handle) {
      const found = attachment(handle, "screenshot");
      const path = join(found.stateDir, `screenshot-${crypto.randomUUID()}.png`);
      try {
        found.automation.require(
          await found.automation.run(screenshotArgs(path)),
          "Capturing a screenshot",
        );
        const file = await lstat(path).catch(() => null);
        if (!file?.isFile())
          throw deviceError("invalid-artifact", "The screenshot helper wrote no readable file.");
        if (file.size > Device.MAX_SCREENSHOT_BYTES)
          throw deviceError(
            "invalid-artifact",
            "The screenshot exceeded the maximum allowed size.",
          );
        const data = await readFile(path).catch(() => null);
        if (!data)
          throw deviceError("invalid-artifact", "The screenshot helper wrote no readable file.");
        if (data.byteLength > Device.MAX_SCREENSHOT_BYTES)
          throw deviceError(
            "invalid-artifact",
            "The screenshot exceeded the maximum allowed size.",
          );
        const dimensions = readPngDimensions(data);
        if (!dimensions)
          throw deviceError("invalid-artifact", "The screenshot was not a readable PNG.");
        return {
          data,
          ...dimensions,
          deviceId: found.handle.deviceId,
          platform: found.handle.platform,
        };
      } finally {
        await rm(path, { force: true }).catch(() => undefined);
      }
    },

    async stream(handle) {
      return attachment(handle).hub.descriptor;
    },

    async close(input) {
      const found = attachments.get(input.handle.token);
      if (!found) return;
      // Verify the whole handle, not just the token, so a stale or mismatched handle never tears down a live device.
      if (!Device.sameHandle(found.handle, input.handle)) {
        throw deviceError(
          "detached",
          "This device handle is no longer attached; open the device again.",
        );
      }
      if (input.shutdown && found.bootedByUs) await found.backend.shutdown(found.handle.deviceId);
      attachments.delete(input.handle.token);
      registry.release(input.handle);
      await teardown(found);
    },

    async dispose() {
      const entries = [...attachments.values()];
      attachments.clear();
      for (const entry of entries) {
        registry.release(entry.handle);
        await teardown(entry);
      }
    },
  };

  async function teardown(entry: Attachment): Promise<void> {
    await Promise.all([
      entry.automation.run(closeArgs(), 10_000).catch(() => undefined),
      entry.hub.stop().catch(() => undefined),
    ]);
    await rm(entry.stateDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function openAutomation(
  automation: Automation,
  signal?: AbortSignal,
): Promise<Device.Capabilities> {
  automation.require(
    await automation.run(["open", "--no-test-ime", "--no-record"], undefined, signal),
    "Opening the automation session",
  );
  return readCapabilities(automation, signal);
}

// Read only capabilities reported by the automation engine. Streaming is a separate backend.
async function readCapabilities(
  automation: Automation,
  signal?: AbortSignal,
): Promise<Device.Capabilities> {
  const result = await automation.run(capabilitiesArgs(), undefined, signal).catch(() => null);
  signal?.throwIfAborted();
  const reported = result && result.code === 0 ? parseCapabilities(result.stdout) : null;
  const base = (reported ?? []).filter((capability) => capability !== "stream");
  const supported = [...new Set<Device.Capability>([...base, "stream"])];
  const unsupported = ALL_CAPABILITIES.filter((capability) => !supported.includes(capability)).map(
    (capability) => ({
      capability,
      reason: reported
        ? "Not reported by the device's automation engine."
        : "The automation engine did not return a readable capability report.",
    }),
  );
  return { supported, unsupported };
}
