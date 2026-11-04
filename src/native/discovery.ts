import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { runCommand } from "./process.js";
import { androidToolPath } from "./android.js";
import { adbState, parseAdbDevices, type AdbDevice } from "./adb.js";
export { adbState, parseAdbDevices } from "./adb.js";
export type { AdbDevice } from "./adb.js";

// Listing reads `adb` and `emulator` directly, so it never boots a device or starts the hub.

export interface DiscoveryOptions {
  androidSdkRoot?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// List Android devices: every AVD as a discovery entry, marked booted when a running emulator reports that AVD name.
// The discovery id is the AVD name, which `open` resolves to a running adb serial.
export async function androidDevices(options: DiscoveryOptions): Promise<Device.DeviceInfo[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const emulator = androidToolPath("emulator", options.androidSdkRoot);
  const [avdList, deviceList] = await Promise.all([
    runCommand({ command: emulator, args: ["-list-avds"], timeoutMs, signal: options.signal }),
    runCommand({ command: adb, args: ["devices"], timeoutMs, signal: options.signal }),
  ]);
  if (avdList.code !== 0)
    throw deviceError(
      "missing-prerequisite",
      "Android Emulator is unavailable. Install it in Android Studio and configure ANDROID_HOME.",
    );
  if (deviceList.code !== 0)
    throw deviceError(
      "missing-prerequisite",
      "Android adb is unavailable. Install SDK Platform-Tools and configure ANDROID_HOME.",
    );
  const avds = avdList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(" "));
  const running = parseAdbDevices(deviceList.stdout).filter((device) =>
    device.serial.startsWith("emulator-"),
  );
  const runningAvds = new Map<string, AdbDevice>();
  // Resolve names concurrently without spawning an unbounded fleet of adb processes.
  for (let offset = 0; offset < running.length; offset += 4) {
    await Promise.all(
      running.slice(offset, offset + 4).map(async (device) => {
        const name = await runCommand({
          command: adb,
          args: ["-s", device.serial, "emu", "avd", "name"],
          timeoutMs,
          signal: options.signal,
        });
        const avd = name.stdout.split("\n")[0]?.trim();
        if (avd) runningAvds.set(avd, device);
      }),
    );
  }
  return avds.map((avd) => {
    const device = runningAvds.get(avd);
    return {
      id: avd,
      name: avd.replaceAll("_", " "),
      platform: "android" as const,
      state: device ? adbState(device.state) : ("shutdown" as const),
      ownership: device ? ("unknown" as const) : ("available" as const),
    };
  });
}
