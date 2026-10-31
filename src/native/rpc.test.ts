import { expect, test } from "bun:test";
import { Schema } from "effect";
import { Device } from "../rpc.js";
import { DeviceIpc } from "../ipc.js";

test("manual IPC preserves the video viewport and rejects invalid dimensions", () => {
  const codec = DeviceIpc.Bridge.spec.methods.manual.input;
  const input = {
    scope: { serverID: "local", sessionID: "ses_test" },
    operation: {
      type: "tap",
      handle: {
        token: "dh_123e4567-e89b-12d3-a456-426614174000",
        platform: "android",
        deviceId: "emulator-5554",
        generation: 1,
      },
      point: { x: 100, y: 200 },
      viewport: { width: 576, height: 1280 },
    },
  } as const;
  const decoded = Schema.decodeUnknownSync(codec)(input);
  expect(Schema.encodeSync(codec)(decoded)).toEqual(input);
  expect(
    Schema.decodeUnknownOption(codec)({
      ...input,
      operation: { ...input.operation, viewport: { width: 0, height: 1280 } },
    })._tag,
  ).toBe("None");
});

test("HandleToken accepts the dh_<uuid> form and rejects others", () => {
  const good = Schema.decodeUnknownOption(Device.HandleToken)(
    "dh_123e4567-e89b-12d3-a456-426614174000",
  );
  const bad = Schema.decodeUnknownOption(Device.HandleToken)("handle-1");
  expect(good._tag).toBe("Some");
  expect(bad._tag).toBe("None");
});

test("ElementRef accepts @eN and eN and rejects e0 or arbitrary text", () => {
  expect(Schema.decodeUnknownOption(Device.ElementRef)("@e2")._tag).toBe("Some");
  expect(Schema.decodeUnknownOption(Device.ElementRef)("e42")._tag).toBe("Some");
  expect(Schema.decodeUnknownOption(Device.ElementRef)("e0")._tag).toBe("None");
  expect(Schema.decodeUnknownOption(Device.ElementRef)("button")._tag).toBe("None");
});

test("Screenshot round-trips bytes through base64", () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const screenshot: Device.Screenshot = {
    data: bytes,
    width: 1,
    height: 1,
    deviceId: "emulator-5554",
    platform: "android",
  };
  const encoded = Schema.encodeSync(Device.Screenshot)(screenshot);
  const decoded = Schema.decodeUnknownSync(Device.Screenshot)(encoded);
  expect(Array.from(decoded.data)).toEqual(Array.from(bytes));
});

test("StreamDescriptor requires loopback true", () => {
  const base = {
    platform: "android" as const,
    deviceId: "emulator-5554",
    baseUrl: "http://127.0.0.1:3400",
    token: "abc",
    protocol: "h264" as const,
  };
  expect(
    Schema.decodeUnknownOption(Device.StreamDescriptor)({ ...base, loopback: true })._tag,
  ).toBe("Some");
  expect(
    Schema.decodeUnknownOption(Device.StreamDescriptor)({ ...base, loopback: false })._tag,
  ).toBe("None");
});

test("LogicalPoint rejects coordinates outside the logical range", () => {
  expect(Schema.decodeUnknownOption(Device.LogicalPoint)({ x: 0, y: 1000000 })._tag).toBe("Some");
  expect(Schema.decodeUnknownOption(Device.LogicalPoint)({ x: -1, y: 0 })._tag).toBe("None");
  expect(Schema.decodeUnknownOption(Device.LogicalPoint)({ x: 0, y: 1000001 })._tag).toBe("None");
});
