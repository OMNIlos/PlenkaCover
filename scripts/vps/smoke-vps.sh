#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

validate_environment
ensure_runtime
require_command curl
require_command jq

origin="$(env_value PUBLIC_ORIGIN)"
readonly -a pilot_accounts=(
  'коммерция|SEED_PILOT_PASSWORD_COMMERCIAL|commercial'
  'производство|SEED_PILOT_PASSWORD_PRODUCTION|production_lead'
  'ахметов булат|SEED_PILOT_PASSWORD_OPERATOR|operator'
  'хабибулин руслан|SEED_PILOT_PASSWORD_OPERATOR_2|operator'
  'гайнулин ильназ|SEED_PILOT_PASSWORD_OPERATOR_3|operator'
  'склад|SEED_PILOT_PASSWORD_WAREHOUSE|warehouse'
  'бухгалтерия|SEED_PILOT_PASSWORD_FINANCE|finance'
  'директор|SEED_PILOT_PASSWORD_DIRECTOR|director'
  'админ|SEED_PILOT_PASSWORD_ADMIN|admin'
)
[[ "${#pilot_accounts[@]}" -eq 9 ]] || die 'pilot account smoke must contain exactly nine accounts'

response_file="$(mktemp)"
token=''
cleanup() {
  if [[ -n "${token:-}" ]]; then
    curl --silent \
      --output /dev/null \
      --request POST \
      --header "Authorization: Bearer $token" \
      "$origin/api/auth/logout" >/dev/null 2>&1 || true
    token=''
  fi
  rm -f -- "$response_file"
}
trap cleanup EXIT INT TERM

assert_no_host_bindings() {
  local service="$1"
  local container_id=''
  local host_binding_markers=''
  local host_binding_count=0

  if ! container_id="$(compose ps --status running -q "$service" 2>/dev/null)"; then
    die "could not resolve the running $service container"
  fi
  [[ -n "$container_id" ]] || die "$service container is not running"
  [[ "$container_id" != *$'\n'* ]] || die "$service resolved to multiple running containers"

  if ! host_binding_markers="$(
    docker inspect \
      --format '{{range $bindings := .NetworkSettings.Ports}}{{range $bindings}}x{{end}}{{end}}' \
      "$container_id" 2>/dev/null
  )"; then
    die "could not inspect $service port bindings"
  fi
  host_binding_count="${#host_binding_markers}"
  [[ "$host_binding_count" -eq 0 ]] || die "$service has a published host port"
}

assert_login_response() {
  local account_number="$1"
  local expected_role="$2"

  jq --exit-status \
    --arg expected_role "$expected_role" \
    '(.token | type == "string" and test("^[0-9a-f]{64}$")) and
      (.passwordChangeRequired == false) and
      (.user | type == "object") and
      (.user.role == $expected_role)' \
    "$response_file" >/dev/null ||
    die "pilot account $account_number login response is invalid"
}

assert_identity_response() {
  local account_number="$1"
  local expected_role="$2"

  jq --exit-status \
    --arg expected_role "$expected_role" \
    '(.role == $expected_role) and (.passwordChangeRequired == false)' \
    "$response_file" >/dev/null ||
    die "pilot account $account_number identity response is invalid"
}

curl --fail --silent --show-error --output /dev/null "$origin/api/health"
curl --fail --silent --show-error --output /dev/null "$origin/api/health/ready"

account_number=0
for account_spec in "${pilot_accounts[@]}"; do
  account_number=$((account_number + 1))
  IFS='|' read -r login password_key expected_role <<<"$account_spec"
  [[ -n "$login" && -n "$password_key" && -n "$expected_role" ]] ||
    die "pilot account $account_number manifest entry is invalid"
  password="$(env_value "$password_key")"

  status_code="$(
    printf '{"login":"%s","password":"%s"}' "$login" "$password" |
      curl --silent --show-error \
        --output "$response_file" \
        --write-out '%{http_code}' \
        --header 'Content-Type: application/json' \
        --data-binary @- \
        "$origin/api/auth/login"
  )"
  [[ "$status_code" == 200 || "$status_code" == 201 ]] ||
    die "pilot account $account_number login failed"

  token="$(jq --exit-status --raw-output '.token' "$response_file")" ||
    die "pilot account $account_number login response omitted a valid session token"
  [[ "$token" =~ ^[0-9a-f]{64}$ && "$token" != *$'\n'* ]] ||
    die "pilot account $account_number login response omitted a valid session token"
  assert_login_response "$account_number" "$expected_role"

  status_code="$(
    curl --silent --show-error \
      --output "$response_file" \
      --write-out '%{http_code}' \
      --header "Authorization: Bearer $token" \
      "$origin/api/auth/me"
  )"
  [[ "$status_code" == 200 ]] || die "pilot account $account_number identity check failed"
  assert_identity_response "$account_number" "$expected_role"

  status_code="$(
    curl --silent --show-error \
      --output "$response_file" \
      --write-out '%{http_code}' \
      --request POST \
      --header "Authorization: Bearer $token" \
      "$origin/api/auth/logout"
  )"
  [[ "$status_code" == 200 || "$status_code" == 201 ]] ||
    die "pilot account $account_number session cleanup failed"
  token=''
  password=''
done

assert_no_host_bindings api
assert_no_host_bindings db
compose ps --status running >/dev/null
printf '%s\n' \
  'VPS identity smoke: PARTIAL (HTTPS, readiness, private bindings and 9 canonical pilot accounts; browser acceptance checklist is still required)'
