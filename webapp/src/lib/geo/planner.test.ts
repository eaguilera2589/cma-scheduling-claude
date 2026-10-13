/**
 * Planner invariants on synthetic coordinates. planRoutes is pure, so every
 * assertion here is exact-deterministic (explicit `now`, fixed points).
 *
 * All synthetic tests use home = (0,0) with degree-space points; with small
 * deltas the haversine reduces to scaled Euclidean, which keeps the expected
 * orderings easy to verify.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haversineMiles } from './distance';
import { planRoutes, type PlacedStop } from './planner';

const HOME = { lat: 0, lng: 0 };
const NOW = new Date('2026-10-13T12:00:00Z');

function stop(id: string, city: string, lat: number, lng: number, dueDate?: Date | null): PlacedStop {
  return { caseNumber: id, address: `${id} st`, city, lat, lng, dueDate };
}

function grades(plan: { stops: { caseNumber: string; grade: number }[] }): Record<string, number> {
  return Object.fromEntries(plan.stops.map((s) => [s.caseNumber, s.grade]));
}

/** Shared invariant check for any non-empty city plan. */
function assertCoreInvariants(plan: ReturnType<typeof planRoutes>[number], home = HOME): void {
  const n = plan.stops.length;
  // Grades contiguous 1..n, every stop exactly once.
  assert.deepEqual(
    plan.stops.map((s) => s.grade),
    [...Array(n).keys()].map((i) => i + 1)
  );
  assert.equal(new Set(plan.stops.map((s) => s.caseNumber)).size, n);
  // Farthest from home = grade 1; closest to home = last grade (n>=2).
  if (n >= 2) {
    const dist = (s: { lat: number; lng: number }) => haversineMiles(home, { lat: s.lat, lng: s.lng });
    const all = plan.stops.map(dist);
    assert.equal(dist(plan.stops[0]), Math.max(...all), 'grade 1 is the farthest stop');
    assert.equal(dist(plan.stops[n - 1]), Math.min(...all), 'last grade is the closest stop');
  }
  // Legs/cumulative bookkeeping; total includes the return leg.
  let cum = 0;
  for (const s of plan.stops) {
    cum += s.legMiles;
    assert.ok(Math.abs(cum - s.cumulativeMiles) < 1e-9, 'cumulativeMiles = running leg sum');
  }
  assert.ok(plan.totalMiles >= cum, 'totalMiles >= legs sum (return leg included)');
}

test('planRoutes: empty input yields no plans', () => {
  assert.deepEqual(planRoutes([], HOME, NOW), []);
});

test('single-stop city: grade 1, out-and-back total', () => {
  const plans = planRoutes([stop('A', 'tampa', 0.1, 0)], HOME, NOW);
  assert.equal(plans.length, 1);
  const [p] = plans;
  assert.equal(p.stops.length, 1);
  assert.equal(p.stops[0].grade, 1);
  assertCoreInvariants(p);
  assert.ok(Math.abs(p.stops[0].legMiles - p.totalMiles / 2) < 1e-9, 'total = home->stop->home');
});

test('invariants hold on a spread-out 6-stop city', () => {
  const stops = [
    stop('A', 'Tampa', 0.05, 0.02),
    stop('B', 'Tampa', 0.30, 0.10), // farthest -> grade 1
    stop('C', 'Tampa', 0.01, 0.03), // closest -> last
    stop('D', 'Tampa', 0.18, 0.22),
    stop('E', 'Tampa', 0.12, 0.05),
    stop('F', 'Tampa', 0.25, 0.03),
  ];
  const [plan] = planRoutes(stops, HOME, NOW);
  assertCoreInvariants(plan);
  assert.equal(plan.stops[0].caseNumber, 'B');
  assert.equal(plan.stops[5].caseNumber, 'C');
});

