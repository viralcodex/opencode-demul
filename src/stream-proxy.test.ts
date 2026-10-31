import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Device } from "./rpc.js";
import {
  authorizeBearer,
  authorizeSubprotocols,
  buildUpstream,
  expectedClientSubprotocol,
  startStreamProxy,
  videoRequestStatus,
  type StreamProxy,
} from "./stream-proxy.js";

const HUB_TOKEN = "hub-secret-token";

const descriptor = (over: Partial<Device.StreamDescriptor>): Device.StreamDescriptor => ({
  platform: "android",
  deviceId: "emulator-5554",
  baseUrl: "http://127.0.0.1:3400",
  token: HUB_TOKEN,
  protocol: "h264",
  loopback: true,
  ...over,
});

// Every server, proxy, and socket a test opens is torn down here so files stay independent and nothing leaks a port.
const teardown: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
});

function track<T extends { stop(): Promise<void> } | { close(): void }>(resource: T): T {
  teardown.push(() =>
    "stop" in resource ? resource.stop() : new Promise<void>((r) => (resource.close(), r())),
  );
  return resource;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

function proxyVideoUrl(proxy: StreamProxy, query = ""): string {
  return `${proxy.descriptor.baseUrl}/video${query}`;
}

describe("pure request contract", () => {
  test("buildUpstream targets the fixed serve-emu video WebSocket for Android", () => {
    const upstream = buildUpstream(
      descriptor({ protocol: "h264", baseUrl: "http://127.0.0.1:3400" }),
    );
    expect(upstream.kind).toBe("ws");
    expect(upstream).toEqual({
      kind: "ws",
      url: "ws://127.0.0.1:3400/vendor/serve-emu/ws?device=emulator-5554&video=1&frame-meta=1",
      subprotocol: `serve-emu.token.${HUB_TOKEN}`,
    });
  });

  test("buildUpstream targets the vendored serve-sim MJPEG route for iOS with Bearer auth", () => {
    const upstream = buildUpstream(
      descriptor({ platform: "ios", protocol: "mjpeg", deviceId: "UDID-1" }),
    );
    expect(upstream).toEqual({
      kind: "mjpeg",
      url: "http://127.0.0.1:3400/vendor/serve-sim/stream.mjpeg?device=UDID-1",
      authorization: `Bearer ${HUB_TOKEN}`,
    });
  });

  test("videoRequestStatus accepts only GET /video with at most a frame-meta query", () => {
    expect(videoRequestStatus("GET", "/video")).toBeUndefined();
    expect(videoRequestStatus("GET", "/video?frame-meta=1")).toBeUndefined();
    expect(videoRequestStatus("POST", "/video")).toBe(405);
    expect(videoRequestStatus("GET", "/")).toBe(404);
    expect(videoRequestStatus("GET", "/video/../secret")).toBe(404);
    expect(videoRequestStatus("GET", "/stream")).toBe(404);
    expect(videoRequestStatus("GET", "/video?token=x")).toBe(400);
    expect(videoRequestStatus("GET", "/video?frame-meta=1&device=x")).toBe(400);
  });

  test("authorizeBearer matches only the exact token", () => {
    expect(authorizeBearer("Bearer abc", "abc")).toBe(true);
    expect(authorizeBearer("Bearer abcd", "abc")).toBe(false);
    expect(authorizeBearer("Bearer ", "abc")).toBe(false);
    expect(authorizeBearer("Basic abc", "abc")).toBe(false);
    expect(authorizeBearer(undefined, "abc")).toBe(false);
  });

  test("authorizeSubprotocols matches the opencode-device.<token> offer in header or list form", () => {
    const expected = expectedClientSubprotocol("abc");
    expect(expected).toBe("opencode-device.abc");
    expect(authorizeSubprotocols(expected, "abc")).toBe(true);
    expect(authorizeSubprotocols(` other, ${expected} `, "abc")).toBe(true);
    expect(authorizeSubprotocols(["other", expected], "abc")).toBe(true);
    expect(authorizeSubprotocols("opencode-device.abcd", "abc")).toBe(false);
    expect(authorizeSubprotocols("opencode-device.", "abc")).toBe(false);
    expect(authorizeSubprotocols(undefined, "abc")).toBe(false);
  });
});

describe("MJPEG proxy (iOS)", () => {
  // A stand-in for the hub's serve-sim route: it enforces the fixed path, query, and Bearer token, then streams MJPEG.
  function fakeSimHub(): Promise<{
    baseUrl: string;
    lastRequest: () => { url?: string; auth?: string };
  }> {
    let url: string | undefined;
    let auth: string | undefined;
    const server = track(
      createServer((request, response) => {
        url = request.url;
        auth = request.headers.authorization;
        if (
          request.url !== "/vendor/serve-sim/stream.mjpeg?device=UDID-1" ||
          auth !== `Bearer ${HUB_TOKEN}`
        ) {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
        response.write("--frame\r\nContent-Type: image/jpeg\r\n\r\n");
        response.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
        response.write("\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n");
        response.write(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]));
      }),
    );
    return listen(server).then((port) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      lastRequest: () => ({ url, auth }),
    }));
  }

  test("streams the hub body only to a correctly authenticated viewer and hides the hub token", async () => {
    const hub = await fakeSimHub();
    const proxy = track(
      await startStreamProxy(
        descriptor({
          platform: "ios",
          protocol: "mjpeg",
          deviceId: "UDID-1",
          baseUrl: hub.baseUrl,
        }),
      ),
    );

    expect(proxy.descriptor.token).not.toBe(HUB_TOKEN);
    expect(proxy.descriptor.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(proxy.descriptor.loopback).toBe(true);

    const bytes = await readMjpeg(proxyVideoUrl(proxy), `Bearer ${proxy.descriptor.token}`);
    expect(bytes.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBe(true);
    expect(bytes.includes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]))).toBe(true);
    expect(hub.lastRequest()).toEqual({
      url: "/vendor/serve-sim/stream.mjpeg?device=UDID-1",
      auth: `Bearer ${HUB_TOKEN}`,
    });
  });

  test("rejects a missing, wrong, or malformed viewer request", async () => {
    const hub = await fakeSimHub();
    const proxy = track(
      await startStreamProxy(
        descriptor({
          platform: "ios",
          protocol: "mjpeg",
          deviceId: "UDID-1",
          baseUrl: hub.baseUrl,
        }),
      ),
    );
    const token = proxy.descriptor.token;

    expect((await fetch(proxyVideoUrl(proxy))).status).toBe(401);
    expect(
      (await fetch(proxyVideoUrl(proxy), { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(proxyVideoUrl(proxy), {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(`${proxy.descriptor.baseUrl}/secret`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(proxyVideoUrl(proxy, "?token=x"), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
  });

  test("stop closes the listener so the proxy no longer accepts connections", async () => {
    const hub = await fakeSimHub();
    const proxy = await startStreamProxy(
      descriptor({ platform: "ios", protocol: "mjpeg", deviceId: "UDID-1", baseUrl: hub.baseUrl }),
    );
    const url = proxyVideoUrl(proxy);
    const token = proxy.descriptor.token;
    await proxy.stop();
    await expect(fetch(url, { headers: { authorization: `Bearer ${token}` } })).rejects.toThrow();
  });
});

describe("H.264 proxy (Android)", () => {
  interface FakeEmuHub {
    baseUrl: string;
    lastUrl: () => string | undefined;
    received: () => RawData[];
    clientMessage: Promise<RawData>;
    clientClosed: Promise<void>;
  }

  // A stand-in for the hub's serve-emu socket: it enforces the serve-emu.token subprotocol, records inbound frames
  // (to prove the proxy never relays a client message upstream), and sends one H.264 binary frame plus a text header.
  function fakeEmuHub(): Promise<FakeEmuHub> {
    let lastUrl: string | undefined;
    const received: RawData[] = [];
    const clientMessage = Promise.withResolvers<RawData>();
    let resolveClosed: () => void = () => {};
    const clientClosed = new Promise<void>((resolve) => (resolveClosed = resolve));
    const server = createServer();
    const wss = new WebSocketServer({
      server,
      handleProtocols: (offered) =>
        offered.has(`serve-emu.token.${HUB_TOKEN}`) ? `serve-emu.token.${HUB_TOKEN}` : false,
    });
    wss.on("connection", (socket, request) => {
      lastUrl = request.url;
      socket.on("message", (data) => {
        received.push(data);
        clientMessage.resolve(data);
      });
      socket.on("close", resolveClosed);
      socket.send(JSON.stringify({ type: "video-session", size: { width: 1080, height: 2400 } }));
      socket.send(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]), { binary: true });
    });
    teardown.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of wss.clients) socket.terminate();
          wss.close();
          server.close(() => resolve());
        }),
    );
    return listen(server).then((port) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      lastUrl: () => lastUrl,
      received: () => received,
      clientMessage: clientMessage.promise,
      clientClosed,
    }));
  }

  test("forwards hub frames to a subprotocol-authenticated viewer over the fixed route", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(
      await startStreamProxy(
        descriptor({ protocol: "h264", deviceId: "emulator-5554", baseUrl: hub.baseUrl }),
      ),
    );

    const client = new WebSocket(proxyVideoUrl(proxy, "?frame-meta=1"), [
      `opencode-device.${proxy.descriptor.token}`,
    ]);
    const messages = await collect(client, 2);

    expect(typeof messages[0]).toBe("string");
    expect(JSON.parse(messages[0] as string)).toEqual({
      type: "video-session",
      size: { width: 1080, height: 2400 },
    });
    expect(messages[1]).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));
    expect(hub.lastUrl()).toBe("/vendor/serve-emu/ws?device=emulator-5554&video=1&frame-meta=1");
    client.close();
    await hub.clientClosed;
  });

  test("never relays device input or arbitrary client messages upstream", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(
      await startStreamProxy(
        descriptor({ protocol: "h264", deviceId: "emulator-5554", baseUrl: hub.baseUrl }),
      ),
    );
    const client = new WebSocket(proxyVideoUrl(proxy), [
      `opencode-device.${proxy.descriptor.token}`,
    ]);
    await collect(client, 1);
    client.send(Buffer.from([9, 9, 9]));
    client.send("steer the device");
    client.close();
    // The hub only receives what the proxy writes; the proxy writes nothing before closing, so inbound stays empty.
    await hub.clientClosed;
    expect(hub.received()).toEqual([]);
  });

  test("allows only a fixed video reset and never forwards arbitrary request fields", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));
    const client = new WebSocket(proxyVideoUrl(proxy), [
      `opencode-device.${proxy.descriptor.token}`,
    ]);
    await collect(client, 1);
    client.send(JSON.stringify({ type: "tap", x: 10, y: 20 }));
    client.send(JSON.stringify({ type: "reset-video", ack: true, secret: "must-not-forward" }));
    expect(JSON.parse(toBuffer(await hub.clientMessage).toString())).toEqual({
      type: "reset-video",
      ack: false,
    });
    client.close();
    await hub.clientClosed;
    expect(hub.received()).toHaveLength(1);
  });

  test("rejects a WebSocket that offers a missing or wrong subprotocol", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(
      await startStreamProxy(
        descriptor({ protocol: "h264", deviceId: "emulator-5554", baseUrl: hub.baseUrl }),
      ),
    );

    await expect(opens(new WebSocket(proxyVideoUrl(proxy)))).resolves.toBe(false);
    await expect(
      opens(new WebSocket(proxyVideoUrl(proxy), ["opencode-device.wrong"])),
    ).resolves.toBe(false);
    await expect(
      opens(new WebSocket(proxyVideoUrl(proxy), [`serve-emu.token.${proxy.descriptor.token}`])),
    ).resolves.toBe(false);
  });
});

async function readMjpeg(url: string, authorization: string): Promise<Buffer> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { authorization }, signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < 14) {
    const next = await reader.read();
    if (next.done) break;
    if (next.value) {
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  }
  controller.abort();
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks);
}

function collect(socket: WebSocket, count: number): Promise<Array<string | Buffer>> {
  return new Promise((resolve, reject) => {
    const messages: Array<string | Buffer> = [];
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const buffer = toBuffer(data);
      messages.push(isBinary ? buffer : buffer.toString("utf8"));
      if (messages.length >= count) resolve(messages);
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("socket closed before enough messages")));
  });
}

function opens(socket: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    socket.on("open", () => (socket.close(), resolve(true)));
    socket.on("error", () => resolve(false));
    socket.on("close", () => resolve(false));
  });
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
