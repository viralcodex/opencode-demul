import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { deviceError } from "./errors.js";
import { runCommand, spawnProcess, type LongRunningProcess } from "./process.js";

// Android emulator lifecycle. Discovery names an AVD; attachment must turn that into a booted adb serial. Booting is
// explicit and only happens when the caller asked for it, and the runtime records whether it booted the emulator so it
// can shut down only what it started and never a device the user was already running.

export interface AndroidOptions {
  androidSdkRoot?: string;
  timeoutMs?: number;
}

export interface BootedDevice {
  serial: string;
  // True only when this call started the emulator, so cleanup never stops a pre-existing one.
  bootedByUs: boolean;
  // The emulator process when this call started it; absent when the emulator was already running.
  process?: LongRunningProcess;
}

export function resolveAndroidSdkRoot(
  options: {
    root?: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configured = options.root ?? (env["ANDROID_HOME"] || env["ANDROID_SDK_ROOT"]);
  if (configured) return configured;
  if (platform === "darwin") return posix.join(home, "Library", "Android", "sdk");
  if (platform === "linux") return posix.join(home, "Android", "Sdk");
  if (platform === "win32")
    return win32.join(
      env["LOCALAPPDATA"] || win32.join(home, "AppData", "Local"),
      "Android",
      "Sdk",
    );
  return undefined;
}

export function androidToolPath(
  tool: "adb" | "emulator",
  root?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = platform === "win32" ? `${tool}.exe` : tool;
  if (!root) return executable;
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(root, tool === "adb" ? "platform-tools" : "emulator", executable);
}

// Find the adb serial of a running emulator whose reported AVD name matches, or null when none is running.
export async function resolveRunningSerial(
  options: AndroidOptions,
  avdName: string,
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const devices = await runCommand({ command: adb, args: ["devices"], timeoutMs });
  const serials = devices.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
  for (const serial of serials) {
    const name = await runCommand({
      command: adb,
      args: ["-s", serial, "emu", "avd", "name"],
      timeoutMs,
    });
    if (name.stdout.split("\n")[0]?.trim() === avdName) return serial;
  }
  return null;
}

export async function ensureBooted(
  options: AndroidOptions,
  avdName: string,
  bootIntent: boolean,
): Promise<BootedDevice> {
  const existing = await resolveRunningSerial(options, avdName);
  if (existing) return { serial: existing, bootedByUs: false };
  if (!bootIntent) {
    throw deviceError(
      "not-found",
      `The device "${avdName}" is not booted; open it with boot enabled.`,
    );
  }
  const bootTimeoutMs = options.timeoutMs ?? 180_000;
  const process = spawnProcess({
    command: androidToolPath("emulator", options.androidSdkRoot),
    args: ["-avd", avdName, "-no-window", "-no-boot-anim"],
  });
  const serial = await waitForSerial(options, avdName, bootTimeoutMs);
  if (!serial) {
    process.stop("SIGKILL");
    throw deviceError("timeout", `The device "${avdName}" did not boot within the deadline.`);
  }
  await waitForBootCompleted(options, serial, bootTimeoutMs).catch(async (error) => {
    process.stop("SIGKILL");
    await process.exited;
    throw error;
  });
  return { serial, bootedByUs: true, process };
}

// Stop an emulator this runtime started, by serial. Used only for devices booted by the runtime.
export async function shutdownEmulator(options: AndroidOptions, serial: string): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  await runCommand({
    command: androidToolPath("adb", options.androidSdkRoot),
    args: ["-s", serial, "emu", "kill"],
    timeoutMs,
  });
}

async function waitForSerial(
  options: AndroidOptions,
  avdName: string,
  timeoutMs: number,
): Promise<string | null> {
  return poll(
    () => resolveRunningSerial(options, avdName),
    (serial) => serial !== null,
    timeoutMs,
  );
}

async function waitForBootCompleted(
  options: AndroidOptions,
  serial: string,
  timeoutMs: number,
): Promise<void> {
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const completed = await poll(
    async () => {
      const result = await runCommand({
        command: adb,
        args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        timeoutMs: 10_000,
      });
      return result.stdout.trim();
    },
    (value) => value === "1",
    timeoutMs,
  );
  if (completed !== "1")
    throw deviceError(
      "timeout",
      `The device "${serial}" did not finish booting within the deadline.`,
    );
}

// Poll an async producer until `done` accepts a value or the deadline passes, returning the last value seen.
async function poll<T>(
  produce: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await produce();
  while (!done(value) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    value = await produce();
  }
  return value;
}
