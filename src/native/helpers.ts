import { readFile, access, mkdir, readdir, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32, relative, isAbsolute, sep } from "node:path";
import { Option, Schema } from "effect";
import { deviceError } from "./errors.js";
import { parseJson } from "./json.js";
import { runCommand } from "./process.js";

// The helper installation and external-runtime resolution. The two automation helpers run under an external Node, not
// Electron's embedded one, and install into an isolated, caller-owned directory with exact pins, so the repository's
// lockfile never churns. Nothing here upgrades system tooling; it installs only these two npm packages on request.

// The exact helper versions, pinned after verifying their npm metadata, source, and MIT licensing.
export const PINS = { "agent-device": "0.21.35", "expo-device-hub": "0.19.0" } as const;

export const MIN_NODE = { major: 22, minor: 19 };

export function defaultHelperDir(home = homedir()): string {
  return join(home, ".cache", "opencode", "device-helpers");
}

export async function validateHelperDirectory(
  dir: string,
  uid = process.getuid?.(),
): Promise<void> {
  const metadata = await lstat(dir);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (uid !== undefined && (metadata.uid !== uid || (metadata.mode & 0o077) !== 0))
  ) {
    throw deviceError(
      "missing-prerequisite",
      "The device helper cache must be a private, user-owned directory without symlinks.",
    );
  }
}

async function trustedPath(root: string, path: string): Promise<boolean> {
  const child = relative(root, path);
  if (!child || isAbsolute(child) || child.split(sep).includes(".."))
    throw deviceError(
      "missing-prerequisite",
      "A device helper path escapes its package directory.",
    );
  let current = root;
  for (const part of child.split(sep)) {
    current = join(current, part);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return false;
    if (
      metadata.isSymbolicLink() ||
      (process.getuid && (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0))
    )
      throw deviceError(
        "missing-prerequisite",
        "A device helper path is symlinked or not owned securely by the current user.",
      );
  }
  return true;
}

export function parseNodeVersion(output: string) {
  const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/u);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function satisfiesNode(version: string) {
  const parts = version.split(".").map(Number);
  return parts[0] === MIN_NODE.major ? parts[1]! >= MIN_NODE.minor : parts[0]! >= 24;
}

export interface HelperPaths {
  // The isolated install root. Its `node_modules` holds the two pinned helpers.
  dir: string;
  // The agent-device CLI entry file, resolved from its installed `package.json` bin.
  agentDeviceBin: string;
  // The expo-device-hub CLI entry file, resolved from its installed `package.json` bin.
  hubCli: string;
}

// The npm command that installs the pinned helpers into `dir` without touching any outer lockfile.
export function installArgs(
  dir: string,
  node?: string,
  npmCli?: string,
): { command: string; args: string[] } {
  return {
    command: npmCli ? (node ?? "node") : "npm",
    args: [
      ...(npmCli ? [npmCli] : []),
      "install",
      "--prefix",
      dir,
      "--no-save",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      `agent-device@${PINS["agent-device"]}`,
      `expo-device-hub@${PINS["expo-device-hub"]}`,
    ],
  };
}

// Ensure both helpers are installed in `dir` at their pinned versions and return the resolved CLI entry files. When the
// bins already resolve the install is skipped, so the step is idempotent and offline after the first run.
export async function ensureHelpers(
  dir: string,
  timeoutMs = 300_000,
  node = "node",
): Promise<HelperPaths> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await validateHelperDirectory(dir);
  const existing = await resolveHelperPaths(dir);
  if (existing) return existing;

  // A manifest lets `npm --prefix` treat the directory as its own project, so the install stays local to it.
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "opencode-device-helpers", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  const npmCli = process.platform === "win32" ? await resolveNpmCli(node) : undefined;
  const { command, args } = installArgs(dir, node, npmCli);
  const result = await runCommand({ command, args, timeoutMs, cwd: dir });
  if (result.code !== 0) {
    const reason =
      result.spawnError ??
      result.stderr.split("\n").slice(-3).join(" ").trim() ??
      "npm install failed";
    throw deviceError(
      "missing-prerequisite",
      `Installing the device helpers failed: ${reason || "npm install failed"}`,
    );
  }
  const resolved = await resolveHelperPaths(dir);
  if (!resolved)
    throw deviceError(
      "missing-prerequisite",
      "The device helpers installed but their CLIs are missing.",
    );
  return resolved;
}

