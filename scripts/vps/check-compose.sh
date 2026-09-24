#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

if [[ "${1:-}" == '--example-only' ]]; then
  VPS_ENV_FILE="$VPS_ROOT_DIR/deploy/vps/.env.example"
elif [[ $# -ne 0 ]]; then
  die 'usage: check-compose.sh [--example-only]'
else
  validate_environment
fi

ensure_runtime
compose --profile bootstrap config --quiet
printf 'Compose validation: PASS\n'
