/**
 * Haversine sanity checks against known FL point pairs. Expected values are
 * real-world great-circle distances; tolerances are a couple of miles —
 * generous for "sanity", tight enough to catch a broken formula or radius.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { haversineMiles, type GeoPoint } from './distance';

// 4305 Glendon Pl, Valrico FL (approximate, per task brief).
const HOME: GeoPoint = { lat: 27.956, lng: -82.299 };
const DOWNTOWN_TAMPA: GeoPoint = { lat: 27.9475, lng: -82.4584 };
const BRANDON: GeoPoint = { lat: 27.9378, lng: -82.2859 };
const ORLANDO: GeoPoint = { lat: 28.5383, lng: -81.3792 };
const LAKELAND: GeoPoint = { lat: 28.0395, lng: -81.9498 };

test('haversineMiles: zero for the same point', () => {
  assert.equal(haversineMiles(HOME, HOME), 0);
});

test('haversineMiles: symmetric', () => {
  const ab = haversineMiles(HOME, ORLANDO);
  const ba = haversineMiles(ORLANDO, HOME);
  assert.ok(Math.abs(ab - ba) < 1e-9);
});

test('haversineMiles: Valrico -> downtown Tampa ~9.7 mi', () => {
  const d = haversineMiles(HOME, DOWNTOWN_TAMPA);
  assert.ok(d > 9 && d < 10.5, `got ${d}`);
});

test('haversineMiles: Valrico -> Brandon ~1.5 mi', () => {
  const d = haversineMiles(HOME, BRANDON);
  assert.ok(d > 0.5 && d < 3, `got ${d}`);
});

test('haversineMiles: Tampa -> Orlando ~77-78 mi', () => {
  const d = haversineMiles(DOWNTOWN_TAMPA, ORLANDO);
  assert.ok(d > 76 && d < 80, `got ${d}`);
});

test('haversineMiles: Valrico -> Lakeland ~21 mi', () => {
  const d = haversineMiles(HOME, LAKELAND);
  assert.ok(d > 20 && d < 23, `got ${d}`);
});
