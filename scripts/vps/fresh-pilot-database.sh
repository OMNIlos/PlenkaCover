#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ $# -eq 2 && "$1" == --confirm-archive ]] ||
  die 'usage: fresh-pilot-database.sh --confirm-archive /absolute/path/to/backup.dump'
backup_artifact="$2"

validate_environment
ensure_runtime

[[ "$(env_value SEED_PROFILE)" == pilot ]] || die 'fresh database is available only for pilot'
[[ "$backup_artifact" == /* ]] || die 'backup artifact path must be absolute'

backup_dir="$(env_value BACKUP_DIR)"
database_name="$(env_value POSTGRES_DB)"
admin_user="$(env_value POSTGRES_ADMIN_USER)"
owner_user="$(env_value DATABASE_OWNER_USER)"
app_user="$(env_value DATABASE_APP_USER)"
if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
  marker="${PLENKA_FRESH_DB_MARKER:-$(dirname "$VPS_ENV_FILE")/pilot.legacy.database}"
else
  marker=/opt/plenka/shared/pilot.legacy.database
fi

prepare_backup_directory "$backup_dir"
require_command flock
exec 9>"$backup_dir/.maintenance.lock"
flock -n 9 || die 'backup, restore or database archive is already running'

marker_dir="$(dirname "$marker")"
[[ -d "$marker_dir" && ! -L "$marker_dir" ]] || die 'pilot archive marker directory is unsafe'
if [[ -e "$marker" || -L "$marker" ]]; then
  marker_state='unknown'
  if [[ -f "$marker" && ! -L "$marker" ]]; then
    marker_state="$(awk -F= '$1 == "state" { print $2; exit }' "$marker")"
    [[ -n "$marker_state" ]] || marker_state='unknown'
  fi
  die "a legacy pilot database is already registered; recovery state=$marker_state; refusing a second archive"
fi

[[ "$backup_artifact" == "$backup_dir/$(basename -- "$backup_artifact")" ]] ||
  die 'backup artifact must be directly inside the configured backup directory'
[[ "$(basename -- "$backup_artifact")" =~ ^plenka-[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  die 'backup artifact name is not canonical'
[[ -f "$backup_artifact" && ! -L "$backup_artifact" ]] || die 'backup artifact is unavailable'
[[ -f "$backup_artifact.sha256" && ! -L "$backup_artifact.sha256" ]] ||
  die 'backup checksum is unavailable'
[[ -f "$backup_artifact.complete" && ! -L "$backup_artifact.complete" ]] ||
  die 'backup completion marker is unavailable'
[[ "$(cat "$backup_artifact.complete")" == complete ]] || die 'backup is incomplete'
find "$backup_artifact" -mmin -240 -print -quit | grep -q . ||
  die 'backup is older than four hours; create a fresh checked backup'

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

[[ "$(awk 'END { print NR }' "$backup_artifact.sha256")" == 1 ]] ||
  die 'checksum sidecar must contain exactly one record for the selected artifact'
expected_checksum=''
expected_name=''
unexpected_checksum_field=''
IFS=' ' read -r expected_checksum expected_name unexpected_checksum_field \
  <"$backup_artifact.sha256" || die 'checksum sidecar is unreadable'
[[ -z "$unexpected_checksum_field" && "$expected_name" == "$(basename -- "$backup_artifact")" ]] ||
  die 'checksum sidecar does not name the selected backup artifact'
[[ ${#expected_checksum} -eq 64 && ! "$expected_checksum" =~ [^a-fA-F0-9] ]] ||
  die 'checksum sidecar contains an invalid digest'
actual_checksum="$(sha256_file "$backup_artifact")"
normalized_expected_checksum="$(printf '%s' "$expected_checksum" | tr 'A-F' 'a-f')"
[[ "$actual_checksum" == "$normalized_expected_checksum" ]] ||
  die 'selected backup artifact checksum verification failed'

# A published checksum is not recovery evidence by itself: prove that the exact selected
# artifact restores into a disposable database while the common maintenance lock is held.
"$SCRIPT_DIR/restore.sh" --check "$backup_artifact" >/dev/null

compose up -d --wait db
for service in api web; do
  container="$(compose ps --all -q "$service")"
  [[ -z "$container" ]] && continue
  state="$(docker inspect -f '{{.State.Status}}' "$container")"
  [[ "$state" != running && "$state" != restarting ]] ||
    die "$service must be stopped before archiving the pilot database"
done

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
legacy_suffix="_legacy_${timestamp}"
database_prefix_length=$((63 - ${#legacy_suffix}))
(( database_prefix_length > 0 )) || die 'cannot derive a safe legacy database name'
legacy_name="${database_name:0:database_prefix_length}${legacy_suffix}"
(( ${#legacy_name} <= 63 )) || die 'derived legacy database name exceeds PostgreSQL limits'

marker_started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
marker_temporary=''
marker_preclaimed=false
marker_complete=false

write_marker_state() {
  local destination="$1"
  local state="$2"
  local recovery="$3"
  {
    printf 'state=%s\n' "$state"
    printf 'database=%s\n' "$database_name"
    printf 'legacy_database=%s\n' "$legacy_name"
    printf 'backup_artifact=%s\n' "$(basename -- "$backup_artifact")"
    printf 'backup_sha256=%s\n' "$actual_checksum"
    printf 'started_at=%s\n' "$marker_started_at"
    printf 'updated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'recovery=%s\n' "$recovery"
  } >"$destination"
  chmod 0600 "$destination"
}

replace_marker_state() {
  local state="$1"
  local recovery="$2"
  marker_temporary="$(mktemp "$marker_dir/.pilot.legacy.database.XXXXXX")"
  write_marker_state "$marker_temporary" "$state" "$recovery"
  mv -f -- "$marker_temporary" "$marker"
  marker_temporary=''
  sync
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  [[ -z "$marker_temporary" ]] || rm -f -- "$marker_temporary"
  if [[ "$marker_preclaimed" == true && "$marker_complete" != true && -f "$marker" && ! -L "$marker" ]]; then
    replace_marker_state failed manual_database_state_verification_required >/dev/null 2>&1 || true
  fi
  exit "$status"
}

on_signal() {
  local status="$1"
  exit "$status"
}

trap on_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Publish a same-filesystem hard-link before any database DDL. `ln` is an atomic no-clobber
# claim: a crash leaves `pending`, which blocks every retry until an owner verifies recovery.
marker_temporary="$(mktemp "$marker_dir/.pilot.legacy.database.XXXXXX")"
write_marker_state "$marker_temporary" pending manual_database_state_verification_required
if ! ln "$marker_temporary" "$marker" 2>/dev/null; then
  rm -f -- "$marker_temporary"
  marker_temporary=''
  die 'pilot archive marker was claimed concurrently; refusing database access'
fi
rm -f -- "$marker_temporary"
marker_temporary=''
sync
marker_preclaimed=true

compose exec -T db sh -s -- \
  "$database_name" "$legacy_name" "$admin_user" "$owner_user" "$app_user" <<'CONTAINER_SH'
set -eu

database_name="$1"
legacy_name="$2"
admin_user="$3"
owner_user="$4"
app_user="$5"
committed=false

database_state() {
  psql --username "$admin_user" --dbname postgres --no-align --tuples-only \
    --set=ON_ERROR_STOP=1 --set=database_name="$database_name" --set=legacy_name="$legacy_name" <<'SQL'
SELECT count(*) || ':' || COALESCE(max(datallowconn::int), -1)
  FROM pg_database WHERE datname = :'database_name';
SELECT count(*) || ':' || COALESCE(max(datallowconn::int), -1)
  FROM pg_database WHERE datname = :'legacy_name';
SQL
}

verify_original_state() {
  [ "$(database_state)" = "$(printf '1:1\n0:-1')" ] || {
    printf '%s\n' 'database rollback state verification failed' >&2
    return 1
  }
}

verify_archived_state() {
  [ "$(database_state)" = "$(printf '1:1\n1:0')" ] || {
    printf '%s\n' 'database archive state verification failed' >&2
    return 1
  }
}

rollback() {
  current_state="$(database_state)" || return 1
  application_state="$(printf '%s\n' "$current_state" | sed -n '1p')"
  legacy_state="$(printf '%s\n' "$current_state" | sed -n '2p')"
  if [ "$legacy_state" = '0:-1' ]; then
    [ "$application_state" = '1:1' ] || {
      printf '%s\n' 'application database is not recoverable automatically' >&2
      return 1
    }
    return 0
  fi
  [ "$legacy_state" = '1:0' ] || [ "$legacy_state" = '1:1' ] || {
    printf '%s\n' 'legacy database state is unsafe for automatic rollback' >&2
    return 1
  }

  psql --username "$admin_user" --dbname postgres --set=ON_ERROR_STOP=1 \
    --set=database_name="$database_name" --set=legacy_name="$legacy_name" <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = :'database_name' AND pid <> pg_backend_pid();
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'database_name') \gexec
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS true', :'legacy_name') \gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', :'legacy_name', :'database_name') \gexec
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS true', :'database_name') \gexec
SQL
  verify_original_state
}

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$committed" != true ] && ! rollback; then
    printf '%s\n' 'automatic database rollback failed; keep the pending marker and recover manually' >&2
    status=1
  fi
  exit "$status"
}

on_signal() {
  status="$1"
  exit "$status"
}

trap on_exit EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

counts="$({
  psql --username "$admin_user" --dbname "$database_name" --no-align --tuples-only \
    --set=ON_ERROR_STOP=1 <<'SQL'
SELECT 'active_sessions=' || count(*) FROM operator_post_sessions WHERE status = 'active';
SELECT 'open_bag_usages=' || count(*) FROM shift_bag_usages WHERE "closedAt" IS NULL;
SELECT 'pending_commands=' || count(*) FROM gateway_commands
  WHERE status IN ('queued', 'in_flight');
SELECT 'weight_captures=' || count(*) FROM weight_captures;
SELECT 'operator_operations=' || count(*) FROM operator_roll_operations;
SELECT 'label_jobs=' || count(*) FROM label_print_jobs;
SQL
} 2>/dev/null)"
if printf '%s\n' "$counts" | grep -Ev '^[a-z_]+=0$' >/dev/null; then
  printf '%s\n' 'pilot database archive blocked by active or physical facts' >&2
  printf '%s\n' "$counts" >&2
  exit 1
fi

verify_original_state

psql --username "$admin_user" --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=database_name="$database_name" --set=legacy_name="$legacy_name" <<'SQL' >/dev/null
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = :'database_name' AND pid <> pg_backend_pid();
SELECT format('ALTER DATABASE %I RENAME TO %I', :'database_name', :'legacy_name') \gexec
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'legacy_name') \gexec
SQL

psql --username "$admin_user" --dbname postgres --set=ON_ERROR_STOP=1 \
  --set=database_name="$database_name" --set=owner_user="$owner_user" <<'SQL' >/dev/null
SELECT format(
  'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING ''UTF8''',
  :'database_name', :'owner_user'
) \gexec
SQL

psql --username "$admin_user" --dbname "$database_name" --set=ON_ERROR_STOP=1 \
  --set=database_name="$database_name" --set=owner_user="$owner_user" \
  --set=app_user="$app_user" <<'SQL' >/dev/null
SELECT format('ALTER SCHEMA public OWNER TO %I', :'owner_user') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'app_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner_user', :'app_user'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'owner_user', :'app_user'
) \gexec
SQL

verify_archived_state
committed=true
trap - EXIT HUP INT TERM
CONTAINER_SH

replace_marker_state complete archived_database_frozen_and_verified
marker_complete=true
printf 'Fresh pilot database: PASS (legacy=%s)\n' "$legacy_name"
