// A pure PNG header reader. The automation engine writes a screenshot to a file; the runtime reads its real width and
// height from the image itself rather than guessing from a device profile, so the {@link Device.Screenshot} dimensions
// match the bytes. Only the 8-byte signature and the IHDR chunk are needed, which are always first in a PNG.

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export interface PngDimensions {
  width: number;
  height: number;
}

// Return a PNG's pixel dimensions, or null when the bytes are not a PNG with a readable IHDR chunk.
export function readPngDimensions(bytes: Uint8Array): PngDimensions | null {
  if (bytes.length < 24) return null;
  for (let index = 0; index < SIGNATURE.length; index++) {
    if (bytes[index] !== SIGNATURE[index]) return null;
  }
  // The IHDR chunk follows the signature: 4-byte length, the "IHDR" type, then width and height as big-endian uint32s.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
    return null;
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
