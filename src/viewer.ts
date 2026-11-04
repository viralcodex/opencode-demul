import type { Device } from "./rpc.js";

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
  if (
    !token ||
    token !== renderedToken ||
    state !== "playing" ||
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  )
    return;
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

export interface FramePacket {
  readonly bytes: Uint8Array;
  readonly key: boolean;
  readonly codec?: string;
  readonly timestamp: number;
  readonly serverTimestamp?: number;
}

export interface MjpegFrames {
  readonly frames: ReadonlyArray<Uint8Array<ArrayBuffer>>;
  readonly rest: Uint8Array<ArrayBuffer>;
}

const MAGIC = 0x53454d55;
const FRAME_HEADERS: Readonly<Record<number, number | undefined>> = { 1: 16, 2: 24 };
const MAX_JPEG_BUFFER = 16 * 1024 * 1024;

export function createViewer(options: ViewerOptions) {
  let active = false;
  let stop: (() => void) | undefined;

  const start = () => {
    try {
      return options.stream.protocol === "h264" ? playH264(options) : playMjpeg(options);
    } catch (error) {
      options.onState("paused");
      options.onError(error instanceof Error ? error.message : String(error));
      return () => {};
    }
  };
  const update = () => {
    const shouldPlay = active && document.visibilityState === "visible";
    if (shouldPlay && !stop) {
      stop = start();
      return;
    }
    if (shouldPlay || !stop) return;
    stop();
    stop = undefined;
    options.onState(active ? "paused" : "idle");
  };
  const visibility = () => update();
  document.addEventListener("visibilitychange", visibility);

  return {
    active(value: boolean) {
      active = value;
      update();
    },
    destroy() {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      stop?.();
      stop = undefined;
      options.canvas.width = 0;
      options.canvas.height = 0;
      options.onState("idle");
    },
  };
}

export function parseFramePacket(input: ArrayBuffer): FramePacket | undefined {
  const data = new Uint8Array(input);
  if (data.byteLength < 4) return;
  const view = new DataView(input);
  if (view.getUint32(0) === MAGIC) return metadataFrame(data, view);
  return videoFrame(data, performance.now() * 1_000, false);
}

function metadataFrame(data: Uint8Array, view: DataView): FramePacket | undefined {
  if (data.byteLength < 16) return;
  const header = FRAME_HEADERS[view.getUint8(4)];
  if (!header || data.byteLength <= header) return;
  const pts = view.getBigUint64(8);
  if (pts > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return videoFrame(
    data.subarray(header),
    Number(pts),
    (view.getUint8(5) & 1) === 1,
    header === 24 ? Number(view.getBigUint64(16)) / 1_000 : undefined,
  );
}

function videoFrame(
  bytes: Uint8Array,
  timestamp: number,
  key: boolean,
  serverTimestamp?: number,
): FramePacket | undefined {
  const start = nalStart(bytes, 0);
  if (start === undefined || start >= bytes.byteLength) return;
  const info = annexBInfo(bytes);
  return {
    bytes,
    key: key || info.key,
    codec: info.codec,
    timestamp,
    serverTimestamp,
  };
}

export function annexBCodec(data: Uint8Array) {
  return annexBInfo(data).codec;
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

export function multipartBoundary(contentType: string | null) {
  if (!contentType || /[\r\n]/.test(contentType)) return;
  const parts = contentType.split(";");
  if (parts.shift()?.trim().toLowerCase() !== "multipart/x-mixed-replace") return;
  const value = parts
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith("boundary="))
    ?.slice("boundary=".length)
    .trim();
  if (!value) return;
  const boundary = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  const normalized = boundary.startsWith("--") ? boundary.slice(2) : boundary;
  if (!normalized) return;
  return normalized;
}

export function parseMjpegFrames(data: Uint8Array<ArrayBuffer>, boundary: string): MjpegFrames {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const separator = new Uint8Array([13, 10, 13, 10]);
  const frames: Uint8Array<ArrayBuffer>[] = [];
  let cursor = 0;
  let consumed = 0;
  while (cursor < data.byteLength) {
    const start = findBytes(data, delimiter, cursor);
    if (start < 0) break;
    const line = start + delimiter.byteLength;
    if (line + 2 > data.byteLength) return { frames, rest: data.slice(start) };
    if (!hasCrlf(data, line)) {
      cursor = line;
      continue;
    }
    const headerEnd = findBytes(data, separator, line + 2);
    if (headerEnd < 0) return { frames, rest: data.slice(start) };
    const headers = new TextDecoder("ascii").decode(data.subarray(line + 2, headerEnd));
    const bytes = jpegLength(headers);
    const frameStart = headerEnd + separator.byteLength;
    if (!bytes) {
      cursor = headerEnd + separator.byteLength;
      continue;
    }
    const frameEnd = frameStart + bytes;
    if (frameEnd > data.byteLength) return { frames, rest: data.slice(start) };
    const frame = data.subarray(frameStart, frameEnd);
    if (isJpeg(frame)) frames.push(frame);
    consumed = frameEnd;
    cursor = frameEnd;
  }
  return { frames, rest: data.slice(consumed) };
}

function hasCrlf(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset] === 13 && bytes[offset + 1] === 10;
}

