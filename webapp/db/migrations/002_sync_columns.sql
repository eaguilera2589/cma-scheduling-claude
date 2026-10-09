-- Phase 2 (T1) — sync columns for the Postgres-driven n8n↔Postgres workflow.
--
-- caseid      : the LC360 case GUID — raw `CaseID` field returned by the LC360
--               GetCases API (a GUID, unique per case across portals). The
--               LC360→DB ingest refreshes it on every pull (LC360-owned column).
--               The Phase-2 write-back workflow addresses cases in LC360 by this
--               GUID, so it must be stored; `case_number` stays the DB PK.
-- last_synced : written by the Phase-2 write-back when a row's human edits are
--               pushed to LC360 (i.e. when sync_status moves to "Synced").
--               NULL until that workflow exists — nothing writes it yet.
--
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere). Applied automatically
-- by scripts/ingest-lc360-to-db.ts on every ingest run, alongside 001_init.sql.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS caseid text;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_synced timestamptz;

-- Lookup by LC360 GUID (write-back verification / cross-portal addressing).
CREATE INDEX IF NOT EXISTS cases_caseid_idx ON cases (caseid);

-- Lookup by sync state for the Phase-2 consumer ("which rows are Ready to
-- Sync?"). lower() so case-insensitive predicates can use the index; cheap at
-- this table size. If the final consumer queries an exact literal instead, a
-- plain or partial index would fit better — revisit in the Phase-2 task.
CREATE INDEX IF NOT EXISTS cases_sync_status_idx ON cases (lower(sync_status));
