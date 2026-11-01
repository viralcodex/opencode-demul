import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData } from "ws";
import type { Device } from "../rpc.js";
import {
  encodeButton,
  encodeTouch,
  isHidButton,
  pressButton,
  sendTouches,
  swipeEvents,
  tapEvents,
  waitForScreen,
} from "./serve-sim.js";

const HUB_TOKEN = "fixture-hid-secret-token";
const buttonCases = [
  ["home", '{"button":"home"}'],
  ["lock", '{"button":"power","page":12,"usage":48}'],
  ["volumeUp", '{"button":"volume-up","page":12,"usage":233}'],
  ["volumeDown", '{"button":"volume-down","page":12,"usage":234}'],
] as const;
const descriptor = (baseUrl: string): Device.StreamDescriptor => ({
  platform: "ios",
  deviceId: "UDID-1",
  baseUrl,
  token: HUB_TOKEN,
  protocol: "mjpeg",
  loopback: true,
});

const teardown: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close();
});

function listen(server: Server): Promise<string> {
  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function track(server: WebSocketServer): WebSocketServer {
  teardown.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  return server;
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

test("encodeTouch writes tag 3 followed by the event's UTF-8 JSON bytes", () => {
  const event = { type: "begin" as const, x: 0.25, y: 0.75 };
  const encoded = encodeTouch(event);
  const json = Buffer.from('{"type":"begin","x":0.25,"y":0.75}', "utf8");
  expect(encoded[0]).toBe(3);
  expect(encoded.subarray(1)).toEqual(json);
  expect(encoded.byteLength).toBe(1 + json.byteLength);
});

test.each(buttonCases)("encodeButton writes tag 4 and %s UTF-8 JSON bytes", (button, payload) => {
  const encoded = encodeButton(button);
  const json = Buffer.from(payload, "utf8");
  expect(encoded[0]).toBe(4);
  expect(encoded.subarray(1)).toEqual(json);
  expect(encoded.byteLength).toBe(1 + json.byteLength);
});

test("isHidButton accepts all four HID keys but rejects back and recents", () => {
  for (const [button] of buttonCases) expect(isHidButton(button)).toBe(true);
  for (const key of ["back", "recents"]) expect(isHidButton(key)).toBe(false);
});

test("tapEvents begins and ends at the same normalized point", () => {
  expect(tapEvents({ x: 0.25, y: 0.75 })).toEqual([
    { type: "begin", x: 0.25, y: 0.75 },
    { type: "end", x: 0.25, y: 0.75 },
  ]);
});

test("swipeEvents interpolates the requested number of steps between exact endpoints", () => {
  expect(swipeEvents({ x: 0, y: 1 }, { x: 1, y: 0 }, 4)).toEqual([
    { type: "begin", x: 0, y: 1 },
    { type: "move", x: 0.25, y: 0.75 },
    { type: "move", x: 0.5, y: 0.5 },
    { type: "move", x: 0.75, y: 0.25 },
    { type: "end", x: 1, y: 0 },
  ]);
});

test("swipeEvents defaults to ten steps and nine interpolated moves", () => {
  const events = swipeEvents({ x: 0, y: 0 }, { x: 1, y: 1 });
  expect(events).toHaveLength(11);
  expect(events[0]).toEqual({ type: "begin", x: 0, y: 0 });
  expect(events.at(-1)).toEqual({ type: "end", x: 1, y: 1 });
  expect(events.slice(1, -1)).toEqual(
    Array.from({ length: 9 }, (_, index) => ({
      type: "move",
      x: (index + 1) / 10,
      y: (index + 1) / 10,
    })),
  );
});

test("sendTouches authenticates the device-scoped HID socket and sends binary messages in order", async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  const received: Array<{ data: Buffer; binary: boolean }> = [];
  const closed = Promise.withResolvers<void>();
  let lastMessageAt = 0;
  let closedAt = 0;
  let offeredProtocols: string[] = [];
  let requestUrl: string | undefined;
  let selectedProtocol: string | undefined;
  const wss = track(
    new WebSocketServer({
      server,
      handleProtocols: (offered) => {
        offeredProtocols = [...offered];
        return offered.has(`serve-sim.token.${HUB_TOKEN}`) ? `serve-sim.token.${HUB_TOKEN}` : false;
      },
    }),
  );
  wss.on("connection", (socket, request) => {
    requestUrl = request.url;
    selectedProtocol = socket.protocol;
    socket.on("message", (data, binary) => {
      received.push({ data: toBuffer(data), binary });
      lastMessageAt = performance.now();
    });
    socket.on("close", () => {
      closedAt = performance.now();
      closed.resolve();
    });
  });

  const events = swipeEvents({ x: 0.25, y: 0.75 }, { x: 0.75, y: 0.25 }, 4);
  await sendTouches(descriptor(baseUrl), events, 1, 1_000);
  await closed.promise;

  const url = new URL(requestUrl!, baseUrl);
  expect(url.pathname).toBe("/vendor/serve-sim/helper/ws");
  expect([...url.searchParams]).toEqual([["device", "UDID-1"]]);
  expect(offeredProtocols).toEqual([`serve-sim.token.${HUB_TOKEN}`]);
  expect(selectedProtocol).toBe(`serve-sim.token.${HUB_TOKEN}`);
  expect(received).toEqual(events.map((event) => ({ data: encodeTouch(event), binary: true })));
  expect(closedAt - lastMessageAt).toBeGreaterThanOrEqual(490);
});

test.each(buttonCases)(
  "pressButton authenticates the HID socket and sends one binary tag-4 %s message",
  async (button, payload) => {
    const server = createServer();
    const baseUrl = await listen(server);
    const received: Array<{ data: Buffer; binary: boolean }> = [];
    const closed = Promise.withResolvers<void>();
    let lastMessageAt = 0;
    let closedAt = 0;
    let requestUrl: string | undefined;
    let selectedProtocol: string | undefined;
    const wss = track(
      new WebSocketServer({
        server,
        handleProtocols: (offered) =>
          offered.has(`serve-sim.token.${HUB_TOKEN}`) ? `serve-sim.token.${HUB_TOKEN}` : false,
      }),
    );
    wss.on("connection", (socket, request) => {
      requestUrl = request.url;
      selectedProtocol = socket.protocol;
      socket.on("message", (data, binary) => {
        received.push({ data: toBuffer(data), binary });
        lastMessageAt = performance.now();
      });
      socket.on("close", () => {
        closedAt = performance.now();
        closed.resolve();
      });
    });

    await pressButton(descriptor(baseUrl), button);
    await closed.promise;

    expect(requestUrl).toBe("/vendor/serve-sim/helper/ws?device=UDID-1");
    expect(selectedProtocol).toBe(`serve-sim.token.${HUB_TOKEN}`);
    expect(received).toEqual([
      { data: Buffer.concat([Buffer.from([4]), Buffer.from(payload, "utf8")]), binary: true },
    ]);
    expect(closedAt - lastMessageAt).toBeGreaterThanOrEqual(490);
  },
);

test("pressButton reports a refused upgrade as a button press without leaking the token", async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  track(
    new WebSocketServer({
      server,
      verifyClient: (_info, done) => done(false, 401, "Unauthorized"),
    }),
  );
  await expect(pressButton(descriptor(baseUrl), "home")).rejects.toMatchObject({
    message: expect.stringContaining("button press"),
    data: {
      code: "helper-failed",
      mayHaveExecuted: false,
      message: expect.not.stringContaining(HUB_TOKEN),
    },
  });
});

