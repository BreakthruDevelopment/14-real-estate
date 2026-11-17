/**
 * Deterministic image fixtures for `src/lib/images/process.ts`.
 *
 * Every byte here comes from this file, so anyone can regenerate the set:
 *
 *     pnpm fixtures:images
 *
 * Two groups:
 *
 * - **Committed** (`test/fixtures/images/*`): small files the tests and `scripts/smoke.sh` read directly.
 *   `exif-gps.jpg` is uploaded **raw** by the smoke test, so it must really carry GPS EXIF; `assertHasGps()`
 *   in the tests checks the input before any test claims the output is clean. Stripping GPS while building the
 *   fixture would make the "no GPS in the output" test pass against an input that never had any.
 * - **Generated** (`test/fixtures/images/generated/*`, git-ignored): the 2048 x 2048 worst-allowed-input files.
 *   Together they are ~14 MB, which would otherwise sit in every clone and in the Docker build context
 *   (there is no `.dockerignore`, so `COPY . .` in the build stage would carry them into the image build).
 *   `ensureLargeFixtures()` writes them on first use and the files are then cached on disk.
 *
 * The sizes are not incidental. Each file has a `band` below and `writeAll()` fails if a file lands outside it,
 * so a future libvips upgrade that shifts compression cannot quietly turn a test into one that proves nothing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import sharp from "sharp";

export const FIXTURE_DIR = path.join(process.cwd(), "test/fixtures/images");
export const GENERATED_DIR = path.join(FIXTURE_DIR, "generated");

const KB = 1024;
const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Deterministic pixel sources
// ---------------------------------------------------------------------------

/** mulberry32: a tiny PRNG, so the same seed gives the same bytes on every machine and every Node version. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Blocky RGB noise. `block` is the size of a constant-colour cell: bigger cells compress better. */
function blockNoise(w: number, h: number, seed: number, block: number): Buffer {
  const out = Buffer.alloc(w * h * 3);
  const r = rng(seed);
  const bw = Math.ceil(w / block);
  const cells = Buffer.alloc(bw * Math.ceil(h / block) * 3);
  for (let i = 0; i < cells.length; i++) cells[i] = Math.floor(r() * 256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = (Math.floor(y / block) * bw + Math.floor(x / block)) * 3;
      const pi = (y * w + x) * 3;
      out[pi] = cells[ci];
      out[pi + 1] = cells[ci + 1];
      out[pi + 2] = cells[ci + 2];
    }
  }
  return out;
}

/** Smooth waves plus film grain of amplitude `amp`. `amp` is the single knob that sets how well WebP compresses it. */
function grain(w: number, h: number, seed: number, amp: number): Buffer {
  const out = Buffer.alloc(w * h * 3);
  const r = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const base = [
        128 + 100 * Math.sin(x / 90) * Math.cos(y / 70),
        120 + 90 * Math.sin((x + y) / 60),
        140 + 80 * Math.cos(x / 50),
      ];
      for (let c = 0; c < 3; c++) {
        const v = base[c] + (r() * 2 - 1) * amp;
        out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/** Four solid quadrants, so a test can tell which way up an image came out. */
function quadrants(w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const c = QUADRANTS[(y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)];
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
    }
  }
  return out;
}

/** Quadrant colours of the **upright** picture, clockwise from the top left. Far apart so lossy encoding can't blur one into another. */
export const QUADRANTS = [
  [220, 30, 30], // top-left: red
  [30, 190, 60], // top-right: green
  [30, 70, 220], // bottom-left: blue
  [240, 215, 40], // bottom-right: yellow
] as const;

const raw = (buf: Buffer, width: number, height: number, channels: 3 | 4 = 3) =>
  sharp(buf, { raw: { width, height, channels } });

