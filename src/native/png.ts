// Read screenshot dimensions from the PNG signature and IHDR header, not from a guessed device profile.

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export interface PngDimensions {
  width: number;
  height: number;
}

// Return a PNG's pixel dimensions, or null when the bytes are not a PNG with a readable IHDR chunk.
export function readPngDimensions(bytes: Uint8Array): PngDimensions | null {
  if (bytes.length < 24) return null;
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  // The IHDR chunk follows the signature: 4-byte length, the "IHDR" type, then width and height as big-endian uint32s.
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}
