#!/usr/bin/env python3
"""Rebuild data/zcta-centroids.csv.gz from the upstream all_us_zipcodes.csv (see data/README.md).

Usage: python3 -I data/build-zip-centroids.py all_us_zipcodes.csv data/zcta-centroids.csv.gz

Keeps zip, lat, lon (renamed lng) rounded to 5 decimals; drops rows with no coordinates and rows outside the app's
US bounds (lat 17.5-71.5, lng -179 to -64); collapses duplicate ZIPs if any are present (the pinned source has
none -- 42,366 rows, 42,366 distinct codes -- so this step currently removes nothing, and it is not a change to
report under CC BY); sorts by ZIP. The gzip is `gzip -9n` (no name,
no timestamp), so the output is byte-identical to the committed file.
"""
import csv
import subprocess
import sys

LAT_MIN, LAT_MAX, LNG_MIN, LNG_MAX = 17.5, 71.5, -179.0, -64.0


def main(src: str, dst: str) -> None:
    rows: dict[str, tuple[float, float]] = {}
    no_coords = out_of_bounds = 0
    with open(src, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not r["lat"] or not r["lon"]:
                no_coords += 1
                continue
            lat, lng = float(r["lat"]), float(r["lon"])
            if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
                out_of_bounds += 1
                continue
            rows[r["code"]] = (round(lat, 5), round(lng, 5))
    text = "zip,lat,lng\n" + "".join(f"{z},{rows[z][0]:.5f},{rows[z][1]:.5f}\n" for z in sorted(rows))
    with open(dst, "wb") as out:  # the system gzip, so the bytes match a plain `gzip -9n` and the checksum is stable
        subprocess.run(["gzip", "-9n", "-c"], input=text.encode(), stdout=out, check=True)
    print(f"{len(rows)} ZIPs written; {no_coords} rows without coordinates, {out_of_bounds} out of bounds", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
