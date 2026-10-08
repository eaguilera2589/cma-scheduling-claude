# CMA Scheduling (webapp)

The scheduling interface over the production **Inspections** Google Sheet. It
shows which inspection cases still need scheduling and which are already
booked, lets the scheduler **make the scheduling changes directly in the
browser** (editing the six human-edit columns), and can **trigger the n8n
Phase 2 sync** with one click. The LC360/Zoho push itself still happens inside
n8n — this app only writes sheet cells and fires the webhook.

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind. The page fetches
`/api/inspections`, which reads the same "Inspections" sheet the n8n pull
workflow writes to. Writes go back to the same sheet, cell by cell, addressed
by `CaseNumber`.

## What it shows

Two tabs, splitting every case on the `Date Scheduled For` column:

- **Needs Scheduling** — rows where `Date Scheduled For` is blank.
- **Scheduled** — rows where it holds a date (this tab also shows a
  non-sortable *Scheduled* column with that date).

Each tab shows a live count.

Desktop renders a table (Case #, Insured, Address, City/State, Due, Portal,
Flags, Sync); below the `md` breakpoint the same rows render as stacked cards.
The first six columns (everything but Flags/Sync) are sortable and toggle
asc/desc; blank and unparseable values always sink to the bottom.

- **Due-date coloring** — red = overdue, amber = due within 3 days, plain
  otherwise (`MM/DD/YYYY` dates).
- **Flags** — a row with `Rush` or `Escalated` set to `Y` gets a matching
  pill.
- **Sync** — the row's current `Sync Status` as a colored pill
  (blue = Ready to Sync, green = Synced, red = Error).

## Making scheduling changes

Every row has an **Edit** button (table row / card footer) that opens an
editor for the six human-edit columns:

| Sheet column                | Control                                          |
| --------------------------- | ------------------------------------------------ |
| Schedule Appointment (Y/N) | Y / N / blank segmented control                 |
| Date                        | date picker (written as `MM/DD/YYYY`)            |
| Time                        | time picker (written as `H:MM AM/PM`)            |
| Attempted to Contact        | dropdown (`Insured` / `Agent` / `Other`)         |
| Comments                    | free text                                        |
| Sync Status                 | dropdown (blank / `Ready to Sync` / `Synced`)    |

**Save** PATCHes only the changed fields to `/api/inspections/<CaseNumber>`;
the server validates formats, locates the row by `CaseNumber`, and writes
**only those cells** (`spreadsheets.values.update`, RAW) — the non-editable
columns and every other row are never touched. The sheet read-cache is busted on a
successful write, so the table reflects the change immediately.

The **Sync now** button (top right) calls `POST /api/sync`, which fires the
n8n Phase 2 webhook over all rows currently marked `Ready to Sync`. The
workflow then writes `Synced` / `Error: …` back to the sheet. Setting
`Sync Status` to `Ready to Sync` from the editor is what queues a row.

> Note: Phase 2 branches on the `Portal` column and pushes scheduling and the
> Zoho event to **both** Preferred and Sutton — the same LC360 platform under
> different branding (see the repo-root [README](../README.md)). Watch the
> **first real Sutton** booking the first time through: its LC360 `UserId` is
> resolved at runtime, so it has less live verification behind it than Preferred.

## Prerequisites

- Node.js **>= 20**.
- A Google **service-account key JSON** that has **edit** access to the sheet.
  It must live **outside this repo** — never place it under `webapp/`.
