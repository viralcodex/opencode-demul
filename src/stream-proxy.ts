import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Schema } from "effect";
import type { Device } from "./rpc.js";

// A loopback proxy in front of the hub's video stream. The hub token unlocks every hub route, so the viewer gets this
// proxy's own token instead, which reaches only `GET /video` for one device. Client messages are never relayed upstream
// except a validated video reset. Upstream routes are the vendored serve-emu (H.264 WebSocket, token subprotocol) and
// serve-sim (MJPEG GET, Bearer token) endpoints.

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
  | { readonly kind: "mjpeg"; readonly url: string; readonly authorization: string };

export function startStreamProxy(raw: Device.StreamDescriptor): Promise<StreamProxy> {
  const token = randomBytes(24).toString("hex");
  const upstream = buildUpstream(raw);
  const responses = new Set<ServerResponse>();
  const controllers = new Set<AbortController>();
  const sockets = new Set<WebSocket>();
  const relay =
    upstream.kind === "ws" ? new WebSocketServer({ noServer: true, maxPayload: 4_096 }) : undefined;
  if (relay && upstream.kind === "ws") {
    const hub = upstream;
    relay.on("connection", (downstream: WebSocket) => bridgeWebSocket(hub, downstream, sockets));
  }

  const server = createServer((request, response) => {
    if (upstream.kind === "mjpeg" && request.method === "OPTIONS")
      return preflight(response, videoRequestStatus("GET", request.url));
    const status = videoRequestStatus(request.method, request.url);
    if (status) return reject(response, status);
    if (upstream.kind !== "mjpeg") return reject(response, 426);
    // The viewer fetches from the renderer's origin; the Bearer token, not the origin, gates access.
    response.setHeader("access-control-allow-origin", "*");
    if (!authorizeBearer(request.headers.authorization, token)) return unauthorized(response);
    responses.add(response);
    response.on("close", () => responses.delete(response));
    pumpMjpeg(upstream, response, controllers).catch(
      () => response.destroyed || response.destroy(),
    );
  });

  server.on("upgrade", (request, socket, head) => {
    if (!relay || videoRequestStatus(request.method, request.url))
      return destroySocket(socket, 400);
    if (!authorizeSubprotocols(request.headers["sec-websocket-protocol"], token))
      return destroySocket(socket, 401);
    relay.handleUpgrade(request, socket, head, (downstream) => {
      relay.emit("connection", downstream, request);
    });
  });

  return new Promise<StreamProxy>((resolve, reject2) => {
    server.once("error", reject2);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject2);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject2(new Error("The stream proxy did not bind a TCP port."));
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
        stop: () => stop(server, relay, responses, controllers, sockets),
      });
    });
  });
}

function buildUpstream(raw: Device.StreamDescriptor): UpstreamTarget {
  const origin = new URL(raw.baseUrl).origin;
  if (raw.protocol === "h264") {
    const url = new URL("/vendor/serve-emu/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("device", raw.deviceId);
    url.searchParams.set("video", "1");
    url.searchParams.set("frame-meta", "1");
    return { kind: "ws", url: url.toString(), subprotocol: `serve-emu.token.${raw.token}` };
  }
  const url = new URL("/vendor/serve-sim/helper/stream.mjpeg", origin);
  url.searchParams.set("device", raw.deviceId);
  return { kind: "mjpeg", url: url.toString(), authorization: `Bearer ${raw.token}` };
}

function videoRequestStatus(
  method: string | undefined,
  requestUrl: string | undefined,
): number | undefined {
  if (method !== "GET") return 405;
  const url = new URL(requestUrl ?? "/", `http://${LOOPBACK_HOST}`);
  if (url.pathname !== VIDEO_PATH) return 404;
  for (const key of url.searchParams.keys()) if (key !== ALLOWED_QUERY_KEY) return 400;
  return undefined;
}

function authorizeBearer(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/u.exec(header ?? "");
  return match ? safeEqual(match[1], token) : false;
}

function authorizeSubprotocols(header: string | string[] | undefined, token: string): boolean {
  const expected = CLIENT_SUBPROTOCOL_PREFIX + token;
  return subprotocols(header).some((protocol) => safeEqual(protocol, expected));
}

// Pipe the hub's MJPEG body to the viewer with one-chunk backpressure, abortable when the viewer disconnects.
async function pumpMjpeg(
  upstream: Extract<UpstreamTarget, { kind: "mjpeg" }>,
  response: ServerResponse,
  controllers: Set<AbortController>,
) {
  const controller = new AbortController();
  controllers.add(controller);
  response.on("close", () => controller.abort());
  const fetched = await fetch(upstream.url, {
    method: "GET",
    headers: { authorization: upstream.authorization },
    signal: controller.signal,
  });
  if (!fetched.ok || !fetched.body) {
    controllers.delete(controller);
    return reject(response, 502);
  }
  response.writeHead(200, {
    "content-type":
      fetched.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame",
    "cache-control": "no-store",
  });
  const reader = fetched.body.getReader();
  try {
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength && !response.write(chunk.value))
        await once(response, "drain", { signal: controller.signal });
    }
  } finally {
    controllers.delete(controller);
    await reader.cancel().catch(() => {});
    if (!response.destroyed) response.end();
  }
}

const VideoReset = Schema.Struct({ type: Schema.Literal("reset-video") });

// Forward video; a validated reset request becomes a fixed proxy-owned recovery message.
function bridgeWebSocket(
  upstream: Extract<UpstreamTarget, { kind: "ws" }>,
  downstream: WebSocket,
  sockets: Set<WebSocket>,
) {
  const hub = new WebSocket(upstream.url, [upstream.subprotocol]);
  let resetRequested = false;
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
    if (isBinary && downstream.bufferedAmount > MAX_BUFFERED_BYTES) return;
    downstream.send(data, { binary: isBinary });
  });
  hub.on("close", closeBoth);
  hub.on("error", closeBoth);
  hub.on("open", () => {
    if (resetRequested) hub.send(JSON.stringify({ type: "reset-video", ack: false }));
    resetRequested = false;
  });
  downstream.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const text = (
      Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
    ).toString("utf8");
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(VideoReset))(text);
    if (parsed._tag === "None") return;
    if (hub.readyState === WebSocket.CONNECTING) {
      resetRequested = true;
      return;
    }
    if (hub.readyState === WebSocket.OPEN)
      hub.send(JSON.stringify({ type: "reset-video", ack: false }));
  });
  downstream.on("close", closeBoth);
  downstream.on("error", closeBoth);
}

// Close the listener and every connection and fetch the proxy owns, then resolve once the listener has shut down.
async function stop(
  server: Server,
  relay: WebSocketServer | undefined,
  responses: Set<ServerResponse>,
  controllers: Set<AbortController>,
  sockets: Set<WebSocket>,
) {
  for (const controller of controllers) controller.abort();
  for (const response of responses) if (!response.destroyed) response.destroy();
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
  if (relay) await new Promise<void>((resolve) => relay.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function subprotocols(header: string | string[] | undefined): string[] {
  const value = Array.isArray(header) ? header.join(",") : (header ?? "");
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reject(response: ServerResponse, status: number) {
  response.writeHead(status).end();
}

function preflight(response: ServerResponse, status: number | undefined) {
  if (status) return reject(response, status);
  response
    .writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET",
      "access-control-allow-headers": "authorization",
      "access-control-max-age": "600",
    })
    .end();
}

function unauthorized(response: ServerResponse) {
  response.writeHead(401, { "www-authenticate": "Bearer" }).end();
}

function destroySocket(socket: Duplex, status: number) {
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
