# Production DB Cutover Runbook (sheet-backed → Postgres-backed) — HUMAN-RUN

> **Never print secret values** at any step (commands, logs, chat, tickets). Reference
> secrets by name only. `DATABASE_URL`, `N8N_SYNC_SECRET`, the n8n API key, and the LC360
> password live in git-ignored files (`webapp/.env.local`, `infra/.env.staging`,
> `n8n-workflow/.env`) — never `git add` or `echo` them. When a command needs a secret,
> reference it by env-var name so the shell expands it without it appearing on screen.

## What this runbook does

Flips the production webapp on **:3010** from **sheet-backed** (`DATA_SOURCE` unset →
reads/writes the Google Sheet) to **Postgres-backed** (`DATA_SOURCE=db`).

The mechanism is the **promotion of the existing staging database to production** — no new
database is created:

- The staging Postgres container `cma-scheduling-staging-pg` (Postgres 16-alpine, bound to
  `127.0.0.1:5433` only, named volume `cma_staging_pgdata`) becomes the **production**
  `cases` store. Its name is still `*-staging-*` — renaming is a post-cutover cleanup step
  (see §Cleanup).
- The running `cma-lc360-ingest-staging.timer` (every 2 h → `run-ingest-lc360.sh` →
  `lc360:ingest`) keeps running and now feeds **production**: it refreshes the LC360-owned
  columns and the `caseid` GUID on every run. **Do not stop this timer.**
- The webapp PATCHes Postgres directly and, on **Sync now**, fires n8n's
  **"LC360 Sync (DB)"** workflow (`EYZmcYCOTejZadNY`, webhook `…/lc360-sync-db`) which
  reads `Ready to Sync` rows from `cases` and writes `Synced`/`last_synced` back to the DB.
- The **sheet pull** workflow (`cG2WVIbQkPAfBvWW`, LC360→Google Sheet, every 2 h) stays
  **active** for **1–2 weeks** as a warm rollback copy. Nothing is deactivated in the LC360
  pull path.

Key components / ids:

| Role | Identifier |
| --- | --- |
| Prod webapp (sheet→DB target) | systemd user unit `cma-scheduling-webapp.service`, port **3010** |
| Staging webapp (retired this run) | systemd user unit `cma-scheduling-webapp-staging.service`, port 3011 |
| LC360 ingest (now feeds prod) | `cma-lc360-ingest-staging.service` + `.timer` (every 2 h) |
| Promoted database | container `cma-scheduling-staging-pg`, `127.0.0.1:5433`, volume `cma_staging_pgdata` |
| DB write-back workflow | `EYZmcYCOTejZadNY` "LC360 Sync (DB)", webhook `…/lc360-sync-db` |
| Sheet pull (kept warm) | `cG2WVIbQkPAfBvWW` "LC360 → Google Sheet", webhook/2 h schedule |
| n8n host | `http://192.168.1.74:5678` (API key in `n8n-workflow/.env`, read/write/activate/run-scoped) |
| Production sheet | `1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0`, tab `Inspections` |

**Prerequisite code state (this is what the prep commits provide):** the DB write-back
`Read Cases (DB)` SQL guards against a missing GUID (`… AND caseid IS NOT NULL AND caseid <> ''`),
and DB-mode errors read "the database" rather than "the Google Sheet". See §Preflight P0.

---

## 0. Preflight (all read-only — no writes)

Set up a shell that can reach the DB **without printing the URL**. From the repo root:

```bash
cd /opt/workspace/projects/cma-scheduling-claude/webapp
# Load DATABASE_URL etc. for the psql/curl commands below WITHOUT echoing values.
set +x; set -a; . ../infra/.env.staging; set +a
# Convenience alias for read-only SQL (never echoes the connection string):
sql() { psql "$DATABASE_URL" -X -q -Atc "$1"; }
```

### P0. Workflow-export guard is in place + live n8n state

The exported `LC360 Sync (DB)` JSON guard must be reflected in the **live** n8n workflow.
If the live `EYZmcYCOTejZadNY` predates the guard, re-import
`n8n-workflow/existing-lc360-sync-db.json` (or edit the `Read Cases (DB)` node in the UI)
so its query ends:

```
… FROM cases WHERE lower(sync_status) = 'ready to sync' AND caseid IS NOT NULL AND caseid <> '';
```

Confirm active flags via the n8n API (key referenced by name, never printed):

```bash
export $(grep -E '^N8N_API_KEY=' ../n8n-workflow/.env)   # loads, does not echo the value
api() { curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" "http://192.168.1.74:5678/api/v1$1"; }
for id in EYZmcYCOTejZadNY cG2WVIbQkPAfBvWW BNHnE6trqQk079eo; do
  printf '%s  ' "$id"; api "/workflows/$id" | jq -r '[.name, .active] | @tsv'
done
```

Expected: sheet pull `cG2WVIbQkPAfBvWW` **active=true**; DB workflow `EYZmcYCOTejZadNY`
and Phase 2 `BNHnE6trqQk079eo` may be active=false — that's fine (activated/rolled through
below).