- **Google Sheets API enabled** in GCP project `openclaw-crm-490018`, and the
  sheet shared with the service account with **Editor** access (writes need
  more than Viewer). See [Sheet access](#sheet-access) — this is a one-time
  setup.

## Setup and run

```bash
cd webapp
npm install
cp .env.example .env.local   # then fill in the values (see below)
npm run dev                  # http://localhost:3000
```

Other scripts:

```bash
npm run build      # next build
npm run start      # next start (production server; run after build)
npm run typecheck  # tsc --noEmit
npm test           # node --test over src/**/*.test.ts (no live Google calls)
```

`.env.local` is git-ignored. `GOOGLE_SA_KEY_PATH` points at a file outside the
repo, so nothing secret is ever committed from here.

### Production service (systemd user unit)

On the host the app runs as the systemd **user** service
`cma-scheduling-webapp`: production `next start` on port **3010**
(`http://192.168.1.74:3010/`). The unit
(`~/.config/systemd/user/cma-scheduling-webapp.service`) launches
[`scripts/run-webapp-3010.sh`](scripts/run-webapp-3010.sh), which resolves
`node` at runtime from nvm (the `default` alias → newest installed version as
fallback) and then execs `next start -p 3010` from the `webapp/` dir, so
`.env.local` is autoloaded. The unit has `Restart=always` / `RestartSec=3`.

```bash
systemctl --user status  cma-scheduling-webapp   # also: start / stop / restart
journalctl --user -u cma-scheduling-webapp       # logs
loginctl enable-linger                           # one-time: start at boot, no login session needed
```

> **Don't run `next dev` against the same `.next` while this service is up** —
> it caused an outage (400s on `/_next/static/*`). Use a separate port and
> directory for a dev instance.

**Down after a node upgrade?** The service picks node from the nvm `default`
alias — check it points at an installed version (e.g. `nvm alias default 26`,
or `nvm install --lts && nvm alias default lts/*`), then
`systemctl --user restart cma-scheduling-webapp`.

## Configuration

`webapp/.env.example` → copy to `webapp/.env.local`:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SHEET_ID` | yes | — | Spreadsheet id. The production Inspections sheet is `1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0`. |
| `SHEET_TAB` | no | `Inspections` | Tab name to read/write. |
| `GOOGLE_SA_KEY_PATH` | yes* | — | Absolute path to the service-account JSON, **outside the repo**. |
| `N8N_WEBHOOK_URL` | for Sync now | — | POST URL of the n8n "LC360 Scheduling Sync (Phase 2)" webhook. While unset, `/api/sync` returns `503` and the UI shows a configuration error. |
| `N8N_SYNC_SECRET` | if the webhook checks a secret | — | Sent to n8n as the `x-sync-secret` header. |

\* `GOOGLE_APPLICATION_CREDENTIALS` is accepted as a fallback for the key path
if `GOOGLE_SA_KEY_PATH` is unset.

Example:

```bash
SHEET_ID=1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0
SHEET_TAB=Inspections
GOOGLE_SA_KEY_PATH=/path/outside/repo/service-account.json
N8N_WEBHOOK_URL=http://192.168.1.74:5678/webhook/<path>   # provided by the n8n wiring task
N8N_SYNC_SECRET=...
```

## API surface

- `GET /api/inspections` — all rows, including the six editable fields.
- `PATCH /api/inspections/<CaseNumber>` — body is a subset of `{
  scheduleAppointmentYN, date, time, attemptedToContact, comments, syncStatus }`.
  `400` on invalid formats (Date `MM/DD/YYYY`, Time `H:MM AM/PM`, Y/N ∈
  {`Y`, `N`, blank}, Sync Status ∈ {blank, `Ready to Sync`, `Synced`,
  `Error: …`}), `404` when no row matches the CaseNumber, `500` on
  sheet-access failure, `200` + canonicalized values on success.
- `POST /api/sync` — fires the n8n webhook. `202` accepted, `502` n8n
  failed/unreachable, `503` unconfigured.

## Sheet access

The app authenticates with a Google service account
(`pintame-prime@openclaw-crm-490018.iam.gserviceaccount.com`, GCP project
`openclaw-crm-490018`) using the full `spreadsheets` scope. Two one-time steps
on the Google Cloud side:

1. **Enable the Google Sheets API** for project `openclaw-crm-490018`
   (Google Cloud Console → APIs & Services → Library → "Google Sheets API" →
   Enable).
2. **Share the sheet** with `pintame-prime@openclaw-crm-490018.iam.gserviceaccount.com`
   with **Editor** access, the same way you'd share with a person.

Until both are done, `/api/inspections` returns `502` and the UI shows
*"Could not load inspections"*; writes return `500`.

## Known limitations

- **The LC360/Zoho push lives in n8n, not here.** The webapp writes sheet
  cells and triggers the webhook; everything after that (contact-type
  resolution, AddScheduleItem, Zoho Calendar, `Synced`/`Error` write-back) is
  Phase 2's job. Phase 2 branches on the `Portal` column and pushes to both
  Preferred and Sutton, and can be started from this button or n8n's manual trigger.
- **Live data needs the Sheets API enabled and the sheet shared** with the
  service account (see [Sheet access](#sheet-access)).
- **Sheet reads are cached in memory for 60 seconds.** New or changed rows can
  take up to a minute to appear; a successful write through this app busts the
  cache immediately, and restarting the server clears it.
- **No login.** Anyone who can reach the app can edit the sheet's human-edit
  columns. Intended for the trusted LAN; add auth before exposing it further.
