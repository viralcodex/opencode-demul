import { spawn } from "node:child_process";
import { deviceError } from "./errors.js";

// The child-process boundary for the native runtime. The plugin's Electron main process never imports a native addon;
// it spawns the helper CLIs under an external Node runtime and talks to them here. Output is bounded so a chatty or
// runaway helper cannot grow memory without limit, and every run has a deadline.

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  // Deadline in milliseconds. On expiry the child is killed and `timedOut` is true.
  timeoutMs: number;
  // The maximum bytes retained per stream. Beyond this the capture is truncated, not dropped.
  maxBytes?: number;
  // Optional data to write to the child's stdin, then close it.
  input?: string;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  // Set when the child could not be spawned at all, for example a missing executable.
  spawnError?: string;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

// Append a chunk to a bounded buffer, keeping the newest bytes once the cap is reached.
export function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const combined = current + chunk;
  return combined.length <= maxBytes ? combined : combined.slice(combined.length - maxBytes);
}

// Run a command to completion and capture its bounded output. Never rejects: a missing executable, a non-zero exit, and
// a timeout all resolve to a {@link CommandResult} the caller inspects, so the runtime maps them to typed device errors
// rather than unwinding through exceptions.
export function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs);
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.on(
      "data",
      (chunk: Buffer) => (stdout = appendBounded(stdout, chunk.toString("utf8"), maxBytes)),
    );
    child.stderr?.on(
      "data",
      (chunk: Buffer) => (stderr = appendBounded(stderr, chunk.toString("utf8"), maxBytes)),
    );
    child.on("error", (error) =>
      finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error.message }),
    );
    child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
    if (spec.input !== undefined) child.stdin?.end(spec.input);
    else child.stdin?.end();
  });
}

export interface LongRunningProcess {
  readonly pid: number | undefined;
  // Resolves when the process exits, with its code and signal.
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // Send a termination signal. The process is only asked to stop; `exited` reports when it actually did.
  stop(signal?: NodeJS.Signals): void;
  release?(): void;
}

export const STOP_GRACE_MS = 2_000;
export const STOP_KILL_MS = 2_000;
const stopping = new WeakMap<LongRunningProcess, Promise<void>>();

export function stopProcess(
  process: LongRunningProcess,
  graceMs = STOP_GRACE_MS,
  killMs = STOP_KILL_MS,
): Promise<void> {
  const existing = stopping.get(process);
  if (existing) return existing;
  const stop = async () => {
    try {
      process.stop("SIGTERM");
    } catch {}
    if (await waitForExit(process, graceMs)) return;
    try {
      process.stop("SIGKILL");
    } catch {}
    if (await waitForExit(process, killMs)) return;
    process.release?.();
    throw deviceError(
      "timeout",
      "The device helper did not exit after SIGTERM and SIGKILL within the cleanup deadline.",
    );
  };
  const result = stop();
  stopping.set(process, result);
  return result;
}

async function waitForExit(process: LongRunningProcess, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SpawnSpec extends Omit<CommandSpec, "timeoutMs" | "input"> {
  // Called for each newline-delimited line the process writes to stdout.
  onStdoutLine?: (line: string) => void;
  // Called for each newline-delimited line the process writes to stderr.
  onStderrLine?: (line: string) => void;
}

// Start a long-lived helper, for example the device hub, streaming its output line by line. The caller owns the
// lifetime: it must call `stop` and await `exited` so no helper or encoder outlives the attachment that started it.
export function spawnProcess(spec: SpawnSpec): LongRunningProcess {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env ? { ...process.env, ...spec.env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  lineReader(child.stdout, spec.onStdoutLine, spec.maxBytes);
  lineReader(child.stderr, spec.onStderrLine, spec.maxBytes);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      spec.onStderrLine?.(error.message);
      resolve({ code: null, signal: null });
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    exited,
    stop: (signal: NodeJS.Signals = "SIGTERM") => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
    release: () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    },
  };
}

// Split a readable stream into trimmed lines and forward each to `onLine`, keeping a partial trailing line buffered.
function lineReader(
  stream: NodeJS.ReadableStream | null,
  onLine?: (line: string) => void,
  maxBytes = DEFAULT_MAX_BYTES,
) {
  if (!stream || !onLine) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      onLine(appendBounded("", buffer.slice(0, index).replace(/\r$/u, ""), maxBytes));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    buffer = appendBounded("", buffer, maxBytes);
  });
  stream.on("close", () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/u, ""));
  });
}
