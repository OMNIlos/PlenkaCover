#!/usr/bin/env bash
set -Eeuo pipefail

LOCAL_SMOKE=false
if [[ "${1:-}" == '--local-smoke' ]]; then
  LOCAL_SMOKE=true
  shift
fi
if [[ $# -gt 1 ]]; then
  printf 'Environment validation: FAIL (usage: validate-env.sh [--local-smoke] [ENV_FILE])\n' >&2
  exit 1
fi

ENV_FILE="${1:-${PLENKA_ENV_FILE:-/opt/plenka/shared/pilot.env}}"

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Environment validation: FAIL (file is missing)\n' >&2
  exit 1
fi
if [[ ! -r "$ENV_FILE" ]]; then
  printf 'Environment validation: FAIL (file is not readable)\n' >&2
  exit 1
fi

file_mode=''
if file_mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null)"; then
  :
elif file_mode="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null)"; then
  :
fi
case "$file_mode" in
  400 | 600) ;;
  *)
    printf 'Environment validation: FAIL (file mode must be 0400 or 0600)\n' >&2
    exit 1
    ;;
esac

case "$ENV_FILE" in
  /opt/plenka/*)
    file_uid=''
    if file_uid="$(stat -c '%u' "$ENV_FILE" 2>/dev/null)"; then
      :
    elif file_uid="$(stat -f '%u' "$ENV_FILE" 2>/dev/null)"; then
      :
    fi
    if [[ "$file_uid" != 0 ]]; then
      printf 'Environment validation: FAIL (deployment file must be owned by root)\n' >&2
      exit 1
    fi
    ;;
esac

APPROVED_BACKUP_DIR='/opt/plenka/backups'
if [[ "$LOCAL_SMOKE" == true ]]; then
  environment_directory="$(cd "$(dirname "$ENV_FILE")" && pwd -L)"
  environment_directory_physical="$(cd "$(dirname "$ENV_FILE")" && pwd -P)"
  temporary_root="$(cd "${TMPDIR:-/tmp}" && pwd -L)"
  temporary_root_physical="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  case "$environment_directory:$environment_directory_physical" in
    "$temporary_root"/plenka-vps-smoke.*:"$temporary_root_physical"/plenka-vps-smoke.*) ;;
    *)
      printf 'Environment validation: FAIL (local smoke file is outside its temporary root)\n' >&2
      exit 1
      ;;
  esac
  APPROVED_BACKUP_DIR="$environment_directory/backups"
fi

awk -v approved_backup_dir="$APPROVED_BACKUP_DIR" '
  function fail(message) {
    print "Environment validation: FAIL (" message ")" > "/dev/stderr"
    failed = 1
    exit 1
  }
  function require_key(key) {
    if (!(key in values) || values[key] == "") fail("missing key " key)
    if (tolower(values[key]) ~ /replace-me/) fail("sentinel value for " key)
  }
  function require_exact(key, expected) {
    require_key(key)
    if (values[key] != expected) fail("invalid value for " key)
  }
  function reject_key(key) {
    if (key in values) fail("forbidden key " key)
  }
  function require_integer(key, minimum, maximum, number) {
    require_key(key)
    if (values[key] !~ /^[0-9]+$/) fail("invalid integer for " key)
    number = values[key] + 0
    if (number < minimum || number > maximum) fail("out-of-range integer for " key)
  }
  function require_decimal_integer(key, minimum, maximum, number) {
    require_key(key)
    if (values[key] !~ /^(0|[1-9][0-9]*)$/) fail("invalid decimal integer for " key)
    number = values[key] + 0
    if (number < minimum || number > maximum) fail("out-of-range integer for " key)
  }
  function valid_role_name(value) {
    return length(value) >= 3 && length(value) <= 32 && value ~ /^[a-z][a-z0-9_]*$/
  }
  function valid_ipv4(value, parts, count, i) {
    count = split(value, parts, ".")
    if (count != 4) return 0
    for (i = 1; i <= count; i++) {
      if (parts[i] !~ /^[0-9]+$/ || length(parts[i]) > 3 || parts[i] + 0 > 255) return 0
      if (length(parts[i]) > 1 && substr(parts[i], 1, 1) == "0") return 0
    }
    return 1
  }
  function valid_dns(value, labels, count, i, label) {
    if (length(value) < 3 || length(value) > 253) return 0
    count = split(value, labels, ".")
    if (count < 2) return 0
    for (i = 1; i <= count; i++) {
      label = labels[i]
      if (length(label) < 1 || length(label) > 63) return 0
      if (label !~ /^[a-z0-9][a-z0-9-]*[a-z0-9]$/ && label !~ /^[a-z0-9]$/) {
        return 0
      }
    }
    return 1
  }
  function valid_email(value, at, local_part, domain) {
    at = index(value, "@")
    if (at < 2 || index(substr(value, at + 1), "@")) return 0
    local_part = substr(value, 1, at - 1)
    domain = substr(value, at + 1)
    return length(local_part) <= 64 && local_part ~ /^[A-Za-z0-9._%+-]+$/ && valid_dns(domain)
  }
  function is_numeric_ipv4_notation(value, parts, count, i) {
    count = split(value, parts, ".")
    if (count < 1 || count > 4) return 0
    for (i = 1; i <= count; i++) {
      if (parts[i] !~ /^[0-9]+$/ && parts[i] !~ /^0[xX][0-9a-fA-F]+$/) return 0
    }
    return 1
  }
  function is_public_ipv4(parts, first, second, third) {
    # IANA special-purpose ranges cannot identify the public ACME endpoint.
    first = parts[1] + 0
    second = parts[2] + 0
    third = parts[3] + 0
    if (first == 0 || first == 10 || first == 127 || first >= 224) return 0
    if (first == 100 && second >= 64 && second <= 127) return 0
    if (first == 169 && second == 254) return 0
    if (first == 172 && second >= 16 && second <= 31) return 0
    if (first == 192 && second == 0 && (third == 0 || third == 2)) return 0
    if (first == 192 && second == 31 && third == 196) return 0
    if (first == 192 && second == 52 && third == 193) return 0
    if (first == 192 && second == 88 && third == 99) return 0
    if (first == 192 && second == 168) return 0
    if (first == 192 && second == 175 && third == 48) return 0
    if (first == 198 && (second == 18 || second == 19)) return 0
    if (first == 198 && second == 51 && third == 100) return 0
    if (first == 203 && second == 0 && third == 113) return 0
    return 1
  }
  function has_dns_suffix(value, suffix, start) {
    if (value == suffix) return 1
    start = length(value) - length(suffix) + 1
    return start > 1 && substr(value, start - 1, 1) == "." && substr(value, start) == suffix
  }
  function valid_public_dns(value, labels, count, final_label, i) {
    if (!valid_dns(value)) return 0
    count = split(value, labels, ".")
    final_label = labels[count]
    if (final_label !~ /^[a-z]/) return 0
    for (i = 1; i <= count; i++) if (labels[i] ~ /^xn--/) return 0
    if (has_dns_suffix(value, "localhost") || has_dns_suffix(value, "test") ||
        has_dns_suffix(value, "invalid") || has_dns_suffix(value, "example") ||
        has_dns_suffix(value, "local") || has_dns_suffix(value, "onion") ||
        has_dns_suffix(value, "internal") || has_dns_suffix(value, "alt") ||
        has_dns_suffix(value, "arpa") ||
        has_dns_suffix(value, "home.arpa") || has_dns_suffix(value, "example.com") ||
        has_dns_suffix(value, "example.net") || has_dns_suffix(value, "example.org")) return 0
    return 1
  }
  function valid_public_host(value, ipv4_parts) {
    if (valid_ipv4(value, ipv4_parts)) return is_public_ipv4(ipv4_parts)
    if (is_numeric_ipv4_notation(value)) return 0
    return valid_public_dns(value)
  }
  function shannon_entropy(value, counts, size, i, symbol, probability, entropy) {
    size = length(value)
    for (i = 1; i <= size; i++) counts[substr(value, i, 1)]++
    entropy = 0
    for (symbol in counts) {
      probability = counts[symbol] / size
      entropy -= probability * log(probability) / log(2)
    }
    return entropy
  }
  function has_exact_repeated_block(value, size, block_size, block, offset, repeated) {
    size = length(value)
    for (block_size = 1; block_size <= size / 2; block_size++) {
      if (size % block_size != 0) continue
      block = substr(value, 1, block_size)
      repeated = 1
      for (offset = block_size + 1; offset <= size; offset += block_size) {
        if (substr(value, offset, block_size) != block) {
          repeated = 0
          break
        }
      }
      if (repeated) return 1
    }
    return 0
  }
  function valid_pilot_agent_token(token, payload, size, remainder, final_value) {
    if (substr(token, 1, 4) != "ptk_") return 0
    payload = substr(token, 5)
    if (!payload || payload !~ /^[A-Za-z0-9_-]+$/) return 0

    size = length(payload)
    remainder = size % 4
    if (remainder == 1 || int(size * 6 / 8) < 32) return 0
    final_value = index("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", substr(payload, size, 1)) - 1
    if ((remainder == 2 && final_value % 16 != 0) ||
        (remainder == 3 && final_value % 4 != 0)) return 0
    if (shannon_entropy(payload) < 3.5 || has_exact_repeated_block(payload)) return 0
    return 1
  }
  function valid_image(value, at, colon, i, repository, tag, digest) {
    at = index(value, "@sha256:")
    if (at) {
      repository = substr(value, 1, at - 1)
      digest = substr(value, at + 8)
      if (length(digest) != 64 || digest !~ /^[a-f0-9]+$/) return 0
    } else {
      colon = 0
      for (i = length(value); i > 0; i--) {
        if (substr(value, i, 1) == ":") { colon = i; break }
      }
      if (!colon) return 0
      repository = substr(value, 1, colon - 1)
      tag = substr(value, colon + 1)
      if (length(tag) < 7 || length(tag) > 64 || tag !~ /^[a-f0-9]+$/) return 0
    }
    if (length(repository) < 1 || length(repository) > 200) return 0
    if (repository !~ /^[a-z0-9][-a-z0-9._\/]*[a-z0-9]$/ && repository !~ /^[a-z0-9]$/) return 0
    if (repository ~ /\/\// || repository ~ /\.\./) return 0
    return 1
  }
  /^[[:space:]]*(#|$)/ { next }
  {
    line = $0
    sub(/\r$/, "", line)
    separator = index(line, "=")
    if (separator == 0) fail("malformed line " NR)
    key = substr(line, 1, separator - 1)
    value = substr(line, separator + 1)
    if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/) fail("invalid key on line " NR)
    if (key in values) fail("duplicate key " key)
    if (value ~ /[[:space:]]/ || index(value, "$") || index(value, "\\") ||
        index(value, "{") || index(value, "}") || index(value, "`") ||
        index(value, "\"") || index(value, "\047") || index(value, ";") ||
        index(value, "&") || index(value, "<") || index(value, ">")) {
      fail("unsafe value grammar for " key)
    }
    values[key] = value
  }
  END {
    if (failed) exit 1

    split("COMPOSE_PROJECT_NAME PLENKA_API_IMAGE PLENKA_MIGRATION_IMAGE PLENKA_WEB_IMAGE PUBLIC_HOST PUBLIC_ORIGIN ACME_EMAIL POSTGRES_ADMIN_USER POSTGRES_ADMIN_PASSWORD DATABASE_OWNER_USER DATABASE_OWNER_PASSWORD DATABASE_APP_USER DATABASE_APP_PASSWORD POSTGRES_DB MIGRATION_DATABASE_URL DATABASE_URL BACKUP_DIR ONEC_FINANCE_SYNC_ENABLED ONEC_FINANCE_SYNC_INTERVAL_MS ONEC_PAYMENT_SYNC_ENABLED ONEC_PAYMENT_AUTO_APPLY_ENABLED ONEC_SYNC_ENABLED ONEC_SYNC_INTERVAL_MS ONEC_SYNC_PAGE_SIZE PALLET_LABEL_PROFILE WAREHOUSE_COVERAGE_V2_ENABLED PILOT_SHORT_PASSWORDS_ENABLED PRODUCTION_COST_RECONCILER_ENABLED", required)
    for (i in required) require_key(required[i])

    require_exact("APP_ENV", "pilot")
    require_exact("NODE_ENV", "production")
    require_exact("AUTH_DEV_XROLE", "off")
    require_exact("GATEWAY_SIMULATOR", "off")
    require_exact("SEED_PROFILE", "pilot")
    if (values["PALLET_LABEL_PROFILE"] !~ /^(pallet-100x150-v1|pallet-100x150-compact-v2|pallet-100x100-square-v4|pallet-100x100-safe-v5|pallet-100x100-extended-v6)$/) {
      fail("invalid PALLET_LABEL_PROFILE")
    }
    if (values["WAREHOUSE_COVERAGE_V2_ENABLED"] !~ /^(false|true)$/) {
      fail("invalid WAREHOUSE_COVERAGE_V2_ENABLED")
    }
    if (values["PILOT_SHORT_PASSWORDS_ENABLED"] !~ /^(false|true)$/) {
      fail("invalid PILOT_SHORT_PASSWORDS_ENABLED")
    }
    require_exact("PRODUCTION_COST_RECONCILER_ENABLED", "true")

    require_exact("ONEC_LIVE", "false")
    require_exact("ONEC_WRITE", "false")
    require_exact("ONEC_SYNC_ENABLED", "false")
    require_exact("ONEC_FINANCE_SYNC_ENABLED", "false")
    require_exact("ONEC_PAYMENT_SYNC_ENABLED", "false")
    require_exact("ONEC_PAYMENT_AUTO_APPLY_ENABLED", "false")
    split("ONEC_BASE_URL ONEC_USERNAME ONEC_PASSWORD ONEC_WRITE_CONFIRM ONEC_INVOICE_ORDER_REFERENCE_FIELD ONEC_ORG_KEY ONEC_WAREHOUSE_KEY ONEC_GOODS_ACCOUNT_KEY ONEC_STOCK_NOMENCLATURE", forbidden_onec)
    for (i in forbidden_onec) reject_key(forbidden_onec[i])
    if (values["DEVICE_GATEWAY_SCALE"] !~ /^(on|off)$/) fail("invalid DEVICE_GATEWAY_SCALE")
    if (values["DEVICE_GATEWAY_PRINTER"] !~ /^(on|off)$/) fail("invalid DEVICE_GATEWAY_PRINTER")

    require_exact("PORT", "3000")
    require_integer("SESSION_TTL", 300, 604800)
    require_integer("PASSWORD_SETUP_TTL", 300, 3600)
    require_integer("LOGIN_RATE_MAX", 1, 100)
    require_integer("LOGIN_RATE_MAX_KEYS", 100, 100000)
    require_integer("LOGIN_RATE_WINDOW_MS", 1000, 3600000)
    require_integer("GATEWAY_COMMAND_TIMEOUT_MS", 100, 120000)
    require_integer("ONEC_TIMEOUT_MS", 100, 120000)
    require_integer("ONEC_FINANCE_SYNC_INTERVAL_MS", 60000, 86400000)
    require_integer("ONEC_SYNC_INTERVAL_MS", 60000, 86400000)
    require_integer("ONEC_SYNC_PAGE_SIZE", 50, 500)
    require_decimal_integer("BACKUP_RETENTION_COUNT", 1, 365)
    require_integer("BACKUP_RETENTION_DAYS", 1, 3650)

    if (!valid_public_host(values["PUBLIC_HOST"])) fail("invalid PUBLIC_HOST")
    if (values["PUBLIC_ORIGIN"] != "https://" values["PUBLIC_HOST"]) {
      fail("PUBLIC_ORIGIN does not match PUBLIC_HOST")
    }
    if (!valid_email(values["ACME_EMAIL"])) fail("invalid ACME_EMAIL")
    if (values["COMPOSE_PROJECT_NAME"] !~ /^[a-z0-9][a-z0-9_-]*$/ ||
        length(values["COMPOSE_PROJECT_NAME"]) > 63) fail("invalid COMPOSE_PROJECT_NAME")
    if (!valid_role_name(values["POSTGRES_ADMIN_USER"])) fail("invalid POSTGRES_ADMIN_USER")
    if (!valid_role_name(values["DATABASE_OWNER_USER"])) fail("invalid DATABASE_OWNER_USER")
    if (!valid_role_name(values["DATABASE_APP_USER"])) fail("invalid DATABASE_APP_USER")
    if (values["POSTGRES_ADMIN_USER"] == values["DATABASE_OWNER_USER"] ||
        values["POSTGRES_ADMIN_USER"] == values["DATABASE_APP_USER"] ||
        values["DATABASE_OWNER_USER"] == values["DATABASE_APP_USER"]) fail("database roles must be distinct")
    if (values["POSTGRES_DB"] !~ /^[a-z][a-z0-9_]{2,62}$/ ||
        values["POSTGRES_DB"] ~ /^(postgres|template0|template1)$/) fail("invalid POSTGRES_DB")
    split("POSTGRES_ADMIN_PASSWORD DATABASE_OWNER_PASSWORD DATABASE_APP_PASSWORD", database_passwords)
    for (i in database_passwords) {
      key = database_passwords[i]
      if (values[key] !~ /^[A-Za-z0-9_-]+$/ || length(values[key]) < 24) fail("weak database password " key)
    }
    expected_url = "postgresql://" values["DATABASE_APP_USER"] ":" values["DATABASE_APP_PASSWORD"] "@db:5432/" values["POSTGRES_DB"] "?schema=public"
    if (values["DATABASE_URL"] != expected_url) fail("DATABASE_URL does not match runtime database role")
    expected_url = "postgresql://" values["DATABASE_OWNER_USER"] ":" values["DATABASE_OWNER_PASSWORD"] "@db:5432/" values["POSTGRES_DB"] "?schema=public"
    if (values["MIGRATION_DATABASE_URL"] != expected_url) fail("MIGRATION_DATABASE_URL does not match owner role")
    if (values["BACKUP_DIR"] != approved_backup_dir ||
        values["BACKUP_DIR"] !~ /^\/[-A-Za-z0-9._\/]+$/ ||
        values["BACKUP_DIR"] ~ /\/\.\.?(\/|$)/ || values["BACKUP_DIR"] ~ /\/\//) {
      fail("invalid BACKUP_DIR")
    }

    split("PLENKA_API_IMAGE PLENKA_MIGRATION_IMAGE PLENKA_WEB_IMAGE", images)
    for (i in images) {
      image = values[images[i]]
      if (!valid_image(image)) fail("image must use an immutable release reference")
    }

    split("SEED_PILOT_PASSWORD_COMMERCIAL SEED_PILOT_PASSWORD_PRODUCTION SEED_PILOT_PASSWORD_OPERATOR SEED_PILOT_PASSWORD_OPERATOR_2 SEED_PILOT_PASSWORD_OPERATOR_3 SEED_PILOT_PASSWORD_WAREHOUSE SEED_PILOT_PASSWORD_FINANCE SEED_PILOT_PASSWORD_DIRECTOR SEED_PILOT_PASSWORD_ADMIN", passwords)
    split("SEED_PILOT_AGENT_TOKEN_POST_1 SEED_PILOT_AGENT_TOKEN_POST_2 SEED_PILOT_AGENT_TOKEN_POST_3 SEED_PILOT_AGENT_TOKEN_POST_4 SEED_PILOT_AGENT_TOKEN_POST_5", tokens)
    delete secret_owner
    for (i in database_passwords) {
      key = database_passwords[i]
      if (values[key] in secret_owner) fail("shared database secret " key)
      secret_owner[values[key]] = key
    }
    for (i in passwords) {
      key = passwords[i]
      require_key(key)
      secret = values[key]
      if (values["PILOT_SHORT_PASSWORDS_ENABLED"] == "true") {
        if (secret !~ /^[0-9]{4}$/) fail("invalid pilot PIN " key)
      } else if (length(secret) < 16 || length(secret) > 128 ||
                 secret !~ /^[A-Za-z0-9_-]+$/ ||
                 tolower(secret) ~ /^plenka-(dev|demo)/) {
        fail("invalid password " key)
      }
      if (secret in secret_owner) fail("shared bootstrap secret " key)
      secret_owner[secret] = key
    }
    for (i in tokens) {
      key = tokens[i]
      require_key(key)
      secret = values[key]
      if (!valid_pilot_agent_token(secret)) fail("invalid agent token " key)
      if (secret in secret_owner) fail("shared bootstrap secret " key)
      secret_owner[secret] = key
    }
  }
' "$ENV_FILE"

[[ ! -L "$APPROVED_BACKUP_DIR" ]] || {
  printf 'Environment validation: FAIL (backup path escapes through a symlink)\n' >&2
  exit 1
}
if [[ -e "$APPROVED_BACKUP_DIR" && ! -d "$APPROVED_BACKUP_DIR" ]]; then
  printf 'Environment validation: FAIL (backup path is not a directory)\n' >&2
  exit 1
fi
if [[ "$LOCAL_SMOKE" != true ]]; then
  backup_probe="$APPROVED_BACKUP_DIR"
  while [[ ! -e "$backup_probe" && ! -L "$backup_probe" ]]; do
    parent="$(dirname "$backup_probe")"
    [[ "$parent" != "$backup_probe" ]] || break
    backup_probe="$parent"
  done
  [[ ! -L "$backup_probe" && -d "$backup_probe" ]] || {
    printf 'Environment validation: FAIL (backup path has an unsafe ancestor)\n' >&2
    exit 1
  }
  resolved_backup_probe="$(cd "$backup_probe" && pwd -P)"
  [[ "$resolved_backup_probe" == "$backup_probe" ]] || {
    printf 'Environment validation: FAIL (backup path escapes through a symlink)\n' >&2
    exit 1
  }
fi

printf 'Environment validation: PASS\n'
