import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { runCommand } from "./process.js";
import { androidToolPath } from "./android.js";

// Listing reads `adb` and `emulator` directly, so it never boots a device or starts the hub.

export interface DiscoveryOptions {
  androidSdkRoot?: string;
  timeoutMs?: number;
}

// One line of `adb devices`: a serial and its connection state.
export interface AdbDevice {
  serial: string;
  state: string;
}

// Parse `adb devices` output into serial/state pairs, skipping its header and blank lines.
export function parseAdbDevices(output: string): AdbDevice[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*"))
    .flatMap((line) => {
      const [serial, state] = line.split(/\s+/u);
      return serial && state ? [{ serial, state }] : [];
    });
}

// Map an adb connection state to the contract's device state.
export function adbState(state: string): Device.DeviceState {
  if (state === "device") return "booted";
  if (state === "offline" || state === "connecting" || state === "authorizing") return "booting";
  return "unavailable";
}

// List Android devices: every AVD as a discovery entry, marked booted when a running emulator reports that AVD name.
// The discovery id is the AVD name, which `open` resolves to a running adb serial.
export async function androidDevices(options: DiscoveryOptions): Promise<Device.DeviceInfo[]> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const emulator = androidToolPath("emulator", options.androidSdkRoot);
  const [avdList, deviceList] = await Promise.all([
    runCommand({ command: emulator, args: ["-list-avds"], timeoutMs }),
    runCommand({ command: adb, args: ["devices"], timeoutMs }),
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
  for (const device of running) {
    const name = await runCommand({
      command: adb,
      args: ["-s", device.serial, "emu", "avd", "name"],
      timeoutMs,
    });
    const avd = name.stdout.split("\n")[0]?.trim();
    if (avd) runningAvds.set(avd, device);
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
