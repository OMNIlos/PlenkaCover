#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_CADDYFILE="$SCRIPT_DIR/fixtures/Caddyfile.runtime"
FRONTEND_ROUTES="$ROOT_DIR/deploy/vps/frontend-routes.caddy"

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

if [[ $# -ne 1 || -z "$1" ]]; then
  die 'usage: smoke-caddy-runtime.sh WEB_IMAGE'
fi

WEB_IMAGE="$1"
readonly WEB_IMAGE

for command_name in awk cmp curl date docker find grep mktemp sed seq sleep; do
  require_command "$command_name"
done

docker info >/dev/null 2>&1 || die 'Docker daemon is unavailable'
resolved_image_id="$(docker image inspect --format '{{.Id}}' "$WEB_IMAGE" 2>/dev/null)" ||
  die 'the exact supplied web image is not available locally'
[[ "$resolved_image_id" == sha256:* ]] ||
  die 'the supplied web image did not resolve to an immutable local image ID'

temporary_root="${TMPDIR:-/tmp}"
temporary_directory="$(mktemp -d "${temporary_root%/}/plenka-caddy-runtime.XXXXXX")"
runtime_id="plenka-caddy-runtime-${$}-$(date +%s)"
network_name="${runtime_id}-network"
inspect_container="${runtime_id}-inspect"
api_container="${runtime_id}-api"
web_container="${runtime_id}-web"

cleanup() {
  local status="$?"

  trap - EXIT INT TERM
  docker container rm --force \
    "$web_container" \
    "$api_container" \
    "$inspect_container" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  find "$temporary_directory" -depth -delete >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

index_file="$temporary_directory/index.html"
image_asset_file="$temporary_directory/image-asset.js"

docker create --name "$inspect_container" "$resolved_image_id" >/dev/null
docker cp "${inspect_container}:/srv/index.html" "$index_file"
[[ -s "$index_file" ]] || die 'the supplied web image has no non-empty /srv/index.html'

entry_path="$(
  awk '
    match($0, /src="\/assets\/[^"]+[.]js"/) {
      print substr($0, RSTART + 5, RLENGTH - 6)
      exit
    }
  ' "$index_file"
)"
case "$entry_path" in
  /assets/*.js) ;;
  *) die 'could not resolve the Vite JavaScript entry from /srv/index.html' ;;
esac
[[ "$entry_path" != *'..'* && "$entry_path" != *$'\n'* ]] ||
  die 'the Vite JavaScript entry path is unsafe'

docker cp "${inspect_container}:/srv${entry_path}" "$image_asset_file"
[[ -s "$image_asset_file" ]] || die 'the Vite JavaScript entry is empty'

docker network create "$network_name" >/dev/null
docker run --detach \
  --name "$api_container" \
  --network "$network_name" \
  --network-alias api \
  --entrypoint caddy \
  "$resolved_image_id" \
  respond --listen :3000 --status 204 >/dev/null

docker run --detach \
  --name "$web_container" \
  --network "$network_name" \
  --publish 127.0.0.1::8080 \
  --volume "$RUNTIME_CADDYFILE:/etc/caddy/Caddyfile.runtime:ro" \
  --volume "$FRONTEND_ROUTES:/etc/caddy/frontend-routes.caddy:ro" \
  --entrypoint caddy \
  "$resolved_image_id" \
  run --config /etc/caddy/Caddyfile.runtime --adapter caddyfile >/dev/null

published_binding="$(docker port "$web_container" 8080/tcp)"
[[ "$published_binding" != *$'\n'* && "$published_binding" == 127.0.0.1:* ]] ||
  die 'runtime Caddy did not publish one random loopback port'
published_port="${published_binding##*:}"
[[ "$published_port" =~ ^[0-9]+$ ]] || die 'runtime Caddy published an invalid port'
origin="http://127.0.0.1:${published_port}"

ready=false
for _ in $(seq 1 40); do
  if curl --fail --silent \
    --connect-timeout 1 \
    --max-time 1 \
    --output /dev/null \
    "$origin/" 2>/dev/null; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$web_container")" != true ]]; then
    break
  fi
  sleep 0.25
done
if [[ "$ready" != true ]]; then
  docker logs --tail 80 "$web_container" >&2 || true
  die 'runtime Caddy did not become ready within 50 seconds'
fi

header_values() {
  local header_name="$1"
  local headers_file="$2"

  awk -v expected="$header_name" '
    {
      line = $0
      sub(/\r$/, "", line)
      separator = index(line, ":")
      if (separator == 0) next
      name = tolower(substr(line, 1, separator - 1))
      if (name != tolower(expected)) next
      value = substr(line, separator + 1)
      sub(/^[[:space:]]+/, "", value)
      print value
    }
  ' "$headers_file"
}

assert_html_shell() {
  local request_path="$1"
  local artifact_name="$2"
  local headers_file="$temporary_directory/${artifact_name}.headers"
  local body_file="$temporary_directory/${artifact_name}.body"
  local status_code
  local cache_control

  status_code="$(
    curl --fail --silent --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --dump-header "$headers_file" \
      --output "$body_file" \
      --write-out '%{http_code}' \
      "$origin$request_path"
  )"
  [[ "$status_code" == 200 ]] || die "$request_path did not return HTTP 200"
  cache_control="$(header_values Cache-Control "$headers_file")"
  [[ "$cache_control" == 'no-cache, no-store, must-revalidate' ]] ||
    die "$request_path did not return the exact no-cache policy"
  cmp -s "$index_file" "$body_file" || die "$request_path did not return the exact SPA shell"
}

assert_not_html() {
  local headers_file="$1"
  local body_file="$2"

  if header_values Content-Type "$headers_file" | grep -Eiq '^text/html(?:;|$)'; then
    die 'a missing frontend artifact returned an HTML content type'
  fi
  if grep -Eiq '<!doctype[[:space:]]+html|<html(?:[[:space:]>])' "$body_file"; then
    die 'a missing frontend artifact returned an HTML body'
  fi
  cmp -s "$index_file" "$body_file" &&
    die 'a missing frontend artifact returned the SPA shell'
  return 0
}

sha256_file() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die 'sha256sum or shasum is required'
  fi
}

api_body="$temporary_directory/api.body"
api_status="$(
  curl --fail --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --output "$api_body" \
    --write-out '%{http_code}' \
    "$origin/api/runtime-smoke"
)"
[[ "$api_status" == 204 ]] || die 'the API route was not handled before frontend routes'
[[ ! -s "$api_body" ]] || die 'the dummy API returned an unexpected body'

assert_html_shell '/' root
assert_html_shell '/commercial/orders/route-smoke' deep-link

asset_headers="$temporary_directory/asset.headers"
http_asset_file="$temporary_directory/http-asset.js"
asset_status="$(
  curl --fail --silent --show-error \
    --connect-timeout 2 \
    --max-time 5 \
    --dump-header "$asset_headers" \
    --output "$http_asset_file" \
    --write-out '%{http_code}' \
    "$origin$entry_path"
)"
[[ "$asset_status" == 200 ]] || die 'the Vite JavaScript entry did not return HTTP 200'
asset_cache_control="$(header_values Cache-Control "$asset_headers")"
[[ "$asset_cache_control" == 'public, max-age=31536000, immutable' ]] ||
  die 'the Vite JavaScript entry did not return the exact immutable cache policy'
image_asset_sha256="$(sha256_file "$image_asset_file")"
http_asset_sha256="$(sha256_file "$http_asset_file")"
[[ "$http_asset_sha256" == "$image_asset_sha256" ]] ||
  die 'the HTTP JavaScript bytes differ from /srv in the exact supplied web image'

for missing_path in \
  "/assets/${runtime_id}-missing.js" \
  "${entry_path}.map"; do
  artifact_name="$(printf '%s' "$missing_path" | sed 's#[^A-Za-z0-9]#-#g')"
  missing_headers="$temporary_directory/${artifact_name}.headers"
  missing_body="$temporary_directory/${artifact_name}.body"
  missing_status="$(
    curl --silent --show-error \
      --connect-timeout 2 \
      --max-time 5 \
      --dump-header "$missing_headers" \
      --output "$missing_body" \
      --write-out '%{http_code}' \
      "$origin$missing_path"
  )"
  [[ "$missing_status" == 404 ]] || die "$missing_path did not return a real HTTP 404"
  assert_not_html "$missing_headers" "$missing_body"
done

printf 'Caddy runtime smoke: PASS (%s)\n' "$WEB_IMAGE"
