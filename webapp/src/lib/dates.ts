export type DueState = 'overdue' | 'soon' | 'normal' | 'unknown';

const MS_PER_DAY = 86_400_000;

/** Number of days considered "due soon". */
export const SOON_WINDOW_DAYS = 3;

/**
 * Parse a strict "MM/DD/YYYY" (or "M/D/YYYY") string into a local-midnight Date.
 * Returns null for anything else (blank, malformed, impossible dates).
 * Parsed manually so behavior does not depend on Date-parse quirks across engines.
 */
export function parseMMDDYYYY(value: string): Date | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  // Reject rollovers like 02/30/2026.
  if (
    d.getFullYear() !== year ||
    d.getMonth() !== month - 1 ||
    d.getDate() !== day
  ) {
    return null;
  }
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Classify a due-date string relative to today (local time). */
export function dueState(due: string, today: Date = startOfToday()): DueState {
  const d = parseMMDDYYYY(due);
  if (!d) return 'unknown';
  const diffDays = Math.round((d.getTime() - today.getTime()) / MS_PER_DAY);
  if (diffDays < 0) return 'overdue';
  if (diffDays <= SOON_WINDOW_DAYS) return 'soon';
  return 'normal';
}