### P1. Promoted DB is reachable and schema is current

```bash
sql 'SELECT current_database(), count(*) AS cases FROM cases;'          # rows > 0
sql "SELECT count(*) FROM information_schema.columns
     WHERE table_name='cases'
       AND column_name IN ('caseid','last_synced','contact_at_insured');"   # expect 3
```

If the column count is < 3, run the ingest once (it applies all three migrations
`001_init` / `002_sync_columns` / `003_contact_at_insured`): `npm run lc360:ingest`.

### P2. DB ↔ sheet parity, and every ready row has a GUID

`migrate:sheet-to-db` is idempotent and, at the end, prints
`SELECT count(*) FROM cases` vs the sheet's unique case count. Run it now (still pre-cutover)
and confirm it logs `OK: DB row count matches the sheet` (a `WARNING: count mismatch` means
resolve that **before** cutting over):

```bash
npm run migrate:sheet-to-db
```

Then confirm the write-back can address every "ready" row (must be **0** ready rows missing
a GUID, else the guard silently drops them):

```bash
sql "SELECT count(*) FROM cases
     WHERE lower(sync_status)='ready to sync' AND (caseid IS NULL OR caseid='');"   # expect 0
sql "SELECT count(*) FILTER (WHERE caseid IS NOT NULL AND caseid<>'') AS with_guid FROM cases;"  # sanity
```

### P3. Staging instance is healthy in DB mode (proves the prod target path)

```bash
curl -s http://localhost:3011/api/inspections | jq 'length'   # staging :3011, DATA_SOURCE=db
```

A non-error array means the exact serving path prod is about to adopt works against the
promoted DB. (Staging `:3011` reads `DATA_SOURCE=db` + `DATABASE_URL` from the systemd
`EnvironmentFile` `infra/.env.staging`, not `webapp/.env.local`.)

**GO/NO-GO:** proceed only if P0–P3 are all clean.

---

## 1. Cutover sequence (do these in order)

### 1.1 Edit freeze
Announce/confirm **no edits** to the sheet or the webapp for the window. This freezes the
sheet's human-edit columns at their authoritative values; the last seed below copies them.

### 1.2 Final data sync (LC360-owned first, then human-edit columns last)

```bash
# (a) Refresh LC360-owned columns + the caseid GUID + ensure schema:
npm run lc360:ingest
# (b) Copy the FROZEN sheet's six human-edit columns (+ contact_at_insured) into the DB LAST,
#     so the DB's editable columns match the final authoritative sheet state:
npm run migrate:sheet-to-db
```

Both are idempotent and never clobber each other: `lc360:ingest` never writes the six
human-edit columns or `caseid`… (it owns `caseid`, not the edit cols); `migrate:sheet-to-db`
never writes `caseid`/`last_synced`. Order (a)→(b) guarantees GUIDs present and edit columns
reflect the frozen sheet. The final `migrate` must print `OK: DB row count matches the sheet`.

### 1.3 Point prod (:3010) at the DB
Edit **`webapp/.env.local`** (git-ignored; autoloaded by Next when the prod unit runs
`next start`). **Never print the values** — edit in place:

- add `DATA_SOURCE=db`
- add `DATABASE_URL=` set to the **same** value held in `infra/.env.staging` (copy the line;
  do not paste it into logs/chat). Reference for the operator:
  ```bash
  # copy just the key from staging env into .env.local WITHOUT echoing the value:
  grep '^DATABASE_URL=' ../infra/.env.staging >> .env.local   # then ensure no duplicate key
  ```
- **optional** `N8N_WEBHOOK_URL_DB=http://192.168.1.74:5678/webhook/lc360-sync-db` — if
  unset, the app derives it from `N8N_WEBHOOK_URL` by swapping the trailing `lc360-sync`
  segment for `lc360-sync-db` (see `resolveSyncWebhookUrl`). Set it explicitly if
  `N8N_WEBHOOK_URL` does not end in `/lc360-sync`.
- keep `N8N_SYNC_SECRET` (shared by both workflows; unchanged).

> If `webapp/.env.local` already has a `DATA_SOURCE`/`DATABASE_URL` line, **edit** it — don't
> append a duplicate. Next uses the last assignment, but a duplicate is confusing to audit.

### 1.4 Restart prod
```bash
systemctl --user restart cma-scheduling-webapp
journalctl --user -u cma-scheduling-webapp -n 30 --no-pager   # no DATABASE_URL / db errors at boot
```

### 1.5 Activate the DB write-back workflow; change nothing in the pull path
```bash
# Activate LC360 Sync (DB):
curl -s -X POST -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "http://192.168.1.74:5678/api/v1/workflows/EYZmcYCOTejZadNY/activate" | jq '.active'   # true
```
- **Do NOT deactivate** the sheet pull `cG2WVIbQkPAfBvWW` — it stays active (warm copy).
- **Do NOT** deactivate the LC360 ingest timer — it now feeds production.
- Leave Phase 2 `BNHnE6trqQk079eo` as-is (it is the sheet write-back path, kept for rollback).

