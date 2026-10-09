# LC360 Credential Rotation Runbook (Batch 2 — HUMAN-RUN)

> **Never print secret values** at any step (commands, logs, chat, tickets). Reference by
> name, length, or last-4 only. All files named below are git-ignored; never `git add` them.

## Why this runbook exists

The shared LC360 account password is used by **four consumer groups**. Rotating it means
updating every consumer inside one window, **while all automated triggers are paused** —
an automation that sends an empty or stale login could lock the accounts.

Consumers of `LC360_PASSWORD` (and per-tenant usernames):

| # | Consumer | Where the credential lives today |
|---|----------|----------------------------------|
| ① | n8n workflow **Phase 2** `BNHnE6trqQk079eo` | Code nodes `Extract Token + Cookie` + `Extract Token + Cookie (Sutton)` — `$env.LC360_*` reads (no literals) |
| ② | n8n workflow **LC360→Sheet pull** `cG2WVIbQkPAfBvWW` | same two Code-node shapes (`$env.LC360_*` reads) |
| ③ | n8n workflow **CMA Field Contact Emails** `Xf222ciqOyu7NUeP` | Code nodes `(Preferred)` + `(Sutton)` (`$env.LC360_*` reads) |
| ④ | **Direct ingest** (`cma-lc360-ingest-staging.timer` → `run-ingest-lc360.sh`) | `infra/.env.staging` (`LC360_PREFERRED_USERNAME`, `LC360_SUTTON_USERNAME`, `LC360_PASSWORD`) |
| ⑤ | **Human portal sign-ins** (Preferred + Sutton accounts) | browser password managers — update after rotation |

n8n containers (①②③) get their environment from **`docker/n8n/.env`** via the
`docker/n8n/docker-compose.yml` `${VAR}` pass-throughs (`LC360_USERNAME`, `LC360_PASSWORD`,
`LC360_PREFERRED_USERNAME`, `LC360_SUTTON_USERNAME`, `SYNC_SECRET`), so **one edit there
feeds all 3 workflows**. The ingest (④) reads a *separate* file (`infra/.env.staging`) —
it does **not** update automatically and must be changed in the same window.

### Current state (verified 2026-10-09)

- The `$env` de-hardcode is **applied on all 3 live workflows**: every login Code node
  reads `$env.LC360_PREFERRED_USERNAME` / `$env.LC360_SUTTON_USERNAME` /
  `$env.LC360_PASSWORD` and fails closed with
  `if (!u || !p) throw new Error('LC360 env credential(s) unset — …')`; Phase 2's
  `Check Webhook Secret` compares against `={{ $env.SYNC_SECRET }}`. **Zero `FALLBACK_*`
  or literal LC360 creds remain.** Proof: `docs/verification/cred-hardening-live-proof.md`.
  (Variables remain license-disabled, but that is moot — `$env` works in Code nodes.)
- The n8n public API key is scoped to workflow read/write/activate/run; `deactivate`,
  `DELETE` and credential writes return 403. Use the **n8n UI** for pause/deactivate.
- **A password rotation now needs NO workflow edits** — see Step 4.

## Prerequisites

- ~30 minutes where nobody triggers Sync or manual workflow runs.
- Access: LC360 portal admin (to set the new password), n8n UI, this host (systemd user units).
- Confirm no LC360 account is currently locked (a rotation against a locked account masks
  the lockout as "credentials broken").
- A strong new password generated offline (vault), **never pasted into chat/logs**.

## Procedure (in this exact order)

1. **Back up all 3 workflows** (GET via API or `Download` in UI; store under `/tmp/opencode/cred-fix/`,
   zero them again at the end):
   `BNHnE6trqQk079eo`, `cG2WVIbQkPAfBvWW`, `Xf222ciqOyu7NUeP`.
