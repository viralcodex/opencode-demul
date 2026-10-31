import { Option, Schema } from "effect";
import { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { parseJson } from "./json.js";
import { runCommand, type CommandResult } from "./process.js";

export interface AutomationOptions {
  externalNode: string;
  agentDeviceBin: string;
  platform: Device.Platform;
  // The real device identity the session is pinned to: an adb serial on Android, a simulator UDID on iOS.
  deviceId: string;
  // The isolated working directory that scopes this attachment's agent-device session.
  stateDir: string;
  // Default per-command deadline. Cold iOS runner builds are slower; callers override where needed.
  timeoutMs?: number;
  env?: Record<string, string>;
}

// Launch an app. agent-device has no `launch` command; `open <app>` boots the target when needed and brings the app to
// the foreground. A deep link is the optional positional URL; `--relaunch` terminates a running process first.
export function launchArgs(app: string, deepLink?: string, relaunch?: boolean): string[] {
  const base = deepLink ? ["open", app, deepLink] : ["open", app];
  return relaunch ? [...base, "--relaunch"] : base;
}
export function snapshotArgs(interactiveOnly: boolean): string[] {
  return interactiveOnly ? ["snapshot", "-i", "--json"] : ["snapshot", "--json"];
}
export function pressArgs(ref: Device.ElementRef): string[] {
  return ["press", ref, "--settle"];
}
export function tapArgs(point: Device.LogicalPoint): string[] {
  return ["press", String(point.x), String(point.y), "--settle"];
}
export function fillArgs(ref: Device.ElementRef, value: string): string[] {
  return ["fill", ref, value, "--settle"];
}
// agent-device's base `swipe` takes two positional coordinate pairs and flings between them; it has no duration flag.
export function swipeArgs(from: Device.LogicalPoint, to: Device.LogicalPoint): string[] {
  return ["swipe", String(from.x), String(from.y), String(to.x), String(to.y)];
}

// agent-device has no `key` command; each contract navigation key maps to its own dedicated command.
const KEY_COMMAND: Record<Device.NavigationKey, readonly string[]> = {
  home: ["home"],
  back: ["back", "--settle"],
  recents: ["app-switcher"],
  lock: ["hardware-button", "sleep"],
  volumeUp: ["hardware-button", "volume-up"],
  volumeDown: ["hardware-button", "volume-down"],
};
export function keyArgs(key: Device.NavigationKey): string[] {
  return [...KEY_COMMAND[key]];
}
export function screenshotArgs(path: string): string[] {
  return ["screenshot", path];
}
export function appsArgs(): string[] {
  return ["apps", "--all", "--json"];
}
export function installArgs(artifact: string): string[] {
  return ["install", artifact];
}
export function capabilitiesArgs(): string[] {
  return ["capabilities", "--json"];
}
export function closeArgs(): string[] {
  return ["close"];
}

// One node of agent-device's `--json` snapshot. Only the fields the contract surfaces are read; the rest are ignored.
const SnapshotNode = Schema.Struct({
  ref: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  focused: Schema.optional(Schema.Boolean),
});
const SnapshotReport = Schema.Struct({
  data: Schema.Struct({
    nodes: Schema.Array(SnapshotNode),
    // The engine sets this when it dropped nodes, so the contract's `complete` is its negation.
    truncated: Schema.optional(Schema.Boolean),
  }),
});

// Decode agent-device's bare `e<n>` ref into the contract's branded, `@`-prefixed {@link Device.ElementRef}.
const decodeRef = Schema.decodeUnknownOption(Device.ElementRef);

export function parseSnapshotJson(
  output: string,
): { nodes: Device.AccessibilityNode[]; complete: boolean } | null {
  const parsed = parseJson(SnapshotReport, output);
  if (Option.isNone(parsed)) return null;
  const nodes = parsed.value.data.nodes.flatMap((node) => {
    const role = node.kind ?? node.type;
    if (!role) return [];
    const decoded = node.ref
      ? decodeRef(node.ref.startsWith("@") ? node.ref : `@${node.ref}`)
      : Option.none();
    const result: Device.AccessibilityNode = {
      role,
      ...(Option.isSome(decoded) ? { ref: decoded.value } : {}),
      ...(node.label ? { name: node.label } : {}),
      ...(node.value !== undefined ? { value: node.value } : {}),
      ...(node.enabled !== undefined ? { enabled: node.enabled } : {}),
      ...(node.focused !== undefined ? { focused: node.focused } : {}),
    };
    return [result];
  });
  return { nodes, complete: !(parsed.value.data.truncated ?? false) };
}

const AppList = Schema.Struct({
  data: Schema.Struct({
    apps: Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.Struct({
          id: Schema.optional(Schema.String),
          bundleId: Schema.optional(Schema.String),
          packageName: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          label: Schema.optional(Schema.String),
        }),
      ]),
    ),
  }),
});

