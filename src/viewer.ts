import type { Device } from "./rpc.js";
import { H264Configuration, parseFramePacket, type FramePacket } from "./h264.js";
import { createH264Decoder } from "./viewer-decoder.js";

export type ViewerState = "idle" | "connecting" | "playing" | "paused";

export interface ScreenFrame {
  readonly token: string;
  readonly width: number;
  readonly height: number;
}

export function screenFrame(
  token: string | undefined,
  renderedToken: string | undefined,
  state: ViewerState,
  size: { width: number; height: number },
): ScreenFrame | undefined {
  if (!token || token !== renderedToken || state !== "playing" || !validVideoSize(size)) return;
  return { token, width: size.width, height: size.height };
}

export function sameScreenFrame(start: ScreenFrame, current: ScreenFrame | undefined): boolean {
  return (
    !!current &&
    start.token === current.token &&
    start.width === current.width &&
    start.height === current.height
  );
}

export interface ViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly stream: Device.StreamDescriptor;
  readonly onState: (state: ViewerState) => void;
  readonly onError: (message: string) => void;
}

type Playback = { type: "idle" | "destroyed" } | { type: "running"; stop(): void };
interface DecoderSetup {
  type: "configuring";
  codec: string;
  missed: boolean;
}
type H264State =
  | { type: "waiting" | "stopped" }
  | DecoderSetup
  | {
      type: "decoding" | "playing";
      setup: DecoderSetup;
      decoder: VideoDecoder;
      waitingKeyframe: boolean;
    };

export function createViewer(options: ViewerOptions) {
  let active = false;
  let playback: Playback = { type: "idle" };

  const start = () => {
    try {
      return playH264(options);
    } catch (error) {
      options.onState("paused");
      options.onError(error instanceof Error ? error.message : String(error));
      return () => {};
    }
  };
  const update = () => {
    if (playback.type === "destroyed") return;
    const shouldPlay = active && document.visibilityState === "visible";
    if (shouldPlay && playback.type === "idle") {
      playback = { type: "running", stop: start() };
      return;
    }
    if (shouldPlay || playback.type !== "running") return;
    playback.stop();
    playback = { type: "idle" };
    options.onState(active ? "paused" : "idle");
  };
  document.addEventListener("visibilitychange", update);

  return {
    active(value: boolean) {
      if (playback.type === "destroyed") return;
      active = value;
      update();
    },
    destroy() {
      if (playback.type === "destroyed") return;
      const previous = playback;
      playback = { type: "destroyed" };
      document.removeEventListener("visibilitychange", update);
      if (previous.type === "running") previous.stop();
      options.canvas.width = 0;
      options.canvas.height = 0;
      options.onState("idle");
    },
  };
}

