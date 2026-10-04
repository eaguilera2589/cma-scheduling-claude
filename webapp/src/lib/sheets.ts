import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import type { Inspection } from './types';
import { EMPTY_INSPECTION } from './types';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

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
 * The production sheet is written by the n8n "Upsert to Sheet" node using
 * autoMapInputData, so its row-1 headers are exactly the LC360 object keys from
 * the "Map Cases to Rows" node (PascalCase, no spaces). Verified against
 * n8n-workflow/existing-lc360-sheet-export.json: CaseNumber, InsuredName,
 * LocationAddress, LocationCity, LocationState, InspectionDue, DateScheduledFor,
 * Portal, Rush, Escalated, SchedulingStatus, CaseType — all resolve correctly
 * under normalizeHeader, with no collisions from the other sheet columns.
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

async function fetchInspectionsFromSheet(): Promise<Inspection[]> {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error('SHEET_ID is not set in .env.local');
  const tab = process.env.SHEET_TAB || 'Inspections';

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
  const sheets = google.sheets({ version: 'v4', auth });

  // Ask for the grid size first so we read exactly what exists (no giant
  // over-fetch, no truncation on large sheets).
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(title,gridProperties(rowCount,columnCount))',
  });
  const sheetMeta =
    meta.data.sheets?.find((s) => s.properties?.title === tab) ??
    meta.data.sheets?.[0];
  if (!sheetMeta?.properties) {
    throw new Error(`Sheet tab "${tab}" not found in spreadsheet ${spreadsheetId}`);
  }
  const title = sheetMeta.properties.title ?? tab;
  const colCount = sheetMeta.properties.gridProperties?.columnCount ?? 46;
  const rowCount = sheetMeta.properties.gridProperties?.rowCount ?? 1000;

  const range = `${rangeTitle(title)}!A1:${columnLabel(Math.max(colCount, 1))}${Math.max(rowCount, 1)}`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = (res.data.values ?? []) as string[][];
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
