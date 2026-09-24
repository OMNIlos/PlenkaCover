#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
previous_environment="${1:-}"
[[ -f "$previous_environment" ]] || {
  printf 'ERROR: usage: rollback.sh /opt/plenka/shared/pilot.previous.env\n' >&2
  exit 1
}

export PLENKA_ENV_FILE="$previous_environment"
"$SCRIPT_DIR/validate-env.sh" "$PLENKA_ENV_FILE" >/dev/null
"$SCRIPT_DIR/deploy.sh"
printf 'Rollback images deployed; run smoke-vps.sh before accepting traffic\n'
