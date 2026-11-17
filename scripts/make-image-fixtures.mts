/**
 * Regenerates `test/fixtures/images/`. Run from the repo root:
 *
 *     pnpm fixtures:images
 *
 * Everything is deterministic (a seeded PRNG, fixed sharp options), so a rerun on any machine produces the same
 * bytes. Each file has to land inside the size band declared in `test/fixtures/images/make.ts`; a file that drifts
 * out of its band fails the run rather than silently turning a test into one that proves nothing.
 */
import { writeAll } from "../test/fixtures/images/make";

await writeAll();
