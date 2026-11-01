import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type { Device } from "../rpc.js";
import { deviceError } from "./errors.js";

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

export function tap(stream: Device.StreamDescriptor, point: ScreenPoint): Promise<void> {
  return sendTouches(stream, tapEvents(point), TAP_HOLD_MS);
}

export function swipe(
  stream: Device.StreamDescriptor,
  from: ScreenPoint,
  to: ScreenPoint,
): Promise<void> {
  return sendTouches(stream, swipeEvents(from, to), SWIPE_DURATION_MS / SWIPE_STEPS);
}

export function pressButton(stream: Device.StreamDescriptor, button: HidButton): Promise<void> {
  return sendHid(stream, [encodeButton(button)], 0, "button press");
}

// Send touch events over one short-lived HID socket, spacing them so the simulator sees a real gesture.
export function sendTouches(
  stream: Device.StreamDescriptor,
  events: readonly TouchEvent[],
  intervalMs: number,
  openTimeoutMs?: number,
): Promise<void> {
  return sendHid(stream, events.map(encodeTouch), intervalMs, "touch input", openTimeoutMs);
}

async function sendHid(
  stream: Device.StreamDescriptor,
  messages: readonly Buffer[],
  intervalMs: number,
  action: string,
  openTimeoutMs = 10_000,
): Promise<void> {
  const url = helperUrl(stream, "ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, [`serve-sim.token.${stream.token}`]);
  // Errors surface through `opened` and `send`; this keeps a late socket error from becoming an uncaught event.
  socket.on("error", () => undefined);
  let sent = 0;
  try {
    await opened(socket, openTimeoutMs);
    for (const message of messages) {
      if (sent > 0) await delay(intervalMs);
      await send(socket, message);
      sent++;
    }
    await delay(HID_SETTLE_MS);
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.replaceAll(stream.token, "[redacted]") : "";
    throw deviceError(
      "helper-failed",
      `The simulator did not accept the ${action}${detail ? `: ${detail}` : "."}`,
      sent > 0,
    );
  } finally {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    else socket.terminate();
  }
}

// The hub reports ready before native capture starts; poll the screen config until the simulator display is served.
export async function waitForScreen(
  stream: Device.StreamDescriptor,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = helperUrl(stream, "config");
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${stream.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))),
    }).catch(() => null);
    await response?.body?.cancel().catch(() => undefined);
    if (response?.ok) return;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw deviceError(
    "timeout",
    "The simulator screen did not become available within the deadline.",
  );
}

function opened(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => fail(new Error("the HID socket did not open in time")),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", succeed);
      socket.off("error", fail);
      socket.off("unexpected-response", rejected);
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
    socket.once("open", succeed);
    socket.once("error", fail);
    socket.once("unexpected-response", rejected);
  });
}

function send(socket: WebSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("the HID socket closed"));
    socket.send(data, { binary: true }, (error) => (error ? reject(error) : resolve()));
  });
}
