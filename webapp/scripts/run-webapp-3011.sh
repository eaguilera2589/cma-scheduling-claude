#!/usr/bin/env bash
# run-webapp-3011.sh — runtime node resolver + launcher for the CMA Scheduling
# webapp STAGING instance (Next.js production server, port 3011).
#
# This is the staging twin of run-webapp-3010.sh. It is intentionally a SEPARATE
# script so the production launcher (run-webapp-3010.sh) is never modified. The
# only functional difference from prod is the default PORT (3011); the staging
# data source (DATA_SOURCE=db) and DATABASE_URL are supplied by the
# cma-scheduling-webapp-staging systemd unit, NOT by this script.
#
# Used by the systemd user unit cma-scheduling-webapp-staging.service. Like the
# prod resolver, node is resolved at runtime (nvm `default`, then alias-file,
# then newest installed) so an nvm node upgrade needs NO unit-file edit.
#
# Testing hook: RUN_WEBAPP_RESOLVE_ONLY=1 prints the resolved node path and exits
# 0 without launching (proves upgrade-proofing; systemd never sets it).
set -euo pipefail

APP_DIR="/opt/workspace/projects/cma-scheduling-claude/webapp"
NEXT_ENTRY="$APP_DIR/node_modules/next/dist/bin/next"
PORT="${PORT:-3011}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
VERSIONS_DIR="$NVM_DIR/versions/node"

die() { printf 'run-webapp-3011: FATAL: %s\n' "$*" >&2; exit 1; }

# A resolved value is usable only if it's an executable file.
usable_node() { [[ -n "${1:-}" && -f "$1" && -x "$1" ]]; }

# Newest version dir matching any of the given globs (e.g. "v26.[0-9]*") ->
# echoes its bin/node, or nothing if no match. nullglob keeps failed globs from
# yielding literals. Patterns are intentionally unquoted so they glob.
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

# 1. Ask nvm what "default" resolves to. Subshell: nvm.sh is not clean under
# `set -u`/`set -e` and must not touch our shell; </dev/null so it can never
# block or prompt under the service. Always exits 0; empty output = no answer.
resolve_via_nvm() {
  [[ -s "$NVM_DIR/nvm.sh" ]] || return 0
  bash -c '
    set +eu
    export NVM_DIR
    . "$NVM_DIR/nvm.sh" </dev/null >/dev/null 2>&1 || exit 0
    nvm which default </dev/null 2>/dev/null || true
  ' | tail -n1
}

# 2. Read the alias file directly and map it to an installed version dir.
# Handles: exact "v26.8.2"/"26.8.2", minor "26.8", plain major "26".
resolve_via_alias_file() {
  local a=""
  [[ -f "$NVM_DIR/alias/default" ]] || return 0
  read -r a <"$NVM_DIR/alias/default" || true
  a="${a//[$'\t\r\n ']/}"          # trim whitespace
  [[ -n "$a" ]] || return 0
  a="${a#v}"
  case "$a" in
    *[!0-9.]*) return 0 ;;
    *.*) newest_matching "v${a}" "v${a}.*"; return 0 ;;
    *)   newest_matching "v${a}.[0-9]*"; return 0 ;;
  esac
}

# 3. Newest installed version, period.
newest_installed() { newest_matching "*"; }

NODE_BIN="$(resolve_via_nvm)"
usable_node "$NODE_BIN" || NODE_BIN="$(resolve_via_alias_file)"
usable_node "$NODE_BIN" || NODE_BIN="$(newest_installed)"
usable_node "$NODE_BIN" || die "no usable node found under $VERSIONS_DIR (nvm default alias AND installed-version fallbacks all failed)"

export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ "${RUN_WEBAPP_RESOLVE_ONLY:-0}" == "1" ]]; then
  printf '%s\n' "$NODE_BIN"
  exit 0
fi

cd "$APP_DIR" || die "cannot cd to $APP_DIR"
[[ -f "$NEXT_ENTRY" ]] || die "Next entrypoint not found: $NEXT_ENTRY"

# Log what we resolved (goes to the user journal) so upgrades are auditable.
printf 'run-webapp-3011: starting next start -p %s with node %s (%s)\n' \
  "$PORT" "$NODE_BIN" "$("$NODE_BIN" --version 2>/dev/null || echo 'version unknown')" >&2

# exec so systemd's PID tracking, signals, and Restart= semantics hit next
# directly (no wrapper shell in between).
exec "$NODE_BIN" "$NEXT_ENTRY" start -p "$PORT"
