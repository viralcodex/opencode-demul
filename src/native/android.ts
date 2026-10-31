import { homedir } from "node:os";
import { createServer, type Socket } from "node:net";
import { posix, win32 } from "node:path";
import { deviceError } from "./errors.js";
import {
  appendBounded,
  runCommand,
  spawnProcess,
  stopProcess,
  type LongRunningProcess,
} from "./process.js";

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

export function androidHelperEnv(
  root?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> | undefined {
  if (!root) return undefined;
  const paths = platform === "win32" ? win32 : posix;
  const pathKey =
    platform === "win32"
      ? (Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path")
      : "PATH";
  return {
    ANDROID_HOME: root,
    ANDROID_SDK_ROOT: root,
    [pathKey]: [
      paths.join(root, "platform-tools"),
      paths.join(root, "emulator"),
      ...(env[pathKey] ? [env[pathKey]] : []),
    ].join(paths.delimiter),
  };
}

// Find the adb serial of a running emulator whose reported AVD name matches, or null when none is running.
export async function resolveRunningSerial(
  options: AndroidOptions,
  avdName: string,
  run = runCommand,
  expectedSerial?: string,
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const devices = await run({ command: adb, args: ["devices"], timeoutMs });
  const serials = devices.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
  for (const serial of serials) {
    if (expectedSerial && serial !== expectedSerial) continue;
    const name = await run({
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
  dependencies: {
    run?: typeof runCommand;
    spawn?: typeof spawnProcess;
    pollIntervalMs?: number;
  } = {},
): Promise<BootedDevice> {
  const run = dependencies.run ?? runCommand;
  const existing = await resolveRunningSerial(options, avdName, run);
  if (existing) return { serial: existing, bootedByUs: false };
  if (!bootIntent) {
    throw deviceError(
      "not-found",
      `The device "${avdName}" is not booted; open it with boot enabled.`,
    );
  }
  const bootTimeoutMs = options.timeoutMs ?? 180_000;
  const report = await consoleReport();
  const abort = new AbortController();
  let child: LongRunningProcess | undefined;
  let stderr = "";
  try {
    child = (dependencies.spawn ?? spawnProcess)({
      command: androidToolPath("emulator", options.androidSdkRoot),
      args: ["-avd", avdName, "-no-window", "-no-boot-anim", "-report-console", report.address],
      maxBytes: 4_096,
      onStderrLine: (line) => {
        stderr = appendBounded(stderr, `${line}\n`, 4_096);
      },
    });
    const process = child;
    const failed = process.exited.then(({ code, signal }) => {
      const error = deviceError(
        "helper-failed",
        `The emulator for "${avdName}" exited during startup (${signal ?? `code ${code}`}): ${stderr.trim() || "no startup diagnostics"}`,
      );
      abort.abort(error);
      throw error;
    });
    const boot = async (): Promise<BootedDevice> => {
      const serial = await poll(
        () =>
          report.serial
            ? resolveRunningSerial(options, avdName, run, report.serial)
            : Promise.resolve(null),
        (value) => value !== null,
        bootTimeoutMs,
        abort.signal,
        dependencies.pollIntervalMs,
      );
      if (!serial)
        throw deviceError("timeout", `The device "${avdName}" did not boot within the deadline.`);
      await waitForBootCompleted(
        options,
        serial,
        bootTimeoutMs,
        run,
        abort.signal,
        dependencies.pollIntervalMs,
      );
      return { serial, bootedByUs: true, process };
    };
    return await Promise.race([failed, boot()]);
  } catch (error) {
    abort.abort(error);
    if (child) await stopProcess(child, 0);
    throw error;
  } finally {
    abort.abort();
    report.close();
  }
}

async function consoleReport() {
  const sockets = new Set<Socket>();
  const report = {
    address: "",
    serial: undefined as string | undefined,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 16) socket.destroy();
    });
    socket.on("end", () => {
      if (report.serial) return;
      if (!/^\d{4,5}\s*$/u.test(text)) return;
      const port = Number(text.trim());
      if (port >= 5554 && port <= 5682 && port % 2 === 0) report.serial = `emulator-${port}`;
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw deviceError("helper-failed", "The emulator console report listener could not start.");
  report.address = `tcp:${address.port},max=10`;
  return report;
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

async function waitForBootCompleted(
  options: AndroidOptions,
  serial: string,
  timeoutMs: number,
  run = runCommand,
  signal?: AbortSignal,
  intervalMs?: number,
): Promise<void> {
  const adb = androidToolPath("adb", options.androidSdkRoot);
  const completed = await poll(
    async () => {
      const result = await run({
        command: adb,
        args: ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        timeoutMs: 10_000,
      });
      return result.stdout.trim();
    },
    (value) => value === "1",
    timeoutMs,
    signal,
    intervalMs,
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
  signal?: AbortSignal,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await produce();
  while (!done(value) && Date.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(intervalMs, Math.max(0, deadline - Date.now())),
      );
      signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
    value = await produce();
  }
  return value;
}
