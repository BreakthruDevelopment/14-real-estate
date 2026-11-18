import { describe, expect, it } from "vitest";
import { haversineMiles } from "./distance";
import { boundingBox } from "./sql";

describe("boundingBox", () => {
  it("contains every point within the radius, in every direction", () => {
    const c = { lat: 30.24, lng: -97.77 };
    for (const miles of [1, 10, 50]) {
      const b = boundingBox(c, miles);
      for (let deg = 0; deg < 360; deg += 5) {
        const rad = (deg * Math.PI) / 180;
        const lat = c.lat + (miles / 69.0934) * Math.cos(rad) * 0.999;
        const lng = c.lng + ((miles / 69.0934) * Math.sin(rad) * 0.999) / Math.cos((c.lat * Math.PI) / 180);
        expect(haversineMiles(c.lat, c.lng, lat, lng)).toBeLessThanOrEqual(miles * 1.001);
        expect(lat).toBeGreaterThanOrEqual(b.latMin);
        expect(lat).toBeLessThanOrEqual(b.latMax);
        expect(lng).toBeGreaterThanOrEqual(b.lngMin as number);
        expect(lng).toBeLessThanOrEqual(b.lngMax as number);
      }
    }
  });

  it("is wider in longitude than latitude away from the equator", () => {
    const b = boundingBox({ lat: 60, lng: -150 }, 10);
    expect((b.lngMax as number) - (b.lngMin as number)).toBeGreaterThan(b.latMax - b.latMin);
  });

  it("drops the longitude bounds near a pole", () => {
    expect(boundingBox({ lat: 89.9, lng: 0 }, 10).lngMin).toBeNull();
  });
});
