import { Prisma, PrismaClient } from '@prisma/client';
import { ROLE_INBOX_PRESENTATIONS } from '../role-inbox/role-inbox.registry';

export const PILOT_ORDER_HISTORY_PURGE_CONFIRMATION = 'PURGE_PILOT_ORDER_HISTORY';
export const PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION = 'PURGE_ACCUMULATED_RUNTIME';

export const PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY =
  "WITH advisory_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(hashtextextended('plenka:pilot-order-history-purge', 0))) SELECT 1::int AS locked FROM advisory_lock";

export const PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS = [
  "SET LOCAL lock_timeout = '5s'",
  "SET LOCAL statement_timeout = '115s'",
  "SET LOCAL idle_in_transaction_session_timeout = '115s'",
] as const;

export const PILOT_ORDER_PURGE_PREFLIGHTS = [
  {
    name: 'active operator sessions or open order shifts',
    query: `SELECT (
      (SELECT count(*) FROM "operator_post_sessions" WHERE "status" = 'active') +
      (SELECT count(*) FROM "shifts" AS shift
       WHERE shift."status" = 'open'
         AND EXISTS (
           SELECT 1 FROM "roll_dispatch_items" AS dispatch
           WHERE dispatch."plannedShiftId" = shift."id"
         ))
    )::int AS count`,
    failureMessage: 'active operator sessions or open order shifts must be closed',
  },
  {
    name: 'in-progress physical operations',
    query: `SELECT (
      (SELECT count(*) FROM "operator_roll_operations" WHERE "status" = 'in_progress') +
      (SELECT count(*) FROM "warehouse_operations" WHERE "status" = 'in_progress')
    )::int AS count`,
    failureMessage: 'in-progress operator or warehouse operations must be resolved',
  },
  {
    name: 'pending or ambiguous gateway commands',
    query: `SELECT count(*)::int AS count
      FROM "gateway_commands" AS command
      WHERE command."status" IN ('queued', 'in_flight')
         OR (
           command."status" = 'delivery_unknown'
           AND NOT EXISTS (
             SELECT 1
             FROM "label_print_jobs" AS job
             JOIN "label_print_reconciliations" AS reconciliation
               ON reconciliation."printJobId" = job."id"
             WHERE job."gatewayCommandId" = command."id"
               AND job."status" IN ('failed', 'submitted', 'printed')
           )
           AND NOT EXISTS (
             SELECT 1
             FROM "pallet_print_jobs" AS job
             JOIN "pallet_print_reconciliations" AS reconciliation
               ON reconciliation."printJobId" = job."id"
             WHERE job."gatewayCommandId" = command."id"
               AND job."status" IN ('failed', 'submitted')
           )
         )`,
    failureMessage: 'queued, in-flight or delivery-unknown Gateway commands must be resolved',
  },
  {
    name: 'unsafe print jobs',
    query: `SELECT (
      (SELECT count(*) FROM "label_print_jobs"
       WHERE "status" IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
      (SELECT count(*) FROM "pallet_print_jobs"
       WHERE "status" IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
      (SELECT count(*) FROM "big_bag_label_print_jobs"
       WHERE "status" IN ('queued', 'in_flight', 'reprint_requested', 'delivery_unknown', 'uncertain')) +
      (SELECT count(*) FROM "defect_bag_label_print_jobs"
       WHERE "status" IN ('queued', 'delivery_unknown'))
    )::int AS count`,
    failureMessage: 'unsafe label print jobs must be resolved',
  },
  {
    name: 'active 1C synchronization',
    query: `SELECT count(*)::int AS count
      FROM "onec_sync_runs"
      WHERE "status" = 'running' OR "activeScopeKey" IS NOT NULL`,
    failureMessage: 'active 1C synchronization must be completed or recovered',
  },
  {
    name: 'active or unresolved 1C journal claims',
    query: `SELECT count(*)::int AS count
      FROM "sync_journals"
      WHERE "status" NOT IN ('ready', 'error')
         OR "activeScopeKey" IS NOT NULL
         OR "leaseExpiresAt" IS NOT NULL`,
    failureMessage: 'active or unresolved 1C journal claims must be completed or recovered',
  },
  {
    name: 'ambiguous legacy admin 1C invoice identities',
    query: `SELECT count(*)::int AS count
      FROM "finance_orders" AS target_finance
      WHERE EXISTS (
        SELECT 1
        FROM (
          SELECT invoice."externalId"::text AS value
          FROM "onec_invoices" AS invoice
          UNION
          SELECT snapshot."externalId"::text
          FROM "source_snapshots" AS snapshot
          WHERE snapshot."subjectType" = 'invoice' AND snapshot."externalId" IS NOT NULL
          UNION
          SELECT finance_identity."externalId"::text
          FROM "finance_orders" AS finance_identity
          WHERE finance_identity."externalId" IS NOT NULL
          UNION
          SELECT policy."invoiceExternalId"::text
          FROM "payment_policies" AS policy
          WHERE policy."invoiceExternalId" IS NOT NULL
          UNION
          SELECT receipt."invoiceExternalId"::text
          FROM "finance_payment_receipts" AS receipt
          WHERE receipt."invoiceExternalId" IS NOT NULL
          UNION
          SELECT payment."invoiceExternalId"::text
          FROM "onec_payments" AS payment
          WHERE payment."invoiceExternalId" IS NOT NULL
          UNION
          SELECT shipment."invoiceExternalId"::text
          FROM "onec_shipments" AS shipment
          WHERE shipment."invoiceExternalId" IS NOT NULL
          UNION
          SELECT event."detail" #>> '{externalId}'
          FROM "domain_events" AS event
          WHERE event."type" = 'integration.onec_imported'
            AND event."label" = 'onec_import_invoice'
            AND event."detail" #>> '{subjectType}' = 'invoice'
            AND event."detail" #>> '{externalId}' IS NOT NULL
          UNION
          SELECT event."detail" #>> '{externalId}'
          FROM "domain_events" AS event
          WHERE event."type" = 'admin.onec.import_requested'
            AND event."detail" #>> '{subjectType}' = 'invoice'
            AND event."objectId" = event."detail" #>> '{externalId}'
        ) AS invoice_identity
        WHERE invoice_identity.value = target_finance."id"::text
      )`,
    failureMessage:
      'PILOT_PURGE_ONEC_INVOICE_IDENTITY_COLLISION: a local FinanceOrder id is also a legitimate 1C invoice identity',
  },
] as const;

export const PILOT_ACCUMULATED_RUNTIME_PREFLIGHTS = [
  {
    name: 'open Big-Bag shift usage',
    query: `SELECT (
      (SELECT count(*) FROM "shift_bag_usages" WHERE "closedAt" IS NULL) +
      (SELECT count(*) FROM "shift_bag_usage_episodes" WHERE "closedAt" IS NULL)
    )::int AS count`,
    failureMessage: 'open Big-Bag shift usage must be closed',
  },
] as const;

/**
 * Exact full-table purge set. It is deliberately closed over current order/runtime models and is
 * checked against Prisma DMMF in the companion spec. No caller can supply a table name.
 */
