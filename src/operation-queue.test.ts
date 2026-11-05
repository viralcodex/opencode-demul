import { expect, test } from "bun:test";
import { OperationQueue } from "./operation-queue.js";

test("queued cancellation rejects before the active action finishes and never bypasses that action", async () => {
  const queue = new OperationQueue();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const calls: string[] = [];
  const first = queue.run(async () => {
    started.resolve();
    calls.push("first");
    await release.promise;
  });
  await started.promise;
  const abort = new AbortController();
  const second = queue.run(async () => {
    calls.push("cancelled");
  }, abort.signal);
  const third = queue.run(async () => {
    calls.push("third");
  });
  abort.abort();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual(["first"]);
  release.resolve();
  await Promise.all([first, third, queue.drain()]);
  expect(calls).toEqual(["first", "third"]);
});

test("running cancellation waits for the action's own cleanup before advancing the queue", async () => {
  const queue = new OperationQueue();
  const abort = new AbortController();
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const first = queue.run(async () => {
    started.resolve();
    await released.promise;
    abort.signal.throwIfAborted();
  }, abort.signal);
  await started.promise;
  abort.abort();
  let nextStarted = false;
  const next = queue.run(async () => {
    nextStarted = true;
  });
  await Promise.resolve();
  expect(nextStarted).toBe(false);
  released.resolve();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  await next;
  expect(nextStarted).toBe(true);
});
