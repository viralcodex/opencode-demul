export interface FramePacket {
  readonly bytes: Uint8Array;
  readonly key: boolean;
  readonly picture: boolean;
  readonly codec?: string;
  readonly sps?: Uint8Array;
  readonly pps?: Uint8Array;
  readonly timestamp: number;
  readonly serverTimestamp?: number;
}

const MAGIC = 0x53454d55;
const FRAME_HEADERS: Readonly<Record<number, number | undefined>> = { 1: 16, 2: 24 };
const START_CODE = new Uint8Array([0, 0, 0, 1]);

// Accept typed-array views as well as browser ArrayBuffers without copying pooled Node buffers.
export function parseFramePacket(input: ArrayBuffer | Uint8Array): FramePacket | undefined {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (data.byteLength < 4) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0) === MAGIC) return metadataFrame(data, view);
  return videoFrame(data, performance.now() * 1_000, false);
}

function metadataFrame(data: Uint8Array, view: DataView): FramePacket | undefined {
  if (data.byteLength < 16) return;
  const header = FRAME_HEADERS[view.getUint8(4)];
  if (!header || data.byteLength <= header) return;
  const pts = view.getBigUint64(8);
  if (pts > BigInt(Number.MAX_SAFE_INTEGER)) return;
  return videoFrame(
    data.subarray(header),
    Number(pts),
    (view.getUint8(5) & 1) === 1,
    header === 24 ? Number(view.getBigUint64(16)) / 1_000 : undefined,
  );
}

function videoFrame(
  bytes: Uint8Array,
  timestamp: number,
  key: boolean,
  serverTimestamp?: number,
): FramePacket | undefined {
  const start = nalStart(bytes, 0);
  if (start === undefined || start >= bytes.byteLength) return;
  const info = annexBInfo(bytes);
  return { bytes, ...info, key: info.key || (info.picture && key), timestamp, serverTimestamp };
}

function annexBInfo(data: Uint8Array) {
  let key = false;
  let picture = false;
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  for (const nal of nals(data)) {
    const type = nal[0] & 31;
    if (type === 5) key = true;
    if (type >= 1 && type <= 5) picture = true;
    if (type === 7) sps = nal;
    if (type === 8) pps = nal;
  }
  return { key, picture, codec: sps && spsCodec(sps), sps, pps };
}

// Yield NAL bodies, excluding either form of Annex-B start code.
function* nals(data: Uint8Array): Generator<Uint8Array> {
  let start = nalStart(data, 0);
  if (start === undefined) return;
  for (let index = start; index < data.byteLength - 2; index++) {
    const next = nalStart(data, index);
    if (next === undefined) continue;
    if (index > start) yield data.subarray(start, index);
    start = next;
    index = next - 1;
  }
  if (start < data.byteLength) yield data.subarray(start);
}

function nalStart(data: Uint8Array, index: number): number | undefined {
  if (data[index] !== 0 || data[index + 1] !== 0) return;
  if (data[index + 2] === 1) return index + 3;
  if (data[index + 2] === 0 && data[index + 3] === 1) return index + 4;
}

function spsCodec(sps: Uint8Array): string | undefined {
  if (sps.byteLength < 4) return;
  return `avc1.${[sps[1], sps[2], sps[3]].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class H264Configuration {
  codec: string | undefined;
  private sps: Uint8Array | undefined;
  private pps: Uint8Array | undefined;

  update(frame: FramePacket): void {
    if (frame.sps) {
      this.sps = frame.sps.slice();
      this.codec = frame.codec;
    }
    if (frame.pps) this.pps = frame.pps.slice();
  }

  // Android may send parameter sets separately. Supply them with the IDR, never as a fake keyframe.
  bytes(frame: FramePacket): Uint8Array {
    if (!frame.key) return frame.bytes;
    const parts: Uint8Array[] = [];
    if (!frame.sps && this.sps) parts.push(START_CODE, this.sps);
    if (!frame.pps && this.pps) parts.push(START_CODE, this.pps);
    if (!parts.length) return frame.bytes;
    parts.push(frame.bytes);
    const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  clear(): void {
    this.codec = undefined;
    this.sps = undefined;
    this.pps = undefined;
  }
}
