// serve-sim sends length-prefixed records: description=1, keyframe=2, delta=3, JPEG seed=4.
// Convert AVCC NAL lengths to Annex-B start codes without decoding or re-encoding video.
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_NALS = 4_096;
const START_CODE = Buffer.from([0, 0, 0, 1]);

export interface AvccFrame {
  readonly bytes: Buffer;
  readonly key: boolean;
}

interface Configuration {
  readonly lengthBytes: number;
  readonly parameters: Buffer;
}

export class AvccStream {
  private readonly header = Buffer.alloc(4);
  private headerBytes = 0;
  private record: Buffer | undefined;
  private recordBytes = 0;
  private configuration: Configuration | undefined;
  private waitingKeyframe = true;

  push(chunk: Uint8Array): AvccFrame[] {
    const frames: AvccFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.record) {
        offset += this.readHeader(chunk.subarray(offset));
        if (!this.record) continue;
      }
      const count = Math.min(this.record.length - this.recordBytes, chunk.byteLength - offset);
      this.record.set(chunk.subarray(offset, offset + count), this.recordBytes);
      this.recordBytes += count;
      offset += count;
      if (this.recordBytes !== this.record.length) continue;
      const record = this.record;
      this.record = undefined;
      this.recordBytes = 0;
      const frame = this.convert(record);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  finish(): void {
    if (this.headerBytes || this.record) throw new Error("Truncated iOS H.264 record");
  }

  private readHeader(chunk: Uint8Array): number {
    const count = Math.min(4 - this.headerBytes, chunk.byteLength);
    this.header.set(chunk.subarray(0, count), this.headerBytes);
    this.headerBytes += count;
    if (this.headerBytes !== 4) return count;
    const length = this.header.readUInt32BE(0);
    if (length < 1 || length > MAX_RECORD_BYTES) throw new Error("Invalid iOS H.264 record size");
    this.record = Buffer.allocUnsafe(length);
    this.headerBytes = 0;
    return count;
  }

  private convert(record: Buffer): AvccFrame | undefined {
    const tag = record[0];
    const payload = record.subarray(1);
    if (tag === 4) return;
    if (tag === 1) {
      this.configuration = parseConfiguration(payload);
      this.waitingKeyframe = true;
      return;
    }
    if (tag !== 2 && tag !== 3) throw new Error("Invalid iOS H.264 record type");
    if (!this.configuration || (this.waitingKeyframe && tag !== 2)) return;
    const key = tag === 2;
    const bytes = annexB(payload, this.configuration, key);
    this.waitingKeyframe = false;
    return { bytes, key };
  }
}

function parseConfiguration(data: Buffer): Configuration {
  if (data.length < 7 || data[0] !== 1) throw new Error("Invalid iOS H.264 configuration");
  const lengthBytes = (data[4] & 3) + 1;
  if (lengthBytes === 3) throw new Error("Invalid iOS H.264 NAL length size");
  const sps = parameterSets(data, 6, data[5] & 31, 7);
  const pps = parameterSets(data, sps.offset + 1, data[sps.offset] ?? 0, 8);
  if (!sps.parts.length || !pps.parts.length) throw new Error("Missing iOS H.264 parameter sets");
  return { lengthBytes, parameters: Buffer.concat([...sps.parts, ...pps.parts]) };
}

function parameterSets(data: Buffer, start: number, count: number, type: number) {
  const parts: Buffer[] = [];
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 2 > data.length) throw new Error("Truncated iOS H.264 parameter set");
    const length = data.readUInt16BE(offset);
    offset += 2;
    if (!length || offset + length > data.length || (data[offset] & 31) !== type)
      throw new Error("Invalid iOS H.264 parameter set");
    parts.push(START_CODE, data.subarray(offset, offset + length));
    offset += length;
  }
  return { parts, offset };
}

function annexB(data: Buffer, configuration: Configuration, key: boolean): Buffer {
  const parts: Buffer[] = key ? [configuration.parameters] : [];
  let offset = 0;
  let count = 0;
  while (offset < data.length) {
    if (++count > MAX_NALS) throw new Error("Too many iOS H.264 NAL units");
    if (offset + configuration.lengthBytes > data.length)
      throw new Error("Truncated iOS H.264 NAL length");
    const length = data.readUIntBE(offset, configuration.lengthBytes);
    offset += configuration.lengthBytes;
    if (!length || offset + length > data.length) throw new Error("Invalid iOS H.264 NAL size");
    parts.push(START_CODE, data.subarray(offset, offset + length));
    offset += length;
  }
  if (!data.length) throw new Error("Empty iOS H.264 frame");
  return Buffer.concat(parts);
}
