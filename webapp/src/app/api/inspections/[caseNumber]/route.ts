import { makePatchInspectionHandler } from '@/lib/api/handlers';
import { clearSourceCache, updateInspectionFieldsToSource } from '@/lib/dataSource';

// Backed by the configured data source (sheet by default == prod; Postgres in
// staging). Never statically optimized or cached by Next itself.
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/inspections/[caseNumber] — write the six human-edit fields of one
 * case. Validation and status codes live in lib/api/handlers.ts. The concrete
 * sink (Google Sheet or Postgres `cases`) is chosen by DATA_SOURCE; in sheet
 * mode this writes to the sheet exactly as before. See lib/dataSource.ts.
 */
export const PATCH = makePatchInspectionHandler({
  update: updateInspectionFieldsToSource,
  clearCache: clearSourceCache,
});
