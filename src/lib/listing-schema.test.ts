import { describe, expect, it } from "vitest";
import { FEATURES, GEO_BOUNDS, STATUS_TRANSITIONS, hideInput, inquiryInput, locationInput, newListingInput, roleInput, updateListingInput } from "./listing-schema";

const base = {
  title: "T",
  propertyType: "house",
  priceUsd: 100_000,
  beds: 2,
  baths: 1.5,
  addressLine: "1 Main",
  city: "Austin",
  state: "tx",
  zip: "78704",
  clientOpId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
};

describe("listing schemas", () => {
  it("fills optional facts with null/empty and normalises state", () => {
    expect(newListingInput.parse(base)).toMatchObject({ sqft: null, lotSqft: null, yearBuilt: null, features: [], description: "", agentNotes: "", state: "TX" });
  });

  it("a partial update doesn't bring defaults back (it would wipe stored values)", () => {
    const parsed = updateListingInput.parse({ version: 1, title: "New" });
    expect(parsed).toEqual({ version: 1, title: "New" });
  });

  it("rejects NUL in every free-text field", () => {
    for (const k of ["title", "addressLine", "city", "description", "agentNotes"]) {
      expect(newListingInput.safeParse({ ...base, [k]: "a\0b" }).success, k).toBe(false);
    }
    expect(inquiryInput.safeParse({ listingId: base.clientOpId, message: "a\0", clientOpId: base.clientOpId }).success).toBe(false);
    expect(hideInput.safeParse({ hidden: true, reason: "a\0" }).success).toBe(false);
    expect(roleInput.safeParse({ userId: "a\0", role: "agent" }).success).toBe(false);
  });

  it("keeps the feature list at 20 and unique keys", () => {
    expect(FEATURES).toHaveLength(20);
  });

  it("location: bounds and the device accuracy limit", () => {
    const v = { version: 1, lat: 30, lng: -97 };
    expect(locationInput.safeParse({ source: "device", ...v, accuracyM: 200 }).success).toBe(true);
    expect(locationInput.safeParse({ source: "device", ...v, accuracyM: 200.1 }).success).toBe(false);
    expect(locationInput.safeParse({ source: "manual", ...v, lat: GEO_BOUNDS.latMax + 0.01 }).success).toBe(false);
    expect(locationInput.safeParse({ source: "manual", ...v, lng: GEO_BOUNDS.lngMax + 0.01 }).success).toBe(false);
    expect(locationInput.safeParse({ source: "manual", ...v, lng: -179 }).success).toBe(true);
    expect(locationInput.safeParse({ source: "manual", ...v, lat: Infinity }).success).toBe(false);
  });

  it("status transitions: nothing leaves draft except to active; sold and withdrawn only relist", () => {
    expect(STATUS_TRANSITIONS.draft).toEqual(["active"]);
    expect(STATUS_TRANSITIONS.sold).toEqual(["active"]);
    expect(STATUS_TRANSITIONS.withdrawn).toEqual(["active"]);
  });

  it("roles can only be set to user or agent", () => {
    expect(roleInput.safeParse({ userId: "u", role: "admin" }).success).toBe(false);
    expect(roleInput.safeParse({ userId: "u", role: "agent" }).success).toBe(true);
  });
});
