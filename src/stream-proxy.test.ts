import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { on } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Device } from "./rpc.js";
import { startStreamProxy, type StreamProxy } from "./stream-proxy.js";
import { parseFramePacket } from "./h264.js";
import { avccDescription, avccRecord, avccSample, idr, delta } from "../test/video.js";

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

test("malformed HTTP and upgrade targets return 400 without crashing the Node host", async () => {
  const built = await Bun.build({
    entrypoints: ["src/stream-proxy.ts"],
    target: "node",
    format: "cjs",
    packages: "external",
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const bundle = await built.outputs[0]!.text();
  const child = Bun.spawn(["node"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(`
    const assert = require("node:assert/strict");
    const { connect } = require("node:net");
    const bundle = { exports: {} };
    new Function("require", "module", "exports", ${JSON.stringify(bundle)})(require, bundle, bundle.exports);
    (async () => {
      const proxy = await bundle.exports.startStreamProxy({ platform: "android", deviceId: "fixture", baseUrl: "http://127.0.0.1:1", token: "fixture", protocol: "h264", loopback: true });
      const origin = new URL(proxy.descriptor.baseUrl);
      try {
        for (const target of ["http://[", "//[", "http://%"] ) {
          for (const upgrade of [false, true]) {
            const response = await new Promise((resolve, reject) => {
              const socket = connect(Number(origin.port), origin.hostname);
              let result = "";
              socket.setTimeout(2000, () => socket.destroy(new Error("request timed out")));
              socket.on("error", reject);
              socket.on("data", chunk => result += chunk.toString());
              socket.on("close", () => resolve(result));
              socket.on("connect", () => socket.write("GET " + target + " HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: " + (upgrade ? "Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" : "close") + "\\r\\n\\r\\n"));
            });
            assert.equal(response.startsWith("HTTP/1.1 400"), true);
          }
        }
        assert.equal((await fetch(proxy.descriptor.baseUrl + "/video")).status, 426);
      } finally {
        await proxy.stop();
      }
      console.log("malformed targets rejected; proxy still responsive");
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("proxy still responsive");
}, 10_000);

function track<T extends { stop(): Promise<void> } | { close(): void }>(resource: T): T {
  teardown.push(() => ("stop" in resource ? resource.stop() : resource.close()));
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

function viewer(
  proxy: StreamProxy,
  query = "",
  protocols = [`opencode-device.${proxy.descriptor.token}`],
) {
  return track(new WebSocket(proxyVideoUrl(proxy, query), protocols));
}

describe("H.264 proxy (iOS)", () => {
  const simDescriptor = (baseUrl: string) =>
    descriptor({ platform: "ios", deviceId: "UDID-1", baseUrl });

  // A seed JPEG, AVC decoder description, keyframe, and delta in serve-sim's length-prefixed HTTP format.
  const avcc = Buffer.concat([
    avccRecord(4, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    avccDescription(),
    avccSample(2, [idr.subarray(4)]),
    avccSample(3, [delta.subarray(3)]),
  ]);
  function fakeSimHub(
    options: { status?: number; payload?: Buffer; end?: boolean; headers?: boolean } = {},
  ) {
    const requests: Array<{ url?: string; auth?: string; method?: string }> = [];
    const closed = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    const server = track(
      createServer((request, response) => {
        requests.push({
          url: request.url,
          auth: request.headers.authorization,
          method: request.method,
        });
        requested.resolve();
        request.socket.on("close", () => closed.resolve());
        if (
          request.url !== "/vendor/serve-sim/helper/stream.avcc?device=UDID-1" ||
          request.headers.authorization !== `Bearer ${HUB_TOKEN}`
        ) {
          response.writeHead(401).end();
          return;
        }
        if (options.headers === false) return;
        response.writeHead(options.status ?? 200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.write(options.payload ?? avcc);
        if (options.end || options.status) response.end();
      }),
    );
    return listen(server).then((port) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      closed: closed.promise,
      requested: requested.promise,
    }));
  }

  test("normalizes native H.264 for the shared authenticated viewer and skips JPEG seeds", async () => {
    const hub = await fakeSimHub();
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));

    expect(proxy.descriptor.token).not.toBe(HUB_TOKEN);
    expect(proxy.descriptor.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
    expect(proxy.descriptor.loopback).toBe(true);
    expect(proxy.descriptor.protocol).toBe("h264");
    const client = viewer(proxy, "?frame-meta=1");
    const messages = await collect(client, 2);
    expect(messages).toEqual([
      Buffer.from([
        0, 0, 0, 1, 0x67, 0x64, 0, 0x29, 0, 0, 0, 1, 0x68, 0xeb, 0, 0, 0, 1, 0x65, 0x88,
      ]),
      Buffer.from([0, 0, 0, 1, 0x41, 0x99]),
    ]);
    expect(parseFramePacket(messages[0] as Buffer)).toMatchObject({
      key: true,
      codec: "avc1.640029",
    });
    expect(hub.requests).toEqual([
      {
        url: "/vendor/serve-sim/helper/stream.avcc?device=UDID-1",
        auth: `Bearer ${HUB_TOKEN}`,
        method: "GET",
      },
    ]);
    client.close();
    await hub.closed;
  });

  test("only a validated video reset restarts the capture subscription", async () => {
    const hub = await fakeSimHub();
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
    const client = viewer(proxy);
    await collect(client, 2);
    const next = collect(client, 2);
    client.send(Buffer.from([9, 9, 9]));
    client.send("steer the device");
    client.send(JSON.stringify({ type: "tap", x: 10, y: 20 }));
    client.send(JSON.stringify({ type: "reset-video", ack: true, device: "must-not-forward" }));
    await next;
    expect(hub.requests).toHaveLength(2);
    expect(hub.requests[1]).toEqual(hub.requests[0]);
    client.close();
    await hub.closed;
  });

  test("rejects unauthenticated sockets without opening an upstream stream", async () => {
    const hub = await fakeSimHub();
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
    expect(await opens(new WebSocket(proxyVideoUrl(proxy)))).toBe(false);
    expect(await opens(new WebSocket(proxyVideoUrl(proxy), ["opencode-device.wrong"]))).toBe(false);
    expect(
      await opens(
        new WebSocket(proxyVideoUrl(proxy, "?device=other"), [
          `opencode-device.${proxy.descriptor.token}`,
        ]),
      ),
    ).toBe(false);
    expect(hub.requests).toEqual([]);
  });

  test("HTTP video and input routes are unavailable", async () => {
    const hub = await fakeSimHub();
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
    for (const [method, route, httpStatus] of [
      ["GET", "/video", 426],
      ["OPTIONS", "/video", 405],
      ["POST", "/video", 405],
      ["GET", "/", 404],
      ["GET", "/secret", 404],
      ["GET", "/video/../secret", 404],
      ["GET", "/stream", 404],
      ["GET", "/video?token=x", 400],
      ["GET", "/video?frame-meta=1&device=x", 400],
    ] as const) {
      expect(
        (
          await fetch(`${proxy.descriptor.baseUrl}${route}`, {
            method,
            headers: { authorization: `Bearer ${proxy.descriptor.token}` },
          })
        ).status,
      ).toBe(httpStatus);
    }
    expect(hub.requests).toEqual([]);
  });

  test.each([
    { options: { status: 401 }, error: "HTTP 401" },
    { options: { payload: Buffer.from([0, 128, 0, 1]) }, error: "record size" },
    { options: { payload: Buffer.from([0, 0]), end: true }, error: "Truncated" },
    { options: { end: true }, error: "stream ended" },
  ])("reports upstream failures and closes the viewer: $error", async ({ options, error }) => {
    const hub = await fakeSimHub(options);
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
    const client = viewer(proxy);
    const messages: Array<string | Buffer> = [];
    client.on("message", (data, binary) =>
      messages.push(binary ? toBuffer(data) : toBuffer(data).toString()),
    );
    await new Promise<void>((resolve, reject) => {
      client.on("error", reject);
      client.on("close", () => resolve());
    });
    const message = JSON.parse(messages.at(-1) as string);
    expect(message.ok).toBe(false);
    expect(message.error).toContain(error);
    expect(message.error).not.toContain(HUB_TOKEN);
  });

  test.each([false, true])(
    "stop aborts a pending upstream stream and closes the listener, headers=%s",
    async (headers) => {
      const hub = await fakeSimHub({ payload: Buffer.alloc(0), headers });
      const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
      const url = proxyVideoUrl(proxy);
      const client = viewer(proxy);
      const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
      await hub.requested;
      await proxy.stop();
      await closed;
      await hub.closed;
      await expect(fetch(url)).rejects.toThrow();
    },
  );

  test("viewer closure cancels its stream without stopping another viewer", async () => {
    const hub = await fakeSimHub();
    const proxy = track(await startStreamProxy(simDescriptor(hub.baseUrl)));
    const first = viewer(proxy);
    const second = viewer(proxy);
    await Promise.all([collect(first, 2), collect(second, 2)]);
    first.close();
    await hub.closed;
    const next = collect(second, 2);
    second.send(JSON.stringify({ type: "reset-video" }));
    await next;
    expect(second.readyState).toBe(WebSocket.OPEN);
    second.close();
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
  function fakeEmuHub(frames = [Buffer.from([0, 0, 0, 1, 0x67, 0x42])]): Promise<FakeEmuHub> {
    let lastUrl: string | undefined;
    const received: RawData[] = [];
    const clientMessage = Promise.withResolvers<RawData>();
    const clientClosed = Promise.withResolvers<void>();
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
      socket.on("close", () => clientClosed.resolve());
      socket.send(JSON.stringify({ type: "video-session", size: { width: 1080, height: 2400 } }));
      for (const frame of frames) socket.send(frame, { binary: true });
      socket.send(
        JSON.stringify({ type: "diagnostic", message: `fixture diagnostic ${HUB_TOKEN}` }),
      );
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
      clientClosed: clientClosed.promise,
    }));
  }

  test("forwards hub frames to a subprotocol-authenticated viewer over the fixed route", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));

    const client = viewer(proxy, "?frame-meta=1", [
      "other",
      `opencode-device.${proxy.descriptor.token}`,
    ]);
    const messages = await collect(client, 3);

    expect(typeof messages[0]).toBe("string");
    expect(JSON.parse(messages[0] as string)).toEqual({
      type: "video-session",
      size: { width: 1080, height: 2400 },
    });
    expect(messages[1]).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42]));
    expect(JSON.parse(messages[2] as string)).toEqual({
      type: "diagnostic",
      message: "fixture diagnostic [redacted]",
    });
    expect(hub.lastUrl()).toBe("/vendor/serve-emu/ws?device=emulator-5554&video=1&frame-meta=1");
    client.close();
    await hub.clientClosed;
  });

  test("never relays device input or arbitrary client messages upstream", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));
    const client = viewer(proxy);
    await collect(client, 1);
    client.send(Buffer.from([9, 9, 9]));
    client.send("steer the device");
    client.close();
    // The hub only receives what the proxy writes; the proxy writes nothing before closing, so inbound stays empty.
    await hub.clientClosed;
    expect(hub.received()).toEqual([]);
  });

  test("forwards separate configuration but drops initial dependent pictures until an IDR", async () => {
    const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x29]);
    const skipped = Buffer.from([0, 0, 1, 0x41, 0x11]);
    const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
    const delta = Buffer.from([0, 0, 1, 0x41, 0x22]);
    const hub = await fakeEmuHub([sps, skipped, idr, delta]);
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));
    const client = viewer(proxy);
    const messages = await collect(client, 5);
    expect(messages.filter((message) => Buffer.isBuffer(message))).toEqual([sps, idr, delta]);
    client.close();
    await hub.clientClosed;
  });

  test("allows only a fixed video reset and never forwards arbitrary request fields", async () => {
    const hub = await fakeEmuHub();
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));
    const client = viewer(proxy);
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
    const proxy = track(await startStreamProxy(descriptor({ baseUrl: hub.baseUrl })));

    await expect(opens(new WebSocket(proxyVideoUrl(proxy)))).resolves.toBe(false);
    await expect(
      opens(new WebSocket(proxyVideoUrl(proxy), ["opencode-device.wrong"])),
    ).resolves.toBe(false);
    await expect(
      opens(new WebSocket(proxyVideoUrl(proxy), [`opencode-device.${proxy.descriptor.token}x`])),
    ).resolves.toBe(false);
    await expect(opens(new WebSocket(proxyVideoUrl(proxy), ["opencode-device."]))).resolves.toBe(
      false,
    );
    await expect(
      opens(new WebSocket(proxyVideoUrl(proxy), [`serve-emu.token.${proxy.descriptor.token}`])),
    ).resolves.toBe(false);
  });
});

async function collect(socket: WebSocket, count: number): Promise<Array<string | Buffer>> {
  const messages: Array<string | Buffer> = [];
  for await (const [data, isBinary] of on(socket, "message", { close: ["close"] })) {
    const bytes = toBuffer(data);
    messages.push(isBinary ? bytes : bytes.toString("utf8"));
    if (messages.length === count) return messages;
  }
  throw new Error("socket closed before enough messages");
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
