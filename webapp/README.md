# CMA Scheduling (webapp)

A read-only dashboard over the production **Inspections** Google Sheet. It
shows which inspection cases still need scheduling and which are already
booked, so the scheduling queue can be worked without opening the sheet.

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind. The page fetches
`/api/inspections`, which reads the same "Inspections" sheet the n8n pull
workflow writes to. **It never writes anything back** — scheduling itself is
still done by editing the sheet and running the n8n Phase 2 workflow.

## What it shows

Two tabs, splitting every case on the `Date Scheduled For` column:

- **Needs Scheduling** — rows where `Date Scheduled For` is blank.
- **Scheduled** — rows where it holds a date (this tab also shows a
  non-sortable *Scheduled* column with that date).

Each tab shows a live count.

Desktop renders a table (Case #, Insured, Address, City/State, Due, Portal,
Flags); below the `md` breakpoint the same rows render as stacked cards. The
first six columns (everything but Flags) are sortable and toggle asc/desc;
blank and unparseable values always sink to the bottom.

- **Due-date coloring** — red = overdue, amber = due within 3 days, plain
  otherwise (`MM/DD/YYYY` dates).
- **Flags** — a row with `Rush` or `Escalated` set to `Y` gets a matching
  pill.

## Prerequisites

- Node.js **>= 20**.
- A Google **service-account key JSON** that has read access to the sheet.
  It must live **outside this repo** — never place it under `webapp/`.
- **Google Sheets API enabled** in GCP project `openclaw-crm-490018`, and the
  sheet shared with the service account. See [Sheet access](#sheet-access) —
  this is a one-time setup and is **not yet done** (see
  [Known limitations](#known-limitations)).

## Setup and run

```bash
cd webapp
npm install
cp .env.example .env.local   # then fill in the three values (see below)
npm run dev                  # http://localhost:3000
```

Other scripts:

```bash
npm run build      # next build
npm run start      # next start (production server; run after build)
npm run typecheck  # tsc --noEmit
```

`.env.local` is git-ignored. `GOOGLE_SA_KEY_PATH` points at a file outside the
repo, so nothing secret is ever committed from here.

## Configuration

`webapp/.env.example` → copy to `webapp/.env.local`. Three variables:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SHEET_ID` | yes | — | Spreadsheet id. The production Inspections sheet is `1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0`. |
| `SHEET_TAB` | no | `Inspections` | Tab name to read. |
| `GOOGLE_SA_KEY_PATH` | yes* | — | Absolute path to the service-account JSON, **outside the repo**. |

\* `GOOGLE_APPLICATION_CREDENTIALS` is accepted as a fallback for the key path
if `GOOGLE_SA_KEY_PATH` is unset.

Example:

```bash
SHEET_ID=1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0
SHEET_TAB=Inspections
GOOGLE_SA_KEY_PATH=/path/outside/repo/service-account.json
```

## Sheet access

The app authenticates with a Google service account
(`pintame-prime@openclaw-crm-490018.iam.gserviceaccount.com`, GCP project
`openclaw-crm-490018`) using the `spreadsheets.readonly` scope. Two one-time
steps on the Google Cloud side:

1. **Enable the Google Sheets API** for project `openclaw-crm-490018`
   (Google Cloud Console → APIs & Services → Library → "Google Sheets API" →
   Enable).
2. **Share the sheet** with `pintame-prime@openclaw-crm-490018.iam.gserviceaccount.com`
   with **Viewer** (read) access, the same way you'd share with a person.

Until both are done, `/api/inspections` returns `502` and the UI shows
*"Could not load inspections"*.

## Known limitations

- **Read-only.** No scheduling happens here. To schedule, edit the sheet's
  human-edit columns and run the n8n Phase 2 workflow (see the repo root
  [README](../README.md)).
- **Live data needs the Sheets API enabled and the sheet shared** with the
  service account (see [Sheet access](#sheet-access)). The code is complete;
  as of writing the API is **not yet enabled** in `openclaw-crm-490018`, so a
  fresh run against real data returns the load error until that one-time step
  is completed.
- **Sheet reads are cached in memory for 60 seconds.** New or changed rows
  can take up to a minute to appear; restart the dev server to clear the cache.
