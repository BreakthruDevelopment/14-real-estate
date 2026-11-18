import { describe, expect, it } from "vitest";
import { parseZipLine } from "./zip-load";

describe("parseZipLine", () => {
  it("parses a row and rejects the header, bad ZIPs and out-of-bounds points", () => {
    expect(parseZipLine("78704,30.24068,-97.76883")).toEqual({ zip: "78704", lat: 30.24068, lng: -97.76883 });
    expect(parseZipLine("zip,lat,lng")).toBeNull();
    expect(parseZipLine("7870,30.2,-97.7")).toBeNull();
    expect(parseZipLine("99545,59.95,162.89")).toBeNull(); // sign-flipped longitude
    expect(parseZipLine("78704,abc,-97.7")).toBeNull();
    expect(parseZipLine("")).toBeNull();
  });
});
