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

/**
 * Human-readable name of the active source, for user-facing error copy ("Failed
 * to write the update to ${sourceLabel()}."). In DB mode the sheet is NOT the
 * sink, so the message must say "the database", not "the Google Sheet". The
 * sheet-mode string is byte-for-byte what it has always been.
 *
 * Lives here (the one source-decision module) rather than in lib/sheets or the
 * route handlers so neither the `pg` nor the `googleapis` dependency is pulled in
 * by importing it — both the Next-free handlers and the App Router routes can use
 * it behind the same DATA_SOURCE gate as everything else.
 */
export function sourceLabel(): string {
  return resolveDataSource() === 'db' ? 'the database' : 'the Google Sheet';
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
