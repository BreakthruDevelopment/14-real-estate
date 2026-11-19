import { type SQL, sql } from "drizzle-orm";
import { EARTH_RADIUS_MILES } from "./distance";

/** Miles per degree of latitude on the same sphere the haversine uses (about 69.09). */
const MILES_PER_DEGREE = (EARTH_RADIUS_MILES * Math.PI) / 180;

export type Center = { lat: number; lng: number };
/** Column references (a Drizzle column or a raw `sql` fragment). */
export type GeoColumns = { lat: SQL | { name: string }; lng: SQL | { name: string } };

/** Bounds of a square that contains the circle. Longitude bounds are dropped near a pole, where they stop being meaningful. */
export function boundingBox(center: Center, miles: number) {
  const dLat = miles / MILES_PER_DEGREE;
  const latMin = center.lat - dLat;
  const latMax = center.lat + dLat;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const nearPole = Math.max(Math.abs(latMin), Math.abs(latMax)) >= 89.5 || cos < 1e-3;
  const dLng = nearPole ? null : dLat / cos;
  return {
    latMin,
    latMax,
    lngMin: dLng === null ? null : center.lng - dLng,
    lngMax: dLng === null ? null : center.lng + dLng,
  };
}

/** Haversine distance in miles from `center` to the row's lat/lng (3958.8 * 2 * asin(sqrt(...))). Also the displayed distance. */
export function distanceMilesSql(center: Center, cols: GeoColumns): SQL<number> {
  const lat = sql`${cols.lat}::float8`;
  const lng = sql`${cols.lng}::float8`;
  const cLat = sql`${center.lat}::float8`;
  const cLng = sql`${center.lng}::float8`;
  return sql<number>`(${EARTH_RADIUS_MILES}::float8 * 2 * asin(sqrt(least(1::float8,
    power(sin(radians(${lat} - ${cLat}) / 2), 2)
    + cos(radians(${cLat})) * cos(radians(${lat})) * power(sin(radians(${lng} - ${cLng}) / 2), 2)))))`;
}

/**
 * WHERE fragment for a radius search: the bounding box first (it can use the btree on status, lat, lng), then the
 * exact haversine cut. `miles` is clamped to 1-50.
 */
export function withinRadiusSql(center: Center, miles: number, cols: GeoColumns): SQL {
  const r = Math.min(50, Math.max(1, miles));
  const box = boundingBox(center, r);
  const parts: SQL[] = [sql`${cols.lat} between ${box.latMin}::float8 and ${box.latMax}::float8`];
  if (box.lngMin !== null && box.lngMax !== null) {
    parts.push(sql`${cols.lng} between ${box.lngMin}::float8 and ${box.lngMax}::float8`);
  }
  parts.push(sql`${distanceMilesSql(center, cols)} <= ${r}::float8`);
  return sql.join(parts, sql` and `);
}
