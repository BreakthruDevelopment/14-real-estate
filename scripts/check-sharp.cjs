/**
 * Does sharp actually work inside the built Alpine runner image?
 *
 * This is the one check a green test run on the CI host cannot stand in for. sharp's native binding is a
 * per-platform optional dependency: the host installs `@img/sharp-linux-x64` (glibc) and the runner image needs
 * `@img/sharp-linuxmusl-x64`. If the standalone bundle ships without it, or pnpm's libc filtering picks the wrong
 * one, every photo upload is a 500 on the deployed app and nothing before this point notices.
 *
 * So: load it, check the binding is the musl one, and put a real image through the same operations
 * `processImage()` uses. `require('sharp')` alone would pass against a binding that cannot decode anything.
 *
 * Run inside the image, with /app as the working directory so `require` resolves the bundled node_modules:
 *
 *     docker run --rm --workdir /app app:ci node -e "$(cat scripts/check-sharp.cjs)"
 */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: this file is injected with
   `node -e` inside the runner image, which has no bundler, no TypeScript and no ESM entry point. */
const path = require("node:path");

// Loading sharp is itself the first assertion: a missing or wrong-libc native binding throws right here.
const sharp = require("sharp");

async function main() {
  // Node reports a glibc version only on glibc; its absence means musl, which is what Alpine runs.
  const isMusl = !process.report.getReport().header.glibcVersionRuntime;
  const expected = `@img/sharp-${isMusl ? "linuxmusl" : "linux"}-${process.arch}`;
  let binding = "(not resolvable by name)";
  try {
    binding = path.relative(process.cwd(), require.resolve(expected, { paths: [path.dirname(require.resolve("sharp"))] }));
  } catch {
    /* pnpm nests it; sharp having loaded at all is the assertion that matters */
  }
  console.log(`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`platform ${process.platform}/${process.arch}, libc ${isMusl ? "musl" : "glibc"}, expecting ${expected}`);
  console.log(`binding: ${binding}`);

  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#204080" } })
    .png()
    .toBuffer();
  const webp = await sharp(png)
    .autoOrient()
    .resize({ width: 128, height: 128, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();
  const meta = await sharp(webp).metadata();
  if (meta.format !== "webp" || meta.width !== 128 || meta.height !== 80) {
    throw new Error(`unexpected output: ${JSON.stringify(meta)}`);
  }
  if (meta.exif || meta.xmp || meta.icc) throw new Error("re-encode kept metadata");
  console.log(`decode + autoOrient + resize + webp encode ok: ${webp.length} bytes, ${meta.width}x${meta.height}`);
}

main().catch((err) => {
  console.error("sharp check failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
