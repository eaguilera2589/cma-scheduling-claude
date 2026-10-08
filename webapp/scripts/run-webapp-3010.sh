#!/usr/bin/env bash
# run-webapp-3010.sh — runtime node resolver + launcher for the CMA Scheduling
# webapp (Next.js production server, port 3010).
#
# Used by the systemd user unit cma-scheduling-webapp.service. The unit must NOT
# pin a versioned nvm node path: nvm upgrades move the binary to
# ~/.nvm/versions/node/<newver>/, which would break a hard-pinned ExecStart.
# Resolving node here means a node upgrade is picked up with no unit-file edit.
#
# Resolution order (first usable hit wins):
#   1. nvm itself: source ~/.nvm/nvm.sh and ask `nvm which default` (correctly
#      resolves any alias form the alias file may contain: lts/*, major, exact).
#   2. Pure-bash: read ~/.nvm/alias/default and glob it against installed
#      version dirs (covers major "26" and exact/ "26.8" style aliases even if
#      sourcing nvm.sh fails).
#   3. Newest installed ~/.nvm/versions/node/*/bin/node (sort -V).
#
# Testing hook: RUN_WEBAPP_RESOLVE_ONLY=1 prints the resolved node path and
# exits 0 without launching (used to prove upgrade-proofing; systemd never sets
# it, so the service path is unaffected).
set -euo pipefail

APP_DIR="/opt/workspace/projects/cma-scheduling-claude/webapp"
NEXT_ENTRY="$APP_DIR/node_modules/next/dist/bin/next"
PORT="${PORT:-3010}"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
VERSIONS_DIR="$NVM_DIR/versions/node"

die() { printf 'run-webapp-3010: FATAL: %s\n' "$*" >&2; exit 1; }

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
# Nested/`lts/*` aliases can only be resolved by nvm itself (step 1); here they
# fall through to the newest-installed fallback.
resolve_via_alias_file() {
  local a=""
  [[ -f "$NVM_DIR/alias/default" ]] || return 0
  read -r a <"$NVM_DIR/alias/default" || true
  a="${a//[$'\t\r\n ']/}"          # trim whitespace
  [[ -n "$a" ]] || return 0
  a="${a#v}"
  case "$a" in
    # Contains anything other than digits/dots (e.g. "lts/*", a codename) ->
    # only nvm itself can interpret it; let step 1/3 handle it.
    *[!0-9.]*) return 0 ;;
    # "26.8" or "26.8.2": match the exact dir, plus any patch/prerelease suffix.
    *.*) newest_matching "v${a}" "v${a}.*"; return 0 ;;
    # Bare major "26": newest v26.x installed.
    *)   newest_matching "v${a}.[0-9]*"; return 0 ;;
  esac
}

# 3. Newest installed version, period.
newest_installed() { newest_matching "*"; }

NODE_BIN="$(resolve_via_nvm)"
usable_node "$NODE_BIN" || NODE_BIN="$(resolve_via_alias_file)"
usable_node "$NODE_BIN" || NODE_BIN="$(newest_installed)"
usable_node "$NODE_BIN" || die "no usable node found under $VERSIONS_DIR (nvm default alias AND installed-version fallbacks all failed)"

# Make the resolved node the one everything downstream (PATH lookups, child
# processes) sees too — replaces the version-pinned PATH the unit used to set.
export PATH="$(dirname "$NODE_BIN"):$PATH"

if [[ "${RUN_WEBAPP_RESOLVE_ONLY:-0}" == "1" ]]; then
  printf '%s\n' "$NODE_BIN"
  exit 0
fi

cd "$APP_DIR" || die "cannot cd to $APP_DIR"
[[ -f "$NEXT_ENTRY" ]] || die "Next entrypoint not found: $NEXT_ENTRY"

# Log what we resolved (goes to the user journal) so upgrades are auditable.
printf 'run-webapp-3010: starting next start -p %s with node %s (%s)\n' \
  "$PORT" "$NODE_BIN" "$("$NODE_BIN" --version 2>/dev/null || echo 'version unknown')" >&2

# exec so systemd's PID tracking, signals, and Restart= semantics hit next
# directly (no wrapper shell in between).
exec "$NODE_BIN" "$NEXT_ENTRY" start -p "$PORT"
