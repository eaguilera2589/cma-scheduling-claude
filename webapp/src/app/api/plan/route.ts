import { makePlanHandler } from '@/lib/api/planHandler';
import { loadInspections } from '@/lib/dataSource';
import { geocodeHome, geocodeInspectionLocation } from '@/lib/geo/geocode';

// Reads live inspection data plus the on-disk geo cache; never statically
// optimized into the build (same reasoning as api/inspections/route.ts).
export const dynamic = 'force-dynamic';

/**
 * GET /api/plan — unscheduled inspections grouped into per-city day plans
 * (grades 1..n, farthest→closest to home). Scope: ?scope=unscheduled
 * (default) | scheduled | all. Handler logic + tests: lib/api/planHandler.ts.
 */
export const GET = makePlanHandler({
  loadInspections,
  geocodeLocation: geocodeInspectionLocation,
  geocodeHome,
});
