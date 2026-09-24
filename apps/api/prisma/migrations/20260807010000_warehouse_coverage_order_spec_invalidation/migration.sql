BEGIN;

ALTER TABLE "warehouse_coverage_states"
  DROP CONSTRAINT "warehouse_coverage_states_state_ck",
  ADD CONSTRAINT "warehouse_coverage_states_state_ck"
    CHECK (
      "state" IN (
        'calculating',
        'awaiting_finance',
        'production_required',
        'unknown',
        'recheck_requested',
        'warehouse_reserved',
        'stale',
        'order_spec_changed'
      )
    );

CREATE FUNCTION "warehouse_coverage_decision_has_physical_facts"(decision_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path FROM CURRENT
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM "warehouse_rolls"
      WHERE "producedByCoverageDecisionId" = decision_id
    )
    OR EXISTS (
      SELECT 1
      FROM "warehouse_acceptance_tasks" task
      WHERE task."coverageDecisionId" = decision_id
        AND (
          task."status" NOT IN ('open', 'cancelled')
          OR EXISTS (
            SELECT 1 FROM "warehouse_operations" operation
            WHERE operation."taskId" = task."id"
          )
          OR EXISTS (
            SELECT 1 FROM "warehouse_pallets" pallet
            WHERE pallet."taskId" = task."id"
          )
          OR EXISTS (
            SELECT 1
            FROM "scan_rows" scan
            WHERE scan."taskId" = task."id"
              AND (
                scan."scanStatus" <> 'expected'
                OR scan."lastScanAt" IS NOT NULL
                OR scan."scannedByName" IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM "warehouse_operations" operation
                  WHERE operation."scanRowId" = scan."id"
                )
                OR EXISTS (
                  SELECT 1 FROM "warehouse_pallet_items" item
                  WHERE item."scanRowId" = scan."id"
                )
              )
          )
        )
    );
$$;

CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_roll"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  workflow_version INTEGER;
BEGIN
  IF NEW."currentCoverageFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "warehouse_roll_coverage_facts"
    WHERE "id" = NEW."currentCoverageFactId"
      AND "rollId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'current coverage fact must belong to the same roll';
  END IF;

  IF NEW."reservedForOrderId" IS NOT NULL THEN
    SELECT "warehouseCoverageWorkflowVersion"
    INTO workflow_version
    FROM "commercial_orders"
    WHERE "id" = NEW."reservedForOrderId";
  END IF;
  IF workflow_version = 2 AND NEW."reservedByCoverageDecisionId" IS NULL THEN
    RAISE EXCEPTION 'V2 roll reservation requires coverage decision provenance';
  END IF;

  IF NEW."reservedByCoverageDecisionId" IS NOT NULL THEN
    IF NEW."reservedForOrderId" IS NULL
      OR NEW."reservedAt" IS NULL
      OR NEW."reservedByProposalId" IS NOT NULL
      OR NEW."currentCoverageFactId" IS NULL
    THEN
      RAISE EXCEPTION 'coverage decision roll reservation provenance mismatch';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "warehouse_coverage_decisions"
      WHERE "id" = NEW."reservedByCoverageDecisionId"
    ) AND NOT EXISTS (
      SELECT 1
      FROM "warehouse_coverage_decisions" decision
      JOIN "warehouse_coverage_matches" match
        ON match."calculationId" = decision."calculationId"
       AND match."rollId" = NEW."id"
      WHERE decision."id" = NEW."reservedByCoverageDecisionId"
        AND decision."kind" = 'use_warehouse'
        AND decision."orderId" = NEW."reservedForOrderId"
        AND match."coverageFactId" = NEW."currentCoverageFactId"
        AND (
          NEW."reservedForPositionId" IS NULL
          OR NEW."reservedForPositionId" = match."positionId"
        )
    ) THEN
      RAISE EXCEPTION 'coverage decision roll reservation provenance mismatch';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."reservedByCoverageDecisionId" IS NOT NULL
    AND NEW."reservedByCoverageDecisionId" IS DISTINCT FROM OLD."reservedByCoverageDecisionId"
  THEN
    IF NEW."reservedByCoverageDecisionId" IS NOT NULL
      OR NEW."reservedForOrderId" IS NOT NULL
      OR NEW."reservedForPositionId" IS NOT NULL
      OR NEW."reservedAt" IS NOT NULL
      OR NOT (
        EXISTS (
          SELECT 1
          FROM "order_resolution_cases" coverage_case
          JOIN "warehouse_coverage_recheck_memberships" membership
            ON membership."caseId" = coverage_case."id"
           AND membership."rollId" = NEW."id"
          WHERE coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
            AND coverage_case."status" = 'open'
            AND coverage_case."sourceCoverageDecisionId" =
              OLD."reservedByCoverageDecisionId"
            AND membership."sourceDecisionId" = OLD."reservedByCoverageDecisionId"
            AND membership."sourceKind" = 'decision_match'
        )
        OR EXISTS (
          SELECT 1
          FROM "warehouse_coverage_decisions" decision
          JOIN "warehouse_coverage_states" state
            ON state."orderId" = decision."orderId"
          JOIN "warehouse_coverage_matches" match
            ON match."calculationId" = decision."calculationId"
           AND match."rollId" = OLD."id"
          WHERE decision."id" = OLD."reservedByCoverageDecisionId"
            AND decision."kind" = 'use_warehouse'
            AND decision."orderId" = OLD."reservedForOrderId"
            AND decision."generation" = state."generation"
            AND decision."calculationId" = state."currentCalculationId"
            AND state."state" = 'order_spec_changed'
            AND state."currentDecisionId" IS NULL
            AND match."coverageFactId" = OLD."currentCoverageFactId"
            AND NOT EXISTS (
              SELECT 1
              FROM "production_orders"
              WHERE "commercialOrderId" = decision."orderId"
            )
            AND (
              SELECT count(*)
              FROM "warehouse_acceptance_tasks" task
              WHERE task."coverageDecisionId" = decision."id"
            ) = 1
            AND EXISTS (
              SELECT 1
              FROM "warehouse_acceptance_tasks" task
              WHERE task."coverageDecisionId" = decision."id"
                AND task."mode" = 'reserve'
                AND task."orderId" = decision."orderId"
                AND task."proposalId" IS NULL
                AND task."positionId" IS NULL
                AND task."status" = 'cancelled'
            )
            AND NOT "warehouse_coverage_decision_has_physical_facts"(decision."id")
        )
      )
    THEN
      RAISE EXCEPTION 'physical recovery must clear an exact decision reservation set';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_state"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  calculation "warehouse_coverage_calculations"%ROWTYPE;
  decision "warehouse_coverage_decisions"%ROWTYPE;
  old_decision "warehouse_coverage_decisions"%ROWTYPE;
  order_row "commercial_orders"%ROWTYPE;
  current_position_versions JSONB;
  physical_recovery_ok BOOLEAN;
  persisted_match_count INTEGER;
