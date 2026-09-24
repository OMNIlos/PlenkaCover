#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

[[ $# -eq 2 && "$1" == --confirm && "$2" == RESET_PILOT_DEMO_DATA ]] ||
  die 'usage: reset-pilot-demo.sh --confirm RESET_PILOT_DEMO_DATA'

validate_environment
ensure_runtime
[[ "$(env_value APP_ENV)" == pilot && "$(env_value SEED_PROFILE)" == pilot ]] ||
  die 'demo reset is available only for the pilot environment and seed profile'
[[ "${PILOT_GATEWAYS_STOPPED:-}" == yes ]] ||
  die 'stop every POST gateway and archive its offline queue, then set PILOT_GATEWAYS_STOPPED=yes'

backup_dir="$(env_value BACKUP_DIR)"
database_name="$(env_value POSTGRES_DB)"
owner_user="$(env_value DATABASE_OWNER_USER)"
prepare_backup_directory "$backup_dir"
require_command flock
exec 9>"$backup_dir/.maintenance.lock"
flock -n 9 || die 'backup, restore or pilot reset is already running'

[[ -n "$(compose ps --status running -q api)" ]] ||
  die 'api must be running before the maintenance window'
[[ -n "$(compose ps --status running -q web)" ]] ||
  die 'web must be running before the maintenance window'

services_stopped=false
reset_committed=false
validation_passed=false
cleanup() {
  local status=$?
  local restart_status=0
  trap - EXIT HUP INT TERM
  if [[ "$services_stopped" == true ]]; then
    if [[ "$reset_committed" == true && "$validation_passed" != true ]]; then
      printf '%s\n' \
        'ERROR: reset committed but validation failed; leave api/web stopped for restore or diagnosis' >&2
    else
      compose up -d --wait api web >/dev/null || restart_status=$?
    fi
  fi
  (( restart_status == 0 )) || status=1
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

compose stop api web >/dev/null
services_stopped=true
[[ -z "$(compose ps --status running -q api)" ]] || die 'api did not stop'
[[ -z "$(compose ps --status running -q web)" ]] || die 'web did not stop'

backup_output="$(
  PLENKA_MAINTENANCE_LOCK_HELD=1 \
    "$SCRIPT_DIR/backup.sh" --check --lock-held
)"
backup_artifact="$(printf '%s\n' "$backup_output" | tail -n 1)"
unset backup_output
backup_name="$(basename -- "$backup_artifact")"
[[ "$(dirname -- "$backup_artifact")" == "$backup_dir" ]] ||
  die 'checked backup path is outside BACKUP_DIR'
[[ "$backup_name" =~ ^plenka-[0-9]{8}T[0-9]{6}Z\.dump$ ]] ||
  die 'checked backup path is not a canonical artifact'
for backup_part in "$backup_artifact" "$backup_artifact.sha256" "$backup_artifact.complete"; do
  [[ -f "$backup_part" && ! -L "$backup_part" ]] ||
    die 'checked backup generation is incomplete or unsafe'
done

compose --profile maintenance run --rm \
  -e PILOT_DEMO_RESET_CONFIRM=RESET_PILOT_DEMO_DATA \
  reset-pilot-demo
reset_committed=true

counts="$(
  compose exec -T db psql \
    --username="$owner_user" \
    --dbname="$database_name" \
    --no-align \
    --tuples-only \
    --set=ON_ERROR_STOP=1 <<'SQL'
SELECT 'commercial_orders=' || count(*) FROM commercial_orders;
SELECT 'demo_orders=' || count(*) FROM commercial_orders WHERE "orderNumber" = 'DEMO-001';
SELECT 'commercial_order_positions=' || count(*) FROM commercial_order_positions;
SELECT 'demo_position_roll_count=' || COALESCE(sum(position."rollCount"), 0)
  FROM commercial_order_positions AS position
  JOIN commercial_orders AS orders ON orders.id = position."orderId"
  WHERE orders."orderNumber" = 'DEMO-001';
SELECT 'production_orders=' || count(*) FROM production_orders;
SELECT 'roll_dispatch_items=' || count(*) FROM roll_dispatch_items;
SELECT 'operator_roll_lines=' || count(*) FROM operator_roll_lines;
SELECT 'shifts=' || count(*) FROM shifts;
SELECT 'operator_assignments=' || count(*) FROM operator_shift_machine_assignments;
SELECT 'active_operator_sessions=' || count(*)
  FROM operator_post_sessions
  WHERE status = 'active';
SELECT 'operator_test_rolls=' || count(*)
  FROM roll_dispatch_items AS dispatch
  JOIN operator_roll_lines AS line
    ON line."rollDispatchItemId" = dispatch.id
  JOIN users AS operator
    ON operator.id = dispatch."assignedOperatorId"
  JOIN posts AS post
    ON post.id = dispatch."postId"
  JOIN shifts AS shift
    ON shift.id = dispatch."plannedShiftId"
  JOIN operator_shift_machine_assignments AS assignment
    ON assignment."shiftId" = shift.id
    AND assignment."operatorId" = operator.id
    AND assignment."postId" = post.id
  WHERE dispatch."rollCode" = 'DEMO-001-roll-1'
    AND dispatch.status = 'assigned'
    AND dispatch."machineId" = 'POST-1'
    AND line.step = 'assigned'
    AND operator."externalId" = 'seed-operator-2'
    AND operator."displayName" = 'Хабибулин Руслан'
    AND operator.role = 'operator'
    AND operator."isActive" = true
    AND post.code = 'POST-1'
    AND post.status = 'active'
    AND shift.status = 'planned'
    AND assignment.status = 'planned';
SELECT 'finance_orders=' || count(*) FROM finance_orders;
SELECT 'counterparty_templates=' || count(*) FROM counterparty_order_templates;
SELECT 'canonical_counterparty_templates=' || count(*)
  FROM counterparty_order_templates
  WHERE status = 'active'
    AND id IN ('tpl-uralpak-sleeve-80', 'tpl-uralpak-sleeve-60');
SELECT 'counterparty_template_versions=' || count(*)
  FROM counterparty_order_template_versions;
SELECT 'stock_templates=' || count(*) FROM stock_production_templates;
SELECT 'canonical_stock_templates=' || count(*)
  FROM stock_production_templates
  WHERE status = 'active' AND id = 'stock-template-primary-80';
SELECT 'stock_template_versions=' || count(*) FROM stock_production_template_versions;
SELECT 'invalid_template_dimensions=' || count(*)
FROM (
  SELECT jsonb_array_elements(positions) AS position FROM counterparty_order_templates
  UNION ALL
  SELECT jsonb_array_elements(positions) AS position FROM counterparty_order_template_versions
  UNION ALL
  SELECT jsonb_array_elements(positions) AS position FROM stock_production_templates
  UNION ALL
  SELECT jsonb_array_elements(positions) AS position FROM stock_production_template_versions
) AS template_positions
WHERE NOT jsonb_path_exists(
  position,
  '$ ? (@.widthMm.type() == "number" && @.widthMm > 0 && @.plannedLengthM.type() == "number" && @.plannedLengthM > 0)'
);
SELECT 'production_problems=' || count(*) FROM production_problems;
SELECT 'operational_incidents=' || count(*) FROM operational_incidents;
SELECT 'notification_receipts=' || count(*) FROM notification_receipts;
SELECT 'big_bag_units=' || count(*) FROM big_bag_units;
SELECT 'big_bag_scan_tokens=' || count(*) FROM big_bag_scan_tokens;
SELECT 'big_bag_movements=' || count(*) FROM big_bag_movements;
SELECT 'big_bag_label_print_jobs=' || count(*) FROM big_bag_label_print_jobs;
SELECT 'sessions=' || count(*) FROM sessions;
SELECT 'gateway_commands=' || count(*) FROM gateway_commands;
SELECT 'gateway_events=' || count(*) FROM gateway_events;
SELECT 'reset_events=' || count(*) FROM domain_events WHERE type = 'audit:pilot_demo_reset';
SELECT 'users=' || count(*) FROM users;
SELECT 'posts=' || count(*) FROM posts;
SELECT 'devices=' || count(*) FROM device_runtimes;
SELECT 'raw_material_stocks=' || count(*) FROM raw_material_stocks;
SQL
)"

for expected in \
  commercial_orders=1 \
  demo_orders=1 \
  commercial_order_positions=1 \
  demo_position_roll_count=1 \
  production_orders=1 \
  roll_dispatch_items=1 \
  operator_roll_lines=1 \
  shifts=1 \
  operator_assignments=1 \
  active_operator_sessions=0 \
  operator_test_rolls=1 \
  finance_orders=1 \
  counterparty_templates=2 \
  canonical_counterparty_templates=2 \
  counterparty_template_versions=2 \
  stock_templates=1 \
  canonical_stock_templates=1 \
  stock_template_versions=1 \
  invalid_template_dimensions=0 \
  production_problems=0 \
  operational_incidents=0 \
  notification_receipts=0 \
  big_bag_units=0 \
  big_bag_scan_tokens=0 \
  big_bag_movements=0 \
  big_bag_label_print_jobs=0 \
  sessions=0 \
  gateway_commands=0 \
  gateway_events=0; do
  printf '%s\n' "$counts" | grep -Fxq "$expected" ||
    die "post-reset invariant failed: $expected"
done

for key in reset_events users posts devices raw_material_stocks; do
  value="$(printf '%s\n' "$counts" | awk -F= -v expected="$key" '$1 == expected { print $2 }')"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 ]] ||
    die "post-reset preserved invariant failed: $key"
done

validation_passed=true
compose up -d --wait api web >/dev/null
services_stopped=false
trap - EXIT HUP INT TERM

printf 'Pilot demo reset: PASS (backup=%s)\n' "$backup_artifact"
