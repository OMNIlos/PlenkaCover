#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

CHECK_AFTER=false
LOCK_HELD=false
NO_RETENTION=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_AFTER=true ;;
    --lock-held) LOCK_HELD=true ;;
    --no-retention) NO_RETENTION=true ;;
    *) die 'usage: backup.sh [--check] [--no-retention]' ;;
  esac
  shift
done
if [[ "$LOCK_HELD" == true && "${PLENKA_MAINTENANCE_LOCK_HELD:-}" != 1 ]]; then
  die 'internal maintenance lock assertion failed'
fi

validate_environment
ensure_runtime

BACKUP_DIR="$(env_value BACKUP_DIR)"
RETENTION_COUNT="$(env_value BACKUP_RETENTION_COUNT)"
RETENTION_DAYS="$(env_value BACKUP_RETENTION_DAYS)"
DATABASE_OWNER_USER="$(env_value DATABASE_OWNER_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
[[ "$BACKUP_DIR" == /* ]] || die 'BACKUP_DIR must be absolute'

prepare_backup_directory "$BACKUP_DIR"

temporary=''
checksum_temporary=''
completion_temporary=''
lock_directory=''
artifact=''
published=false
cleanup() {
  [[ -z "$temporary" ]] || rm -f -- "$temporary"
  [[ -z "$checksum_temporary" ]] || rm -f -- "$checksum_temporary"
  [[ -z "$completion_temporary" ]] || rm -f -- "$completion_temporary"
  if [[ "$published" != true && -n "$artifact" ]]; then
    rm -f -- "$artifact" "$artifact.sha256" "$artifact.complete"
  fi
  [[ -z "$lock_directory" ]] || rmdir "$lock_directory" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [[ "$LOCK_HELD" != true ]]; then
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$BACKUP_DIR/.maintenance.lock"
    flock -n 9 || die 'backup or live restore is already running'
  else
    lock_directory="$BACKUP_DIR/.maintenance.lock.d"
    mkdir "$lock_directory" 2>/dev/null || die 'backup or live restore is already running'
  fi
fi

timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
artifact="$BACKUP_DIR/plenka-${timestamp}.dump"
[[ ! -e "$artifact" && ! -e "$artifact.sha256" && ! -e "$artifact.complete" ]] ||
  die 'backup artifact collision'
temporary="$(mktemp "$BACKUP_DIR/.plenka-${timestamp}.XXXXXX")"

compose exec -T db pg_dump \
  --username="$DATABASE_OWNER_USER" \
  --dbname="$POSTGRES_DB" \
  --format=custom \
  --no-owner \
  --no-privileges >"$temporary"

[[ -s "$temporary" ]] || die 'pg_dump produced an empty artifact'

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

checksum="$(sha256_file "$temporary")"
checksum_temporary="$(mktemp "$BACKUP_DIR/.checksum-${timestamp}.XXXXXX")"
printf '%s  %s\n' "$checksum" "$(basename "$artifact")" >"$checksum_temporary"
completion_temporary="$(mktemp "$BACKUP_DIR/.complete-${timestamp}.XXXXXX")"
printf '%s\n' 'complete' >"$completion_temporary"

mv -- "$temporary" "$artifact"
temporary=''
chmod 0600 "$artifact"
mv -- "$checksum_temporary" "$artifact.sha256"
checksum_temporary=''
chmod 0600 "$artifact.sha256"
mv -- "$completion_temporary" "$artifact.complete"
completion_temporary=''
chmod 0600 "$artifact.complete"
sync
published=true

apply_retention() {
  local backups=()
  local old_artifact
  while IFS= read -r old_artifact; do
    [[ "$old_artifact" == "$artifact" ]] && continue
    [[ -f "$old_artifact.complete" ]] || continue
    rm -f -- "$old_artifact" "$old_artifact.sha256" "$old_artifact.complete"
  done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'plenka-*.dump' -mtime "+$RETENTION_DAYS" -print)

  shopt -s nullglob
  for old_artifact in "$BACKUP_DIR"/plenka-*.dump; do
    [[ -f "$old_artifact.complete" ]] && backups+=("$old_artifact")
  done
  if (( ${#backups[@]} > RETENTION_COUNT )); then
    while IFS= read -r old_artifact; do
      [[ "$old_artifact" == "$artifact" ]] && continue
      rm -f -- "$old_artifact" "$old_artifact.sha256" "$old_artifact.complete"
    done < <(ls -1t "${backups[@]}" | tail -n "+$((RETENTION_COUNT + 1))")
  fi
}

if [[ "$CHECK_AFTER" == true ]]; then
  if ! "$SCRIPT_DIR/restore.sh" --check "$artifact"; then
    rm -f -- "$artifact" "$artifact.sha256" "$artifact.complete"
    die 'new backup failed restore-check; previous backups were preserved'
  fi
  [[ "$NO_RETENTION" == true ]] || apply_retention
fi

printf '%s\n' 'Backup: PASS' >&2
printf '%s\n' "$artifact"
