/**
 * Geo-cache backfill for the route planner (idempotent; safe to re-run).
 *
 * Loads every OPEN case through the normal dataSource selector (sheet in
 * prod, Postgres with DATA_SOURCE=db — same reads the board uses), geocodes
 * each inspection location into the permanent JSON cache
 * (webapp/data/geo-cache.json), and prints a resolved/failed summary.
 *
 * Cache-first: already-geocoded addresses (including previously-failed ones)
 * never hit Google, so re-runs are cheap. Google calls are sequential with a
 * small delay to stay rate-limit-friendly.
 *
 * Requires GOOGLE_MAPS_API_KEY (env / --env-file). With no key the first
 * cache-miss geocode throws GeocodeConfigError: the script prints the reason
 * and exits non-zero. It never writes to the sheet/DB, n8n, or any schema.
 *
 * Run via the npm script `geo:backfill`.
 */
import { loadInspections } from '../src/lib/dataSource';
import {
  geocodeHome,
  geocodeInspectionLocation,
  GeocodeConfigError,
  homeAddress,
} from '../src/lib/geo/geocode';

/** Polite pacing between Google calls (QPS-per-key safety margin). */
const DELAY_MS = 110;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "Open" == not yet scheduled for a date (same predicate as the board). */
function isOpen(dateScheduledFor: string): boolean {
  return dateScheduledFor.trim() === '';
}

async function main(): Promise<void> {
  const started = Date.now();
  console.log('[geo] DATA_SOURCE guard: reads cases read-only; writes ONLY data/geo-cache.json.');

  // Geocode home BEFORE loading any cases: a missing/blocked key surfaces
  // here, before any sheet/DB reads are even attempted.
  try {
    const home = await geocodeHome();
    if (!home) {
      console.error(`[geo] home address "${homeAddress()}" could not be geocoded — fix it before planning routes.`);
      process.exitCode = 1;
      return;
    }
    console.log(`[geo] home resolved: ${home.lat}, ${home.lng}`);
  } catch (err) {
    if (err instanceof GeocodeConfigError) {
      console.error(`[geo] ABORT: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const cases = (await loadInspections()).filter((c) => isOpen(c.dateScheduledFor));
  console.log(`[geo] ${cases.length} open case(s) to geocode.`);

  let resolved = 0;
  let failed = 0;
  const failedCases: string[] = [];

  for (const c of cases) {
    try {
      const point = await geocodeInspectionLocation(c);
      if (point) {
        resolved++;
      } else {
        failed++;
        failedCases.push(c.caseNumber);
      }
      await sleep(DELAY_MS);
    } catch (err) {
      if (err instanceof GeocodeConfigError) {
        console.error(`[geo] ABORT after ${resolved + failed}/${cases.length}: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  console.log(`[geo] done in ${Date.now() - started} ms — resolved=${resolved} failed=${failed} total=${cases.length}`);
  if (failedCases.length > 0) {
    console.log(`[geo] failed case numbers: ${failedCases.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(`[geo] unexpected failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
