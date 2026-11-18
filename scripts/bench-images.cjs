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
 * What it measures, two ways, and the gate considers both:
 *
 *   - `VmHWM` from `/proc/self/status`: the kernel's own peak-RSS high-water mark for this process, not a sample,
 *     so a spike between two samples cannot be missed.
 *   - The cgroup's own peak: `memory.peak` (cgroup v2) or `memory.max_usage_in_bytes` (v1), read next to the
 *     `memory.max` this file already reports. The kernel OOM-kills on the cgroup's `memory.current` (anonymous
 *     pages, page cache, kernel memory, socket buffers), not on one process's RSS, so this is the figure closest
 *     to the thing that actually ends the container. Where the file does not exist the harness says so and falls
 *     back to `VmHWM` alone; it does not crash and it does not pretend.
 *
 * What the number is, and is not. On glibc, `MALLOC_ARENA_MAX=1` with low trim and mmap thresholds makes the
 * allocator behave like musl, but the two routes to a figure, default glibc and musl-like glibc, are not two
 * independent confirmations of one number: they differ by retention, and only the one taken on the allocator that
 * ships counts. Likewise `VmHWM` and the cgroup peak are not independent of each other: in a container where this is
 * the only process, one process's RSS and the cgroup's anonymous charge are nearly the same quantity under either
 * allocator, so their agreement is one quantity read twice. The
 * allocator does change the figure a great deal (the same workload read about 426 MB on default glibc and about
 * 208 MB musl-like, which is retention, not workload), so a number is only meaningful for the allocator it was
 * taken on, and the one that counts is the one measured inside the Alpine image. Nor does any of this show that a
 * process also holding a Next.js heap and serving traffic retains no more than this one does; that is covered by
 * `SERVER_BASELINE_MB` and the headroom described there, not assumed from here.
 *
 * Why the gate takes the larger of the two deltas and never replaces one with the other. The cgroup counter
 * (`memory.max_usage_in_bytes` on v1, and `memory.peak` on a cgroup that has already run other work) is a monotone
 * high-water mark for the whole cgroup, not for this process, so its *delta* is structurally understated by
 * whatever the cgroup peaked at earlier: one real run read `delta, cgroup: 0.0 MB` with the counter already at
 * 5760 MB. A `min`, or the cgroup figure alone, would have reported an image delta of 0 and passed. `max()` makes
 * the cgroup reading purely additive: it can raise the gate's figure and can never lower it.
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

/**
 * Every numeric knob goes through this, so a malformed value is a loud failure rather than a quiet one. A bad
 * value used to become `NaN`, and every comparison against `NaN` is false, so both budget checks stopped firing and
 * the gate exited 0 while printing "against NaN MB". Unset means the default. Anything else must be a plain
 * positive decimal number ("512", "12.5"): "512m" (the docker `--memory` spelling), "abc", "", "0", "-5", "1e3",
 * "0x10" and "Infinity" are all refused, and there is no fallback to the default, because that would discard what
 * the operator asked for. A new knob should use this and not `Number(process.env.X)`.
 *
 * Position-independent on purpose: a bad value exits **inside this function**, so there is no later check a new
 * knob could be placed below. The function either returns a validated number or the process is gone; it has no
 * return path that carries an invalid value.
 */