// Resolve both helper CLI entry files from an existing install, or null when either is not installed.
export async function resolveHelperPaths(dir: string): Promise<HelperPaths | null> {
  await validateHelperDirectory(dir);
  const agentDeviceBin = await resolveBin(dir, "agent-device");
  const hubCli = await resolveBin(dir, "expo-device-hub");
  if (!agentDeviceBin || !hubCli) return null;
  return { dir, agentDeviceBin, hubCli };
}

// The one manifest field the resolver reads: a bin as a string or a name-to-path record.
const BinManifest = Schema.Struct({
  version: Schema.String,
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
});

// Read a package's installed `package.json` and return the absolute path of its named bin, or null when absent.
async function resolveBin(dir: string, pkg: keyof typeof PINS): Promise<string | null> {
  const root = join(dir, "node_modules", pkg);
  if (!(await trustedPath(dir, join(root, "package.json")))) return null;
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  const manifest = parseJson(BinManifest, raw);
  if (Option.isNone(manifest) || manifest.value.version !== PINS[pkg]) return null;
  const bin = manifest.value.bin;
  const relative =
    typeof bin === "string" ? bin : bin ? (bin[pkg] ?? Object.values(bin)[0]) : undefined;
  if (!relative) return null;
  const resolved = join(root, relative);
  return (await trustedPath(root, resolved)) ? resolved : null;
}

// Resolve the external Node binary the helpers run under and verify it meets the automation engine's minimum. The
// candidate comes from the explicit option, then `OPENCODE_DEVICE_NODE`, then PATH with installed NVM versions as fallback.
export async function resolveExternalNode(candidate?: string, timeoutMs = 10_000): Promise<string> {
  const node = candidate ?? process.env["OPENCODE_DEVICE_NODE"] ?? "node";
  const result = await runCommand({ command: node, args: ["--version"], timeoutMs });
  const version = parseNodeVersion(result.stdout) ?? parseNodeVersion(result.stderr);
  if (
    candidate === undefined &&
    process.env["OPENCODE_DEVICE_NODE"] === undefined &&
    (result.code !== 0 || !version || !satisfiesNode(version))
  ) {
    const installed = await nvmNodeCandidates(process.env["NVM_DIR"] ?? join(homedir(), ".nvm"));
    if (installed[0]) return resolveExternalNode(installed[0], timeoutMs);
  }
  if (result.code !== 0 || !version) {
    const reason = result.spawnError ?? result.stderr.trim() ?? "not found";
    throw deviceError(
      "missing-prerequisite",
      `External Node runtime "${node}" is unavailable: ${reason || "not found"}`,
    );
  }
  if (!satisfiesNode(version)) {
    throw deviceError(
      "missing-prerequisite",
      `External Node ${version} is unsupported. Use Node 22.19 or newer on the 22.x line, or Node 24 or newer.`,
    );
  }
  const executable = await runCommand({
    command: node,
    args: ["--print", "process.execPath"],
    timeoutMs,
  });
  if (executable.code !== 0 || !executable.stdout.trim())
    throw deviceError(
      "missing-prerequisite",
      "The external Node executable path could not be resolved.",
    );
  return executable.stdout.trim();
}

export async function nvmNodeCandidates(dir: string): Promise<string[]> {
  const root = join(dir, "versions", "node");
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(
      (entry) =>
        entry.isDirectory() &&
        /^v\d+\.\d+\.\d+$/.test(entry.name) &&
        satisfiesNode(entry.name.slice(1)),
    )
    .sort((first, second) => second.name.localeCompare(first.name, undefined, { numeric: true }))
    .map((entry) => join(root, entry.name, "bin", "node"));
}

export function npmCliCandidates(
  node: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  return [
    ...(env["npm_execpath"] && paths.basename(env["npm_execpath"]) === "npm-cli.js"
      ? [env["npm_execpath"]]
      : []),
    paths.join(paths.dirname(node), "node_modules", "npm", "bin", "npm-cli.js"),
    paths.join(paths.dirname(node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...pathValue
      .split(platform === "win32" ? ";" : ":")
      .filter(Boolean)
      .map((entry) => paths.join(entry, "node_modules", "npm", "bin", "npm-cli.js")),
  ];
}

async function resolveNpmCli(node: string): Promise<string> {
  for (const candidate of npmCliCandidates(node)) {
    if (await exists(candidate)) return candidate;
  }
  throw deviceError(
    "missing-prerequisite",
    "npm is unavailable. Install Node with npm and make it available to OpenCode Desktop.",
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