// ---------------------------------------------------------------------------
// A PNG with a real IHDR and pixel data that cannot be decoded
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/**
 * A PNG whose IHDR honestly declares `w` x `h` but whose IDAT holds 16 zero bytes: far too little data for the
 * declared size, so **any attempt to decode it fails**. That is the point. A pixel-limit check that reads only the
 * header answers `too_many_pixels`; code that decoded first could only ever answer `decode_failed`. The fixture
 * therefore distinguishes the two by construction, with no timing or memory heuristics.
 */
export function pngHeaderOnly(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// An animated WebP, assembled as RIFF chunks
// ---------------------------------------------------------------------------

const u24 = (n: number): Buffer => {
  const b = Buffer.alloc(3);
  b.writeUIntLE(n, 0, 3);
  return b;
};

const riffChunk = (id: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(payload.length, 4);
  // Chunks are padded to an even length.
  return Buffer.concat(payload.length % 2 ? [header, payload, Buffer.alloc(1)] : [header, payload]);
};

/**
 * An animated WebP: a `VP8X` header with the animation flag, an `ANIM` chunk and one `ANMF` frame per colour,
 * each wrapping the `VP8` bitstream out of a normal still that sharp encodes. sharp cannot write an animation
 * from synthesised frames, and this is a container question rather than a codec one, so the container is built
 * here and the frames come from the encoder.
 */
async function animatedWebp(w: number, h: number, colours: string[]): Promise<Buffer> {
  const frames = await Promise.all(
    colours.map(async (background) => {
      const still = await sharp({ create: { width: w, height: h, channels: 3, background } })
        .webp({ quality: 70 })
        .toBuffer();
      return still.subarray(12); // drop `RIFF<size>WEBP`, keep the VP8 chunk and its header
    }),
  );
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    riffChunk("VP8X", Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(w - 1), u24(h - 1)])),
    riffChunk("ANIM", Buffer.from([0, 0, 0, 0, 0, 0])), // transparent background, loop forever
    ...frames.map((frame) =>
      riffChunk("ANMF", Buffer.concat([u24(0), u24(0), u24(w - 1), u24(h - 1), u24(100), Buffer.from([0]), frame])),
    ),
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), size, body]);
}

// ---------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------

type Spec = {
  name: string;
  large?: true;
  /** Inclusive byte range this file must land in. A file outside its band fails `writeAll()`. */
  band: [number, number];
  why: string;
  build: () => Promise<Buffer> | Buffer;
};

/**
 * GPS for 30 15' 30" N, 97 44' 24" W (Austin, Texas) plus a camera make and model: exactly the metadata a
 * phone writes into a photo taken at a property, which is the leak this module exists to stop.
 */
const GPS_EXIF = {
  IFD0: { Make: "BreakthruFixture", Model: "FixtureCam 1", Software: "make-image-fixtures" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "30/1 15/1 3000/100",
    GPSLongitudeRef: "W",
    GPSLongitude: "97/1 44/1 2400/100",
    GPSAltitudeRef: "0",
    GPSAltitude: "149/1",
  },
} as const;