function envNumber(name, fallback, { integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const ok = /^\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) && Number(raw) > 0 && (!integer || Number.isInteger(Number(raw)));
  if (!ok) {
    console.error(
      `bench refused to run: invalid environment.\n  ${name}=${JSON.stringify(raw)} is not a positive ${integer ? "whole " : ""}number (plain digits, no unit suffix such as "m")`,
    );
    process.exit(1);
  }
  return Number(raw);
}

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
const REPLICA_BUDGET_MB = envNumber("REPLICA_BUDGET_MB", 400);
/**
 * The built Next.js server, booted and serving, with **no image work and sharp not yet loaded**, under these same
 * two limits: `node .next/standalone/server.js` in the same cgroup, hit `/api/health`, then read VmHWM.
 *
 * **Sharp is a separate step, and it is measured, not assumed.** The server only imports the image module when
 * the first photo upload arrives (the 14.4 route), and `require("sharp")` alone moved VmHWM by about 23 MB. That
 * is a step, not growth, and it is not in this constant. The harness measures it itself, in the image that ships:
 * VmHWM before `require("sharp")` and after the module is loaded, reported as `SHARP LOAD STEP`, added to the
 * projection and taken out of the delta budget. So if the projected replica is about 23 MB higher than
 * "server at rest + delta" would suggest, that is the sharp step, not a regression.
 *
 * Last re-measured (14.4's route on `main`): VmHWM 104 MB after `/api/health` on glibc, 95 MB with a musl-like
 * glibc setting, so 112 is deliberately a little high. Note what it does not contain: a signed-in server. The
 * first sign-in (scrypt) is a transient whose size is a configuration parameter, and it is not small: a server
 * that had served a full sign-up, sign-in and upload flow reached VmHWM 276 MB on default glibc (the allocator
 * that does not ship, with no cgroup back-pressure, and including image work), and about 102 MB RSS musl-like
 * after a login alone. This constant is **not** safe because a signed-in server happens to sit close to it; it
 * is not claimed to hold for one. Nothing bounds concurrent sign-ins the way `MAX_CONCURRENT` 1 bounds image
 * work, so those peaks can coincide with an upload on a real replica. What makes the constant safe is the
 * headroom in the projection: on the musl-like runs the projected replica sat about 120-150 MB under the budget,
 * which absorbs a 60-90 MB understatement here. If the headroom shrinks, this is the constant to re-examine
 * first, and a signed-in term should still not be added to the projection: it would bake a transient into a
 * steady-state figure.
 *
 * Re-measure this constant if the app grows. If it moves, the delta budget moves with it, and the change belongs
 * in the PR description. It is not something to adjust until the gate passes.
 */
const SERVER_BASELINE_MB = envNumber("SERVER_BASELINE_MB", 112);
/**
 * An override of the delta budget cannot bypass the gate: the projected replica is checked against
 * REPLICA_BUDGET_MB on its own, below, whatever the delta budget says. The override is kept for experiments.
 */
const DELTA_BUDGET_OVERRIDE = envNumber("DELTA_BUDGET_MB", null);
/** Stop once two successive rounds move the peak less than this, so a flat allocator costs CI almost nothing. */
const PLATEAU_PCT = envNumber("BENCH_PLATEAU_PCT", 2);
const MAX_ROUNDS = envNumber("BENCH_MAX_ROUNDS", 8, { integer: true });
const MIN_ROUNDS = envNumber("BENCH_MIN_ROUNDS", 2, { integer: true });
/** A hard wall-clock stop, so a pathologically slow runner cannot hang the job. */
const MAX_SECONDS = envNumber("BENCH_MAX_SECONDS", 420);

const MB = 1024 * 1024;
const mb = (bytes) => bytes / MB;
const fmt = (bytes) => mb(bytes).toFixed(1);

const readStatus = (field) => {
  const m = new RegExp(`${field}:\\s+(\\d+) kB`).exec(fs.readFileSync("/proc/self/status", "utf8"));
  return m ? Number(m[1]) * 1024 : 0;
};
const peakRss = () => readStatus("VmHWM");

/**
 * The cgroup's own high-water mark, in bytes, or null with the reason. v2 `memory.peak` (kernel 5.19+) or v1
 * `memory.max_usage_in_bytes`. BENCH_CGROUP_DIR points at a specific cgroup directory (for running outside a
 * container); inside the container the defaults are the container's own cgroup.
 */
