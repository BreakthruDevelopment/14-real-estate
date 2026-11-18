/** Content types `matchesMagic` can verify. Add a case here to accept another type. */
export type MagicType = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * True when the bytes really are the type the client claimed. Never trust a Content-Type header or a file
 * extension; call this on the uploaded bytes before storing or parsing them.
 */
/** ISO base media `ftyp` brands of HEIC and HEIF stills (and their sequences). */
const HEIF_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"];

/** `????ftyp<brand>`: the box size is free, then `ftyp`, then a major brand that has to be a HEIF one. */
function isHeif(b: Uint8Array): boolean {
  if (!startsWith(b, [0x66, 0x74, 0x79, 0x70], 4) || b.length < 12) return false; // "ftyp" at offset 4
  return HEIF_BRANDS.includes(Buffer.from(b.subarray(8, 12)).toString("latin1"));
}

export function matchesMagic(type: MagicType, bytes: Uint8Array): boolean {
  switch (type) {
    case "application/pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      // RIFF <size> WEBP
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
    case "image/heic":
    case "image/heif":
      return isHeif(bytes);
    default:
      return false;
  }
}
