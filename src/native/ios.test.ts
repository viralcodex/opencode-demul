import { expect, test } from "bun:test";
import { ensureSimulatorBooted, parseSimctlDevices, shutdownSimulator } from "./ios.js";
import type { CommandResult, CommandSpec } from "./process.js";

const UDID = "UDID-1";
const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-2";
const LIST_ARGS = ["simctl", "list", "devices", "available", "-j"];

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

function deviceList(state: string, isAvailable = true): string {
  return JSON.stringify({
    devices: { [IOS_RUNTIME]: [{ udid: UDID, name: "Fixture iPhone", state, isAvailable }] },
  });
}

function fakeRun(results: readonly CommandResult[]) {
  const commands: CommandSpec[] = [];
  return {
    commands,
    run: async (spec: CommandSpec): Promise<CommandResult> => {
      expect(spec.command).toBe("xcrun");
      commands.push(spec);
      const next = results[commands.length - 1];
      if (!next) throw new Error(`Unexpected simctl command: ${spec.args.join(" ")}`);
      return next;
    },
  };
}

test("parseSimctlDevices filters non-iOS runtimes and maps runtime versions", () => {
  expect(
    parseSimctlDevices(
      JSON.stringify({
        devices: {
          [IOS_RUNTIME]: [{ udid: UDID, name: "Fixture iPhone", state: "Booted" }],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4-1": [
            { udid: "UDID-2", name: "Fixture iPad", state: "Shutdown" },
          ],
          "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [
            { udid: "WATCH-1", name: "Fixture Watch", state: "Booted" },
          ],
        },
      }),
    ),
  ).toEqual([
    {
      id: UDID,
      name: "Fixture iPhone",
      platform: "ios",
      osVersion: "27.2",
      state: "booted",
      ownership: "unknown",
    },
    {
      id: "UDID-2",
      name: "Fixture iPad",
      platform: "ios",
      osVersion: "26.4.1",
      state: "shutdown",
      ownership: "available",
    },
  ]);
});

test.each([
  { state: "Booted", isAvailable: true, expected: "booted", ownership: "unknown" },
  { state: "Shutdown", isAvailable: true, expected: "shutdown", ownership: "available" },
  { state: "Booting", isAvailable: true, expected: "booting", ownership: "unknown" },
  { state: "Creating", isAvailable: true, expected: "unavailable", ownership: "unknown" },
  { state: "Booted", isAvailable: false, expected: "unavailable", ownership: "unknown" },
  { state: "Shutdown", isAvailable: false, expected: "unavailable", ownership: "unknown" },
])("parseSimctlDevices maps state, availability and ownership: %j", (input) => {
  expect(parseSimctlDevices(deviceList(input.state, input.isAvailable))).toEqual([
    {
      id: UDID,
      name: "Fixture iPhone",
      platform: "ios",
      osVersion: "27.2",
      state: input.expected,
      ownership: input.ownership,
    },
  ]);
});

test.each(["not JSON", '{"devices":', '{"devices":[]}', '{"devices":{"runtime":[{}]}}'])(
  "parseSimctlDevices returns null for malformed output: %s",
  (output) => {
    expect(parseSimctlDevices(output)).toBeNull();
  },
);