export const PILOT_ORDER_PURGE_DELETE_TABLES = [
  'notification_receipts',
  'commercial_finance_note_commands',
  'commercial_order_amendment_commands',
  'recipe_snapshot_versions',
  'recipe_snapshots',
  'warehouse_cover_matches',
  'additional_production_costs',
  'roll_production_cost_snapshots',
  'machine_assignments',
  'label_print_reconciliations',
  'label_print_jobs',
  'warehouse_reserve_roll_commands',
  'warehouse_coverage_states',
  'warehouse_coverage_matches',
  'warehouse_coverage_commands',
  'warehouse_coverage_recheck_memberships',
  'order_resolution_cases',
  'production_problems',
  'defect_records',
  'warehouse_roll_coverage_facts',
  'weight_captures',
  'operator_roll_operations',
  'operator_roll_lines',
  'roll_dispatch_items',
  'production_orders',
  'warehouse_pallet_items',
  'warehouse_pallet_commands',
  'pallet_scan_tokens',
  'pallet_print_reconciliations',
  'pallet_print_jobs',
  'pallet_list_documents',
  'warehouse_pallets',
  'roll_scan_tokens',
  'warehouse_rolls',
  'warehouse_cover_proposals',
  'commercial_order_positions',
  'warehouse_operations',
  'scan_rows',
  'warehouse_acceptance_tasks',
  'warehouse_coverage_decisions',
  'warehouse_coverage_calculations',
  'payment_operations',
  'finance_payment_allocations',
  'payment_schedules',
  'payment_policy_stages',
  'payment_policies',
  'finance_payment_allocation_commands',
  'finance_payment_receipts',
  'finance_payment_update_commands',
  'finance_payment_correction_commands',
  'finance_orders',
  'commercial_orders',
  'director_decisions',
  'penalties',
  'gateway_commands',
  'gateway_events',
] as const;

export const PILOT_ORDER_PURGE_PRESERVED_TABLES = [
  'access_templates',
  'big_bag_label_print_jobs',
  'big_bag_movements',
  'big_bag_scan_tokens',
  'big_bag_units',
  'counterparties',
  'counterparty_order_template_versions',
  'counterparty_order_templates',
  'defect_bag_label_print_jobs',
  'defect_bag_movements',
  'defect_bag_scan_tokens',
  'defect_bags',
  'device_runtimes',
  'material_price_references',
  'onec_nomenclature_items',
  'onec_organizations',
  'onec_production_material_lines',
  'onec_production_output_lines',
  'onec_production_reports',
  'onec_stock_balances',
  'onec_stock_push_operations',
  'onec_sync_runs',
  'onec_warehouses',
  'operator_machine_changes',
  'operator_post_sessions',
  'operator_shift_close_commands',
  'operator_shift_machine_assignment_cancellation_commands',
  'operator_shift_machine_assignments',
  'pallet_label_layout_publish_commands',
  'pallet_label_layout_versions',
  'payroll_tariff_order_commands',
  'payroll_tariff_orders',
  'posts',
  'raw_material_definitions',
  'raw_material_stocks',
  'recipe_definition_versions',
  'recipe_definitions',
  'recipe_ingredients',
  'sessions',
  'shift_bag_usage_episodes',
  'shift_bag_usages',
  'shifts',
  'spool_price_references',
  'spool_stock_receipts',
  'spool_stock_movements',
  'stock_production_template_versions',
  'stock_production_templates',
  'user_capability_overrides',
  'users',
  'warehouse_coverage_inventory_epochs',
] as const;

/** Extra one-time scope for clearing accumulated hours/payroll facts after order history. */
export const PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES = [
  'defect_bag_label_print_jobs',
  'defect_bag_movements',
  'defect_bag_scan_tokens',
  'defect_bags',
  'shift_bag_usage_episodes',
  'shift_bag_usages',
  'operator_shift_close_commands',
  'operator_machine_changes',
  'operator_shift_machine_assignment_cancellation_commands',
  'operator_post_sessions',
  'operator_shift_machine_assignments',
  'shifts',
] as const;

export const PILOT_ACCUMULATED_RUNTIME_EVENT_TYPES = [
  'audit:defect_bag_weighed',
  'audit:defect_bag_label_print_requested',
  'audit:defect_bag_label_reprint_requested',
  'audit:defect_bag_label_print_submitted',
  'audit:defect_bag_label_print_failed',
  'audit:defect_bag_label_print_delivery_unknown',
  'audit:defect_bag_received',
  'audit:defect_bag_shipped',
  'audit:bigbag_weight_recorded',
  'audit:operator_shift_opened',
  'audit:operator_shift_bag_added',
  'audit:operator_shift_bag_released',
  'audit:operator_shift_closed',
  'audit:operator_post_session_opened',
  'audit:operator_post_session_closed',
  'audit:operator_shift_machine_assigned',
  'audit:operator_shift_machine_assignment_cancelled',
  'audit:operator_machine_change_requested',
  'audit:operator_machine_change_final_weight_recorded',
  'audit:operator_machine_change_ready',
  'audit:operator_machine_change_completed',
  'audit:operator_machine_change_cancelled',
  'audit:operator_machine_breakdown_reassigned',
  'problem:shift_balance_mismatch',
] as const;

export const PILOT_ACCUMULATED_RUNTIME_DISABLE_TRIGGER_STATEMENTS = [
  'ALTER TABLE "shift_bag_usage_episodes" DISABLE TRIGGER USER',
  'ALTER TABLE "operator_shift_close_commands" DISABLE TRIGGER USER',
] as const;

export const PILOT_ACCUMULATED_RUNTIME_ENABLE_TRIGGER_STATEMENTS = [
  'ALTER TABLE "operator_shift_close_commands" ENABLE TRIGGER USER',
  'ALTER TABLE "shift_bag_usage_episodes" ENABLE TRIGGER USER',
] as const;

export const PILOT_ACCUMULATED_RUNTIME_EVENT_DELETE_STATEMENT = `DELETE FROM "domain_events"
WHERE "type" IN (${PILOT_ACCUMULATED_RUNTIME_EVENT_TYPES.map((type) => `'${type}'`).join(', ')})`;

const SELECTIVE_PURGE_TABLES = [
  'domain_events',
  'onec_invoice_lines',
  'onec_invoices',
  'onec_payments',
  'onec_shipment_lines',
  'onec_shipments',
  'operational_checks',
  'operational_incidents',
  'source_snapshots',
  'sync_journals',
] as const;

export const PILOT_ORDER_PURGE_TABLE_BOUNDARY: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(PILOT_ORDER_PURGE_DELETE_TABLES.map((table) => [table, 'delete-all'])),
  ...Object.fromEntries(PILOT_ORDER_PURGE_PRESERVED_TABLES.map((table) => [table, 'preserve'])),
  ...Object.fromEntries(SELECTIVE_PURGE_TABLES.map((table) => [table, 'delete-order-linked'])),
});

const PILOT_ORDER_PURGE_TRIGGER_TABLES = [
  'domain_events',
  'roll_scan_tokens',
  'label_print_reconciliations',
  'production_problems',
  'defect_records',
  'warehouse_roll_coverage_facts',
  'warehouse_coverage_calculations',
  'warehouse_coverage_matches',
  'warehouse_coverage_decisions',
  'warehouse_coverage_commands',
  'warehouse_coverage_recheck_memberships',
  'warehouse_pallet_commands',
  'warehouse_rolls',
  'warehouse_acceptance_tasks',
  'scan_rows',
  'pallet_scan_tokens',
  'pallet_print_reconciliations',
  'roll_production_cost_snapshots',
] as const;

export const PILOT_ORDER_PURGE_DISABLE_TRIGGER_STATEMENTS = PILOT_ORDER_PURGE_TRIGGER_TABLES.map(
  (table) => `ALTER TABLE "${table}" DISABLE TRIGGER USER`,
);

export const PILOT_ORDER_PURGE_ENABLE_TRIGGER_STATEMENTS = [...PILOT_ORDER_PURGE_TRIGGER_TABLES]
  .reverse()
  .map((table) => `ALTER TABLE "${table}" ENABLE TRIGGER USER`);

