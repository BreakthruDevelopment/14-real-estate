import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  IMAGE_CONTENT_TYPES,
  ImageError,
  LG_MAX_BYTES,
  LG_QUALITY_LADDER,
  MAX_INPUT_BYTES,
  MAX_INPUT_PIXELS,
  VARIANTS,
  VARIANT_NAMES,
  imageQueueStats,
  processImage,
  sniff,
} from "@/lib/images/process";
import { ensureLargeFixtures, QUADRANTS, readFixture } from "../../../test/fixtures/images/make";
import { readGps, riffChunkIds } from "../../../test/fixtures/images/exif";

/**
 * The upload threat model for app 14 lives in `process.ts`, so these tests are written to be hard to satisfy by
 * accident. Three habits throughout:
 *
 * - **Check the input, not just the output.** "No GPS in the variant" means nothing unless the input had GPS, so
 *   `exif-gps.jpg` is checked for real coordinates before anything is claimed about the variants.
 * - **Read the bytes.** EXIF is looked for in the output buffer itself (RIFF chunk ids and a raw substring scan),
 *   not by asking sharp whether it thinks it wrote any.
 * - **Prove the mechanism, not the message.** The pixel-limit tests assert that libvips was never asked to decode,
 *   and the re-encode tests independently re-encode the fixture to confirm it still exercises the path it was
 *   tuned for, so a fixture that drifts fails loudly instead of quietly proving nothing.
 */

const JPEG = "image/jpeg";
const PNG = "image/png";
const WEBP = "image/webp";

/** The one call that makes libvips decode pixels. `metadata()` does not go through it; every variant does. */
const sharpPrototype = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } }));

/**
 * Every way sharp 0.35.5 can make libvips read pixels.
 *
 * `_pipeline` is the one all three output paths go through — `toBuffer`, `toUint8Array` and `toFile` each call
 * it — so spying on it rather than on `toBuffer` makes the "nothing was decoded" proof hold for output paths
 * this module does not use today but someone might add tomorrow. `stats` is the exception: it decodes through
 * its own native binding and never touches `_pipeline`, so it is counted separately.
 *
 * `metadata` is deliberately **not** in this list. It parses the header and does not decode, which is not an
 * assumption: `pixel limit > refuses a 20,000 x 20,000 header` calls it on a file whose pixel data cannot be
 * decoded at all and it resolves with the dimensions.
 */
const DECODE_DRIVERS = ["_pipeline", "stats"] as const;
/** Asking libvips to look at the bytes at all, decode or not. Used to prove an unsupported file never reaches it. */
const LIBVIPS_ENTRY_POINTS = [...DECODE_DRIVERS, "metadata"] as const;

async function countingCalls<T>(
  methods: readonly string[],
  fn: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; calls: number; byMethod: Record<string, number> }> {
  const spies = methods.map((m) => [m, vi.spyOn(sharpPrototype, m as never)] as const);
  try {
    const result = await Promise.allSettled([fn()]).then((r) => r[0]);
    const byMethod = Object.fromEntries(spies.map(([m, s]) => [m, s.mock.calls.length]));
    return { result, calls: Object.values(byMethod).reduce((a, b) => a + b, 0), byMethod };
  } finally {
    for (const [, spy] of spies) spy.mockRestore();
  }
}

/** Runs `fn` while counting how many times anything in the process asks libvips for pixels. */
async function countingDecodes<T>(fn: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; decodes: number }> {
  const { result, calls } = await countingCalls(DECODE_DRIVERS, fn);
  return { result, decodes: calls };
}

/** The gate holds its slot until the real work settles, which can outlive a call that hit its deadline. */
async function waitForIdle(): Promise<void> {
  for (let i = 0; i < 400 && imageQueueStats().active > 0; i++) await new Promise((r) => setTimeout(r, 25));
}

const reasonOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof ImageError ? err.reason : `${(err as Error).name}: ${(err as Error).message}`;
  }
};

