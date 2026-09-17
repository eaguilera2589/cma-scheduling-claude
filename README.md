# CMA Scheduling (Loss Control 360 automation)

Automates the busywork around scheduling inspection appointments in
**PreferredReports / Loss Control 360** (`preferred.losscontrol360.com`), so the
only manual work left is the actual human judgment call: whether/when to
schedule, and what to note about the contact attempt.

## Data flow

```
n8n (scheduled trigger, e.g. daily)
  └─▶ scraper/src/pull.js  (Playwright, logs into LC360)
        └─▶ scrapes inspections still needing scheduling
              └─▶ n8n writes/updates rows in the Google Sheet
                                                            │
                                      Enrique edits rows: Schedule? / Date /
                                      Time / Attempted to Contact / Comments
                                                            │
n8n (trigger: edited row, e.g. "Sync Status" column flipped to "Ready")
  └─▶ scraper/src/push.js  (Playwright, logs into LC360)
        └─▶ writes the scheduling fields back into the report, saves
  └─▶ HTTP Request node → Zoho Calendar API
        └─▶ creates the appointment event
  └─▶ marks the row "Synced" in the Sheet
```

Google Sheet (created 2026-09-17): [CMA Scheduling — Loss Control 360 Inspections](https://docs.google.com/spreadsheets/d/1xZjQLFA8tnKFtHp6xw3Cf4hcFFmksXPnQc1mW-UtGx4/edit)
Columns: `Inspection ID, Insured/Property, Address, Status, Portal Link, Schedule Appointment? (Y/N), Date, Time, Attempted to Contact, Comments, Sync Status, Last Synced`.

## Repo layout

- `scraper/` — Node.js + Playwright. `src/login.js` (working, verified against
  the real login form), `src/explore.js` (recon script — run once with real
  credentials to capture the authenticated site's markup), `src/pull.js` /
  `src/push.js` (stubs — selectors pending recon output).
- `n8n-workflow/` — the n8n workflow definition, once built (export from the
  n8n UI at `http://192.168.1.74:5678`).
- `docs/` — decisions and setup notes.

## Status (2026-09-17)

| Piece | Status |
|---|---|
| Login automation | Done — confirmed against the real login form (ASP.NET MVC, posts to `/Login/Login`, fields `#UserName`/`#Password`, no 2FA/CAPTCHA). |
| Inspections list scrape | **Blocked** — needs real credentials to run `npm run explore` and see the authenticated page markup. |
| Report edit/save | **Blocked** — same; also needs to know which fields on the LC360 side correspond to "schedule appointment/date/time/attempted to contact/comments". |
| Google Sheet | Done — created with header row (link above). n8n still needs a Google Sheets credential connected to read/write it. |
| Zoho Calendar event creation | **Blocked** — needs a Zoho API Console OAuth client (Calendar scope). The Zoho *Mail* app password already in use elsewhere in this environment does not cover Calendar. |
| n8n workflow | Not built yet — waiting on the above so the nodes have real data to wire against. |

## What's needed to unblock

1. **LC360 login** — put real values in `scraper/.env` (copy from
   `.env.example`; this file is git-ignored). Don't paste credentials into
   chat/agent conversations — drop them straight into the file on
   `192.168.1.74` under `/opt/workspace/projects/cma-scheduling-claude/scraper/.env`.
2. **Google Sheets access for n8n** — in the n8n editor (`http://192.168.1.74:5678`),
   add a Google Sheets credential (Credentials → New → Google Sheets OAuth2
   API) and sign in with the Google account that should own the sheet.
3. **Zoho Calendar OAuth client** — register a "Self Client" or
   "Server-based Application" at `api-console.zoho.com` with the
   `ZohoCalendar.calendar.ALL` scope, then add it to n8n as a generic OAuth2
   API credential pointed at Zoho's auth/token endpoints. Happy to walk
   through this step by step once you're ready.

Once (1) is available, run `cd scraper && npm install && npm run explore` —
that logs in, saves the authenticated pages to `scraper/recon/` (git-ignored),
and from there the real selectors go into `pull.js`/`push.js`.
