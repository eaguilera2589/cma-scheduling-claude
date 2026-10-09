import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { Inspection, SixEditFields } from './types';
import { EMPTY_INSPECTION } from './types';

// Full (read-write) Sheets scope: the dashboard reads the Inspections tab and
// writes back only the six human-edit cells. The service account must be
// shared on the sheet with Editor access for writes to succeed.
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/** In-memory cache TTL for sheet reads. */
const CACHE_TTL_MS = 60_000;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

let cache: { rows: Inspection[]; fetchedAt: number } | null = null;
let inFlight: Promise<Inspection[]> | null = null;

function keyFilePath(): string {
  const p =
    process.env.GOOGLE_SA_KEY_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!p) {
    throw new Error(
      'No service-account key configured: set GOOGLE_SA_KEY_PATH (or GOOGLE_APPLICATION_CREDENTIALS) in .env.local'
    );
  }
  return path.resolve(p);
}

function spreadsheetIdOrThrow(): string {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error('SHEET_ID is not set in .env.local');
  return id;
}

/** Convert a 1-based index to a column letter: 1->A, 27->AA. */
function columnLabel(index: number): string {
  let label = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** Quote a sheet title for use in an A1 range if it needs quoting. */
function rangeTitle(title: string): string {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

/**
 * Maps normalized sheet header -> Inspection field. Headers are compared with
 * all non-alphanumeric characters removed and lowercased, so "Case Number",
 * "case_number", and "CaseNumber" all match.
 *
 * Read columns are LC360 PascalCase keys (the n8n pull writes them via
 * autoMapInputData); the six human-edit columns carry human-readable names.
 * All mappings below were verified against row 1 of the live Inspections tab
 * on 2026-10-06 — no two headers normalize to the same key, so first-match
 * lookup is unambiguous. Live letters for the edit columns:
 * AP "Schedule Appointment (Y/N)", AQ "Date", AR "Time",
 * AS "Attempted to Contact", AT "Comments", AU "Sync Status".
 */
const HEADER_TO_FIELD: Record<string, keyof Inspection> = {
  casenumber: 'caseNumber',
  insuredname: 'insuredName',
  locationaddress: 'locationAddress',
  locationcity: 'locationCity',
  locationstate: 'locationState',
  inspectiondue: 'inspectionDue',
  datescheduledfor: 'dateScheduledFor',
  portal: 'portal',
  rush: 'rush',
  escalated: 'escalated',
  schedulingstatus: 'schedulingStatus',
  casetype: 'caseType',
  // Read-only LC360 header present on the live sheet (col AT-era verified in
  // sheets.test.ts LIVE_HEADER): "Contact at Insured". Read-only — never part
  // of the six-column write path. Absent headers stay tolerated (blank field).
  policycontactname: 'contactAtInsured',
  // Human-edit columns (writable — see EDIT_FIELD_HEADERS below).
  scheduleappointmentyn: 'scheduleAppointmentYN',
  date: 'date',
  time: 'time',
  attemptedtocontact: 'attemptedToContact',
  comments: 'comments',
  syncstatus: 'syncStatus',
};

/** Editable field -> the exact sheet header it must be found under. */
export const EDIT_FIELD_HEADERS: Record<keyof SixEditFields, string> = {
  scheduleAppointmentYN: 'Schedule Appointment (Y/N)',
  date: 'Date',
  time: 'Time',
  attemptedToContact: 'Attempted to Contact',
  comments: 'Comments',
  syncStatus: 'Sync Status',
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Exported for tests: map raw sheet cells (header row first) to Inspections. */
export function rowsToInspections(values: string[][]): Inspection[] {
  const [header, ...dataRows] = values;
  if (!header) return [];

  // Column index for each Inspection field; -1 when the sheet lacks that header.
  const fieldCol = new Map<keyof Inspection, number>();
  header.forEach((cell, i) => {
    const field = HEADER_TO_FIELD[normalizeHeader(cell ?? '')];
    if (field && !fieldCol.has(field)) fieldCol.set(field, i);
  });

  const missing = (Object.values(HEADER_TO_FIELD) as (keyof Inspection)[]).filter(
    (f) => !fieldCol.has(f)
  );
  if (missing.length > 0) {
    // Loud but non-fatal: the missing fields simply come back blank.
    console.warn(`[sheets] headers not found in sheet, fields will be blank: ${missing.join(', ')}`);
  }

  const rows: Inspection[] = [];
  for (const row of dataRows) {
    if (!row || row.every((cell) => (cell ?? '').trim() === '')) continue;
    const inspection: Inspection = { ...EMPTY_INSPECTION };
    for (const [field, col] of fieldCol) {
      inspection[field] = (row[col] ?? '').trim();
    }
    rows.push(inspection);
  }
  return rows;
}

/**
 * Structural subset of the googleapis Sheets client that this module uses.
 * The real client is cast to this at the seam; tests pass a fake instead of
 * talking to Google.
 */
export interface SheetsClientLike {
  spreadsheets: {
    get(params: { spreadsheetId: string; fields?: string }): Promise<{
      data?: {
        sheets?: Array<{
          properties?: {
            title?: string | null;
            gridProperties?: { rowCount?: number | null; columnCount?: number | null } | null;
          } | null;
        }> | null;
      } | null;
    }>;
    values: {
      get(params: { spreadsheetId: string; range: string }): Promise<{
        data?: { values?: string[][] | null } | null;
      }>;
      // Cell data goes in the request BODY as `requestBody` — the googleapis
      // client binds any other top-level param as a query parameter, and
      // Google rejects `values` that way with "Unknown name values".
      update(params: {
        spreadsheetId: string;
        range: string;
        valueInputOption: string;
        requestBody: { values: string[][] };
      }): Promise<unknown>;
    };
  };
}

/** Thrown by updateInspectionFields when no row matches the CaseNumber. */
export class RowNotFoundError extends Error {
  readonly caseNumber: string;
  constructor(caseNumber: string) {
    super(`No row found in the sheet with CaseNumber "${caseNumber}"`);
    this.name = 'RowNotFoundError';
    this.caseNumber = caseNumber;
  }
}

/** Authenticate with the service-account key and build a read-write client. */
async function sheetsClient(): Promise<SheetsClientLike> {
  const keyPath = keyFilePath();
  const key: ServiceAccountKey = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error(`Service-account key at ${keyPath} is missing client_email/private_key`);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: key.client_email,
      private_key: key.private_key,
    },
    scopes: SCOPES,
  });
  // The structural interface above is a strict subset of the generated
  // client's surface; the cast only narrows method-param typing.
  return google.sheets({ version: 'v4', auth }) as unknown as SheetsClientLike;
}

