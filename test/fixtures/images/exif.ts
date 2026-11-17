/**
 * Just enough TIFF/EXIF parsing to answer one question: **are there GPS tags in these bytes?**
 *
 * The tests use it on the input as well as the output. Asserting "no GPS in the variant" is worthless unless the
 * input is known to have had some, and `exif-gps.jpg` is also uploaded raw by `scripts/smoke.sh`, so the same
 * check guards the fixture itself.
 */

export type GpsTags = {
  /** The EXIF GPS tag numbers present, e.g. 1 = GPSLatitudeRef, 2 = GPSLatitude, 3/4 = longitude. */
  tags: number[];
  /** Decoded degrees, when latitude and longitude are both present and readable. */
  latitude?: number;
  longitude?: number;
};

/** EXIF in a JPEG APP1 segment is prefixed `Exif\0\0`; sharp's `metadata().exif` keeps that prefix. */
const tiffStart = (buf: Buffer): number => (buf.length >= 6 && buf.toString("latin1", 0, 6) === "Exif\u0000\u0000" ? 6 : 0);

/** Reads the GPS IFD out of an EXIF block, or null when there is no EXIF, no GPS pointer or unreadable bytes. */
export function readGps(exif: Buffer | undefined): GpsTags | null {
  if (!exif || exif.length < 16) return null;
  try {
    const base = tiffStart(exif);
    const byteOrder = exif.toString("latin1", base, base + 2);
    if (byteOrder !== "II" && byteOrder !== "MM") return null;
    const le = byteOrder === "II";
    const u16 = (o: number) => (le ? exif.readUInt16LE(o) : exif.readUInt16BE(o));
    const u32 = (o: number) => (le ? exif.readUInt32LE(o) : exif.readUInt32BE(o));

    const ifd0 = base + u32(base + 4);
    let gpsOffset = 0;
    const entries = u16(ifd0);
    for (let i = 0; i < entries; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) === 0x8825) gpsOffset = base + u32(entry + 8); // GPSInfoIFDPointer
    }
    if (!gpsOffset) return null;

    const gpsEntries = u16(gpsOffset);
    const tags: number[] = [];
    const values = new Map<number, number[]>();
    const refs = new Map<number, string>();
    for (let i = 0; i < gpsEntries; i++) {
      const entry = gpsOffset + 2 + i * 12;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      tags.push(tag);
      if (type === 5 && count === 3) {
        // RATIONAL[3]: 24 bytes, so always stored out of line
        const at = base + u32(entry + 8);
        values.set(tag, [0, 1, 2].map((n) => u32(at + n * 8) / (u32(at + n * 8 + 4) || 1)));
      } else if (type === 2 && count <= 4) {
        refs.set(tag, exif.toString("latin1", entry + 8, entry + 8 + count).replace(/\0/g, ""));
      }
    }

    const dms = (v?: number[]) => (v ? v[0] + v[1] / 60 + v[2] / 3600 : undefined);
    const lat = dms(values.get(2));
    const lng = dms(values.get(4));
    return {
      tags,
      latitude: lat === undefined ? undefined : refs.get(1) === "S" ? -lat : lat,
      longitude: lng === undefined ? undefined : refs.get(3) === "W" ? -lng : lng,
    };
  } catch {
    return null;
  }
}

/** The RIFF chunk ids in a WebP file, in order: `['VP8 ']` for a plain lossy image, plus `EXIF`/`XMP `/`ICCP` if any. */
export function riffChunkIds(buf: Buffer): string[] {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("not a WebP file");
  }
  const ids: string[] = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("latin1", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    ids.push(id);
    offset += 8 + size + (size % 2); // chunks are padded to an even length
    if (size === 0 && id.trim() === "") break;
  }
  return ids;
}
