import { describe, expect, it } from "vitest";
import { haversineMiles } from "./distance";

describe("haversineMiles", () => {
  it("is zero for the same point", () => {
    expect(haversineMiles(30.2672, -97.7431, 30.2672, -97.7431)).toBe(0);
  });

  it("matches known city pairs within 0.5%", () => {
    // Austin TX to Dallas TX: about 182 mi. New York to Los Angeles: about 2,445 mi.
    const austinDallas = haversineMiles(30.2672, -97.7431, 32.7767, -96.797);
    expect(Math.abs(austinDallas - 182) / 182).toBeLessThan(0.005);
    const nyLa = haversineMiles(40.7128, -74.006, 34.0522, -118.2437);
    expect(Math.abs(nyLa - 2445) / 2445).toBeLessThan(0.005);
  });

  it("is symmetric and one degree of latitude is about 69 miles", () => {
    expect(haversineMiles(30, -97, 31, -97)).toBeCloseTo(69.09, 1);
    expect(haversineMiles(30, -97, 31, -96)).toBeCloseTo(haversineMiles(31, -96, 30, -97), 9);
  });
});
