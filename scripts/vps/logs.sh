#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
validate_environment
ensure_runtime
if (( $# > 0 )); then
  compose logs --tail "${LOG_TAIL:-200}" "$@"
else
  compose logs --tail "${LOG_TAIL:-200}"
fi
