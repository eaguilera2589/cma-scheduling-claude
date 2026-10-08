-- Phase 1 — initial schema for the CMA Scheduling staging database.
--
-- `cases` mirrors the webapp's Inspection shape (src/lib/types.ts): the
-- read-only LC360 columns plus the six human-edit columns. All values are stored
-- as text in Phase 1 (the sheet is the source of truth for format today, e.g.
-- dates as "MM/DD/YYYY"); stricter typing is a later-phase concern.
--
-- PK is case_number (the live sheet's CaseNumber is unique — verified: 83 rows,
-- 0 duplicates). The four Phase-2 columns are added now, nullable, so seeding
-- and the sheet code path never need to know about them.
--
-- `date` and `time` are SQL type keywords, so the columns are quoted; the
-- repository layer always references them quoted as well.

CREATE TABLE IF NOT EXISTS cases (
  case_number             text PRIMARY KEY,

  -- Read-only LC360 columns (n8n pull).
  insured_name            text,
  location_address        text,
  location_city           text,
  location_state          text,
  inspection_due          text,  -- "MM/DD/YYYY" | ''
  date_scheduled_for      text,  -- "MM/DD/YYYY" | '' (== not yet scheduled)
  portal                  text,  -- "Preferred" | "Sutton" | ''
  rush                    text,  -- "Y"/"TRUE"/'' etc (stored verbatim)
  escalated               text,
  scheduling_status       text,
  case_type               text,

  -- Human-edit columns (writable via PATCH /api/inspections/[caseNumber]).
  schedule_appointment_yn text,  -- "Y" | "N" | ''
  "date"                  text,  -- appointment date "MM/DD/YYYY" | ''
  "time"                  text,  -- appointment time "H:MM AM/PM" | ''
  attempted_to_contact    text,  -- "Insured" | "Agent" | "Other" | ''
  comments                text,
  sync_status             text,  -- '' | "Ready to Sync" | "Synced" | "Error: ..."

  -- Phase 2 columns (added now, populated later; nullable, unused in Phase 1).
  policy_number           text,
  phone                   text,
  agent_name              text,
  agent_number            text
);
