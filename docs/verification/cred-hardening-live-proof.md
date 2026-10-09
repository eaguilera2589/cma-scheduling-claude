# LC360 Credential Hardening — Live Export Proof

**Purpose:** Aida re-review verifiability blocker — proves the **live** n8n workflows
(current versionId + activeVersion) actually contain the `$env` de-hardcode, via fresh
read-only exports of all three workflows. Produced 2026-10-09 ~04:20 UTC via
`GET /api/v1/workflows/{id}` (read-only; no PUT, no restart, key held in
`n8n-workflow/.env`, never printed).

**Secret policy:** This file contains **no secret values**. There are none left inline in
the LC360 credential paths of any of the 3 workflows (verified by scan, see §4).

## 1. Workflow state (from live n8n, n8n v2.34.5 at :5678)

| Workflow | ID | active | versionId | updatedAt | Live export file |
|---|---|---|---|---|---|
| LC360 Scheduling Sync (Phase 2) | `BNHnE6trqQk079eo` | `true` | `c0492480-c8d5-4ad5-885b-77f40d6a3b7d` | 2026-10-09T11:34:20.404Z | `projects/cma-scheduling-claude/n8n-workflow/existing-lc360-scheduling-sync-phase2.json` |
| LC360 → Google Sheet (Inspection Export) | `cG2WVIbQkPAfBvWW` | `true` | `46bf1ab1-06dd-424e-85e1-21ef854fdf93` | 2026-10-09T02:13:59.539Z | `projects/cma-scheduling-claude/n8n-workflow/existing-lc360-sheet-export.json` |
| CMA Field Contact Emails | `Xf222ciqOyu7NUeP` | `true` | `17b80c2a-a363-41e8-a29e-e16bd5bfd67d` | 2026-10-09T02:13:59.665Z | `projects/cma-automated-field-emails/n8n-workflow/existing-cma-field-contact-emails.json` |

