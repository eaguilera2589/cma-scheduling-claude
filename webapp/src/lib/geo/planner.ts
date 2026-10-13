/**
 * Route planner for the "end the day near home" heuristic.
 *
 * Pure functions — no fs, no network, no env reads. Coordinates come in on
 * the stops; the home coordinate is an explicit parameter (geocoding home is
 * the caller's job via lib/geo/geocode). This keeps the planner trivially
 * unit-testable and free of side effects.
 *
 * Grouping: stops are grouped strictly by city string (case-insensitive,
 * trimmed). Cities are ordered by their farthest stop's distance from home,
 * descending (farthest city's day first); ties break on the lowercased city
 * name ascending, so the order is fully deterministic.
 *
 * Within a city (n = number of stops):
 *  - grade 1 is pinned to the stop FARTEST from home (the day starts by
 *    driving out to the far end), and the LAST grade is pinned to the stop
 *    CLOSEST to home (the day ends near home). For n>=2 these are distinct
 *    stops; with distance ties the first maximum and the last minimum (in
 *    input order) are taken, preferring a stop different from the pinned
 *    first one.
 *  - The middle stops (if any) are chained with nearest-neighbor from the
 *    first stop, then a 2-opt improvement pass runs that only ever reverses
 *    sub-paths between the two pinned endpoints — so both pinned invariants
 *    survive every accepted move.
 *
 * Legs: grade 1's legMiles is home -> stop1 (the outbound drive); later
 * grades' legMiles is previous stop -> stop. cumulativeMiles sums the legs
 * so far; CityPlan.totalMiles adds the return leg (last stop -> home).
 *
 * dueWarning is a SOFT flag only: true when the stop's dueDate is in the
 * past or lands within the next 3 days relative to `now`. It never
 * reorders or excludes anything.
 */
import { haversineMiles, type GeoPoint } from './distance';

export interface PlacedStop {
  caseNumber: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  dueDate?: Date | null;
}

export interface PlannedStop extends PlacedStop {
  /** 1-based position in the day's route. */
  grade: number;
  /** Miles driven to reach this stop (home -> stop1 for grade 1). */
  legMiles: number;
  /** Sum of legs from home through this stop. */
  cumulativeMiles: number;
  /** Due in the past or within DUE_WARNING_WINDOW_DAYS of `now`. */
  dueWarning: boolean;
}

export interface CityPlan {
  city: string;
  /** Route legs plus the return leg last stop -> home. */
  totalMiles: number;
  stops: PlannedStop[];
}

/** Days ahead of `now` inside which a due date raises the soft warning. */
export const DUE_WARNING_WINDOW_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/** Smallest distance gain worth a 2-opt move; guards float churn / loops. */
const EPS = 1e-9;

function point(stop: PlacedStop): GeoPoint {
  return { lat: stop.lat, lng: stop.lng };
}

/**
 * Order one city's stops: farthest-from-home first, nearest-to-home last,
 * middles by NN + endpoint-pinned 2-opt. Returns indices into `stops`.
 */
function orderCity(stops: PlacedStop[], home: GeoPoint): number[] {
  const n = stops.length;
  if (n <= 1) return n === 1 ? [0] : [];

  const distHome = stops.map((s) => haversineMiles(home, point(s)));

  // Pinned first: first stop at the maximum distance from home.
  let first = 0;
  for (let i = 1; i < n; i++) {
    if (distHome[i] > distHome[first]) first = i;
  }

  // Pinned last: stop closest to home among the others; ties prefer the
  // later index so a full-distance-tie still yields a distinct stop.
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (i === first) continue;
    if (last === -1 || distHome[i] <= distHome[last]) last = i;
  }

  // Middle stops in their original input order (stable, deterministic).
  const rest: number[] = [];
  for (let i = 0; i < n; i++) if (i !== first && i !== last) rest.push(i);

  // Nearest-neighbor chain from `first` through the middles.
  const path: number[] = [first];
  let cursor = first;
  while (rest.length > 0) {
    let pick = 0;
    for (let i = 1; i < rest.length; i++) {
      if (haversineMiles(point(stops[rest[i]]), point(stops[cursor])) <
          haversineMiles(point(stops[rest[pick]]), point(stops[cursor]))) {
        pick = i;
      }
    }
    cursor = rest[pick];
    path.push(rest.splice(pick, 1)[0]);
  }
  path.push(last);

  twoOpt(path, stops);
  return path;
}

