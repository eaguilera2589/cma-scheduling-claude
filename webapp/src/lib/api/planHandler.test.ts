/**
 * GET /api/plan handler tests against injected fakes — no Next server, no
 * network, no geo cache. Covers: scope filtering (default unscheduled /
 * scheduled / all), the unresolved bucket, the 200 + configError paths for
 * GeocodeConfigError and an un-plannable home (never a 500), due-date parsing
 * into the planner (dueWarning), display enrichment, planner order
 * passthrough, and the 502 data-source failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePlanHandler, type PlanHandlerDeps } from './planHandler';
import { GeocodeConfigError, type GeoPoint } from '../geo/geocode';
import { EMPTY_INSPECTION, type Inspection } from '../types';

// Degree-space coordinates (same trick as planner.test): tiny deltas where
// haversine ≈ scaled Euclidean, so expected orderings are easy to verify.
const HOME: GeoPoint = { lat: 0, lng: 0 };
const NOW = new Date('2026-10-13T12:00:00Z');
const FAR: GeoPoint = { lat: 0, lng: 2 }; // ~137 mi from HOME
const NEAR: GeoPoint = { lat: 0, lng: 0.5 };

function insp(overrides: Partial<Inspection>): Inspection {
  return { ...EMPTY_INSPECTION, ...overrides };
}

interface PlanDepsOptions {
  rows: Inspection[];
  /** Geocoded point (or null = unresolved) per caseNumber. */
  points?: Record<string, GeoPoint | null>;
  /** geocodeHome result; default HOME. Set null for a cached home failure. */
  home?: GeoPoint | null;
  homeThrows?: Error;
  loadThrows?: boolean;
}

function planDeps(opts: PlanDepsOptions) {
  const geocoded: string[] = [];
  const deps: PlanHandlerDeps = {
    loadInspections: async () => {
      if (opts.loadThrows) throw new Error('sheet down');
      return opts.rows;
    },
    geocodeHome: async () => {
      if (opts.homeThrows) throw opts.homeThrows;
      return opts.home === undefined ? HOME : opts.home;
    },
    geocodeLocation: async (i: Inspection) => {
      geocoded.push(i.caseNumber);
      const p = opts.points?.[i.caseNumber];
      return p === undefined ? { lat: 0.1, lng: 0.1 } : p; // an explicit null stays unresolved
    },
    now: () => NOW,
  };
  return { deps, geocoded };
}

function request(scope?: string): Request {
  return new Request(`http://localhost/api/plan${scope ? `?scope=${scope}` : ''}`);
}