test("sendTouches reports a refused upgrade without claiming input ran or leaking the token", async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  track(
    new WebSocketServer({
      server,
      verifyClient: (_info, done) => done(false, 401, "Unauthorized"),
    }),
  );
  const failure = await sendTouches(
    descriptor(baseUrl),
    tapEvents({ x: 0.5, y: 0.5 }),
    1,
    1_000,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    message: expect.not.stringContaining(HUB_TOKEN),
    data: {
      code: "helper-failed",
      mayHaveExecuted: false,
    },
  });
});

test("waitForScreen polls the authenticated config route until capture becomes ready", async () => {
  const requests: Array<{ url?: string; auth?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization });
    response.writeHead(requests.length <= 2 ? 404 : 200).end("{}");
  });
  const baseUrl = await listen(server);
  await expect(waitForScreen(descriptor(baseUrl), 1_000, 5)).resolves.toBeUndefined();
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({
      url: "/vendor/serve-sim/helper/config?device=UDID-1",
      auth: `Bearer ${HUB_TOKEN}`,
    })),
  );
});

test("waitForScreen reports a timeout when capture never becomes ready", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  await expect(waitForScreen(descriptor(baseUrl), 40, 5)).rejects.toMatchObject({
    data: { code: "timeout", mayHaveExecuted: false },
  });
  expect(requests).toBeGreaterThan(0);
});