### 1.6 Retire the staging webapp instance
```bash
systemctl --user stop cma-scheduling-webapp-staging.service     # stop :3011
# (optional, to keep it from auto-starting at boot) systemctl --user disable cma-scheduling-webapp-staging.service
```
Leave the Postgres container and the ingest timer running — they are now production.

---

## 2. E2E verification (against prod :3010, DB mode)

Pick a real case number you are willing to schedule; substitute `<CASE>`.

1. **PATCH a test case → DB**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
     http://localhost:3010/api/inspections/<CASE> \
     -H 'content-type: application/json' -d '{"syncStatus":"Ready to Sync"}'   # 200
   sql "SELECT sync_status FROM cases WHERE case_number='<CASE>';"             # Ready to Sync
   ```
2. **Confirm DB-mode serving + source-neutral error copy**
   ```bash
   curl -s http://localhost:3010/api/inspections | jq 'length'   # array, no "Google Sheet" error
   curl -s http://localhost:3010/api/inspections | jq -e '.[0].phone // "" != ""' >/dev/null \
     && echo 'phone populated (DB-only field)' || echo 'phone blank — ingest may not have run'
   ```
3. **Fire sync → n8n DB workflow**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3010/api/sync   # 202
   ```
   Watch the n8n execution for `EYZmcYCOTejZadNY` (UI → Executions): the case scheduled in
   LC360, then:
   ```bash
   sql "SELECT sync_status, last_synced FROM cases WHERE case_number='<CASE>';"   # Synced + timestamp
   ```
4. **Route Planner phones live** — open `http://192.168.1.74:3010/` → **Route Planner** tab;
   insured phone (`tel:` links) render from the DB `phone` column (blank in sheet mode).

All four green ⇒ cutover complete.

---

## 3. Rollback (revert to sheet-backed)

Rollback is cheap for **≤ 2 weeks** because the sheet pull workflow kept the sheet as a warm
copy — **frozen at the cutover values for the human-edit columns** (the pull never writes the
six human-edit columns).

1. Remove `DATA_SOURCE` (and optionally `DATABASE_URL` / `N8N_WEBHOOK_URL_DB`) from
   `webapp/.env.local` — comment the line, do not paste values elsewhere.
2. `systemctl --user restart cma-scheduling-webapp`  → prod is back to sheet mode; the
   existing sheet-mode webhook path (`/webhook/lc360-sync` → Phase 2 `BNHnE6trqQk079eo`,
   which was never deactivated) resumes.
3. **Consequence to know:** any human edits made in the **DB** after cutover are **not** in
   the sheet (the sheet's edit columns are frozen at cutover). If those edits matter, export
   them from the promoted DB and reconcile into the sheet before/after rollback:
   ```bash
   sql "SELECT case_number, sync_status, \"date\", \"time\", attempted_to_contact,
              comments, schedule_appointment_yn
        FROM cases WHERE sync_status <> '' ORDER BY case_number;"
   ```
4. (Optional) bring staging back to keep validating:
   `systemctl --user start cma-scheduling-webapp-staging.service`.
5. If rolling back within the warm window, do **not** rely on the sheet's edit columns being
   current beyond the cutover instant — treat them as the cutover snapshot.

---

## 4. Cleanup (only after ≥ 2 weeks of stable DB mode)

Do these **after** confirming DB mode is stable and the warm-rollback window has closed:

- **Rename the promoted units/container** to drop the `staging` name (schedule a maintenance
  window; they are currently production despite their names):
  - compose service + container `cma-scheduling-staging-pg` → a production name, volume
    `cma_staging_pgdata` → production name (do this with a `docker compose down` that **keeps**
    the named volume, then `up -d` under the new names — a data-losing `down -v` is forbidden).
  - `cma-lc360-ingest-staging.{service,timer}` → production names.
  - `infra/.env.staging` → a production env file.
- **Delete the warm sheet pull workflow** `cG2WVIbQkPAfBvWW` (deactivate, then remove) **only
  after** the 2-week window — until then it is the rollback copy.
- **Delete the retired staging webapp unit** `cma-scheduling-webapp-staging.service` (and
  `run-webapp-3011.sh`) once no longer needed.
- Optionally add a `statement_timeout` / `connectionTimeoutMillis` to `lib/db/pool.ts` (now
  that a DB stall would hang prod requests) — a separate, low-priority hardening task.

## Appendix — commands referenced by this runbook
- Sheet→DB seed: `npm run migrate:sheet-to-db` (**SEED-ONLY** — see the warning header in
  `webapp/scripts/migrate-sheet-to-db.ts`; re-running after cutover needs an edit freeze).
- LC360 ingest: `npm run lc360:ingest` (owns `caseid` + LC360 columns; runs on the timer).
- Credential rotation (unrelated, but same DB/secret hygiene rules):
  [`lc360-credential-rotation.md`](./lc360-credential-rotation.md).
