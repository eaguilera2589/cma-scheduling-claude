# CMA Scheduling (Loss Control 360 automation)

Automates the busywork around scheduling inspection appointments across
**two Loss Control 360 tenants** — PreferredReports (`preferred.losscontrol360.com`)
and Sutton Reports (`ecommerce3.sibfla.com`), both the same underlying LC360
platform under different branding — so the only manual work left is the
actual human judgment call: whether/when to schedule, and what to note about
the contact attempt.

**Status: live in production.** Pull side (both portals) and Phase 2 push
(Preferred only, see Open Items) are active/verified against real cases.

## Architecture

The production system runs entirely in n8n (`http://192.168.1.74:5678`) as
two workflows, both using plain HTTP nodes against LC360's real endpoints
rather than browser automation — much lighter than the original
Playwright-based plan.

```
n8n: "LC360 → Google Sheet (Inspection Export)"  (id cG2WVIbQkPAfBvWW, active, every 2h)
  ├─▶ Preferred branch: logs into preferred.losscontrol360.com (HTTP, cookie/
  │     anti-forgery-token flow) → POST /WebServices/LandingPage.asmx/GetCases
  │     → maps rows, tags Portal = "Preferred"
  ├─▶ Sutton branch: identical flow against ecommerce3.sibfla.com
  │     → maps rows, tags Portal = "Sutton"
  └─▶ merges both branches → upserts rows into TWO destinations, both
        matched by CaseID only (GUIDs are effectively unique across tenants,
        so Portal is not part of the match key — keeps this from ever
        duplicating pre-existing rows):
          1. the human-edited "Inspections" sheet (never touches the
             human-edit columns — safe to re-run anytime)
          2. "CMA Automation Feed (Inspections)" — a separate, automation-only
             spreadsheet with the same case data, added 2026-09-22 so
             downstream automations (see `cma-automated-field-emails`) don't
             depend on a sheet humans are actively editing
                                                            │
                              Enrique fills in: Schedule Appointment (Y/N),
                              Date, Time, Attempted to Contact, Comments,
                              then sets Sync Status = "Ready to Sync"
                                                            │
n8n: "LC360 Scheduling Sync (Phase 2)"  (id BNHnE6trqQk079eo, manual trigger)
  └─▶ reads the sheet, filters to Sync Status == "Ready to Sync"
  └─▶ resolves "Attempted to Contact" against that case's real contact types
  └─▶ POST /api/CaseScheduling/AddScheduleItem  (writes to LC360's Scheduling
        Summary Info — never the general Case Notes log, see below)
  └─▶ if Y: refreshes a Zoho token and POSTs a Zoho Calendar event
  └─▶ writes back Sync Status = "Synced" or "Error: <reason>" + Last Synced
```

Google Sheet: [Inspections](https://docs.google.com/spreadsheets/d/1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0/edit)
(owned by `inspections@cmainspections.com`), tab "Inspections". Columns are
the ~40 LC360 fields, `Portal` (`Preferred` or `Sutton`), plus `Case Link`,
`Last Synced`, and the human-edit columns: `Schedule Appointment (Y/N)`,
`Date`, `Time`, `Attempted to Contact`, `Comments`, `Sync Status`. This is
the sheet Enrique works from — Phase 2 reads it.

Automation-only mirror: "CMA Automation Feed (Inspections)" (spreadsheet id
`12baCBOqJmolinW88sVf6lTC4v4iqoEPSU4au33nTzyk`, also owned by
`inspections@cmainspections.com`, tab "Inspections"). Same LC360 fields +
`Portal`, no human-edit columns, never touched by hand. Exists purely so
other automations (e.g. `cma-automated-field-emails`) have a stable read
source that isn't subject to concurrent manual edits, sorting, or filters on
the human-facing sheet.

**To schedule an appointment:** fill in those 6 columns for a row (Date as
`MM/DD/YYYY`, Time as e.g. `4:00 PM`, Attempted to Contact must exactly match
one of that case's valid contact types — usually `Insured`, `Agent`, or
`Other`), then set `Sync Status` to exactly `Ready to Sync`. Run the "LC360
Scheduling Sync (Phase 2)" workflow (currently manual — see Open Items).

## Why two n8n workflows instead of the original Playwright plan

The original plan (see `scraper/`) was a Node.js + Playwright scraper driven
by n8n's Execute Command node. While building it, an existing, more advanced
n8n workflow was discovered already doing the LC360 login + an official ASMX
JSON endpoint (no HTML scraping needed) — that became the foundation instead.
`scraper/` is kept as a reference: `login.js`/`grid.js`/`push.js` were used to
discover and verify LC360's real API contracts (the Kendo grid's
`RequiresScheduling` class, the `/api/CaseScheduling/*` endpoints, the ASMX
`GetCases` endpoint) before porting the same logic into n8n nodes.

## Known limitations / open items