/**
 * In-place constrained 2-opt: only reverses sub-arrays path[a..b] with
 * 1 <= a < b <= path.length-2, so the pinned endpoints (indices 0 and n-1)
 * never move. First-improvement, repeated until a clean pass.
 */
function twoOpt(path: number[], stops: PlacedStop[]): void {
  const n = path.length;
  if (n < 4) return; // no interior segment to reverse
  // Hard cap: each accepted move strictly shortens the path by > EPS; this
  // just bounds the worst case far below anything reachable at these sizes.
  let budget = n * n * n;
  let improved = true;
  while (improved && budget-- > 0) {
    improved = false;
    for (let a = 1; a <= n - 2 && !improved; a++) {
      for (let b = a + 1; b <= n - 2; b++) {
        const before =
          haversineMiles(point(stops[path[a - 1]]), point(stops[path[a]])) +
          haversineMiles(point(stops[path[b]]), point(stops[path[b + 1]]));
        const after =
          haversineMiles(point(stops[path[a - 1]]), point(stops[path[b]])) +
          haversineMiles(point(stops[path[a]]), point(stops[path[b + 1]]));
        if (before - after > EPS) {
          const seg = path.slice(a, b + 1).reverse();
          path.splice(a, b - a + 1, ...seg);
          improved = true;
          break;
        }
      }
    }
  }
}

function isDueWarning(dueDate: Date | null | undefined, now: Date): boolean {
  if (!dueDate) return false;
  return dueDate.getTime() - now.getTime() <= DUE_WARNING_WINDOW_DAYS * MS_PER_DAY;
}

/**
 * Plan one day per city. See the module header for ordering rules.
 * `now` only feeds dueWarning (defaulting to the wall clock); pass an
 * explicit Date in tests for determinism.
 */
export function planRoutes(stops: PlacedStop[], home: GeoPoint, now: Date = new Date()): CityPlan[] {
  // Group strictly by normalized city; display name = first trimmed city seen.
  const groups = new Map<string, { city: string; stops: PlacedStop[] }>();
  for (const stop of stops) {
    const key = stop.city.trim().toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.stops.push(stop);
    } else {
      groups.set(key, { city: stop.city.trim(), stops: [stop] });
    }
  }

  // Cities: farthest max-distance-from-home day first; ties by name asc.
  const maxDist = (group: { stops: PlacedStop[] }): number =>
    Math.max(...group.stops.map((s) => haversineMiles(home, point(s))));
  const orderedKeys = [...groups.keys()].sort((ka, kb) => {
    const ga = groups.get(ka)!;
    const gb = groups.get(kb)!;
    return maxDist(gb) - maxDist(ga) || ka.localeCompare(kb);
  });

  return orderedKeys.map((key) => {
    const group = groups.get(key)!;
    const order = orderCity(group.stops, home);

    const planned: PlannedStop[] = [];
    let cumulative = 0;
    let prev: GeoPoint = home;
    order.forEach((idx, position) => {
      const stop = group.stops[idx];
      const legMiles = position === 0
        ? haversineMiles(home, point(stop)) // outbound leg, home -> stop 1
        : haversineMiles(prev, point(stop));
      cumulative += legMiles;
      prev = point(stop);
      planned.push({
        ...stop,
        grade: position + 1,
        legMiles,
        cumulativeMiles: cumulative,
        dueWarning: isDueWarning(stop.dueDate, now),
      });
    });

    const lastPoint = order.length > 0 ? point(group.stops[order[order.length - 1]]) : home;
    const totalMiles = order.length > 0 ? cumulative + haversineMiles(lastPoint, home) : 0;
    return { city: group.city, totalMiles, stops: planned };
  });
}
