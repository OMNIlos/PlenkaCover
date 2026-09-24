#!/usr/bin/env bash

VPS_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_ROOT_DIR="$(cd "$VPS_SCRIPT_DIR/../.." && pwd)"
VPS_COMPOSE_FILE="$VPS_ROOT_DIR/deploy/vps/compose.yml"
VPS_ENV_FILE="${PLENKA_ENV_FILE:-/opt/plenka/shared/pilot.env}"

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

env_value() {
  local key="$1"
  awk -v expected="$key" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      sub(/\r$/, "", line)
      separator = index(line, "=")
      if (separator == 0) next
      key = substr(line, 1, separator - 1)
      value = substr(line, separator + 1)
      if (key != expected) next
      print value
      exit
    }
  ' "$VPS_ENV_FILE"
}

validate_environment() {
  if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
    "$VPS_SCRIPT_DIR/validate-env.sh" --local-smoke "$VPS_ENV_FILE" >/dev/null
  else
    "$VPS_SCRIPT_DIR/validate-env.sh" "$VPS_ENV_FILE" >/dev/null
  fi
}

prepare_backup_directory() {
  local backup_directory="$1"
  local actual_mode=''
  local actual_uid=''
  local expected_uid=0
  local resolved_directory

  if [[ ! -e "$backup_directory" && ! -L "$backup_directory" ]]; then
    install -d -m 0700 -- "$backup_directory"
  fi
  [[ -d "$backup_directory" && ! -L "$backup_directory" ]] ||
    die 'backup path must be a real directory'
  resolved_directory="$(cd "$backup_directory" && pwd -P)"
  if [[ "${PLENKA_LOCAL_SMOKE:-}" != 1 ]]; then
    [[ "$resolved_directory" == "$backup_directory" ]] ||
      die 'backup directory must not traverse symlinks'
  fi

  if actual_mode="$(stat -c '%a' "$backup_directory" 2>/dev/null)"; then
    actual_uid="$(stat -c '%u' "$backup_directory")"
  else
    actual_mode="$(stat -f '%Lp' "$backup_directory")"
    actual_uid="$(stat -f '%u' "$backup_directory")"
  fi
  if [[ "${PLENKA_LOCAL_SMOKE:-}" == 1 ]]; then
    expected_uid="$(id -u)"
  fi
  [[ "$actual_mode" == 700 ]] || die 'backup directory mode must be 0700'
  [[ "$actual_uid" == "$expected_uid" ]] || die 'backup directory has an unsafe owner'
}

compose() {
  local key
  local project_name
  local -a sanitized_environment=(env)

  project_name="$(env_value COMPOSE_PROJECT_NAME)"
  [[ -n "$project_name" ]] || die 'COMPOSE_PROJECT_NAME is missing from the environment file'

  while IFS= read -r key; do
    [[ "$key" == COMPOSE_* ]] && sanitized_environment+=(-u "$key")
  done < <(compgen -e)

  while IFS= read -r key; do
    sanitized_environment+=(-u "$key")
  done < <(
    awk '
      {
        line = $0
        while (match(line, /[$][{][A-Za-z_][A-Za-z0-9_]*/)) {
          print substr(line, RSTART + 2, RLENGTH - 2)
          line = substr(line, RSTART + RLENGTH)
        }
      }
    ' "$VPS_COMPOSE_FILE"
  )

  "${sanitized_environment[@]}" docker compose \
    --project-name "$project_name" \
    --env-file "$VPS_ENV_FILE" \
    -f "$VPS_COMPOSE_FILE" \
    "$@"
}

ensure_runtime() {
  require_command docker
  docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'
  docker compose version >/dev/null 2>&1 || die 'Docker Compose plugin is unavailable'
}
