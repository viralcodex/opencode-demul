import type { Device } from "../rpc.js";
import { androidHelperEnv, ensureBooted, shutdownEmulator } from "./android.js";
import { androidDevices } from "./discovery.js";
import { sendGesture } from "./hub.js";
import { ensureSimulatorBooted, iosDevices, shutdownSimulator } from "./ios.js";
import * as ServeSim from "./serve-sim.js";
import type { ScreenPoint } from "./serve-sim.js";

// Everything that differs between Android emulators and iOS simulators. The runtime owns helpers, the hub, handles,
// and automation the same way for both platforms and delegates only these steps to the device's backend.
export interface PlatformBackend {
  list(): Promise<Device.DeviceInfo[]>;
  // Resolve a discovery id to the booted device id the helpers pin to, booting only when asked.
  ensureBooted(id: string, boot: boolean): Promise<{ deviceId: string; bootedByUs: boolean }>;
  shutdown(deviceId: string): Promise<void>;
  // Extra environment for the hub and automation helpers.
  readonly env: Record<string, string> | undefined;
  // Resolves once the hub serves the device's screen.
  streamReady(stream: Device.StreamDescriptor): Promise<void>;
  tap(stream: Device.StreamDescriptor, point: ScreenPoint): Promise<void>;
  swipe(stream: Device.StreamDescriptor, from: ScreenPoint, to: ScreenPoint): Promise<void>;
  // Press a key through the hub, resolving false when the automation engine should handle it instead.
  pressKey(stream: Device.StreamDescriptor, key: Device.NavigationKey): Promise<boolean>;
}

export function androidBackend(androidSdkRoot: string | undefined): PlatformBackend {
  const options = { androidSdkRoot };
  return {
    list: () => androidDevices(options),
    ensureBooted: async (id, boot) => {
      const { serial, bootedByUs } = await ensureBooted(options, id, boot);
      return { deviceId: serial, bootedByUs };
    },
    shutdown: (serial) => shutdownEmulator(options, serial),
    env: androidHelperEnv(androidSdkRoot),
    streamReady: async () => undefined,
    tap: (stream, point) => sendGesture(stream, { type: "tap", ...point }),
    swipe: (stream, from, to) =>
      sendGesture(stream, {
        type: "swipe",
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        durationMs: 300,
      }),
    pressKey: async () => false,
  };
}

export function iosBackend(): PlatformBackend {
  return {
    list: () => iosDevices(),
    ensureBooted: (udid, boot) => ensureSimulatorBooted({}, udid, boot),
    shutdown: (udid) => shutdownSimulator({}, udid),
    env: undefined,
    streamReady: (stream) => ServeSim.waitForScreen(stream),
    tap: ServeSim.tap,
    swipe: ServeSim.swipe,
    // The automation engine cannot press lock or volume on a simulator, so hardware buttons go through the hub.
    pressKey: async (stream, key) => {
      if (!ServeSim.isHidButton(key)) return false;
      await ServeSim.pressButton(stream, key);
      return true;
    },
  };
}