export const PILOT_ORDER_PURGE_PREPARE_STATEMENTS = [
  'UPDATE "warehouse_rolls" SET "currentCoverageFactId" = NULL WHERE "currentCoverageFactId" IS NOT NULL',
  'UPDATE "warehouse_rolls" SET "producedByCoverageDecisionId" = NULL, "reservedByCoverageDecisionId" = NULL WHERE "producedByCoverageDecisionId" IS NOT NULL OR "reservedByCoverageDecisionId" IS NOT NULL',
  'UPDATE "roll_dispatch_items" SET "replacesDispatchItemId" = NULL WHERE "replacesDispatchItemId" IS NOT NULL',
  'UPDATE "weight_captures" SET "supersedesCaptureId" = NULL WHERE "supersedesCaptureId" IS NOT NULL',
  'UPDATE "roll_production_cost_snapshots" SET "supersedesSnapshotId" = NULL WHERE "supersedesSnapshotId" IS NOT NULL',
  'UPDATE "payment_operations" SET "reversesOperationId" = NULL WHERE "reversesOperationId" IS NOT NULL',
  'UPDATE "finance_payment_allocations" SET "reversesId" = NULL WHERE "reversesId" IS NOT NULL',
] as const;

type IdentifierSource = {
  namespace: string;
  table: (typeof PILOT_ORDER_PURGE_DELETE_TABLES)[number];
  column: string;
};

const PRIMARY_KEY_COLUMN_OVERRIDES: Partial<
  Record<(typeof PILOT_ORDER_PURGE_DELETE_TABLES)[number], string>
> = {
  pallet_scan_tokens: 'documentId',
  roll_scan_tokens: 'rollCode',
  warehouse_coverage_states: 'orderId',
};

export const PILOT_ORDER_PURGE_IDENTIFIER_SOURCES: readonly IdentifierSource[] =
  PILOT_ORDER_PURGE_DELETE_TABLES.map((table) => ({
    namespace: `${table}:primary`,
    table,
    column: PRIMARY_KEY_COLUMN_OVERRIDES[table] ?? 'id',
  }));

const IDENTIFIER_TABLE_CREATE_STATEMENT = `CREATE TEMP TABLE "pilot_order_purge_identifiers" (
  "namespace" text NOT NULL,
  "value" text NOT NULL,
  PRIMARY KEY ("namespace", "value")
) ON COMMIT DROP`;

const PRIMARY_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
${PILOT_ORDER_PURGE_IDENTIFIER_SOURCES.map(
  ({ namespace, table, column }) =>
    `SELECT '${namespace}'::text, "${column}"::text FROM "${table}" WHERE "${column}" IS NOT NULL`,
).join('\nUNION ALL ')}
ON CONFLICT ("namespace", "value") DO NOTHING`;

const BUSINESS_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT identifiers."namespace", identifiers."value"
FROM (
  SELECT 'commercial_order_id'::text AS "namespace", order_row."id"::text AS "value" FROM "commercial_orders" AS order_row
  UNION ALL SELECT 'order_number', order_row."orderNumber"::text FROM "commercial_orders" AS order_row
  UNION ALL SELECT 'onec_order_reference', 'PLENKA_ORDER=' || btrim(order_row."orderNumber") FROM "commercial_orders" AS order_row
  UNION ALL SELECT 'commercial_order_external_id', order_row."externalId"::text FROM "commercial_orders" AS order_row
  UNION ALL SELECT 'commercial_position_id', position."id"::text FROM "commercial_order_positions" AS position
  UNION ALL SELECT 'production_order_id', production."id"::text FROM "production_orders" AS production
  UNION ALL SELECT 'roll_dispatch_item_id', dispatch."id"::text FROM "roll_dispatch_items" AS dispatch
  UNION ALL SELECT 'roll_code', dispatch."rollCode"::text FROM "roll_dispatch_items" AS dispatch
  UNION ALL SELECT 'roll_code', warehouse_roll."rollCode"::text FROM "warehouse_rolls" AS warehouse_roll
  UNION ALL SELECT 'warehouse_roll_id', warehouse_roll."id"::text FROM "warehouse_rolls" AS warehouse_roll
  UNION ALL SELECT 'operator_roll_line_id', line."id"::text FROM "operator_roll_lines" AS line
  UNION ALL SELECT 'operator_operation_id', operation."id"::text FROM "operator_roll_operations" AS operation
  UNION ALL SELECT 'weight_capture_id', capture."id"::text FROM "weight_captures" AS capture
  UNION ALL SELECT 'defect_id', defect."id"::text FROM "defect_records" AS defect
  UNION ALL SELECT 'production_problem_id', problem."id"::text FROM "production_problems" AS problem
  UNION ALL SELECT 'resolution_case_id', resolution."id"::text FROM "order_resolution_cases" AS resolution
  UNION ALL SELECT 'warehouse_task_id', task."id"::text FROM "warehouse_acceptance_tasks" AS task
  UNION ALL SELECT 'warehouse_operation_id', operation."id"::text FROM "warehouse_operations" AS operation
  UNION ALL SELECT 'scan_row_id', scan_row."id"::text FROM "scan_rows" AS scan_row
  UNION ALL SELECT 'warehouse_pallet_id', pallet."id"::text FROM "warehouse_pallets" AS pallet
  UNION ALL SELECT 'pallet_code', pallet."palletCode"::text FROM "warehouse_pallets" AS pallet
  UNION ALL SELECT 'pallet_document_id', document."id"::text FROM "pallet_list_documents" AS document
  UNION ALL SELECT 'warehouse_calculation_id', calculation."id"::text FROM "warehouse_coverage_calculations" AS calculation
  UNION ALL SELECT 'warehouse_decision_id', decision."id"::text FROM "warehouse_coverage_decisions" AS decision
  UNION ALL SELECT 'finance_order_id', finance."id"::text FROM "finance_orders" AS finance
  UNION ALL SELECT 'finance_invoice_external_id', finance."externalId"::text FROM "finance_orders" AS finance
  UNION ALL SELECT 'finance_payment_receipt_id', receipt."id"::text FROM "finance_payment_receipts" AS receipt
  UNION ALL SELECT 'finance_payment_external_id', receipt."externalId"::text FROM "finance_payment_receipts" AS receipt
  UNION ALL SELECT 'payment_operation_id', operation."id"::text FROM "payment_operations" AS operation
  UNION ALL SELECT 'director_decision_id', decision."id"::text FROM "director_decisions" AS decision
  UNION ALL SELECT 'penalty_id', penalty."id"::text FROM "penalties" AS penalty
  UNION ALL SELECT 'gateway_command_id', command."id"::text FROM "gateway_commands" AS command
) AS identifiers("namespace", "value")
WHERE identifiers."value" IS NOT NULL AND btrim(identifiers."value") <> ''
ON CONFLICT ("namespace", "value") DO NOTHING`;