interface Grid {
  title: string;
  values: string[][];
}

/**
 * Read the whole tab as a string grid, header row first.
 *
 * The range always starts at A1, and the Sheets API returns grid rows 1:1
 * (blank rows in the middle come back as blank entries; only trailing blank
 * rows are trimmed — verified against the live sheet on 2026-10-06). So
 * values[i] is grid row i + 1, which is what makes write-range addressing
 * below safe.
 */
async function readGrid(sheets: SheetsClientLike): Promise<Grid> {
  const spreadsheetId = spreadsheetIdOrThrow();
  const tab = process.env.SHEET_TAB || 'Inspections';

  // Ask for the grid size first so we read exactly what exists (no giant
  // over-fetch, no truncation on large sheets).
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(title,gridProperties(rowCount,columnCount))',
  });
  const sheetMeta =
    meta.data?.sheets?.find((s) => s.properties?.title === tab) ??
    meta.data?.sheets?.[0];
  if (!sheetMeta?.properties) {
    throw new Error(`Sheet tab "${tab}" not found in spreadsheet ${spreadsheetId}`);
  }
  const title = sheetMeta.properties.title ?? tab;
  const colCount = sheetMeta.properties.gridProperties?.columnCount ?? 52;
  const rowCount = sheetMeta.properties.gridProperties?.rowCount ?? 1000;

  const range = `${rangeTitle(title)}!A1:${columnLabel(Math.max(colCount, 1))}${Math.max(rowCount, 1)}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { title, values: (res.data?.values ?? []) as string[][] };
}

async function fetchInspectionsFromSheet(): Promise<Inspection[]> {
  const sheets = await sheetsClient();
  const { values } = await readGrid(sheets);
  return rowsToInspections(values);
}

/**
 * Read inspections from the Google Sheet with a 60-second in-memory cache.
 * Concurrent callers share a single in-flight fetch.
 */
export async function getInspections(): Promise<Inspection[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  if (!inFlight) {
    inFlight = fetchInspectionsFromSheet()
      .then((rows) => {
        cache = { rows, fetchedAt: Date.now() };
        return rows;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Exported for tests/dev tooling: clear the cached sheet data. */
export function clearInspectionsCache(): void {
  cache = null;
}

/** One targeted cell write derived from the current grid. */
export interface CellUpdate {
  field: keyof SixEditFields;
  /** A1 range of the single target cell, e.g. "Inspections!AQ7". */
  a1: string;
  value: string;
}

export interface UpdatePlan {
  /** 1-based grid row of the matched case. */
  rowNumber: number;
  updates: CellUpdate[];
}

/**
 * Pure planner (exported for tests): given the raw grid, locate the row whose
 * CaseNumber cell matches `caseNumber` and map each edited field to the A1
 * range of its human-edit cell. Never touches read-only columns or other
 * rows. Throws RowNotFoundError when the case is absent, or Error when a
 * required header is missing from the sheet.
 */
export function planInspectionUpdate(
  values: string[][],
  sheetTitle: string,
  caseNumber: string,
  edits: Partial<SixEditFields>
): UpdatePlan {
  const [header, ...dataRows] = values;
  if (!header) {
    throw new Error('Sheet has no header row; cannot address write ranges.');
  }

  // First column whose normalized header matches; mirrors rowsToInspections.
  const colOf = (headerName: string): number => {
    const target = normalizeHeader(headerName);
    return header.findIndex((cell) => normalizeHeader(cell ?? '') === target);
  };

  const caseCol = colOf('CaseNumber');
  if (caseCol < 0) {
    throw new Error('Required header "CaseNumber" not found in the sheet.');
  }

  // Edit columns are resolved before row lookup so a misconfigured sheet
  // fails before any question of which row to write.
  const fields = Object.keys(edits) as (keyof SixEditFields)[];
  const editCols = new Map<keyof SixEditFields, number>();
  for (const field of fields) {
    const headerName = EDIT_FIELD_HEADERS[field];
    const col = colOf(headerName);
    if (col < 0) {
      throw new Error(`Required header "${headerName}" not found in the sheet.`);
    }
    editCols.set(field, col);
  }

  let rowNumber = -1;
  for (let i = 0; i < dataRows.length; i++) {
    if ((dataRows[i]?.[caseCol] ?? '').trim() === caseNumber) {
      rowNumber = i + 2; // dataRows[0] is grid row 2
      break;
    }
  }
  if (rowNumber < 0) {
    throw new RowNotFoundError(caseNumber);
  }

  const updates: CellUpdate[] = [];
  for (const field of fields) {
    const col = editCols.get(field)!;
    updates.push({
      field,
      a1: `${rangeTitle(sheetTitle)}!${columnLabel(col + 1)}${rowNumber}`,
      value: edits[field] ?? '',
    });
  }
  return { rowNumber, updates };
}

export interface UpdateInspectionResult {
  caseNumber: string;
  rowNumber: number;
  writtenFields: (keyof SixEditFields)[];
}

/**
 * Write the six human-edit cells of the row whose CaseNumber matches.
 * Reads the current grid, plans the exact target cells (see
 * planInspectionUpdate), and writes each with values.update + RAW so values
 * land verbatim — read-only columns and every other row are never touched.
 *
 * `client` is injectable for tests; production code omits it and a real
 * authenticated client is built from GOOGLE_SA_KEY_PATH.
 */
export async function updateInspectionFields(
  caseNumber: string,
  edits: Partial<SixEditFields>,
  client?: SheetsClientLike
): Promise<UpdateInspectionResult> {
  const trimmed = caseNumber.trim();
  if (!trimmed) throw new Error('caseNumber is required to address a sheet row.');
  if (Object.keys(edits).length === 0) {
    throw new Error('updateInspectionFields called with no field edits.');
  }

  const sheets = client ?? (await sheetsClient());
  const { title, values } = await readGrid(sheets);
  const { rowNumber, updates } = planInspectionUpdate(values, title, trimmed, edits);
  const spreadsheetId = spreadsheetIdOrThrow();

  for (const u of updates) {
    // RAW: write the string exactly as validated/canonicalized; no formula or
    // locale reinterpretation of dates and times.
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: u.a1,
      valueInputOption: 'RAW',
      requestBody: { values: [[u.value]] },
    });
  }
  return {
    caseNumber: trimmed,
    rowNumber,
    writtenFields: updates.map((u) => u.field),
  };
}
