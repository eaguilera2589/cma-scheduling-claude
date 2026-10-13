/**
 * Address geocoding with a permanent JSON cache.
 *
 * Google Geocoding API (`maps.googleapis.com/maps/api/geocode/json`) is
 * called ONLY on a cache miss; results — including failed lookups — are
 * memoized in `webapp/data/geo-cache.json` keyed by a normalized address so
 * repeat lookups (and repeat failures) never hit the network again. Concurrent
 * misses of the same key are also de-duplicated in memory (one in-flight
 * lookup per key), so a parallel fan-out never pays twice for one address.
 *
 * Failure semantics, deliberately split:
 *  - Missing/blank GOOGLE_MAPS_API_KEY at call time (or a Google
 *    REQUEST_DENIED response) throws GeocodeConfigError — a CONFIGURATION
 *    problem the operator must fix, which must not be poisoned into the
 *    permanent cache. Cache hits still work with no key at all, so importing
 *    this module or serving from a warm cache never crashes callers.
 *  - Everything else (ZERO_RESULTS, HTTP error, malformed payload, network
 *    error) is cached as a failed entry and resolves to null.
 *
 * The fs cache lives here so planner.ts / distance.ts stay pure. Tests
 * inject fetchImpl + cachePath; production code uses the module-level
 * geocodeAddress() against the default cache file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Inspection } from '../types';
import type { GeoPoint } from './distance';

export type { GeoPoint };

/** Thrown when a LIVE geocode call is impossible for configuration reasons. */
export class GeocodeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodeConfigError';
  }
}

/** Home base: the day's start AND end point. Override with HOME_ADDRESS. */
export const DEFAULT_HOME_ADDRESS = '4305 Glendon Place, Valrico, FL';

export function homeAddress(): string {
  return process.env.HOME_ADDRESS?.trim() || DEFAULT_HOME_ADDRESS;
}

const GEOCODE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Default cache file: <webapp>/data/geo-cache.json (resolved from src/lib/geo). */
export const DEFAULT_CACHE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'data',
  'geo-cache.json'
);

/** Minimal fetch surface so tests can stub the network without a lib. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CacheHit {
  lat: number;
  lng: number;
}
interface CacheFailure {
  failed: true;
  reason: string;
}
type CacheEntry = CacheHit | CacheFailure;

const isHit = (e: CacheEntry): e is CacheHit => 'lat' in e;

/**
 * Normalize an address into a cache key: lowercase, trimmed, collapsed
 * whitespace, and secondary/unit designators stripped from the KEY ONLY
 * ("123 Main St APT 3" and "123 Main St" share one entry — the coordinates
 * of a building are the coordinates of a unit, and unit noise otherwise
 * fragments the cache). The stored value is unaffected.
 */
