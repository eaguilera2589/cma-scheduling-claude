# CMA Scheduling (Loss Control 360 automation)

Automates the busywork around scheduling inspection appointments in
**PreferredReports / Loss Control 360** (`preferred.losscontrol360.com`), so the
only manual work left is the actual human judgment call: whether/when to
schedule, and what to note about the contact attempt.

**Status: live in production as of 2026-09-17.** Both n8n workflows below are
active/verified against real cases.

## Architecture

The production system runs entirely in n8n (`http://192.168.1.74:5678`) as
two workflows, both using plain HTTP nodes against LC360's real endpoints
rather than browser automation — much lighter than the original
Playwright-based plan.

```
n8n: "LC360 → Google Sheet (Inspection Export)"  (id cG2WVIbQkPAfBvWW, active, every 2h)
  └─▶ logs into LC360 (HTTP, cookie/anti-forgery-token flow)
  └─▶ POST /WebServices/LandingPage.asmx/GetCases  (official ASMX JSON endpoint, ~40 fields)
  └─▶ upserts rows into the Google Sheet, matched by CaseID
        (never touches the human-edit columns — safe to re-run anytime)
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
the ~40 LC360 fields plus `Case Link`, `Last Synced`, and the human-edit
columns: `Schedule Appointment (Y/N)`, `Date`, `Time`, `Attempted to Contact`,
`Comments`, `Sync Status`.

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

- **Phase 2 is manual-trigger only.** Decide whether to add a schedule
  trigger so it runs automatically instead of clicking "Execute workflow"
  after marking rows ready.
- **Secrets live in plaintext inside two n8n Code/HTTP nodes** (the LC360
  login credentials, and a Zoho OAuth client id/secret/refresh token) rather
  than n8n's credential vault. This was a deliberate, discussed tradeoff:
  n8n's public API can't create credentials, `$credentials` doesn't resolve
  in HTTP node expressions on this n8n version, and enabling `$env` access
  for Code nodes is an instance-wide security flag, not a scoped fix. Do not
  export/share these two workflows without stripping those values first.
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