BEGIN
  IF NEW."currentCalculationId" IS NULL THEN
    IF NEW."generation" <> 0
      OR NEW."state" <> 'calculating'
      OR NEW."currentDecisionId" IS NOT NULL
    THEN
      RAISE EXCEPTION 'coverage state without calculation must be generation zero';
    END IF;
  ELSE
    SELECT * INTO calculation
    FROM "warehouse_coverage_calculations"
    WHERE "id" = NEW."currentCalculationId";
    IF NOT FOUND
      OR calculation."orderId" IS DISTINCT FROM NEW."orderId"
      OR calculation."generation" IS DISTINCT FROM NEW."generation"
    THEN
      RAISE EXCEPTION 'coverage state calculation order/generation mismatch';
    END IF;
    SELECT count(*)::integer INTO persisted_match_count
    FROM "warehouse_coverage_matches"
    WHERE "calculationId" = calculation."id";
    IF persisted_match_count <> (CASE
      WHEN calculation."availability" = 'verified_full'
        THEN calculation."matchedRollCount"
      ELSE 0
    END) THEN
      RAISE EXCEPTION 'coverage state calculation persisted match count mismatch';
    END IF;
  END IF;

  IF NEW."currentDecisionId" IS NOT NULL THEN
    SELECT * INTO decision
    FROM "warehouse_coverage_decisions"
    WHERE "id" = NEW."currentDecisionId";
    IF NOT FOUND
      OR decision."orderId" IS DISTINCT FROM NEW."orderId"
      OR decision."calculationId" IS DISTINCT FROM NEW."currentCalculationId"
      OR decision."generation" IS DISTINCT FROM NEW."generation"
    THEN
      RAISE EXCEPTION 'coverage state decision/calculation/generation mismatch';
    END IF;
    IF
      (
        decision."kind" = 'use_warehouse'
        AND NEW."state" NOT IN ('warehouse_reserved', 'order_spec_changed')
      )
      OR (
        decision."kind" = 'produce_all'
        AND NEW."state" NOT IN ('production_required', 'order_spec_changed')
      )
      OR (
        decision."kind" = 'auto_produce_all'
        AND NEW."state" NOT IN ('production_required', 'stale', 'order_spec_changed')
      )
      OR (
        decision."kind" = 'auto_produce_all'
        AND NEW."state" = 'production_required'
        AND calculation."inventoryEpoch" <> (
          SELECT "epoch"
          FROM "warehouse_coverage_inventory_epochs"
          WHERE "id" = 1
        )
      )
      OR (
        NEW."state" = 'stale'
        AND (
          decision."kind" <> 'auto_produce_all'
          OR calculation."inventoryEpoch" >= (
            SELECT "epoch"
            FROM "warehouse_coverage_inventory_epochs"
            WHERE "id" = 1
          )
        )
      )
    THEN
      RAISE EXCEPTION 'coverage state and terminal decision kind mismatch';
    END IF;
  ELSIF NEW."state" IN ('warehouse_reserved', 'production_required') THEN
    RAISE EXCEPTION 'terminal coverage state requires current decision';
  ELSIF NEW."currentCalculationId" IS NOT NULL THEN
    IF NEW."state" = 'awaiting_finance'
      AND calculation."availability" <> 'verified_full'
    THEN
      RAISE EXCEPTION 'awaiting_finance state requires a decisive calculation';
    ELSIF NEW."state" = 'unknown'
      AND calculation."availability" <> 'unknown'
    THEN
      RAISE EXCEPTION 'unknown state requires unknown calculation';
    ELSIF NEW."state" = 'recheck_requested' AND NOT EXISTS (
      SELECT 1
      FROM "order_resolution_cases"
      WHERE "orderId" = NEW."orderId"
        AND "status" = 'open'
        AND "sourceCoverageCalculationId" = NEW."currentCalculationId"
        AND "coverageOrigin" IN (
          'finance_request',
          'decision_linked_physical_exception'
        )
    ) THEN
      RAISE EXCEPTION 'recheck_requested state requires matching open coverage case';
    ELSIF NEW."state" NOT IN (
      'awaiting_finance',
      'unknown',
      'recheck_requested',
      'order_spec_changed'
    ) THEN
      RAISE EXCEPTION 'coverage state/availability tuple is invalid';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."stateVersion" <> OLD."stateVersion" + 1 THEN
      RAISE EXCEPTION 'coverage stateVersion CAS must increment by exactly one';
    END IF;
    IF NEW."generation" NOT IN (OLD."generation", OLD."generation" + 1) THEN
      RAISE EXCEPTION 'coverage state generation may advance by at most one';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "production_orders"
      WHERE "commercialOrderId" = NEW."orderId"
    ) AND (
      NEW."generation" IS DISTINCT FROM OLD."generation"
      OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
      OR NEW."currentDecisionId" IS DISTINCT FROM OLD."currentDecisionId"
    ) THEN
      RAISE EXCEPTION 'coverage state is terminal after production order creation';
    END IF;

    IF NEW."state" = 'order_spec_changed' THEN
      IF OLD."currentCalculationId" IS NULL
        OR NEW."generation" IS DISTINCT FROM OLD."generation"
        OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
      THEN
        RAISE EXCEPTION 'order-spec invalidation must retain calculation provenance';
      END IF;
      SELECT * INTO order_row
      FROM "commercial_orders"
      WHERE "id" = NEW."orderId";
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'positionId', position."id",
            'version', position."version"
          )
          ORDER BY position."id" COLLATE "C"
        ),
        '[]'::jsonb
      )
      INTO current_position_versions
      FROM "commercial_order_positions" position
      WHERE position."orderId" = NEW."orderId";
      IF NOT FOUND
        OR (
          current_position_versions IS NOT DISTINCT FROM calculation."positionVersions"
          AND order_row."cancellationStatus" = 'active'
          AND OLD."state" <> 'order_spec_changed'
        )
      THEN
        RAISE EXCEPTION 'order-spec invalidation requires changed desired order facts';
      END IF;
      IF OLD."state" = 'recheck_requested'
        AND EXISTS (
          SELECT 1
          FROM "order_resolution_cases"
          WHERE "orderId" = NEW."orderId"
            AND "status" = 'open'
            AND "sourceCoverageCalculationId" = NEW."currentCalculationId"
            AND "coverageOrigin" IN (
              'finance_request',
              'decision_linked_physical_exception'
            )
        )
      THEN
        RAISE EXCEPTION 'order-spec invalidation cannot orphan an open coverage case';
      END IF;
      IF NEW."currentDecisionId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "production_orders"
          WHERE "commercialOrderId" = NEW."orderId"
        )
        AND NOT "warehouse_coverage_decision_has_physical_facts"(NEW."currentDecisionId")
      THEN
        RAISE EXCEPTION 'order-spec invalidation cannot retain an uncommitted decision';
      END IF;
    END IF;

    IF OLD."state" = 'order_spec_changed'
      AND NEW."state" <> 'order_spec_changed'
    THEN
      IF OLD."currentDecisionId" IS NOT NULL
        OR NEW."generation" <> OLD."generation" + 1
        OR NEW."currentCalculationId" IS NULL
        OR NEW."currentCalculationId" IS NOT DISTINCT FROM OLD."currentCalculationId"
      THEN
        RAISE EXCEPTION 'order-spec invalidation exit requires a new calculation';
      END IF;
      SELECT * INTO order_row
      FROM "commercial_orders"
      WHERE "id" = NEW."orderId";
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'positionId', position."id",
            'version', position."version"
          )
          ORDER BY position."id" COLLATE "C"
        ),
        '[]'::jsonb
      )
      INTO current_position_versions
      FROM "commercial_order_positions" position
      WHERE position."orderId" = NEW."orderId";
      IF NOT FOUND
        OR order_row."cancellationStatus" <> 'active'
        OR calculation."positionVersions" IS DISTINCT FROM current_position_versions
      THEN
        RAISE EXCEPTION 'order-spec invalidation exit calculation is not current';
      END IF;
    END IF;

    IF OLD."currentDecisionId" IS NOT NULL
      AND NEW."currentDecisionId" IS DISTINCT FROM OLD."currentDecisionId"
    THEN
      SELECT * INTO old_decision
      FROM "warehouse_coverage_decisions"
      WHERE "id" = OLD."currentDecisionId";

      IF old_decision."kind" IN ('produce_all', 'auto_produce_all')
        AND NEW."state" = 'order_spec_changed'
      THEN
        IF NEW."currentDecisionId" IS NOT NULL
          OR NEW."generation" <> OLD."generation"
          OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
          OR EXISTS (
            SELECT 1 FROM "production_orders"
            WHERE "commercialOrderId" = NEW."orderId"
          )
          OR EXISTS (
            SELECT 1 FROM "warehouse_rolls"
            WHERE "producedByCoverageDecisionId" = OLD."currentDecisionId"
          )
        THEN
          RAISE EXCEPTION 'production decision order-spec invalidation is not exact';
        END IF;
      ELSIF old_decision."kind" = 'produce_all' THEN
        RAISE EXCEPTION 'explicit terminal coverage decision cannot be cleared';
      ELSIF old_decision."kind" = 'auto_produce_all' THEN
        IF NEW."currentDecisionId" IS NOT NULL THEN
          IF OLD."state" <> 'stale'
            OR decision."kind" <> 'auto_produce_all'
            OR NEW."generation" <> OLD."generation" + 1
          THEN
            RAISE EXCEPTION 'stale auto decision replacement is invalid';
          END IF;
        ELSIF NEW."state" = 'recheck_requested' THEN
          IF NEW."generation" <> OLD."generation"
            OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
            OR NOT EXISTS (
              SELECT 1
              FROM "order_resolution_cases"
              WHERE "orderId" = NEW."orderId"
                AND "status" = 'open'
                AND "coverageOrigin" = 'finance_request'
                AND "sourceCoverageCalculationId" = OLD."currentCalculationId"
            )
          THEN
            RAISE EXCEPTION 'finance recheck cannot clear auto decision';
          END IF;
        ELSIF NEW."state" IN ('unknown', 'awaiting_finance') THEN
          IF OLD."state" <> 'stale'
            OR NEW."generation" <> OLD."generation" + 1
            OR NEW."currentCalculationId" IS NOT DISTINCT FROM OLD."currentCalculationId"
            OR (
              NEW."state" = 'unknown'
              AND calculation."availability" <> 'unknown'
            )
            OR (
              NEW."state" = 'awaiting_finance'
              AND calculation."availability" <> 'verified_full'
            )
          THEN
            RAISE EXCEPTION 'refreshed calculation cannot clear stale auto decision';
          END IF;
        ELSE
          RAISE EXCEPTION 'auto decision clear transition is not whitelisted';
        END IF;
      ELSIF old_decision."kind" = 'use_warehouse'
        AND NEW."state" = 'order_spec_changed'
      THEN
        IF NEW."currentDecisionId" IS NOT NULL
          OR NEW."generation" <> OLD."generation"
          OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
          OR EXISTS (
            SELECT 1 FROM "production_orders"
            WHERE "commercialOrderId" = NEW."orderId"
          )
          OR "warehouse_coverage_decision_has_physical_facts"(OLD."currentDecisionId")
        THEN
          RAISE EXCEPTION 'warehouse decision order-spec invalidation is not exact';
        END IF;
      ELSIF old_decision."kind" = 'use_warehouse' THEN
        SELECT EXISTS (
          SELECT 1
          FROM "order_resolution_cases" coverage_case
          WHERE coverage_case."orderId" = NEW."orderId"
            AND coverage_case."status" = 'open'
            AND coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
            AND coverage_case."sourceCoverageDecisionId" = OLD."currentDecisionId"
            AND coverage_case."sourceCoverageCalculationId" = OLD."currentCalculationId"
            AND (
              SELECT count(*)
              FROM "warehouse_coverage_recheck_memberships" membership
              WHERE membership."caseId" = coverage_case."id"
                AND membership."sourceDecisionId" = OLD."currentDecisionId"
                AND membership."sourceKind" = 'decision_match'
            ) = old_decision."expectedRollCount"
            AND NOT EXISTS (
              SELECT 1 FROM "warehouse_rolls"
              WHERE "reservedByCoverageDecisionId" = OLD."currentDecisionId"
            )
            AND EXISTS (
              SELECT 1 FROM "warehouse_acceptance_tasks"
              WHERE "coverageDecisionId" = OLD."currentDecisionId"
                AND "status" = 'exception'
            )
        ) INTO physical_recovery_ok;
        IF NEW."currentDecisionId" IS NOT NULL
          OR NEW."state" <> 'recheck_requested'
          OR NEW."generation" <> OLD."generation"
          OR NEW."currentCalculationId" IS DISTINCT FROM OLD."currentCalculationId"
          OR NOT physical_recovery_ok
        THEN
          RAISE EXCEPTION 'physical recovery state transition is not exact';
        END IF;
      END IF;
    END IF;
  ELSIF NEW."stateVersion" <> 1 THEN
    RAISE EXCEPTION 'initial coverage stateVersion must equal one';
  ELSIF NEW."state" = 'order_spec_changed' THEN
    RAISE EXCEPTION 'order-spec invalidation cannot be an initial state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "warehouse_coverage_assert_decision_set"(decision_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  decision "warehouse_coverage_decisions"%ROWTYPE;
  active_roll_count INTEGER;
  task_id TEXT;
  task_count INTEGER;
  physical_recovery BOOLEAN;
