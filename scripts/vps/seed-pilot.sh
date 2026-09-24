#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

validate_environment
ensure_runtime
compose --profile bootstrap run --rm seed-pilot
printf 'Pilot seed: PASS\n'