/** The colour at a fraction of the way across and down a WebP variant. */
async function pixelAt(webp: Buffer, fx: number, fy: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const x = Math.floor(info.width * fx);
  const y = Math.floor(info.height * fy);
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const near = (got: readonly number[], want: readonly number[], tolerance = 40) =>
  got.every((v, i) => Math.abs(v - want[i]) <= tolerance);

beforeAll(async () => {
  await ensureLargeFixtures();
}, 120_000);

afterEach(waitForIdle);

// ---------------------------------------------------------------------------

describe("sniff", () => {
  it("names the three accepted types and the two that have to be refused", async () => {
    expect(sniff(await readFixture("exif-gps.jpg"))).toBe(JPEG);
    expect(sniff(await readFixture("photo.png"))).toBe(PNG);
    expect(sniff(await readFixture("photo.webp"))).toBe(WEBP);
    expect(sniff(await readFixture("tiny.gif"))).toBe("image/gif");
    expect(sniff(await readFixture("vector.svg"))).toBe("image/svg+xml");
  });

  it("does not take a RIFF container that is not WebP for a WebP", () => {
    const wav = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "latin1");
    expect(sniff(wav)).toBe("unknown");
  });

  it("sees an SVG behind a BOM, leading whitespace or an XML declaration", () => {
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniff(Buffer.from('\n\n  <?xml version="1.0"?><svg/>'))).toBe("image/svg+xml");
    expect(sniff(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<svg/>")]))).toBe("image/svg+xml");
  });

  it("calls an empty or short buffer unknown rather than guessing", () => {
    expect(sniff(Buffer.alloc(0))).toBe("unknown");
    expect(sniff(Buffer.from([0xff, 0xd8]))).toBe("unknown"); // two of the three JPEG magic bytes
  });
});

// ---------------------------------------------------------------------------

describe("variants", () => {
  it("produces lg 1280, md 640 and sm 320 WebP from a 2048 x 2048 photo", async () => {
    const result = await processImage({ bytes: await readFixture("q100-2048.jpg"), declaredType: JPEG });

    expect(Object.keys(result.variants).sort()).toEqual(["lg", "md", "sm"]);
    for (const name of VARIANT_NAMES) {
      const v = result.variants[name];
      expect(v.contentType).toBe("image/webp");
      expect(sniff(v.bytes)).toBe(WEBP);
      expect(Math.max(v.width, v.height)).toBe(VARIANTS[name].edge);
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(result.source).toMatchObject({ format: JPEG, width: 2048, height: 2048 });
    expect(result.totalBytes).toBe(VARIANT_NAMES.reduce((n, v) => n + result.variants[v].bytes.byteLength, 0));
  }, 60_000);

  it("never upscales: a 320 x 240 photo stays 320 x 240 in all three variants", async () => {
    const bytes = await readFixture("small-320x240.jpg");
    const { variants } = await processImage({ bytes, declaredType: JPEG });
    for (const name of VARIANT_NAMES) {
      expect([variants[name].width, variants[name].height]).toEqual([320, 240]);
    }
    // The guard is `withoutEnlargement`, not a coincidence of this fixture: 320 is already sm's long edge, and
    // lg (1280) and md (640) would both have enlarged it.
    expect(VARIANTS.lg.edge).toBeGreaterThan(320);
    expect(VARIANTS.md.edge).toBeGreaterThan(320);
  }, 30_000);

  it("keeps the aspect ratio and fits the long edge, whichever edge that is", async () => {
    const { variants } = await processImage({ bytes: await readFixture("photo.png"), declaredType: PNG }); // 800 x 600
    expect([variants.lg.width, variants.lg.height]).toEqual([800, 600]); // not enlarged to 1280
    expect([variants.md.width, variants.md.height]).toEqual([640, 480]);
    expect([variants.sm.width, variants.sm.height]).toEqual([320, 240]);
  }, 30_000);

  it("accepts each of the three input types", async () => {
    for (const [name, type] of [
      ["exif-gps.jpg", JPEG],
      ["photo.png", PNG],
      ["photo.webp", WEBP],
    ] as const) {
      const result = await processImage({ bytes: await readFixture(name), declaredType: type });
      expect(result.variants.sm.bytes.byteLength).toBeGreaterThan(0);
      expect(result.source.format).toBe(type);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("metadata and GPS", () => {
  it("the exif-gps.jpg fixture really carries GPS, so the test below is worth something", async () => {
    const bytes = await readFixture("exif-gps.jpg");
    const meta = await sharp(bytes).metadata();
    const gps = readGps(meta.exif);

    expect(gps).not.toBeNull();
    expect(gps!.tags).toEqual(expect.arrayContaining([1, 2, 3, 4])); // lat ref, lat, lng ref, lng
    expect(gps!.latitude).toBeCloseTo(30.2583, 3); // 30 deg 15' 30" N
    expect(gps!.longitude).toBeCloseTo(-97.74, 3); // 97 deg 44' 24" W
    expect(meta.exif!.toString("latin1")).toContain("BreakthruFixture"); // camera make
    // And it is within the pixel limit, because scripts/smoke.sh uploads this exact file.
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_INPUT_BYTES);
    expect(meta.width! * meta.height!).toBeLessThanOrEqual(MAX_INPUT_PIXELS);
  });

  it("leaves no EXIF, GPS, XMP or ICC in any variant, read from the output bytes", async () => {
    const bytes = await readFixture("exif-gps.jpg");
    const result = await processImage({ bytes, declaredType: JPEG });
    expect(result.source.hadMetadata).toBe(true);

    for (const name of VARIANT_NAMES) {
      const out = result.variants[name].bytes;

      // 1. The container: a WebP carries metadata in EXIF / XMP / ICCP chunks. There are none.
      const chunks = riffChunkIds(out);
      expect(chunks).not.toContain("EXIF");
      expect(chunks).not.toContain("XMP ");
      expect(chunks).not.toContain("ICCP");
      expect(chunks.some((id) => id === "VP8 " || id === "VP8L" || id === "VP8X")).toBe(true);

      // 2. The raw bytes: nothing that looks like EXIF, XMP or anything out of the input's metadata.
      const text = out.toString("latin1");
      for (const marker of ["Exif", "ns.adobe.com/xap", "GPSLatitude", "BreakthruFixture", "FixtureCam", "make-image-fixtures"]) {
        expect(text, `${name} contains ${marker}`).not.toContain(marker);
      }

      // 3. And libvips, reading the variant back, finds no metadata of any kind.
      const meta = await sharp(out).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(readGps(meta.exif)).toBeNull();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("orientation", () => {
  it("applies EXIF orientation 6, so the photo comes out upright and the right way round", async () => {
    const bytes = await readFixture("orientation-6.jpg");
    const stored = await sharp(bytes).metadata();
    // Stored sideways: 480 wide, 320 tall, tagged "rotate 90 clockwise to display".
    expect([stored.width, stored.height]).toEqual([480, 320]);
    expect(stored.orientation).toBe(6);

    const { variants } = await processImage({ bytes, declaredType: JPEG });

    // Upright is 320 x 480. lg is inside 1280 so it is not resized, which keeps the corner check exact.
    expect([variants.lg.width, variants.lg.height]).toEqual([320, 480]);
    expect(variants.md.height).toBeGreaterThan(variants.md.width);

    // Dimensions alone would also pass for a 180-degree error, so check the picture itself: the quadrants have to
    // land red / green / blue / yellow clockwise from the top left.
    const [tl, tr, bl, br] = await Promise.all([
      pixelAt(variants.lg.bytes, 0.25, 0.25),
      pixelAt(variants.lg.bytes, 0.75, 0.25),
      pixelAt(variants.lg.bytes, 0.25, 0.75),
      pixelAt(variants.lg.bytes, 0.75, 0.75),
    ]);
    expect(near(tl, QUADRANTS[0]), `top-left was ${tl}, wanted red`).toBe(true);
    expect(near(tr, QUADRANTS[1]), `top-right was ${tr}, wanted green`).toBe(true);
    expect(near(bl, QUADRANTS[2]), `bottom-left was ${bl}, wanted blue`).toBe(true);
    expect(near(br, QUADRANTS[3]), `bottom-right was ${br}, wanted yellow`).toBe(true);
  }, 30_000);

  it("drops the orientation tag rather than re-applying it to an already upright variant", async () => {
    const { variants } = await processImage({ bytes: await readFixture("orientation-6.jpg"), declaredType: JPEG });
    const meta = await sharp(variants.lg.bytes).metadata();
    // 1 or absent: anything else and a viewer would turn the picture again.
    expect([1, undefined]).toContain(meta.orientation);
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("pixel limit", () => {
  it("refuses 2049 x 2048 as too_many_pixels without asking libvips to decode anything", async () => {
    const bytes = await readFixture("oversize-2049x2048.png");
    // The fixture is a complete, decodable PNG: nothing but its pixel count can explain the refusal.
    const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
    expect([meta.width, meta.height]).toEqual([2049, 2048]);
    expect(meta.width! * meta.height!).toBe(MAX_INPUT_PIXELS + 2048);
    await expect(sharp(bytes, { limitInputPixels: false }).resize(8).toBuffer()).resolves.toBeInstanceOf(Buffer);

    const { result, decodes } = await countingDecodes(() => processImage({ bytes, declaredType: PNG }));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ reason: "too_many_pixels", status: 422 });
    expect(decodes, "libvips was asked for pixels before the image was refused").toBe(0);
  }, 30_000);

  it("refuses a 20,000 x 20,000 header the same way, and that file cannot even be decoded", async () => {
    const bytes = await readFixture("bomb-20000x20000.png");
    expect(bytes.byteLength).toBeLessThan(1024); // 400 megapixels declared in 68 bytes

    // The decisive detail: the pixel data in this file is unusable, so *any* answer that came from a decode would
    // have to be `decode_failed`. Getting `too_many_pixels` is only possible from the header.
    await expect(sharp(bytes, { limitInputPixels: false }).resize(8).toBuffer()).rejects.toThrow();

    const { result, decodes } = await countingDecodes(() => processImage({ bytes, declaredType: PNG }));

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({ reason: "too_many_pixels" });
    expect(decodes).toBe(0);
  }, 30_000);

  it("counts decodes properly, so a zero above means something", async () => {
    // The control. If the spy could not see libvips being driven, the two tests above would pass against any
    // implementation at all, including one that decodes a 400 megapixel image first and refuses it afterwards.
    const bytes = await readFixture("small-320x240.jpg");
    const { result, decodes } = await countingDecodes(() => processImage({ bytes, declaredType: JPEG }));
    expect(result.status).toBe("fulfilled");
    expect(decodes).toBeGreaterThanOrEqual(4); // one raw decode plus one encode per variant
  }, 30_000);

  it("accepts an image exactly on the limit", async () => {
    const onTheLine = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#204080" } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(2048 * 2048).toBe(MAX_INPUT_PIXELS);
    const { source } = await processImage({ bytes: onTheLine, declaredType: PNG });
    expect([source.width, source.height]).toEqual([2048, 2048]);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("formats that are refused", () => {
  it("refuses a GIF as unsupported, however it is declared", async () => {
    const bytes = await readFixture("tiny.gif");
    // libvips would read this quite happily, so the refusal has to be ours.
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({ format: "gif" });

    expect(await reasonOf(processImage({ bytes, declaredType: PNG }))).toBe("unsupported");
    expect(await reasonOf(processImage({ bytes, declaredType: "image/gif" }))).toBe("unsupported");
  });

  it("refuses an SVG as unsupported", async () => {
    const bytes = await readFixture("vector.svg");
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({ format: "svg" });

    expect(await reasonOf(processImage({ bytes, declaredType: PNG }))).toBe("unsupported");
    expect(await reasonOf(processImage({ bytes, declaredType: "image/svg+xml" }))).toBe("unsupported");
  });

  it("never hands an unsupported file to libvips at all, not even to read its header", async () => {
    // The point of sniffing in our own code is that libvips never sees these bytes. There is a second line of
    // defence further in (`header.format` has to agree with the magic bytes), and it is good that there is —
    // but it only runs *after* libvips has parsed the file, so on its own it would mean a GIF, an SVG or a PDF
    // still got fed to a stack of C parsers we have no reason to expose. This asserts the first line directly.
    for (const name of ["tiny.gif", "vector.svg", "document.pdf"] as const) {
      const bytes = await readFixture(name);
      const { result, calls, byMethod } = await countingCalls(LIBVIPS_ENTRY_POINTS, () =>
        processImage({ bytes, declaredType: PNG }),
      );
      expect(result.status).toBe("rejected");
      expect((result as PromiseRejectedResult).reason).toMatchObject({ reason: "unsupported" });
      expect(calls, `${name} reached libvips: ${JSON.stringify(byMethod)}`).toBe(0);
    }
  });

  it("counts libvips entry points properly, so the zero above means something", async () => {
    // The control for the test above: an accepted photo must register on the same spies.
    const bytes = await readFixture("photo.png");
    const { result, byMethod } = await countingCalls(LIBVIPS_ENTRY_POINTS, () =>
      processImage({ bytes, declaredType: PNG }),
    );
    expect(result.status).toBe("fulfilled");
    expect(byMethod.metadata).toBeGreaterThanOrEqual(1); // the header probe
    expect(byMethod._pipeline).toBeGreaterThanOrEqual(4); // one decode plus one encode per variant
  }, 30_000);

  it("refuses bytes that do not match the declared type", async () => {
    const png = await readFixture("photo.png");
    expect(await reasonOf(processImage({ bytes: png, declaredType: JPEG }))).toBe("unsupported");
    expect(await reasonOf(processImage({ bytes: png, declaredType: WEBP }))).toBe("unsupported");
    expect(await reasonOf(processImage({ bytes: png, declaredType: PNG }))).toBe("resolved");
  }, 30_000);

  it("ignores Content-Type parameters but still insists on one of the three types", async () => {
    const bytes = await readFixture("photo.webp");
    expect(await reasonOf(processImage({ bytes, declaredType: "IMAGE/WEBP; charset=binary" }))).toBe("resolved");
    expect(await reasonOf(processImage({ bytes, declaredType: "application/octet-stream" }))).toBe("unsupported");
  }, 30_000);

  it("gets nowhere with a polyglot that wears accepted magic bytes", async () => {
    // Each of these begins with magic the sniffer accepts and continues as something else, which is how a file
    // gets past a magic-byte check. They fail in libvips' *header* parse, before any pixel work — a different
    // code path from the truncated JPEG below, which has an intact header and fails in the decode.
    const gif = await readFixture("tiny.gif");
    const jpg = await readFixture("exif-gps.jpg");
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const polyglots = {
      "PNG signature, GIF body": { bytes: Buffer.concat([pngSignature, gif]), type: PNG },
      "PNG signature, JPEG body": { bytes: Buffer.concat([pngSignature, jpg]), type: PNG },
      "JPEG marker, PNG body": { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), await readFixture("photo.png")]), type: JPEG },
      "RIFF/WEBP container, junk payload": {
        bytes: Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.alloc(32, 0x41)]),
        type: WEBP,
      },
    };
    for (const [name, { bytes, type }] of Object.entries(polyglots)) {
      expect(sniff(bytes), `${name} should get past the magic check`).toBe(type);
      const { result, decodes } = await countingDecodes(() => processImage({ bytes, declaredType: type }));
      expect(result.status, name).toBe("rejected");
      expect((result as PromiseRejectedResult).reason, name).toMatchObject({ reason: "decode_failed" });
      expect(decodes, `${name} got as far as a decode`).toBe(0);
    }
  }, 30_000);

  it("refuses a truncated JPEG as decode_failed", async () => {
    const bytes = await readFixture("truncated.jpg");
    // Its header is intact, so it gets past sniffing and the pixel check: the failure really is in the decode.
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({ format: "jpeg", width: 900, height: 600 });
    expect(await reasonOf(processImage({ bytes, declaredType: JPEG }))).toBe("decode_failed");
  }, 30_000);

  it("refuses an animated WebP: the pixel budget is per frame, not per file", async () => {
    const animated = await readFixture("animated.webp");
    await expect(sharp(animated).metadata()).resolves.toMatchObject({ format: "webp", pages: 3 });
    // Left alone, libvips would decode frame 1 and the other two would be stored as nothing at all.
    await expect(sharp(animated).raw().toBuffer({ resolveWithObject: true })).resolves.toMatchObject({
      info: { width: 600, height: 400 },
    });
    expect(await reasonOf(processImage({ bytes: animated, declaredType: WEBP }))).toBe("unsupported");
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("the 400 KB lg cap", () => {
  it("re-encodes an lg over 400 KB and keeps the photo when the ladder gets it under", async () => {
    const bytes = await readFixture("grainy-2048.jpg");

    // Independent check that this fixture still exercises the path: encoded at the nominal quality it is over the
    // cap. If a libvips upgrade ever makes that false, this fails here rather than passing for the wrong reason.
    const atNominalQuality = await sharp(bytes)
      .autoOrient()
      .resize({ width: VARIANTS.lg.edge, height: VARIANTS.lg.edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: VARIANTS.lg.quality })
      .toBuffer();
    expect(atNominalQuality.byteLength, "fixture no longer produces an oversized lg").toBeGreaterThan(LG_MAX_BYTES);

    const { variants } = await processImage({ bytes, declaredType: JPEG });

    expect(variants.lg.bytes.byteLength).toBeLessThanOrEqual(LG_MAX_BYTES);
    expect(variants.lg.quality).not.toBe(VARIANTS.lg.quality); // the ladder ran
    expect(LG_QUALITY_LADDER).toContain(variants.lg.quality as never);
    expect(variants.lg.bytes.byteLength).toBeLessThan(atNominalQuality.byteLength);
    // md and sm are untouched by the ladder.
    expect(variants.md.quality).toBe(VARIANTS.md.quality);
    expect(variants.sm.quality).toBe(VARIANTS.sm.quality);
  }, 120_000);

  it("refuses too_large_after_encode when even the bottom of the ladder is over, and stores nothing", async () => {
    const bytes = await readFixture("noisy-2048.png");

    // Same independent check, at the bottom of the ladder this time.
    const atLowestQuality = await sharp(bytes)
      .autoOrient()
      .resize({ width: VARIANTS.lg.edge, height: VARIANTS.lg.edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: LG_QUALITY_LADDER[LG_QUALITY_LADDER.length - 1] })
      .toBuffer();
    expect(atLowestQuality.byteLength, "fixture no longer survives the ladder").toBeGreaterThan(LG_MAX_BYTES);

    const rejection = await processImage({ bytes, declaredType: PNG }).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ImageError);
    expect(rejection).toMatchObject({ reason: "too_large_after_encode", status: 422 });
    // Nothing partial comes back: a caller has no variants to store.
    expect((rejection as ImageError & { variants?: unknown }).variants).toBeUndefined();
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe("one at a time", () => {
  it("runs one, queues one, and refuses the third with busy", async () => {
    const bytes = await readFixture("q100-2048.jpg");

    // Three calls in the same tick. Admission is decided synchronously, so this does not depend on how fast the
    // first one runs.
    const calls = [
      processImage({ bytes, declaredType: JPEG }),
      processImage({ bytes, declaredType: JPEG }),
      processImage({ bytes, declaredType: JPEG }),
    ];
    const settled = await Promise.allSettled(calls);

    expect(settled[0].status).toBe("fulfilled");
    expect(settled[1].status).toBe("fulfilled");
    expect(settled[2].status).toBe("rejected");
    const refusal = (settled[2] as PromiseRejectedResult).reason as ImageError;
    expect(refusal).toBeInstanceOf(ImageError);
    expect(refusal.reason).toBe("busy");
    expect(refusal.status).toBe(429);
    expect(refusal.retryAfterSeconds).toBe(3);
  }, 180_000);

  it("takes work again once the queue has drained", async () => {
    const bytes = await readFixture("small-320x240.jpg");
    await expect(processImage({ bytes, declaredType: JPEG })).resolves.toBeDefined();
    expect(imageQueueStats()).toEqual({ active: 0, waiting: 0 });
  }, 30_000);

  it("does not let a refused upload take a slot at all", async () => {
    const gif = await readFixture("tiny.gif");
    // Ten refusals in the same tick: if any of them took the gate, the later ones would come back `busy`.
    const reasons = await Promise.all(
      Array.from({ length: 10 }, () => reasonOf(processImage({ bytes: gif, declaredType: PNG }))),
    );
    expect(reasons).toEqual(Array(10).fill("unsupported"));
  });
});

// ---------------------------------------------------------------------------

describe("deadline", () => {
  it("gives up on a photo that outlasts its deadline", async () => {
    const bytes = await readFixture("noisy-2048.png");
    expect(await reasonOf(processImage({ bytes, declaredType: PNG, deadlineMs: 1 }))).toBe("timeout");
  }, 120_000);

  it("keeps the slot until the abandoned work really finishes, rather than letting two decodes overlap", async () => {
    const bytes = await readFixture("noisy-2048.png");
    const abandoned = processImage({ bytes, declaredType: PNG, deadlineMs: 1 });
    expect(await reasonOf(abandoned)).toBe("timeout");
    // The caller is gone, but libvips cannot be cancelled, so the gate is still held.
    expect(imageQueueStats().active).toBe(1);
    await waitForIdle();
    expect(imageQueueStats()).toEqual({ active: 0, waiting: 0 });
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("refuses an empty body", async () => {
    expect(await reasonOf(processImage({ bytes: Buffer.alloc(0), declaredType: JPEG }))).toBe("unsupported");
  });

  it("refuses a body over 4 MB before looking at it", async () => {
    const tooBig = Buffer.alloc(MAX_INPUT_BYTES + 1);
    Buffer.from([0xff, 0xd8, 0xff]).copy(tooBig); // a real JPEG magic, so only the size can be the reason
    const { result, decodes } = await countingDecodes(() => processImage({ bytes: tooBig, declaredType: JPEG }));
    expect((result as PromiseRejectedResult).reason).toMatchObject({ reason: "too_large_input", status: 413 });
    expect(decodes).toBe(0);
  });

  it("rejects a Content-Type with a NUL byte at the boundary, not in the database", async () => {
    const bytes = await readFixture("photo.png");
    const reason = await reasonOf(processImage({ bytes, declaredType: "image/png\u0000" }));
    expect(reason).toContain("ZodError");
  });

  it("rejects an empty Content-Type and a non-buffer body", async () => {
    const bytes = await readFixture("photo.png");
    expect(await reasonOf(processImage({ bytes, declaredType: "   " }))).toContain("ZodError");
    expect(await reasonOf(processImage({ bytes: "not bytes" as never, declaredType: PNG }))).toContain("ZodError");
  });

  it("caps the deadline a caller may ask for", async () => {
    const bytes = await readFixture("photo.png");
    expect(await reasonOf(processImage({ bytes, declaredType: PNG, deadlineMs: 600_000 }))).toContain("ZodError");
  });
});

// ---------------------------------------------------------------------------

describe("the error contract routes depend on", () => {
  it("maps every reason to a status and a message with nothing internal in it", () => {
    for (const reason of ["unsupported", "too_many_pixels", "decode_failed", "too_large_after_encode", "busy", "timeout"] as const) {
      const err = new ImageError(reason);
      expect(err.status).toBeGreaterThanOrEqual(400);
      expect(err.message).not.toMatch(/libvips|vips|sharp|Error:|\.ts:/i);
      expect(err.reason).toBe(reason);
    }
    expect(new ImageError("busy").retryAfterSeconds).toBe(3);
    expect(new ImageError("unsupported").retryAfterSeconds).toBeUndefined();
  });

  it("agrees with the list of types the browser is told to accept", async () => {
    const { ACCEPTED_UPLOAD_TYPES } = await import("@/lib/images/client-resize");
    expect([...ACCEPTED_UPLOAD_TYPES]).toEqual([...IMAGE_CONTENT_TYPES]);
  });
});