export function contentPoint(
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  size: { readonly width: number; readonly height: number },
  client: { readonly x: number; readonly y: number },
): Device.LogicalPoint | undefined {
  if (
    ![
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
      size.width,
      size.height,
      client.x,
      client.y,
    ].every(Number.isFinite)
  )
    return;
  if (bounds.width <= 0 || bounds.height <= 0 || !validVideoSize(size)) return;
  const scale = Math.min(bounds.width / size.width, bounds.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  const x = client.x - bounds.left - (bounds.width - width) / 2;
  const y = client.y - bounds.top - (bounds.height - height) / 2;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  return {
    x: Math.min(size.width - 1, Math.floor(x / scale)),
    y: Math.min(size.height - 1, Math.floor(y / scale)),
  };
}

function playH264(options: ViewerOptions) {
  if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
    options.onState("paused");
    options.onError("H.264 device video requires WebCodecs support in this browser");
    return () => {};
  }
  const url = new URL("/video?frame-meta=1", new URL(options.stream.baseUrl).origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, `opencode-device.${options.stream.token}`);
  let state: H264State = { type: "waiting" };
  const configuration = new H264Configuration();
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let decodeTimer: ReturnType<typeof setTimeout> | undefined;
  const waitForFrame = () => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(
      () =>
        fail("Device video did not produce a screen within 15 seconds. Refresh devices to retry."),
      15_000,
    );
  };
  socket.binaryType = "arraybuffer";
  options.onState("connecting");

  const requestKeyframe = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    } catch {}
  };
  const reset = (request = false) => {
    clearTimeout(decodeTimer);
    decodeTimer = undefined;
    const previous = state;
    state = { type: "waiting" };
    if ("decoder" in previous && previous.decoder.state !== "closed") previous.decoder.close();
    if (request && previous.type === "playing") {
      waitForFrame();
      options.onState("connecting");
    }
    if (request) requestKeyframe();
  };
  const stop = () => {
    if (state.type === "stopped") return;
    reset();
    state = { type: "stopped" };
    clearTimeout(startupTimer);
    socket.close();
  };
  const fail = (message: string) => {
    if (state.type === "stopped") return;
    stop();
    options.onError(message.replaceAll(options.stream.token, "[redacted]").slice(0, 512));
    options.onState("paused");
  };
  const decode = (frame: FramePacket, target: VideoDecoder) => {
    if (!("decoder" in state) || state.decoder !== target || target.state !== "configured") return;
    state.waitingKeyframe = false;
    try {
      decodeTimer ??= setTimeout(() => {
        decodeTimer = undefined;
        reset(true);
      }, 15_000);
      target.decode(
        new EncodedVideoChunk({
          type: frame.key ? "key" : "delta",
          timestamp: frame.timestamp,
          data: configuration.bytes(frame),
        }),
      );
    } catch (error) {
      fail(`H.264 decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const configure = (frame: FramePacket, nextCodec: string) => {
    reset();
    const setup: DecoderSetup = { type: "configuring", codec: nextCodec, missed: false };
    state = setup;
    const current = () => state === setup || ("decoder" in state && state.setup === setup);
    const config: VideoDecoderConfig = {
      codec: nextCodec,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    };
    void createH264Decoder(config, {
      current,
      output(output) {
        if (!("decoder" in state)) return;
        const previous = state;
        clearTimeout(decodeTimer);
        decodeTimer = undefined;
        draw(options, output, output.displayWidth, output.displayHeight);
        if (state !== previous || previous.type === "playing") return;
        state = { ...previous, type: "playing" };
        clearTimeout(startupTimer);
        options.onState("playing");
      },
      error: fail,
    })
      .then((target) => {
        if (!target) return;
        if (state !== setup) {
          target.close();
          return;
        }
        state = { type: "decoding", setup, decoder: target, waitingKeyframe: true };
        decode(frame, target);
        if (current() && "decoder" in state && setup.missed) {
          state.waitingKeyframe = true;
          requestKeyframe();
        }
      })
      .catch((error) => {
        if (!current()) return;
        fail(
          `H.264 decoder setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const decoderCodec = () =>
    state.type === "configuring" ? state.codec : "decoder" in state ? state.setup.codec : undefined;
  const updateConfiguration = (frame: FramePacket) => {
    configuration.update(frame);
    const codec = decoderCodec();
    if (codec && configuration.codec !== codec) reset(true);
  };
  const decodeOrConfigure = (frame: FramePacket) => {
    const nextCodec = configuration.codec ?? decoderCodec();
    if (!nextCodec) return requestKeyframe();
    if ("decoder" in state) return decode(frame, state.decoder);
    if (!frame.key) return reset(true);
    configure(frame, nextCodec);
  };
  const receive = (frame: FramePacket) => {
    updateConfiguration(frame);
    if (!frame.picture) return;
    if (state.type === "configuring") {
      state.missed = true;
      return;
    }
    if ("decoder" in state && state.decoder.decodeQueueSize > 2) return reset(true);
    if (!frame.key && (!("decoder" in state) || state.waitingKeyframe)) return;
    decodeOrConfigure(frame);
  };
  waitForFrame();
  socket.addEventListener("open", requestKeyframe);
  socket.addEventListener("message", (event) => {
    if (state.type === "stopped") return;
    if (typeof event.data === "string") {
      const message = videoMessage(event.data);
      if (message?.type === "error") fail(`Device video failed: ${message.message}`);
      if (message?.type === "reset") {
        configuration.clear();
        reset(true);
      }
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = parseFramePacket(event.data);
    if (frame) receive(frame);
  });
  socket.addEventListener("error", () => fail("Device video connection failed"));
  socket.addEventListener("close", (event) => {
    fail(`Device video connection closed (code ${event.code}). Refresh devices to retry.`);
  });

  return stop;
}

function draw(options: ViewerOptions, source: CanvasImageSource, width: number, height: number) {
  if (!validVideoSize({ width, height }))
    throw new Error("Device video produced invalid screen dimensions");
  if (options.canvas.width !== width || options.canvas.height !== height) {
    options.canvas.width = width;
    options.canvas.height = height;
  }
  const context = options.canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Device video canvas is unavailable");
  context.drawImage(source, 0, 0, width, height);
}

type VideoMessage = { type: "reset" } | { type: "error"; message: string };

function videoMessage(value: string): VideoMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return;
    if ("ok" in parsed && parsed.ok === false)
      return {
        type: "error",
        message:
          "error" in parsed && typeof parsed.error === "string"
            ? parsed.error
            : "the capture session failed",
      };
    if (isVideoSession(parsed)) return { type: "reset" };
  } catch {
    return;
  }
}

function isVideoSession(message: object): boolean {
  return (
    "type" in message &&
    message.type === "video-session" &&
    "size" in message &&
    message.size !== null &&
    typeof message.size === "object" &&
    validVideoSize(message.size)
  );
}

function validVideoSize(size: object): boolean {
  if (!("width" in size) || !("height" in size)) return false;
  return (
    typeof size.width === "number" &&
    typeof size.height === "number" &&
    Number.isSafeInteger(size.width) &&
    Number.isSafeInteger(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}
