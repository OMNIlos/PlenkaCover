#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

validate_environment
ensure_runtime
api_image="$(env_value PLENKA_API_IMAGE)"
migration_image="$(env_value PLENKA_MIGRATION_IMAGE)"

docker build --target runtime --tag "$api_image" "$VPS_ROOT_DIR"
docker build --target migration --tag "$migration_image" "$VPS_ROOT_DIR"
printf 'Backend images: PASS\n'
