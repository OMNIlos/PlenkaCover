#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

validate_environment
ensure_runtime

container_health() {
  local container
  container="$(compose ps --status running -q "$1")"
  if [[ -z "$container" ]]; then
    printf '%s\n' 'stopped'
    return
  fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$container" 2>/dev/null || printf '%s\n' 'unknown'
}

db_health="$(container_health db)"
api_health="$(container_health api)"
web_health="$(container_health web)"

if [[ "$api_health" == unhealthy ]]; then
  if [[ "$db_health" == healthy ]]; then
    compose restart api >/dev/null
    printf '%s\n' 'Recovery guard: restarted unhealthy api'
  else
    printf '%s\n' 'Recovery guard: api restart skipped while database is not healthy'
  fi
fi

if [[ "$web_health" == unhealthy ]]; then
  compose restart web >/dev/null
  printf '%s\n' 'Recovery guard: restarted unhealthy web'
fi
