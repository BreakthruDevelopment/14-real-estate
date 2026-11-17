/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS on purpose: this runs inside the runner
   image, which has no bundler, no TypeScript and no ESM entry point. */
/**
 * The memory gate for the image module (issue 14.2, decision 2), run **inside the image that ships**.
 *
 * Why it lives in CI rather than in a one-off measurement: sharp's memory behaviour is mostly its allocator's
 * behaviour, and the allocator is a property of the base image. A figure measured on the CI host's glibc says
 * very little about `node:22-alpine`, which is musl. Measuring anywhere other than inside the real image is
 * measuring the wrong thing. It also has to stay in CI permanently, because a limit that is checked once is a
 * limit that gets exceeded later without anyone noticing.
 *
 * What it measures: `VmHWM` from `/proc/self/status` — the kernel's own peak-RSS high-water mark for this
 * process, not a sample, so a spike between two samples cannot be missed.
 *
 * What it runs: the worst inputs `processImage()` will accept, in pairs, which is the deepest the gate ever
 * gets at the shipped setting (`MAX_CONCURRENT` 1, `MAX_WAITING` 1: one decoding, one queued). Rounds repeat
 * until the peak stops moving, because glibc took about 24 images to plateau and a two-image run would have
 * reported a number 200 MB below the truth.
 *
 *     docker run --rm --memory=512m --memory-swap=512m --cpus=0.25 \
 *       -v "$PWD/bench:/app/bench:ro" -v "$PWD/test/fixtures/images/generated:/app/fixtures:ro" \
 *       --workdir /app app:ci node bench/bench-images.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const BUNDLE = process.env.BENCH_BUNDLE || "/app/bench/process.bundle.cjs";
const FIXTURES = process.env.BENCH_FIXTURES || "/app/fixtures";
/**
 * Decision 2's threshold is about **the replica**, not about this harness. This process is the image module on
 * its own, so comparing its total RSS against 400 MB would be lenient by roughly the size of the app that is
 * missing from it.
 *
 * So the budget is on the **delta** — what processing images adds on top of whatever the process already was:
 *
 *     replica budget 400 MB  -  the built Next.js server at rest 112 MB  =  288 MB for images
 *
 * The delta is also the thing that actually regresses. A total would drift every time the harness baseline moved
 * (a sharp upgrade, a Node upgrade) and would have to be re-tuned for reasons that have nothing to do with this
 * module.
 */
const REPLICA_BUDGET_MB = Number(process.env.REPLICA_BUDGET_MB || 400);
/**
 * The built Next.js server, booted and serving, with no image work, under these same two limits. Re-measure and
 * update this if the app grows: `node .next/standalone/server.js` in the same cgroup, then read VmHWM.
 */
const SERVER_BASELINE_MB = Number(process.env.SERVER_BASELINE_MB || 112);
const DELTA_BUDGET_MB = Number(process.env.DELTA_BUDGET_MB || REPLICA_BUDGET_MB - SERVER_BASELINE_MB);
/** Stop once two successive rounds move the peak less than this, so a flat allocator costs CI almost nothing. */
const PLATEAU_PCT = Number(process.env.BENCH_PLATEAU_PCT || 2);
const MAX_ROUNDS = Number(process.env.BENCH_MAX_ROUNDS || 8);
const MIN_ROUNDS = Number(process.env.BENCH_MIN_ROUNDS || 2);
/** A hard wall-clock stop, so a pathologically slow runner cannot hang the job. */
const MAX_SECONDS = Number(process.env.BENCH_MAX_SECONDS || 420);

const MB = 1024 * 1024;
const mb = (bytes) => bytes / MB;
const fmt = (bytes) => mb(bytes).toFixed(1);

const readStatus = (field) => {
  const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(fs.readFileSync("/proc/self/status", "utf8"));
  return m ? Number(m[1]) * 1024 : 0;
};
const peakRss = () => readStatus("VmHWM");
const rss = () => readStatus("VmRSS");

