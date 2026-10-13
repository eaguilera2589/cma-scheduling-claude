/**
 * Route-handler logic for GET /api/plan — the Route Planner feed. Same
 * injectable-deps, Next-free factory pattern as handlers.ts so the node:test
 * suite can exercise it without a server or the network; src/app/api/plan/
 * route.ts wires it to the App Router with production deps.
 *
 * Behavior:
 *  - Loads inspections from the configured data source (same seam as
 *    /api/inspections) and filters by scope: default = OPEN (unscheduled —
 *    the same `dateScheduledFor` blank predicate the board uses), plus
 *    `?scope=scheduled` and `?scope=all`.
 *  - Geocodes each scoped row's location; rows that resolve to null go to
 *    the `unresolved` bucket (never silently dropped from the response).
 *  - Runs the pure planner (lib/geo/planner) over the placed stops and
 *    enriches each planned stop with display fields (insured name, raw due
 *    date, Rush/Escalated flags) that live on the Inspection, not on the
 *    planner's PlacedStop.
 *  - A GeocodeConfigError anywhere (no GOOGLE_MAPS_API_KEY and a cold cache,
 *    or Google REQUEST_DENIED) is an operator-fixable setup problem, so it
 *    answers 200 + `configError` + empty cities — never 500 — and the UI
 *    shows the setup banner.
 */
import { parseMMDDYYYY } from '../dates';
import { GeocodeConfigError, type GeoPoint } from '../geo/geocode';
import { planRoutes, type PlannedStop } from '../geo/planner';
import type { Inspection } from '../types';
import { rowFlags } from '../../components/flags';

export type PlanScope = 'unscheduled' | 'scheduled' | 'all';

/** A planned stop plus the display fields the planner knows nothing about. */
export interface PlannedStopView extends PlannedStop {
  insuredName: string;
  /** Raw "MM/DD/YYYY" (or "") for display; dueWarning is the flag. */
  inspectionDue: string;
  /** "Rush" / "Escalated" labels, per components/flags.ts. */
  flags: string[];
}

/** CityPlan with enriched stops; order is exactly the planner's (do not re-sort). */
export interface CityPlanView {
  city: string;
  totalMiles: number;
  stops: PlannedStopView[];
}

export interface UnresolvedStop {
  caseNumber: string;
  address: string;
  city: string;
}

export interface PlanResponse {
  generatedAt: string;
  home: GeoPoint | null;
  cities: CityPlanView[];
  unresolved: UnresolvedStop[];
  /** Present (with empty cities) when geocoding is not configured. */
  configError?: string;
}

export interface PlanHandlerDeps {
  loadInspections: () => Promise<Inspection[]>;
  geocodeLocation: (inspection: Inspection) => Promise<GeoPoint | null>;
  geocodeHome: () => Promise<GeoPoint | null>;
  /** Clock seam for deterministic dueWarning/generatedAt in tests. */
  now?: () => Date;
}

/** Same predicate as the board's "Needs Scheduling" tab. */
function isUnscheduled(row: Inspection): boolean {
  return row.dateScheduledFor.trim() === '';
}

function scopeRows(rows: Inspection[], scope: PlanScope): Inspection[] {
  if (scope === 'all') return rows;
  if (scope === 'scheduled') return rows.filter((r) => !isUnscheduled(r));
  return rows.filter(isUnscheduled);
}

function scopeOf(request: Request): PlanScope {
  let raw: string | null = null;
  try {
    raw = new URL(request.url).searchParams.get('scope');
  } catch {
    // A non-parsable URL just means no scope filter could be read; default.
  }
  return raw === 'scheduled' || raw === 'all' ? raw : 'unscheduled';
}

/**
 * Canonical message for the plain "key not set" case (what the setup banner
 * targets); anything else (e.g. REQUEST_DENIED) keeps its diagnostic text.
 */
function configErrorMessage(err: GeocodeConfigError): string {
  return err.message.includes('GOOGLE_MAPS_API_KEY is not set')
    ? 'GOOGLE_MAPS_API_KEY is not set'
    : err.message;
}

/**
 * GET /api/plan — day plans per city for the scoped inspection pool, in the
 * planner's order (farthest city day first; grades 1..n farthest→closest).
 * 200 + configError when geocoding is misconfigured; 502 when the inspection
 * source itself is unreachable.
 */
export function makePlanHandler(deps: PlanHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const now = (deps.now ?? (() => new Date()))();
    const scope = scopeOf(request);

    let rows: Inspection[];
    try {
      rows = await deps.loadInspections();
    } catch (err) {
      console.error('[api/plan] failed to load data:', err);
      return Response.json(
        { error: 'Failed to load inspections from the Google Sheet.' },
        { status: 502 }
      );
    }
    const scoped = scopeRows(rows, scope);

    // Home first, then one point per scoped row, all in parallel. The file
    // geocoder is cache-first but does NOT de-dupe concurrent misses: on a
    // cold cache these fan out to Google in parallel (duplicate addresses
    // included). Normal serving hits a warm cache, so fan-out is rare.
    let home: GeoPoint | null;
    let points: (GeoPoint | null)[];
    try {
      const results = await Promise.all([
        deps.geocodeHome(),
        ...scoped.map((row) => deps.geocodeLocation(row)),
      ]);
      home = results[0];
      points = results.slice(1);
    } catch (err) {
      if (err instanceof GeocodeConfigError) {
        return Response.json({
          generatedAt: now.toISOString(),
          home: null,
          cities: [],
          unresolved: [],
          configError: configErrorMessage(err),
        } satisfies PlanResponse);
      }
      console.error('[api/plan] geocoding failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: 'Geocoding failed unexpectedly.', detail: message },
        { status: 500 }
      );
    }

    const unresolved: UnresolvedStop[] = [];
    scoped.forEach((row, i) => {
      if (!points[i]) {
        unresolved.push({
          caseNumber: row.caseNumber,
          address: row.locationAddress,
          city: row.locationCity,
        });
      }
    });

    if (!home) {
      // The HOME address itself is a cached geocode failure — no route can be
      // planned at all. Setup problem, so the same 200 + configError contract;
      // unresolved (addresses that failed on their own) is still reported.
      return Response.json({
        generatedAt: now.toISOString(),
        home: null,
        cities: [],
        unresolved,
        configError:
          'Could not geocode the home address — check HOME_ADDRESS and the geo cache.',
      } satisfies PlanResponse);
    }

    const placed = scoped
      .map((row, i) => {
        const p = points[i];
        if (!p) return null;
        return {
          caseNumber: row.caseNumber,
          address: row.locationAddress,
          city: row.locationCity.trim(),
          lat: p.lat,
          lng: p.lng,
          dueDate: parseMMDDYYYY(row.inspectionDue),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);

    // Display enrichment keyed by caseNumber (planner stops carry no name/flags).
    const byCase = new Map(scoped.map((row) => [row.caseNumber, row]));
    const cities: CityPlanView[] = planRoutes(placed, home, now).map(
      (plan): CityPlanView => ({
        city: plan.city,
        totalMiles: plan.totalMiles,
        stops: plan.stops.map((stop): PlannedStopView => {
          const row = byCase.get(stop.caseNumber);
          return {
            ...stop,
            insuredName: row?.insuredName ?? '',
            inspectionDue: row?.inspectionDue ?? '',
            flags: row ? rowFlags(row) : [],
          };
        }),
      })
    );

    return Response.json({
      generatedAt: now.toISOString(),
      home,
      cities,
      unresolved,
    } satisfies PlanResponse);
  };
}
