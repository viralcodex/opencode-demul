import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { deviceError } from "./errors.js";

// Run helpers outside Electron. Capture bounded diagnostics and enforce command and cleanup deadlines.

export interface CommandSpec {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  // Deadline in milliseconds. On expiry the child is killed and `timedOut` is true.
  timeoutMs: number;
  signal?: AbortSignal;
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

// Command failures return bounded diagnostics. Cancellation kills the child and rejects with the caller's reason.
export function runCommand(spec: CommandSpec): Promise<CommandResult> {
  if (spec.signal?.aborted) return Promise.reject(spec.signal.reason);
  const maxBytes = Math.max(0, spec.maxBytes ?? DEFAULT_MAX_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = capture(maxBytes);
    const stderr = capture(maxBytes);
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeoutMs);
    const abort = () => child.kill("SIGKILL");
    spec.signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", abort);
      if (spec.signal?.aborted) reject(spec.signal.reason);
      else resolve({ ...result, stdout: stdout.text(), stderr: stderr.text() });
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", (error) =>
      finish({ code: null, signal: null, timedOut, spawnError: error.message }),
    );
    child.on("close", (code, signal) => finish({ code, signal, timedOut }));
    if (spec.input !== undefined) child.stdin?.end(spec.input);
    else child.stdin?.end();
  });
}

// Keep bounded byte chunks and decode once, avoiding repeated large string copies and split UTF-8 characters.
function capture(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    append(chunk: Buffer) {
      chunks.push(chunk);
      size += chunk.byteLength;
      while (size > limit) {
        const first = chunks[0];
        const remove = Math.min(first.byteLength, size - limit);
        if (remove === first.byteLength) chunks.shift();
        else chunks[0] = first.subarray(remove);
        size -= remove;
      }
    },
    text: () => Buffer.concat(chunks, size).toString("utf8"),
  };
}

export interface LongRunningProcess {
  readonly pid: number | undefined;
  // Resolves when the process exits, with its code and signal.
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // Send a termination signal. The process is only asked to stop; `exited` reports when it actually did.
  stop(signal?: NodeJS.Signals): void;
  release?(): void;
}

const STOP_GRACE_MS = 2_000;
const STOP_KILL_MS = 2_000;
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
  void result.catch(() => {
    if (stopping.get(process) === result) stopping.delete(process);
  });
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

export interface SpawnSpec extends Omit<CommandSpec, "timeoutMs" | "input" | "signal"> {
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
  if (!stream) return;
  if (!onLine) {
    stream.resume();
    return;
  }
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      onLine(appendBounded("", buffer.slice(0, index).replace(/\r$/u, ""), maxBytes));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
    buffer = appendBounded("", buffer, maxBytes);
  });
  stream.on("close", () => {
    buffer = appendBounded(buffer, decoder.end(), maxBytes);
    if (buffer.length > 0) onLine(buffer.replace(/\r$/u, ""));
  });
}
