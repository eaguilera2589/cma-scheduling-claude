import type { Inspection } from './types';
import { parseMMDDYYYY } from './dates';

/** Columns the UI allows sorting by. */
export type SortKey =
  | 'caseNumber'
  | 'insuredName'
  | 'locationAddress'
  | 'locationCity'
  | 'inspectionDue'
  | 'portal';

export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/**
 * True for values that should sink to the bottom regardless of sort direction
 * (blank strings; unparseable dates for the date column).
 */
function isBottom(value: string, key: SortKey): boolean {
  if (value === '') return true;
  if (key === 'inspectionDue') return parseMMDDYYYY(value) === null;
  return false;
}

function compare(a: Inspection, b: Inspection, key: SortKey): number {
  if (key === 'inspectionDue') {
    const da = parseMMDDYYYY(a.inspectionDue);
    const db = parseMMDDYYYY(b.inspectionDue);
    if (da && db) return da.getTime() - db.getTime();
    return 0; // handled by the bottom-sinking pass
  }
  return a[key].localeCompare(b[key], 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * Sort a copy of `rows`. Blank/unparseable values always sink to the bottom;
 * ties fall back to case number so ordering is stable and predictable.
 */
export function sortInspections(rows: Inspection[], { key, dir }: SortSpec): Inspection[] {
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const aBottom = isBottom(a[key], key);
    const bBottom = isBottom(b[key], key);
    if (aBottom !== bBottom) return aBottom ? 1 : -1;
    const cmp = compare(a, b, key);
    if (cmp !== 0) return cmp * mult;
    return a.caseNumber.localeCompare(b.caseNumber, 'en', { numeric: true });
  });
}
