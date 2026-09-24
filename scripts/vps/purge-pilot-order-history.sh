#!/bin/bash -p

if [[ "$-" == *p* && "$EUID" =~ ^[0-9]+$ && "$EUID" == 0 &&
  "$(</proc/self/status)" =~ (^|$'\n')Uid:[[:blank:]]+[0-9]+[[:blank:]]+0[[:blank:]]+[0-9]+[[:blank:]]+[0-9]+($|$'\n') ]]; then
  # Keep every maintenance operation below in this authenticated branch.
  set -Eeuo pipefail
  umask 077

unset BASH_ENV ENV LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH
unset PLENKA_LOCAL_SMOKE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage='usage: purge-pilot-order-history.sh --confirm PURGE_PILOT_ORDER_HISTORY [--include-accumulated-runtime PURGE_ACCUMULATED_RUNTIME]'
delete_accumulated_runtime=false
if [[ $# -eq 2 && "$1" == --confirm && "$2" == PURGE_PILOT_ORDER_HISTORY ]]; then
  :
elif [[ $# -eq 4 && "$1" == --confirm && "$2" == PURGE_PILOT_ORDER_HISTORY &&
  "$3" == --include-accumulated-runtime && "$4" == PURGE_ACCUMULATED_RUNTIME ]]; then
  delete_accumulated_runtime=true
else
  die "$usage"
fi
[[ "${PILOT_GATEWAYS_STOPPED:-}" == yes ]] ||
  die 'stop every physical POST gateway and archive its offline queue, then set PILOT_GATEWAYS_STOPPED=yes'
[[ "${PILOT_OFFHOST_BACKUP_VERIFIED:-}" == yes ]] ||
  die 'the deploy controller must set PILOT_OFFHOST_BACKUP_VERIFIED=yes after off-host checksum and TOC verification'
[[ "${PILOT_OFFHOST_BACKUP_REFERENCE:-}" =~ ^plenka-[0-9]{8}T[0-9]{6}Z[.]dump:[0-9a-f]{64}$ ]] ||
  die 'PILOT_OFFHOST_BACKUP_REFERENCE must be canonical dump-name:sha256 evidence from verified off-host storage'

validate_environment
ensure_runtime
[[ "$(env_value APP_ENV)" == pilot && "$(env_value SEED_PROFILE)" == pilot ]] ||
  die 'order-history purge is available only for the pilot environment and seed profile'

backup_dir="$(env_value BACKUP_DIR)"
database_name="$(env_value POSTGRES_DB)"
owner_user="$(env_value DATABASE_OWNER_USER)"
prepare_backup_directory "$backup_dir"
require_command flock
require_command sha256sum
exec 9>"$backup_dir/.maintenance.lock"
flock -n 9 || die 'backup, restore or pilot maintenance is already running'

[[ -n "$(compose ps --status running -q api)" ]] ||
  die 'api must be running before the maintenance window'
[[ -n "$(compose ps --status running -q web)" ]] ||
  die 'web must be running before the maintenance window'

services_stopped=false
validation_passed=false
backup_artifact=''
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$services_stopped" == true && "$validation_passed" != true ]]; then
    compose stop api web >/dev/null 2>&1 || true
    printf '%s\n' 'ERROR: purge did not reach PASS; leave api/web stopped for diagnosis' >&2
    if [[ -n "$backup_artifact" ]]; then
      printf 'Restore instruction: %q --live %q RESTORE_LIVE_PLENKA\n' \
        "$SCRIPT_DIR/restore.sh" "$backup_artifact" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

compose stop api web >/dev/null
services_stopped=true
[[ -z "$(compose ps --status running -q api)" ]] || die 'api did not stop'
[[ -z "$(compose ps --status running -q web)" ]] || die 'web did not stop'

backup_output="$(
  PLENKA_MAINTENANCE_LOCK_HELD=1 \
    "$SCRIPT_DIR/backup.sh" --check --lock-held --no-retention
)"
backup_artifact="$(printf '%s\n' "$backup_output" | tail -n 1)"
unset backup_output
backup_name="$(basename -- "$backup_artifact")"
[[ "$(dirname -- "$backup_artifact")" == "$backup_dir" ]] ||
  die 'checked backup path is outside BACKUP_DIR'
[[ "$backup_name" =~ ^plenka-[0-9]{8}T[0-9]{6}Z[.]dump$ ]] ||
  die 'checked backup path is not a canonical artifact'
for backup_part in "$backup_artifact" "$backup_artifact.sha256" "$backup_artifact.complete"; do
  [[ -f "$backup_part" && ! -L "$backup_part" ]] ||
    die 'checked backup generation is incomplete or unsafe'
done
[[ "$(wc -l <"$backup_artifact.sha256" | tr -d ' ')" == 1 ]] ||
  die 'checked backup checksum must contain exactly one record'
read -r backup_sha backup_checksum_name backup_checksum_extra <"$backup_artifact.sha256"
[[ "$backup_sha" =~ ^[0-9a-f]{64}$ && "$backup_checksum_name" == "$backup_name" && \
  -z "${backup_checksum_extra:-}" ]] || die 'checked backup checksum is not canonical'
[[ "$(cat "$backup_artifact.complete")" == complete ]] ||
  die 'checked backup completion marker is invalid'
(
  cd "$backup_dir"
  sha256sum --check --status "$backup_name.sha256"
) || die 'checked backup checksum verification failed'

capture_preserved_fingerprints() {
  compose exec -T db psql \
    --username="$owner_user" \
    --dbname="$database_name" \
    --no-align \
    --tuples-only \
    --set=ON_ERROR_STOP=1 <<'SQL'
SELECT 'users=' || md5(COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM users t), '[]'));
SELECT 'migrations=' || md5(COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM _prisma_migrations t), '[]'));
SELECT 'access=' || md5(jsonb_build_object(
  'overrides', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM user_capability_overrides t), '[]'),
  'templates', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM access_templates t), '[]'),
  'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM sessions t), '[]')
)::text);
SELECT 'catalogs=' || md5(jsonb_build_object(
  'counterparties', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM counterparties t), '[]'),
  'counterpartyTemplates', COALESCE((SELECT jsonb_agg(to_jsonb(t) - 'usageCount' - 'lastUsedAt' ORDER BY t.id) FROM counterparty_order_templates t), '[]'),
  'counterpartyTemplateVersions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM counterparty_order_template_versions t), '[]'),
  'stockTemplates', COALESCE((SELECT jsonb_agg(to_jsonb(t) - 'usageCount' - 'lastUsedAt' ORDER BY t.id) FROM stock_production_templates t), '[]'),
  'stockTemplateVersions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM stock_production_template_versions t), '[]'),
  'rawDefinitions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM raw_material_definitions t), '[]'),
  'recipeDefinitions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM recipe_definitions t), '[]'),
  'recipeVersions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM recipe_definition_versions t), '[]'),
  'recipeIngredients', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM recipe_ingredients t), '[]'),
  'materialPrices', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM material_price_references t), '[]'),
  'spoolPrices', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM spool_price_references t), '[]')
)::text);
SELECT 'topology=' || md5(jsonb_build_object(
  'posts', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM posts t), '[]'),
  'devices', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM device_runtimes t), '[]')
)::text);
SELECT 'raw_stock=' || md5(COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM raw_material_stocks t), '[]'));
SELECT 'big_bag_physical=' || md5(jsonb_build_object(
  'units', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM big_bag_units t), '[]'),
  'tokens', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM big_bag_scan_tokens t), '[]'),
  'movements', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM big_bag_movements t), '[]'),
  'labels', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM big_bag_label_print_jobs t), '[]')
)::text);
SELECT 'shift_big_bag=' || md5(jsonb_build_object(
  'usages', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM shift_bag_usages t), '[]'),
  'episodes', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM shift_bag_usage_episodes t), '[]')
)::text);
SELECT 'defect_bag_physical=' || md5(jsonb_build_object(
  'bags', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM defect_bags t), '[]'),
  'tokens', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."defectBagId") FROM defect_bag_scan_tokens t), '[]'),
  'movements', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM defect_bag_movements t), '[]'),
  'labels', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM defect_bag_label_print_jobs t), '[]')
)::text);
SELECT 'spoolMovementPhysical=' || md5(COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'id', t.id, 'rollCode', t."rollCode", 'spoolType', t."spoolType", 'tareKg', t."tareKg",
    'quantity', t.quantity, 'location', t.location, 'returnedByRole', t."returnedByRole",
    'returnedById', t."returnedById", 'createdAt', t."createdAt"
  ) ORDER BY t.id)::text FROM spool_stock_movements t
), '[]'));
SELECT 'shift_physical=' || md5(jsonb_build_object(
  'shifts', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM shifts t), '[]'),
  'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_post_sessions t), '[]'),
  'assignments', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_shift_machine_assignments t), '[]'),
  'changes', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_machine_changes t), '[]'),
  'cancellations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_shift_machine_assignment_cancellation_commands t), '[]'),
  'closures', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM operator_shift_close_commands t), '[]')
)::text);
SELECT 'payroll_tariff_fingerprint=' || md5(jsonb_build_object(
  'orders', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM payroll_tariff_orders t), '[]'),
  'commands', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM payroll_tariff_order_commands t), '[]'),
  'events', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM domain_events t
    WHERE t.type IN (
      'audit:payroll_tariff_order_created', 'audit:payroll_tariff_order_draft_updated',
      'audit:payroll_tariff_order_published'
    )), '[]')
)::text);
SELECT 'onec_reference=' || md5(jsonb_build_object(
  'nomenclature', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_nomenclature_items t), '[]'),
  'organizations', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_organizations t), '[]'),
  'warehouses', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_warehouses t), '[]'),
  'stockBalances', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_stock_balances t), '[]')
)::text);
SELECT 'onec_freshness=' || md5(jsonb_build_object(
  'syncRuns', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_sync_runs t), '[]'),
  'stockPushes', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_stock_push_operations t), '[]'),
  'productionReports', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t."externalId") FROM onec_production_reports t), '[]'),
  'productionOutput', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_production_output_lines t), '[]'),
  'productionMaterials', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM onec_production_material_lines t), '[]'),
  'referenceSnapshots', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM source_snapshots t
    WHERE t."financeOrderId" IS NULL AND t."subjectType" IN (
      'counterparty', 'nomenclature', 'organization', 'warehouse', 'stock', 'production_report'
    )), '[]'),
  'stockImportEvents', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM domain_events t
    WHERE t.type IN ('integration.onec_imported', 'integration.onec_import_failed')
      AND t.label = 'onec_import_stock'), '[]')
)::text);
SELECT 'coverage_epoch=' || md5(COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id)::text FROM warehouse_coverage_inventory_epochs t), '[]'));
SELECT 'active_layout_fingerprint=' || md5(jsonb_build_object(
  'versions', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM pallet_label_layout_versions t), '[]'),
  'commands', COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM pallet_label_layout_publish_commands t), '[]')
)::text);
SQL
}

