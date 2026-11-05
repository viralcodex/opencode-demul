export const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x29]);
export const pps = new Uint8Array([0, 0, 1, 0x68, 0xeb]);
export const idr = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
export const delta = new Uint8Array([0, 0, 1, 0x41, 0x99]);
export const keyframe = new Uint8Array([...sps, ...idr]);
export const startCode = Buffer.from([0, 0, 0, 1]);

export function avccRecord(tag: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength + 1);
  header[4] = tag;
  return Buffer.concat([header, payload]);
}

export function avccDescription(lengthBytes = 4): Buffer {
  return avccRecord(
    1,
    Buffer.concat([
      Buffer.from([1, 0x64, 0, 0x29, 0xfc | (lengthBytes - 1), 0xe1, 0, 4]),
      sps.subarray(4),
      Buffer.from([1, 0, 2]),
      pps.subarray(3),
    ]),
  );
}

export function avccSample(tag: number, nals: readonly Uint8Array[], lengthBytes = 4): Buffer {
  return avccRecord(
    tag,
    Buffer.concat(
      nals.flatMap((nal) => {
        const length = Buffer.alloc(lengthBytes);
        length.writeUIntBE(nal.byteLength, 0, lengthBytes);
        return [length, nal];
      }),
    ),
  );
}

export function metadataFrame(
  version: number,
  flags: number,
  pts: bigint,
  payload: Uint8Array,
  serverTimestamp = 0n,
): Uint8Array<ArrayBuffer> {
  const header = version === 2 ? 24 : 16;
  const data = new Uint8Array(header + payload.byteLength);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x53454d55);
  view.setUint8(4, version);
  view.setUint8(5, flags);
  view.setBigUint64(8, pts);
  if (version === 2) view.setBigUint64(16, serverTimestamp);
  data.set(payload, header);
  return data;
}
