-- Board UI batch — "Contact at Insured" column.
--
-- contact_at_insured : the LC360 `PolicyContactName` field ("Contact at
--               Insured"). Populated by the LC360→DB ingest (LC360-owned
--               column, refreshed on insert AND on conflict). The live
--               Google Sheet carries the same value under the header
--               "PolicyContactName", so the sheet reader maps it too — and,
--               unlike policy_number/phone/agent_*, the sheet→db migrate
--               path may write it (its sheet-sourced value is real data,
--               not a blank that would wipe the ingest's).
--
-- Idempotent: safe to re-run (IF NOT EXISTS). Applied automatically by
-- scripts/ingest-lc360-to-db.ts on every ingest run, alongside 001/002.

ALTER TABLE cases ADD COLUMN IF NOT EXISTS contact_at_insured text;
