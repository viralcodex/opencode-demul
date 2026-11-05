import { describe, expect, test } from "bun:test";
import { AvccStream } from "./avcc.js";
import { parseFramePacket } from "./h264.js";
import {
  avccDescription as description,
  avccRecord as record,
  avccSample as sample,
  sps as annexSps,
  pps as annexPps,
  idr as annexIdr,
  delta as annexDelta,
  startCode as start,
} from "../test/video.js";

const sps = annexSps.subarray(4);
const pps = annexPps.subarray(3);
const idr = annexIdr.subarray(4);
const delta = annexDelta.subarray(3);

describe("iOS AVCC normalization", () => {
  test.each([1, 2, 4])(
    "converts %i-byte NAL lengths and preserves keyframe parameter sets",
    (lengthBytes) => {
      const stream = new AvccStream();
      const frames = stream.push(
        Buffer.concat([
          record(4, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
          description(lengthBytes),
          sample(2, [idr], lengthBytes),
          sample(3, [delta, delta], lengthBytes),
        ]),
      );
      expect(frames).toEqual([
        { key: true, bytes: Buffer.concat([start, sps, start, pps, start, idr]) },
        { key: false, bytes: Buffer.concat([start, delta, start, delta]) },
      ]);
      expect(parseFramePacket(frames[0].bytes)).toMatchObject({ key: true, codec: "avc1.640029" });
      stream.finish();
    },
  );

  test("handles every split point and byte-at-a-time delivery", () => {
    const bytes = Buffer.concat([description(), sample(2, [idr]), sample(3, [delta])]);
    const expected = new AvccStream().push(bytes);
    for (let offset = 0; offset <= bytes.length; offset++) {
      const stream = new AvccStream();
      expect([
        ...stream.push(bytes.subarray(0, offset)),
        ...stream.push(bytes.subarray(offset)),
      ]).toEqual(expected);
      stream.finish();
    }
    const stream = new AvccStream();
    expect([...bytes].flatMap((byte) => stream.push(Buffer.from([byte])))).toEqual(expected);
    stream.finish();
  });

  test("waits for configuration and a keyframe, including after configuration changes", () => {
    const stream = new AvccStream();
    expect(stream.push(sample(2, [idr]))).toEqual([]);
    expect(stream.push(Buffer.concat([description(), sample(3, [delta])]))).toEqual([]);
    expect(stream.push(sample(2, [idr]))).toHaveLength(1);
    expect(stream.push(Buffer.concat([description(2), sample(3, [delta], 2)]))).toEqual([]);
    expect(stream.push(sample(2, [idr], 2))).toHaveLength(1);
  });

  test("does not mutate frames after processing more records", () => {
    const stream = new AvccStream();
    const frame = stream.push(Buffer.concat([description(), sample(2, [idr])]))[0];
    const original = Buffer.from(frame.bytes);
    stream.push(sample(3, [Buffer.alloc(100_000, 0x41)]));
    expect(frame.bytes).toEqual(original);
  });

  test.each([0, 8 * 1024 * 1024 + 1, 0xffffffff])(
    "rejects record size %i before allocating its payload",
    (size) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(size);
      expect(() => new AvccStream().push(header)).toThrow("record size");
    },
  );

  test.each([
    Buffer.alloc(0),
    Buffer.from([1, 0x64, 0, 0x29, 0xfe, 0xe1, 0]),
    Buffer.from([1, 0x64, 0, 0x29, 0xff, 0xe1, 0, 255]),
    Buffer.from([1, 0x64, 0, 0x29, 0xff, 0xe0, 0]),
  ])("rejects malformed decoder descriptions", (data) => {
    expect(() => new AvccStream().push(record(1, data))).toThrow("iOS H.264");
  });

  test.each([
    Buffer.alloc(0),
    Buffer.from([0, 0]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 5, 0x65]),
  ])("rejects malformed sample NAL units", (data) => {
    const stream = new AvccStream();
    stream.push(description());
    expect(() => stream.push(record(2, data))).toThrow("iOS H.264");
  });

  test("bounds the number of NAL units and rejects unknown tags", () => {
    const stream = new AvccStream();
    stream.push(description());
    expect(() =>
      stream.push(
        sample(
          2,
          Array.from({ length: 4_097 }, () => idr),
        ),
      ),
    ).toThrow("Too many");
    expect(() => new AvccStream().push(record(9, Buffer.alloc(0)))).toThrow("record type");
  });

  test.each([Buffer.from([0, 0]), Buffer.from([0, 0, 0, 5, 1])])(
    "detects truncated records at EOF",
    (data) => {
      const stream = new AvccStream();
      stream.push(data);
      expect(() => stream.finish()).toThrow("Truncated");
    },
  );
});