function jpegLength(headers: string): number | undefined {
  const length = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i)?.[1];
  const contentType = headers
    .match(/(?:^|\r\n)Content-Type:\s*([^\r\n]+)(?:\r\n|$)/i)?.[1]
    .trim()
    .toLowerCase();
  const bytes = length ? Number(length) : 0;
  if (
    Number.isSafeInteger(bytes) &&
    bytes > 0 &&
    bytes <= MAX_JPEG_BUFFER &&
    contentType === "image/jpeg"
  )
    return bytes;
}

function isJpeg(frame: Uint8Array): boolean {
  return (
    frame.byteLength >= 4 &&
    frame[0] === 0xff &&
    frame[1] === 0xd8 &&
    frame.at(-2) === 0xff &&
    frame.at(-1) === 0xd9
  );
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
  let decoder: VideoDecoder | undefined;
  let codec: string | undefined;
  let configuring = 0;
  let waitingKeyframe = true;
  let stopped = false;
  let playing = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const waitForFrame = () => {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(
      () =>
        fail("Android video did not produce a screen within 15 seconds. Refresh devices to retry."),
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
    configuring++;
    const previous = decoder;
    const wasPlaying = playing;
    decoder = undefined;
    codec = undefined;
    waitingKeyframe = true;
    playing = false;
    if (previous && previous.state !== "closed") previous.close();
    if (request && wasPlaying && !stopped) {
      waitForFrame();
      options.onState("connecting");
    }
    if (request) requestKeyframe();
  };
  const fail = (message: string) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(startupTimer);
    socket.close();
    reset();
    options.onError(message.replaceAll(options.stream.token, "[redacted]").slice(0, 512));
    options.onState("paused");
  };
  const decode = (frame: FramePacket, target: VideoDecoder) => {
    if (stopped || decoder !== target || target.state !== "configured") return;
    try {
      target.decode(
        new EncodedVideoChunk({
          type: frame.key ? "key" : "delta",
          timestamp: frame.timestamp,
          data: frame.bytes,
        }),
      );
      waitingKeyframe = false;
    } catch (error) {
      fail(`H.264 decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const configure = (frame: FramePacket, nextCodec: string) => {
    reset();
    codec = nextCodec;
    const generation = configuring;
    const config: VideoDecoderConfig = {
      codec: nextCodec,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    };
    void VideoDecoder.isConfigSupported(config)
      .then((support) => {
        if (stopped || generation !== configuring) return;
        if (!support.supported) {
          fail(`H.264 codec ${nextCodec} is not supported by this browser`);
          return;
        }
        const target: VideoDecoder = new VideoDecoder({
          output(output) {
            if (stopped || decoder !== target) {
              output.close();
              return;
            }
            try {
              draw(options, output, output.displayWidth, output.displayHeight);
              if (!playing) {
                playing = true;
                clearTimeout(startupTimer);
                options.onState("playing");
              }
            } catch (error) {
              fail(
                `Device video draw failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              output.close();
            }
          },
          error(error) {
            if (stopped || decoder !== target) return;
            fail(`H.264 decoder failed: ${error.message}`);
          },
        });
        try {
          target.configure(support.config ?? config);
        } catch (error) {
          target.close();
          fail(
            `H.264 decoder configuration failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        decoder = target;
        decode(frame, target);
      })
      .catch((error) => {
        if (stopped || generation !== configuring) return;
        fail(
          `H.264 decoder setup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const receive = (frame: FramePacket) => {
    if (decoder && decoder.decodeQueueSize > 2) return reset(true);
    if (waitingKeyframe && !frame.key) return;
    const nextCodec = frame.codec ?? codec;
    if (!nextCodec) return requestKeyframe();
    if (decoder && nextCodec === codec) return decode(frame, decoder);
    configure(frame, nextCodec);
  };
  waitForFrame();
  socket.addEventListener("open", requestKeyframe);
  socket.addEventListener("message", (event) => {
    if (stopped) return;
    if (typeof event.data === "string") {
      const message = videoMessage(event.data);
      if (message?.type === "error") fail(`Android video failed: ${message.message}`);
      if (message?.type === "reset") reset(true);
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

  return () => {
    stopped = true;
    clearTimeout(startupTimer);
    socket.close();
    reset();
  };
}

function playMjpeg(options: ViewerOptions) {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  let playing = false;
  const render = async (bytes: Uint8Array<ArrayBuffer>) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    try {
      if (stopped) return;
      draw(options, bitmap, bitmap.width, bitmap.height);
      if (!playing) {
        playing = true;
        options.onState("playing");
      }
    } finally {
      bitmap.close();
    }
  };
  options.onState("connecting");
  void fetch(new URL("/video", new URL(options.stream.baseUrl).origin), {
    method: "GET",
    headers: { Authorization: `Bearer ${options.stream.token}` },
    signal: abort.signal,
  })
    .then(async (response) => {
      if (!response.ok || !response.body)
        throw new Error(`Device video returned ${response.status}`);
      const boundary = multipartBoundary(response.headers.get("content-type"));
      if (!boundary) throw new Error("Device video returned an invalid MJPEG content type");
      reader = response.body.getReader();
      let pending = new Uint8Array();
      while (!stopped) {
        const next = await reader.read();
        if (next.done) break;
        pending = append(pending, next.value);
        const frames = parseMjpegFrames(pending, boundary);
        pending = frames.rest;
        const bytes = frames.frames.at(-1);
        if (bytes) await render(bytes);
        if (pending.byteLength > MAX_JPEG_BUFFER)
          throw new Error("Device MJPEG stream exceeded 16 MiB without a complete frame");
      }
      if (!stopped) throw new Error("Device video stream ended. Refresh devices to retry.");
    })
    .catch((error) => {
      if (!stopped) {
        options.onState("paused");
        options.onError(error instanceof Error ? error.message : String(error));
      }
    })
    .finally(async () => {
      abort.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      reader = undefined;
    });

  return () => {
    stopped = true;
    abort.abort();
    void reader?.cancel().catch(() => {});
  };
}

function draw(options: ViewerOptions, source: CanvasImageSource, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
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

// Inspect once per packet. An SPS supplies both the codec and keyframe marker, so most keyframes stop at their header.
function annexBInfo(data: Uint8Array): { key: boolean; codec?: string } {
  let key = false;
  for (let index = 0; index < data.byteLength - 2; index++) {
    const start = nalStart(data, index);
    if (start === undefined) continue;
    const type = data[start] & 0x1f;
    if (type === 7) return { key: true, codec: spsCodec(data.subarray(start, start + 4)) };
    if (type === 5) key = true;
    index = start;
  }
  return { key };
}

function nalStart(data: Uint8Array, index: number): number | undefined {
  if (data[index] !== 0 || data[index + 1] !== 0) return;
  if (data[index + 2] === 1) return index + 3;
  if (data[index + 2] === 0 && data[index + 3] === 1) return index + 4;
}

function spsCodec(sps: Uint8Array): string | undefined {
  if (sps.byteLength < 4) return;
  return `avc1.${[sps[1], sps[2], sps[3]].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function append(left: Uint8Array, right: Uint8Array) {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

function findBytes(data: Uint8Array, needle: Uint8Array, offset: number) {
  for (let index = offset; index <= data.byteLength - needle.byteLength; index++) {
    let matches = true;
    for (let cursor = 0; cursor < needle.byteLength; cursor++) {
      if (data[index + cursor] === needle[cursor]) continue;
      matches = false;
      break;
    }
    if (matches) return index;
  }
  return -1;
}
