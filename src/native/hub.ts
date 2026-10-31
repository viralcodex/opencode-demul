import { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { spawnProcess, type LongRunningProcess } from "./process.js";
import { Option, Schema } from "effect";
import { parseJson } from "./json.js";

export async function sendGesture(
  stream: Device.StreamDescriptor,
  gesture:
    | { type: "tap"; x: number; y: number }
    | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; durationMs: number },
): Promise<void> {
  const url = new URL(`/vendor/serve-emu/api/${gesture.type}`, stream.baseUrl);
  url.searchParams.set("device", stream.deviceId);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${stream.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(gesture),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
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
  env?: Record<string, string>;
}

// The hub's ready endpoint: a loopback origin and the session token minted by `--require-token`.
export interface HubReady {
  baseUrl: string;
  token: string;
}

// The loopback host the hub binds to. The stream never leaves the machine.
export const LOOPBACK_HOST = "127.0.0.1";

// The wire protocol each backend's video stream actually serves, which is what the viewer must decode. The two backends
// differ and the hub's `--transport` flag (mjpeg|h264|webrtc, default mjpeg) is only a dashboard preference — it does
// not change the codec a direct stream connection receives:
//
// - Android (the vendored `serve-emu`) always serves **H.264** over its video WebSocket. Its only transports are
// `websocket` (H.264) and `webrtc` (H.264); it has no MJPEG path. Frames are raw Annex-B (each starts with the
// `00 00 00 01` start code; a keyframe opens with an SPS NAL `0x67`), or, when the socket is opened with
// `frame-meta=1`, each frame is prefixed with the `SEMU` (`0x53454d55`) metadata header carrying the keyframe flag.
// - iOS (the vendored `serve-sim`) serves **MJPEG** (`multipart/x-mixed-replace` with `image/jpeg` parts). This is read
// from the vendored implementation; it is not verified against a live simulator here.
//
// The descriptor advertises this per-platform codec so the viewer decodes what the backend sends, and the hub's own
// `--transport` preference is pinned to the same value so the dashboard never disagrees with the direct stream.
export function streamProtocolFor(platform: Device.Platform): Device.StreamProtocol {
  return platform === "ios" ? "mjpeg" : "h264";
}

export function hubArgs(options: HubOptions): string[] {
  return [
    options.hubCli,
    "--host",
    LOOPBACK_HOST,
    "--require-token",
    "--transport",
    streamProtocolFor(options.platform),
    "--platform",
    options.platform,
    "--single-device",
    options.deviceId,
  ];
}

// Parse a hub ready line such as `Local: http://localhost:3400/?token=abc` into its loopback origin and token.
export function parseReady(line: string): HubReady | null {
  const match = line.match(/https?:\/\/[^\s]*token=[^\s]+/u);
  if (!match) return null;
  const parsed = toUrl(match[0]);
  if (!parsed) return null;
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
    protocol: streamProtocolFor(platform),
    loopback: true,
  };
}

export interface HubSession {
  descriptor: Device.StreamDescriptor;
  process: LongRunningProcess;
  // Stop the hub and await its exit, so no streaming backend outlives the attachment.
  stop(): Promise<void>;
}

export function startHub(options: HubOptions): Promise<HubSession> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  return new Promise<HubSession>((resolve, reject) => {
    let settled = false;
    let ready: HubReady | null = null;
    const process = spawnProcess({
      command: options.externalNode,
      args: hubArgs(options),
      env: options.env,
      onStdoutLine: (line) => {
        if (ready) return;
        const parsed = parseReady(line);
        if (parsed) {
          ready = parsed;
          finishReady(parsed);
        }
      },
    });
    const timer = setTimeout(() => {
      if (settled) return;
      process.stop("SIGKILL");
      finish(() =>
        reject(deviceError("timeout", "The device hub did not become ready within the deadline.")),
      );
    }, readyTimeoutMs);
    const stop = async () => {
      process.stop();
      await process.exited;
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
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

function toUrl(value: string): URL | null {
  return URL.canParse(value) ? new URL(value) : null;
}
