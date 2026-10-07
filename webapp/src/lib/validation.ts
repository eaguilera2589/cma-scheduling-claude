/**
 * Server-side validation + canonicalization of the six human-edit fields
 * accepted by PATCH /api/inspections/[caseNumber].
 *
 * Every canonicalizer accepts the blank string (means "clear the cell") and
 * returns the value in the exact format the sheet/Phase 2 expects, or null
 * when invalid. All are pure so the API handler tests can cover them without
 * touching Google.
 */
import type { SixEditFields } from './types';
import { parseMMDDYYYY } from './dates';

/** Editable field keys, in PATCH body order. Mirrors SixEditFields. */
export const EDIT_FIELDS: readonly (keyof SixEditFields)[] = [
  'scheduleAppointmentYN',
  'date',
  'time',
  'attemptedToContact',
  'comments',
  'syncStatus',
];

/** Values the Sync Status dropdown may set (besides an existing "Error: ..."). */
export const SYNC_STATUS_FIXED = ['', 'Ready to Sync', 'Synced'] as const;

/** Informational contact-type options (not enforced server-side; Phase 2 resolves against LC360). */
export const CONTACT_TYPES = ['Insured', 'Agent', 'Other'] as const;

const MAX_COMMENTS_LENGTH = 5000;

export type CanonicalResult = string | null;

/** "Y"/"N"/"" case-insensitively; anything else is invalid. */
export function canonicalYN(value: string): CanonicalResult {
  const v = value.trim().toUpperCase();
  return v === '' || v === 'Y' || v === 'N' ? v : null;
}

/**
 * "MM/DD/YYYY" (also accepts "M/D/YYYY", case is N/A here), or "".
 * Returns the zero-padded canonical form; rejects impossible dates.
 */
export function canonicalDate(value: string): CanonicalResult {
  const v = value.trim();
  if (v === '') return '';
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!m) return null;
  const canonical = `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return parseMMDDYYYY(canonical) ? canonical : null;
}

/**
 * "H:MM AM/PM" (e.g. "4:00 PM") or "". Accepts any casing and an optional
 * space before AM/PM; canonicalizes to "H:MM AM|PM" with an unpadded hour to
 * match the existing sheet values that Phase 2 parses.
 */
export function canonicalTime(value: string): CanonicalResult {
  const v = value.trim();
  if (v === '') return '';
  const m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/i.exec(v);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return `${hour}:${m[2]} ${m[3].toUpperCase()}`;
}

/**
 * Allowed Sync Status values: "", "Ready to Sync", "Synced" (both matched
 * case-insensitively and canonicalized), or an existing "Error: ..." string
 * (so the UI can round-trip a current error value without clobbering it).
 */
export function canonicalSyncStatus(value: string): CanonicalResult {
  const v = value.trim();
  if (v === '') return '';
  const lower = v.toLowerCase();
  if (lower === 'ready to sync') return 'Ready to Sync';
  if (lower === 'synced') return 'Synced';
  const err = /^error\b:?\s*(.*)$/i.exec(v);
  if (err) {
    const rest = err[1].trim();
    return `Error: ${rest}`.slice(0, 300);
  }
  return null;
}

/** Attempted to Contact: informational only — any string up to a sane length. */
export function canonicalContact(value: string): CanonicalResult {
  const v = value.trim();
  return v.length <= 100 ? v : null;
}

/** Comments: free text, trimmed at the edges, bounded length. */
export function canonicalComments(value: string): CanonicalResult {
  const v = value.trim();
  return v.length <= MAX_COMMENTS_LENGTH ? v : null;
}

const CANONICALIZE: Record<(typeof EDIT_FIELDS)[number], (v: string) => CanonicalResult> = {
  scheduleAppointmentYN: canonicalYN,
  date: canonicalDate,
  time: canonicalTime,
  attemptedToContact: canonicalContact,
  comments: canonicalComments,
  syncStatus: canonicalSyncStatus,
};

export type ValidateEditResult =
  | { ok: true; edits: Partial<SixEditFields> }
  | { ok: false; error: string };

/**
 * Validate a PATCH body against the six editable fields. Only the six known
 * keys are accepted (unknown keys are a client bug, not something to ignore);
 * at least one must be present. Values are canonicalized for writing.
 */
export function validateEditBody(body: unknown): ValidateEditResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object of editable fields.' };
  }
  const obj = body as Record<string, unknown>;

  const unknown = Object.keys(obj).filter(
    (k) => !(EDIT_FIELDS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    return { ok: false, error: `Unexpected field(s): ${unknown.join(', ')}` };
  }
  const present = EDIT_FIELDS.filter((f) => obj[f] !== undefined);
  if (present.length === 0) {
    return { ok: false, error: 'Body must contain at least one editable field.' };
  }

  const edits: Partial<SixEditFields> = {};
  for (const field of present) {
    const raw = obj[field];
    if (typeof raw !== 'string') {
      return { ok: false, error: `Field "${field}" must be a string.` };
    }
    const canonical = CANONICALIZE[field](raw);
    if (canonical === null) {
      return { ok: false, error: `Field "${field}" has an invalid value: ${JSON.stringify(raw)}` };
    }
    edits[field] = canonical;
  }
  return { ok: true, edits };
}