/** cities flattened to "city:case(case)…", preserving server order exactly. */
function cityShape(json: {
  cities: { city: string; stops: { caseNumber: string }[] }[];
}): string {
  return json.cities
    .map((c) => `${c.city}:${c.stops.map((s) => s.caseNumber).join(',')}`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Scope filtering

test('plan: default scope is unscheduled (dateScheduledFor blank predicate)', async () => {
  const d = planDeps({
    rows: [
      insp({ caseNumber: 'A', locationCity: 'Tampa' }),
      insp({ caseNumber: 'B', locationCity: 'Tampa', dateScheduledFor: '10/20/2026' }),
      insp({ caseNumber: 'C', locationCity: 'Tampa', dateScheduledFor: '   ' }),
    ],
  });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.unresolved, []);
  assert.equal(cityShape(json), 'Tampa:A,C', 'blank and whitespace scheduled count as open');
  assert.deepEqual(d.geocoded, ['A', 'C'], 'scheduled rows are never geocoded');
});

test('plan: ?scope=scheduled keeps only dated rows; ?scope=all keeps everything; unknown value falls back to unscheduled', async () => {
  const rows = [
    insp({ caseNumber: 'A', locationCity: 'Tampa' }),
    insp({ caseNumber: 'B', locationCity: 'Tampa', dateScheduledFor: '10/20/2026' }),
  ];

  const sched = planDeps({ rows });
  const json1 = await (await makePlanHandler(sched.deps)(request('scheduled'))).json();
  assert.equal(cityShape(json1), 'Tampa:B');
  assert.deepEqual(sched.geocoded, ['B']);

  const all = planDeps({ rows });
  const json2 = await (await makePlanHandler(all.deps)(request('all'))).json();
  assert.equal(cityShape(json2), 'Tampa:A,B');

  const junk = planDeps({ rows });
  const json3 = await (await makePlanHandler(junk.deps)(request('nonsense'))).json();
  assert.equal(cityShape(json3), 'Tampa:A', 'unrecognized scope defaults to the open pool');
});

// ---------------------------------------------------------------------------
// Unresolved bucketing

test('plan: null-geocoded stops land in unresolved, never in cities', async () => {
  const d = planDeps({
    rows: [
      insp({ caseNumber: 'A', locationAddress: '1 Main St', locationCity: 'Tampa' }),
      insp({ caseNumber: 'B', locationAddress: '9 Nowhere Rd', locationCity: 'Brandon' }),
    ],
    points: { B: null },
  });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(cityShape(json), 'Tampa:A');
  assert.deepEqual(json.unresolved, [{ caseNumber: 'B', address: '9 Nowhere Rd', city: 'Brandon' }]);
});

// ---------------------------------------------------------------------------
// Config-error paths: 200 + configError + empty cities, never a 500

test('plan: GeocodeConfigError from home geocode → 200, canonical configError, empty cities', async () => {
  const d = planDeps({
    rows: [insp({ caseNumber: 'A', locationCity: 'Tampa' })],
    homeThrows: new GeocodeConfigError(
      'GOOGLE_MAPS_API_KEY is not set — cannot geocode "4305 Glendon Place, Valrico, FL" (cache miss).'
    ),
  });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 200, 'a missing key must not 500');
  const json = await res.json();
  assert.equal(json.configError, 'GOOGLE_MAPS_API_KEY is not set');
  assert.deepEqual(json.cities, []);
  assert.equal(json.home, null);
});

test('plan: GeocodeConfigError from a stop geocode → same 200 + configError path', async () => {
  const deps: PlanHandlerDeps = {
    loadInspections: async () => [insp({ caseNumber: 'A', locationCity: 'Tampa' })],
    geocodeHome: async () => HOME,
    geocodeLocation: async () => {
      throw new GeocodeConfigError('GOOGLE_MAPS_API_KEY is not set — cannot geocode "1 Main St, Tampa, FL".');
    },
    now: () => NOW,
  };
  const res = await makePlanHandler(deps)(request());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.configError, 'GOOGLE_MAPS_API_KEY is not set');
  assert.deepEqual(json.cities, []);
});

test('plan: non-"key not set" config error keeps its diagnostic message', async () => {
  const d = planDeps({
    rows: [insp({ caseNumber: 'A', locationCity: 'Tampa' })],
    homeThrows: new GeocodeConfigError('Google Geocoding API denied the request — check GOOGLE_MAPS_API_KEY.'),
  });
  const json = await (await makePlanHandler(d.deps)(request())).json();
  assert.match(json.configError, /denied the request/);
});

test('plan: home geocode resolves to null (cached failure) → 200 + home-focused configError, unresolved still listed', async () => {
  const d = planDeps({
    rows: [
      insp({ caseNumber: 'A', locationCity: 'Tampa' }),
      insp({ caseNumber: 'B', locationAddress: '9 Nowhere Rd', locationCity: 'Brandon' }),
    ],
    home: null,
    points: { B: null },
  });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.cities, []);
  assert.match(json.configError, /home address/i);
  assert.deepEqual(json.unresolved, [{ caseNumber: 'B', address: '9 Nowhere Rd', city: 'Brandon' }]);
});

// ---------------------------------------------------------------------------
// Data-source failure

test('plan: inspection load failure → 502 with a load error, not a plan payload', async () => {
  const d = planDeps({ rows: [], loadThrows: true });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error, /Failed to load inspections/);
});