preserved_fingerprints_for_mode() {
  if [[ "$delete_accumulated_runtime" == true ]]; then
    capture_preserved_fingerprints | grep -Ev \
      '^(shift_big_bag|defect_bag_physical|shift_physical)='
  else
    capture_preserved_fingerprints
  fi
}

before_fingerprints="$(preserved_fingerprints_for_mode)"

maintenance_environment=(
  -e PILOT_ORDER_HISTORY_PURGE_CONFIRM=PURGE_PILOT_ORDER_HISTORY
  -e PILOT_GATEWAYS_STOPPED=yes
)
if [[ "$delete_accumulated_runtime" == true ]]; then
  maintenance_environment+=(
    -e PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRM=PURGE_ACCUMULATED_RUNTIME
  )
fi
compose --profile maintenance run --rm "${maintenance_environment[@]}" purge-pilot-order-history

counts="$(
  compose exec -T db psql \
    --username="$owner_user" \
    --dbname="$database_name" \
    --no-align \
    --tuples-only \
    --set=ON_ERROR_STOP=1 <<'SQL'
SELECT 'order_runtime_rows=' || (
  (SELECT count(*) FROM commercial_finance_note_commands) +
  (SELECT count(*) FROM commercial_order_amendment_commands) +
  (SELECT count(*) FROM commercial_order_positions) +
  (SELECT count(*) FROM commercial_orders) +
  (SELECT count(*) FROM recipe_snapshot_versions) +
  (SELECT count(*) FROM recipe_snapshots) +
  (SELECT count(*) FROM warehouse_cover_matches) +
  (SELECT count(*) FROM warehouse_cover_proposals) +
  (SELECT count(*) FROM production_problems) +
  (SELECT count(*) FROM order_resolution_cases) +
  (SELECT count(*) FROM production_orders) +
  (SELECT count(*) FROM roll_dispatch_items) +
  (SELECT count(*) FROM additional_production_costs) +
  (SELECT count(*) FROM roll_production_cost_snapshots) +
  (SELECT count(*) FROM machine_assignments) +
  (SELECT count(*) FROM operator_roll_lines) +
  (SELECT count(*) FROM weight_captures) +
  (SELECT count(*) FROM defect_records) +
  (SELECT count(*) FROM label_print_jobs) +
  (SELECT count(*) FROM label_print_reconciliations) +
  (SELECT count(*) FROM operator_roll_operations) +
  (SELECT count(*) FROM warehouse_rolls) +
  (SELECT count(*) FROM warehouse_reserve_roll_commands) +
  (SELECT count(*) FROM warehouse_acceptance_tasks) +
  (SELECT count(*) FROM warehouse_roll_coverage_facts) +
  (SELECT count(*) FROM warehouse_coverage_states) +
  (SELECT count(*) FROM warehouse_coverage_calculations) +
  (SELECT count(*) FROM warehouse_coverage_matches) +
  (SELECT count(*) FROM warehouse_coverage_decisions) +
  (SELECT count(*) FROM warehouse_coverage_commands) +
  (SELECT count(*) FROM warehouse_coverage_recheck_memberships) +
  (SELECT count(*) FROM scan_rows) +
  (SELECT count(*) FROM warehouse_pallets) +
  (SELECT count(*) FROM warehouse_pallet_items) +
  (SELECT count(*) FROM warehouse_pallet_commands) +
  (SELECT count(*) FROM pallet_list_documents) +
  (SELECT count(*) FROM pallet_scan_tokens) +
  (SELECT count(*) FROM pallet_print_jobs) +
  (SELECT count(*) FROM pallet_print_reconciliations) +
  (SELECT count(*) FROM roll_scan_tokens) +
  (SELECT count(*) FROM warehouse_operations) +
  (SELECT count(*) FROM finance_orders) +
  (SELECT count(*) FROM payment_policies) +
  (SELECT count(*) FROM payment_policy_stages) +
  (SELECT count(*) FROM payment_schedules) +
  (SELECT count(*) FROM payment_operations) +
  (SELECT count(*) FROM finance_payment_receipts) +
  (SELECT count(*) FROM finance_payment_allocations) +
  (SELECT count(*) FROM finance_payment_allocation_commands) +
  (SELECT count(*) FROM finance_payment_update_commands) +
  (SELECT count(*) FROM finance_payment_correction_commands) +
  (SELECT count(*) FROM director_decisions) +
  (SELECT count(*) FROM penalties) +
  (SELECT count(*) FROM operational_checks WHERE "targetType" IN (
    'order', 'commercial_order', 'production_order', 'finance_order', 'warehouse_order', 'roll', 'pallet'
  )) +
  (SELECT count(*) FROM operational_incidents WHERE "targetType" IN (
    'order', 'commercial_order', 'production_order', 'finance_order', 'warehouse_order', 'roll', 'pallet'
  ))
);
SELECT 'notification_receipts=' || count(*) FROM notification_receipts;
SELECT 'role_inbox_events=' || count(*) FROM domain_events WHERE type IN (
  'admin.incident.opened', 'admin.incident.reopened',
  'audit:commercial_order_ready_for_shipment', 'audit:defect_resolved_rework',
  'audit:defect_resolved_writeoff', 'audit:deferred_payment_due_scheduled',
  'audit:director_finance_override_applied', 'audit:director_finance_override_requested',
  'audit:director_production_override_applied', 'audit:director_warehouse_override_applied',
  'audit:finance_order_created', 'audit:inventory_manual_correction',
  'audit:invoice_handoff_created', 'audit:invoice_status_updated',
  'audit:operator_physical_operation_recovered', 'audit:operator_roll_handed_over',
  'audit:payment_schedule_item_confirmed', 'audit:payment_status_updated',
  'audit:production_order_created', 'audit:replacement_roll_created',
  'audit:task_assigned', 'audit:task_reassigned',
  'audit:warehouse_cover_commercial_approved', 'audit:warehouse_cover_disputed',
  'audit:warehouse_cover_proposed', 'audit:warehouse_cover_recheck_requested',
  'audit:warehouse_cover_technical_approved', 'audit:warehouse_coverage_calculated',
  'audit:warehouse_coverage_recheck_requested', 'audit:warehouse_coverage_recheck_resolved',
  'audit:warehouse_delivery_task_created', 'audit:warehouse_physical_operation_recovered',
  'audit:warehouse_roll_received', 'audit:warehouse_roll_shipped',
  'audit:warehouse_rolls_reserved_for_order', 'notification:commercial_correction_applied',
  'notification:commercial_order_amended', 'notification:commercial_order_cancelled',
  'notification:commercial_order_reactivated', 'notification:operator_machine_change_cancelled',
  'notification:operator_machine_change_completed', 'notification:operator_machine_change_ready',
  'notification:operator_machine_change_requested', 'notification:penalty_created',
  'notification:production_order_fully_handed_over', 'notification:production_problem_received',
  'problem:machine_breakdown_reported', 'problem:operator_defect_reported',
  'problem:operator_reported', 'problem:payment_overdue', 'problem:payment_sync_error',
  'problem:production_defect_reported', 'problem:production_reported_to_commercial',
  'problem:raw_material_shortage', 'problem:shift_balance_mismatch',
  'problem:warehouse_defect_reported'
);
SELECT 'gateway_unsafe_commands=' || count(*) FROM gateway_commands
  WHERE status IN ('queued', 'in_flight', 'delivery_unknown');
