/**
 * Postgres write path for the LC360 ingest.
 *
 * Upserts `cases` by `case_number`, refreshing ONLY the LC360-owned (read-only)
 * columns on conflict. The six human-edit columns — schedule_appointment_yn,
 * "date", "time", attempted_to_contact, comments, sync_status — are set to a
 * blank default on first INSERT and are NEVER touched by the ON CONFLICT UPDATE,
 * mirroring the live n8n pull's rule of never clobbering human-edited cells.
 *
 * Every value is bound as a query parameter; only fixed, code-defined column
 * identifiers ever appear in the SQL string. This module uses the shared pool
 * (src/lib/db/pool) and is written directly to DATABASE_URL.
 */
import type { Queryable } from '../db/caseRepository';
import { getPool } from '../db/pool';
import type { Lc360Case } from './client';

/**
 * LC360-owned columns the ingest writes on every run (insert AND update).
 * Excludes the PK (case_number) and the six human-edit columns.
 */
const LC360_OWNED_COLUMNS: readonly string[] = [
  'insured_name',
  'location_address',
  'location_city',
  'location_state',
  'inspection_due',
  'date_scheduled_for',
  'portal',
  'rush',
  'escalated',
  'scheduling_status',
  'case_type',
  'policy_number',
  'phone',
  'agent_name',
  'agent_number',
  // LC360 GUID (raw GetCases CaseID). LC360-owned: refreshed on insert AND on
  // conflict; never one of the six preserved human-edit columns.
  'caseid',
];

/**
 * The six human-edit columns: INSERT defaults only, never in the UPDATE clause.
 * Quoted where the bare name is a reserved SQL keyword.
 */
const HUMAN_EDIT_COLUMNS: readonly string[] = [
  'schedule_appointment_yn',
  '"date"',
  '"time"',
  'attempted_to_contact',
  'comments',
  'sync_status',
];

/** camel-free accessor: each Lc360Case key already matches its column name. */
function valueFor(row: Lc360Case, column: string): string {
  return (row as unknown as Record<string, string>)[column] ?? '';
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/**
 * Idempotent LC360 upsert. Returns how many rows were freshly inserted vs.
 * updated (detected per row via `xmax = 0`, which is true only on INSERT).
 */
export async function upsertLc360Cases(rows: Lc360Case[], executor?: Queryable): Promise<UpsertResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const exec: Queryable = executor ?? getPool();

  const insertColumns = ['case_number', ...LC360_OWNED_COLUMNS, ...HUMAN_EDIT_COLUMNS].join(', ');
  const updateAssignments = LC360_OWNED_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

  let inserted = 0;
  let updated = 0;
  const BATCH = 50;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 0;
    for (const row of chunk) {
      const placeholders: string[] = [];
      params.push(row.case_number);
      p += 1;
      placeholders.push(`$${p}`);
      for (const column of LC360_OWNED_COLUMNS) {
        params.push(valueFor(row, column));
        p += 1;
        placeholders.push(`$${p}`);
      }
      // Human-edit columns: blank default, present only in the INSERT tuple.
      for (const _ of HUMAN_EDIT_COLUMNS) {
        params.push('');
        p += 1;
        placeholders.push(`$${p}`);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }

    const sql =
      `INSERT INTO cases (${insertColumns}) VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT (case_number) DO UPDATE SET ${updateAssignments} ` +
      `RETURNING (xmax = 0) AS inserted`;

    const { rows: returned } = await exec.query(sql, params);
    for (const r of returned) {
      if ((r as { inserted?: boolean }).inserted) inserted += 1;
      else updated += 1;
    }
  }

  return { inserted, updated };
}
