/**
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ SEED-ONLY — run only BEFORE / DURING the sheet→DB cutover.                     │
 * │ After prod runs with DATA_SOURCE=db, this script REVERTS DB-side human edits    │
 * │ to (stale) sheet values: upsertCases() ON CONFLICT refreshes the six human-edit │
 * │ columns (Schedule Y/N, Date, Time, Attempted to Contact, Comments, Sync Status) │
 * │ and contact_at_insured from the sheet. A re-run post-cutover requires a         │
 * │ coordinated EDIT FREEZE and is a documented rollback-RECOVERY step, NOT routine.│
 * │ Procedure: docs/runbooks/db-cutover.md.                                        │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Sheet -> Postgres seed/migrate (one-shot, idempotent, safe to re-run BEFORE
 * cutover only — see the SEED-ONLY box above).
 *
 * Reads the live Google Sheet via the existing read path (getInspections) — it
 * ONLY READS the sheet, never writes it — ensures the `cases` schema exists
 * (db/migrations/001_init.sql), and upserts every row by case_number.
 *
 * Requires, at runtime:
 *   - sheet creds: SHEET_ID / SHEET_TAB / GOOGLE_SA_KEY_PATH  (from webapp/.env.local)
 *   - DB target:   DATABASE_URL                               (from infra/.env.staging)
 * Run via the npm script `migrate:sheet-to-db`, which supplies both with
 * --env-file and installs the TS resolution hook with --import.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getInspections } from '../src/lib/sheets';
import { getPool, closePool } from '../src/lib/db/pool';
import { upsertCases } from '../src/lib/db/caseRepository';
import type { Inspection } from '../src/lib/types';

async function applyMigration(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '..', 'db', 'migrations', '001_init.sql');
  const sql = fs.readFileSync(file, 'utf8');
  // CREATE TABLE IF NOT EXISTS — idempotent, safe to re-run.
  await getPool().query(sql);
}

function run(): Promise<void> {
  return (async () => {
    const started = Date.now();
    console.warn(
      '[migrate] SEED-ONLY: intended for BEFORE/DURING cutover. With DATA_SOURCE=db this ' +
        'REFRESHES the six human-edit columns (and contact_at_insured) from the (possibly ' +
        'stale) sheet and would revert post-cutover DB edits. A re-run requires a coordinated ' +
        'edit freeze (rollback-recovery only). See docs/runbooks/db-cutover.md.'
    );
    console.log('[migrate] DATA_SOURCE guard: this script reads the sheet READ-ONLY and writes only to Postgres.');

    console.log('[migrate] reading live sheet via getInspections() (read-only)...');
    const sheetRows = await getInspections();
    console.log(`[migrate] sheet inspection rows read: ${sheetRows.length}`);

    // Defensive: drop rows with no CaseNumber (cannot key the PK) and de-dupe by
    // case_number so a single multi-row upsert never "affects a row twice".
    const byCase = new Map<string, Inspection>();
    let skippedEmpty = 0;
    for (const row of sheetRows) {
      const key = row.caseNumber.trim();
      if (!key) {
        skippedEmpty++;
        continue;
      }
      byCase.set(key, { ...row, caseNumber: key });
    }
    const deduped = [...byCase.values()];
    if (skippedEmpty > 0) console.warn(`[migrate] WARNING: skipped ${skippedEmpty} row(s) with an empty CaseNumber.`);
    if (deduped.length !== sheetRows.length - skippedEmpty) {
      console.warn(`[migrate] WARNING: de-duplicated duplicate caseNumbers (${sheetRows.length - skippedEmpty} -> ${deduped.length}).`);
    }

    console.log('[migrate] applying schema db/migrations/001_init.sql ...');
    await applyMigration();

    console.log(`[migrate] upserting ${deduped.length} case(s) into Postgres ...`);
    const affected = await upsertCases(deduped);

    const { rows } = await getPool().query<{ count: number }>('SELECT count(*)::int AS count FROM cases');
    const dbCount = rows[0]?.count ?? -1;
    console.log(`[migrate] upsert affected rows: ${affected}; SELECT count(*) FROM cases = ${dbCount}`);
    console.log(`[migrate] expected (unique caseNumbers from sheet): ${deduped.length}`);
    if (dbCount !== deduped.length) {
      console.warn(`[migrate] WARNING: count mismatch — sheet=${deduped.length} db=${dbCount}`);
    } else {
      console.log('[migrate] OK: DB row count matches the sheet.');
    }
    console.log(`[migrate] done in ${Date.now() - started} ms.`);
  })();
}

run()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exitCode = 1;
  });