test('2-opt improves the NN chain and reaches the optimal endpoint-pinned order', () => {
  // Discovered by brute-force search: NN chains [2,5,1,3,0,4] (42.87 mi of
  // inter-stop legs); the optimal order that keeps the farthest stop first
  // and the closest stop last is [2,5,0,3,1,4] (40.79 mi). A plain NN+2-opt
  // must find the crossing-free optimum.
  const coords: [number, number][] = [
    [0.3016, 0.0337], // 0
    [0.1761, 0.1324], // 1
    [0.0721, 0.3256], // 2  farthest from (0,0) -> grade 1
    [0.2792, 0.0221], // 3
    [0.1593, 0.1051], // 4  closest to (0,0) -> last grade
    [0.2276, 0.2007], // 5
  ];
  const stops = coords.map(([lat, lng], i) => stop(`S${i}`, 'Tampa', lat, lng));
  const [plan] = planRoutes(stops, HOME, NOW);
  assertCoreInvariants(plan);
  assert.deepEqual(
    plan.stops.map((s) => s.caseNumber),
    ['S2', 'S5', 'S0', 'S3', 'S1', 'S4']
  );
  // Inter-stop legs of the route: strictly shorter than the NN-only chain.
  const legSum = plan.stops.reduce((t, s, i) => t + (i === 0 ? 0 : s.legMiles), 0);
  assert.ok(legSum < 41.5, `optimized legs ${legSum.toFixed(2)} mi < NN 42.87 mi`);
  // Route + outbound + return totals (brute-forced expectation).
  assert.ok(Math.abs(plan.totalMiles - 77.02) < 0.05, `total ${plan.totalMiles.toFixed(3)}`);
});

test('city grouping is strict but case/whitespace-insensitive; farthest city first', () => {
  const stops = [
    stop('A', ' brandon ', 0.02, 0.0),
    stop('B', 'Brandon', 0.03, 0.0),
    stop('C', 'TAMPA', 0.09, 0.0),
    stop('D', 'tampa', 0.04, 0.0),
    stop('E', 'Lakeland', 0.5, 0.0), // farthest city wins first place
  ];
  const plans = planRoutes(stops, HOME, NOW);
  // Display name = trimmed city of the first stop seen for each group.
  assert.deepEqual(plans.map((p) => p.city), ['Lakeland', 'TAMPA', 'brandon']);
  assert.deepEqual(grades(plans[1]), { C: 1, D: 2 }); // farthest-first within Tampa
});

test('city tie-break: equal max distances order by city name', () => {
  const stops = [
    stop('X', 'zebra', 0.2, 0),
    stop('Y', 'Alpha', 0.2, 0),
  ];
  const plans = planRoutes(stops, HOME, NOW);
  assert.deepEqual(plans.map((p) => p.city), ['Alpha', 'zebra']);
});

test('dueWarning: past, within 3 days, boundary, beyond, blank', () => {
  const day = 86_400_000;
  const stops = [
    stop('past', 'Tampa', 0.3, 0, new Date(NOW.getTime() - day)),
    stop('soon', 'Tampa', 0.25, 0, new Date(NOW.getTime() + 2 * day)),
    stop('edge', 'Tampa', 0.2, 0, new Date(NOW.getTime() + 3 * day)),
    stop('far', 'Tampa', 0.15, 0, new Date(NOW.getTime() + 4 * day)),
    stop('blank', 'Tampa', 0.1, 0, null),
    stop('none', 'Tampa', 0.05, 0),
    stop('closest', 'Tampa', 0.01, 0),
  ];
  const [plan] = planRoutes(stops, HOME, NOW);
  const byId = Object.fromEntries(plan.stops.map((s) => [s.caseNumber, s.dueWarning]));
  assert.deepEqual(byId, {
    past: true,
    soon: true,
    edge: true, // within the window is inclusive
    far: false,
    blank: false,
    none: false,
    closest: false,
  });
  assertCoreInvariants(plan); // warnings must not perturb ordering
});

test('distance ties are deterministic: all points equidistant from home', () => {
  // Points on one circle: same distance from home. Grades must still form a
  // permutation with the pinned endpoints honored by the tie-break rule.
  const r = 0.2;
  const stops = Array.from({ length: 5 }, (_, i) =>
    stop(`T${i}`, 'Circle', r * Math.cos((i * 2 * Math.PI) / 5), r * Math.sin((i * 2 * Math.PI) / 5))
  );
  const [plan] = planRoutes(stops, HOME, NOW);
  assert.equal(new Set(plan.stops.map((s) => s.caseNumber)).size, 5);
  assert.deepEqual(plan.stops.map((s) => s.grade), [1, 2, 3, 4, 5]);
  const again = planRoutes(stops, HOME, NOW);
  assert.deepEqual(again[0].stops.map((s) => s.caseNumber), plan.stops.map((s) => s.caseNumber));
});

test('stops are never mutated by planRoutes', () => {
  const stops = [stop('A', 'Tampa', 0.1, 0), stop('B', 'Tampa', 0.2, 0.2)];
  const snapshot = JSON.stringify(stops);
  planRoutes(stops, HOME, NOW);
  assert.equal(JSON.stringify(stops), snapshot);
});
