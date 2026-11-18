import { describe, expect, it } from "vitest";
import { Semaphore } from "@/lib/images/semaphore";

/** A promise plus the handles to settle it, so a test decides exactly when a task finishes. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Semaphore", () => {
  it("runs one at a time: the second task does not start until the first finishes", async () => {
    const sem = new Semaphore(1, 1);
    const first = deferred();
    const started: string[] = [];

    const a = sem.run(async () => {
      started.push("a");
      await first.promise;
      return "a";
    });
    const b = sem.run(async () => {
      started.push("b");
      return "b";
    });

    await Promise.resolve();
    expect(started).toEqual(["a"]); // b is queued, not running
    expect(sem.stats).toEqual({ active: 1, waiting: 1 });

    first.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(started).toEqual(["a", "b"]);
    expect(sem.stats).toEqual({ active: 0, waiting: 0 });
  });

  it("refuses the third caller while one runs and one waits", async () => {
    const sem = new Semaphore(1, 1);
    const first = deferred();

    const a = sem.run(() => first.promise.then(() => "a"));
    const b = sem.run(async () => "b");
    await expect(sem.run(async () => "c")).rejects.toMatchObject({ status: 429 });

    // The refusal costs the queue nothing: a and b still complete normally.
    first.resolve();
    expect(await a).toBe("a");
    expect(await b).toBe("b");

    // And once the queue has drained, the gate takes work again.
    expect(await sem.run(async () => "d")).toBe("d");
  });

  it("admits in call order, synchronously, so the outcome does not depend on timing", async () => {
    const sem = new Semaphore(1, 1);
    const gate = deferred();
    const results: string[] = [];

    // All three calls are made in the same tick, before anything is awaited.
    const calls = [
      sem.run(() => gate.promise.then(() => "first")),
      sem.run(async () => "second"),
      sem.run(async () => "third"),
    ];
    gate.resolve();
    for (const call of calls) {
      await call.then(
        (v) => results.push(v),
        (e: Error) => results.push(`rejected:${e.constructor.name}`),
      );
    }
    expect(results).toEqual(["first", "second", "rejected:TooManyRequestsError"]);
  });

  it("uses the error the caller supplied for a refusal", async () => {
    class Custom extends Error {}
    const sem = new Semaphore(1, 0, () => new Custom("no room"));
    const gate = deferred();
    const running = sem.run(() => gate.promise);
    await expect(sem.run(async () => undefined)).rejects.toBeInstanceOf(Custom);
    gate.resolve();
    await running;
  });

  it("frees the slot when the work throws", async () => {
    const sem = new Semaphore(1, 1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(sem.stats).toEqual({ active: 0, waiting: 0 });
    expect(await sem.run(async () => "ok")).toBe("ok");
  });

  it("hands the slot straight to the waiter without letting a newcomer jump in", async () => {
    const sem = new Semaphore(1, 1);
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const a = sem.run(async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = sem.run(async () => {
      order.push("b:start");
      await second.promise;
      order.push("b:end");
    });

    first.resolve();
    await first.promise;
    await Promise.resolve();
    // `a` has finished and handed its slot to `b`, so the gate is full again and a newcomer only gets the queue.
    expect(sem.stats.active).toBe(1);
    const c = sem.run(async () => order.push("c"));
    await expect(sem.run(async () => order.push("d"))).rejects.toMatchObject({ status: 429 });

    second.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c"]);
  });

  it("allows higher concurrency when asked for it", async () => {
    const sem = new Semaphore(2, 0);
    const gate = deferred();
    const a = sem.run(() => gate.promise.then(() => "a"));
    const b = sem.run(() => gate.promise.then(() => "b"));
    await expect(sem.run(async () => "c")).rejects.toMatchObject({ status: 429 });
    gate.resolve();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  });

  it("refuses a nonsensical configuration", () => {
    expect(() => new Semaphore(0, 1)).toThrow();
    expect(() => new Semaphore(1, -1)).toThrow();
  });

  describe("maxWaitMs", () => {
    it("rejects a waiter that waited too long, takes it out of the queue, and leaves the runner alone", async () => {
      const sem = new Semaphore(1, 1);
      const first = deferred<string>();
      const a = sem.run(() => first.promise);
      const b = sem.run(async () => "b", { maxWaitMs: 5, onWaitTimeout: () => new Error("waited") });
      await expect(b).rejects.toThrow("waited");
      expect(sem.stats).toEqual({ active: 1, waiting: 0 });
      // The slot in the queue is free again.
      const c = sem.run(async () => "c");
      first.resolve("a");
      expect(await a).toBe("a");
      expect(await c).toBe("c");
      expect(sem.stats).toEqual({ active: 0, waiting: 0 });
    });

    it("does not count time spent running, and does not fire after the slot was handed over", async () => {
      const sem = new Semaphore(1, 1);
      const first = deferred();
      const a = sem.run(() => first.promise);
      const ran: string[] = [];
      const b = sem.run(async () => { ran.push("b"); await new Promise((r) => setTimeout(r, 30)); return "b"; }, { maxWaitMs: 20 });
      first.resolve();
      await a;
      // b started well inside its wait cap and then ran for longer than the cap: it must finish normally.
      expect(await b).toBe("b");
      expect(ran).toEqual(["b"]);
    });

    it("defaults to a 429 when no error is given", async () => {
      const sem = new Semaphore(1, 1);
      const first = deferred();
      const a = sem.run(() => first.promise);
      const b = sem.run(async () => "b", { maxWaitMs: 5 });
      await expect(b).rejects.toMatchObject({ status: 429 });
      first.resolve();
      await a;
    });
  });
});
