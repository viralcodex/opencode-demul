import { afterEach, describe, expect, jest, test } from "bun:test";
import { contentPoint, createViewer, sameScreenFrame, screenFrame } from "./viewer.js";
import { sps, pps, idr, delta, keyframe as annexB } from "../test/video.js";

const teardown: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of teardown.splice(0).reverse()) cleanup();
});

async function settleDecoder(): Promise<void> {
  for (let step = 0; step < 4; step++) await Promise.resolve();
}

function h264Fixture(platform: "android" | "ios" = "android") {
  jest.useFakeTimers();
  const listeners = new Set<EventListener>();
  const checks: Array<ReturnType<typeof Promise.withResolvers<VideoDecoderSupport>>> = [];
  const chunks: EncodedVideoChunkInit[] = [];
  const decoders: Decoder[] = [];
  const sockets: Socket[] = [];
  const sent: string[] = [];
  let outputEnabled = true;
  let framesClosed = 0;
  class Socket extends EventTarget {
    static instance: Socket;
    static OPEN = 1;
    readyState = 1;
    closed = false;
    binaryType = "";
    constructor(
      readonly url: URL,
      readonly protocol: string,
    ) {
      super();
      Socket.instance = this;
      sockets.push(this);
    }
    send(message: string) {
      sent.push(message);
    }
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
    constructor(private readonly callbacks: VideoDecoderInit) {
      decoders.push(this);
    }
    configure() {
      this.state = "configured";
    }
    decode() {
      if (outputEnabled) this.output();
    }
    output() {
      this.callbacks.output({
        displayWidth: 100,
        displayHeight: 200,
        close() {
          framesClosed++;
        },
      } as VideoFrame);
    }
    error() {
      this.callbacks.error(new DOMException("obsolete decoder failure"));
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
    EncodedVideoChunk: class {
      constructor(input: EncodedVideoChunkInit) {
        chunks.push(input);
      }
    },
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
      platform,
      deviceId: "phone",
      baseUrl: "http://127.0.0.1:3400",
      token: "private-token",
      protocol: "h264",
      loopback: true,
    },
    onState: (state) => states.push(state),
    onError: (message) => errors.push(message),
  });
  teardown.push(() => {
    viewer.destroy();
    jest.useRealTimers();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  viewer.active(true);
  return {
    viewer,
    states,
    errors,
    canvas,
    listeners,
    checks,
    chunks,
    decoders,
    sent,
    stall(value: boolean) {
      outputEnabled = !value;
    },
    framesClosed: () => framesClosed,
    socket: Socket.instance,
    sockets,
    visibility(state: "visible" | "hidden") {
      globals.document.visibilityState = state;
      for (const listener of listeners) listener(new Event("visibilitychange"));
    },
  };
}

test.each(["android", "ios"] as const)(
  "%s uses the same authenticated H.264 viewer",
  (platform) => {
    const item = h264Fixture(platform);
    expect(item.socket.url.toString()).toBe("ws://127.0.0.1:3400/video?frame-meta=1");
    expect(item.socket.protocol).toBe("opencode-device.private-token");
  },
);

describe("H.264 viewer", () => {
  test.each([
    {
      name: "separate configuration",
      packets: [sps, pps, delta],
      expected: new Uint8Array([...sps, 0, ...pps, ...idr]),
    },
    { name: "SPS plus delta", packets: [new Uint8Array([...sps, ...delta])], expected: annexB },
  ])(
    "$name waits for an IDR and includes cached parameters in its decoder data",
    async ({ packets, expected }) => {
      const item = h264Fixture();
      for (const data of packets) item.socket.emit("message", { data: data.slice().buffer });
      expect(item.checks).toHaveLength(0);
      expect(item.chunks).toHaveLength(0);
      item.socket.emit("message", { data: idr.slice().buffer });
      item.checks[0]!.resolve({ supported: true });
      await settleDecoder();
      expect(item.chunks).toHaveLength(1);
      expect(item.chunks[0]).toMatchObject({ type: "key", data: expected });
      expect(item.states.at(-1)).toBe("playing");
    },
  );

  test("dropped packets during asynchronous setup request a new IDR instead of decoding dependent deltas", async () => {
    const item = h264Fixture();
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.socket.emit("message", { data: delta.slice().buffer });
    item.socket.emit("message", { data: annexB.slice().buffer });
    expect(item.checks).toHaveLength(1);
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    expect(item.sent).toHaveLength(1);
    expect(JSON.parse(item.sent[0]!)).toEqual({ type: "reset-video", ack: false });
    item.socket.emit("message", { data: delta.slice().buffer });
    expect(item.chunks).toHaveLength(1);
    item.socket.emit("message", { data: idr.slice().buffer });
    expect(item.chunks).toHaveLength(2);
    expect(item.checks).toHaveLength(1);
  });

  test("decoder backlog resets playback and rejects deltas until an IDR arrives", async () => {
    const item = h264Fixture();
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    const previous = item.decoders[0]!;
    previous.decodeQueueSize = 3;
    item.socket.emit("message", { data: delta.slice().buffer });
    expect(previous.state).toBe("closed");
    expect(item.states.at(-1)).toBe("connecting");
    const closed = item.framesClosed();
    previous.output();
    previous.error();
    expect(item.errors).toEqual([]);
    expect(item.framesClosed()).toBe(closed + 1);
    expect(item.states.at(-1)).toBe("connecting");
    item.socket.emit("message", { data: delta.slice().buffer });
    expect(item.chunks).toHaveLength(1);
    item.socket.emit("message", { data: idr.slice().buffer });
    item.checks[1]!.resolve({ supported: true });
    await settleDecoder();
    expect(item.states.at(-1)).toBe("playing");
    expect(item.chunks.at(-1)!.type).toBe("key");
  });

  test("a running decoder stall requests recovery and then reports a bounded failure", async () => {
    const item = h264Fixture();
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    item.stall(true);
    item.socket.emit("message", { data: delta.slice().buffer });
    jest.advanceTimersByTime(14_999);
    item.socket.emit("message", { data: delta.slice().buffer });
    jest.advanceTimersByTime(1);
    expect(item.states.at(-1)).toBe("connecting");
    expect(item.sent).toHaveLength(1);
    expect(item.decoders[0]!.state).toBe("closed");
    jest.advanceTimersByTime(15_000);
    expect(item.states.at(-1)).toBe("paused");
    expect(item.errors).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a static screen with no submitted video does not trigger a stall timeout", async () => {
    const item = h264Fixture();
    item.socket.emit("message", { data: annexB.slice().buffer });
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    jest.advanceTimersByTime(60_000);
    expect(item.states.at(-1)).toBe("playing");
    expect(item.errors).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("unexpected video closure is visible instead of a silently blank panel", () => {
    const item = h264Fixture();
    item.socket.emit("close", { code: 1006 });
    expect(item.states).toEqual(["connecting", "paused"]);
    expect(item.errors[0]).toContain("connection closed (code 1006)");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("video startup has a deadline and stops failed connections", () => {
    const item = h264Fixture();
    jest.advanceTimersByTime(15_000);
    expect(item.errors[0]).toContain("within 15 seconds");
    expect(item.socket.closed).toBe(true);
    expect(item.states.at(-1)).toBe("paused");
    expect(jest.getTimerCount()).toBe(0);
  });

  test("backend errors are shown once and redact the stream token", () => {
    const item = h264Fixture();
    item.socket.emit("message", {
      data: JSON.stringify({ ok: false, error: "capture failed private-token" }),
    });
    item.socket.emit("close", { code: 1006 });
    expect(item.errors).toEqual(["Device video failed: capture failed [redacted]"]);
    expect(item.socket.closed).toBe(true);
  });

  test.each([
    { trigger: "session", phase: "configuring" },
    { trigger: "session", phase: "playing" },
    { trigger: "codec", phase: "configuring" },
    { trigger: "codec", phase: "playing" },
  ])(
    "$trigger replacement during $phase invalidates the previous decoder generation",
    async ({ trigger, phase }) => {
      const item = h264Fixture();
      item.socket.emit("message", { data: annexB.buffer });
      if (phase === "playing") {
        item.checks[0]!.resolve({ supported: true });
        await settleDecoder();
      }
      if (trigger === "session") {
        item.socket.emit("message", {
          data: JSON.stringify({ type: "video-session", size: { width: 100, height: 200 } }),
        });
        item.socket.emit("message", { data: annexB.buffer });
      } else {
        item.socket.emit("message", {
          data: new Uint8Array([...sps.slice(0, 5), 0x4d, 0, 0x1f, ...idr]).buffer,
        });
      }
      expect(item.checks).toHaveLength(2);
      expect(jest.getTimerCount()).toBe(1);
      if (phase === "playing") {
        expect(item.decoders[0]!.state).toBe("closed");
        item.decoders[0]!.error();
      } else if (trigger === "session") item.checks[0]!.reject(new Error("obsolete codec check"));
      else item.checks[0]!.resolve({ supported: true });
      item.checks[1]!.resolve({ supported: true });
      await settleDecoder();
      expect(item.decoders).toHaveLength(phase === "playing" ? 2 : 1);
      expect(item.states).toEqual(
        phase === "playing"
          ? ["connecting", "playing", "connecting", "playing"]
          : ["connecting", "playing"],
      );
      expect(item.canvas).toMatchObject({ width: 100, height: 200 });
      expect(jest.getTimerCount()).toBe(0);
      expect(item.errors).toEqual([]);
    },
  );

  test.each(["unsupported", "rejected"])(
    "a %s codec check stops startup and reports one error",
    async (failure) => {
      const item = h264Fixture();
      item.socket.emit("message", { data: annexB.buffer });
      if (failure === "unsupported") item.checks[0]!.resolve({ supported: false });
      else item.checks[0]!.reject(new Error("codec check failed"));
      await settleDecoder();
      expect(item.errors).toHaveLength(1);
      expect(item.states.at(-1)).toBe("paused");
      expect(item.socket.closed).toBe(true);
      expect(item.decoders).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test("hiding the page releases capture and ignores a pending codec check", async () => {
    const item = h264Fixture();
    item.socket.emit("message", { data: annexB.buffer });
    item.visibility("hidden");
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    expect(item.socket.closed).toBe(true);
    expect(item.states.at(-1)).toBe("paused");
    expect(item.decoders).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    item.visibility("visible");
    expect(item.states.at(-1)).toBe("connecting");
  });

  test("a failed canvas draw closes the output frame and decoder", async () => {
    const item = h264Fixture();
    item.canvas.getContext = () => null;
    item.socket.emit("message", { data: annexB.buffer });
    item.checks[0]!.resolve({ supported: true });
    await settleDecoder();
    expect(item.framesClosed()).toBe(1);
    expect(item.decoders[0]!.state).toBe("closed");
    expect(item.errors[0]).toContain("canvas is unavailable");
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(["configuring", "playing"])(
    "destroying a %s viewer is terminal and releases its resources",
    async (phase) => {
      const item = h264Fixture();
      item.socket.emit("message", { data: annexB.buffer });
      if (phase === "playing") {
        item.checks[0]!.resolve({ supported: true });
        await settleDecoder();
      }
      item.viewer.destroy();
      item.viewer.active(true);
      item.visibility("visible");
      if (phase === "configuring") item.checks[0]!.resolve({ supported: true });
      await settleDecoder();
      expect(item.sockets).toHaveLength(1);
      expect(item.decoders).toHaveLength(phase === "playing" ? 1 : 0);
      if (phase === "playing") expect(item.decoders[0]!.state).toBe("closed");
      expect(item.states.at(-1)).toBe("idle");
      expect(item.listeners.size).toBe(0);
      expect(item.canvas).toMatchObject({ width: 0, height: 0 });
      item.socket.emit("close", { code: 1006 });
      expect(item.errors).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
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
