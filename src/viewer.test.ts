import { describe, expect, jest, test } from "bun:test";
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

function h264Fixture() {
  jest.useFakeTimers();
  const listeners = new Set<EventListener>();
  const checks: Array<ReturnType<typeof Promise.withResolvers<VideoDecoderSupport>>> = [];
  class Socket extends EventTarget {
    static instance: Socket;
    static OPEN = 1;
    readyState = 1;
    closed = false;
    binaryType = "";
    constructor() {
      super();
      Socket.instance = this;
    }
    send() {}
    close() {
      this.closed = true;
    }
    emit(type: string, properties: object = {}) {
      this.dispatchEvent(Object.assign(new Event(type), properties));
    }
  }
  class Decoder {
    static isConfigSupported() {
      const check = Promise.withResolvers<VideoDecoderSupport>();
      checks.push(check);
      return check.promise;
    }
    state = "unconfigured";
    decodeQueueSize = 0;
    constructor(private readonly callbacks: VideoDecoderInit) {}
    configure() {
      this.state = "configured";
    }
    decode() {
      this.callbacks.output({ displayWidth: 100, displayHeight: 200, close() {} } as VideoFrame);
    }
    close() {
      this.state = "closed";
    }
  }
  const globals = {
    document: {
      visibilityState: "visible",
      addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
    },
    WebSocket: Socket,
    VideoDecoder: Decoder,
    EncodedVideoChunk: class {},
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const states: string[] = [];
  const errors: string[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  } as unknown as HTMLCanvasElement;
  const viewer = createViewer({
    canvas,
    stream: {
      platform: "android",
      deviceId: "phone",
      baseUrl: "http://127.0.0.1:3400",
      token: "private-token",
      protocol: "h264",
      loopback: true,
    },
    onState: (state) => states.push(state),
    onError: (message) => errors.push(message),
  });
  viewer.active(true);
  return {
    viewer,
    states,
    errors,
    canvas,
    listeners,
    checks,
    socket: Socket.instance,
    restore() {
      viewer.destroy();
      jest.useRealTimers();
      for (const [key, original] of originals) {
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("unexpected Android video closure is visible instead of a silently blank panel", () => {
  const item = h264Fixture();
  try {
    item.socket.emit("close", { code: 1006 });
    expect(item.states).toEqual(["connecting", "paused"]);
    expect(item.errors[0]).toContain("connection closed (code 1006)");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    item.restore();
  }
});

test("Android video startup has a deadline and stops failed connections", () => {
  const item = h264Fixture();
  try {
    jest.advanceTimersByTime(15_000);
    expect(item.errors[0]).toContain("within 15 seconds");
    expect(item.socket.closed).toBe(true);
    expect(item.states.at(-1)).toBe("paused");
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    item.restore();
  }
});

test("Android backend errors are shown once and redact the stream token", () => {
  const item = h264Fixture();
  try {
    item.socket.emit("message", {
      data: JSON.stringify({ ok: false, error: "capture failed private-token" }),
    });
    item.socket.emit("close", { code: 1006 });
    expect(item.errors).toEqual(["Android video failed: capture failed [redacted]"]);
    expect(item.socket.closed).toBe(true);
  } finally {
    item.restore();
  }
});

test("Android ignores stale decoder checks, renders the current frame, and releases viewer resources", async () => {
  const item = h264Fixture();
  try {
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.socket.emit("message", {
      data: JSON.stringify({ type: "video-session", size: { width: 100, height: 200 } }),
    });
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.checks[0].reject(new Error("obsolete codec check"));
    item.checks[1].resolve({ supported: true });
    await Promise.resolve();
    expect(item.states).toEqual(["connecting", "playing"]);
    expect(item.canvas.width).toBe(100);
    expect(item.canvas.height).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
    expect(item.errors).toEqual([]);
    expect(item.listeners.size).toBe(1);
    item.socket.emit("message", {
      data: JSON.stringify({ type: "video-session", size: { width: 100, height: 200 } }),
    });
    expect(jest.getTimerCount()).toBe(1);
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.checks[2].resolve({ supported: true });
    await Promise.resolve();
    expect(jest.getTimerCount()).toBe(0);
    item.viewer.destroy();
    expect(item.canvas.width).toBe(0);
    expect(item.canvas.height).toBe(0);
    expect(item.listeners.size).toBe(0);
    item.socket.emit("close", { code: 1006 });
    expect(item.errors).toEqual([]);
  } finally {
    item.restore();
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
      codec: "avc1.640029",
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
      codec: "avc1.640029",
      timestamp: 222,
      serverTimestamp: 1_735_689_600_123,
    });
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
