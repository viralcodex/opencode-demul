import { describe, expect, test } from "bun:test";
import {
  annexBCodec,
  contentPoint,
  createViewer,
  multipartBoundary,
  parseFramePacket,
  parseMjpegFrames,
  sameScreenFrame,
  screenFrame,
} from "./viewer.js";

const annexB = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x29, 0, 0, 1, 0x65, 0x88]);

test("destroying a viewer clears the previous device canvas dimensions", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const listeners = new Set<EventListener>();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    },
  });
  try {
    const canvas = { width: 100, height: 200 } as HTMLCanvasElement;
    const states: string[] = [];
    const viewer = createViewer({
      canvas,
      stream: {
        platform: "android",
        deviceId: "device-a",
        baseUrl: "http://127.0.0.1:3400",
        token: "private",
        protocol: "h264",
        loopback: true,
      },
      onState: (state) => states.push(state),
      onError: () => undefined,
    });
    expect(listeners.size).toBe(1);
    viewer.destroy();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(states).toEqual(["idle"]);
    expect(listeners.size).toBe(0);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("screen input requires a current rendered frame and rejects a changed gesture target", () => {
  const first = { token: "device-a", width: 100, height: 200 };
  expect(screenFrame(first.token, first.token, "playing", first)).toEqual(first);
  for (const state of ["idle", "connecting", "paused"] as const)
    expect(screenFrame("device-b", undefined, state, first)).toBeUndefined();
  expect(screenFrame("device-b", first.token, "playing", first)).toBeUndefined();
  expect(screenFrame("device-b", undefined, "idle", { width: 0, height: 0 })).toBeUndefined();
  const next = screenFrame("device-b", "device-b", "playing", { width: 200, height: 400 });
  expect(next).toEqual({ token: "device-b", width: 200, height: 400 });
  expect(sameScreenFrame(first, undefined)).toBe(false);
  expect(sameScreenFrame(first, next)).toBe(false);
  expect(sameScreenFrame(first, { ...first, width: 200 })).toBe(false);
  expect(sameScreenFrame(first, { ...first, height: 400 })).toBe(false);
  expect(sameScreenFrame(first, first)).toBe(true);
});

describe("parseFramePacket", () => {
  test("parses raw Annex-B and detects an IDR keyframe", () => {
    const packet = parseFramePacket(annexB.slice().buffer);
    expect(packet?.bytes).toEqual(annexB);
    expect(packet?.key).toBe(true);
    expect(packet?.timestamp).toBeGreaterThan(0);
  });

  test("parses SEMU v1 metadata", () => {
    const data = framed(1, 1, 123_456n, annexB);
    const packet = parseFramePacket(data.buffer);
    expect(packet).toEqual({
      bytes: data.subarray(16),
      key: true,
      timestamp: 123_456,
      serverTimestamp: undefined,
    });
  });

  test("parses the v2 server timestamp without treating it as dimensions", () => {
    const data = framed(2, 0, 222n, annexB, 1_735_689_600_123_000n);
    const packet = parseFramePacket(data.buffer);
    expect(packet).toEqual({
      bytes: data.subarray(24),
      key: true,
      timestamp: 222,
      serverTimestamp: 1_735_689_600_123,
    });
    expect(packet?.width).toBeUndefined();
    expect(packet?.height).toBeUndefined();
  });

  test.each([
    new Uint8Array(),
    new Uint8Array([0, 0, 0, 1]),
    framed(3, 0, 1n, annexB),
    framed(2, 0, 1n, new Uint8Array()),
    framed(1, 0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, annexB),
    new Uint8Array([0x53, 0x45, 0x4d, 0x55, 1]),
  ])("rejects malformed framing", (data) => {
    expect(parseFramePacket(data.buffer)).toBeUndefined();
  });
});

test("annexBCodec reads an SPS across mixed start-code boundaries", () => {
  expect(
    annexBCodec(
      new Uint8Array([0, 0, 0, 1, 0x68, 1, 2, 0, 0, 1, 0x67, 0x64, 0, 0x29, 0, 0, 0, 1, 0x65]),
    ),
  ).toBe("avc1.640029");
});

describe("MJPEG multipart framing", () => {
  test("reads the boundary and a Content-Length framed JPEG across chunks", () => {
    expect(multipartBoundary('multipart/x-mixed-replace; boundary="frame"')).toBe("frame");
    const first = join(
      new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n"),
      new Uint8Array([0xff, 0xd8]),
    );
    const second = new Uint8Array([0xff, 0xd9, 13, 10]);
    const partial = parseMjpegFrames(first, "frame");
    expect(partial.frames).toEqual([]);
    const complete = parseMjpegFrames(join(partial.rest, second), "frame");
    expect(complete.frames).toEqual([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]);
  });

  test.each([
    null,
    "image/jpeg",
    "multipart/x-mixed-replace",
    "multipart/x-mixed-replace; boundary=\r\ninvalid",
  ])("rejects malformed content types", (contentType) => {
    expect(multipartBoundary(contentType)).toBeUndefined();
  });

  test("does not emit malformed parts", () => {
    const malformed = new TextEncoder().encode(
      "--frame\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nnope\r\n",
    );
    const validHeader = new TextEncoder().encode(
      "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n",
    );
    const data = join(join(malformed, validHeader), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(parseMjpegFrames(data, "frame").frames).toEqual([
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ]);
  });
});

describe("contentPoint", () => {
  const bounds = { left: 10, top: 20, width: 200, height: 200 };
  const size = { width: 100, height: 50 };

  test("maps the rendered letterbox content into native pixels", () => {
    expect(contentPoint(bounds, size, { x: 10, y: 70 })).toEqual({ x: 0, y: 0 });
    expect(contentPoint(bounds, size, { x: 209.999, y: 169.999 })).toEqual({ x: 99, y: 49 });
  });

  test("excludes letterbox bars and half-open right and bottom edges", () => {
    expect(contentPoint(bounds, size, { x: 100, y: 69.999 })).toBeUndefined();
    expect(contentPoint(bounds, size, { x: 210, y: 100 })).toBeUndefined();
    expect(contentPoint(bounds, size, { x: 100, y: 170 })).toBeUndefined();
  });

  test.each([
    [{ ...bounds, width: 0 }, size],
    [bounds, { ...size, height: 0 }],
    [bounds, { ...size, width: Number.NaN }],
  ])("rejects malformed sizes", (nextBounds, nextSize) => {
    expect(contentPoint(nextBounds, nextSize, { x: 100, y: 100 })).toBeUndefined();
  });
});

function framed(
  version: number,
  flags: number,
  pts: bigint,
  payload: Uint8Array,
  serverTimestamp = 0n,
) {
  const header = version === 2 ? 24 : 16;
  const data = new Uint8Array(header + payload.byteLength);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x53454d55);
  view.setUint8(4, version);
  view.setUint8(5, flags);
  view.setBigUint64(8, pts);
  if (version === 2) view.setBigUint64(16, serverTimestamp);
  data.set(payload, header);
  return data;
}

function join(left: Uint8Array, right: Uint8Array) {
  const data = new Uint8Array(left.byteLength + right.byteLength);
  data.set(left);
  data.set(right, left.byteLength);
  return data;
}
