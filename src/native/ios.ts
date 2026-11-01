import { Option, Schema } from "effect";
import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { parseJson } from "./json.js";
import { runCommand, type CommandResult } from "./process.js";

// iOS Simulator discovery and lifecycle through `xcrun simctl`. The discovery id is the simulator UDID, which the hub and
// automation engine also pin to, so a booted simulator needs no further resolution. As on Android, booting happens only
// when the caller asked for it, and the runtime shuts down only a simulator this module booted.

export interface SimulatorOptions {
  timeoutMs?: number;
}

export interface BootedSimulator {
  deviceId: string;
  // True only when this call booted the simulator, so cleanup never stops one the user was already running.
  bootedByUs: boolean;
}

const SimDevice = Schema.Struct({
  udid: Schema.String,
  name: Schema.String,
  state: Schema.String,
  isAvailable: Schema.optional(Schema.Boolean),
});
const SimDeviceList = Schema.Struct({
  devices: Schema.Record(Schema.String, Schema.Array(SimDevice)),
});

// Only iOS runtimes; watchOS, tvOS, and visionOS simulators are listed by simctl too but are not supported targets.
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/u;
// simctl's message when boot or shutdown finds the simulator already in the requested state.
const ALREADY_BOOTED = /current state: Booted/u;
const ALREADY_SHUTDOWN = /current state: Shutdown/u;

export function simulatorState(state: string): Device.DeviceState {
  if (state === "Booted") return "booted";
  if (state === "Shutdown") return "shutdown";
  if (state === "Booting") return "booting";
  return "unavailable";
}

// Parse `xcrun simctl list devices -j`, whose devices are grouped by runtime identifier.
export function parseSimctlDevices(output: string): Device.DeviceInfo[] | null {
  const parsed = parseJson(SimDeviceList, output);
  if (Option.isNone(parsed)) return null;
  return Object.entries(parsed.value.devices).flatMap(([runtime, devices]) => {
    const osVersion = runtime.match(IOS_RUNTIME)?.[1]?.replaceAll("-", ".");
    if (!osVersion) return [];
    return devices.map((device) => {
      const state = device.isAvailable === false ? "unavailable" : simulatorState(device.state);
      return {
        id: device.udid,
        name: device.name,
        platform: "ios" as const,
        osVersion,
        state,
        ownership: state === "shutdown" ? ("available" as const) : ("unknown" as const),
      };
    });
  });
}

export async function iosDevices(
  options: SimulatorOptions = {},
  run = runCommand,
): Promise<Device.DeviceInfo[]> {
  const result = await simctl(run, ["list", "devices", "available", "-j"], options.timeoutMs);
  if (result.code !== 0)
    throw deviceError(
      "missing-prerequisite",
      "The iOS Simulator is unavailable. Install Xcode and select it with `xcode-select`.",
    );
  const devices = parseSimctlDevices(result.stdout);
  if (!devices) throw deviceError("helper-failed", "The simulator list could not be read.");
  return devices;
}

export async function ensureSimulatorBooted(
  options: SimulatorOptions,
  udid: string,
  bootIntent: boolean,
  run = runCommand,
): Promise<BootedSimulator> {
  const device = (await iosDevices(options, run)).find((entry) => entry.id === udid);
  if (!device) throw deviceError("not-found", `The simulator "${udid}" was not found.`);
  if (device.state === "booted") return { deviceId: udid, bootedByUs: false };
  if (device.state === "unavailable")
    throw deviceError("unsupported", `The simulator "${device.name}" is unavailable.`);
  if (device.state === "shutdown" && !bootIntent)
    throw deviceError(
      "not-found",
      `The simulator "${device.name}" is not booted; open it with boot enabled.`,
    );

  const bootTimeoutMs = options.timeoutMs ?? 180_000;
  let bootedByUs = false;
  if (device.state === "shutdown") {
    const boot = await simctl(run, ["boot", udid], bootTimeoutMs);
    if (boot.code !== 0 && !ALREADY_BOOTED.test(boot.stderr))
      throw simctlFailure("Booting the simulator", boot);
    bootedByUs = boot.code === 0;
  }
  try {
    requireSuccess(
      "Waiting for the simulator to boot",
      await simctl(run, ["bootstatus", udid, "-b"], bootTimeoutMs),
    );
  } catch (error) {
    if (bootedByUs) await shutdownSimulator(options, udid, run).catch(() => undefined);
    throw error;
  }
  return { deviceId: udid, bootedByUs };
}

// Shut down a simulator this runtime booted. An already shut down simulator is not an error.
export async function shutdownSimulator(
  options: SimulatorOptions,
  udid: string,
  run = runCommand,
): Promise<void> {
  const result = await simctl(run, ["shutdown", udid], options.timeoutMs ?? 60_000);
  if (result.code !== 0 && ALREADY_SHUTDOWN.test(result.stderr)) return;
  requireSuccess("Shutting down the simulator", result, true);
}

function simctl(run: typeof runCommand, args: readonly string[], timeoutMs = 20_000) {
  return run({ command: "xcrun", args: ["simctl", ...args], timeoutMs });
}

function requireSuccess(action: string, result: CommandResult, mayHaveExecuted = false) {
  if (result.code !== 0 || result.signal || result.timedOut || result.spawnError)
    throw simctlFailure(action, result, mayHaveExecuted);
}

function simctlFailure(action: string, result: CommandResult, mayHaveExecuted = true) {
  if (result.spawnError)
    return deviceError(
      "missing-prerequisite",
      `${action} could not start xcrun: ${result.spawnError}`,
    );
  if (result.timedOut) return deviceError("timeout", `${action} timed out.`, mayHaveExecuted);
  const reason = result.stderr.trim().split("\n").slice(-2).join(" ");
  return deviceError(
    "helper-failed",
    `${action} failed (${result.signal ?? `exit ${result.code}`})${reason ? `: ${reason}` : "."}`,
    mayHaveExecuted,
  );
}