const INVOICE_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT 'onec_invoice_external_id', target."value"
FROM (
  SELECT identifier."value"
  FROM "pilot_order_purge_identifiers" AS identifier
  WHERE identifier."namespace" = 'finance_invoice_external_id'
  UNION
  SELECT policy."invoiceExternalId"::text
  FROM "payment_policies" AS policy
  WHERE policy."invoiceExternalId" IS NOT NULL
  UNION
  SELECT snapshot."externalId"::text
  FROM "source_snapshots" AS snapshot
  WHERE snapshot."financeOrderId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'finance_order_id'
  ) AND snapshot."subjectType" = 'invoice'
  UNION
  SELECT invoice."externalId"::text
  FROM "onec_invoices" AS invoice
  WHERE invoice."orderReference" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'onec_order_reference'
  )
  UNION
  SELECT snapshot."externalId"::text
  FROM "source_snapshots" AS snapshot
  WHERE snapshot."subjectType" = 'invoice'
    AND snapshot."parsed" #>> '{orderReference}' IN (
      SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
      WHERE identifier."namespace" = 'onec_order_reference'
    )
) AS target("value")
WHERE target."value" IS NOT NULL AND btrim(target."value") <> ''
ON CONFLICT ("namespace", "value") DO NOTHING`;

const PAYMENT_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT 'onec_payment_external_id', target."value"
FROM (
  SELECT identifier."value"
  FROM "pilot_order_purge_identifiers" AS identifier
  WHERE identifier."namespace" = 'finance_payment_external_id'
  UNION
  SELECT snapshot."externalId"::text
  FROM "source_snapshots" AS snapshot
  WHERE snapshot."financeOrderId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'finance_order_id'
  ) AND snapshot."subjectType" = 'payment'
  UNION
  SELECT payment."externalId"::text
  FROM "onec_payments" AS payment
  WHERE payment."orderReference" IN (
      SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
      WHERE identifier."namespace" = 'onec_order_reference'
    )
    OR payment."invoiceExternalId" IN (
      SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
      WHERE identifier."namespace" = 'onec_invoice_external_id'
    )
    OR (
      payment."documentBasisType" = 'StandardODATA.Document_СчетНаОплатуПокупателю'
      AND payment."documentBasisExternalId" IN (
        SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
        WHERE identifier."namespace" = 'onec_invoice_external_id'
      )
    )
  UNION
  SELECT snapshot."externalId"::text
  FROM "source_snapshots" AS snapshot
  WHERE snapshot."subjectType" = 'payment'
    AND (
      snapshot."parsed" #>> '{orderReference}' IN (
        SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
        WHERE identifier."namespace" = 'onec_order_reference'
      )
      OR snapshot."parsed" #>> '{invoiceExternalId}' IN (
        SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
        WHERE identifier."namespace" = 'onec_invoice_external_id'
      )
      OR (
        snapshot."parsed" #>> '{documentBasisType}' = 'StandardODATA.Document_СчетНаОплатуПокупателю'
        AND snapshot."parsed" #>> '{documentBasisExternalId}' IN (
          SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
          WHERE identifier."namespace" = 'onec_invoice_external_id'
        )
      )
    )
) AS target("value")
WHERE target."value" IS NOT NULL AND btrim(target."value") <> ''
ON CONFLICT ("namespace", "value") DO NOTHING`;

const SHIPMENT_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT 'onec_shipment_external_id', target."value"
FROM (
  SELECT shipment."externalId"::text
  FROM "onec_shipments" AS shipment
  WHERE shipment."invoiceExternalId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'onec_invoice_external_id'
  )
  UNION
  SELECT snapshot."externalId"::text
  FROM "source_snapshots" AS snapshot
  WHERE snapshot."subjectType" = 'shipment'
    AND (
      snapshot."financeOrderId" IN (
        SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
        WHERE identifier."namespace" = 'finance_order_id'
      )
      OR snapshot."parsed" #>> '{invoiceExternalId}' IN (
        SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
        WHERE identifier."namespace" = 'onec_invoice_external_id'
      )
    )
) AS target("value")
WHERE target."value" IS NOT NULL AND btrim(target."value") <> ''
ON CONFLICT ("namespace", "value") DO NOTHING`;

const SOURCE_SNAPSHOT_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT 'source_snapshot_id', snapshot."id"::text
FROM "source_snapshots" AS snapshot
WHERE snapshot."financeOrderId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'finance_order_id'
  )
  OR (snapshot."subjectType" = 'invoice' AND (
    snapshot."externalId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_invoice_external_id')
    OR snapshot."parsed" #>> '{orderReference}' IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_order_reference')
  ))
  OR (snapshot."subjectType" = 'payment' AND (
    snapshot."externalId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_payment_external_id')
    OR snapshot."parsed" #>> '{orderReference}' IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_order_reference')
    OR snapshot."parsed" #>> '{invoiceExternalId}' IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_invoice_external_id')
    OR (
      snapshot."parsed" #>> '{documentBasisType}' = 'StandardODATA.Document_СчетНаОплатуПокупателю'
      AND snapshot."parsed" #>> '{documentBasisExternalId}' IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_invoice_external_id')
    )
  ))
  OR (snapshot."subjectType" = 'shipment' AND (
    snapshot."externalId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_shipment_external_id')
    OR snapshot."parsed" #>> '{invoiceExternalId}' IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'onec_invoice_external_id')
  ))
ON CONFLICT ("namespace", "value") DO NOTHING`;

const SYNC_JOURNAL_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT 'sync_journal_id', journal."id"::text
FROM "sync_journals" AS journal
WHERE journal."financeOrderId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'finance_order_id'
  )
  OR journal."sourceSnapshotId" IN (
    SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier
    WHERE identifier."namespace" = 'source_snapshot_id'
  )