test("an already booted simulator is not booted again or owned by this call", async () => {
  const fake = fakeRun([result({ stdout: deviceList("Booted") })]);
  await expect(ensureSimulatorBooted({}, UDID, true, fake.run)).resolves.toEqual({
    deviceId: UDID,
    bootedByUs: false,
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([LIST_ARGS]);
});

test("a shut down simulator requires explicit boot intent", async () => {
  const fake = fakeRun([result({ stdout: deviceList("Shutdown") })]);
  await expect(ensureSimulatorBooted({}, UDID, false, fake.run)).rejects.toMatchObject({
    data: { code: "not-found", mayHaveExecuted: false },
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([LIST_ARGS]);
});

test("boot intent boots the selected simulator and waits for bootstatus", async () => {
  const fake = fakeRun([result({ stdout: deviceList("Shutdown") }), result(), result()]);
  await expect(ensureSimulatorBooted({ timeoutMs: 123 }, UDID, true, fake.run)).resolves.toEqual({
    deviceId: UDID,
    bootedByUs: true,
  });
  expect(fake.commands).toEqual(
    [LIST_ARGS, ["simctl", "boot", UDID], ["simctl", "bootstatus", UDID, "-b"]].map((args) => ({
      command: "xcrun",
      args,
      timeoutMs: 123,
    })),
  );
});

test("a concurrent boot is tolerated without claiming simulator ownership", async () => {
  const fake = fakeRun([
    result({ stdout: deviceList("Shutdown") }),
    result({ code: 149, stderr: "Unable to boot device in current state: Booted" }),
    result(),
  ]);
  await expect(ensureSimulatorBooted({}, UDID, true, fake.run)).resolves.toEqual({
    deviceId: UDID,
    bootedByUs: false,
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([
    LIST_ARGS,
    ["simctl", "boot", UDID],
    ["simctl", "bootstatus", UDID, "-b"],
  ]);
  expect(fake.commands.map((spec) => spec.timeoutMs)).toEqual([20_000, 180_000, 180_000]);
});

test.each([0, 1])(
  "bootstatus failure rolls back our boot and preserves the error, shutdown exit=%s",
  async (shutdownCode) => {
    const fake = fakeRun([
      result({ stdout: deviceList("Shutdown") }),
      result(),
      result({ code: 1, stderr: "fixture bootstatus failure" }),
      result({ code: shutdownCode, stderr: "fixture shutdown failure" }),
    ]);
    await expect(ensureSimulatorBooted({}, UDID, true, fake.run)).rejects.toMatchObject({
      data: {
        code: "helper-failed",
        message: expect.stringContaining("fixture bootstatus failure"),
      },
    });
    expect(fake.commands.map((spec) => spec.args)).toEqual([
      LIST_ARGS,
      ["simctl", "boot", UDID],
      ["simctl", "bootstatus", UDID, "-b"],
      ["simctl", "shutdown", UDID],
    ]);
  },
);

test("bootstatus failure never shuts down a concurrently booted simulator", async () => {
  const fake = fakeRun([
    result({ stdout: deviceList("Shutdown") }),
    result({ code: 149, stderr: "Unable to boot device in current state: Booted" }),
    result({ code: 1, stderr: "fixture bootstatus failure" }),
  ]);
  await expect(ensureSimulatorBooted({}, UDID, true, fake.run)).rejects.toMatchObject({
    data: { code: "helper-failed" },
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([
    LIST_ARGS,
    ["simctl", "boot", UDID],
    ["simctl", "bootstatus", UDID, "-b"],
  ]);
});

test("a booting simulator waits without issuing boot or claiming ownership", async () => {
  const fake = fakeRun([result({ stdout: deviceList("Booting") }), result()]);
  await expect(ensureSimulatorBooted({}, UDID, false, fake.run)).resolves.toEqual({
    deviceId: UDID,
    bootedByUs: false,
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([
    LIST_ARGS,
    ["simctl", "bootstatus", UDID, "-b"],
  ]);
});

test("an unknown simulator is not found and no boot is attempted", async () => {
  const fake = fakeRun([result({ stdout: deviceList("Shutdown") })]);
  await expect(ensureSimulatorBooted({}, "UNKNOWN-UDID", true, fake.run)).rejects.toMatchObject({
    data: { code: "not-found", mayHaveExecuted: false },
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([LIST_ARGS]);
});

test("a missing xcrun during discovery reports a missing prerequisite", async () => {
  const fake = fakeRun([result({ code: null, spawnError: "spawn xcrun ENOENT" })]);
  await expect(ensureSimulatorBooted({}, UDID, true, fake.run)).rejects.toMatchObject({
    data: { code: "missing-prerequisite", mayHaveExecuted: false },
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([LIST_ARGS]);
});

test("shutdownSimulator accepts success and pins the command and timeout", async () => {
  const fake = fakeRun([result()]);
  await expect(shutdownSimulator({ timeoutMs: 123 }, UDID, fake.run)).resolves.toBeUndefined();
  expect(fake.commands).toEqual([
    { command: "xcrun", args: ["simctl", "shutdown", UDID], timeoutMs: 123 },
  ]);
});

test("shutdownSimulator tolerates an already shut down simulator", async () => {
  const fake = fakeRun([
    result({ code: 149, stderr: "Unable to shutdown device in current state: Shutdown" }),
  ]);
  await expect(shutdownSimulator({}, UDID, fake.run)).resolves.toBeUndefined();
  expect(fake.commands).toEqual([
    { command: "xcrun", args: ["simctl", "shutdown", UDID], timeoutMs: 60_000 },
  ]);
});

test("shutdownSimulator reports other failures as possibly executed", async () => {
  const fake = fakeRun([result({ code: 1, stderr: "fixture shutdown failure" })]);
  await expect(shutdownSimulator({}, UDID, fake.run)).rejects.toMatchObject({
    data: {
      code: "helper-failed",
      mayHaveExecuted: true,
      message: expect.stringContaining("fixture shutdown failure"),
    },
  });
  expect(fake.commands.map((spec) => spec.args)).toEqual([["simctl", "shutdown", UDID]]);
});