- **Fixed and live-verified 2026-09-22: three IF nodes silently swallowed
  errors and fired the sheet-update step prematurely.** While debugging a
  failed sync for case #2447348 (its row was missing "Attempted to
  Contact"), found that `IF Valid Row`, `IF Contact Resolved`, and
  `IF Appointment` all had their true and false branches wired to the
  *same* output — the false ("this failed / this is attempt-only") branch
  had no connections at all for the first two, so invalid rows or
  unresolvable contact types did nothing and never got an
  `Error: ...` written back to `Sync Status`, exactly what happened to
  #2447348. Worse, because both branches fired together on success, a
  successful row could trigger `Prepare Sheet Update` prematurely — in
  parallel with, not after, the real `AddScheduleItem`/Zoho work — meaning
  a later failure in that same row's processing could go unnoticed since
  the sheet had already been marked "Synced". Fixed by properly separating
  each IF node's true/false outputs (true continues the pipeline only;
  false routes to `Prepare Sheet Update` — for `IF Appointment`, false
  means "attempt only, not a scheduled appointment," a valid completion,
  not an error). Live-verified end to end immediately after the fix: filled
  in #2447348's missing field, re-ran Phase 2, got a real appointment
  pushed to LC360 (10/1/2026 9:00 AM), a real Zoho Calendar event, and the
  sheet correctly marked `Synced` — all in one clean pass, then confirmed
  the case dropped out of `cma-automated-field-emails`'s eligible list on
  the next pull cycle.
- **Fixed 2026-09-22: Phase 2 silently processed only one "Ready to Sync"
  row per run.** `Resolve Contact Type` used `$input.first()` plus an
  implicit single-item return instead of looping over every input item —
  if you ever marked more than one row "Ready to Sync" and ran Phase 2 once,
  only the first got pushed to LC360/Zoho; the rest were silently left
  untouched (not lost — they'd just stay "Ready to Sync" until the next
  run). Never caused a problem in practice because it was only ever
  exercised one row at a time, but was caught while building
  `cma-automated-field-emails`, which cloned this exact pattern and hit it
  immediately with 3 rows. Fixed by looping over `$input.all()` with n8n's
  `itemMatching()` to correctly re-pair each `GetCaseScheduleNotes` response
  back to its originating sheet row. Not yet re-verified live with an
  actual multi-row "Ready to Sync" batch — the fix was unit-tested outside
  n8n before pushing, but if you batch multiple rows ready at once, keep an
  eye on the first real run.
- **Phase 2 only pushes back to Preferred.** The Sutton pull was added
  2026-09-22 to get cases from both portals into the sheet; Phase 2 (writing
  scheduling data back + Zoho Calendar) has not been extended to route to
  Sutton yet. Scheduling a Sutton-portal row via the sheet today will not
  work correctly — extend Phase 2 to branch on the `Portal` column before
  relying on it for Sutton cases.
- **Phase 2 is manual-trigger only.** Decide whether to add a schedule
  trigger so it runs automatically instead of clicking "Execute workflow"
  after marking rows ready.
- **Secrets live in plaintext inside n8n Code/HTTP nodes** (LC360 login
  credentials for both portals, and a Zoho OAuth client id/secret/refresh
  token) rather than n8n's credential vault. This was a deliberate, discussed
  tradeoff: n8n's public API can't create credentials, `$credentials` doesn't
  resolve in HTTP node expressions on this n8n version, and enabling `$env`
  access for Code nodes is an instance-wide security flag, not a scoped fix.
  Do not export/share these workflows without stripping those values first.
- **No delete path for LC360 schedule-history entries.** Only actual
  appointments can be cancelled (`/api/CaseScheduling/CancelAppointment`);
  logged "attempted to contact" entries are permanent. Test carefully.
- The Zoho Calendar step uses the same manual refresh-token pattern as the
  pre-existing "CMA Cust Appt Reminder" workflow (calendar
  `8a7a896edb0f41649892a96d48ab70a3`, owned by `inspections@cmainspections.com`,
  shared with "Manage" permission to the token's account) rather than n8n's
  native `zohoOAuth2Api` credential type, which turned out to have no
  Client ID/Secret configured and was left unfixed as lower priority.

## Repo layout (reference/dev tooling, not the production path)

- `scraper/` — Node.js + Playwright. Used to discover and verify LC360's site
  structure and API contracts before porting the logic into n8n. `.env` here
  holds LC360 credentials for re-running discovery if the site changes
  (git-ignored).
- `n8n-workflow/` — exported copies of the relevant n8n workflows for
  reference, plus `.env` for the n8n API key used to manage them via the API
  (both git-ignored — these exports contain live secrets).
- `scripts/` — `format-sheet.js`, an idempotent one-shot formatter for the
  Inspections sheet (freeze header, filter, hide noise columns, conditional
  formatting, dropdowns, a "Days Until Due" column, and "Needs
  Scheduling"/"Scheduled" helper tabs). Run with `cd scripts && node
  format-sheet.js`; depends on the Google Sheets API being enabled in the same
  GCP project as the webapp.
- `webapp/` — read-only Next.js 15 dashboard over the Inspections sheet (two
  tabs, sortable table / mobile cards, due-date coloring, Rush/Escalated
  flags). Reads only — scheduling is still via n8n Phase 2. See
  [`webapp/README.md`](webapp/README.md).
