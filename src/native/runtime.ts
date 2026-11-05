import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Device } from "../rpc.js";
import type { DeviceBridge } from "../bridge.js";
import {
  capabilitiesArgs,
  createAutomation,
  parseCapabilities,
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
import { startHub } from "./hub.js";
import { HubConnection } from "./hub-connection.js";
import { DeviceResources } from "./resources.js";
import { createDeviceOperations, type ActiveDevice } from "./operations.js";
import { waitWithSignal } from "../cancellation.js";

export interface DeviceRuntime {
  list(platform?: Device.Platform, signal?: AbortSignal): Promise<Device.DeviceInfo[]>;
  open(input: OpenInput, signal?: AbortSignal): Promise<OpenResult>;
  apps(handle: Device.DeviceHandle, signal?: AbortSignal): Promise<Device.AppInfo[]>;
  launch(input: LaunchInput, signal?: AbortSignal): Promise<Device.LaunchResult>;
  install(input: InstallInput, signal?: AbortSignal): Promise<Device.InstallResult>;
  snapshot(input: SnapshotInput, signal?: AbortSignal): Promise<Device.Snapshot>;
  press(input: PressInput, signal?: AbortSignal): Promise<void>;
  tap(input: TapInput, signal?: AbortSignal): Promise<void>;
  fill(input: FillInput, signal?: AbortSignal): Promise<void>;
  swipe(input: SwipeInput, signal?: AbortSignal): Promise<void>;
  key(input: KeyInput, signal?: AbortSignal): Promise<void>;
  screenshot(handle: Device.DeviceHandle, signal?: AbortSignal): Promise<Device.Screenshot>;
  stream(handle: Device.DeviceHandle, signal?: AbortSignal): Promise<Device.StreamDescriptor>;
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

interface Attachment extends ActiveDevice {
  resources: DeviceResources;
}

export interface RuntimeDependencies {
  backends?: Partial<Record<Device.Platform, PlatformBackend>>;
  resolveNode?: typeof resolveExternalNode;
  helpers?: typeof ensureHelpers;
  hub?: typeof startHub;
  automation?: typeof createAutomation;
}

export function createNativeRuntime(
  options: RuntimeOptions = {},
  dependencies: RuntimeDependencies = {},
): DeviceRuntime {
  const helperDir = options.helperDir ?? defaultHelperDir();
  const stateRoot = options.stateRoot ?? join(tmpdir(), "opencode-device-sessions");
  const backends: Partial<Record<Device.Platform, PlatformBackend>> = dependencies.backends ?? {
    android: androidBackend(resolveAndroidSdkRoot({ root: options.androidSdkRoot })),
    ...(process.platform === "darwin" ? { ios: iosBackend() } : {}),
  };
  const attachments = new Map<string, Attachment>();
  const failedOpens = new Map<string, DeviceResources>();
  const registry = new HandleRegistry();
  const lifetime = new AbortController();
  const pendingOpens = new Set<Promise<void>>();
  let resolvedNode: Promise<string> | null = null;
  let installedHelpers: Promise<HelperPaths> | null = null;

  const node = () =>
    (resolvedNode ??= (dependencies.resolveNode ?? resolveExternalNode)(
      options.externalNode,
      undefined,
      lifetime.signal,
    ).catch((error) => {
      resolvedNode = null;
      throw error;
    }));
  const helpers = (externalNode: string) =>
    (installedHelpers ??= (dependencies.helpers ?? ensureHelpers)(
      helperDir,
      300_000,
      externalNode,
      lifetime.signal,
    ).catch((error) => {
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
    if (found.resources.closing)
      throw deviceError("detached", "Device cleanup is incomplete; retry closing this attachment.");
    if (capability && !found.capabilities.supported.includes(capability)) {
      const reason = found.capabilities.unsupported.find(
        (entry) => entry.capability === capability,
      )?.reason;
      throw deviceError("unsupported", reason ?? `This device does not support ${capability}.`);
    }
    return found;
  };

  const backendFor = (platform: Device.Platform) => {
    if (!["darwin", "linux", "win32"].includes(process.platform))
      throw deviceError("unsupported", "Device control supports macOS, Linux, and Windows.");
    const backend = backends[platform];
    if (!backend) throw deviceError("unsupported", "iOS simulators require a macOS host.");
    return backend;
  };

  return {
    async list(platform, signal) {
      signal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      signal.throwIfAborted();
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

    open(input, signal) {
      const combined = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
      const result = openDevice(input, combined);
      const pending = result.then(
        () => undefined,
        () => undefined,
      );
      pendingOpens.add(pending);
      void pending.then(() => pendingOpens.delete(pending));
      return result;
    },

    ...createDeviceOperations(attachment, registry),

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
      await found.resources.close(input.shutdown);
      attachments.delete(input.handle.token);
      registry.release(input.handle);
    },

    async dispose() {
      lifetime.abort();
      await Promise.all(pendingOpens);
      await Promise.allSettled([resolvedNode, installedHelpers]);
      const results = await Promise.allSettled([
        ...[...attachments.values()].map(async (entry) => {
          await entry.resources.close();
          registry.release(entry.handle);
          attachments.delete(entry.handle.token);
        }),
        ...[...failedOpens].map(async ([key, resources]) => {
          await resources.close(true);
          failedOpens.delete(key);
        }),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };

  async function openDevice(input: OpenInput, signal: AbortSignal): Promise<OpenResult> {
    signal.throwIfAborted();
    const backend = backendFor(input.platform);
    const key = JSON.stringify([input.platform, input.deviceId]);
    const previous = failedOpens.get(key);
    if (previous) {
      await previous.close(true);
      failedOpens.delete(key);
    }
    const externalNode = await waitWithSignal(node(), signal);
    const paths = await waitWithSignal(helpers(externalNode), signal);
    signal.throwIfAborted();
    const { deviceId, bootedByUs } = await backend.ensureBooted(
      input.deviceId,
      input.boot ?? false,
      signal,
    );
    const resources = new DeviceResources(backend, deviceId, bootedByUs);
    failedOpens.set(key, resources);
    const handle = registry.create(input.platform, deviceId);
    const startup = new AbortController();
    const startupSignal = AbortSignal.any([startup.signal, signal]);
    let initialized = false;
    try {
      signal.throwIfAborted();
      const env = backend.env;
      const hubOptions = {
        externalNode,
        hubCli: paths.hubCli,
        platform: input.platform,
        deviceId,
        env,
      };
      const hub = await (dependencies.hub ?? startHub)({
        ...hubOptions,
        signal,
        onCleanupFailure: (stop) => resources.retainStop(stop),
      });
      const connection = new HubConnection({
        initial: hub,
        options: hubOptions,
        start: dependencies.hub,
        ready: (stream, signal) => backend.streamReady(stream, signal),
        onExit: () => {
          registry.invalidate(handle);
          if (!initialized)
            startup.abort(deviceError("helper-failed", "Device capture exited during startup."));
        },
      });
      resources.hub = connection;
      const stateDir = join(stateRoot, handle.token);
      resources.stateDir = stateDir;
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const automation = (dependencies.automation ?? createAutomation)({
        externalNode,
        agentDeviceBin: paths.agentDeviceBin,
        platform: input.platform,
        deviceId,
        stateDir,
        env,
      });
      resources.automation = automation;
      const cancelStartup = (error: unknown): never => {
        startup.abort(error);
        throw error;
      };
      const [, controls] = await Promise.allSettled([
        backend.streamReady(hub.descriptor, startupSignal).catch(cancelStartup),
        openAutomation(automation, startupSignal).catch(cancelStartup),
      ]);
      startupSignal.throwIfAborted();
      if (controls.status === "rejected") throw controls.reason;
      await connection.descriptor(startupSignal);
      const capabilities = controls.value;
      initialized = true;
      attachments.set(handle.token, {
        handle,
        backend,
        hub: connection,
        automation,
        capabilities,
        stateDir,
        resources,
      });
      failedOpens.delete(key);
      return { handle, capabilities };
    } catch (error) {
      registry.release(handle);
      await resources.close(true);
      failedOpens.delete(key);
      throw error;
    }
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
  // The automation report contains unique control capabilities; streaming belongs to the capture backend.
  const result = await automation.run(capabilitiesArgs(), undefined, signal).catch(() => null);
  signal?.throwIfAborted();
  const reported = result && result.code === 0 ? parseCapabilities(result.stdout) : null;
  const supported: Device.Capability[] = [...(reported ?? []), "stream"];
  const unsupported = Device.Capability.literals
    .filter((capability) => !supported.includes(capability))
    .map((capability) => ({
      capability,
      reason: reported
        ? "Not reported by the device's automation engine."
        : "The automation engine did not return a readable capability report.",
    }));
  return { supported, unsupported };
}
