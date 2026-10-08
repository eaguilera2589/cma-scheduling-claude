/**
 * LC360 -> staging Postgres ingest (canonical seeder; idempotent; safe to re-run).
 *
 * This REPLACES the Google-Sheet seed (`migrate:sheet-to-db`) as the source of
 * truth for the staging `cases` table: it authenticates to BOTH LC360 portals
 * directly and upserts every case by `case_number`, refreshing only the
 * LC360-owned columns and never the six human-edit columns. It writes ONLY to
 * the staging database (DATABASE_URL in infra/.env.staging) and never touches
 * the live Google Sheet, the live n8n workflow, or production.
 *
 * Requires at runtime (all via --env-file=infra/.env.staging):
 *   - DATABASE_URL              staging Postgres connection string
 *   - LC360_PREFERRED_USERNAME  Preferred portal username
 *   - LC360_SUTTON_USERNAME     Sutton portal username
 *   - LC360_PASSWORD            shared LC360 password (NEVER printed)
 *
 * Run via the npm script `lc360:ingest`, or the cma-lc360-ingest-staging.service
 * systemd user unit (driven by cma-lc360-ingest-staging.timer every 2h).
 *
 * Dry-run: set LC360_INGEST_DRY_RUN=1 to authenticate both portals and report
 * counts WITHOUT touching the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTALS, fetchPortal, type Lc360Case } from '../src/lib/lc360/client';
import { upsertLc360Cases } from '../src/lib/lc360/repository';
import { getPool, closePool } from '../src/lib/db/pool';

const DRY_RUN = process.env.LC360_INGEST_DRY_RUN === '1';

/**
 * Optional mirror/prune mode (OFF by default). When LC360_INGEST_PRUNE=1, after
 * the upsert the ingest deletes staging rows whose case_number is absent from the
 * current LC360 active pull, so `cases` mirrors LC360 exactly (count == LC360
 * total). This is a DESTRUCTIVE delete of staging rows only (never prod). It is
 * intentionally opt-in because the staging table may still hold sheet-era
 * historical cases; leave OFF unless a true mirror of LC360 is wanted.
 */
const PRUNE = process.env.LC360_INGEST_PRUNE === '1';

/** Ensure the `cases` schema exists (idempotent CREATE TABLE IF NOT EXISTS). */
async function applyMigration(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, '..', 'db', 'migrations', '001_init.sql');
  await getPool().query(fs.readFileSync(file, 'utf8'));
}

