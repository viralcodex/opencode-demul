import { Device } from "../rpc.js";
import { cancellationError, deviceError, isDeviceFailure } from "./errors.js";
import { spawnProcess, stopProcess, type LongRunningProcess } from "./process.js";
import { Option, Schema } from "effect";
import { parseJson } from "./json.js";

export async function sendGesture(
  stream: Device.StreamDescriptor,
  gesture:
    | { type: "tap"; x: number; y: number }
    | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number },
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
  try {
    await postGesture(stream, gesture, requestSignal);
  } catch (error) {
    if (isDeviceFailure(error)) throw error;
    if (requestSignal.aborted) throw cancellationError(requestSignal, true);
    throw deviceError("helper-failed", "The device gesture connection failed.", true);
  }
}

async function postGesture(
  stream: Device.StreamDescriptor,
  gesture: Parameters<typeof sendGesture>[1],
  signal: AbortSignal,
): Promise<void> {
  const url = new URL(`/vendor/serve-emu/api/${gesture.type}`, stream.baseUrl);
  url.searchParams.set("device", stream.deviceId);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${stream.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(gesture),
    redirect: "error",
    signal,
  });
  const result = parseJson(
    Schema.Struct({ ok: Schema.Boolean, error: Schema.optionalKey(Schema.String) }),
    await response.text(),
  );
  if (!response.ok || Option.isNone(result) || !result.value.ok) {
    const detail = Option.isSome(result) ? result.value.error?.trim() : undefined;
    const safeDetail = detail?.replaceAll(stream.token, "[redacted]").slice(0, 512);
    throw deviceError(
      "helper-failed",
      `The device rejected the ${gesture.type} gesture (HTTP ${response.status})${safeDetail ? `: ${safeDetail}` : "."}`,
      true,
    );
  }
}

export interface HubOptions {
  externalNode: string;
  hubCli: string;
  platform: Device.Platform;
  // The device the session is pinned to: a simulator UDID or an adb serial.
  deviceId: string;
  // How long to wait for the hub's ready line before giving up.
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  stopKillMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  // Preserve a stop that timed out before startup completed, so the owning runtime can retry it.
  onCleanupFailure?: (stop: () => Promise<void>) => void;
}

// The hub's ready endpoint: a loopback origin and the session token minted by `--require-token`.
export interface HubReady {
  baseUrl: string;
  token: string;
}

// The loopback host the hub binds to. The stream never leaves the machine.
export const LOOPBACK_HOST = "127.0.0.1";

export function hubArgs(options: HubOptions): string[] {
  return [
    options.hubCli,
    "--host",
    LOOPBACK_HOST,
    "--require-token",
    "--transport",
    "h264",
    "--platform",
    options.platform,
    "--single-device",
    options.deviceId,
    ...(options.platform === "android" ? ["--stream-source", "scrcpy"] : []),
  ];
}

// Parse a hub ready line such as `Local: http://localhost:3400/?token=abc` into its loopback origin and token.
export function parseReady(line: string): HubReady | null {
  const match = line.match(/https?:\/\/[^\s]*token=[^\s]+/u);
  if (!match || !URL.canParse(match[0])) return null;
  const parsed = new URL(match[0]);
  const token = parsed.searchParams.get("token");
  if (!token) return null;
  return { baseUrl: parsed.origin, token };
}

export function streamDescriptor(
  ready: HubReady,
  platform: Device.Platform,
  deviceId: string,
): Device.StreamDescriptor {
  return {
    platform,
    deviceId,
    baseUrl: ready.baseUrl,
    token: ready.token,
    protocol: "h264",
    loopback: true,
  };
}

export interface HubSession {
  descriptor: Device.StreamDescriptor;
  process: LongRunningProcess;
  // Allow 2 seconds for SIGTERM, then 2 seconds for SIGKILL before reporting a cleanup timeout.
  stop(): Promise<void>;
}

export function startHub(options: HubOptions, spawn = spawnProcess): Promise<HubSession> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  return new Promise<HubSession>((resolve, reject) => {
    let settled = false;
    const process = spawn({
      command: options.externalNode,
      args: hubArgs(options),
      env: options.env,
      onStdoutLine: (line) => {
        if (settled) return;
        const parsed = parseReady(line);
        if (parsed) finishReady(parsed);
      },
    });
    const timer = setTimeout(() => {
      fail(deviceError("timeout", "The device hub did not become ready within the deadline."));
    }, readyTimeoutMs);
    const stop = () => stopProcess(process, options.stopGraceMs, options.stopKillMs);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      action();
    };
    const fail = (error: unknown) =>
      finish(() => {
        void stop().then(
          () => reject(error),
          (cleanupError) => {
            options.onCleanupFailure?.(stop);
            reject(cleanupError);
          },
        );
      });
    const abort = () => fail(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const finishReady = (value: HubReady) =>
      finish(() =>
        resolve({
          descriptor: streamDescriptor(value, options.platform, options.deviceId),
          process,
          stop,
        }),
      );
    process.exited.then(({ code }) =>
      finish(() =>
        reject(
          deviceError("helper-failed", `The device hub exited before it was ready (code ${code}).`),
        ),
      ),
    );
  });
}
