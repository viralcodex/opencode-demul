import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { bridgeAvcc } from "./stream-avcc.js";
import { avccDescription, avccSample, idr, delta } from "../test/video.js";

test("iOS backpressure restarts capture once after draining and releases every subscription", async () => {
  const frames: Buffer[] = [];
  const responses: ServerResponse[] = [];
  const closed: Promise<void>[] = [];
  const first = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<void>();
  const blocked = Promise.withResolvers<void>();
  let buffered = 0;
  class Viewer extends EventEmitter {
    readyState: number = WebSocket.OPEN;
    get bufferedAmount() {
      if (buffered > 0) blocked.resolve();
      return buffered;
    }
    send(bytes: Buffer) {
      frames.push(bytes);
      if (frames.length === 1) first.resolve();
      else recovered.resolve();
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
    }
  }
  const viewer = new Viewer();
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer hub-secret");
    responses.push(response);
    closed.push(new Promise((resolve) => request.socket.once("close", () => resolve())));
    response.writeHead(200).flushHeaders();
    response.write(Buffer.concat([avccDescription(), avccSample(2, [idr.subarray(4)])]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridge = bridgeAvcc(
    {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      authorization: "Bearer hub-secret",
    },
    viewer as unknown as WebSocket,
    100,
  );
  try {
    await first.promise;
    buffered = 95;
    responses[0]!.write(avccSample(3, [delta.subarray(3)]));
    await blocked.promise;
    buffered = 0;
    responses[0]!.write(avccSample(3, [delta.subarray(3)]));
    await recovered.promise;
    expect(responses).toHaveLength(2);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual(frames[0]);
  } finally {
    viewer.close();
    await bridge.done;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(closed);
  }
  expect(viewer.listenerCount("close")).toBe(0);
  expect(viewer.listenerCount("error")).toBe(0);
});
