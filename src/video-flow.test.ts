import { expect, test } from "bun:test";
import { VideoFlow } from "./video-flow.js";

const key = { key: true, picture: true, bytes: new Uint8Array(10) };
const delta = { key: false, picture: true, bytes: new Uint8Array(10) };
const configuration = { key: false, picture: false, bytes: new Uint8Array(10) };

test("initial playback forwards configuration but waits for a keyframe before deltas", () => {
  const flow = new VideoFlow(100, () => {
    throw new Error("unexpected recovery");
  });
  expect(flow.accept(configuration, 0)).toBe(true);
  expect(flow.accept(delta, 0)).toBe(false);
  expect(flow.accept(key, 0)).toBe(true);
  expect(flow.accept(delta, 0)).toBe(true);
});

test("backpressure includes the next packet and requests recovery only once after the buffer drains", () => {
  let recoveries = 0;
  const flow = new VideoFlow(100, () => recoveries++);
  expect(flow.accept(key, 0)).toBe(true);
  expect(flow.accept(delta, 95)).toBe(false);
  expect(flow.accept(key, 100)).toBe(false);
  expect(recoveries).toBe(0);
  expect(flow.accept(delta, 0)).toBe(false);
  expect(flow.accept(configuration, 0)).toBe(true);
  expect(flow.accept(delta, 0)).toBe(false);
  expect(recoveries).toBe(1);
  expect(flow.accept(key, 0)).toBe(true);
  expect(flow.accept(delta, 0)).toBe(true);
  expect(flow.accept(delta, 100)).toBe(false);
  expect(flow.accept(delta, 0)).toBe(false);
  expect(recoveries).toBe(2);
});

test("a naturally arriving keyframe recovers without requesting an unnecessary reset", () => {
  const flow = new VideoFlow(100, () => {
    throw new Error("unexpected recovery");
  });
  flow.accept(key, 0);
  flow.accept(delta, 100);
  expect(flow.accept(key, 0)).toBe(true);
  expect(flow.accept(delta, 0)).toBe(true);
});

test("an explicit viewer reset discards deltas without duplicating the reset request", () => {
  const flow = new VideoFlow(100, () => {
    throw new Error("unexpected recovery");
  });
  flow.accept(key, 0);
  flow.reset();
  expect(flow.accept(delta, 0)).toBe(false);
  expect(flow.accept(configuration, 0)).toBe(true);
  expect(flow.accept(key, 0)).toBe(true);
});
