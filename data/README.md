# ZIP centroid data

`zcta-centroids.csv.gz` holds one `zip,lat,lng` row per ZIP code (42,345 rows, 5-decimal degrees, gzipped CSV with a
header line). `src/lib/geo/zip-load.ts` loads it into `zip_centroid` at startup when that table is empty.

## Source, licence and attribution

**Licence: Creative Commons Attribution 3.0 Unported (CC BY 3.0), <https://creativecommons.org/licenses/by/3.0/>.**
Attribution is required, and the changes made are listed below.

- **Origin:** the zip-to-coordinate data is from [GeoNames](https://www.geonames.org) (postal code data, which GeoNames
  publishes under CC BY).
- **Compiled by:** Midwire Technologies, LLC, in the `midwire/free_zipcode_data` repository
  (`https://github.com/midwire/free_zipcode_data`). Its README, section "Data License", says: "The zipcode data is licensed
  under a Creative Commons Attribution 3.0 Unported License, carried forward from GeoNames." Their code (not the data) is
  MIT licensed, Copyright (c) 2017 Midwire Technologies, LLC (`LICENSE.md` in that repository).
- **File used:** `https://raw.githubusercontent.com/midwire/free_zipcode_data/master/all_us_zipcodes.csv`, fetched
  2026-11-17. Columns: `code,city,state,county,area_code,lat,lon`. The upstream README dates its original Census pull to
  2011 and its move to GeoNames to 2017; this file is from the GeoNames era, so CC BY 3.0 applies.
- **Source SHA-256** (the unmodified download, 2,072,181 bytes, 42,366 data rows):
  `808c04000fe8b1f26271ff4e8546cefdfe4daf1b1e490f507f1c5656ec903d35`
- **Shipped file SHA-256** (`data/zcta-centroids.csv.gz`):
  `6f8182119a7f7501a2b481dcff807f0769db0cdddcc3e69045df4b636ba4b874`
- **Rebuild it:** `python3 -I data/build-zip-centroids.py all_us_zipcodes.csv data/zcta-centroids.csv.gz`
  reproduces the shipped file byte for byte.

## What this file is, and is not

**It is not the US Census ZCTA Gazetteer** that spec decision D9 names; the Census file could not be fetched when this
slice was built (`census.gov` was refused by the build environment's egress proxy). Whether this data may stand in for
it is a scope decision for the project owner. It is keyed by **USPS ZIP code**, not ZCTA, so it includes PO-box and
unique-organisation ZIPs (42,345 rows against about 33,800 ZCTAs). Coordinates are described upstream as "estimated or
zip-centroid": approximate centres, fine for a 1-50 mile radius search, not survey-grade. Spot check: 78704 is
30.24068, -97.76883 here, within about 0.1 mile of the figure the template tests use.

## Changes made to the source (CC BY requires this)

- Dropped the `city`, `state`, `county` and `area_code` columns; renamed `lon` to `lng`.
- Removed 12 rows with no coordinates. No duplicates needed collapsing: the source has 42,366 rows and 42,366
  distinct ZIP codes, and 42,366 - 12 - 9 = 42,345 exactly.
- Dropped 9 rows outside the app's US bounds (lat 17.5-71.5, lng -179 to -64): `17335, 56902, 56904, 56950, 73451,
  81075, 81403, 84081, 99545`. All nine are source errors, but not all for the same reason. **Seven** carry a
  longitude with the wrong sign and fall inside the bounds once it is negated (for example 99545 at 162.89).
  The other **two** are wrong in some further way: negating the longitude of `73451` (59.580, 16.230) or `81075`
  (37.040, 35.310) puts both in the mid-Atlantic, and neither is near the ZIP it claims. The loader applies the same
  bounds, so it would skip all nine anyway.

## Replacing it with the Census file (if the owner decides so)

Download the 2020 ZCTA Gazetteer (`2020_Gaz_zcta_national.zip`, tab separated: `GEOID`, `INTPTLAT`, `INTPTLONG`),
write `zip,lat,lng` rows, `gzip -9n` them to `zcta-centroids.csv.gz`, update the checksums and the licence section above, and run
`pnpm test` (the loader test checks the row count against the file, so nothing else changes).