export const SPECS: Spec[] = [
  {
    name: "exif-gps.jpg",
    band: [20 * KB, 400 * KB],
    why: "1024x768 (within the 2048 limit) carrying GPS EXIF; scripts/smoke.sh uploads this file raw",
    build: () =>
      raw(grain(1024, 768, 3, 18), 1024, 768)
        .jpeg({ quality: 86 })
        .withExif({ ...GPS_EXIF })
        .toBuffer(),
  },
  {
    name: "orientation-6.jpg",
    band: [1 * KB, 200 * KB],
    why: "stored 480x320 with EXIF orientation 6; upright it is 320x480 with red/green/blue/yellow quadrants",
    build: async () => {
      // Build the picture the right way up, then store it turned a quarter turn anticlockwise and tag it
      // orientation 6 ("rotate 90 clockwise to display"). Undoing that tag must reproduce the upright picture.
      const upright = quadrants(320, 480);
      return raw(upright, 320, 480)
        .rotate(270)
        .jpeg({ quality: 96, chromaSubsampling: "4:4:4" })
        .withMetadata({ orientation: 6 })
        .toBuffer();
    },
  },
  {
    name: "photo.png",
    band: [1 * KB, 900 * KB],
    why: "an ordinary PNG with an alpha channel, for the happy path",
    build: () => {
      // Smooth and posterised to 16 levels a channel: PNG stores pixels verbatim, and this file is committed.
      const rgb = grain(800, 600, 5, 0);
      for (let i = 0; i < rgb.length; i++) rgb[i] &= 0xf0;
      const rgba = Buffer.alloc(800 * 600 * 4);
      for (let y = 0; y < 600; y++) {
        for (let x = 0; x < 800; x++) {
          const p = y * 800 + x;
          rgba[p * 4] = rgb[p * 3];
          rgba[p * 4 + 1] = rgb[p * 3 + 1];
          rgba[p * 4 + 2] = rgb[p * 3 + 2];
          rgba[p * 4 + 3] = 160 + Math.round((95 * y) / 599); // a real alpha channel, never fully transparent
        }
      }
      return raw(rgba, 800, 600, 4).png({ compressionLevel: 9 }).toBuffer();
    },
  },
  {
    name: "photo.webp",
    band: [1 * KB, 400 * KB],
    why: "an ordinary WebP, for the happy path",
    build: () => raw(grain(800, 600, 6, 12), 800, 600).webp({ quality: 80 }).toBuffer(),
  },
  {
    name: "small-320x240.jpg",
    band: [512, 120 * KB],
    why: "smaller than every variant, so it proves nothing is ever upscaled",
    build: () => raw(grain(320, 240, 8, 14), 320, 240).jpeg({ quality: 90 }).toBuffer(),
  },
  {
    name: "oversize-2049x2048.png",
    band: [1 * KB, 200 * KB],
    why: "2049x2048 = 4,196,352 pixels, 2,048 over the limit; a complete, decodable PNG so nothing but the pixel count can explain the rejection",
    build: () =>
      sharp({ create: { width: 2049, height: 2048, channels: 3, background: { r: 40, g: 90, b: 140 } } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
  },
  {
    name: "bomb-20000x20000.png",
    band: [32, 1 * KB],
    why: "400,000,000 pixels declared in the IHDR with undecodable pixel data: rejecting it as too_many_pixels can only happen before a decode",
    build: () => pngHeaderOnly(20000, 20000),
  },
  {
    name: "truncated.jpg",
    band: [512, 200 * KB],
    why: "the first 45% of a valid JPEG: the header parses, the scan does not",
    build: async () => {
      const whole = await raw(grain(900, 600, 9, 16), 900, 600).jpeg({ quality: 88 }).toBuffer();
      return whole.subarray(0, Math.floor(whole.length * 0.45));
    },
  },
  {
    name: "animated.webp",
    band: [512, 16 * KB],
    why: "a real three-frame animated WebP: libvips reads only frame 1 unless asked otherwise, so an animation would be stored as a silent crop of itself",
    build: () => animatedWebp(600, 400, ["#aa3333", "#3333aa", "#33aa33"]),
  },
  {
    name: "tiny.gif",
    band: [16, 1 * KB],
    why: "GIF is not an accepted type (libvips would happily read it, so the module has to refuse it itself)",
    build: () => Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  },
  {
    name: "document.pdf",
    band: [128, 2 * KB],
    why: "libvips lists a pdf loader (poppler), disabled in this build but not necessarily in the next one; the module must refuse a PDF on its own rather than on libvips' say-so",
    build: () =>
      Buffer.from(
        "%PDF-1.4\n" +
          "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
          "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
          "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n" +
          "trailer<</Root 1 0 R>>\n" +
          "%%EOF\n",
      ),
  },
  {
    name: "vector.svg",
    band: [64, 2 * KB],
    why: "SVG is not an accepted type: it is a document, libvips renders it, and it can reference the network",
    build: () =>
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">\n' +
          '  <rect width="640" height="480" fill="#1d4ed8"/>\n' +
          '  <circle cx="320" cy="240" r="120" fill="#fbbf24"/>\n' +
          "</svg>\n",
      ),
  },

  // ---- Large: the worst inputs the module is allowed to accept (body cap 4 MB, 2048 x 2048). ----
  {
    name: "noisy-2048.png",
    large: true,
    band: [3 * MB, 4 * MB],
    why: "2048x2048 RGBA blocky noise just under the 4 MB body cap: the worst allowed PNG (16.8 MB decoded, four channels), and the lg variant stays over 400 KB at every quality on the ladder",
    build: () => {
      // Noisy colour with a smooth alpha ramp. Four channels is what makes this the worst case for memory, and a
      // smooth alpha keeps the *file* under the 4 MB body cap while the *decode* is still 2048 x 2048 x 4.
      const rgb = blockNoise(2048, 2048, 7, 2);
      const rgba = Buffer.alloc(2048 * 2048 * 4);
      for (let y = 0; y < 2048; y++) {
        for (let x = 0; x < 2048; x++) {
          const p = y * 2048 + x;
          rgba[p * 4] = rgb[p * 3];
          rgba[p * 4 + 1] = rgb[p * 3 + 1];
          rgba[p * 4 + 2] = rgb[p * 3 + 2];
          rgba[p * 4 + 3] = 128 + Math.round((127 * y) / 2047);
        }
      }
      return raw(rgba, 2048, 2048, 4).png({ compressionLevel: 9 }).toBuffer();
    },
  },
  {
    name: "q100-2048.jpg",
    large: true,
    band: [3 * MB, 4 * MB],
    why: "2048x2048 JPEG at quality 100, still under the 4 MB body cap: the worst allowed JPEG",
    build: () => raw(grain(2048, 2048, 13, 22), 2048, 2048).jpeg({ quality: 100 }).toBuffer(),
  },
  {
    name: "big-2048.webp",
    large: true,
    band: [3 * MB, 4 * MB],
    why: "a WebP close to the 4 MB body cap: the worst allowed WebP",
    build: () => raw(blockNoise(2048, 2048, 17, 2), 2048, 2048).webp({ lossless: true, effort: 1 }).toBuffer(),
  },
  {
    name: "grainy-2048.jpg",
    large: true,
    band: [2 * MB, 3 * MB],
    why: "grain tuned so the lg variant is ~467 KB at q75 (over the 400 KB cap) and ~358 KB at q55 (under it): the re-encode ladder has to run and then succeed",
    build: () => raw(grain(2048, 2048, 11, 64), 2048, 2048).jpeg({ quality: 88 }).toBuffer(),
  },
];

export const fixturePath = (name: string): string =>
  path.join(SPECS.find((s) => s.name === name)?.large ? GENERATED_DIR : FIXTURE_DIR, name);

/** Reads a fixture. Call `ensureLargeFixtures()` first for anything in `generated/`. */
export const readFixture = (name: string): Promise<Buffer> => readFile(fixturePath(name));

/** Writes the large fixtures if they are not on disk already. Cheap after the first run. */
export async function ensureLargeFixtures(): Promise<void> {
  const missing = SPECS.filter((s) => s.large && !existsSync(fixturePath(s.name)));
  if (missing.length > 0) await writeAll(missing);
}

/** Writes fixtures and checks each one lands inside its declared size band. */
export async function writeAll(specs: Spec[] = SPECS): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await mkdir(GENERATED_DIR, { recursive: true });
  for (const spec of specs) {
    const bytes = await spec.build();
    const [min, max] = spec.band;
    if (bytes.length < min || bytes.length > max) {
      throw new Error(
        `fixture ${spec.name} is ${bytes.length} bytes, outside its band ${min}..${max}. ` +
          `It was tuned so that: ${spec.why}. Retune it rather than widening the band.`,
      );
    }
    await writeFile(fixturePath(spec.name), bytes);
    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    process.stdout.write(
      `${spec.large ? "generated/" : ""}${spec.name}\t${bytes.length} bytes\tsha256:${sha}\n`,
    );
  }
}
