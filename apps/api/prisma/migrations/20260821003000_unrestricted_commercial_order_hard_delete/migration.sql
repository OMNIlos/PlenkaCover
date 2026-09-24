-- A commercial cancellation is an irreversible aggregate purge, even after production starts.
-- Domain events deliberately stay append-only; every mutable business projection is removed.

CREATE OR REPLACE FUNCTION hard_delete_commercial_order(target_order_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  trigger_table text;
  trigger_index integer;
  trigger_tables CONSTANT text[] := ARRAY[
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
    'roll_production_cost_snapshots'
  ];
BEGIN
  IF target_order_id IS NULL OR btrim(target_order_id) = '' THEN
    RETURN false;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('plenka:commercial-order-hard-delete:' || target_order_id, 0)
  );
  PERFORM 1
  FROM commercial_orders
  WHERE "id" = target_order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DROP TABLE IF EXISTS pg_temp.commercial_order_hard_delete_ids;
  CREATE TEMP TABLE pg_temp.commercial_order_hard_delete_ids (
    namespace text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (namespace, value)
  ) ON COMMIT DROP;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT identifiers.namespace, identifiers.value
  FROM (
    SELECT 'commercial_order'::text, "id"::text
    FROM commercial_orders WHERE "id" = target_order_id
    UNION ALL
    SELECT 'order_number', "orderNumber"::text
    FROM commercial_orders WHERE "id" = target_order_id
    UNION ALL
    SELECT 'onec_order_reference', 'PLENKA_ORDER=' || btrim("orderNumber")
    FROM commercial_orders WHERE "id" = target_order_id
    UNION ALL
    SELECT 'commercial_order_external_id', "externalId"::text
    FROM commercial_orders WHERE "id" = target_order_id AND "externalId" IS NOT NULL
    UNION ALL
    SELECT 'commercial_position', "id"::text
    FROM commercial_order_positions WHERE "orderId" = target_order_id
    UNION ALL
    SELECT 'warehouse_proposal', "id"::text
    FROM warehouse_cover_proposals WHERE "orderId" = target_order_id
    UNION ALL
    SELECT 'coverage_calculation', "id"::text
    FROM warehouse_coverage_calculations WHERE "orderId" = target_order_id
    UNION ALL
    SELECT 'coverage_decision', "id"::text
    FROM warehouse_coverage_decisions WHERE "orderId" = target_order_id
    UNION ALL
    SELECT 'production_order', "id"::text
    FROM production_orders WHERE "commercialOrderId" = target_order_id
    UNION ALL
    SELECT 'finance_order', "id"::text
    FROM finance_orders WHERE "commercialOrderId" = target_order_id
    UNION ALL
    SELECT 'finance_invoice_external_id', "externalId"::text
    FROM finance_orders
    WHERE "commercialOrderId" = target_order_id AND "externalId" IS NOT NULL
  ) AS identifiers(namespace, value)
  WHERE identifiers.value IS NOT NULL AND btrim(identifiers.value) <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'roll_dispatch_item', dispatch."id"::text
  FROM roll_dispatch_items AS dispatch
  WHERE dispatch."productionOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'production_order'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'roll_code', dispatch."rollCode"::text
  FROM roll_dispatch_items AS dispatch
  WHERE dispatch."id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_dispatch_item'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'operator_roll_line', line."id"::text
  FROM operator_roll_lines AS line
  WHERE line."rollDispatchItemId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_dispatch_item'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'operator_operation', operation."id"::text
  FROM operator_roll_operations AS operation
  WHERE operation."operatorRollLineId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'operator_roll_line'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'warehouse_roll', roll."id"::text
  FROM warehouse_rolls AS roll
  WHERE roll."producedForOrderId" = target_order_id
     OR roll."producedForStockOrderId" = target_order_id
     OR roll."producedForPositionId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'commercial_position'
     )
     OR roll."rollCode" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_code'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'roll_code', roll."rollCode"::text
  FROM warehouse_rolls AS roll
  WHERE roll."id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_roll'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'warehouse_task', task."id"::text
  FROM warehouse_acceptance_tasks AS task
  WHERE task."orderId" = target_order_id
     OR task."positionId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'commercial_position'
     )
     OR task."proposalId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_proposal'
     )
     OR task."coverageDecisionId" IN (
       SELECT value::uuid FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'coverage_decision'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'scan_row', row."id"::text
  FROM scan_rows AS row
  WHERE row."taskId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_task'
    )
     OR row."fromOrderId" = target_order_id
     OR row."rollCode" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_code'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'warehouse_operation', operation."id"::text
  FROM warehouse_operations AS operation
  WHERE operation."taskId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_task'
    )
     OR operation."scanRowId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'scan_row'
     )
     OR operation."rollCode" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_code'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'weight_capture', capture."id"::text
  FROM weight_captures AS capture
  WHERE capture."operatorRollLineId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'operator_roll_line'
    )
     OR capture."operationId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'operator_operation'
     )
     OR capture."warehouseOperationId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_operation'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'defect_record', defect."id"::text
  FROM defect_records AS defect
  WHERE defect."operatorRollLineId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'operator_roll_line'
    )
     OR defect."weightCaptureId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'weight_capture'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'production_problem', problem."id"::text
  FROM production_problems AS problem
  WHERE problem."orderId" = target_order_id
     OR problem."positionId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'commercial_position'
     )
     OR problem."rollId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace IN ('roll_dispatch_item', 'warehouse_roll', 'roll_code')
     )
     OR problem."defectRecordId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'defect_record'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'resolution_case', resolution."id"::text
  FROM order_resolution_cases AS resolution
  WHERE resolution."orderId" = target_order_id
     OR resolution."problemId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'production_problem'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'coverage_fact', fact."id"::text
  FROM warehouse_roll_coverage_facts AS fact
  WHERE fact."sourceOrderId" = target_order_id
     OR fact."sourcePositionId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'commercial_position'
     )
     OR fact."sourceDispatchItemId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_dispatch_item'
     )
     OR fact."sourceWeightCaptureId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'weight_capture'
     )
     OR fact."rollId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_roll'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'warehouse_pallet', pallet."id"::text
  FROM warehouse_pallets AS pallet
  WHERE pallet."orderId" = target_order_id
     OR pallet."taskId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_task'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'pallet_code', pallet."palletCode"::text
  FROM warehouse_pallets AS pallet
  WHERE pallet."id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_pallet'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'pallet_document', document."id"::text
  FROM pallet_list_documents AS document
  WHERE document."warehousePalletId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_pallet'
    )
     OR document."acceptanceTaskId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_task'
     )
     OR document."orderIds" @> jsonb_build_array(target_order_id)
     OR EXISTS (
       SELECT 1
       FROM pg_temp.commercial_order_hard_delete_ids AS roll_identifier
       WHERE roll_identifier.namespace = 'roll_code'
         AND document."rollIds" @> jsonb_build_array(roll_identifier.value)
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'label_print_job', job."id"::text
  FROM label_print_jobs AS job
  WHERE job."operatorRollLineId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'operator_roll_line'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'pallet_print_job', job."id"::text
  FROM pallet_print_jobs AS job
  WHERE job."palletListDocumentId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_document'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'gateway_command', identifiers.value
  FROM (
    SELECT job."gatewayCommandId"::text AS value
    FROM label_print_jobs AS job
    WHERE job."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'label_print_job'
    )
    UNION
    SELECT job."gatewayCommandId"::text
    FROM pallet_print_jobs AS job
    WHERE job."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'pallet_print_job'
    )
  ) AS identifiers
  WHERE identifiers.value IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_policy', policy."id"::text
  FROM payment_policies AS policy
  WHERE policy."financeOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_policy_stage', stage."id"::text
  FROM payment_policy_stages AS stage
  WHERE stage."paymentPolicyId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_policy'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_schedule', schedule."id"::text
  FROM payment_schedules AS schedule
  WHERE schedule."financeOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_allocation', allocation."id"::text
  FROM finance_payment_allocations AS allocation
  WHERE allocation."financeOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_operation', operation."id"::text
  FROM payment_operations AS operation
  WHERE operation."financeOrderId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'finance_order'
    )
     OR operation."paymentAllocationId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'payment_allocation'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_allocation_command', allocation."commandId"::text
  FROM finance_payment_allocations AS allocation
  WHERE allocation."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'payment_allocation'
    )
    AND allocation."commandId" IS NOT NULL
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'payment_receipt', allocation."receiptId"::text
  FROM finance_payment_allocations AS allocation
  WHERE allocation."id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_allocation'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'onec_invoice_external_id', identifiers.value
  FROM (
    SELECT value
    FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_invoice_external_id'
    UNION
    SELECT policy."invoiceExternalId"::text
    FROM payment_policies AS policy
    WHERE policy."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'payment_policy'
    )
    UNION
    SELECT snapshot."externalId"::text
    FROM source_snapshots AS snapshot
    WHERE snapshot."financeOrderId" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'finance_order'
      )
      AND snapshot."subjectType" = 'invoice'
    UNION
    SELECT invoice."externalId"::text
    FROM onec_invoices AS invoice
    WHERE invoice."orderReference" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'onec_order_reference'
    )
  ) AS identifiers(value)
  WHERE identifiers.value IS NOT NULL AND btrim(identifiers.value) <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'onec_payment_external_id', identifiers.value
  FROM (
    SELECT snapshot."externalId"::text AS value
    FROM source_snapshots AS snapshot
    WHERE snapshot."financeOrderId" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'finance_order'
      )
      AND snapshot."subjectType" = 'payment'
    UNION
    SELECT payment."externalId"::text
    FROM onec_payments AS payment
    WHERE payment."orderReference" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'onec_order_reference'
      )
       OR payment."invoiceExternalId" IN (
         SELECT value FROM pg_temp.commercial_order_hard_delete_ids
         WHERE namespace = 'onec_invoice_external_id'
       )
  ) AS identifiers(value)
  WHERE identifiers.value IS NOT NULL AND btrim(identifiers.value) <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'onec_shipment_external_id', identifiers.value
  FROM (
    SELECT shipment."externalId"::text AS value
    FROM onec_shipments AS shipment
    WHERE shipment."invoiceExternalId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'onec_invoice_external_id'
    )
    UNION
    SELECT snapshot."externalId"::text
    FROM source_snapshots AS snapshot
    WHERE snapshot."financeOrderId" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'finance_order'
      )
      AND snapshot."subjectType" = 'shipment'
  ) AS identifiers(value)
  WHERE identifiers.value IS NOT NULL AND btrim(identifiers.value) <> ''
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'source_snapshot', snapshot."id"::text
  FROM source_snapshots AS snapshot
  WHERE snapshot."financeOrderId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'finance_order'
    )
     OR (snapshot."subjectType" = 'invoice' AND snapshot."externalId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'onec_invoice_external_id'
     ))
     OR (snapshot."subjectType" = 'payment' AND snapshot."externalId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'onec_payment_external_id'
     ))
     OR (snapshot."subjectType" = 'shipment' AND snapshot."externalId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'onec_shipment_external_id'
     ))
     OR snapshot."parsed" #>> '{orderReference}' IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'onec_order_reference'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO pg_temp.commercial_order_hard_delete_ids (namespace, value)
  SELECT 'sync_journal', journal."id"::text
  FROM sync_journals AS journal
  WHERE journal."financeOrderId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'finance_order'
    )
     OR journal."sourceSnapshotId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'source_snapshot'
     )
  ON CONFLICT DO NOTHING;

  -- The append-only/physical-integrity triggers guard ordinary writes. This owner-only function
  -- takes access-exclusive locks while they are disabled and restores them before returning.
  FOREACH trigger_table IN ARRAY trigger_tables LOOP
    EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', trigger_table);
  END LOOP;

  UPDATE warehouse_rolls
  SET "currentCoverageFactId" = NULL
  WHERE "currentCoverageFactId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'coverage_fact'
  );

  UPDATE warehouse_rolls
  SET "reservedForOrderId" = NULL,
      "reservedForPositionId" = NULL,
      "reservedByProposalId" = NULL,
      "reservedByCoverageDecisionId" = NULL,
      "reservedAt" = NULL
  WHERE "id" NOT IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_roll'
    )
    AND (
      "reservedForOrderId" = target_order_id
      OR "reservedForPositionId" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'commercial_position'
      )
      OR "reservedByProposalId" IN (
        SELECT value FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'warehouse_proposal'
      )
      OR "reservedByCoverageDecisionId" IN (
        SELECT value::uuid FROM pg_temp.commercial_order_hard_delete_ids
        WHERE namespace = 'coverage_decision'
      )
    );

  UPDATE roll_dispatch_items
  SET "replacesDispatchItemId" = NULL
  WHERE "replacesDispatchItemId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_dispatch_item'
  );
  UPDATE weight_captures
  SET "supersedesCaptureId" = NULL
  WHERE "supersedesCaptureId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'weight_capture'
  );
  UPDATE roll_production_cost_snapshots
  SET "supersedesSnapshotId" = NULL
  WHERE "rollDispatchItemId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'roll_dispatch_item'
    )
     OR "supersedesSnapshotId" IN (
       SELECT snapshot."id"
       FROM roll_production_cost_snapshots AS snapshot
       WHERE snapshot."rollDispatchItemId" IN (
         SELECT value FROM pg_temp.commercial_order_hard_delete_ids
         WHERE namespace = 'roll_dispatch_item'
       )
     );
  UPDATE payment_operations
  SET "reversesOperationId" = NULL
  WHERE "reversesOperationId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_operation'
  );
  UPDATE finance_payment_allocations
  SET "reversesId" = NULL
  WHERE "reversesId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_allocation'
  );
  UPDATE pallet_print_jobs
  SET "replacesJobId" = NULL
  WHERE "replacesJobId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_print_job'
  );

  DELETE FROM onec_shipment_lines
  WHERE "shipmentExternalId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'onec_shipment_external_id'
  );
  DELETE FROM onec_invoice_lines
  WHERE "invoiceExternalId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'onec_invoice_external_id'
  );
  DELETE FROM onec_payments
  WHERE "externalId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'onec_payment_external_id'
  );
  DELETE FROM onec_shipments
  WHERE "externalId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'onec_shipment_external_id'
  );
  DELETE FROM onec_invoices
  WHERE "externalId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'onec_invoice_external_id'
  );
  DELETE FROM sync_journals
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'sync_journal'
  );
  DELETE FROM source_snapshots
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'source_snapshot'
  );

  DELETE FROM operational_checks
  WHERE "targetId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
  );
  DELETE FROM operational_incidents
  WHERE "targetId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
  );
  DELETE FROM director_decisions
  WHERE "objectId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
  );
  DELETE FROM penalties
  WHERE "sourceObjectId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    )
     OR "sourceProductionOrderId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'production_order'
     )
     OR "sourceOrderNumber" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'order_number'
     )
     OR "sourceRollCode" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_code'
     );

  DELETE FROM warehouse_coverage_recheck_memberships
  WHERE "orderId" = target_order_id;
  DELETE FROM warehouse_coverage_commands
  WHERE "orderId" = target_order_id;
  DELETE FROM warehouse_coverage_matches
  WHERE "orderId" = target_order_id
     OR "calculationId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'coverage_calculation'
     );
  DELETE FROM warehouse_cover_matches
  WHERE "proposalId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_proposal'
    )
     OR "rollId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_roll'
     );
  DELETE FROM warehouse_reserve_roll_commands
  WHERE "sourceOrderId" = target_order_id
     OR "sourcePositionId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'commercial_position'
     )
     OR "rollId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_roll'
     );

  DELETE FROM pallet_print_reconciliations
  WHERE "palletListDocumentId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_document'
  );
  DELETE FROM pallet_print_jobs
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_print_job'
  );
  DELETE FROM pallet_scan_tokens
  WHERE "documentId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_document'
  );
  DELETE FROM pallet_list_documents
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'pallet_document'
  );
  DELETE FROM warehouse_pallet_items
  WHERE "palletId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_pallet'
    )
     OR "scanRowId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'scan_row'
     );
  DELETE FROM warehouse_pallet_commands
  WHERE "taskId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'warehouse_task'
    )
     OR "scanRowId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'scan_row'
     )
     OR "palletId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'warehouse_pallet'
     );
  DELETE FROM warehouse_pallets
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_pallet'
  );

  DELETE FROM label_print_reconciliations
  WHERE "operatorRollLineId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'operator_roll_line'
  );
  DELETE FROM label_print_jobs
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'label_print_job'
  );
  DELETE FROM additional_production_costs
  WHERE "productionOrderId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'production_order'
    )
     OR "rollDispatchItemId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_dispatch_item'
     );
  DELETE FROM roll_production_cost_snapshots
  WHERE "rollDispatchItemId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_dispatch_item'
  );
  DELETE FROM machine_assignments
  WHERE "productionOrderId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'production_order'
    )
     OR "rollDispatchItemId" IN (
       SELECT value FROM pg_temp.commercial_order_hard_delete_ids
       WHERE namespace = 'roll_dispatch_item'
     );
  DELETE FROM order_resolution_cases
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'resolution_case'
  );
  DELETE FROM production_problems
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'production_problem'
  );
  DELETE FROM defect_records
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'defect_record'
  );
  DELETE FROM warehouse_roll_coverage_facts
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'coverage_fact'
  );
  DELETE FROM weight_captures
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'weight_capture'
  );
  DELETE FROM operator_roll_operations
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'operator_operation'
  );
  DELETE FROM operator_roll_lines
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'operator_roll_line'
  );
  DELETE FROM roll_dispatch_items
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_dispatch_item'
  );
  DELETE FROM production_orders
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'production_order'
  );

  DELETE FROM warehouse_operations
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_operation'
  );
  DELETE FROM scan_rows
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'scan_row'
  );
  DELETE FROM warehouse_acceptance_tasks
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_task'
  );
  DELETE FROM roll_scan_tokens
  WHERE "rollCode" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'roll_code'
  );
  DELETE FROM warehouse_rolls
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_roll'
  );

  DELETE FROM warehouse_coverage_states
  WHERE "orderId" = target_order_id;
  DELETE FROM warehouse_coverage_decisions
  WHERE "id" IN (
    SELECT value::uuid FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'coverage_decision'
  );
  DELETE FROM warehouse_coverage_calculations
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'coverage_calculation'
  );
  DELETE FROM warehouse_cover_proposals
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'warehouse_proposal'
  );
  DELETE FROM recipe_snapshot_versions
  WHERE "recipeSnapshotId" IN (
    SELECT snapshot."id"
    FROM recipe_snapshots AS snapshot
    WHERE snapshot."positionId" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'commercial_position'
    )
  );
  DELETE FROM recipe_snapshots
  WHERE "positionId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'commercial_position'
  );
  DELETE FROM commercial_order_positions
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'commercial_position'
  );

  DELETE FROM payment_operations
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_operation'
  );
  DELETE FROM finance_payment_allocations
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_allocation'
  );
  DELETE FROM payment_schedules
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_schedule'
  );
  DELETE FROM payment_policy_stages
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_policy_stage'
  );
  DELETE FROM payment_policies
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'payment_policy'
  );
  DELETE FROM finance_payment_allocation_commands AS command
  WHERE command."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'payment_allocation_command'
    )
    AND NOT EXISTS (
      SELECT 1 FROM finance_payment_allocations AS allocation
      WHERE allocation."commandId" = command."id"
    );
  DELETE FROM finance_payment_receipts AS receipt
  WHERE receipt."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'payment_receipt'
    )
    AND NOT EXISTS (
      SELECT 1 FROM finance_payment_allocations AS allocation
      WHERE allocation."receiptId" = receipt."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM finance_payment_allocation_commands AS command
      WHERE command."receiptId" = receipt."id"
    );
  DELETE FROM finance_payment_update_commands
  WHERE "financeOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  );
  DELETE FROM finance_payment_correction_commands
  WHERE "financeOrderId" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  );
  DELETE FROM finance_orders
  WHERE "id" IN (
    SELECT value FROM pg_temp.commercial_order_hard_delete_ids
    WHERE namespace = 'finance_order'
  );

  DELETE FROM commercial_finance_note_commands
  WHERE "orderId" = target_order_id;
  DELETE FROM commercial_order_amendment_commands
  WHERE "orderId" = target_order_id;
  DELETE FROM commercial_orders
  WHERE "id" = target_order_id;

  DELETE FROM gateway_commands AS command
  WHERE command."id" IN (
      SELECT value FROM pg_temp.commercial_order_hard_delete_ids
      WHERE namespace = 'gateway_command'
    )
     OR EXISTS (
       SELECT 1
       FROM pg_temp.commercial_order_hard_delete_ids AS identifier
       WHERE identifier.namespace IN (
           'commercial_order',
           'production_order',
           'roll_dispatch_item',
           'operator_roll_line',
           'roll_code',
           'warehouse_roll',
           'warehouse_pallet',
           'pallet_code',
           'pallet_document'
         )
         AND (
           jsonb_path_exists(
             coalesce(command."payload", 'null'::jsonb),
             '$.** ? (@ == $target)',
             jsonb_build_object('target', to_jsonb(identifier.value))
           )
           OR jsonb_path_exists(
             coalesce(command."result", 'null'::jsonb),
             '$.** ? (@ == $target)',
             jsonb_build_object('target', to_jsonb(identifier.value))
           )
         )
     );
  DELETE FROM gateway_events AS event
  WHERE EXISTS (
    SELECT 1
    FROM pg_temp.commercial_order_hard_delete_ids AS identifier
    WHERE identifier.namespace IN (
        'commercial_order',
        'production_order',
        'roll_dispatch_item',
        'operator_roll_line',
        'roll_code',
        'warehouse_roll',
        'warehouse_pallet',
        'pallet_code',
        'pallet_document'
      )
      AND (
        jsonb_path_exists(
          coalesce(event."payload", 'null'::jsonb),
          '$.** ? (@ == $target)',
          jsonb_build_object('target', to_jsonb(identifier.value))
        )
        OR jsonb_path_exists(
          coalesce(event."rawPayload", 'null'::jsonb),
          '$.** ? (@ == $target)',
          jsonb_build_object('target', to_jsonb(identifier.value))
        )
      )
  );

  UPDATE warehouse_coverage_inventory_epochs
  SET "epoch" = "epoch" + 1,
      "updatedAt" = clock_timestamp()
  WHERE "id" = 1;

  FOR trigger_index IN REVERSE array_upper(trigger_tables, 1)..array_lower(trigger_tables, 1) LOOP
    EXECUTE format(
      'ALTER TABLE %I ENABLE TRIGGER USER',
      trigger_tables[trigger_index]
    );
  END LOOP;

  DROP TABLE pg_temp.commercial_order_hard_delete_ids;
  RETURN true;
END;
$$;

DO $$
DECLARE
  runtime_role name;
  target_schema name := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.hard_delete_commercial_order(text) SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.hard_delete_commercial_order(text) FROM PUBLIC',
    target_schema
  );
  FOR runtime_role IN
    SELECT role.rolname
    FROM pg_roles AS role
    WHERE role.rolname <> current_user
      AND has_table_privilege(
        role.rolname,
        format('%I.commercial_orders', target_schema),
        'DELETE'
      )
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.hard_delete_commercial_order(text) TO %I',
      target_schema,
      runtime_role
    );
  END LOOP;
END;
$$;
