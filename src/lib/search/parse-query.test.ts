import { describe, expect, it } from "vitest";
import { hasSearchableText, mergeFilters, parseQuery } from "./parse-query";

describe("parseQuery", () => {
  it('"under 450k" is a maximum of 450,000 (inclusive)', () => {
    const r = parseQuery("craftsman under 450k");
    expect(r.filters.maxPrice).toBe(450_000);
    expect(r.filters.minPrice).toBeUndefined();
    expect(r.residual).toBe("craftsman");
  });

  it("reads a dollar range with an en dash, a hyphen or 'to'", () => {
    for (const q of ["$300,000–$500,000", "$300,000-$500,000", "300k to 500k", "$500,000 - $300,000"]) {
      const r = parseQuery(`bungalow ${q}`);
      expect(r.filters, q).toMatchObject({ minPrice: 300_000, maxPrice: 500_000 });
      expect(r.residual, q).toBe("bungalow");
    }
  });

  it("reads 'over' as a minimum and understands m and plain numbers", () => {
    expect(parseQuery("over $1.2m").filters.minPrice).toBe(1_200_000);
    expect(parseQuery("under $450000").filters.maxPrice).toBe(450_000);
    expect(parseQuery("below 1,000,000").filters.maxPrice).toBe(1_000_000);
  });

  it("ignores prices outside 1k-100M", () => {
    expect(parseQuery("under 5").filters.maxPrice).toBeUndefined();
    expect(parseQuery("under 500m").filters.maxPrice).toBeUndefined();
  });

  it('reads "3 bed" and "2+ ba" as minimums', () => {
    const r = parseQuery("3 bed 2+ ba with a pool");
    expect(r.filters).toMatchObject({ minBeds: 3, minBaths: 2 });
    expect(r.residual).toBe("with a pool");
    expect(parseQuery("4 bedrooms").filters.minBeds).toBe(4);
    expect(parseQuery("2.5 baths").filters.minBaths).toBe(2.5);
    expect(parseQuery("3+ bed").filters.minBeds).toBe(3);
  });

  it("reads property types", () => {
    expect(parseQuery("a house").filters.propertyType).toBe("house");
    expect(parseQuery("downtown condo").filters.propertyType).toBe("condo");
    expect(parseQuery("townhouse").filters.propertyType).toBe("townhouse");
    expect(parseQuery("land").filters.propertyType).toBe("land");
    expect(parseQuery("multi-family").filters.propertyType).toBe("multi_family");
    expect(parseQuery("multifamily near water").filters.propertyType).toBe("multi_family");
  });

  it('reads "near 78704" and "in 78704"', () => {
    const near = parseQuery("quiet street near 78704");
    expect(near.filters.zip).toBe("78704");
    expect(near.residual).toBe("quiet street");
    expect(parseQuery("condo in 78704").filters.zip).toBe("78704");
  });

  it('reads "within N mi" and clamps the radius to 1-50', () => {
    expect(parseQuery("house near 78704 within 10 mi").filters).toMatchObject({ zip: "78704", radiusMiles: 10 });
    expect(parseQuery("within 5 miles").filters.radiusMiles).toBe(5);
    expect(parseQuery("within 200 mi").filters.radiusMiles).toBe(50);
    expect(parseQuery("within 0 mi").filters.radiusMiles).toBe(1);
  });

  it("parses a full sentence and leaves the descriptive words", () => {
    const r = parseQuery("3 bed 2+ ba house under 450k near 78704 within 10 mi with a big yard");
    expect(r.filters).toEqual({ maxPrice: 450_000, minBeds: 3, minBaths: 2, propertyType: "house", zip: "78704", radiusMiles: 10 });
    expect(r.residual).toBe("with a big yard");
  });

  it("leaves plain text alone and handles empty input", () => {
    expect(parseQuery("sunny kitchen")).toEqual({ filters: {}, residual: "sunny kitchen" });
    expect(parseQuery("")).toEqual({ filters: {}, residual: "" });
  });

  it('does not read "lots of" or "a lot of" as land, but still reads a lot', () => {
    expect(parseQuery("lots of natural light").filters.propertyType).toBeUndefined();
    expect(parseQuery("lots of natural light").residual).toBe("lots of natural light");
    expect(parseQuery("a lot of space").filters.propertyType).toBeUndefined();
    expect(parseQuery("vacant lot").filters.propertyType).toBe("land");
  });

  it("still reads the plural lots as land, and the 'of' check survives spacing and case", () => {
    expect(parseQuery("two building lots").filters.propertyType).toBe("land");
    expect(parseQuery("corner lots available").filters.propertyType).toBe("land");
    expect(parseQuery("lots  of   light").filters.propertyType).toBeUndefined(); // multiple spaces
    expect(parseQuery("LOTS OF light").filters.propertyType).toBeUndefined(); // case
    expect(parseQuery("lots\nof light").filters.propertyType).toBeUndefined(); // newline
  });

  it("does not treat a bare 5-digit number without near/in as a ZIP", () => {
    expect(parseQuery("78704").filters.zip).toBeUndefined();
  });
});

describe("mergeFilters", () => {
  it("lets form values win over parsed ones and keeps parsed values the form left out", () => {
    const parsed = parseQuery("house under 450k 3 bed near 78704").filters;
    const merged = mergeFilters(parsed, { maxPrice: 300_000, zip: "10001" });
    expect(merged).toMatchObject({ maxPrice: 300_000, zip: "10001", minBeds: 3, propertyType: "house" });
  });

  it("ignores undefined form values", () => {
    expect(mergeFilters({ maxPrice: 450_000 }, { maxPrice: undefined }).maxPrice).toBe(450_000);
  });
});

describe("hasSearchableText", () => {
  it("needs at least three letters", () => {
    expect(hasSearchableText("")).toBe(false);
    expect(hasSearchableText("a 12")).toBe(false);
    expect(hasSearchableText("pool")).toBe(true);
  });
});
