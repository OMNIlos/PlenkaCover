#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

validate_environment
ensure_runtime

compose pull --policy missing db api migrate web
api_container="$(compose ps --all -q api)"
api_remains_stopped=false
api_should_run=false
api_was_absent=false
if [[ -z "$api_container" ]]; then
  api_was_absent=true
else
  api_state="$(docker inspect -f '{{.State.Status}}' "$api_container")"
  case "$api_state" in
    running | restarting)
      api_should_run=true
      compose stop api
      printf 'Deploy: API stopped for the migration maintenance window\n'
      ;;
    created | exited | dead) ;;
    *) die "unsupported API state before migration: $api_state" ;;
  esac
fi
compose up -d --wait db
compose run --rm --no-deps migrate

if [[ "$api_should_run" == true || "$api_was_absent" == true ]]; then
  compose up -d --no-deps api

  api_container="$(compose ps -q api)"
  [[ -n "$api_container" ]] || die 'API container was not created'
  for _ in $(seq 1 36); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container")"
    [[ "$health" == healthy ]] && break
    [[ "$health" == unhealthy ]] && die 'API healthcheck failed'
    sleep 5
  done
  [[ "$health" == healthy ]] || die 'API did not become healthy in time'
else
  compose up --no-start --no-deps api
  api_remains_stopped=true
fi

compose up -d --wait --no-deps --force-recreate web
compose ps
if [[ "$api_remains_stopped" == true ]]; then
  printf 'Deploy: UPDATED; API remains stopped by its prior operator state\n'
else
  printf 'Deploy: STARTED; complete smoke-vps.sh and the browser acceptance checklist before accepting the pilot\n'
fi
