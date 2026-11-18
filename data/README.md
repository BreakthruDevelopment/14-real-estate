# ZIP centroid data

`zcta-centroids.csv.gz` holds one `zip,lat,lng` row per ZIP code (42,345 rows, 5-decimal degrees, gzipped CSV with a
header line). `src/lib/geo/zip-load.ts` loads it into `zip_centroid` at startup when that table is empty.

## What this file really is (read this before relying on it)

**It is NOT the US Census ZCTA Gazetteer file that spec decision D9 asks for.** The Census file could not be fetched
when this slice was built: `census.gov` and `www2.census.gov` are refused by the build environment's egress proxy.
Nothing here was typed in or invented; the coordinates come unchanged (rounded to 5 decimals) from the file below.

- **Source:** `https://raw.githubusercontent.com/midwire/free_zipcode_data/master/all_us_zipcodes.csv`
  (the `midwire/free_zipcode_data` repository, branch `master`, fetched 2026-11-17). Columns: `code,city,state,county,area_code,lat,lon`.
- **Source SHA-256** (the unmodified download, 2,072,181 bytes, 42,366 data rows):
  `808c04000fe8b1f26271ff4e8546cefdfe4daf1b1e490f507f1c5656ec903d35`
- **Shipped file SHA-256** (`data/zcta-centroids.csv.gz`, built with `gzip -9n`):
  `6f8182119a7f7501a2b481dcff807f0769db0cdddcc3e69045df4b636ba4b874`
- **Keyed by USPS ZIP code, not by ZCTA.** A ZCTA is the Census Bureau's area approximation of a ZIP's delivery area;
  this file lists postal ZIPs, so it includes PO-box and unique-organisation ZIPs that have no ZCTA (42,345 rows against
  about 33,800 ZCTAs). Coordinates are described by the upstream project as "estimated or zip-centroid", so they are
  approximate centres, not Census internal points. Spot check: 78704 is 30.24068, -97.76883 here, within about
  0.1 mile of the figure the template tests use. For a radius search of 1-50 miles that error is acceptable; it is
  not survey-grade.
- **Licence / provenance: not verified.** The repository has **no LICENSE file**. Its README says the data is licensed
  under Creative Commons Attribution 3.0 (carried forward from GeoNames), and its gemspec says MIT for the code. It also
  says the original 2011 data came from US Census sources and that GeoNames data was adopted from 2017. We could not
  establish which of those this particular file is, so we do not assert a licence for it. ZIP-to-coordinate facts are
  not creative expression, but the attribution requirement above (if the GeoNames route applies) is not met by us
  beyond this note. **Replace this file with the Census 2020 Gazetteer (public domain) before treating the data as clean.**

## Changes made to the source

- Dropped the `city`, `state`, `county` and `area_code` columns; renamed `lon` to `lng`.
- Removed 12 rows with no coordinates and collapsed duplicate ZIPs (the source repeats some rows; no ZIP had two different coordinates).
- Dropped 9 rows outside the app's US bounds (lat 17.5-71.5, lng -179 to -64). All of them have a longitude with the
  wrong sign (for example 99545 at 162.89), so they are source errors: `17335, 56902, 56904, 56950, 73451, 81075,
  81403, 84081, 99545`. The loader applies the same bounds, so it would skip them too.

## Replacing it with the Census file

Download the 2020 ZCTA Gazetteer (`2020_Gaz_zcta_national.zip`, tab separated: `GEOID`, `INTPTLAT`, `INTPTLONG`),
write `zip,lat,lng` rows, `gzip -9n` them to `zcta-centroids.csv.gz`, update the checksums above, and run
`pnpm test` (the loader test checks the row count against the file, so nothing else changes).