function cgroupPeakSource() {
  const dir = process.env.BENCH_CGROUP_DIR;
  const candidates = dir
    ? [`${dir}/memory.peak`, `${dir}/memory.max_usage_in_bytes`]
    : ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"];
  for (const file of candidates) {
    try {
      const v = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isFinite(v) && v > 0) {
        // Validated again on every read, not only at selection: the file can change after it was picked, and
        // cgroup v2's `memory.max` holds the string "max" when unlimited, so a crossed path is a realistic slip.
        // A NaN here would make both budget comparisons false and the gate would exit 0.
        const read = () => {
          const text = fs.readFileSync(file, "utf8").trim();
          const n = Number(text);
          if (!Number.isFinite(n) || n < 0) throw new Error(`cgroup peak file ${file} read ${JSON.stringify(text)}, not a non-negative number`);
          return n;
        };
        return { file, read };
      }
    } catch {
      /* try the next one */
    }
  }
  return null;
}
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
  // Before sharp: the process as the server is at rest, give or take. The step to "after" is what 14.4's route adds
  // by importing the image module at all, which no at-rest server measurement contains.
  const beforeSharp = peakRss();
  const sharp = require("sharp");
  const { processImage, MAX_CONCURRENT, MAX_WAITING, MAX_INPUT_BYTES } = require(BUNDLE);
  const sharpStepMb = mb(peakRss() - beforeSharp);
  // `VmHWM` is a monotone high-water mark, so the step cannot be negative, but it can only be *understated*: if
  // node's own startup peaked above the post-load RSS it reads 0, and a 0 would silently widen the budget by the
  // whole ~23-29 MB step, in the unsafe direction. Real readings are 23-29 MB, so a reading under this is a
  // broken measurement. The harness refuses rather than substituting a made-up figure (which would be an invented
  // number) or carrying on with a lenient one. It is also measured going into a near-empty process, not into a
  // 112 MB server; the direction of that error is unknown, so it is stated here and not corrected for.
  const SHARP_STEP_FLOOR_MB = 5;
  if (!(sharpStepMb >= SHARP_STEP_FLOOR_MB)) {
    console.error(
      `bench refused to run: SHARP LOAD STEP read ${sharpStepMb.toFixed(1)} MB, under the ${SHARP_STEP_FLOOR_MB} MB floor. ` +
        `Loading sharp really costs about 23-29 MB, so this reading is wrong (VmHWM was already that high before ` +
        `require("sharp")) and it would understate the projected replica.`,
    );
    process.exit(1);
  }
  const DELTA_BUDGET_MB = DELTA_BUDGET_OVERRIDE ?? REPLICA_BUDGET_MB - SERVER_BASELINE_MB - sharpStepMb;
  const cgroup = cgroupPeakSource();
  const isMusl = !process.report.getReport().header.glibcVersionRuntime;
  const limits = containerLimits();

  console.log("--- conditions -------------------------------------------------");
  console.log(`libc:              ${isMusl ? "musl" : "glibc"}  (${process.platform}/${process.arch}, node ${process.version})`);
  console.log(`sharp:             ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`);
  console.log(`cgroup:            ${limits.cgroup}, memory.max=${limits.memoryMax}, cpu=${limits.cpuMax}`);
  console.log(`node sees:         constrainedMemory=${limits.nodeConstrained}, heap limit=${fmt(require("node:v8").getHeapStatistics().heap_size_limit)} MB`);
  console.log(`gate setting:      MAX_CONCURRENT=${MAX_CONCURRENT}, MAX_WAITING=${MAX_WAITING} (one decoding, ${MAX_WAITING} queued)`);
  console.log(`measurement:       VmHWM from /proc/self/status (kernel high-water mark, not a sample)`);
  console.log(
    cgroup
      ? `                   and the cgroup peak from ${cgroup.file} (what the OOM killer's memory.current is bounded by)`
      : `                   cgroup peak UNAVAILABLE (no memory.peak / memory.max_usage_in_bytes here): VmHWM alone, which is weaker`,
  );
  console.log(`budget:            ${DELTA_BUDGET_MB.toFixed(1)} MB of image delta` +
    ` (= replica budget ${REPLICA_BUDGET_MB} MB - server at rest ${SERVER_BASELINE_MB} MB - sharp load step ${sharpStepMb.toFixed(1)} MB)`);
  if (DELTA_BUDGET_OVERRIDE !== null) {
    console.log(`NOTE: DELTA_BUDGET_MB is overridden to ${DELTA_BUDGET_OVERRIDE}; the replica budget below is still enforced on its own.`);
  }

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
  const cgroupBaseline = cgroup ? cgroup.read() : null;
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
  const rssDelta = peak - baseline;
  // The cgroup peak also holds page cache and kernel memory, so its delta can be larger than VmHWM's. The gate
  // takes the larger of the two: whichever the kernel would see first.
  const cgroupPeak = cgroup ? cgroup.read() : null;
  const cgroupDelta = cgroup ? cgroupPeak - cgroupBaseline : null;
  const delta = cgroupDelta === null ? rssDelta : Math.max(rssDelta, cgroupDelta);
  const projectedReplica = SERVER_BASELINE_MB + sharpStepMb + mb(delta);
  console.log("--- result -----------------------------------------------------");
  console.log(`images processed:  ${images} (${roundsRun} rounds; stopped because ${stoppedBecause})`);
  console.log(`wall clock:        ${((Date.now() - started) / 1000).toFixed(0)}s at the CPU limit above`);
  console.log(`baseline peak RSS: ${fmt(baseline)} MB   (node + sharp + the module, before any image)`);
  console.log(`peak RSS:          ${fmt(peak)} MB   (this process, which is the module alone)`);
  console.log(`SHARP LOAD STEP:   ${sharpStepMb.toFixed(1)} MB   (VmHWM before require("sharp") -> after the module is loaded)`);
  console.log(`delta, VmHWM:      ${fmt(rssDelta)} MB`);
  console.log(
    cgroupDelta === null
      ? `delta, cgroup:     not measured (no cgroup peak file)`
      : `delta, cgroup:     ${fmt(cgroupDelta)} MB   (peak ${fmt(cgroupPeak)} MB at the end, ${fmt(cgroupBaseline)} MB before the first image)`,
  );
  console.log(`IMAGE DELTA:       ${fmt(delta)} MB   (the larger of the two; budget ${DELTA_BUDGET_MB.toFixed(1)} MB)`);
  console.log(
    `projected replica: ${projectedReplica.toFixed(1)} MB   (server at rest ${SERVER_BASELINE_MB} + sharp step ${sharpStepMb.toFixed(1)}` +
      ` + delta, against ${REPLICA_BUDGET_MB} MB)`,
  );

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

  const overBudgetNote =
    `Per decision 2 this is a stop-and-ask, not something to tune away: the options are a per-app cpu/memory\n` +
    `override in 30-apps-infra or smaller variants, and that is Michael's call. Do not "fix" this by changing the\n` +
    `allocator, the baseline constant, or this benchmark.`;
  let overBudget = false;

  if (mb(delta) > DELTA_BUDGET_MB) {
    console.log(
      `\nOVER BUDGET by ${(mb(delta) - DELTA_BUDGET_MB).toFixed(1)} MB of image delta (budget ${DELTA_BUDGET_MB.toFixed(1)} MB).`,
    );
    overBudget = true;
  }

  // Independent of the delta budget on purpose: DELTA_BUDGET_MB can be overridden, and a printed projection that
  // is over the threshold must not be able to exit 0.
  if (projectedReplica > REPLICA_BUDGET_MB) {
    console.log(
      `\nPROJECTED REPLICA OVER BUDGET: ${projectedReplica.toFixed(1)} MB against ${REPLICA_BUDGET_MB} MB, by ` +
        `${(projectedReplica - REPLICA_BUDGET_MB).toFixed(1)} MB.`,
    );
    overBudget = true;
  }
  if (overBudget) {
    console.log(overBudgetNote);
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