export function normalizeAddressKey(address: string): string {
  let s = address.trim().toLowerCase().replace(/\s+/g, ' ');
  // "#4", "# 4b" — unit-number sigils.
  s = s.replace(/#\s*[a-z0-9-]+/g, ' ');
  // Keyword + designator: apt/ste/unit/rm/floor/... followed by a token.
  s = s.replace(
    /\b(?:apt|apartment|ste|suite|unit|bldg|building|rm|room|fl|floor|trlr|lot)\b\.?\s*[a-z0-9-]+/g,
    ' '
  );
  // Tidy punctuation spacing introduced by the removals.
  s = s.replace(/\s+,/g, ',').replace(/,\s*/g, ', ').replace(/\s+/g, ' ');
  s = s.replace(/[,.\s]+$/g, '');
  return s.trim();
}

export interface GeocoderOptions {
  /** Cache JSON path; default <webapp>/data/geo-cache.json. */
  cachePath?: string;
  /** Fetch implementation seam for tests; default globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** API key seam for tests; default process.env.GOOGLE_MAPS_API_KEY. */
  apiKey?: string;
}

export interface Geocoder {
  geocodeAddress(address: string): Promise<GeoPoint | null>;
}

/**
 * Build a file-backed geocoder. The cache file is loaded lazily on the first
 * lookup (a missing file == empty cache) and written atomically (tmp+rename)
 * after every miss. Not designed for multi-process concurrency — this app
 * runs one Node server.
 */
export function createFileGeocoder(opts: GeocoderOptions = {}): Geocoder {
  const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => globalThis.fetch(u, init));

  let cache: Map<string, CacheEntry> | null = null;

  // In-flight cache misses keyed by normalized address: concurrent lookups
  // for the same key share ONE network call. Entries are removed when
  // settled, so a rejection (e.g. a config error, which is never persisted)
  // can never linger and poison later calls.
  const inFlight = new Map<string, Promise<GeoPoint | null>>();

  function loadCache(): Map<string, CacheEntry> {
    if (cache) return cache;
    cache = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, CacheEntry>;
      for (const [k, v] of Object.entries(raw)) cache.set(k, v);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt cache: start empty rather than crash; the next write repairs it.
        console.warn(`[geo] cache at ${cachePath} is unreadable (${(err as Error).message}); starting empty`);
      }
    }
    return cache;
  }

  function persist(entryKey: string, entry: CacheEntry): void {
    const map = loadCache();
    map.set(entryKey, entry);
    const obj = Object.fromEntries(map);
    const tmp = `${cachePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, cachePath);
    } catch (err) {
      // A cache-write failure must not lose the just-resolved coordinate.
      console.warn(`[geo] could not persist cache entry "${entryKey}": ${(err as Error).message}`);
    }
  }

  /** Cache-miss path: config check, one Google call, persist the outcome. */
  async function lookupUncached(entryKey: string, address: string): Promise<GeoPoint | null> {
    const apiKey = (opts.apiKey ?? process.env.GOOGLE_MAPS_API_KEY ?? '').trim();
    if (!apiKey) {
      throw new GeocodeConfigError(
        `GOOGLE_MAPS_API_KEY is not set — cannot geocode "${address}" (cache miss). ` +
          'Set the key or pre-populate the geo cache.'
      );
    }

    const url = `${GEOCODE_ENDPOINT}?address=${encodeURIComponent(entryKey)}&key=${encodeURIComponent(apiKey)}`;
    let body: { status?: string; results?: { geometry?: { location?: { lat?: unknown; lng?: unknown } } }[] };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        persist(entryKey, { failed: true, reason: `http-${res.status}` });
        return null;
      }
      body = (await res.json()) as typeof body;
    } catch (err) {
      // Network/timeout hiccup: memoize so a backfill pass never retries it.
      persist(entryKey, { failed: true, reason: `network: ${(err as Error).message}` });
      return null;
    }

    const status = body?.status ?? 'UNKNOWN_STATUS';
    if (status === 'REQUEST_DENIED') {
      // Key/permissions problem — an operator-fixable config error, and
      // permanently caching the failure would outlive the fix.
      throw new GeocodeConfigError(
        `Google Geocoding API denied the request for "${address}" — check GOOGLE_MAPS_API_KEY ` +
          '(Geocoding API enabled? key valid?).'
      );
    }

    const loc = body?.results?.[0]?.geometry?.location;
    if (status === 'OK' && typeof loc?.lat === 'number' && typeof loc?.lng === 'number') {
      persist(entryKey, { lat: loc.lat, lng: loc.lng });
      return { lat: loc.lat, lng: loc.lng };
    }

    persist(entryKey, { failed: true, reason: status });
    return null;
  }

  async function geocodeAddress(address: string): Promise<GeoPoint | null> {
    const entryKey = normalizeAddressKey(address);
    if (!entryKey) return null;

    const cached = loadCache().get(entryKey);
    if (cached) return isHit(cached) ? { lat: cached.lat, lng: cached.lng } : null;

    const pending = inFlight.get(entryKey);
    if (pending) return pending;

    // Everything up to inFlight.set() runs synchronously (the async function
    // bodies only suspend at their internal awaits), so a follower issued in
    // the same tick always finds the entry. Delete on settle: a settled
    // rejection must never be replayed to later callers, and a fresh entry
    // can only be installed after this one is gone, so this delete can never
    // clobber a newer in-flight lookup.
    const lookup = lookupUncached(entryKey, address).finally(() => {
      inFlight.delete(entryKey);
    });
    inFlight.set(entryKey, lookup);
    return lookup;
  }

  return { geocodeAddress };
}

/** Shared instance over the default cache file; lazily touches disk. */
const defaultGeocoder = createFileGeocoder();

/** Geocode one address string; null on any resolvable failure (see header). */
export function geocodeAddress(address: string): Promise<GeoPoint | null> {
  return defaultGeocoder.geocodeAddress(address);
}

/**
 * Geocode an inspection's location as "<address>, <city>, <state>" with the
 * state defaulting to FL when blank; caches under that composed key.
 */
export function geocodeInspectionLocation(
  inspection: Pick<Inspection, 'locationAddress' | 'locationCity' | 'locationState'>
): Promise<GeoPoint | null> {
  const parts = [
    inspection.locationAddress.trim(),
    inspection.locationCity.trim(),
    inspection.locationState.trim() || 'FL',
  ].filter(Boolean);
  return defaultGeocoder.geocodeAddress(parts.join(', '));
}

/** Geocode the configured home base (HOME_ADDRESS env or the Valrico default). */
export function geocodeHome(): Promise<GeoPoint | null> {
  return defaultGeocoder.geocodeAddress(homeAddress());
}
