import { expect, test } from "bun:test";
import { createLatestRequest } from "./latest-request.js";

test("refresh stays independent of selection and superseded selections cannot update the panel", async () => {
  const states: boolean[] = [];
  const errors: unknown[] = [];
  const values: string[] = [];
  const selection = createLatestRequest({
    pending: (state) => states.push(state),
    error: (error) => errors.push(error),
  });
  const discovery = createLatestRequest({
    pending: () => undefined,
    error: (error) => errors.push(error),
  });
  const first = Promise.withResolvers<string>();
  let signal: AbortSignal | undefined;
  const previous = selection.run(
    (current) => {
      signal = current;
      return first.promise;
    },
    (value) => values.push(value),
  );
  await discovery.run(
    async () => "devices",
    (value) => values.push(value),
  );
  expect(signal?.aborted).toBe(false);
  expect(states).toEqual([true]);
  await selection.run(
    async () => "latest device",
    (value) => values.push(value),
  );
  expect(signal?.aborted).toBe(true);
  first.reject(new Error("obsolete boot failure"));
  await previous;
  expect(values).toEqual(["devices", "latest device"]);
  expect(states).toEqual([true, true, false]);
  expect(errors).toEqual([]);
});

test("closing a panel cancels pending work and ignores late success", async () => {
  const values: string[] = [];
  const states: boolean[] = [];
  const request = createLatestRequest({
    pending: (state) => states.push(state),
    error: () => {
      throw new Error("cancelled work reported an error");
    },
  });
  const result = Promise.withResolvers<string>();
  const pending = request.run(
    () => result.promise,
    (value) => values.push(value),
  );
  request.cancel();
  result.resolve("old device");
  await pending;
  expect(values).toEqual([]);
  expect(states).toEqual([true, false]);
});