SELECT 'unsafe_print_jobs=' || (
  (SELECT count(*) FROM label_print_jobs
    WHERE status IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
  (SELECT count(*) FROM pallet_print_jobs
    WHERE status IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
  (SELECT count(*) FROM big_bag_label_print_jobs
    WHERE status IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
  (SELECT count(*) FROM defect_bag_label_print_jobs
    WHERE status IN ('queued', 'delivery_unknown'))
);
SELECT 'gateway_commands=' || count(*) FROM gateway_commands;
SELECT 'gateway_events=' || count(*) FROM gateway_events;
SELECT 'onec_active_runs=' || count(*) FROM onec_sync_runs
  WHERE status = 'running' OR "activeScopeKey" IS NOT NULL;
SELECT 'sync_journal_active_claims=' || count(*) FROM sync_journals
  WHERE status NOT IN ('ready', 'error')
     OR "activeScopeKey" IS NOT NULL
     OR "leaseExpiresAt" IS NOT NULL;
SELECT 'template_usage_nonzero=' || (
  (SELECT count(*) FROM counterparty_order_templates WHERE "usageCount" <> 0 OR "lastUsedAt" IS NOT NULL) +
  (SELECT count(*) FROM stock_production_templates WHERE "usageCount" <> 0 OR "lastUsedAt" IS NOT NULL)
);
SELECT 'accumulated_runtime_rows=' || (
  (SELECT count(*) FROM defect_bag_label_print_jobs) +
  (SELECT count(*) FROM defect_bag_movements) +
  (SELECT count(*) FROM defect_bag_scan_tokens) +
  (SELECT count(*) FROM defect_bags) +
  (SELECT count(*) FROM shift_bag_usage_episodes) +
  (SELECT count(*) FROM shift_bag_usages) +
  (SELECT count(*) FROM operator_shift_close_commands) +
  (SELECT count(*) FROM operator_machine_changes) +
  (SELECT count(*) FROM operator_shift_machine_assignment_cancellation_commands) +
  (SELECT count(*) FROM operator_post_sessions) +
  (SELECT count(*) FROM operator_shift_machine_assignments) +
  (SELECT count(*) FROM shifts)
);
SELECT 'accumulated_runtime_events=' || count(*) FROM domain_events WHERE type IN (
  'audit:defect_bag_weighed', 'audit:defect_bag_label_print_requested',
  'audit:defect_bag_label_reprint_requested', 'audit:defect_bag_label_print_submitted',
  'audit:defect_bag_label_print_failed', 'audit:defect_bag_label_print_delivery_unknown',
  'audit:defect_bag_received', 'audit:defect_bag_shipped', 'audit:bigbag_weight_recorded',
  'audit:operator_shift_opened', 'audit:operator_shift_bag_added',
  'audit:operator_shift_bag_released', 'audit:operator_shift_closed',
  'audit:operator_post_session_opened', 'audit:operator_post_session_closed',
  'audit:operator_shift_machine_assigned',
  'audit:operator_shift_machine_assignment_cancelled',
  'audit:operator_machine_change_requested',
  'audit:operator_machine_change_final_weight_recorded',
  'audit:operator_machine_change_ready', 'audit:operator_machine_change_completed',
  'audit:operator_machine_change_cancelled', 'audit:operator_machine_breakdown_reassigned',
  'problem:shift_balance_mismatch'
);
SELECT 'spool_movements_with_deleted_defect=' || count(*)
  FROM spool_stock_movements AS movement
  WHERE movement."defectRecordId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM defect_records AS defect WHERE defect.id = movement."defectRecordId");
SQL
)"

expected_counts=(
  order_runtime_rows=0
  notification_receipts=0
  role_inbox_events=0
  gateway_unsafe_commands=0
  unsafe_print_jobs=0
  gateway_commands=0
  gateway_events=0
  onec_active_runs=0
  sync_journal_active_claims=0
  template_usage_nonzero=0
  spool_movements_with_deleted_defect=0
)
if [[ "$delete_accumulated_runtime" == true ]]; then
  expected_counts+=(accumulated_runtime_rows=0 accumulated_runtime_events=0)
fi
for expected in "${expected_counts[@]}"; do
  printf '%s\n' "$counts" | grep -Fxq "$expected" ||
    die "post-purge invariant failed: $expected"
done

after_fingerprints="$(preserved_fingerprints_for_mode)"
[[ "$before_fingerprints" == "$after_fingerprints" ]] ||
  die 'post-purge preserved fingerprint validation failed'

compose up -d --wait api web >/dev/null
[[ -n "$(compose ps --status running -q api)" ]] || die 'api did not restart'
[[ -n "$(compose ps --status running -q web)" ]] || die 'web did not restart'
services_stopped=false
validation_passed=true
trap - EXIT HUP INT TERM

printf 'Pilot order-history purge: PASS (backup=%s)\n' "$backup_artifact"
else
  # This out-of-range element of Bash's readonly BASH_VERSINFO is always unset.
  "${BASH_VERSINFO[999]:?ERROR: pilot order-history purge must run from a root owner shell}"
fi
