#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

artifact="${1:-}"
confirmation="${2:-}"
[[ -n "$artifact" ]] || die 'usage: disaster-recover.sh BACKUP RECOVER_EMPTY_VPS_PLENKA'
[[ "$confirmation" == RECOVER_EMPTY_VPS_PLENKA ]] || die 'disaster recovery confirmation mismatch'

validate_environment
ensure_runtime
[[ "$(env_value ONEC_WRITE)" == false ]] || die 'ONEC_WRITE must remain false during recovery'

for service in api web; do
  [[ -z "$(compose ps --status running -q "$service")" ]] ||
    die 'disaster recovery requires a new host with api and web stopped'
done

cleanup() {
  local status="$?"
  trap - EXIT
  if [[ "$status" -ne 0 ]]; then
    compose stop api web >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose up -d --wait db
"$SCRIPT_DIR/restore.sh" --check "$artifact"

database_owner="$(env_value DATABASE_OWNER_USER)"
database_name="$(env_value POSTGRES_DB)"
public_table_count="$(
  compose exec -T db psql \
    --username="$database_owner" \
    --dbname="$database_name" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
)"
[[ "$public_table_count" =~ ^[[:space:]]*0[[:space:]]*$ ]] ||
  die 'disaster recovery refuses a database that is not empty'

# Create a verified empty schema so restore.sh can preserve and validate its own pre-restore fact.
compose run --rm --no-deps migrate
"$SCRIPT_DIR/restore.sh" --live "$artifact" RESTORE_LIVE_PLENKA
"$SCRIPT_DIR/deploy.sh"
"$SCRIPT_DIR/smoke-vps.sh"

printf '%s\n' 'Disaster recovery: PASS'
