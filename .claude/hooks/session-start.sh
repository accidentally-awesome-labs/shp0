#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs workspace dependencies and provisions the local Postgres 16 test
# database the db/auth integration tests expect:
#   postgresql:///shp0_test?user=default      (tenant role, subject to RLS)
#   postgresql:///shp0_test?user=cloud_admin  (platform role, owns the schema)
# over the default Unix socket with trust auth (dev container only).
#
# Idempotent: safe on startup, resume, clear and compact.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

log() { echo "[session-start] $*" >&2; }

# ── Dependencies ────────────────────────────────────────────────────────────
log "installing workspace dependencies"
pnpm install --frozen-lockfile --prefer-offline >&2

# ── Postgres ────────────────────────────────────────────────────────────────
PG_VERSION=16
PG_CLUSTER=main
PG_HBA="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}/pg_hba.conf"

if ! command -v pg_ctlcluster >/dev/null 2>&1 || [ ! -f "$PG_HBA" ]; then
  log "Postgres ${PG_VERSION} cluster not found; skipping database setup"
  exit 0
fi

# Trust logins for the two app roles only, over the socket and loopback TCP
# (node-postgres connects to localhost when a URL has no host). pg_hba is
# first-match, so the managed block goes above the default peer/scram rules
# and is rewritten whenever its content changes.
BEGIN_MARK="# BEGIN shp0 test roles (managed by the SessionStart hook)"
END_MARK="# END shp0 test roles"
desired_block="$(printf '%s\n' \
  "$BEGIN_MARK" \
  "local   all   default,cloud_admin                  trust" \
  "host    all   default,cloud_admin   127.0.0.1/32   trust" \
  "host    all   default,cloud_admin   ::1/128        trust" \
  "$END_MARK")"
# Exact-string matching (no regex), so the markers need no escaping.
current_block="$(awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{p=1} p{print} $0==e{p=0}' "$PG_HBA")"
if [ "$current_block" != "$desired_block" ]; then
  log "writing trust rules for roles default and cloud_admin to pg_hba.conf"
  tmp="$(mktemp)"
  {
    echo "$desired_block"
    awk -v b="$BEGIN_MARK" -v e="$END_MARK" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$PG_HBA"
  } > "$tmp"
  cat "$tmp" > "$PG_HBA"
  rm -f "$tmp"
  if pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print $4}' | grep -q online; then
    pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" reload >&2
  fi
fi

if ! pg_lsclusters -h | awk -v v="$PG_VERSION" -v c="$PG_CLUSTER" '$1==v && $2==c {print $4}' | grep -q online; then
  log "starting Postgres ${PG_VERSION}/${PG_CLUSTER}"
  pg_ctlcluster "$PG_VERSION" "$PG_CLUSTER" start >&2
fi

psql_admin() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }

# Roles: cloud_admin owns the database (and so every table applySchema
# creates, which is how it bypasses RLS); "default" is the RLS-bound tenant role.
psql_admin -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloud_admin') THEN
    CREATE ROLE cloud_admin LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'default') THEN
    CREATE ROLE "default" LOGIN;
  END IF;
END
$$;
SQL

if [ -z "$(psql_admin -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname = 'shp0_test'")" ]; then
  log "creating database shp0_test"
  psql_admin -d postgres -c "CREATE DATABASE shp0_test OWNER cloud_admin"
fi

log "ready: postgresql:///shp0_test (roles default, cloud_admin)"
