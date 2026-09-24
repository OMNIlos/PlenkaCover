#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

mode="${1:-}"
artifact="${2:-}"
confirmation="${3:-}"
expected_migration=''
case "$mode" in
  --check)
    [[ $# -eq 2 ]] ||
      die 'usage: restore.sh --check BACKUP | --check-migrate BACKUP EXPECTED_MIGRATION | --live BACKUP RESTORE_LIVE_PLENKA'
    ;;
  --check-migrate)
    [[ $# -eq 3 ]] ||
      die 'usage: restore.sh --check BACKUP | --check-migrate BACKUP EXPECTED_MIGRATION | --live BACKUP RESTORE_LIVE_PLENKA'
    expected_migration="$confirmation"
    [[ "$expected_migration" =~ ^[0-9]{14}_[a-z0-9][a-z0-9_]{0,119}$ ]] ||
      die 'expected migration name is invalid'
    ;;
  --live)
    [[ $# -eq 3 ]] ||
      die 'usage: restore.sh --check BACKUP | --check-migrate BACKUP EXPECTED_MIGRATION | --live BACKUP RESTORE_LIVE_PLENKA'
    ;;
  *)
    die 'usage: restore.sh --check BACKUP | --check-migrate BACKUP EXPECTED_MIGRATION | --live BACKUP RESTORE_LIVE_PLENKA'
    ;;
esac

validate_environment
ensure_runtime

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

verify_private_artifact_file() {
  local candidate="$1"
  local expected_uid=0
  local links
  local mode
  local uid

  if mode="$(stat -c '%a' "$candidate" 2>/dev/null)"; then
    uid="$(stat -c '%u' "$candidate")"
    links="$(stat -c '%h' "$candidate")"
  else
    mode="$(stat -f '%Lp' "$candidate")"
    uid="$(stat -f '%u' "$candidate")"
    links="$(stat -f '%l' "$candidate")"
  fi
  if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
    expected_uid="$(id -u)"
  fi
  [[ "$mode" == 600 && "$uid" == "$expected_uid" && "$links" == 1 ]] ||
    die 'backup artifact files must have the expected owner, mode 0600 and one link'
}

verify_artifact_files() {
  local candidate="$1"
  local actual_checksum
  local candidate_name
  local expected_checksum
  local expected_name
  local normalized_expected_checksum
  local unexpected_checksum_field
  [[ "$candidate" == "$BACKUP_DIR/$(basename -- "$candidate")" ]] ||
    die 'backup artifact must be directly inside BACKUP_DIR'
  candidate_name="$(basename -- "$candidate")"
  [[ "$candidate_name" =~ ^plenka-[0-9]{8}T[0-9]{6}Z[.]dump$ ]] ||
    die 'backup artifact name is invalid'
  [[ -f "$candidate" && ! -L "$candidate" ]] ||
    die 'backup artifact must be a regular non-symlink file'
  [[ -s "$candidate" ]] || die 'backup artifact must not be empty'
  [[ -f "$candidate.sha256" && ! -L "$candidate.sha256" ]] ||
    die 'backup checksum must be a regular non-symlink file'
  [[ -f "$candidate.complete" && ! -L "$candidate.complete" ]] ||
    die 'backup completion marker must be a regular non-symlink file'
  verify_private_artifact_file "$candidate"
  verify_private_artifact_file "$candidate.sha256"
  verify_private_artifact_file "$candidate.complete"
  [[ "$(awk 'END { print NR }' "$candidate.sha256")" == 1 ]] ||
    die 'backup checksum sidecar must contain exactly one record'
  expected_checksum=''
  expected_name=''
  unexpected_checksum_field=''
  IFS=' ' read -r expected_checksum expected_name unexpected_checksum_field \
    <"$candidate.sha256" || die 'backup checksum sidecar is unreadable'
  [[ -z "$unexpected_checksum_field" && "$expected_name" == "$candidate_name" ]] ||
    die 'backup checksum sidecar does not name the selected artifact'
  [[ "$(awk 'END { print NR }' "$candidate.complete")" == 1 &&
    "$(cat "$candidate.complete")" == complete ]] ||
    die 'backup completion marker is invalid'
  actual_checksum="$(sha256_file "$candidate")"
  [[ "$expected_checksum" =~ ^[a-fA-F0-9]{64}$ ]] || die 'invalid checksum sidecar'
  normalized_expected_checksum="$(printf '%s' "$expected_checksum" | tr 'A-F' 'a-f')"
  [[ "$actual_checksum" == "$normalized_expected_checksum" ]] || die 'backup checksum mismatch'
}

BACKUP_DIR="$(env_value BACKUP_DIR)"
POSTGRES_ADMIN_USER="$(env_value POSTGRES_ADMIN_USER)"
DATABASE_OWNER_USER="$(env_value DATABASE_OWNER_USER)"
DATABASE_APP_USER="$(env_value DATABASE_APP_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
[[ "$POSTGRES_DB" =~ ^[a-z][a-z0-9_]{2,62}$ &&
  ! "$POSTGRES_DB" =~ ^(postgres|template0|template1)$ ]] ||
  die 'unsafe application database name'
prepare_backup_directory "$BACKUP_DIR"
if [[ "$mode" == '--check-migrate' || "$mode" == '--live' ]]; then
  require_command flock
  exec 9>"$BACKUP_DIR/.maintenance.lock"
  flock -n 9 || die 'backup, restore or migration rehearsal is already running'
fi
verify_artifact_files "$artifact"
canonical_environment="$VPS_ENV_FILE"
restore_database=''
cleanup_database=false
database_create_pid=''
temporary_environment=''

drop_database() {
  local database="$1"
  compose exec -T db psql \
    --username="$POSTGRES_ADMIN_USER" \
    --dbname=postgres \
    --set=ON_ERROR_STOP=1 \
    --command="DROP DATABASE IF EXISTS \"$database\" WITH (FORCE);" >/dev/null
}

cleanup() {
  local status="$?"
  local cleanup_failed=false
  local create_status=0

  trap - EXIT
  trap '' HUP INT TERM
  VPS_ENV_FILE="$canonical_environment"
  if [[ -n "$database_create_pid" ]]; then
    wait "$database_create_pid" || create_status="$?"
    if [[ "$create_status" == 0 ]]; then
      cleanup_database=true
    fi
    database_create_pid=''
  fi
  if [[ "$cleanup_database" == true && -n "$restore_database" ]]; then
    if ! drop_database "$restore_database" >/dev/null 2>&1; then
      printf 'ERROR: failed to clean up disposable database\n' >&2
      cleanup_failed=true
    fi
  fi
  if [[ -n "$temporary_environment" ]]; then
    if ! rm -f -- "$temporary_environment" ||
      [[ -e "$temporary_environment" || -L "$temporary_environment" ]]; then
      printf 'ERROR: failed to remove temporary migration environment\n' >&2
      cleanup_failed=true
    fi
  fi
  [[ "$cleanup_failed" != true ]] || status=1
  exit "$status"
}
trap cleanup EXIT

install_termination_traps() {
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

install_termination_traps

create_database() {
  local database="$1"
  compose exec -T db psql \
    --username="$POSTGRES_ADMIN_USER" \
    --dbname=postgres \
    --set=ON_ERROR_STOP=1 \
    --command="CREATE DATABASE \"$database\" OWNER \"$DATABASE_OWNER_USER\";" >/dev/null
}

create_owned_disposable_database() {
  local database="$1"
  local create_status=0

  [[ -z "$database_create_pid" && "$cleanup_database" == false ]] ||
    die 'disposable database ownership state is already active'
  trap '' HUP INT TERM
  (
    trap '' HUP INT TERM
    create_database "$database"
  ) &
  database_create_pid="$!"
  install_termination_traps

  wait "$database_create_pid" || create_status="$?"
  if [[ "$create_status" == 0 ]]; then
    cleanup_database=true
  fi
  database_create_pid=''
  return "$create_status"
}

restore_into() {
  local database="$1"
  local source_artifact="$2"
  compose exec -T db pg_restore \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --exit-on-error \
    --no-owner \
    --no-privileges <"$source_artifact" >/dev/null
}

grant_runtime_access() {
  local database="$1"
  compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --set=ON_ERROR_STOP=1 \
    --command="GRANT USAGE ON SCHEMA public TO \"$DATABASE_APP_USER\";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \"$DATABASE_APP_USER\";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \"$DATABASE_APP_USER\";
ALTER DEFAULT PRIVILEGES FOR ROLE \"$DATABASE_OWNER_USER\" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \"$DATABASE_APP_USER\";
ALTER DEFAULT PRIVILEGES FOR ROLE \"$DATABASE_OWNER_USER\" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO \"$DATABASE_APP_USER\";
DO \$\$
BEGIN
  IF to_regprocedure('public.hard_delete_commercial_order(text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.hard_delete_commercial_order(text) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hard_delete_commercial_order(text) TO \"$DATABASE_APP_USER\"';
  END IF;
END
\$\$;" >/dev/null
}

verify_database() {
  local database="$1"
  local migration_count
  migration_count="$(compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL;')"
  [[ "$migration_count" =~ ^[[:space:]]*[1-9][0-9]*[[:space:]]*$ ]] ||
    die 'restored database has no completed Prisma migrations'
  compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT count(*) FROM "users"; SELECT count(*) FROM "posts";' >/dev/null
  compose exec -T db psql \
    --username="$DATABASE_APP_USER" \
    --dbname="$database" \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT count(*) FROM "users"; SELECT count(*) FROM "posts";' >/dev/null
}

completed_migration_count() {
  local database="$1"

  compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL;'
}

verify_artifact_in_disposable_database() {
  local source_artifact="$1"
  restore_database="plenka_restore_check_$(date -u '+%Y%m%d%H%M%S')_$$_${RANDOM}"
  create_owned_disposable_database "$restore_database"
  restore_into "$restore_database" "$source_artifact"
  grant_runtime_access "$restore_database"
  verify_database "$restore_database"
  drop_database "$restore_database"
  cleanup_database=false
  restore_database=''
}

verify_private_environment() {
  local expected_uid=0
  local mode
  local uid

  if mode="$(stat -c '%a' "$temporary_environment" 2>/dev/null)"; then
    uid="$(stat -c '%u' "$temporary_environment")"
  else
    mode="$(stat -f '%Lp' "$temporary_environment")"
    uid="$(stat -f '%u' "$temporary_environment")"
  fi
  if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
    expected_uid="$(id -u)"
  fi
  [[ "$mode" == 600 && "$uid" == "$expected_uid" ]] ||
    die 'temporary migration environment has unsafe ownership or mode'
}

create_migration_environment() {
  local database="$1"
  local canonical_directory
  local disposable_migration_url
  local disposable_runtime_url
  local line
  local migration_url
  local migration_replaced=false
  local postgresql_database_replaced=false
  local runtime_replaced=false
  local runtime_url
  local suffix
  local migration_url_prefix
  local runtime_url_prefix

  migration_url="$(env_value MIGRATION_DATABASE_URL)"
  runtime_url="$(env_value DATABASE_URL)"
  suffix="/${POSTGRES_DB}?schema=public"
  migration_url_prefix="${migration_url%"$suffix"}"
  runtime_url_prefix="${runtime_url%"$suffix"}"
  [[ "$migration_url_prefix" != "$migration_url" && -n "$migration_url_prefix" ]] ||
    die 'migration database URL does not match the validated application database'
  [[ "$runtime_url_prefix" != "$runtime_url" && -n "$runtime_url_prefix" ]] ||
    die 'runtime database URL does not match the validated application database'
  disposable_migration_url="${migration_url_prefix}/${database}?schema=public"
  disposable_runtime_url="${runtime_url_prefix}/${database}?schema=public"
  canonical_directory="$(cd "$(dirname "$canonical_environment")" && pwd -L)"
  temporary_environment="$(mktemp "$canonical_directory/.pilot-migration-rehearsal.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      POSTGRES_DB=*)
        [[ "$postgresql_database_replaced" == false ]] ||
          die 'canonical environment contains duplicate application database names'
        printf 'POSTGRES_DB=%s\n' "$database"
        postgresql_database_replaced=true
        ;;
      DATABASE_URL=*)
        [[ "$runtime_replaced" == false ]] ||
          die 'canonical environment contains duplicate runtime database URLs'
        printf 'DATABASE_URL=%s\n' "$disposable_runtime_url"
        runtime_replaced=true
        ;;
      MIGRATION_DATABASE_URL=*)
        [[ "$migration_replaced" == false ]] ||
          die 'canonical environment contains duplicate migration database URLs'
        printf 'MIGRATION_DATABASE_URL=%s\n' "$disposable_migration_url"
        migration_replaced=true
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done <"$canonical_environment" >"$temporary_environment"
  [[ "$postgresql_database_replaced" == true && "$runtime_replaced" == true &&
    "$migration_replaced" == true ]] ||
    die 'canonical environment omitted a database target'
  chmod 0600 "$temporary_environment"
  verify_private_environment
  if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
    "$SCRIPT_DIR/validate-env.sh" --local-smoke "$temporary_environment" >/dev/null 2>&1 ||
      die 'temporary migration environment validation failed'
  else
    "$SCRIPT_DIR/validate-env.sh" "$temporary_environment" >/dev/null 2>&1 ||
      die 'temporary migration environment validation failed'
  fi
}

run_candidate_migration() {
  local migrate_status=0

  VPS_ENV_FILE="$temporary_environment"
  compose run --rm --no-deps --pull never migrate >/dev/null 2>&1 || migrate_status="$?"
  VPS_ENV_FILE="$canonical_environment"
  [[ "$migrate_status" == 0 ]] || die 'candidate migration rehearsal failed'
}

verify_migration_journal() {
  local database="$1"
  local expected="$2"
  local minimum_completed="$3"
  local completed
  local expected_finished
  local expected_invalid
  local health
  local incomplete

  health="$(compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="/* migration_rehearsal_post */
    SELECT
      count(*) FILTER (
        WHERE \"finished_at\" IS NULL AND \"rolled_back_at\" IS NULL
      )::text || ':' ||
      count(*) FILTER (WHERE \"finished_at\" IS NOT NULL)::text || ':' ||
      count(*) FILTER (
        WHERE \"migration_name\" = '${expected}'
          AND \"finished_at\" IS NOT NULL
          AND \"rolled_back_at\" IS NULL
      )::text || ':' ||
      count(*) FILTER (
        WHERE \"migration_name\" = '${expected}'
          AND (
            \"finished_at\" IS NULL
            OR \"rolled_back_at\" IS NOT NULL
          )
      )::text
    FROM \"_prisma_migrations\";")"
  [[ "$health" =~ ^[[:space:]]*([0-9]+):([0-9]+):([0-9]+):([0-9]+)[[:space:]]*$ ]] ||
    die 'candidate migration journal returned an invalid health result'
  incomplete="${BASH_REMATCH[1]}"
  completed="${BASH_REMATCH[2]}"
  expected_finished="${BASH_REMATCH[3]}"
  expected_invalid="${BASH_REMATCH[4]}"
  [[ "$incomplete" == 0 && "$completed" -gt "$minimum_completed" &&
    "$expected_finished" == 1 && "$expected_invalid" == 0 ]] ||
    die 'candidate migration journal is incomplete or omitted the expected migration'
}

verify_pre_migration_journal() {
  local database="$1"
  local expected="$2"
  local existing
  local health
  local incomplete

  health="$(compose exec -T db psql \
    --username="$DATABASE_OWNER_USER" \
    --dbname="$database" \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="/* migration_rehearsal_pre */
    SELECT
      count(*) FILTER (WHERE \"migration_name\" = '${expected}')::text || ':' ||
      count(*) FILTER (
        WHERE \"finished_at\" IS NULL AND \"rolled_back_at\" IS NULL
      )::text
    FROM \"_prisma_migrations\";")"
  [[ "$health" =~ ^[[:space:]]*([0-9]+):([0-9]+)[[:space:]]*$ ]] ||
    die 'pre-migration journal returned an invalid health result'
  existing="${BASH_REMATCH[1]}"
  incomplete="${BASH_REMATCH[2]}"
  [[ "$existing" == 0 ]] ||
    die 'expected migration is already present in the checked backup'
  [[ "$incomplete" == 0 ]] ||
    die 'checked backup contains an incomplete migration'
}

verify_no_stale_rehearsal_database() {
  local stale_count

  stale_count="$(compose exec -T db psql \
    --username="$POSTGRES_ADMIN_USER" \
    --dbname=postgres \
    --tuples-only \
    --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="SELECT count(*)
      FROM pg_database
      WHERE strpos(datname, 'plenka_migration_check_') = 1;")"
  [[ "$stale_count" =~ ^[[:space:]]*0[[:space:]]*$ ]] ||
    die 'stale migration rehearsal database requires manual recovery'
}

if [[ "$mode" == '--check' ]]; then
  verify_artifact_in_disposable_database "$artifact"
  printf 'Restore check: PASS\n'
  exit 0
fi

if [[ "$mode" == '--check-migrate' ]]; then
  [[ -f "$VPS_ROOT_DIR/apps/api/prisma/migrations/$expected_migration/migration.sql" &&
    ! -L "$VPS_ROOT_DIR/apps/api/prisma/migrations/$expected_migration/migration.sql" ]] ||
    die 'expected migration is absent from the candidate release'
  verify_no_stale_rehearsal_database
  restore_database="plenka_migration_check_$(date -u '+%Y%m%d%H%M%S')_$$_${RANDOM}"
  [[ "$restore_database" =~ ^plenka_migration_check_[0-9]{14}_[0-9]+_[0-9]+$ &&
    ${#restore_database} -le 63 && "$restore_database" != "$POSTGRES_DB" ]] ||
    die 'unsafe disposable migration database name'
  create_owned_disposable_database "$restore_database"
  restore_into "$restore_database" "$artifact"
  grant_runtime_access "$restore_database"
  verify_database "$restore_database"
  verify_pre_migration_journal "$restore_database" "$expected_migration"
  pre_migration_count="$(completed_migration_count "$restore_database")"
  [[ "$pre_migration_count" =~ ^[[:space:]]*[1-9][0-9]*[[:space:]]*$ ]] ||
    die 'restored database has no completed Prisma migrations'

  create_migration_environment "$restore_database"
  run_candidate_migration
  rm -f -- "$temporary_environment"
  [[ ! -e "$temporary_environment" && ! -L "$temporary_environment" ]] ||
    die 'failed to remove temporary migration environment'
  temporary_environment=''
  verify_database "$restore_database"
  verify_migration_journal "$restore_database" "$expected_migration" "$pre_migration_count"

  VPS_ENV_FILE="$canonical_environment"
  drop_database "$restore_database"
  cleanup_database=false
  restore_database=''
  printf 'Migration rehearsal: PASS\n'
  exit 0
fi

[[ "$confirmation" == 'RESTORE_LIVE_PLENKA' ]] || die 'live restore confirmation mismatch'
api_container="$(compose ps -q api)"
if [[ -n "$api_container" ]] && [[ "$(docker inspect -f '{{.State.Running}}' "$api_container")" == true ]]; then
  die 'stop the API before a live restore'
fi

verify_artifact_in_disposable_database "$artifact"

export PLENKA_MAINTENANCE_LOCK_HELD=1
pre_restore_artifact="$("$SCRIPT_DIR/backup.sh" --lock-held)"
unset PLENKA_MAINTENANCE_LOCK_HELD
case "$pre_restore_artifact" in
  "$BACKUP_DIR"/plenka-*.dump) ;;
  *) die 'pre-restore backup returned an invalid artifact path' ;;
esac
[[ -f "$pre_restore_artifact" && -f "$pre_restore_artifact.sha256" &&
  -f "$pre_restore_artifact.complete" ]] || die 'pre-restore backup evidence is incomplete'
verify_artifact_files "$pre_restore_artifact"
verify_artifact_in_disposable_database "$pre_restore_artifact"
printf 'Pre-restore backup created and verified: %s\n' "$pre_restore_artifact"

restore_database="$POSTGRES_DB"
drop_database "$restore_database"
create_database "$restore_database"
restore_into "$restore_database" "$artifact"
grant_runtime_access "$restore_database"
verify_database "$restore_database"
printf 'Live restore: PASS; start API and run VPS smoke before accepting traffic\n'
