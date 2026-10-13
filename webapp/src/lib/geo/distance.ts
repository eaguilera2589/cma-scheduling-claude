/**
 * Great-circle distance helpers for the route planner.
 * Pure math, no I/O — safe anywhere (lib code, unit tests, server or client).
 */

/** A geographic coordinate pair (decimal degrees, WGS84). */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Mean Earth radius in statute miles (IUGG mean radius 6371.0 km). */
const EARTH_RADIUS_MILES = 3958.7613;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Haversine great-circle distance between two points, in statute miles.
 * Accurate to well under 0.5% for the distances this app cares about
 * (single metro-area trips), which is far finer than the planner needs.
 */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(s)));
}
