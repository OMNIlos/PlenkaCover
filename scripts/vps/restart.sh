#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
validate_environment
ensure_runtime
service="${1:-api}"
[[ "$service" =~ ^(api|web|db)$ ]] || die 'restart target must be api, web or db'
compose restart "$service"
compose ps "$service"
