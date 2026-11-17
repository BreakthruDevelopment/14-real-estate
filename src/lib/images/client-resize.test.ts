import { describe, expect, it } from "vitest";
import {
  ACCEPTED_UPLOAD_TYPES,
  CLIENT_MAX_BYTES,
  CLIENT_MAX_EDGE,
  CLIENT_QUALITY,
  FILE_INPUT_ACCEPT,
  canResizeInBrowser,
  fitWithin,
} from "@/lib/images/client-resize";
import { MAX_INPUT_BYTES, MAX_INPUT_PIXELS } from "@/lib/images/process";

/**
 * The browser-side resize is a courtesy, not a control, so the thing worth testing here is the arithmetic: a
 * wrong `fitWithin` either uploads a 12 MP photo to a 0.25 vCPU replica or quietly enlarges a small one.
 */
describe("fitWithin", () => {
  it("fits the long edge and keeps the aspect ratio", () => {
    expect(fitWithin(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 }); // a phone photo, landscape
    expect(fitWithin(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 }); // the same photo, portrait
    expect(fitWithin(5000, 1000, 2048)).toEqual({ width: 2048, height: 410 }); // a panorama
  });

  it("never enlarges", () => {
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1, 1, 2048)).toEqual({ width: 1, height: 1 });
    expect(fitWithin(2048, 2048, 2048)).toEqual({ width: 2048, height: 2048 }); // exactly on the limit
  });

  it("rounds to whole pixels and never returns zero, because a zero-width canvas throws", () => {
    const { width, height } = fitWithin(10000, 3, 2048);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBe(1); // 3 * 2048 / 10000 rounds to 0
    expect(width).toBe(2048);
  });

  it("refuses dimensions that are not a real picture", () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [-1, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
    ]) {
      expect(() => fitWithin(w, h)).toThrow();
    }
  });

  it("defaults to the 2048 px long edge the server is sized for", () => {
    expect(fitWithin(4000, 3000)).toEqual(fitWithin(4000, 3000, CLIENT_MAX_EDGE));
  });
});

describe("what the browser is told to accept", () => {
  it("offers the file input exactly the three types the server accepts", () => {
    expect(FILE_INPUT_ACCEPT).toBe("image/jpeg,image/png,image/webp");
    expect([...ACCEPTED_UPLOAD_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("resizes to a size the server will accept, with the same body cap", () => {
    // The whole point of the client resize: its output cannot exceed the server's pixel limit.
    expect(CLIENT_MAX_EDGE * CLIENT_MAX_EDGE).toBe(MAX_INPUT_PIXELS);
    expect(CLIENT_MAX_BYTES).toBe(MAX_INPUT_BYTES);
    expect(CLIENT_QUALITY).toBeGreaterThan(0);
    expect(CLIENT_QUALITY).toBeLessThanOrEqual(1);
  });

  it("reports that it cannot run under Node, where there is no canvas", () => {
    expect(canResizeInBrowser()).toBe(false);
  });
});
