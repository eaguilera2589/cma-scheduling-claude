#!/usr/bin/env bash
# run-ingest-lc360.sh — runtime node resolver + launcher for the LC360 -> staging
# Postgres ingest. Used by the systemd user unit cma-lc360-ingest-staging.service.
#
# Same upgrade-proof node resolution strategy as run-webapp-3010/3011.sh: nvm's
# `default` alias, then the alias file, then newest installed version — so an nvm
# node upgrade needs NO unit-file edit. It then runs the TS ingest entry directly
# via node's native type stripping + the project's ESM resolver hook, loading
# DATABASE_URL and the LC360_* credentials from infra/.env.staging (git-ignored).
#
# This script never hardcodes or prints credentials; the secrets come from the
# env file and are consumed by the script.
#
# Testing hook: RUN_INGEST_RESOLVE_ONLY=1 prints the resolved node path and exits
# 0 without running the ingest (proves upgrade-proofing; systemd never sets it).
set -euo pipefail

APP_DIR="/opt/workspace/projects/cma-scheduling-claude/webapp"
ENV_FILE="/opt/workspace/projects/cma-scheduling-claude/infra/.env.staging"
ENTRY="$APP_DIR/scripts/ingest-lc360-to-db.ts"
REGISTER="$APP_DIR/test/register.mjs"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
VERSIONS_DIR="$NVM_DIR/versions/node"

die() { printf 'run-ingest-lc360: FATAL: %s\n' "$*" >&2; exit 1; }

usable_node() { [[ -n "${1:-}" && -f "$1" && -x "$1" ]]; }

newest_matching() {
  local -a dirs=()
  local p
  shopt -s nullglob
  for p in "$@"; do dirs+=( "$VERSIONS_DIR"/$p ); done
  shopt -u nullglob
  ((${#dirs[@]} > 0)) || return 0
  local newest
  newest="$(printf '%s\n' "${dirs[@]}" | sort -V | tail -n1)"
  printf '%s\n' "$newest/bin/node"
}

# 1. nvm `default`.
resolve_via_nvm() {
  [[ -s "$NVM_DIR/nvm.sh" ]] || return 0
  bash -c '
    set +eu
    export NVM_DIR
    . "$NVM_DIR/nvm.sh" </dev/null >/dev/null 2>&1 || exit 0
    nvm which default </dev/null 2>/dev/null || true
  ' | tail -n1
}

# 2. Read ~/.nvm/alias/default and map to an installed version dir.
resolve_via_alias_file() {
  local a=""
  [[ -f "$NVM_DIR/alias/default" ]] || return 0
  read -r a <"$NVM_DIR/alias/default" || true
  a="${a//[$'\t\r\n ']/}"
  [[ -n "$a" ]] || return 0
  a="${a#v}"
  case "$a" in
    *[!0-9.]*) return 0 ;;
    *.*) newest_matching "v${a}" "v${a}.*"; return 0 ;;
    *)   newest_matching "v${a}.[0-9]*"; return 0 ;;
  esac
}

# 3. Newest installed.
newest_installed() { newest_matching "*"; }

NODE_BIN="$(resolve_via_nvm)"
usable_node "$NODE_BIN" || NODE_BIN="$(resolve_via_alias_file)"
usable_node "$NODE_BIN" || NODE_BIN="$(newest_installed)"
usable_node "$NODE_BIN" || die "no usable node found under $VERSIONS_DIR"

export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ "${RUN_INGEST_RESOLVE_ONLY:-0}" == "1" ]]; then
  printf '%s\n' "$NODE_BIN"
  exit 0
fi

cd "$APP_DIR" || die "cannot cd to $APP_DIR"
[[ -f "$ENTRY" ]]    || die "ingest entrypoint not found: $ENTRY"
[[ -f "$REGISTER" ]] || die "TS resolver hook not found: $REGISTER"

printf 'run-ingest-lc360: starting LC360 ingest with node %s (%s)\n' \
  "$NODE_BIN" "$("$NODE_BIN" --version 2>/dev/null || echo 'version unknown')" >&2

# exec so systemd's PID/signal handling hits node directly.
exec "$NODE_BIN" --env-file="$ENV_FILE" --import="$REGISTER" "$ENTRY"