2. **Pause every automated trigger** so no run fires against the old password mid-window:
   - `systemctl --user stop cma-lc360-ingest-staging.timer`  (stop, not disable)
   - In the n8n UI: **deactivate** workflow ② (its only trigger is the 2-hour schedule;
     it fires at `:00` of every even hour UTC — plan the window to avoid `:00`).
   - In the n8n UI (or API PUT with the node `disabled: true`, then PUT back later):
     disable ③'s `Weekly Schedule`.
   - Do NOT trigger the Phase 2 webhook / webapp "Sync now" during the window.
3. **Change the password in the LC360 portal UI** for BOTH accounts (Preferred + Sutton)
   if they are separate accounts; confirm the change with ONE manual sign-in per account.
   One successful interactive login only — do not hammer it.
4. **Propagate the new password:**
   - **Edit `LC360_PASSWORD=` in `docker/n8n/.env`, then `docker compose up -d` in
     `docker/n8n/`** (recreates the n8n container; ~seconds of webhook downtime). No
     workflow edits — the container env feeds all 3 workflows (①②③) at once via the
     `$env` reads. Same procedure for a username rotation (`LC360_PREFERRED_USERNAME` /
     `LC360_SUTTON_USERNAME` / `LC360_USERNAME`). Confirm with
     `docker compose config` (names only — never `echo` values) that the vars are set.
   - **Update `infra/.env.staging` → `LC360_PASSWORD=` in the same window** (the ingest ④
     reads this separate file — it does NOT follow the n8n container env; leaving it stale
     means failed logins from the timer). Same file also holds the two `*_USERNAME` vars —
     only touch what actually changed.
   - Update the two human browser password managers.
5. **Verify one controlled login per consumer** (single run each; on a 401/lock symptom,
   **stop and do not retry** — re-check the value instead):
   - Activated workflow ② → watch one scheduled/manual run: login nodes succeed.
   - POST the Phase 2 webhook once → execution shows `Login` + `Login (Sutton)` ok.
   - Run the ingest once manually:
     `systemctl --user start cma-lc360-ingest-staging.service` → check
     `journalctl --user -u cma-lc360-ingest-staging.service -n 20`.
   - Workflow ③: one manual run (or its next weekly run) shows both login nodes ok.
6. **Re-enable** everything: reactivate ② in the UI, un-disable ③'s schedule,
   `systemctl --user start cma-lc360-ingest-staging.timer`.
7. **Scrub**: zero the /tmp backups (`: > <file>`), confirm no plaintext password remains
   in `/tmp/opencode` or the `n8n-workflow/*.json` exports.

## Lockout-recovery note

- LC360 locks an account after repeated failed logins. **Every** automation above can produce
  failed logins if it fires while a consumer still holds the old password — hence the paused
  window; and code paths must **throw rather than send empty creds**.
- If a lockout happens: STOP all consumers (deactivate ①②③, stop the timer), wait out the
  portal's lockout window or have a portal admin unlock, then change the password **once**
  and resume at Step 4. Never "test" by repeated attempts.

## What is already done

- **`$env` de-hardcode applied and verified on all 3 live workflows (2026-10-09):** creds
  are read via `$env.LC360_*` from the n8n container env (`docker/n8n/.env` via compose
  pass-throughs), with fail-closed throw guards; Phase 2 webhook check compares
  `={{ $env.SYNC_SECRET }}`. Live-export proof:
  `docs/verification/cred-hardening-live-proof.md`. Password rotation now needs no
  workflow edits (Step 4).
- On-disk `n8n-workflow/existing-*.json` exports are **fresh copies of the live JSON**
  (no placeholders, no literals), git-ignored and `chmod 600`.
- Webhook secret rotation + Header-Auth credential (Batch 1): still **blocked** (API key
  cannot create credentials — 403). When an admin creates an `httpHeaderAuth` credential
  (header `x-sync-secret`) in the n8n UI, set Phase 2's Webhook node → Authentication =
  Header Auth, delete the `Check Webhook Secret` + `Webhook Response Unauthorized` nodes,
  wire `Webhook Trigger → Webhook Response OK`, set `N8N_SYNC_SECRET` in
  `webapp/.env.local` to the same value, and `systemctl --user restart cma-scheduling-webapp cma-scheduling-webapp-staging`.
  Until then, `SYNC_SECRET` rotates the same way as Step 4: edit it in `docker/n8n/.env` +
  `docker compose up -d`, and update the webapp sender in the same window.