// ---------------------------------------------------------------------------
// Due-date parsing → planner dueWarning, and display enrichment

test('plan: inspectionDue parses via parseMMDDYYYY into dueWarning', async () => {
  const d = planDeps({
    rows: [
      insp({ caseNumber: 'OVER', locationCity: 'Tampa', inspectionDue: '01/01/2026' }), // long past
      insp({ caseNumber: 'FAR', locationCity: 'Tampa', inspectionDue: '12/31/2026' }), // far future
      insp({ caseNumber: 'NONE', locationCity: 'Tampa', inspectionDue: '' }),
      insp({ caseNumber: 'JUNK', locationCity: 'Tampa', inspectionDue: 'not-a-date' }),
    ],
  });
  const json = await (await makePlanHandler(d.deps)(request())).json();
  const byCase = Object.fromEntries(
    json.cities[0].stops.map((s: { caseNumber: string }) => [s.caseNumber, s])
  );
  assert.equal(byCase.OVER.dueWarning, true, 'past due date warns');
  assert.equal(byCase.FAR.dueWarning, false, 'far-future due date does not warn');
  assert.equal(byCase.NONE.dueWarning, false, 'blank due date never warns');
  assert.equal(byCase.JUNK.dueWarning, false, 'malformed due date parses to null, never warns');
  // The Date survives JSON serialization as an ISO string; null stays null.
  assert.equal(new Date(byCase.OVER.dueDate).getTime(), new Date(2026, 0, 1).getTime());
  assert.equal(byCase.NONE.dueDate, null);
});

test('plan: stops are enriched with insured name, raw due string, and flags', async () => {
  const d = planDeps({
    rows: [
      insp({
        caseNumber: 'A',
        locationCity: 'Tampa',
        insuredName: 'Jane Doe',
        inspectionDue: '11/02/2026',
        rush: 'Y',
        escalated: 'y',
      }),
    ],
  });
  const json = await (await makePlanHandler(d.deps)(request())).json();
  const stop = json.cities[0].stops[0];
  assert.equal(stop.insuredName, 'Jane Doe');
  assert.equal(stop.inspectionDue, '11/02/2026');
  assert.deepEqual(stop.flags, ['Rush', 'Escalated']);
});

// ---------------------------------------------------------------------------
// Planner order passthrough (farthest city first, grades 1..n)

test('plan: cities and grades come through in exact planner order, nothing re-sorted', async () => {
  const d = planDeps({
    rows: [
      // Input order deliberately puts the near city first; Tampa's FAR stop is
      // farthest from home, so Tampa's day must be planned first.
      insp({ caseNumber: 'N1', locationCity: 'Brandon' }),
      insp({ caseNumber: 'F1', locationCity: 'Tampa' }),
      insp({ caseNumber: 'N2', locationCity: 'Brandon' }),
    ],
    points: { F1: FAR, N1: NEAR, N2: { lat: 0, lng: 0.4 } },
  });
  const json = await (await makePlanHandler(d.deps)(request())).json();
  assert.equal(cityShape(json), 'Tampa:F1 | Brandon:N1,N2');
  assert.deepEqual(
    json.cities.map((c: { stops: { grade: number }[] }) => c.stops.map((s: { grade: number }) => s.grade)),
    [[1], [1, 2]],
    'grades stay 1..n in returned order'
  );
  assert.ok(json.cities[0].totalMiles > json.cities[1].totalMiles, 'sanity: far city drives more');
  assert.deepEqual(json.home, HOME);
  assert.equal(json.generatedAt, NOW.toISOString());
});

test('plan: empty open pool → 200 with empty cities and no configError', async () => {
  const d = planDeps({ rows: [insp({ caseNumber: 'B', locationCity: 'Tampa', dateScheduledFor: '10/20/2026' })] });
  const res = await makePlanHandler(d.deps)(request());
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.cities, []);
  assert.deepEqual(json.unresolved, []);
  assert.equal(json.configError, undefined);
});