BEGIN
  SELECT * INTO decision
  FROM "warehouse_coverage_decisions"
  WHERE "id" = decision_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_roll_count
  FROM "warehouse_rolls"
  WHERE "reservedByCoverageDecisionId" = decision."id";

  IF decision."kind" <> 'use_warehouse' THEN
    IF active_roll_count <> 0 OR EXISTS (
      SELECT 1
      FROM "warehouse_acceptance_tasks"
      WHERE "coverageDecisionId" = decision."id"
    ) THEN
      RAISE EXCEPTION 'final decision set must be empty for production decision';
    END IF;
    RETURN;
  END IF;

  IF active_roll_count = 0
    AND EXISTS (
      SELECT 1
      FROM "warehouse_coverage_states" state
      WHERE state."orderId" = decision."orderId"
        AND state."state" = 'order_spec_changed'
        AND state."generation" = decision."generation"
        AND state."currentCalculationId" = decision."calculationId"
        AND state."currentDecisionId" IS NULL
    )
    AND (
      SELECT count(*)
      FROM "warehouse_acceptance_tasks" task
      WHERE task."coverageDecisionId" = decision."id"
    ) = 1
    AND EXISTS (
      SELECT 1
      FROM "warehouse_acceptance_tasks" task
      WHERE task."coverageDecisionId" = decision."id"
        AND task."mode" = 'reserve'
        AND task."orderId" = decision."orderId"
        AND task."proposalId" IS NULL
        AND task."positionId" IS NULL
        AND task."status" = 'cancelled'
    )
    AND NOT "warehouse_coverage_decision_has_physical_facts"(decision."id")
  THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM "order_resolution_cases" coverage_case
    WHERE coverage_case."status" = 'open'
      AND coverage_case."coverageOrigin" = 'decision_linked_physical_exception'
      AND coverage_case."sourceCoverageDecisionId" = decision."id"
      AND (
        SELECT count(*)
        FROM "warehouse_coverage_recheck_memberships" membership
        WHERE membership."caseId" = coverage_case."id"
          AND membership."sourceDecisionId" = decision."id"
          AND membership."sourceKind" = 'decision_match'
      ) = decision."expectedRollCount"
      AND NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_matches" match
        WHERE match."calculationId" = decision."calculationId"
          AND NOT EXISTS (
            SELECT 1
            FROM "warehouse_coverage_recheck_memberships" membership
            WHERE membership."caseId" = coverage_case."id"
              AND membership."rollId" = match."rollId"
              AND membership."sourceDecisionId" = decision."id"
              AND membership."sourceKind" = 'decision_match'
          )
      )
  ) INTO physical_recovery;

  IF active_roll_count = 0 AND physical_recovery THEN
    RETURN;
  END IF;
  IF active_roll_count <> decision."expectedRollCount" THEN
    RAISE EXCEPTION 'final decision set expectedRollCount mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "warehouse_coverage_matches" match
    LEFT JOIN "warehouse_rolls" roll
      ON roll."id" = match."rollId"
     AND roll."reservedByCoverageDecisionId" = decision."id"
     AND roll."reservedForOrderId" = decision."orderId"
     AND roll."reservedAt" IS NOT NULL
     AND roll."currentCoverageFactId" = match."coverageFactId"
    WHERE match."calculationId" = decision."calculationId"
      AND roll."id" IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM "warehouse_rolls" roll
    WHERE roll."reservedByCoverageDecisionId" = decision."id"
      AND NOT EXISTS (
        SELECT 1
        FROM "warehouse_coverage_matches" match
        WHERE match."calculationId" = decision."calculationId"
          AND match."rollId" = roll."id"
          AND match."coverageFactId" = roll."currentCoverageFactId"
      )
  ) THEN
    RAISE EXCEPTION 'final decision set roll/match provenance mismatch';
  END IF;

  SELECT count(*)::integer, min("id")
  INTO task_count, task_id
  FROM "warehouse_acceptance_tasks"
  WHERE "coverageDecisionId" = decision."id"
    AND "mode" = 'reserve'
    AND "orderId" = decision."orderId"
    AND "proposalId" IS NULL
    AND "positionId" IS NULL
    AND "status" <> 'exception';
  IF task_count <> 1 THEN
    RAISE EXCEPTION 'final decision set requires exactly one reserve task';
  END IF;
  IF (
    SELECT count(*) FROM "scan_rows" WHERE "taskId" = task_id
  ) <> decision."expectedRollCount"
    OR EXISTS (
      SELECT 1
      FROM "scan_rows" scan
      WHERE scan."taskId" = task_id
        AND (
          scan."fromOrderId" IS DISTINCT FROM decision."orderId"
          OR NOT EXISTS (
            SELECT 1
            FROM "warehouse_rolls" roll
            WHERE roll."reservedByCoverageDecisionId" = decision."id"
              AND roll."rollCode" = scan."rollCode"
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM "warehouse_rolls" roll
      WHERE roll."reservedByCoverageDecisionId" = decision."id"
        AND NOT EXISTS (
          SELECT 1
          FROM "scan_rows" scan
          WHERE scan."taskId" = task_id
            AND scan."rollCode" = roll."rollCode"
        )
    )
  THEN
    RAISE EXCEPTION 'final decision set scan rows do not equal matches';
  END IF;
END;
$$;

CREATE FUNCTION "warehouse_coverage_validate_order_change_retirement"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  retired_decision "warehouse_coverage_decisions"%ROWTYPE;
BEGIN
  IF OLD."currentDecisionId" IS NULL
    OR NEW."currentDecisionId" IS NOT NULL
    OR NEW."state" <> 'order_spec_changed'
  THEN
    RETURN NEW;
  END IF;

  SELECT * INTO retired_decision
  FROM "warehouse_coverage_decisions"
  WHERE "id" = OLD."currentDecisionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retired coverage decision is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "production_orders"
    WHERE "commercialOrderId" = retired_decision."orderId"
  ) OR EXISTS (
    SELECT 1 FROM "warehouse_rolls"
    WHERE "producedByCoverageDecisionId" = OLD."currentDecisionId"
  ) THEN
    RAISE EXCEPTION 'order-spec invalidation cannot retire committed production facts';
  END IF;

  PERFORM "warehouse_coverage_assert_decision_set"(OLD."currentDecisionId");
  IF retired_decision."kind" = 'use_warehouse'
    AND (
      EXISTS (
        SELECT 1 FROM "warehouse_rolls"
        WHERE "reservedByCoverageDecisionId" = OLD."currentDecisionId"
      )
      OR (
        SELECT count(*)
        FROM "warehouse_acceptance_tasks"
        WHERE "coverageDecisionId" = OLD."currentDecisionId"
      ) <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM "warehouse_acceptance_tasks"
        WHERE "coverageDecisionId" = OLD."currentDecisionId"
          AND "mode" = 'reserve'
          AND "orderId" = retired_decision."orderId"
          AND "proposalId" IS NULL
          AND "positionId" IS NULL
          AND "status" = 'cancelled'
      )
      OR "warehouse_coverage_decision_has_physical_facts"(OLD."currentDecisionId")
    )
  THEN
    RAISE EXCEPTION 'warehouse decision retirement is incomplete';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER "warehouse_coverage_order_change_retirement_deferred"
AFTER UPDATE ON "warehouse_coverage_states"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD."currentDecisionId" IS NOT NULL
  AND NEW."currentDecisionId" IS NULL
  AND NEW."state" = 'order_spec_changed'
)
EXECUTE FUNCTION "warehouse_coverage_validate_order_change_retirement"();

COMMIT;
