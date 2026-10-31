import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { Schema } from "effect";
import type { Device } from "./rpc.js";

// A loopback video proxy that fronts the device hub's stream for the renderer. The hub mints one session token that
// unlocks every hub route; handing that token to the viewer would let the viewer reach the whole hub. Instead the proxy
// binds its own `127.0.0.1` port and its own random token, exposes exactly one route — `GET /video` — and re-connects
// upstream to the hub with the hub's credentials, which never leave this process. The viewer therefore holds a token
// that can reach only the video of one device, and the proxy revokes it by closing when the attachment ends.
//
// The upstream routes are the fixed, vendored hub endpoints, not guesses:
// - Android serves H.264 over the `serve-emu` video WebSocket at `/vendor/serve-emu/ws`, selected with
// `?device=<id>&video=1&frame-meta=1` and authenticated by the `serve-emu.token.<token>` subprotocol. The stream is
// video-only: the proxy never forwards a client message upstream, so a compromised viewer cannot drive the device.
// - iOS serves MJPEG over the `serve-sim` route `/vendor/serve-sim/stream.mjpeg`, selected with `?device=<id>` and
// authenticated by `Authorization: Bearer <token>`. This route is read from the installed vendor source
// (`serve-sim/dist/serve-sim.js`: a `GET /stream.mjpeg` handler writing `multipart/x-mixed-replace`), not assumed.

// The only host the proxy binds. The video never leaves the machine.
export const LOOPBACK_HOST = "127.0.0.1";

// The single route the proxy serves. Every other path is a 404.
export const VIDEO_PATH = "/video";

// The only query key the viewer may pass (`frame-meta=1` for the H.264 metadata header). Any other key is rejected.
export const ALLOWED_QUERY_KEY = "frame-meta";

// The viewer authenticates a WebSocket by offering this subprotocol with the proxy token appended.
export const CLIENT_SUBPROTOCOL_PREFIX = "opencode-device.";

// The ceiling on a downstream socket's outbound buffer. Beyond it the proxy drops video frames rather than grow.
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// A running proxy: the descriptor the viewer connects to, and a `stop` that closes every socket and fetch it owns.
export interface StreamProxy {
  readonly descriptor: Device.StreamDescriptor;
  stop(): Promise<void>;
}

// Where the proxy reconnects upstream, derived from the hub descriptor. The two platforms use different transports.
export type UpstreamTarget =
  | { readonly kind: "ws"; readonly url: string; readonly subprotocol: string }
  | { readonly kind: "mjpeg"; readonly url: string; readonly authorization: string };

// Start the proxy for one hub stream and resolve once it is listening. The returned descriptor points at the proxy, not
// the hub, so the viewer never sees the hub token. `stop` tears down the listener and every connection it opened.
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
    const status = videoRequestStatus(request.method, request.url);
    if (status) return reject(response, status);
    if (upstream.kind !== "mjpeg") return reject(response, 426);
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

// Build the fixed upstream hub endpoint for a descriptor. H.264 is a WebSocket; MJPEG is an authenticated GET.
export function buildUpstream(raw: Device.StreamDescriptor): UpstreamTarget {
  const origin = new URL(raw.baseUrl).origin;
  if (raw.protocol === "h264") {
    const url = new URL("/vendor/serve-emu/ws", origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("device", raw.deviceId);
    url.searchParams.set("video", "1");
    url.searchParams.set("frame-meta", "1");
    return { kind: "ws", url: url.toString(), subprotocol: `serve-emu.token.${raw.token}` };
  }
  const url = new URL("/vendor/serve-sim/stream.mjpeg", origin);
  url.searchParams.set("device", raw.deviceId);
  return { kind: "mjpeg", url: url.toString(), authorization: `Bearer ${raw.token}` };
}

// The subprotocol a viewer must offer to authenticate a WebSocket connection to the proxy.
export function expectedClientSubprotocol(token: string): string {
  return CLIENT_SUBPROTOCOL_PREFIX + token;
}

// Validate a request line: only `GET`, only `/video`, only the `frame-meta` query. Return a status on rejection.
export function videoRequestStatus(
  method: string | undefined,
  requestUrl: string | undefined,
): number | undefined {
  if (method !== "GET") return 405;
  const url = new URL(requestUrl ?? "/", `http://${LOOPBACK_HOST}`);
  if (url.pathname !== VIDEO_PATH) return 404;
  for (const key of url.searchParams.keys()) if (key !== ALLOWED_QUERY_KEY) return 400;
  return undefined;
}

// True when an `Authorization` header carries exactly `Bearer <token>`, compared in constant time.
export function authorizeBearer(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/u.exec(header ?? "");
  return match ? safeEqual(match[1], token) : false;
}

// True when one offered WebSocket subprotocol is exactly the expected `opencode-device.<token>`, in constant time.
export function authorizeSubprotocols(
  header: string | string[] | undefined,
  token: string,
): boolean {
  const expected = expectedClientSubprotocol(token);
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

function unauthorized(response: ServerResponse) {
  response.writeHead(401, { "www-authenticate": "Bearer" }).end();
}

function destroySocket(socket: Duplex, status: number) {
  const reason = status === 401 ? "Unauthorized" : "Bad Request";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
