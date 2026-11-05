import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Schema } from "effect";
import type { Device } from "./rpc.js";
import { bridgeAvcc, type AvccSource } from "./stream-avcc.js";
import { parseFramePacket } from "./h264.js";
import { VideoFlow } from "./video-flow.js";

// Give the viewer a video-only loopback token, never the hub credential. Both platforms expose Annex-B H.264.

const LOOPBACK_HOST = "127.0.0.1";
const VIDEO_PATH = "/video";
// The only query key the viewer may pass (`frame-meta=1` for the H.264 metadata header).
const ALLOWED_QUERY_KEY = "frame-meta";
const CLIENT_SUBPROTOCOL_PREFIX = "opencode-device.";
// Beyond this outbound buffer the proxy drops video frames rather than grow.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface StreamProxy {
  readonly descriptor: Device.StreamDescriptor;
  stop(): Promise<void>;
}

type UpstreamTarget =
  | { readonly kind: "ws"; readonly url: string; readonly subprotocol: string }
  | ({ readonly kind: "avcc" } & AvccSource);

export function startStreamProxy(raw: Device.StreamDescriptor): Promise<StreamProxy> {
  const token = randomBytes(24).toString("hex");
  const upstream = buildUpstream(raw);
  const sockets = new Set<WebSocket>();
  const tasks = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  const relay = new WebSocketServer({ noServer: true, maxPayload: 4_096 });
  relay.on("connection", (downstream: WebSocket) => {
    if (stopping) return downstream.terminate();
    if (upstream.kind === "ws") return bridgeWebSocket(upstream, downstream, sockets);
    sockets.add(downstream);
    downstream.on("close", () => sockets.delete(downstream));
    downstream.on("error", () => downstream.terminate());
    const bridge = bridgeAvcc(upstream, downstream, MAX_BUFFERED_BYTES);
    downstream.on("message", (data: RawData, isBinary: boolean) => {
      if (isVideoReset(data, isBinary)) bridge.reset();
    });
    const done = bridge.done.catch(() => downstream.terminate());
    tasks.add(done);
    void done.then(() => tasks.delete(done));
  });

  const server = createServer((request, response) => {
    const status = videoRequestStatus(request.method, request.url);
    response.writeHead(status ?? 426).end();
  });

  server.on("upgrade", (request, socket, head) => {
    if (stopping) return destroySocket(socket, 400);
    if (videoRequestStatus(request.method, request.url)) return destroySocket(socket, 400);
    if (!authorizeSubprotocols(request.headers["sec-websocket-protocol"], token))
      return destroySocket(socket, 401);
    relay.handleUpgrade(request, socket, head, (downstream) => {
      relay.emit("connection", downstream, request);
    });
  });

  return new Promise<StreamProxy>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("The stream proxy did not bind a TCP port."));
        return;
      }
      resolve({
        descriptor: {
          platform: raw.platform,
          deviceId: raw.deviceId,
          baseUrl: `http://${LOOPBACK_HOST}:${address.port}`,
          token,
          protocol: raw.protocol,
          loopback: true,
        },
        stop: () => (stopping ??= stop(server, relay, sockets, tasks)),
      });
    });
  });
}

function buildUpstream(raw: Device.StreamDescriptor): UpstreamTarget {
  const origin = new URL(raw.baseUrl).origin;
  if (raw.platform === "android") {
    const url = new URL("/vendor/serve-emu/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("device", raw.deviceId);
    url.searchParams.set("video", "1");
    url.searchParams.set("frame-meta", "1");
    return { kind: "ws", url: url.toString(), subprotocol: `serve-emu.token.${raw.token}` };
  }
  const url = new URL("/vendor/serve-sim/helper/stream.avcc", origin);
  url.searchParams.set("device", raw.deviceId);
  return { kind: "avcc", url: url.toString(), authorization: `Bearer ${raw.token}` };
}

function videoRequestStatus(
  method: string | undefined,
  requestUrl: string | undefined,
): number | undefined {
  if (method !== "GET") return 405;
  const target = requestUrl ?? "/";
  const base = `http://${LOOPBACK_HOST}`;
  if (!URL.canParse(target, base)) return 400;
  const url = new URL(target, base);
  if (url.pathname !== VIDEO_PATH) return 404;
  for (const key of url.searchParams.keys()) if (key !== ALLOWED_QUERY_KEY) return 400;
  return undefined;
}

function authorizeSubprotocols(header: string | string[] | undefined, token: string): boolean {
  const expected = CLIENT_SUBPROTOCOL_PREFIX + token;
  const offered = Array.isArray(header) ? header.join(",") : (header ?? "");
  return offered.split(",").some((protocol) => safeEqual(protocol.trim(), expected));
}

const decodeReset = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ type: Schema.Literal("reset-video") })),
);

function isVideoReset(data: RawData, isBinary: boolean): boolean {
  return !isBinary && decodeReset(text(data))._tag === "Some";
}

// Forward video; a validated reset request becomes a fixed proxy-owned recovery message.
function bridgeWebSocket(
  upstream: Extract<UpstreamTarget, { kind: "ws" }>,
  downstream: WebSocket,
  sockets: Set<WebSocket>,
) {
  const hub = new WebSocket(upstream.url, [upstream.subprotocol], {
    maxPayload: MAX_BUFFERED_BYTES,
  });
  const hubToken = upstream.subprotocol.slice("serve-emu.token.".length);
  let resetRequested = false;
  const requestReset = () => {
    if (hub.readyState === WebSocket.CONNECTING) resetRequested = true;
    if (hub.readyState === WebSocket.OPEN)
      hub.send(JSON.stringify({ type: "reset-video", ack: false }));
  };
  const flow = new VideoFlow(MAX_BUFFERED_BYTES, requestReset);
  sockets.add(downstream);
  sockets.add(hub);
  const closeBoth = () => {
    sockets.delete(downstream);
    sockets.delete(hub);
    if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate();
    if (hub.readyState !== WebSocket.CLOSED) hub.terminate();
  };
  hub.on("message", (data: RawData, isBinary: boolean) => {
    if (downstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      const bytes = buffer(data);
      const frame = parseFramePacket(bytes);
      if (!frame || !flow.accept({ ...frame, bytes }, downstream.bufferedAmount)) return;
    }
    downstream.send(isBinary ? data : text(data).replaceAll(hubToken, "[redacted]"), {
      binary: isBinary,
    });
  });
  hub.on("close", closeBoth);
  hub.on("error", closeBoth);
  hub.on("open", () => {
    if (resetRequested) requestReset();
    resetRequested = false;
  });
  downstream.on("message", (data: RawData, isBinary: boolean) => {
    if (!isVideoReset(data, isBinary)) return;
    flow.reset();
    requestReset();
  });
  downstream.on("close", closeBoth);
  downstream.on("error", closeBoth);
}

function text(data: RawData): string {
  return buffer(data).toString("utf8");
}

function buffer(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}

// Close the listener and every connection and fetch the proxy owns, then resolve once the listener has shut down.
async function stop(
  server: Server,
  relay: WebSocketServer,
  sockets: Set<WebSocket>,
  tasks: Set<Promise<void>>,
) {
  await Promise.all(
    [...sockets].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          socket.terminate();
        }),
    ),
  );
  await Promise.all(tasks);
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function destroySocket(socket: Duplex, status: number) {
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  socket.on("error", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}
