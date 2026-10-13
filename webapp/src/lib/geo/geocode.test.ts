/**
 * Geocode cache tests — NO network. fetch is stubbed via the fetchImpl seam
 * and the cache file lives in a fresh tmp dir per test, so the real
 * webapp/data/geo-cache.json is never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createFileGeocoder,
  GeocodeConfigError,
  normalizeAddressKey,
  type FetchLike,
} from './geocode';

/** Fresh tmp cache path + a geocoder bound to it. */
function makeGeocoder(fetchImpl: FetchLike, seed?: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-cache-test-'));
  const cachePath = path.join(dir, 'geo-cache.json');
  if (seed) fs.writeFileSync(cachePath, JSON.stringify(seed), 'utf8');
  return { cachePath, geocoder: createFileGeocoder({ cachePath, fetchImpl, apiKey: 'test-key' }) };
}

const okFetch =
  (calls: string[] = []): FetchLike =>
  async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 'OK',
        results: [{ geometry: { location: { lat: 27.956, lng: -82.299 } } }],
      }),
    };
  };

const statusFetch =
  (status: string): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => ({ status, results: [] }) });

test('normalizeAddressKey: case, whitespace, punctuation', () => {
  assert.equal(normalizeAddressKey('  Tampa ,FL  '), 'tampa, fl');
  assert.equal(normalizeAddressKey('123   Main   St'), '123 main st');
  assert.equal(normalizeAddressKey('123 MAIN ST, TAMPA, FL'), '123 main st, tampa, fl');
});

test('normalizeAddressKey: secondary/unit designators stripped from the key', () => {
  const base = normalizeAddressKey('123 Main St');
  for (const variant of [
    '123 Main St APT 3',
    '123 Main St, STE 100',
    '123 Main St #4',
    '123 Main St Unit 2B',
    '123 Main St Apt. 7',
    '123 Main St, Floor 3',
  ]) {
    assert.equal(normalizeAddressKey(variant), base, variant);
  }
});

test('geocodeAddress: cache hit avoids the network entirely', async () => {
  const calls: string[] = [];
  const seedKey = '123 main st, tampa, fl';
  const { geocoder } = makeGeocoder(
    async () => {
      throw new Error('must not fetch on a cache hit');
    },
    { [seedKey]: { lat: 27.9, lng: -82.4 } }
  );
  // Different casing/unit text on the query — must normalize onto the same key.
  const point = await geocoder.geocodeAddress('123 Main St APT 3, Tampa, FL');
  assert.deepEqual(point, { lat: 27.9, lng: -82.4 });
  assert.equal(calls.length, 0);
});

test('geocodeAddress: miss calls Google once and persists the entry', async () => {
  const calls: string[] = [];
  const { cachePath, geocoder } = makeGeocoder(okFetch(calls));
  const point = await geocoder.geocodeAddress('123 Main St, Tampa, FL');
  assert.deepEqual(point, { lat: 27.956, lng: -82.299 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/maps\.googleapis\.com\/maps\/api\/geocode\/json\?address=/);

  // Entry persisted under the normalized key; second lookup is a hit.
  const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.deepEqual(stored['123 main st, tampa, fl'], { lat: 27.956, lng: -82.299 });
  const again = await geocoder.geocodeAddress('123 main st, TAMPA, fl');
  assert.deepEqual(again, { lat: 27.956, lng: -82.299 });
  assert.equal(calls.length, 1, 'second lookup must not hit the network');
});

test('geocodeAddress: ZERO_RESULTS is memoized as a failure', async () => {
  const { cachePath, geocoder } = makeGeocoder(statusFetch('ZERO_RESULTS'));
  assert.equal(await geocoder.geocodeAddress('nowhere land'), null);
  assert.equal(await geocoder.geocodeAddress('nowhere land'), null);
  const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.deepEqual(stored['nowhere land'], { failed: true, reason: 'ZERO_RESULTS' });
});

test('geocodeAddress: network errors are memoized as failures', async () => {
  let attempts = 0;
  const { cachePath, geocoder } = makeGeocoder(async () => {
    attempts++;
    throw new Error('ETIMEDOUT');
  });
  assert.equal(await geocoder.geocodeAddress('1 fail st'), null);
  assert.equal(await geocoder.geocodeAddress('1 fail st'), null);
  assert.equal(attempts, 1, 'the failed lookup must be memoized, not retried');
  const stored = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(stored['1 fail st'].failed, true);
});

test('geocodeAddress: missing API key throws GeocodeConfigError, no cache write', async () => {
  const { cachePath, geocoder } = makeGeocoder(okFetch());
  const keyless = createFileGeocoder({ cachePath, fetchImpl: okFetch(), apiKey: '' });
  await assert.rejects(() => keyless.geocodeAddress('5 missing key rd'), GeocodeConfigError);
  assert.equal(fs.existsSync(cachePath), false, 'a config error must not poison the cache');
});

test('geocodeAddress: REQUEST_DENIED throws GeocodeConfigError, not memoized', async () => {
  const { cachePath, geocoder } = makeGeocoder(statusFetch('REQUEST_DENIED'));
  await assert.rejects(() => geocoder.geocodeAddress('1 denied st'), GeocodeConfigError);
  assert.equal(fs.existsSync(cachePath), false, 'a key problem must stay retryable after the fix');
});

test('geocodeAddress: empty/blank address resolves null without a call', async () => {
  const { geocoder } = makeGeocoder(async () => {
    throw new Error('must not fetch for a blank address');
  });
  assert.equal(await geocoder.geocodeAddress('   '), null);
});

// NOTE: geocodeInspectionLocation / geocodeHome use the module-level default
// geocoder bound to the real data/geo-cache.json, so they are NOT called in
// unit tests. Their composition rule ("address, city, state-or-FL" -> the
// normalized cache key) is pinned here instead:
test('inspection-location key composition reaches Google as "address, city, fl"', async () => {
  const calls: string[] = [];
  const { geocoder } = makeGeocoder(okFetch(calls));
  // Same composition geocodeInspectionLocation performs for a blank state.
  await geocoder.geocodeAddress(['123 Main St', 'Tampa', 'FL'].filter(Boolean).join(', '));
  assert.match(calls[0], /address=123%20main%20st%2C%20tampa%2C%20fl&key=test-key$/);
});
