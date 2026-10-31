import type { Device } from "./rpc.js";

export type ViewerState = "idle" | "connecting" | "playing" | "paused";

export interface ViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly stream: Device.StreamDescriptor;
  readonly onState: (state: ViewerState) => void;
  readonly onError: (message: string) => void;
}

export interface FramePacket {
  readonly bytes: Uint8Array;
  readonly key: boolean;
  readonly timestamp: number;
  readonly serverTimestamp?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface MjpegFrames {
  readonly frames: ReadonlyArray<Uint8Array>;
  readonly rest: Uint8Array;
}

const MAGIC = 0x53454d55;
const MAX_JPEG_BUFFER = 16 * 1024 * 1024;

export function createViewer(options: ViewerOptions) {
  let active = false;
  let stop: (() => void) | undefined;

  const update = () => {
    const shouldPlay = active && document.visibilityState === "visible";
    if (shouldPlay && !stop) {
      stop = options.stream.protocol === "h264" ? playH264(options) : playMjpeg(options);
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
      options.onState("idle");
    },
  };
}

export function parseFramePacket(input: ArrayBuffer): FramePacket | undefined {
  const data = new Uint8Array(input);
  const view = new DataView(input);
  if (data.byteLength < 4) return;
  if (view.getUint32(0) !== MAGIC) {
    if (!hasAnnexBStart(data)) return;
    return {
      bytes: data,
      key: hasNal(data, 5) || hasNal(data, 7),
      timestamp: performance.now() * 1_000,
    };
  }

  if (data.byteLength < 16) return;
  const version = view.getUint8(4);
  const header = version === 1 ? 16 : version === 2 ? 24 : 0;
  if (!header || data.byteLength <= header) return;
  const pts = view.getBigUint64(8);
  if (pts > BigInt(Number.MAX_SAFE_INTEGER)) return;
  const bytes = data.subarray(header);
  if (!hasAnnexBStart(bytes)) return;
  return {
    bytes,
    key: (view.getUint8(5) & 1) === 1 || hasNal(bytes, 5) || hasNal(bytes, 7),
    timestamp: Number(pts),
    serverTimestamp: version === 2 ? Number(view.getBigUint64(16)) / 1_000 : undefined,
  };
}

export function annexBCodec(data: Uint8Array) {
  const sps = annexBNals(data).find((nal) => (nal[0] & 0x1f) === 7);
  if (!sps || sps.byteLength < 4) return;
  return `avc1.${[sps[1], sps[2], sps[3]].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height)
  )
    return;
  if (size.width <= 0 || size.height <= 0) return;
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
  if (!normalized || /[\r\n]/.test(normalized)) return;
  return normalized;
}

export function parseMjpegFrames(data: Uint8Array, boundary: string): MjpegFrames {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const separator = new Uint8Array([13, 10, 13, 10]);
  const frames: Uint8Array[] = [];
  let cursor = 0;
  let consumed = 0;
  while (cursor < data.byteLength) {
    const start = findBytes(data, delimiter, cursor);
    if (start < 0) break;
    const line = start + delimiter.byteLength;
    if (line + 2 > data.byteLength) return { frames, rest: data.slice(start) };
    if (data[line] !== 13 || data[line + 1] !== 10) {
      cursor = line;
      continue;
    }
    const headerEnd = findBytes(data, separator, line + 2);
    if (headerEnd < 0) return { frames, rest: data.slice(start) };
    const headers = new TextDecoder("ascii").decode(data.subarray(line + 2, headerEnd));
    const length = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i)?.[1];
    const contentType = headers
      .match(/(?:^|\r\n)Content-Type:\s*([^\r\n]+)(?:\r\n|$)/i)?.[1]
      .trim()
      .toLowerCase();
    const bytes = length ? Number(length) : 0;
    const frameStart = headerEnd + separator.byteLength;
    const frameEnd = frameStart + bytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > MAX_JPEG_BUFFER ||
      contentType !== "image/jpeg"
    ) {
      cursor = headerEnd + separator.byteLength;
      continue;
    }
    if (frameEnd > data.byteLength) return { frames, rest: data.slice(start) };
    const frame = data.slice(frameStart, frameEnd);
    if (
      frame.byteLength >= 4 &&
      frame[0] === 0xff &&
      frame[1] === 0xd8 &&
      frame.at(-2) === 0xff &&
      frame.at(-1) === 0xd9
    )
      frames.push(frame);
    consumed = frameEnd;
    cursor = frameEnd;
  }
  return { frames, rest: data.slice(consumed) };
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
  socket.binaryType = "arraybuffer";
  options.onState("connecting");

  const requestKeyframe = () => {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "reset-video", ack: false }));
    } catch {
      return;
    }
  };
  const reset = (request = false) => {
    configuring++;
    const previous = decoder;
    const wasPlaying = playing;
    decoder = undefined;
    codec = undefined;
    waitingKeyframe = true;
    playing = false;
    if (previous && previous.state !== "closed") {
      try {
        previous.reset();
      } finally {
        previous.close();
      }
    }
    if (request && wasPlaying && !stopped) options.onState("connecting");
    if (request) requestKeyframe();
  };
  const fail = (message: string) => {
    if (stopped) return;
    options.onError(message);
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
      reset(true);
      fail(`H.264 decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  socket.addEventListener("open", () => requestKeyframe());
  socket.addEventListener("message", (event) => {
    if (stopped) return;
    if (typeof event.data === "string") {
      const size = videoSessionSize(event.data);
      if (size) {
        reset(true);
      }
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = parseFramePacket(event.data);
    if (!frame) return;
    if (decoder && decoder.decodeQueueSize > 2) {
      reset(true);
      return;
    }
    if (waitingKeyframe && !frame.key) return;

    const nextCodec = annexBCodec(frame.bytes) ?? codec;
    if (decoder && nextCodec === codec) {
      decode(frame, decoder);
      return;
    }
    if (!nextCodec) {
      requestKeyframe();
      return;
    }
    reset();
    codec = nextCodec;
    const generation = configuring;
    const config: VideoDecoderConfig = {
      codec: nextCodec,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    };
    void VideoDecoder.isConfigSupported(config).then(
      (support) => {
        if (stopped || generation !== configuring) return;
        if (!support.supported) {
          fail(`H.264 codec ${nextCodec} is not supported by this browser`);
          return;
        }
        let target: VideoDecoder;
        target = new VideoDecoder({
          output(output) {
            if (stopped || decoder !== target) {
              output.close();
              return;
            }
            try {
              if (draw(options, output, output.displayWidth, output.displayHeight) && !playing) {
                playing = true;
                options.onState("playing");
              }
            } catch (error) {
              reset(true);
              fail(
                `Device video draw failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            } finally {
              output.close();
            }
          },
          error(error) {
            if (stopped || decoder !== target) return;
            reset(true);
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
        if (stopped || generation !== configuring) {
          target.close();
          return;
        }
        decoder = target;
        decode(frame, target);
      },
      (error) =>
        fail(
          `H.264 decoder support check failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  });
  socket.addEventListener("error", () => fail("Device video connection failed"));
  socket.addEventListener("close", () => {
    reset();
    if (!stopped) options.onState("paused");
  });

  return () => {
    stopped = true;
    socket.close();
    reset();
  };
}

function playMjpeg(options: ViewerOptions) {
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bitmap: ImageBitmap | undefined;
  let stopped = false;
  let playing = false;
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
      let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
      while (!stopped) {
        const next = await reader.read();
        if (next.done) break;
        pending = append(pending, next.value);
        const frames = parseMjpegFrames(pending, boundary);
        pending = frames.rest;
        for (const bytes of frames.frames) {
          const nextBitmap = await createImageBitmap(
            new Blob([new Uint8Array(bytes).buffer], { type: "image/jpeg" }),
          );
          bitmap = nextBitmap;
          try {
            if (stopped) continue;
            if (draw(options, nextBitmap, nextBitmap.width, nextBitmap.height) && !playing) {
              playing = true;
              options.onState("playing");
            }
          } finally {
            nextBitmap.close();
            if (bitmap === nextBitmap) bitmap = undefined;
          }
        }
        if (pending.byteLength > MAX_JPEG_BUFFER)
          throw new Error("Device MJPEG stream exceeded 16 MiB without a complete frame");
      }
      if (!stopped) options.onState("paused");
    })
    .catch((error) => {
      if (!stopped) {
        options.onState("paused");
        options.onError(error instanceof Error ? error.message : String(error));
      }
    })
    .finally(() => {
      reader?.releaseLock();
      reader = undefined;
    });

  return () => {
    stopped = true;
    abort.abort();
    void reader?.cancel().catch(() => {});
    bitmap?.close();
    bitmap = undefined;
  };
}

function draw(options: ViewerOptions, source: CanvasImageSource, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return false;
  if (options.canvas.width !== width || options.canvas.height !== height) {
    options.canvas.width = width;
    options.canvas.height = height;
  }
  const context = options.canvas.getContext("2d", { alpha: false });
  if (!context) return false;
  context.drawImage(source, 0, 0, width, height);
  return true;
}

function videoSessionSize(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("type" in parsed) ||
      parsed.type !== "video-session"
    )
      return;
    if (!("size" in parsed) || !parsed.size || typeof parsed.size !== "object") return;
    if (!("width" in parsed.size) || !("height" in parsed.size)) return;
    if (typeof parsed.size.width !== "number" || typeof parsed.size.height !== "number") return;
    if (!Number.isSafeInteger(parsed.size.width) || !Number.isSafeInteger(parsed.size.height))
      return;
    if (parsed.size.width <= 0 || parsed.size.height <= 0) return;
    return { width: parsed.size.width, height: parsed.size.height };
  } catch {
    return;
  }
}

function annexBNals(data: Uint8Array) {
  const starts: Array<{ readonly code: number; readonly nal: number }> = [];
  for (let index = 0; index < data.byteLength - 2; index++) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    if (data[index + 2] === 1) {
      starts.push({ code: index, nal: index + 3 });
      index += 2;
      continue;
    }
    if (index + 3 < data.byteLength && data[index + 2] === 0 && data[index + 3] === 1) {
      starts.push({ code: index, nal: index + 4 });
      index += 3;
    }
  }
  return starts.map((start, index) =>
    data.subarray(start.nal, starts[index + 1]?.code ?? data.byteLength),
  );
}

function hasAnnexBStart(data: Uint8Array) {
  if (data.byteLength >= 4 && data[0] === 0 && data[1] === 0 && data[2] === 1) return true;
  return data.byteLength >= 5 && data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1;
}

function hasNal(data: Uint8Array, type: number) {
  return annexBNals(data).some((nal) => (nal[0] & 0x1f) === type);
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
