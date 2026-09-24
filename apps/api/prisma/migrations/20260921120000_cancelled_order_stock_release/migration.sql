BEGIN;

ALTER TABLE "warehouse_rolls" ADD COLUMN "releasedFromOrderId" TEXT;
ALTER TABLE "warehouse_rolls" ADD CONSTRAINT "warehouse_rolls_releasedFromOrderId_fkey"
  FOREIGN KEY ("releasedFromOrderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT;
CREATE INDEX "warehouse_rolls_releasedFromOrderId_warehouseStatus_idx"
  ON "warehouse_rolls"("releasedFromOrderId", "warehouseStatus");

ALTER TABLE "warehouse_roll_coverage_facts" DROP CONSTRAINT "warehouse_coverage_facts_source_ck";
ALTER TABLE "warehouse_roll_coverage_facts" ADD CONSTRAINT "warehouse_coverage_facts_source_ck"
  CHECK ("source" IN ('production_handover', 'warehouse_recheck', 'migration_backfill', 'manual_platform', 'order_cancellation'));

CREATE FUNCTION "warehouse_coverage_validate_cancellation_fact"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW."source" <> 'order_cancellation' THEN RETURN NEW; END IF;
  IF NEW."actorKind" <> 'user' OR NEW."reason" IS NULL
    OR char_length(btrim(NEW."reason")) NOT BETWEEN 3 AND 500
    OR NEW."spec" -> 'ownerCounterpartyId' IS DISTINCT FROM 'null'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM "warehouse_rolls" roll
      JOIN "warehouse_roll_coverage_facts" previous ON previous."id" = roll."currentCoverageFactId"
      JOIN "commercial_orders" source_order ON source_order."id" = NEW."sourceOrderId"
      WHERE roll."id" = NEW."rollId" AND roll."releasedFromOrderId" IS NULL
        AND previous."sourceOrderId" = source_order."id"
        AND source_order."cancellationStatus" = 'cancelled'
        AND NEW."version" = previous."version" + 1
        AND (NEW."spec" - 'ownerCounterpartyId') = (previous."spec" - 'ownerCounterpartyId')
    ) THEN RAISE EXCEPTION 'invalid cancelled-order ownership fact'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "warehouse_roll_coverage_facts_cancellation_validate_insert"
  BEFORE INSERT ON "warehouse_roll_coverage_facts" FOR EACH ROW
  EXECUTE FUNCTION "warehouse_coverage_validate_cancellation_fact"();

CREATE FUNCTION "warehouse_roll_validate_stock_release"() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."releasedFromOrderId" IS NOT NULL
    AND NEW."releasedFromOrderId" IS DISTINCT FROM OLD."releasedFromOrderId"
    THEN RAISE EXCEPTION 'cancelled-order stock release provenance is immutable'; END IF;
  IF NEW."releasedFromOrderId" IS NULL THEN RETURN NEW; END IF;
  IF NEW."ownerCounterpartyId" IS NOT NULL OR NEW."producedForStockOrderId" IS NOT NULL
    OR (NEW."producedForOrderId" IS NOT NULL AND NEW."producedForOrderId" <> NEW."releasedFromOrderId")
    OR NOT EXISTS (
      SELECT 1 FROM "commercial_orders" source_order
      JOIN "production_orders" production ON production."commercialOrderId" = source_order."id"
      JOIN "roll_dispatch_items" dispatch ON dispatch."productionOrderId" = production."id"
      WHERE source_order."id" = NEW."releasedFromOrderId"
        AND source_order."cancellationStatus" = 'cancelled'
        AND source_order."requestType" = 'client_order'
        AND dispatch."rollCode" = NEW."rollCode"
    ) THEN RAISE EXCEPTION 'invalid cancelled-order stock release'; END IF;
  IF NEW."currentCoverageFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "warehouse_roll_coverage_facts" fact
    WHERE fact."id" = NEW."currentCoverageFactId" AND fact."rollId" = NEW."id"
      AND fact."sourceOrderId" = NEW."releasedFromOrderId"
      AND fact."spec" -> 'ownerCounterpartyId' = 'null'::jsonb
  ) THEN RAISE EXCEPTION 'stock release must retain canonical origin and company ownership'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "warehouse_roll_validate_stock_release"
  BEFORE INSERT OR UPDATE ON "warehouse_rolls" FOR EACH ROW
  EXECUTE FUNCTION "warehouse_roll_validate_stock_release"();

CREATE OR REPLACE FUNCTION "warehouse_roll_validate_production_provenance"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  provenance_count INTEGER;
  initial_link BOOLEAN := TRUE;
