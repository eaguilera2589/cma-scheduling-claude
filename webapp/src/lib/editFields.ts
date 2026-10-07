/**
 * UI-facing metadata + format conversions for the six human-edit fields.
 * Pure and dependency-free (beyond lib/types) so both the editor component
 * and the node:test suite can use it.
 */
import type { SixEditFields } from './types';
import { parseMMDDYYYY } from './dates';

export const EDIT_FIELD_LABELS: Record<keyof SixEditFields, string> = {
  scheduleAppointmentYN: 'Schedule Appointment (Y/N)',
  date: 'Date',
  time: 'Time',
  attemptedToContact: 'Attempted to Contact',
  comments: 'Comments',
  syncStatus: 'Sync Status',
};

export type SyncTone = 'empty' | 'ready' | 'synced' | 'error' | 'other';

/** Visual tone for the Sync Status pill. */
export function syncStatusTone(status: string): SyncTone {
  const v = status.trim();
  if (v === '') return 'empty';
  if (v.toLowerCase() === 'ready to sync') return 'ready';
  if (v.toLowerCase() === 'synced') return 'synced';
  if (/^error\b/i.test(v)) return 'error';
  return 'other';
}

/** <input type="date"> value ("YYYY-MM-DD") -> sheet "MM/DD/YYYY"; "" if invalid. */
export function isoDateToSheet(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  // Round-trip through the date parser to reject impossible days.
  if (!parseMMDDYYYY(`${m[2]}/${m[3]}/${m[1]}`)) return '';
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** Sheet "MM/DD/YYYY" -> <input type="date"> value; "" if not parseable. */
export function sheetDateToInput(value: string): string {
  const d = parseMMDDYYYY(value);
  if (!d) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** <input type="time"> value ("HH:MM", 24h) -> sheet "H:MM AM/PM"; "" if invalid. */
export function timeInputToSheet(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return '';
  const h24 = Number(m[1]);
  const minute = m[2];
  if (h24 > 23 || Number(minute) > 59) return '';
  const period = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${minute} ${period}`;
}

/** Sheet "H:MM AM/PM" -> <input type="time"> value ("HH:MM"); "" if not parseable. */
export function sheetTimeToInput(value: string): string {
  const m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/i.exec(value.trim());
  if (!m) return '';
  const hour = Number(m[1]);
  const minute = m[2];
  if (hour < 1 || hour > 12 || Number(minute) > 59) return '';
  const h24 = m[3].toUpperCase() === 'AM' ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
  return `${String(h24).padStart(2, '0')}:${minute}`;
}

/** Option list = canonical options plus the row's current value if nonstandard. */
export function optionsWithCurrent(options: readonly string[], current: string): string[] {
  if (current === '' || options.includes(current)) return [...options];
  return [...options, current];
}
