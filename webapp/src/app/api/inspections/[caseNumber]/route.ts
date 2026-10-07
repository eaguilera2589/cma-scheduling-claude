import { makePatchInspectionHandler } from '@/lib/api/handlers';
import { clearInspectionsCache, updateInspectionFields } from '@/lib/sheets';

// Sheet-backed; never statically optimized, never cached by Next itself.
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/inspections/[caseNumber] — write the six human-edit fields of
 * one case back to the sheet. Validation and status codes live in
 * lib/api/handlers.ts.
 */
export const PATCH = makePatchInspectionHandler({
  update: updateInspectionFields,
  clearCache: clearInspectionsCache,
});
