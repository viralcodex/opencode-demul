import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { Device } from "../rpc.js";
import { cancellationError, deviceError } from "./errors.js";

// The hub's vendored serve-sim routes for an iOS Simulator. Manual input goes over its HID WebSocket: each message is one
// tag byte followed by UTF-8 JSON, and touch coordinates are normalized to the 0..1 screen surface, not pixels.

const HELPER_PATH = "/vendor/serve-sim/helper";
const TOUCH_TAG = 3;
const BUTTON_TAG = 4;
const TAP_HOLD_MS = 50;
const SWIPE_DURATION_MS = 300;
const SWIPE_STEPS = 10;
// The helper queues input and drops what it has not dispatched when the socket closes, so hold it open briefly.
const HID_SETTLE_MS = 500;

// Button payloads as serve-sim's own CLI sends them: Home by name, the rest as HID consumer-page usages.
const BUTTONS = {
  home: { button: "home" },
  lock: { button: "power", page: 12, usage: 48 },
  volumeUp: { button: "volume-up", page: 12, usage: 233 },
  volumeDown: { button: "volume-down", page: 12, usage: 234 },
} as const;

// A point on the device screen with each axis normalized to 0..1.
export interface ScreenPoint {
  x: number;
  y: number;
}

export interface TouchEvent {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
}

export type HidButton = keyof typeof BUTTONS;

export function isHidButton(key: string): key is HidButton {
  return Object.hasOwn(BUTTONS, key);
}

export function helperUrl(stream: Device.StreamDescriptor, route: string): URL {
  const url = new URL(`${HELPER_PATH}/${route}`, stream.baseUrl);
  url.searchParams.set("device", stream.deviceId);
  return url;
}

export function encodeTouch(event: TouchEvent): Buffer {
  return encode(TOUCH_TAG, event);
}

export function encodeButton(button: HidButton): Buffer {
  return encode(BUTTON_TAG, BUTTONS[button]);
}

function encode(tag: number, payload: object): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload), "utf8")]);
}

export function tapEvents(point: ScreenPoint): TouchEvent[] {
  return [
    { type: "begin", ...point },
    { type: "end", ...point },
  ];
}

export function swipeEvents(from: ScreenPoint, to: ScreenPoint, steps = SWIPE_STEPS): TouchEvent[] {
  const moves = Array.from({ length: steps - 1 }, (_, index) => {
    const progress = (index + 1) / steps;
    return {
      type: "move" as const,
      x: from.x + (to.x - from.x) * progress,
      y: from.y + (to.y - from.y) * progress,
    };
  });
  return [{ type: "begin", ...from }, ...moves, { type: "end", ...to }];
}

export function tap(
  stream: Device.StreamDescriptor,
  point: ScreenPoint,
  signal?: AbortSignal,
): Promise<void> {
  return sendTouches(stream, tapEvents(point), TAP_HOLD_MS, undefined, signal);
}

export function swipe(
  stream: Device.StreamDescriptor,
  from: ScreenPoint,
  to: ScreenPoint,
  signal?: AbortSignal,
): Promise<void> {
  return sendTouches(
    stream,
    swipeEvents(from, to),
    SWIPE_DURATION_MS / SWIPE_STEPS,
    undefined,
    signal,
  );
}

export function pressButton(
  stream: Device.StreamDescriptor,
  button: HidButton,
  signal?: AbortSignal,
): Promise<void> {
  return sendHid(stream, [encodeButton(button)], 0, "button press", undefined, signal);
}

// Send touch events over one short-lived HID socket, spacing them so the simulator sees a real gesture.
export function sendTouches(
  stream: Device.StreamDescriptor,
  events: readonly TouchEvent[],
  intervalMs: number,
  openTimeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  return sendHid(stream, events.map(encodeTouch), intervalMs, "touch input", openTimeoutMs, signal);
}

async function sendHid(
  stream: Device.StreamDescriptor,
  messages: readonly Buffer[],
  intervalMs: number,
  action: string,
  openTimeoutMs = 10_000,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const url = helperUrl(stream, "ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, [`serve-sim.token.${stream.token}`]);
  // Errors surface through `opened` and `send`; this keeps a late socket error from becoming an uncaught event.
  socket.on("error", () => undefined);
  let sent = 0;
  const abort = () => socket.terminate();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await opened(socket, openTimeoutMs, signal);
    await sendMessages(socket, messages, intervalMs, () => sent++, signal);
    await delay(HID_SETTLE_MS, undefined, { signal });
  } catch (error) {
    throw hidFailure(error, stream.token, action, sent, signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else socket.terminate();
  }
}

async function sendMessages(
  socket: WebSocket,
  messages: readonly Buffer[],
  intervalMs: number,
  onSend: () => void,
  signal?: AbortSignal,
): Promise<void> {
  for (const [index, message] of messages.entries()) {
    signal?.throwIfAborted();
    if (index > 0) await delay(intervalMs, undefined, { signal });
    if (socket.readyState !== WebSocket.OPEN) throw new Error("the HID socket closed");
    onSend();
    await send(socket, message);
  }
}

function hidFailure(
  error: unknown,
  token: string,
  action: string,
  sent: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return cancellationError(signal, sent > 0);
  const detail = error instanceof Error ? error.message.replaceAll(token, "[redacted]") : "";
  return deviceError(
    "helper-failed",
    `The simulator did not accept the ${action}${detail ? `: ${detail}` : "."}`,
    sent > 0,
  );
}

// The hub reports ready before native capture starts; poll the screen config until the simulator display is served.
export async function waitForScreen(
  stream: Device.StreamDescriptor,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const { timeoutMs = 30_000, intervalMs = 500, signal } = options;
  const deadline = Date.now() + timeoutMs;
  const url = helperUrl(stream, "config");
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const available = await screenAvailable(url, stream.token, deadline - Date.now(), signal);
    signal?.throwIfAborted();
    if (available) return;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
  throw deviceError(
    "timeout",
    "The simulator screen did not become available within the deadline.",
  );
}

async function screenAvailable(
  url: URL,
  token: string,
  remainingMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.min(5_000, remainingMs))),
      ...(signal ? [signal] : []),
    ]),
  }).catch(() => null);
  await response?.body?.cancel().catch(() => undefined);
  return response?.ok === true;
}

function opened(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error("the HID socket did not open in time")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", succeed);
      socket.off("error", fail);
      socket.off("close", closed);
      socket.off("unexpected-response", rejected);
      signal?.removeEventListener("abort", cancelled);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const rejected = (_request: unknown, response: { statusCode?: number }) =>
      fail(new Error(`the HID socket was refused (HTTP ${response.statusCode ?? "unknown"})`));
    const closed = () => fail(new Error("the HID socket closed before it opened"));
    const cancelled = () => {
      cleanup();
      reject(signal?.reason);
    };
    socket.once("open", succeed);
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("unexpected-response", rejected);
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
  });
}

function send(socket: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}