async function main(): Promise<void> {
  const started = Date.now();
  const password = process.env.LC360_PASSWORD;
  if (!password) {
    throw new Error('Missing env var LC360_PASSWORD (set it in infra/.env.staging).');
  }

  console.log(
    `[lc360] DATA_SOURCE guard: reads LC360 read-only; writes ONLY the staging DB via DATABASE_URL.` +
      (DRY_RUN ? ` [DRY RUN: no DB writes]` : ``)
  );

  // Authenticate + fetch both portals.
  const results = await Promise.all(PORTALS.map((p) => fetchPortal(p, password)));

  // Combine, tagging provenance; de-dupe by case_number (last portal wins) and
  // drop any row with a blank case_number (cannot key the PK).
  const byCase = new Map<string, Lc360Case>();
  let emptyKey = 0;
  let crossPortalDupes = 0;
  const perPortalCount: Record<string, number> = {};
  for (const r of results) {
    perPortalCount[r.label] = r.cases.length;
    for (const c of r.cases) {
      const key = c.case_number.trim();
      if (!key) {
        emptyKey++;
        continue;
      }
      if (byCase.has(key)) crossPortalDupes++;
      byCase.set(key, { ...c, case_number: key });
    }
  }
  const deduped = [...byCase.values()];
  const lc360Total = deduped.length;

  if (emptyKey > 0) console.warn(`[lc360] WARNING: skipped ${emptyKey} row(s) with an empty CaseNumber.`);
  if (crossPortalDupes > 0) console.warn(`[lc360] WARNING: ${crossPortalDupes} case_number(s) appeared on more than one portal (last portal wins).`);

  const countsLine = results.map((r) => `${r.label}=${r.cases.length}`).join(' ');
  console.log(`[lc360] LC360 rows — ${countsLine} total(distinct)=${lc360Total}`);

  if (DRY_RUN) {
    // Required summary line for the dry-run acceptance check; writes nothing.
    console.log(`[lc360] DRY RUN — authenticated: ${results.map((r) => r.label).join(', ')}. No DB writes.`);
    console.log(`Preferred=${perPortalCount.Preferred ?? 0} Sutton=${perPortalCount.Sutton ?? 0} total=${lc360Total}`);
    console.log(`[lc360] done in ${Date.now() - started} ms.`);
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set; refusing to run a real ingest without a DB target.');
  }

  console.log('[lc360] applying schema db/migrations/001_init.sql ...');
  await applyMigration();

  console.log(`[lc360] upserting ${deduped.length} case(s) into Postgres ...`);
  const { inserted, updated } = await upsertLc360Cases(deduped);
  console.log(`[lc360] upsert result: inserted=${inserted} updated=${updated}`);

  // --- Optional mirror/prune (destructive, opt-in; staging rows only) ---
  if (PRUNE) {
    // Safety guard #1 (effective keep set — the real blast-radius guard): the DELETE
    // below is keyed on `deduped`, NOT on the raw per-portal arrays. If `deduped` is
    // empty the keep array is empty and `NOT (case_number = ANY('{}'))` matches EVERY
    // row, wiping the table. A non-empty raw pull can still dedupe to empty (e.g. every
    // row had a blank CaseNumber and was dropped above), so guard the EFFECTIVE set here.
    if (deduped.length === 0) {
      console.warn(
        '[lc360] PRUNE SKIPPED: the effective keep set (deduped) is empty — ' +
          'refusing to run a mirror that would delete every staging row.'
      );
    }
    // Safety guard #2: never prune unless BOTH portals returned rows — a one-sided auth
    // glitch must not be allowed to mass-delete the table.
    else if (results.some((r) => r.cases.length === 0)) {
      console.warn('[lc360] PRUNE SKIPPED: a portal returned zero rows — refusing to delete on a partial pull.');
    } else {
      const keep = deduped.map((c) => c.case_number);
      const del = await getPool().query<{ deleted: number }>(
        `WITH gone AS (
           DELETE FROM cases WHERE NOT (case_number = ANY($1::text[])) RETURNING 1
         ) SELECT count(*)::int AS deleted FROM gone`,
        [keep]
      );
      console.log(`[lc360] PRUNE: deleted ${del.rows[0]?.deleted ?? 0} row(s) absent from LC360 (mirror mode).`);
    }
  }

  // --- Verification report (reads only; no credentials) ---
  const pool = getPool();
  const total = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM cases');
  const distinct = await pool.query<{ n: number }>('SELECT count(DISTINCT case_number)::int AS n FROM cases');
  const dbCount = total.rows[0]?.count ?? -1;
  console.log(`Preferred=${perPortalCount.Preferred ?? 0} Sutton=${perPortalCount.Sutton ?? 0} total=${lc360Total} (LC360 distinct)`);
  console.log(`[lc360] SELECT count(*) FROM cases = ${dbCount}; distinct case_number = ${distinct.rows[0]?.n ?? -1}`);
  if (dbCount !== lc360Total) {
    console.warn(
      `[lc360] NOTE: DB count (${dbCount}) != LC360 distinct (${lc360Total}). ` +
        `Upserts never delete; if LC360 dropped cases since the last run, ` +
        `stale rows remain. Report this discrepancy.`
    );
  }

  const populated = await pool.query<{ pn: number; ph: number; an: number; ag: number }>(
    `SELECT
       count(*) FILTER (WHERE policy_number IS NOT NULL AND policy_number <> '')::int AS pn,
       count(*) FILTER (WHERE phone         IS NOT NULL AND phone         <> '')::int AS ph,
       count(*) FILTER (WHERE agent_name    IS NOT NULL AND agent_name    <> '')::int AS an,
       count(*) FILTER (WHERE agent_number  IS NOT NULL AND agent_number  <> '')::int AS ag
     FROM cases`
  );
  console.log(
    `[lc360] populated (non-empty) — policy_number=${populated.rows[0].pn} phone=${populated.rows[0].ph} ` +
      `agent_name=${populated.rows[0].an} agent_number=${populated.rows[0].ag}`
  );
  console.log(`[lc360] done in ${Date.now() - started} ms.`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error('[lc360] FAILED:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    process.exitCode = 1;
  });
