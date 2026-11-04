import { Option, Schema } from "effect";
import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";
import { parseJson } from "./json.js";

const Health = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  lastError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

// The hub's ready line only confirms its listener. This request starts capture and checks the Android encoder.
export async function waitForScreen(
  stream: Device.StreamDescriptor,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url = new URL("/vendor/serve-emu/health", stream.baseUrl);
  url.searchParams.set("device", stream.deviceId);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${stream.token}` },
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(options.signal ? [options.signal] : []),
      ]),
    });
    requireStreaming(response, await response.text(), stream.token);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw deviceError(
        "timeout",
        `The Android screen did not become available within ${timeoutMs} ms.`,
      );
    throw error;
  }
}

function requireStreaming(response: Response, text: string, token: string): void {
  const health = parseJson(Health, text);
  if (
    response.ok &&
    Option.isSome(health) &&
    health.value.ok &&
    health.value.status === "streaming"
  )
    return;
  const detail = Option.isSome(health) ? (health.value.error ?? health.value.lastError) : undefined;
  throw deviceError(
    "helper-failed",
    `Android video startup failed (HTTP ${response.status}): ${detail?.replaceAll(token, "[redacted]").slice(0, 512) || "the capture session is not streaming"}`,
  );
}