/** Whatever the container runtime actually applied, read from inside the container rather than assumed. */
function containerLimits() {
  const read = (p) => {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      return null;
    }
  };
  return {
    cgroup: read("/sys/fs/cgroup/memory.max") ? "v2" : "v1",
    memoryMax: read("/sys/fs/cgroup/memory.max") || read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    cpuMax: read("/sys/fs/cgroup/cpu.max") || read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    nodeConstrained: process.constrainedMemory ? process.constrainedMemory() : null,
  };
}

async function main() {
  const started = Date.now();
  const sharp = require("sharp");
  const { processImage, MAX_CONCURRENT, MAX_WAITING, MAX_INPUT_BYTES } = require(BUNDLE);
  const isMusl = !process.report.getReport().header.glibcVersionRuntime;
  const limits = containerLimits();

  console.log("--- conditions -------------------------------------------------");
  console.log(`libc:              ${isMusl ? "musl" : "glibc"}  (${process.platform}/${process.arch}, node ${process.version})`);
  console.log(`sharp:             ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`cgroup:            ${limits.cgroup}, memory.max=${limits.memoryMax}, cpu=${limits.cpuMax}`);
  console.log(`node sees:         constrainedMemory=${limits.nodeConstrained}, heap limit=${fmt(require("node:v8").getHeapStatistics().heap_size_limit)} MB`);
  console.log(`gate setting:      MAX_CONCURRENT=${MAX_CONCURRENT}, MAX_WAITING=${MAX_WAITING} (one decoding, ${MAX_WAITING} queued)`);
  console.log(`measurement:       VmHWM from /proc/self/status (kernel high-water mark, not a sample)`);
  console.log(`budget:            ${DELTA_BUDGET_MB} MB of image delta` +
    ` (= replica budget ${REPLICA_BUDGET_MB} MB - server at rest ${SERVER_BASELINE_MB} MB)`);

  const inputs = [
    { file: "noisy-2048.png", type: "image/png" },
    { file: "q100-2048.jpg", type: "image/jpeg" },
    { file: "big-2048.webp", type: "image/webp" },
    { file: "grainy-2048.jpg", type: "image/jpeg" },
  ].map(({ file, type }) => ({ file, type, bytes: fs.readFileSync(path.join(FIXTURES, file)) }));

  console.log("--- worst allowed inputs ---------------------------------------");
  for (const i of inputs) {
    if (i.bytes.byteLength > MAX_INPUT_BYTES) throw new Error(`${i.file} is over the body cap, so it is not an allowed input`);
    console.log(`${i.file.padEnd(20)} ${String(i.bytes.byteLength).padStart(9)} bytes  (${((i.bytes.byteLength / MAX_INPUT_BYTES) * 100).toFixed(0)}% of the 4 MB cap)`);
  }

  console.log("--- rounds -----------------------------------------------------");
  console.log(`${"".padEnd(8)}${"images".padStart(8)}${"RSS".padStart(10)}${"peak".padStart(10)}${"heapTotal".padStart(11)}${"external".padStart(10)}${"growth".padStart(9)}`);
  const baseline = peakRss();
  console.log(`${"start".padEnd(8)}${"0".padStart(8)}${fmt(rss()).padStart(10)}${fmt(baseline).padStart(10)}`);

  let images = 0;
  let previousPeak = baseline;
  let flatRounds = 0;
  let round = 0;
  let roundsRun = 0;
  let lastGrowth = 0;
  let plateaued = false;
  let stoppedBecause = `reached BENCH_MAX_ROUNDS=${MAX_ROUNDS}`;

  for (round = 1; round <= MAX_ROUNDS; round++) {
    for (let i = 0; i < inputs.length; i++) {
      const a = inputs[i];
      const b = inputs[(i + 1) % inputs.length];
      // Two at once: one runs, one waits. A third would be refused `busy`, so this is the deepest the gate goes.
      await Promise.allSettled([
        processImage({ bytes: a.bytes, declaredType: a.type, deadlineMs: 60_000 }),
        processImage({ bytes: b.bytes, declaredType: b.type, deadlineMs: 60_000 }),
      ]);
      images += 2;
    }
    roundsRun = round;
    const peak = peakRss();
    const growth = ((peak - previousPeak) / previousPeak) * 100;
    const mu = process.memoryUsage();
    console.log(
      `${`round ${round}`.padEnd(8)}${String(images).padStart(8)}${fmt(rss()).padStart(10)}${fmt(peak).padStart(10)}` +
        `${fmt(mu.heapTotal).padStart(11)}${fmt(mu.external).padStart(10)}${`${growth.toFixed(1)}%`.padStart(9)}`,
    );

    flatRounds = growth < PLATEAU_PCT ? flatRounds + 1 : 0;
    previousPeak = peak;
    lastGrowth = growth;
    if (round >= MIN_ROUNDS && flatRounds >= 2) {
      stoppedBecause = `the peak stopped moving (two rounds under ${PLATEAU_PCT}% growth)`;
      plateaued = true;
      break;
    }
    if ((Date.now() - started) / 1000 > MAX_SECONDS) {
      stoppedBecause = `hit BENCH_MAX_SECONDS=${MAX_SECONDS}`;
      break;
    }
  }

  const peak = peakRss();
  const delta = peak - baseline;
  const projectedReplica = SERVER_BASELINE_MB + mb(delta);
  console.log("--- result -----------------------------------------------------");
  console.log(`images processed:  ${images} (${roundsRun} rounds; stopped because ${stoppedBecause})`);
  console.log(`wall clock:        ${((Date.now() - started) / 1000).toFixed(0)}s at the CPU limit above`);
  console.log(`baseline peak RSS: ${fmt(baseline)} MB   (node + sharp + the module, before any image)`);
  console.log(`peak RSS:          ${fmt(peak)} MB   (this process, which is the module alone)`);
  console.log(`IMAGE DELTA:       ${fmt(delta)} MB   (budget ${DELTA_BUDGET_MB} MB)`);
  console.log(`projected replica: ${projectedReplica.toFixed(1)} MB   (server at rest ${SERVER_BASELINE_MB} + delta, against ${REPLICA_BUDGET_MB} MB)`);

  let failed = false;

  if (!plateaued) {
    // Without a plateau this is a lower bound, not the peak — so it is not an answer, and it must not be allowed
    // to pass. The realistic regression is a heavier pipeline that runs out of wall clock before it settles:
    // printing a warning into a three-thousand-line log and going green is exactly how the limit gets exceeded
    // later with a passing build behind it.
    console.log(
      `\nNOT A SETTLED PEAK. The run stopped because ${stoppedBecause}, and the peak was still growing at\n` +
        `${lastGrowth.toFixed(1)}% in the last round. ${fmt(delta)} MB is a lower bound, not the delta. Rerun with a\n` +
        `higher BENCH_MAX_ROUNDS / BENCH_MAX_SECONDS; failing rather than reporting an unsettled number.`,
    );
    failed = true;
  }

  if (mb(delta) > DELTA_BUDGET_MB) {
    console.log(
      `\nOVER BUDGET by ${(mb(delta) - DELTA_BUDGET_MB).toFixed(1)} MB of image delta, which projects to\n` +
        `${projectedReplica.toFixed(1)} MB on the replica against a ${REPLICA_BUDGET_MB} MB threshold. Per decision 2 this is a\n` +
        `stop-and-ask, not something to tune away: the options are a per-app cpu/memory override in\n` +
        `30-apps-infra or smaller variants, and that is Michael's call. Do not "fix" this by changing the\n` +
        `allocator, the baseline constant, or this benchmark.`,
    );
    failed = true;
  }

  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nWithin budget at a settled peak: ${(DELTA_BUDGET_MB - mb(delta)).toFixed(1)} MB of delta to spare ` +
      `(projected replica ${projectedReplica.toFixed(1)} MB).`,
  );
}

main().catch((err) => {
  console.error("bench failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
