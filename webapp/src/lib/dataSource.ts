/**
 * Data-source selector — the one place that decides between the Google Sheet
 * (default) and Postgres (DATA_SOURCE=db).
 *
 * Prod runs with DATA_SOURCE unset (== 'sheet') and therefore keeps calling the
 * exact same lib/sheets functions it always has — same code path, same 60s
 * cache, same JSON. The Postgres repository (and the `pg` dependency) is pulled
 * in with a dynamic import ONLY when DATA_SOURCE=db, so a sheet-mode process
 * never even loads the database layer.
 */
import type { Inspection, SixEditFields } from './types';
import type { UpdateInspectionResult } from './sheets';

export type DataSource = 'sheet' | 'db';

/** Resolve the active source; anything other than exactly 'db' means sheet. */
export function resolveDataSource(): DataSource {
  return process.env.DATA_SOURCE === 'db' ? 'db' : 'sheet';
}

/** Read all inspections from the active source. */
export async function loadInspections(): Promise<Inspection[]> {
  if (resolveDataSource() === 'db') {
    const { getDbInspections } = await import('./db/caseRepository');
    return getDbInspections();
  }
  const { getInspections } = await import('./sheets');
  return getInspections();
}

/** Write the six human-edit fields of one case to the active source. */
export async function updateInspectionFieldsToSource(
  caseNumber: string,
  edits: Partial<SixEditFields>
): Promise<UpdateInspectionResult> {
  if (resolveDataSource() === 'db') {
    const { updateDbInspectionFields } = await import('./db/caseRepository');
    return updateDbInspectionFields(caseNumber, edits);
  }
  const { updateInspectionFields } = await import('./sheets');
  return updateInspectionFields(caseNumber, edits);
}

/**
 * Invalidate any read cache after a write. The sheet source keeps an in-memory
 * 60s cache that must be busted; Postgres is queried live, so nothing to clear.
 */
export async function clearSourceCache(): Promise<void> {
  if (resolveDataSource() === 'db') return;
  const { clearInspectionsCache } = await import('./sheets');
  clearInspectionsCache();
}
