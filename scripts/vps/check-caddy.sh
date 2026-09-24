#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CADDY_IMAGE='public.ecr.aws/docker/library/caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
CADDYFILE="$ROOT_DIR/deploy/vps/Caddyfile"
FRONTEND_ROUTES="$ROOT_DIR/deploy/vps/frontend-routes.caddy"
RUNTIME_CADDYFILE="$ROOT_DIR/scripts/vps/fixtures/Caddyfile.runtime"

docker info >/dev/null 2>&1 || {
  printf 'ERROR: Docker daemon is unavailable\n' >&2
  exit 1
}

for config_file in "$CADDYFILE" "$FRONTEND_ROUTES" "$RUNTIME_CADDYFILE"; do
  docker run --rm \
    --volume "$config_file:/etc/caddy/config:ro" \
    "$CADDY_IMAGE" \
    caddy fmt --diff /etc/caddy/config >/dev/null
done

docker run --rm \
  --env PUBLIC_HOST=pilot.plenka-kontur.ru \
  --env ACME_EMAIL=ops@example.test \
  --volume "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  --volume "$FRONTEND_ROUTES:/etc/caddy/frontend-routes.caddy:ro" \
  "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

docker run --rm \
  --volume "$RUNTIME_CADDYFILE:/etc/caddy/Caddyfile.runtime:ro" \
  --volume "$FRONTEND_ROUTES:/etc/caddy/frontend-routes.caddy:ro" \
  "$CADDY_IMAGE" \
  caddy validate --config /etc/caddy/Caddyfile.runtime --adapter caddyfile >/dev/null

printf 'Caddy validation: PASS\n'
