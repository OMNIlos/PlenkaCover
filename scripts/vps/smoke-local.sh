#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
temporary_root="${TMPDIR:-/tmp}"
temporary_directory="$(mktemp -d "${temporary_root%/}/plenka-vps-smoke.XXXXXX")"
project_name="plenka-smoke-${$}"
environment_file="$temporary_directory/pilot.env"
release_tag="$(printf '%012x' "$$")"
api_image="plenka-api:$release_tag"
migration_image="plenka-migration:$release_tag"
compose_ready=false

cleanup() {
  if [[ "$compose_ready" == true ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  docker image rm "$api_image" "$migration_image" >/dev/null 2>&1 || true
  rm -rf -- "$temporary_directory"
}
trap cleanup EXIT INT TERM

command -v openssl >/dev/null 2>&1 || {
  printf 'ERROR: openssl is required for ephemeral smoke secrets\n' >&2
  exit 1
}

random_value() {
  openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'
}

admin_database_password="Admin_$(random_value 24)"
owner_database_password="Owner_$(random_value 24)"
app_database_password="Runtime_$(random_value 24)"
database_url="postgresql://plenka_app:${app_database_password}@db:5432/plenka_smoke?schema=public"
migration_database_url="postgresql://plenka_owner:${owner_database_password}@db:5432/plenka_smoke?schema=public"

{
  printf '%s\n' \
    "COMPOSE_PROJECT_NAME=$project_name" \
    "PLENKA_API_IMAGE=$api_image" \
    "PLENKA_MIGRATION_IMAGE=$migration_image" \
    'PLENKA_WEB_IMAGE=plenka-web:000000000000' \
    'PUBLIC_HOST=pilot.plenka-kontur.ru' \
    'PUBLIC_ORIGIN=https://pilot.plenka-kontur.ru' \
    'ACME_EMAIL=ops@example.test' \
    'POSTGRES_ADMIN_USER=plenka_admin' \
    "POSTGRES_ADMIN_PASSWORD=$admin_database_password" \
    'DATABASE_OWNER_USER=plenka_owner' \
    "DATABASE_OWNER_PASSWORD=$owner_database_password" \
    'DATABASE_APP_USER=plenka_app' \
    "DATABASE_APP_PASSWORD=$app_database_password" \
    'POSTGRES_DB=plenka_smoke' \
    "MIGRATION_DATABASE_URL=$migration_database_url" \
    "DATABASE_URL=$database_url" \
    'APP_ENV=pilot' \
    'PALLET_LABEL_PROFILE=pallet-100x100-extended-v6' \
    'WAREHOUSE_COVERAGE_V2_ENABLED=false' \
    'PILOT_SHORT_PASSWORDS_ENABLED=false' \
    'PRODUCTION_COST_RECONCILER_ENABLED=true' \
    'NODE_ENV=production' \
    'AUTH_DEV_XROLE=off' \
    'PORT=3000' \
    'SESSION_TTL=43200' \
    'PASSWORD_SETUP_TTL=1800' \
    'LOGIN_RATE_MAX=10' \
    'LOGIN_RATE_MAX_KEYS=10000' \
    'LOGIN_RATE_WINDOW_MS=60000' \
    'DEVICE_GATEWAY_SCALE=on' \
    'DEVICE_GATEWAY_PRINTER=on' \
    'GATEWAY_SIMULATOR=off' \
    'GATEWAY_COMMAND_TIMEOUT_MS=15000' \
    'ONEC_LIVE=false' \
    'ONEC_WRITE=false' \
    'ONEC_TIMEOUT_MS=5000' \
    'ONEC_FINANCE_SYNC_ENABLED=false' \
    'ONEC_FINANCE_SYNC_INTERVAL_MS=300000' \
    'ONEC_PAYMENT_AUTO_APPLY_ENABLED=false' \
    'ONEC_PAYMENT_SYNC_ENABLED=false' \
    'ONEC_SYNC_ENABLED=false' \
    'ONEC_SYNC_INTERVAL_MS=900000' \
    'ONEC_SYNC_PAGE_SIZE=250' \
    'SEED_PROFILE=pilot'
  for suffix in \
    COMMERCIAL PRODUCTION OPERATOR OPERATOR_2 OPERATOR_3 \
    WAREHOUSE FINANCE DIRECTOR ADMIN; do
    printf 'SEED_PILOT_PASSWORD_%s=Pilot_%s\n' "$suffix" "$(random_value 24)"
  done
  for post in 1 2 3 4 5; do
    printf 'SEED_PILOT_AGENT_TOKEN_POST_%s=ptk_%s\n' "$post" "$(random_value 32)"
  done
  printf '%s\n' \
    "BACKUP_DIR=$temporary_directory/backups" \
    'BACKUP_RETENTION_COUNT=3' \
    'BACKUP_RETENTION_DAYS=1'
} >"$environment_file"
chmod 0600 "$environment_file"

export PLENKA_ENV_FILE="$environment_file"
export PLENKA_LOCAL_SMOKE=1
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
compose_ready=true

validate_environment
ensure_runtime
env -u PLENKA_LOCAL_SMOKE "$SCRIPT_DIR/test/run.sh"

docker build --target runtime --tag "$api_image" "$ROOT_DIR"
docker build --target migration --tag "$migration_image" "$ROOT_DIR"

compose up -d --wait db
compose run --rm --no-deps migrate
compose --profile bootstrap run --rm --no-deps seed-pilot >/dev/null
compose --profile bootstrap run --rm --no-deps seed-pilot >/dev/null
compose up -d --no-deps api

api_container="$(compose ps -q api)"
[[ -n "$api_container" ]] || die 'smoke API container was not created'
for _ in $(seq 1 30); do
  api_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$api_container")"
  [[ "$api_health" == healthy ]] && break
  [[ "$api_health" == unhealthy ]] && die 'smoke API became unhealthy'
  sleep 2
done
[[ "$api_health" == healthy ]] || die 'smoke API did not become healthy'
[[ "$(docker inspect -f '{{.Config.User}}' "$api_container")" == node ]] ||
  die 'API runtime is not the non-root node user'

compose exec -T db psql \
  --username=plenka_owner \
  --dbname=plenka_smoke \
  --set=ON_ERROR_STOP=1 \
  --command='CREATE TABLE smoke_persistence (id integer PRIMARY KEY); GRANT SELECT, INSERT, UPDATE, DELETE ON smoke_persistence TO plenka_app;' >/dev/null

compose exec -T db psql \
  --username=plenka_app \
  --dbname=plenka_smoke \
  --set=ON_ERROR_STOP=1 \
  --command='INSERT INTO smoke_persistence VALUES (1);' >/dev/null

if compose exec -T db psql \
  --username=plenka_app \
  --dbname=plenka_smoke \
  --set=ON_ERROR_STOP=1 \
  --command='CREATE TABLE runtime_role_must_not_create_schema (id integer);' >/dev/null 2>&1; then
  die 'runtime database role unexpectedly owns schema DDL privileges'
fi
runtime_role_flags="$(compose exec -T db psql \
  --username=plenka_admin \
  --dbname=postgres \
  --tuples-only \
  --no-align \
  --command="SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = 'plenka_app';")"
[[ "$runtime_role_flags" =~ ^[[:space:]]*f[[:space:]]*$ ]] ||
  die 'runtime database role has administrative privileges'

compose restart db >/dev/null
db_container="$(compose ps -q db)"
for _ in $(seq 1 30); do
  db_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$db_container")"
  [[ "$db_health" == healthy ]] && break
  sleep 2
done
[[ "$db_health" == healthy ]] || die 'database did not recover after restart'
marker="$(compose exec -T db psql \
  --username=plenka_app \
  --dbname=plenka_smoke \
  --tuples-only \
  --no-align \
  --command='SELECT id FROM smoke_persistence;')"
[[ "$marker" =~ ^[[:space:]]*1[[:space:]]*$ ]] || die 'database volume did not preserve data'

"$SCRIPT_DIR/backup.sh" --check >/dev/null
restore_leftovers="$(compose exec -T db psql \
  --username=plenka_app \
  --dbname=postgres \
  --tuples-only \
  --no-align \
  --command="SELECT count(*) FROM pg_database WHERE datname LIKE 'plenka_restore_check_%';")"
[[ "$restore_leftovers" =~ ^[[:space:]]*0[[:space:]]*$ ]] ||
  die 'restore check left a disposable database behind'
printf 'Local Compose smoke: PASS (web/TLS smoke remains pending until the frontend image is merged)\n'