ON CONFLICT ("namespace", "value") DO NOTHING`;

const OPERATIONAL_TARGET_PREDICATE = `(fact."targetType" IN ('order', 'commercial_order', 'warehouse_order')
    OR (fact."targetType" = 'production_order' AND fact."targetId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'production_order_id'))
    OR (fact."targetType" = 'finance_order' AND fact."targetId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" = 'finance_order_id'))
    OR (fact."targetType" = 'roll' AND fact."targetId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" IN ('roll_code', 'roll_dispatch_item_id', 'warehouse_roll_id')))
    OR (fact."targetType" = 'pallet' AND fact."targetId" IN (SELECT "value" FROM "pilot_order_purge_identifiers" WHERE "namespace" IN ('warehouse_pallet_id', 'pallet_code', 'pallet_document_id'))))`;

const OPERATIONAL_IDENTIFIER_CAPTURE_STATEMENT = `INSERT INTO "pilot_order_purge_identifiers" ("namespace", "value")
SELECT facts."namespace", facts."value"
FROM (
  SELECT 'operational_check_id'::text AS "namespace", fact."id"::text AS "value"
  FROM "operational_checks" AS fact
  WHERE ${OPERATIONAL_TARGET_PREDICATE}
  UNION ALL
  SELECT 'operational_incident_id'::text, fact."id"::text
  FROM "operational_incidents" AS fact
  WHERE ${OPERATIONAL_TARGET_PREDICATE}
) AS facts("namespace", "value")
ON CONFLICT ("namespace", "value") DO NOTHING`;

export const PILOT_ORDER_PURGE_IDENTIFIER_CAPTURE_STATEMENTS = [
  IDENTIFIER_TABLE_CREATE_STATEMENT,
  PRIMARY_IDENTIFIER_CAPTURE_STATEMENT,
  BUSINESS_IDENTIFIER_CAPTURE_STATEMENT,
  INVOICE_IDENTIFIER_CAPTURE_STATEMENT,
  PAYMENT_IDENTIFIER_CAPTURE_STATEMENT,
  SHIPMENT_IDENTIFIER_CAPTURE_STATEMENT,
  SOURCE_SNAPSHOT_IDENTIFIER_CAPTURE_STATEMENT,
  SYNC_JOURNAL_IDENTIFIER_CAPTURE_STATEMENT,
  OPERATIONAL_IDENTIFIER_CAPTURE_STATEMENT,
] as const;

export const PILOT_ROLE_INBOX_EVENT_TYPES = [
  ...new Set(ROLE_INBOX_PRESENTATIONS.map((presentation) => presentation.eventType)),
].sort();

const ROLE_INBOX_EVENT_ARRAY = `$pilot_role_inbox_event_types${'$'}{${PILOT_ROLE_INBOX_EVENT_TYPES.join(',')}}$pilot_role_inbox_event_types$::text[]`;

const namespaceValues = (namespaces: readonly string[]) =>
  `SELECT identifier."value" FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" IN (${namespaces
    .map((namespace) => `'${namespace}'`)
    .join(', ')})`;

export const PILOT_ORDER_PURGE_SELECTIVE_DELETE_STATEMENTS = [
  `DELETE FROM "onec_shipment_lines" AS line
   WHERE line."shipmentExternalId" IN (${namespaceValues(['onec_shipment_external_id'])})`,
  `DELETE FROM "onec_invoice_lines" AS line
   WHERE line."invoiceExternalId" IN (${namespaceValues(['onec_invoice_external_id'])})`,
  `DELETE FROM "onec_payments" AS payment
   WHERE payment."externalId" IN (${namespaceValues(['onec_payment_external_id'])})`,
  `DELETE FROM "onec_shipments" AS shipment
   WHERE shipment."externalId" IN (${namespaceValues(['onec_shipment_external_id'])})`,
  `DELETE FROM "onec_invoices" AS invoice
   WHERE invoice."externalId" IN (${namespaceValues(['onec_invoice_external_id'])})`,
  `DELETE FROM "sync_journals" AS journal
   WHERE journal."id" IN (${namespaceValues(['sync_journal_id'])})`,
  `DELETE FROM "source_snapshots" AS snapshot
   WHERE snapshot."id" IN (${namespaceValues(['source_snapshot_id'])})`,
] as const;

type EventObjectRule = { eventTypes: readonly string[]; namespaces: readonly string[] };

const EVENT_OBJECT_RULES: readonly EventObjectRule[] = [
  {
    eventTypes: [
      'audit:commercial_recipe_snapshot_set',
      'audit:counterparty_template_applied',
      'audit:stock_production_template_applied',
      'audit:production_lead_request_created',
      'audit:production_request_created_on_behalf_of_commercial',
      'problem:production_reported_to_commercial',
      'notification:commercial_problem_received',
      'audit:production_problem_seen_by_commercial',
      'audit:commercial_position_updated',
      'audit:commercial_finance_note_updated',
      'audit:commercial_order_comment_updated',
      'audit:commercial_order_amended',
      'audit:commercial_amendment_reconciled',
      'audit:commercial_order_cancelled',
      'audit:commercial_order_reactivated',
      'audit:commercial_position_correction_requested',
      'audit:correction_applies_from_roll_set',
      'audit:current_roll_resolution_set',
      'audit:recipe_correction_applied',
      'audit:raw_material_shortage_resolved',
      'notification:operator_recipe_changed',
      'audit:commercial_draft_promoted',
      'audit:invoice_handoff_created',
      'audit:commercial_warehouse_cover_route_selected',
      'audit:warehouse_coverage_calculated',
      'audit:warehouse_coverage_decided',
      'audit:warehouse_coverage_recheck_requested',
      'audit:warehouse_coverage_recheck_resolved',
      'audit:warehouse_coverage_reserved',
      'audit:warehouse_coverage_reservation_cancelled',
      'audit:warehouse_coverage_order_spec_invalidated',
      'audit:warehouse_cover_recheck_requested',
      'audit:warehouse_cover_proposed',
      'audit:warehouse_cover_confirmed',
      'audit:warehouse_cover_commercial_approved',
      'audit:warehouse_cover_technical_approved',
      'audit:warehouse_rolls_reserved_for_order',
      'audit:warehouse_cover_disputed',
      'audit:warehouse_recheck_resolved',
      'audit:warehouse_cover_recalculated',
      'audit:warehouse_cover_rejected',
      'audit:warehouse_cover_forced_production',
      'audit:commercial_order_ready_for_shipment',
      'audit:commercial_order_locked_by_payment',
    ],
    namespaces: ['commercial_order_id'],
  },
  {
    eventTypes: ['audit:production_order_created', 'audit:production_order_approved'],
    namespaces: ['production_order_id'],
  },
  {
    eventTypes: ['audit:additional_production_cost_recorded'],
    namespaces: ['production_order_id', 'roll_dispatch_item_id'],
  },
  {
    eventTypes: [
      'audit:task_assigned',
      'audit:task_reassigned',
      'audit:machine_assigned',
      'audit:replacement_roll_created',
      'audit:roll_dispatch_assigned',
      'audit:roll_dispatch_bulk_assigned',
      'audit:operator_roll_accepted',
      'audit:operator_roll_handed_over',
      'audit:production_priority_changed',
      'audit:production_queue_reordered',
      'audit:label_reprint_requested',
      'audit:operator_weight_captured',
      'audit:operator_roll_reweighed',
      'audit:operator_roll_step_reopened',
      'audit:operator_weight_capture_failed',
      'audit:operator_label_print_requested',
      'audit:operator_label_print_submitted',
      'audit:operator_label_print_failed',
      'audit:operator_label_print_delivery_unknown',
      'audit:operator_label_print_reconciled',
      'audit:operator_qr_verified',
      'audit:operator_physical_operation_recovered',
      'audit:defect_recorded',
      'audit:defect_spool_returned',
      'audit:warehouse_reserve_roll_created',
      'audit:roll_deferred',
      'audit:roll_resumed',
      'audit:roll_assignment_released',
      'audit:defect_resolved_rework',
      'audit:defect_resolved_writeoff',
      'audit:roll_reserved_for_order',
      'audit:roll_reservation_released',
      'audit:finished_stock_created',
      'audit:finished_stock_reserved',
      'audit:finished_stock_reservation_released',
      'audit:warehouse_roll_received',
      'audit:warehouse_roll_shipped',
      'audit:warehouse_control_weight_recorded',
      'audit:warehouse_control_weight_failed',
      'audit:warehouse_reserve_roll_verified',
      'audit:warehouse_physical_operation_expired',
      'audit:warehouse_physical_operation_recovered',
      'audit:warehouse_roll_reserved_overweight',
      'audit:warehouse_roll_defect_recycled',
      'audit:warehouse_roll_coverage_fact_corrected',
      'audit:roll_production_cost_snapshotted',
      'audit:roll_production_cost_corrected',
    ],
    namespaces: ['roll_code', 'roll_dispatch_item_id', 'warehouse_roll_id'],
  },
  {
    eventTypes: [
      'audit:warehouse_pallet_opened',
      'audit:warehouse_pallet_sealed',
      'audit:warehouse_pallet_order_mismatch_rejected',
      'audit:warehouse_pallet_cutover_applied',
      'audit:warehouse_pallet_roll_selected',
      'audit:warehouse_pallet_roll_deselected',
      'audit:warehouse_pallet_voided',
    ],
    namespaces: ['warehouse_pallet_id', 'pallet_code'],
  },
  {
    eventTypes: [
      'audit:pallet_list_created',
      'audit:pallet_list_voided',
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_submitted',
      'audit:pallet_list_print_failed',
      'audit:pallet_list_print_delivery_unknown',
      'audit:pallet_list_print_reconciled',
      'audit:pallet_list_reprint_requested',
      'audit:pallet_list_exported',
    ],
    namespaces: ['pallet_document_id'],
  },
  {
    eventTypes: [
      'audit:finance_order_created',
      'audit:finance_production_cleared',
      'audit:payment_status_updated',
      'audit:manual_payment_corrected',
      'audit:invoice_status_updated',
      'audit:cash_operation_recorded',
      'audit:installment_plan_created',
      'audit:installment_plan_updated',
      'audit:deferred_payment_terms_selected',
      'audit:deferred_payment_terms_updated',
      'audit:payment_policy_created',
      'audit:payment_policy_updated',
      'audit:deferred_payment_due_scheduled',
      'audit:payment_schedule_item_confirmed',
      'problem:payment_overdue',
      'problem:payment_sync_error',
      'audit:sync_retry_requested',
    ],
    namespaces: ['finance_order_id', 'commercial_order_id'],
  },
  {
    eventTypes: ['audit:payment_status_imported'],
    namespaces: ['finance_payment_receipt_id', 'finance_payment_external_id'],
  },
  {
    eventTypes: ['integration.onec_imported', 'integration.onec_import_failed'],
    namespaces: ['finance_order_id'],
  },
  {
    eventTypes: ['admin.onec.retry_requested'],
    namespaces: ['sync_journal_id'],
  },
  {
    eventTypes: ['audit:sync_retry_requested'],
    namespaces: ['sync_journal_id'],
  },
  {
    eventTypes: ['admin.incident.acknowledged', 'admin.incident.resolved'],
    namespaces: ['operational_incident_id'],
  },
  {
    eventTypes: [
      'problem:production_defect_reported',
      'problem:operator_reported',
      'problem:operator_defect_reported',
      'problem:warehouse_defect_reported',
      'audit:production_problem_resolved',
    ],
    namespaces: ['production_problem_id', 'commercial_order_id', 'roll_code'],
  },
  {
    eventTypes: ['audit:machine_breakdown_confirmed', 'audit:machine_breakdown_rejected'],
    namespaces: ['production_problem_id'],
  },
  {
    eventTypes: ['audit:warehouse_acceptance_task_closed'],
    namespaces: ['warehouse_task_id'],
  },
  {
    eventTypes: ['audit:director_decision_resolved'],
    namespaces: ['director_decision_id'],
  },
  {
    eventTypes: ['audit:penalty_created'],
    namespaces: ['penalty_id'],
  },
  {
    eventTypes: [
      'gateway:command_completed',
      'gateway:command_recovered',
      'gateway:command_result_conflict',
    ],
    namespaces: ['gateway_command_id'],
  },
  {
    eventTypes: ['device.scan.mismatch'],
    namespaces: ['roll_code', 'roll_dispatch_item_id', 'warehouse_roll_id'],
  },
];

const EVENT_OBJECT_REFERENCE_PREDICATE = EVENT_OBJECT_RULES.map(
  ({ eventTypes, namespaces }) => `(
      event."type" IN (${eventTypes.map((eventType) => `'${eventType}'`).join(', ')})
      AND event."objectId" IN (${namespaceValues(namespaces)})
    )`,
).join('\n    OR ');

const EVENT_DETAIL_SCALAR_RULES = [
  { paths: ['orderId', 'commercialOrderId'], namespaces: ['commercial_order_id'] },
  { paths: ['orderNumber'], namespaces: ['order_number'] },
  { paths: ['financeOrderId'], namespaces: ['finance_order_id'] },
  { paths: ['productionOrderId'], namespaces: ['production_order_id'] },
  { paths: ['positionId'], namespaces: ['commercial_position_id'] },
  {
    paths: ['rollId'],
    namespaces: ['roll_dispatch_item_id', 'warehouse_roll_id', 'roll_code'],
  },
  { paths: ['rollCode', 'sourceRollCode', 'replacementRollCode'], namespaces: ['roll_code'] },
  { paths: ['palletId', 'warehousePalletId'], namespaces: ['warehouse_pallet_id'] },
  { paths: ['palletCode'], namespaces: ['pallet_code'] },
  { paths: ['documentId'], namespaces: ['pallet_document_id'] },
  { paths: ['taskId', 'warehouseTaskId'], namespaces: ['warehouse_task_id'] },
  { paths: ['problemId'], namespaces: ['production_problem_id'] },
  { paths: ['defectId'], namespaces: ['defect_id'] },
  { paths: ['caseId'], namespaces: ['resolution_case_id'] },
  { paths: ['calculationId'], namespaces: ['warehouse_calculation_id'] },
  { paths: ['decisionId'], namespaces: ['warehouse_decision_id', 'director_decision_id'] },
  {
    paths: ['operationId', 'warehouseOperationId'],
    namespaces: ['operator_operation_id', 'warehouse_operation_id', 'payment_operation_id'],
  },
  { paths: ['scanRowId'], namespaces: ['scan_row_id'] },
  { paths: ['gatewayCommandId'], namespaces: ['gateway_command_id'] },
] as const;

const EVENT_DETAIL_SCALAR_REFERENCE_PREDICATE = EVENT_DETAIL_SCALAR_RULES.flatMap(
  ({ paths, namespaces }) =>
    paths.map(
      (path) =>
        `event."detail" #>> '{${path}}' IN (${namespaceValues(namespaces as readonly string[])})`,
    ),
).join('\n    OR ');

