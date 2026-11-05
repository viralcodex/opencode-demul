import { expect, test } from "bun:test";
import { H264Configuration, parseFramePacket } from "./h264.js";
import { sps, pps, idr, delta, keyframe, metadataFrame } from "../test/video.js";

test.each([sps, pps, new Uint8Array([...sps, ...pps])])(
  "parameter sets are not keyframes or pictures",
  (data) => {
    expect(parseFramePacket(data)).toMatchObject({ key: false, picture: false });
  },
);

test("an SPS before a delta does not turn the delta into a keyframe", () => {
  expect(parseFramePacket(new Uint8Array([...sps, ...delta]))).toMatchObject({
    key: false,
    picture: true,
    codec: "avc1.640029",
  });
});

test("an IDR is detected independently of SPS ordering and start-code length", () => {
  for (const data of [
    idr,
    new Uint8Array([...sps, ...pps, ...idr]),
    new Uint8Array([...idr, ...sps]),
  ])
    expect(parseFramePacket(data)).toMatchObject({ key: true, picture: true });
});

test("codec detection reads an SPS across mixed start-code boundaries", () => {
  expect(parseFramePacket(new Uint8Array([0, ...pps, ...sps.subarray(1), ...idr]))).toMatchObject({
    codec: "avc1.640029",
  });
});

test("a metadata key flag never turns configuration-only data into a picture", () => {
  const data = metadataFrame(1, 1, 0n, sps);
  expect(parseFramePacket(data)).toMatchObject({ key: false, picture: false });
});

test("typed-array views exclude bytes outside their byte offset and length", () => {
  const pooled = new Uint8Array(100);
  pooled.set(new Uint8Array([...sps, ...idr]), 11);
  const view = pooled.subarray(11, 11 + sps.byteLength + idr.byteLength);
  expect(parseFramePacket(view)).toMatchObject({ bytes: view, key: true, codec: "avc1.640029" });
});

test("separate parameter sets are copied and prepended to an IDR, never to a delta", () => {
  const configuration = new H264Configuration();
  const mutable = sps.slice();
  configuration.update(parseFramePacket(mutable)!);
  configuration.update(parseFramePacket(pps)!);
  mutable.fill(0);
  expect(configuration.codec).toBe("avc1.640029");
  expect(configuration.bytes(parseFramePacket(idr)!)).toEqual(
    new Uint8Array([...sps, 0, 0, 0, 1, 0x68, 0xeb, ...idr]),
  );
  const packet = parseFramePacket(delta)!;
  expect(configuration.bytes(packet)).toBe(packet.bytes);
  const complete = parseFramePacket(new Uint8Array([...sps, ...pps, ...idr]))!;
  expect(configuration.bytes(complete)).toBe(complete.bytes);
  configuration.clear();
  expect(configuration.codec).toBeUndefined();
  const bare = parseFramePacket(idr)!;
  expect(configuration.bytes(bare)).toBe(bare.bytes);
});

test("raw Annex-B packets use a local timestamp", () => {
  const packet = parseFramePacket(keyframe.buffer)!;
  expect(packet.bytes).toEqual(keyframe);
  expect(packet.key).toBe(true);
  expect(packet.timestamp).toBeGreaterThan(0);
});

test.each([1, 2])("SEMU v%i preserves timestamps and excludes its metadata header", (version) => {
  const data = metadataFrame(version, 0, 123_456n, keyframe, 1_735_689_600_123_000n);
  expect(parseFramePacket(data.buffer)).toEqual({
    bytes: keyframe,
    key: true,
    picture: true,
    codec: "avc1.640029",
    sps: sps.subarray(4),
    pps: undefined,
    timestamp: 123_456,
    serverTimestamp: version === 2 ? 1_735_689_600_123 : undefined,
  });
});

test.each([
  new Uint8Array(),
  new Uint8Array([0, 0, 0, 1]),
  metadataFrame(3, 0, 1n, keyframe),
  metadataFrame(2, 0, 1n, new Uint8Array()),
  metadataFrame(1, 0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, keyframe),
  new Uint8Array([0x53, 0x45, 0x4d, 0x55, 1]),
])("rejects malformed framing", (data) => {
  expect(parseFramePacket(data.buffer)).toBeUndefined();
});