For every workflow the API response's `activeVersion.versionId` equals its top-level
`versionId`, so the exported JSON is the **active** graph. All three export files are
git-ignored (`n8n-workflow/existing-*.json`) and `chmod 600`; `n8n-workflow/.env` is
`chmod 600` (was 777 — Aida's finding).

## 2. Credential-handling lines (verbatim from the exports)

Only the credential-handling lines are shown — nothing else from the nodes.

### ① Phase 2 — `BNHnE6trqQk079eo`

Node `Extract Token + Cookie` (Code):
```js
const u = $env.LC360_PREFERRED_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```
Node `Extract Token + Cookie (Sutton)` (Code):
```js
const u = $env.LC360_SUTTON_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```
Node `Check Webhook Secret` (IF) — condition `hdr-secret`:
```
leftValue:  ={{ String($json.headers['x-sync-secret'] || '') }}
rightValue: ={{ $env.SYNC_SECRET }}
```

### ② LC360 → Sheet — `cG2WVIbQkPAfBvWW`

Node `Extract Token + Cookie` (Code):
```js
const u = $env.LC360_PREFERRED_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```
Node `Extract Token + Cookie (Sutton)` (Code):
```js
const u = $env.LC360_SUTTON_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```

### ③ CMA Field Contact Emails — `Xf222ciqOyu7NUeP`

Node `Extract Token + Cookie (Preferred)` (Code):
```js
const u = $env.LC360_PREFERRED_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```
Node `Extract Token + Cookie (Sutton)` (Code):
```js
const u = $env.LC360_SUTTON_USERNAME;
const p = $env.LC360_PASSWORD;
if (!u || !p) throw new Error('LC360 env credential(s) unset — aborting instead of empty login.');
```

## 3. Grep summary (run against the export files on disk)

```
$ grep -c FALLBACK existing-lc360-scheduling-sync-phase2.json   → 0
$ grep -c FALLBACK existing-lc360-sheet-export.json             → 0
$ grep -c FALLBACK existing-cma-field-contact-emails.json       → 0

$ grep -c '\$env\.LC360' existing-lc360-scheduling-sync-phase2.json → 4
$ grep -c '\$env\.LC360' existing-lc360-sheet-export.json           → 4
$ grep -c '\$env\.LC360' existing-cma-field-contact-emails.json     → 4
```
(4 per file = 2 login nodes × 2 lines, duplicated once because the export mirrors the
graph in both `nodes` and `activeVersion.nodes`. No `FALLBACK_*` identifiers anywhere.)

Phase 2 webhook-secret check:
```
$ grep -o '"rightValue": "={{ \$env.SYNC_SECRET }}"' existing-lc360-scheduling-sync-phase2.json | uniq -c
2   "rightValue": "={{ $env.SYNC_SECRET }}"
```
(2 = current graph + `activeVersion` mirror. Workflows ②③ have no webhook node, hence 0.)

## 4. Deep secret scan performed

Each fetched JSON was walked recursively and scanned (values never printed) for:
`FALLBACK`, literal `const u|p|username|password = "…"` assignments not sourced from
`$env`, secret-shaped keys (`password`/`token`/`secret`/`authorization`) with
non-interpolated values, `Basic`/`Bearer` literals, and high-entropy token-shaped
strings. **LC360 credential paths: clean in all 3 workflows** — all remaining
high-entropy hits were benign (Google Sheets `documentId`s, the CSRF field-name string
`__RequestVerificationToken` in regexes/comments, code separators, recurrence-signature
keys).

**Out-of-scope finding (flag) — now RESOLVED for Phase 2 (see §6):** Phase 2's `Refresh
Zoho Token` HTTP node (→ `accounts.zoho.com/oauth/v2/token`) previously carried Zoho OAuth
`refresh_token`, `client_id` and `client_secret` **inline as query-parameter literals**
(pre-existing, unrelated to the LC360 batch). These were moved to `={{ $env.ZOHO_* }}` on
2026-10-09 (~11:35 UTC) — see §6. **Also now RESOLVED** (see §7): workflow **CMA Cust Appt
Reminder** (`yJNlrJqq8SeFZE9O`) — its `Refresh Zoho Token` node and the
`HTTP Request - Testing` authorization-code node — was de-hardcoded on 2026-10-09
(~11:55 UTC) reusing the same `ZOHO_*` env vars. **Zero inline Zoho literals remain in any
live n8n workflow.**

## 5. How this was produced / reproduce

1. `GET {N8N_BASE_URL}/api/v1/workflows/{id}` with `X-N8N-API-KEY` from
   `n8n-workflow/.env` (read-only; the instance requires the `X-N8N-API-KEY` header).
2. Prettified (`json.dump(indent=2)`) the API response verbatim to the export paths in §1.
3. Anyone with n8n read access can re-run step 1 and diff against the export files
   (modulo formatting).

## 6. Zoho OAuth de-hardcode (Phase 2) — added 2026-10-09 ~11:35 UTC

Follow-up to the §4 finding, using the **same `$env` route** as the LC360 batch (no key
rotation — see runbook; rotation would require re-doing the Zoho OAuth consent).

### 6.1 Workflow state

| Field | Value |
|---|---|
| Workflow | LC360 Scheduling Sync (Phase 2) — `BNHnE6trqQk079eo` |
| active | `true` |
| versionId == activeVersion.versionId | `c0492480-c8d5-4ad5-885b-77f40d6a3b7d` |
| nodes | 30 (unchanged — all preserved) |
| Live export | `projects/cma-scheduling-claude/n8n-workflow/existing-lc360-scheduling-sync-phase2.json` (re-exported this batch, `chmod 600`, git-ignored) |

### 6.2 Credential-handling lines (verbatim, nothing else from the node)

Node `Refresh Zoho Token` (HTTP Request → `https://accounts.zoho.com/oauth/v2/token`) query
parameters:
```
grant_type     = refresh_token                       (non-secret literal, unchanged)
refresh_token  = ={{ $env.ZOHO_REFRESH_TOKEN }}
client_id      = ={{ $env.ZOHO_CLIENT_ID }}
client_secret  = ={{ $env.ZOHO_CLIENT_SECRET }}
```
`Create Zoho Calendar Event` is **unchanged** — it still reads the runtime access token via
`={{ 'Zoho-oauthtoken ' + $('Refresh Zoho Token').item.json.access_token }}` (never a
literal). No Zoho secret is used anywhere else.

### 6.3 Environment / compose

- `docker/n8n/.env` (mode `600`) now defines `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIENT_ID`,
  `ZOHO_CLIENT_SECRET` (values copied programmatically from the old node literals; never
  printed). Lengths 70 / 35 / 42.
- `docker/n8n/docker-compose.yml` `environment:` gained the three `${VAR}` pass-throughs
  (`ZOHO_REFRESH_TOKEN=${ZOHO_REFRESH_TOKEN}` etc.) and **dropped** the unused
  `LC360_USERNAME=${LC360_USERNAME}` pass-through (no live workflow reads `$env.LC360_USERNAME`;
  workflows use `LC360_PREFERRED_USERNAME`/`LC360_SUTTON_USERNAME`). Verified via
  `docker compose config` (names only) and `docker exec n8n` length checks.
- No Zoho literal appears in compose; secrets live only in `docker/n8n/.env`. Nothing
  committed (`.env` and exports are git-ignored; `/tmp/opencode` backups shredded).

### 6.4 `$env`-in-HTTP-query-field probe (throwaway, leak-free)

Before editing the live node, a throwaway workflow sent an HTTP request whose **query-param
fields** were `={{ ($env.ZOHO_*||'MISSING').length }}` to a local echo webhook. The echo
received `{rt_len:'70', ci_len:'35', cs_len:'42'}` → expressions **resolve in HTTP
query-param fields** on this build (n8n v2.34.5, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`),
with only lengths on the wire. Throwaways neutralized; **flagged for UI deletion** (API
cannot delete/deactivate — 403): `ZZ-TMP-zoho-env-probe-delete-me` (`LfeKgfPcBn6OKvfr`),
`ZZ-TMP-zoho-echo-delete-me` (`OiQYggQqMk72omcp`).

### 6.5 Token-refresh verification (no calendar event)

A token-only controlled run (HTTP POST to `accounts.zoho.com/oauth/v2/token` with the
`$env.ZOHO_*` params, **no** `Create Zoho Calendar Event` node) returned execution
`success`, `has_access_token=true`, `token_type=Bearer`, `access_token_len=70`, `error=null`.
No Zoho Calendar write occurred. The Zoho refresh token is **reusable** (Phase 2 has reused
this same value across many scheduled event-creation runs with no write-back node), so the
check produced no side effect.

### 6.6 Post-change export scan (values never printed)

```
$env.ZOHO_REFRESH_TOKEN expression : 2   (current graph + activeVersion mirror)
$env.ZOHO_CLIENT_ID     expression : 2
$env.ZOHO_CLIENT_SECRET expression : 2
refresh_token-shaped literals (1000.<hex>.<hex>) : 0
client_id-shaped literals    (1000.<UPPER>)      : 0
40-hex client_secret literals                    : 0
LC360 $env reads ($env.LC360*)                   : 8   (regression: LC360 edits intact)
$env.SYNC_SECRET                                 : 2   (webhook check intact)
FALLBACK                                         : 0
```

## 7. Zoho OAuth de-hardcode (batch 2 — CMA Cust Appt Reminder) — added 2026-10-09 ~11:55 UTC

Closes the remaining §4 flag. Same `$env` route and the **same** `ZOHO_*` vars as §6 — no key
rotation, no new secrets anywhere.

### 7.1 Workflow state

| Field | Value |
|---|---|
| Workflow | CMA Cust Appt Reminder — `yJNlrJqq8SeFZE9O` |
| active | `true` |
| versionId == activeVersion.versionId | `26e2ca2d-0c98-454e-8a1f-798c35831d82` |
| nodes | 12 (unchanged — all preserved; connections byte-identical to backup) |
| Live export | `projects/cma-scheduling-claude/n8n-workflow/existing-cma-cust-appt-reminder.json` (re-exported this batch, git-ignored; mode corrected 777 → 600, matching the `.env` finding in §1) |

### 7.2 Credential-handling lines (verbatim, nothing else from the nodes)

Node `Refresh Zoho Token` (HTTP Request → `https://accounts.zoho.com/oauth/v2/token`) query
parameters — the live schedule path:
```
grant_type     = refresh_token                       (non-secret literal, unchanged)
refresh_token  = ={{ $env.ZOHO_REFRESH_TOKEN }}
client_id      = ={{ $env.ZOHO_CLIENT_ID }}
client_secret  = ={{ $env.ZOHO_CLIENT_SECRET }}
```
Node `HTTP Request - Testing` (auth-code flow; **unconnected and already `disabled: true`** —
dead scaffolding): kept (per "prefer converting to `$env`") with `client_id`/`client_secret`
converted to the same `$env.ZOHO_*`, `grant_type`/`redirect_uri` left as-is, and the spent
one-time `code` literal replaced by a fail-closed expression
(`={{ $env.ZOHO_AUTH_CODE || 'ABORT: one-time OAuth auth-code required …' }}`) — no matching
env var exists by design, so the node aborts loudly if anyone ever re-enables it.

### 7.3 Live-vs-saved graph drift — handled deliberately

Pre-batch the workflow's `versionId` (saved graph) ≠ `activeVersion.versionId`: the saved
graph had additionally **enabled + wired** the `Get Calendars- Testing` scaffolding node
(read-only, token read at runtime — no secrets), which the ACTIVE graph had disabled. To
preserve current live behaviour exactly, the PUT graph sets that node `disabled: true`
(kept, connections untouched). Run 512 confirmed it executes as a zero-time pass-through
(no HTTP call). Flag: the 2026-09-17 saved-but-never-activated edits are otherwise preserved.

### 7.4 Apply + restart

PUT (backup at `/tmp/opencode/cust-reminder/`, mode 600, shredded after verification) then
`docker compose up -d` + `docker restart n8n`. Activation log: `Activated workflow "CMA Cust
Appt Reminder"` + all other active workflows re-registered. On this build a PUT to a running
workflow promoted the new version to active directly (`activeVersionId` == new `versionId`
after PUT).

### 7.5 Token-only verification (no SMS/email/calendar side effect from verification)

n8n's public API cannot run a single node, and "disable downstream then run" is unsafe in
n8n (disabled nodes pass items through), so per the brief's fallback the check was a **direct
read-only POST to `accounts.zoho.com/oauth/v2/token` from inside the container using the env
values** (`docker exec n8n node …`; lengths/status only): `http_status=200`,
`token_type=Bearer`, `access_token_len=70`, `error=null`; a read-only Bearer GET on
`/api/v1/calendars` → 200. No workflow execution was triggered by verification.

### 7.6 Scheduled runs post-restart (register + fire confirmation)

- Restart ~11:58 UTC; activation log re-registered all crons/schedules.
- **Cust-Appt-Reminder schedule**: fired on its regular daily 12:00:52 UTC trigger —
  execution 512, `success`, first production run on the de-hardcoded graph;
  `Refresh Zoho Token` returned Bearer (`access_token_len=70`). **Note for the record:**
  this is the workflow's designed daily behaviour and fired exactly once (no duplicate run);
  its `Look Up Sent Log` → `IF Not Already Sent` gate sent today's 3 legitimate appointment
  reminders (yesterday's scheduled run sent 2). Nothing was triggered by this batch's
  verification steps; the SMS sends were the pre-existing schedule doing its job.
- **LC360 2-hour pull cron** (`cG2WVIbQkPAfBvWW`): still firing — 12:00:28 UTC run after
  the restart (exec 511, `success`).

### 7.7 Whole-workflow-wide Zoho scan (both Zoho-bearing workflows, values never printed)

```
Cust Appt Reminder (existing-cma-cust-appt-reminder.json):
  refresh/auth-code-shaped (1000.x.y) : 0    client_id-shaped (1000.UPPER) : 0
  40-hex secret-shaped                : 0    non-$env secret-named query values : 0
  $env.ZOHO_REFRESH_TOKEN : 2   $env.ZOHO_CLIENT_ID : 4   $env.ZOHO_CLIENT_SECRET : 4
Phase 2 (existing-lc360-scheduling-sync-phase2.json):
  all literal-shape counters          : 0
  $env.ZOHO_REFRESH_TOKEN : 2   $env.ZOHO_CLIENT_ID : 2   $env.ZOHO_CLIENT_SECRET : 2
```
(Counts double where a node appears in both the current graph and the `activeVersion` mirror.)
**Zero inline Zoho literals remain in any live n8n workflow.**

### 7.8 Rotation reminder (applies to BOTH workflows now)

Both Zoho-bearing workflows read the **same** three `docker/n8n/.env` vars. Rotating the
`refresh_token` still **requires re-doing the Zoho OAuth browser consent** (the runbook's
HUMAN-RUN Zoho section — it cannot be minted from CLI/env), **then** editing the three
values in `docker/n8n/.env` **once** and `docker compose up -d` — no workflow edits for
either workflow.