BEGIN
  provenance_count :=
    (NEW."producedForOrderId" IS NOT NULL)::integer
    + (NEW."producedForPositionId" IS NOT NULL)::integer
    + (NEW."producedByCoverageDecisionId" IS NOT NULL)::integer;

  IF provenance_count NOT IN (0, 3) THEN
    RAISE EXCEPTION 'client production provenance must be all-or-none';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    initial_link :=
      OLD."producedForOrderId" IS NULL
      AND OLD."producedForPositionId" IS NULL
      AND OLD."producedByCoverageDecisionId" IS NULL;
    IF NOT initial_link
      AND (
        NEW."producedForOrderId" IS DISTINCT FROM OLD."producedForOrderId"
        OR NEW."producedForPositionId" IS DISTINCT FROM OLD."producedForPositionId"
        OR NEW."producedByCoverageDecisionId"
          IS DISTINCT FROM OLD."producedByCoverageDecisionId"
      )
    THEN
      RAISE EXCEPTION 'client production provenance is immutable';
    END IF;
  END IF;

  IF provenance_count = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW."producedForStockOrderId" IS NOT NULL
    OR (NEW."releasedFromOrderId" IS NULL AND (
    NEW."reservedForOrderId" IS NOT NULL
    OR NEW."reservedForPositionId" IS NOT NULL
    OR NEW."reservedByProposalId" IS NOT NULL
    OR NEW."reservedByCoverageDecisionId" IS NOT NULL
    OR NEW."reservedAt" IS NOT NULL))
  THEN
    RAISE EXCEPTION 'client production provenance cannot overlap stock or reservation provenance';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "warehouse_roll_coverage_facts" AS fact
    JOIN "roll_dispatch_items" AS dispatch
      ON dispatch."id" = fact."sourceDispatchItemId"
     AND dispatch."rollCode" = NEW."rollCode"
    JOIN "production_orders" AS production
      ON production."id" = dispatch."productionOrderId"
    JOIN "commercial_orders" AS order_row
      ON order_row."id" = production."commercialOrderId"
    JOIN "commercial_order_positions" AS position
      ON position."id" = dispatch."orderLineId"
     AND position."orderId" = production."commercialOrderId"
    JOIN "warehouse_coverage_decisions" AS decision
      ON decision."id" = production."sourceCoverageDecisionId"
    WHERE fact."rollId" = NEW."id"
      AND fact."source" = 'production_handover'
      AND fact."sourceOrderId" = NEW."producedForOrderId"
      AND fact."sourcePositionId" = NEW."producedForPositionId"
      AND dispatch."orderLineId" = NEW."producedForPositionId"
      AND production."commercialOrderId" = NEW."producedForOrderId"
      AND production."sourceCoverageDecisionId" = NEW."producedByCoverageDecisionId"
      AND order_row."warehouseCoverageWorkflowVersion" = 2
      AND order_row."requestType" <> 'stock_reserve'
      AND decision."orderId" = NEW."producedForOrderId"
      AND decision."id" = NEW."producedByCoverageDecisionId"
      AND decision."kind" IN ('produce_all', 'auto_produce_all')
      AND (NOT initial_link OR fact."id" = NEW."currentCoverageFactId")
  ) THEN
    RAISE EXCEPTION 'client production provenance does not match its canonical handover fact';
  END IF;

  RETURN NEW;
END;
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
            AND (state."currentDecisionId" IS NULL OR (
              state."currentDecisionId" = decision."id" AND EXISTS (
                SELECT 1 FROM "commercial_orders" cancelled_order
                WHERE cancelled_order."id" = decision."orderId"
                  AND cancelled_order."cancellationStatus" = 'cancelled'
              )
            ))
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
            AND (NOT "warehouse_coverage_decision_has_physical_facts"(decision."id") OR EXISTS (
              SELECT 1 FROM "commercial_orders" cancelled_order
              WHERE cancelled_order."id" = decision."orderId"
                AND cancelled_order."cancellationStatus" = 'cancelled'
            ))
        )
      )
    THEN
      RAISE EXCEPTION 'physical recovery must clear an exact decision reservation set';
    END IF;
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
        AND (state."currentDecisionId" IS NULL OR (
          state."currentDecisionId" = decision."id" AND EXISTS (
            SELECT 1 FROM "commercial_orders" cancelled_order
            WHERE cancelled_order."id" = decision."orderId"
              AND cancelled_order."cancellationStatus" = 'cancelled'
          )
        ))
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
    AND (NOT "warehouse_coverage_decision_has_physical_facts"(decision."id") OR EXISTS (
      SELECT 1 FROM "commercial_orders" cancelled_order
      WHERE cancelled_order."id" = decision."orderId"
        AND cancelled_order."cancellationStatus" = 'cancelled'
    ))
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

COMMIT;