const EVENT_DETAIL_ARRAY_RULES = [
  { paths: ['orderIds'], namespaces: ['commercial_order_id'] },
  { paths: ['orderNumbers'], namespaces: ['order_number'] },
  { paths: ['positionIds'], namespaces: ['commercial_position_id'] },
  {
    paths: ['rollIds', 'changedFutureRollIds', 'preservedPhysicalRollIds'],
    namespaces: ['roll_dispatch_item_id', 'warehouse_roll_id', 'roll_code'],
  },
  { paths: ['rollCodes', 'movedRollCodes'], namespaces: ['roll_code'] },
  { paths: ['dispatchItemIds', 'movedDispatchItemIds'], namespaces: ['roll_dispatch_item_id'] },
] as const;

const EVENT_DETAIL_ARRAY_REFERENCE_PREDICATE = EVENT_DETAIL_ARRAY_RULES.flatMap(
  ({ paths, namespaces }) =>
    paths.map(
      (path) => `EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(event."detail" #> '{${path}}') = 'array'
          THEN event."detail" #> '{${path}}' ELSE '[]'::jsonb END
      ) AS item("value")
      WHERE item."value" IN (${namespaceValues(namespaces as readonly string[])})
    )`,
    ),
).join('\n    OR ');

const EVENT_DETAIL_NESTED_REFERENCE_PREDICATE = `EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event."detail" #> '{assignments}') = 'array'
          THEN event."detail" #> '{assignments}' ELSE '[]'::jsonb END
      ) AS assignment("value")
      WHERE assignment."value" #>> '{commercialOrderId}' IN (${namespaceValues(['commercial_order_id'])})
         OR assignment."value" #>> '{productionOrderId}' IN (${namespaceValues(['production_order_id'])})
         OR assignment."value" #>> '{rollId}' IN (${namespaceValues([
           'roll_dispatch_item_id',
           'warehouse_roll_id',
           'roll_code',
         ])})
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event."detail" #> '{allocations}') = 'array'
          THEN event."detail" #> '{allocations}' ELSE '[]'::jsonb END
      ) AS allocation("value")
      WHERE allocation."value" #>> '{financeOrderId}' IN (${namespaceValues(['finance_order_id'])})
    )`;

const EVENT_ONEC_SUBJECT_REFERENCE_PREDICATE = `(event."detail" #>> '{subjectType}' = 'invoice'
      AND event."detail" #>> '{externalId}' IN (${namespaceValues(['onec_invoice_external_id'])}))
    OR (event."detail" #>> '{subjectType}' = 'payment'
      AND event."detail" #>> '{externalId}' IN (${namespaceValues(['onec_payment_external_id'])}))
    OR (event."detail" #>> '{subjectType}' = 'shipment'
      AND event."detail" #>> '{externalId}' IN (${namespaceValues(['onec_shipment_external_id'])}))`;

const EVENT_ORDER_REFERENCE_PREDICATE = `event."sourceSnapshotId" IN (${namespaceValues([
  'source_snapshot_id',
])})
    OR ${EVENT_OBJECT_REFERENCE_PREDICATE}
    OR ${EVENT_DETAIL_SCALAR_REFERENCE_PREDICATE}
    OR ${EVENT_DETAIL_ARRAY_REFERENCE_PREDICATE}
    OR ${EVENT_DETAIL_NESTED_REFERENCE_PREDICATE}
    OR ${EVENT_ONEC_SUBJECT_REFERENCE_PREDICATE}`;

export const PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT = `DELETE FROM "domain_events" AS event
WHERE event."type" = ANY(${ROLE_INBOX_EVENT_ARRAY})
   OR (${EVENT_ORDER_REFERENCE_PREDICATE})`;