- **Zoho — de-hardcoded on BOTH Zoho-bearing workflows (2026-10-09):** no inline Zoho OAuth
  literals remain in any live n8n workflow; both read `={{ $env.ZOHO_REFRESH_TOKEN }}` /
  `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` from `docker/n8n/.env` via compose pass-throughs.
  - **Phase 2** (`BNHnE6trqQk079eo`) — batch 1 (~11:35 UTC): `Refresh Zoho Token` converted;
    compose pass-throughs added (unused `LC360_USERNAME` pass-through removed). Proof:
    `docs/verification/cred-hardening-live-proof.md` §6.
  - **CMA Cust Appt Reminder** (`yJNlrJqq8SeFZE9O`) — batch 2 (~11:55 UTC): its
    `Refresh Zoho Token` node converted to the SAME `ZOHO_*` vars, and the isolated
    (unconnected, already-disabled) `HTTP Request - Testing` auth-code scaffolding was
    de-hardcoded too (`client_id`/`client_secret` → `$env.ZOHO_*`; the spent one-time
    `code` → fail-closed expression, node stays disabled). Twilio + schedule + all 12 nodes
    preserved; verified token-only (Bearer, no SMS) and by the first post-change scheduled
    run. Proof: `docs/verification/cred-hardening-live-proof.md` §7.

## Zoho OAuth rotation runbook (HUMAN-RUN — different from LC360 password rotation)

> Same rule: **never print Zoho secret values** — reference by name/length/last-4 only.

Zoho OAuth is **not** like the LC360 password: there is nothing to "edit and go". The
`ZOHO_REFRESH_TOKEN` is an **OAuth artifact minted by a browser consent grant**, not a
password. Rotation therefore has a mandatory **human consent step**:

1. **Regenerate the credential in the Zoho Console** (https://api-console.zoho.com) for the
   Self-Client / client used here — this yields a **new `client_id` + `client_secret`** and
   (for the code flow) a **new `refresh_token`**. You (a human, logged into Zoho) must
   complete the **OAuth consent / "Generate Code"** interaction in a browser to mint a fresh
   `refresh_token`; **it cannot be produced from the CLI/env alone.**
2. **Update the three values in ONE place:** edit `ZOHO_REFRESH_TOKEN=`, `ZOHO_CLIENT_ID=`,
   `ZOHO_CLIENT_SECRET=` in `docker/n8n/.env` (mode 600), then `docker compose up -d` in
   `docker/n8n/` to reload them into the container. **No workflow edits** — BOTH Zoho-bearing
   workflows (Phase 2 `BNHnE6trqQk079eo` and CMA Cust Appt Reminder `yJNlrJqq8SeFZE9O`) now
   read the same `ZOHO_*` env vars via `$env` (proof §6/§7), so one `.env` edit + one
   `up -d` feeds both. Remember the consent prerequisite: a new `refresh_token` **cannot be
   minted from the CLI/env** — the browser OAuth consent in step 1 must be redone first.
3. **Verify** with a token-only run (same shape as proof §6.5): a POST to
   `accounts.zoho.com/oauth/v2/token` returns `token_type=Bearer` and a non-empty
   `access_token` with `error=null`. If you get `invalid_grant`, the consent/refresh_token
   did not take — re-do step 1, do not repeatedly retry.
4. **Note on reuse vs rotation:** the current `refresh_token` is **reusable** (Phase 2 has
   reused it across many runs with no write-back). Zoho refresh tokens still expire
   (~1 year) — plan a consent refresh before that date. If Zoho ever rotates the
   `refresh_token` on use (single-use), the stored value MUST be updated to the newly
   returned one after each refresh, or the next run fails with `invalid_grant`.