// A compact app entry agent-device prints as `Name (com.example.app)`; the trailing parenthesised group is the id.
const APP_ENTRY = /^(.+?)\s+\(([^()]+)\)\s*$/u;

// Parse an agent-device app listing, reading the JSON envelope and tolerating both the string and object entry forms.
export function parseApps(output: string): Device.AppInfo[] | null {
  const parsed = parseJson(AppList, output);
  if (Option.isNone(parsed)) return null;
  return parsed.value.data.apps.flatMap((entry) => {
    if (typeof entry === "string") {
      const match = entry.match(APP_ENTRY);
      if (match) return [{ id: match[2]!, name: match[1]! }];
      return entry.trim() ? [{ id: entry.trim() }] : [];
    }
    const id = entry.id ?? entry.bundleId ?? entry.packageName;
    if (!id) return [];
    const name = entry.name ?? entry.label;
    return [name ? { id, name } : { id }];
  });
}

const CapabilityReport = Schema.Struct({
  data: Schema.Struct({
    availableCommands: Schema.optional(Schema.Array(Schema.String)),
  }),
});

// The agent-device command name behind each contract capability it can report. `stream` is the hub's, not here.
const COMMAND_OF: Record<Exclude<Device.Capability, "stream">, string> = {
  apps: "apps",
  // agent-device has no `launch`/`key` command; the launch capability is backed by `open`, and key navigation by `home`.
  launch: "open",
  install: "install",
  snapshot: "snapshot",
  press: "press",
  fill: "fill",
  swipe: "swipe",
  key: "home",
  screenshot: "screenshot",
};

export function parseCapabilities(output: string): Device.Capability[] | null {
  const parsed = parseJson(CapabilityReport, output);
  if (Option.isNone(parsed)) return null;
  const names = new Set(parsed.value.data.availableCommands ?? []);
  const keys = Object.keys(COMMAND_OF) as Exclude<Device.Capability, "stream">[];
  return keys.filter((capability) => names.has(COMMAND_OF[capability]));
}

export interface Automation {
  run(args: readonly string[], timeoutMs?: number): Promise<CommandResult>;
  // Map a non-zero result to a typed device error. `mayHaveExecuted` marks a mutation that was already dispatched.
  require(result: CommandResult, action: string, mayHaveExecuted?: boolean): CommandResult;
}

// Build the dispatcher bound to one external Node, agent-device CLI, platform, and isolated session directory.
export function createAutomation(options: AutomationOptions): Automation {
  const timeout = options.timeoutMs ?? 120_000;
  // Every command is pinned to the one selected device, and the isolated cwd scopes the implicit per-attachment session.
  const selection = [
    "--platform",
    options.platform,
    options.platform === "android" ? "--serial" : "--udid",
    options.deviceId,
  ];
  const run: Automation["run"] = (args, timeoutMs) =>
    runCommand({
      command: options.externalNode,
      args: [options.agentDeviceBin, ...args, ...selection],
      cwd: options.stateDir,
      env: options.env,
      timeoutMs: timeoutMs ?? timeout,
    });
  const require: Automation["require"] = (result, action, mayHaveExecuted = false) => {
    if (result.timedOut) throw deviceError("timeout", `${action} timed out.`, mayHaveExecuted);
    if (result.spawnError)
      throw deviceError("helper-failed", `${action} could not start: ${result.spawnError}`);
    if (result.code !== 0) {
      const reason =
        result.stderr
          .split("\n")
          .filter((line) => line.trim())
          .slice(-2)
          .join(" ") || result.stdout.trim();
      throw deviceError(
        "helper-failed",
        `${action} failed: ${reason || `exit ${result.code}`}`,
        mayHaveExecuted,
      );
    }
    return result;
  };
  return { run, require };
}
