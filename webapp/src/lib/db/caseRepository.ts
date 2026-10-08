/**
 * Thin Postgres repository for the DB data source (DATA_SOURCE=db).
 *
 * Maps the webapp's camelCase `Inspection` shape to the snake_case `cases`
 * table. Every value is bound as a query parameter — only the fixed, code-
 * defined column identifiers ever reach the SQL string (no user input is ever
 * interpolated). This module is only ever imported dynamically behind the
 * DATA_SOURCE gate in lib/dataSource.ts, so `pg` is never loaded in sheet mode.
 */
import type { Inspection, SixEditFields } from '../types';
import { EMPTY_INSPECTION } from '../types';
import { RowNotFoundError, type UpdateInspectionResult } from '../sheets';
import { getPool } from './pool';

/**
 * Minimal query surface these functions need. The real `pg.Pool` satisfies it;
 * tests inject a fake so the SQL/mapping can be exercised without a database.
 * Production callers omit the `executor` argument and get the real pool.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Resolve the executor: injected (tests) or the real pool (production). */
function executorOr(executor?: Queryable): Queryable {
  return executor ?? getPool();
}

/** camelCase field -> SQL column identifier (quoted where the name is reserved). */
const FIELD_COLUMN: Record<keyof Inspection, string> = {
  caseNumber: 'case_number',
  insuredName: 'insured_name',
  locationAddress: 'location_address',
  locationCity: 'location_city',
  locationState: 'location_state',
  inspectionDue: 'inspection_due',
  dateScheduledFor: 'date_scheduled_for',
  portal: 'portal',
  rush: 'rush',
  escalated: 'escalated',
  schedulingStatus: 'scheduling_status',
  caseType: 'case_type',
  scheduleAppointmentYN: 'schedule_appointment_yn',
  date: '"date"',
  time: '"time"',
  attemptedToContact: 'attempted_to_contact',
  comments: 'comments',
  syncStatus: 'sync_status',
};

/** Stable, canonical field order for SELECT/INSERT column lists. */
const FIELD_ORDER: (keyof Inspection)[] = Object.keys(FIELD_COLUMN) as (keyof Inspection)[];

/** DB result column (lowercased, unquoted) -> camelCase field. */
const RESULT_KEY_TO_FIELD: Record<string, keyof Inspection> = {
  case_number: 'caseNumber',
  insured_name: 'insuredName',
  location_address: 'locationAddress',
  location_city: 'locationCity',
  location_state: 'locationState',
  inspection_due: 'inspectionDue',
  date_scheduled_for: 'dateScheduledFor',
  portal: 'portal',
  rush: 'rush',
  escalated: 'escalated',
  scheduling_status: 'schedulingStatus',
  case_type: 'caseType',
  schedule_appointment_yn: 'scheduleAppointmentYN',
  date: 'date',
  time: 'time',
  attempted_to_contact: 'attemptedToContact',
  comments: 'comments',
  sync_status: 'syncStatus',
};

/** Editable field -> SQL column identifier used by the write path. */
const EDIT_FIELD_COLUMN: Record<keyof SixEditFields, string> = {
  scheduleAppointmentYN: 'schedule_appointment_yn',
  date: '"date"',
  time: '"time"',
  attemptedToContact: 'attempted_to_contact',
  comments: 'comments',
  syncStatus: 'sync_status',
};

const SELECT_COLUMNS = FIELD_ORDER.map((f) => FIELD_COLUMN[f]).join(', ');

function rowToInspection(row: Record<string, unknown>): Inspection {
  const inspection: Inspection = { ...EMPTY_INSPECTION };
  for (const [key, value] of Object.entries(row)) {
    const field = RESULT_KEY_TO_FIELD[key];
    if (field) inspection[field] = value == null ? '' : String(value);
  }
  return inspection;
}

/** Read every case from Postgres as Inspection rows. */
export async function getDbInspections(executor?: Queryable): Promise<Inspection[]> {
  const { rows } = await executorOr(executor).query(
    `SELECT ${SELECT_COLUMNS} FROM cases ORDER BY case_number`
  );
  return rows.map(rowToInspection);
}

/**
 * Update the six human-edit fields of one case. Mirrors the sheet writer's
 * contract: throws RowNotFoundError when no case matches, requires at least one
 * edit, and never touches the read-only columns. `rowNumber` is meaningless for
 * Postgres and is returned as 0 (the client does not use it).
 */
export async function updateDbInspectionFields(
  caseNumber: string,
  edits: Partial<SixEditFields>,
  executor?: Queryable
): Promise<UpdateInspectionResult> {
  const trimmed = caseNumber.trim();
  if (!trimmed) throw new Error('caseNumber is required to address a case row.');
  const fields = Object.keys(edits) as (keyof SixEditFields)[];
  if (fields.length === 0) {
    throw new Error('updateDbInspectionFields called with no field edits.');
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const field of fields) {
    params.push(edits[field] ?? '');
    setClauses.push(`${EDIT_FIELD_COLUMN[field]} = $${params.length}`);
  }
  params.push(trimmed); // WHERE case_number = $n

  const sql = `UPDATE cases SET ${setClauses.join(', ')} WHERE case_number = $${params.length} RETURNING case_number`;
  const { rowCount } = await executorOr(executor).query(sql, params);

  if (!rowCount) {
    throw new RowNotFoundError(trimmed);
  }
  return { caseNumber: trimmed, rowNumber: 0, writtenFields: fields };
}

/**
 * Idempotent upsert used by the seed/migrate script: INSERT every case, or on
 * case_number conflict refresh all non-PK columns. Blank values are stored as
 * the empty string (matching how the sheet/serving layer treats a blank cell),
 * so a re-run reproduces the sheet exactly.
 */
export async function upsertCases(rows: Inspection[], executor?: Queryable): Promise<number> {
  if (rows.length === 0) return 0;

  const insertColumns = FIELD_ORDER.map((f) => FIELD_COLUMN[f]).join(', ');
  const updateAssignments = FIELD_ORDER.filter((f) => f !== 'caseNumber')
    .map((f) => `${FIELD_COLUMN[f]} = EXCLUDED.${FIELD_COLUMN[f]}`)
    .join(', ');

  let written = 0;
  const exec = executorOr(executor);
  // Batch a little to keep the round-trips reasonable for the ~80-row sheet.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 0;
    for (const row of chunk) {
      const placeholders: string[] = [];
      for (const field of FIELD_ORDER) {
        params.push(row[field] ?? '');
        p += 1;
        placeholders.push(`$${p}`);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }
    const sql =
      `INSERT INTO cases (${insertColumns}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (case_number) DO UPDATE SET ${updateAssignments}`;
    const res = await exec.query(sql, params);
    written += res.rowCount ?? chunk.length;
  }
  return written;
}
