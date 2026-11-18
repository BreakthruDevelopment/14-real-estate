import { TooManyRequestsError } from "@/lib/errors";

/**
 * An in-process gate with a bounded queue.
 *
 * Image work is the one thing on this replica that can allocate tens of megabytes at a time, and the replica has
 * 0.25 vCPU and 512 MiB. Letting two decodes overlap doubles peak memory for no extra throughput, and letting
 * callers pile up behind the gate only converts a memory problem into a queue of requests that will all time out
 * anyway. So: **one at a time, one may wait, everyone after that is told to come back.**
 *
 * Admission is decided **synchronously**, in `run()`, before anything is awaited. That matters for more than
 * tidiness: it means N calls made in the same tick are admitted in call order with no race, so "the third
 * concurrent call is refused" is a property of the code rather than of how fast the first two happen to run.
 *
 * The slot is held until the work itself settles. A caller that gives up on a deadline does **not** hand its slot
 * to the next caller, because libvips cannot be cancelled: the pixels are still in memory, and admitting the next
 * image would put two decodes in flight — exactly what this gate exists to prevent.
 */
type Waiter = { start: () => void; timer?: ReturnType<typeof setTimeout> };

export type RunOptions = {
  /** Give up on a queued call after this long. Time spent running does not count: this is the wait for a slot only. */
  maxWaitMs?: number;
  /** The rejection for a call that waited longer than `maxWaitMs`. */
  onWaitTimeout?: () => Error;
};

export class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    readonly concurrency: number,
    readonly maxWaiting: number,
    /** Built fresh per rejection, so the error carries a usable stack and the caller's own reason code. */
    private readonly busyError: () => Error = () => new TooManyRequestsError("Busy, try again shortly"),
  ) {
    if (concurrency < 1 || maxWaiting < 0) throw new Error("Semaphore needs concurrency >= 1 and maxWaiting >= 0");
  }

  /** How many are running and how many are queued. For logging and tests; never for a decision. */
  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length };
  }

  /**
   * Runs `work` once a slot is free. Throws `TooManyRequestsError` straight away (as a rejected promise) when the
   * queue is already full, so the caller can answer 429 instead of waiting.
   */
  run<T>(work: () => Promise<T>, opts: RunOptions = {}): Promise<T> {
    if (this.active >= this.concurrency && this.queue.length >= this.maxWaiting) {
      return Promise.reject(this.busyError());
    }
    if (this.active < this.concurrency) {
      this.active += 1;
      return this.settle(work);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        start: () => {
          clearTimeout(waiter.timer);
          // The slot was handed over by `release()`, which already counted it as active.
          this.settle(work).then(resolve, reject);
        },
      };
      if (opts.maxWaitMs !== undefined) {
        waiter.timer = setTimeout(() => {
          // A waiter is only ever removed here or by `release()`, which clears this timer first, so it is still queued.
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          reject(opts.onWaitTimeout?.() ?? new TooManyRequestsError("Busy, try again shortly"));
        }, opts.maxWaitMs);
      }
      this.queue.push(waiter);
    });
  }

  private async settle<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next.start(); // hands the slot straight over: `active` stays as it is
      return;
    }
    this.active -= 1;
  }
}