export const PILOT_ORDER_PURGE_OPERATIONAL_DELETE_STATEMENTS = [
  `DELETE FROM "operational_checks" AS fact
   WHERE ${OPERATIONAL_TARGET_PREDICATE}`,
  `DELETE FROM "operational_incidents" AS incident
   WHERE ${OPERATIONAL_TARGET_PREDICATE.replaceAll('fact.', 'incident.')}`,
] as const;

export const PILOT_ORDER_PURGE_TEMPLATE_RESET_STATEMENTS = [
  'UPDATE "counterparty_order_templates" SET "usageCount" = 0, "lastUsedAt" = NULL WHERE "usageCount" <> 0 OR "lastUsedAt" IS NOT NULL',
  'UPDATE "stock_production_templates" SET "usageCount" = 0, "lastUsedAt" = NULL WHERE "usageCount" <> 0 OR "lastUsedAt" IS NOT NULL',
] as const;

function stableTableFingerprint(table: string, expression = 'to_jsonb(row_value)'): string {
  return `md5(COALESCE((SELECT jsonb_agg(${expression} ORDER BY (${expression})::text)::text FROM "${table}" AS row_value), '[]'))`;
}

function stableFilteredTableFingerprint(
  table: string,
  predicate: string,
  expression = 'to_jsonb(row_value)',
): string {
  return `md5(COALESCE((SELECT jsonb_agg(${expression} ORDER BY (${expression})::text)::text FROM "${table}" AS row_value WHERE ${predicate}), '[]'))`;
}

function preservedFingerprintEntry(table: (typeof PILOT_ORDER_PURGE_PRESERVED_TABLES)[number]) {
  if (table === 'counterparty_order_templates' || table === 'stock_production_templates') {
    return `'${table}', ${stableTableFingerprint(table, "to_jsonb(row_value) - 'usageCount' - 'lastUsedAt'")}`;
  }
  if (table === 'spool_stock_movements') {
    return `'spoolMovementPhysical', md5(COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', row_value."id",
          'rollCode', row_value."rollCode",
          'spoolType', row_value."spoolType",
          'tareKg', row_value."tareKg",
          'quantity', row_value."quantity",
          'location', row_value."location",
          'returnedByRole', row_value."returnedByRole",
          'returnedById', row_value."returnedById",
          'createdAt', row_value."createdAt"
        ) ORDER BY row_value."id"
      )::text FROM "spool_stock_movements" AS row_value
    ), '[]'))`;
  }
  return `'${table}', ${stableTableFingerprint(table)}`;
}

const SELECTIVELY_PRESERVED_FINGERPRINT_ENTRIES = [
  `'source_snapshots', ${stableFilteredTableFingerprint(
    'source_snapshots',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'source_snapshot_id' AND identifier."value" = row_value."id"::text)`,
  )}`,
  `'sync_journals', ${stableFilteredTableFingerprint(
    'sync_journals',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'sync_journal_id' AND identifier."value" = row_value."id"::text)`,
  )}`,
  `'onec_invoices', ${stableFilteredTableFingerprint(
    'onec_invoices',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'onec_invoice_external_id' AND identifier."value" = row_value."externalId"::text)`,
  )}`,
  `'onec_invoice_lines', ${stableFilteredTableFingerprint(
    'onec_invoice_lines',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'onec_invoice_external_id' AND identifier."value" = row_value."invoiceExternalId"::text)`,
  )}`,
  `'onec_payments', ${stableFilteredTableFingerprint(
    'onec_payments',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'onec_payment_external_id' AND identifier."value" = row_value."externalId"::text)`,
  )}`,
  `'onec_shipments', ${stableFilteredTableFingerprint(
    'onec_shipments',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'onec_shipment_external_id' AND identifier."value" = row_value."externalId"::text)`,
  )}`,
  `'onec_shipment_lines', ${stableFilteredTableFingerprint(
    'onec_shipment_lines',
    `NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'onec_shipment_external_id' AND identifier."value" = row_value."shipmentExternalId"::text)`,
  )}`,
  `'onec_stock_inventory_events', ${stableFilteredTableFingerprint(
    'domain_events',
    `row_value."type" IN ('integration.onec_imported', 'integration.onec_import_failed')
      AND row_value."label" = 'onec_import_stock'
      AND NOT EXISTS (SELECT 1 FROM "pilot_order_purge_identifiers" AS identifier WHERE identifier."namespace" = 'source_snapshot_id' AND identifier."value" = row_value."sourceSnapshotId"::text)`,
  )}`,
  `'payroll_tariff_events', ${stableFilteredTableFingerprint(
    'domain_events',
    `row_value."type" IN ('audit:payroll_tariff_order_created', 'audit:payroll_tariff_order_draft_updated', 'audit:payroll_tariff_order_published')`,
  )}`,
];

function preservedFingerprintQuery(deleteAccumulatedRuntime: boolean): string {
  const runtimeTables = new Set<string>(PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES);
  const entries = [
    ...PILOT_ORDER_PURGE_PRESERVED_TABLES.filter(
      (table) => !deleteAccumulatedRuntime || !runtimeTables.has(table),
    ).map(preservedFingerprintEntry),
    ...SELECTIVELY_PRESERVED_FINGERPRINT_ENTRIES,
    `'prismaMigrations', ${stableTableFingerprint('_prisma_migrations')}`,
  ];
  const objects = Array.from(
    { length: Math.ceil(entries.length / 40) },
    (_, index) =>
      `jsonb_build_object(\n  ${entries.slice(index * 40, index * 40 + 40).join(',\n  ')}\n)`,
  );
  return `SELECT ${objects.join('\n  || ')} AS fingerprint`;
}

export const PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY = preservedFingerprintQuery(false);
export const PILOT_ACCUMULATED_RUNTIME_PRESERVED_FINGERPRINT_QUERY =
  preservedFingerprintQuery(true);

const ZERO_COUNT_ROWS = PILOT_ORDER_PURGE_DELETE_TABLES.map(
  (table) => `SELECT '${table}'::text AS name, count(*)::bigint AS count FROM "${table}"`,
);

function zeroValidationQuery(deleteAccumulatedRuntime: boolean): string {
  const runtimeRows = deleteAccumulatedRuntime
    ? [
        ...PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES.map(
          (table) => `SELECT '${table}', count(*) FROM "${table}"`,
        ),
        `SELECT 'accumulated_runtime_events', count(*) FROM "domain_events"
          WHERE "type" IN (${PILOT_ACCUMULATED_RUNTIME_EVENT_TYPES.map((type) => `'${type}'`).join(', ')})`,
      ]
    : [];
  return `WITH purge_counts AS (
  ${[...ZERO_COUNT_ROWS, ...runtimeRows].join('\n  UNION ALL ')}
  UNION ALL SELECT 'target_source_snapshots', count(*) FROM "source_snapshots" AS snapshot
    WHERE snapshot."id" IN (${namespaceValues(['source_snapshot_id'])})
  UNION ALL SELECT 'target_sync_journals', count(*) FROM "sync_journals" AS journal
    WHERE journal."id" IN (${namespaceValues(['sync_journal_id'])})
  UNION ALL SELECT 'target_onec_invoices', count(*) FROM "onec_invoices" AS invoice
    WHERE invoice."externalId" IN (${namespaceValues(['onec_invoice_external_id'])})
  UNION ALL SELECT 'target_onec_invoice_lines', count(*) FROM "onec_invoice_lines" AS line
    WHERE line."invoiceExternalId" IN (${namespaceValues(['onec_invoice_external_id'])})
  UNION ALL SELECT 'target_onec_payments', count(*) FROM "onec_payments" AS payment
    WHERE payment."externalId" IN (${namespaceValues(['onec_payment_external_id'])})
  UNION ALL SELECT 'target_onec_shipments', count(*) FROM "onec_shipments" AS shipment
    WHERE shipment."externalId" IN (${namespaceValues(['onec_shipment_external_id'])})
  UNION ALL SELECT 'target_onec_shipment_lines', count(*) FROM "onec_shipment_lines" AS line
    WHERE line."shipmentExternalId" IN (${namespaceValues(['onec_shipment_external_id'])})
  UNION ALL SELECT 'role_inbox_events', count(*) FROM "domain_events"
    WHERE "type" = ANY(${ROLE_INBOX_EVENT_ARRAY})
  UNION ALL SELECT 'referencing_events', count(*) FROM "domain_events" AS event
    WHERE ${EVENT_ORDER_REFERENCE_PREDICATE}
  UNION ALL SELECT 'order_operational_checks', count(*) FROM "operational_checks" AS fact
    WHERE ${OPERATIONAL_TARGET_PREDICATE}
  UNION ALL SELECT 'order_operational_incidents', count(*) FROM "operational_incidents" AS incident
    WHERE ${OPERATIONAL_TARGET_PREDICATE.replaceAll('fact.', 'incident.')}
  UNION ALL SELECT 'active_sync_journal_claims', count(*) FROM "sync_journals"
    WHERE "status" NOT IN ('ready', 'error')
       OR "activeScopeKey" IS NOT NULL
       OR "leaseExpiresAt" IS NOT NULL
)
SELECT COALESCE(sum(count), 0)::int AS remaining FROM purge_counts`;
}

export const PILOT_ORDER_PURGE_ZERO_VALIDATION_QUERY = zeroValidationQuery(false);
export const PILOT_ACCUMULATED_RUNTIME_ZERO_VALIDATION_QUERY = zeroValidationQuery(true);

type PurgeClient = Pick<PrismaClient, '$transaction'>;

type QueryCountRow = { count: number | bigint };
type FingerprintRow = { fingerprint: unknown };
type RemainingRow = { remaining: number | bigint };

export type PilotOrderHistoryPurgeResult = {
  removedRows: number;
  preservedFingerprint: unknown;
};

export class PilotOrderHistoryPurgeError extends Error {
  constructor(message: string) {
    super(`Pilot order history purge: ${message}`);
    this.name = 'PilotOrderHistoryPurgeError';
  }
}

function sameFingerprint(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

export async function purgePilotOrderHistory(
  prisma: PurgeClient,
  confirmation: string | undefined,
  appEnvironment: string | undefined,
  seedProfile: string | undefined,
  gatewaysStopped: string | undefined,
  accumulatedRuntimeConfirmation?: string,
): Promise<PilotOrderHistoryPurgeResult> {
  if (appEnvironment !== 'pilot' || seedProfile !== 'pilot') {
    throw new PilotOrderHistoryPurgeError(
      'available only for the pilot profile (APP_ENV=pilot and SEED_PROFILE=pilot)',
    );
  }
  if (confirmation !== PILOT_ORDER_HISTORY_PURGE_CONFIRMATION) {
    throw new PilotOrderHistoryPurgeError(
      `confirmation must equal ${PILOT_ORDER_HISTORY_PURGE_CONFIRMATION}`,
    );
  }
  if (gatewaysStopped !== 'yes') {
    throw new PilotOrderHistoryPurgeError(
      'PILOT_GATEWAYS_STOPPED=yes is required before Gateway journals can be purged',
    );
  }
  if (
    accumulatedRuntimeConfirmation !== undefined &&
    accumulatedRuntimeConfirmation !== PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION
  ) {
    throw new PilotOrderHistoryPurgeError(
      `accumulated runtime confirmation must equal ${PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION}`,
    );
  }
  const deleteAccumulatedRuntime =
    accumulatedRuntimeConfirmation === PILOT_ACCUMULATED_RUNTIME_PURGE_CONFIRMATION;
  const preservedFingerprintQuery = deleteAccumulatedRuntime
    ? PILOT_ACCUMULATED_RUNTIME_PRESERVED_FINGERPRINT_QUERY
    : PILOT_ORDER_PURGE_PRESERVED_FINGERPRINT_QUERY;
  const zeroValidation = deleteAccumulatedRuntime
    ? PILOT_ACCUMULATED_RUNTIME_ZERO_VALIDATION_QUERY
    : PILOT_ORDER_PURGE_ZERO_VALIDATION_QUERY;

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(PILOT_ORDER_PURGE_ADVISORY_LOCK_QUERY);
      for (const statement of PILOT_ORDER_PURGE_MAINTENANCE_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      const preflights = deleteAccumulatedRuntime
        ? [...PILOT_ORDER_PURGE_PREFLIGHTS, ...PILOT_ACCUMULATED_RUNTIME_PREFLIGHTS]
        : PILOT_ORDER_PURGE_PREFLIGHTS;
      for (const preflight of preflights) {
        const [row] = await tx.$queryRawUnsafe<QueryCountRow[]>(preflight.query);
        if (!row || Number(row.count) !== 0) {
          throw new PilotOrderHistoryPurgeError(preflight.failureMessage);
        }
      }

      for (const statement of PILOT_ORDER_PURGE_IDENTIFIER_CAPTURE_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      const [beforeRow] = await tx.$queryRawUnsafe<FingerprintRow[]>(preservedFingerprintQuery);
      if (!beforeRow) {
        throw new PilotOrderHistoryPurgeError('preserved fingerprint preflight returned no row');
      }

      for (const statement of PILOT_ORDER_PURGE_DISABLE_TRIGGER_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }
      if (deleteAccumulatedRuntime) {
        for (const statement of PILOT_ACCUMULATED_RUNTIME_DISABLE_TRIGGER_STATEMENTS) {
          await tx.$executeRawUnsafe(statement);
        }
      }
      for (const statement of PILOT_ORDER_PURGE_PREPARE_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      let removedRows = 0;
      for (const statement of PILOT_ORDER_PURGE_SELECTIVE_DELETE_STATEMENTS) {
        removedRows += await tx.$executeRawUnsafe(statement);
      }
      for (const table of PILOT_ORDER_PURGE_DELETE_TABLES) {
        removedRows += await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
      }
      for (const statement of PILOT_ORDER_PURGE_OPERATIONAL_DELETE_STATEMENTS) {
        removedRows += await tx.$executeRawUnsafe(statement);
      }
      removedRows += await tx.$executeRawUnsafe(PILOT_ORDER_PURGE_EVENT_DELETE_STATEMENT);
      if (deleteAccumulatedRuntime) {
        removedRows += await tx.$executeRawUnsafe(PILOT_ACCUMULATED_RUNTIME_EVENT_DELETE_STATEMENT);
        for (const table of PILOT_ACCUMULATED_RUNTIME_DELETE_TABLES) {
          removedRows += await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
        }
      }
      for (const statement of PILOT_ORDER_PURGE_TEMPLATE_RESET_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }
      if (deleteAccumulatedRuntime) {
        for (const statement of PILOT_ACCUMULATED_RUNTIME_ENABLE_TRIGGER_STATEMENTS) {
          await tx.$executeRawUnsafe(statement);
        }
      }
      for (const statement of PILOT_ORDER_PURGE_ENABLE_TRIGGER_STATEMENTS) {
        await tx.$executeRawUnsafe(statement);
      }

      const [afterRow] = await tx.$queryRawUnsafe<FingerprintRow[]>(preservedFingerprintQuery);
      if (!afterRow || !sameFingerprint(beforeRow.fingerprint, afterRow.fingerprint)) {
        throw new PilotOrderHistoryPurgeError('preserved fingerprint changed');
      }
      const [validation] = await tx.$queryRawUnsafe<RemainingRow[]>(zeroValidation);
      if (!validation || Number(validation.remaining) !== 0) {
        throw new PilotOrderHistoryPurgeError('rows remain after purge');
      }

      return {
        removedRows,
        preservedFingerprint: afterRow.fingerprint,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    },
  );
}
