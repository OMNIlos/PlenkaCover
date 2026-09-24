BEGIN;

ALTER TABLE "warehouse_rolls"
  ADD COLUMN "producedForOrderId" TEXT,
  ADD COLUMN "producedForPositionId" TEXT,
  ADD COLUMN "producedByCoverageDecisionId" UUID;

DROP TRIGGER "warehouse_rolls_coverage_epoch_update" ON "warehouse_rolls";

CREATE TRIGGER "warehouse_rolls_coverage_epoch_update"
BEFORE UPDATE OF
  "rollCode",
  "warehouseStatus",
  "ownerCounterpartyId",
  "reservedForOrderId",
  "reservedForPositionId",
  "reservedByProposalId",
  "reservedAt",
  "currentCoverageFactId",
  "reservedByCoverageDecisionId",
  "producedForOrderId",
  "producedForPositionId",
  "producedByCoverageDecisionId"
ON "warehouse_rolls"
FOR EACH STATEMENT EXECUTE FUNCTION "warehouse_coverage_bump_epoch_statement"();

CREATE TEMP TABLE "_warehouse_roll_production_origins"
ON COMMIT DROP
AS
SELECT DISTINCT
  roll."id" AS "rollId",
  roll."rollCode" AS "rollCode",
  production."commercialOrderId" AS "orderId",
  dispatch."orderLineId" AS "positionId",
  production."sourceCoverageDecisionId" AS "decisionId"
FROM "warehouse_rolls" AS roll
JOIN "warehouse_roll_coverage_facts" AS fact
  ON fact."rollId" = roll."id"
JOIN "roll_dispatch_items" AS dispatch
  ON dispatch."id" = fact."sourceDispatchItemId"
 AND dispatch."rollCode" = roll."rollCode"
JOIN "production_orders" AS production
  ON production."id" = dispatch."productionOrderId"
JOIN "commercial_orders" AS order_row
  ON order_row."id" = production."commercialOrderId"
JOIN "commercial_order_positions" AS position
  ON position."id" = dispatch."orderLineId"
 AND position."orderId" = production."commercialOrderId"
JOIN "warehouse_coverage_decisions" AS decision
  ON decision."id" = production."sourceCoverageDecisionId"
WHERE fact."source" = 'production_handover'
  AND fact."sourceOrderId" = production."commercialOrderId"
  AND fact."sourcePositionId" = dispatch."orderLineId"
  AND order_row."warehouseCoverageWorkflowVersion" = 2
  AND order_row."requestType" <> 'stock_reserve'
  AND dispatch."orderLineId" IS NOT NULL
  AND production."sourceCoverageDecisionId" IS NOT NULL
  AND decision."orderId" = production."commercialOrderId"
  AND decision."kind" IN ('produce_all', 'auto_produce_all');

DO $$
DECLARE
  conflict_row RECORD;
BEGIN
  SELECT
    origin."rollId",
    min(origin."rollCode") AS "rollCode",
    count(*) AS "originCount"
  INTO conflict_row
  FROM "_warehouse_roll_production_origins" AS origin
  GROUP BY origin."rollId"
  HAVING count(*) <> 1
  ORDER BY origin."rollId" COLLATE "C"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Unsafe finished-roll provenance upgrade: production origin is ambiguous',
      DETAIL = format(
        'rollId=%s rollCode=%s originCount=%s',
        conflict_row."rollId",
        conflict_row."rollCode",
        conflict_row."originCount"
      ),
      HINT = 'Resolve duplicate production_handover origins before retrying the migration.';
  END IF;

  SELECT
    roll."id" AS "rollId",
    roll."rollCode" AS "rollCode",
    origin."orderId" AS "sourceOrderId",
    origin."positionId" AS "sourcePositionId",
    origin."decisionId" AS "sourceDecisionId",
    roll."producedForStockOrderId",
    roll."reservedForOrderId",
    roll."reservedForPositionId",
    roll."reservedByProposalId",
    roll."reservedByCoverageDecisionId",
    roll."reservedAt"
  INTO conflict_row
  FROM "_warehouse_roll_production_origins" AS origin
  JOIN "warehouse_rolls" AS roll
    ON roll."id" = origin."rollId"
  WHERE roll."producedForStockOrderId" IS NOT NULL
    OR roll."reservedByProposalId" IS NOT NULL
    OR NOT (
      (
        roll."reservedForOrderId" IS NULL
        AND roll."reservedForPositionId" IS NULL
        AND roll."reservedByCoverageDecisionId" IS NULL
        AND roll."reservedAt" IS NULL
      )
      OR (
        roll."reservedForOrderId" IS NOT DISTINCT FROM origin."orderId"
        AND roll."reservedForPositionId" IS NOT DISTINCT FROM origin."positionId"
        AND roll."reservedByCoverageDecisionId" IS NOT DISTINCT FROM origin."decisionId"
        AND roll."reservedAt" IS NOT NULL
      )
    )
  ORDER BY roll."id" COLLATE "C"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE =
        'Unsafe finished-roll provenance upgrade: production roll ownership conflicts',
      DETAIL = format(
        'rollId=%s rollCode=%s sourceOrderId=%s sourcePositionId=%s sourceDecisionId=%s reservedForOrderId=%s reservedForPositionId=%s reservedByCoverageDecisionId=%s producedForStockOrderId=%s',
        conflict_row."rollId",
        conflict_row."rollCode",
        conflict_row."sourceOrderId",
        conflict_row."sourcePositionId",
        conflict_row."sourceDecisionId",
        coalesce(conflict_row."reservedForOrderId", '<null>'),
        coalesce(conflict_row."reservedForPositionId", '<null>'),
        coalesce(conflict_row."reservedByCoverageDecisionId"::text, '<null>'),
        coalesce(conflict_row."producedForStockOrderId", '<null>')
      ),
      HINT =
        'Reconcile this roll to its exact source order, position, and production decision before retrying.';
  END IF;
END;
$$;

ALTER TABLE "warehouse_rolls"
  DISABLE TRIGGER "warehouse_rolls_coverage_validate_write";

UPDATE "warehouse_rolls" AS roll
SET
  "producedForOrderId" = origin."orderId",
  "producedForPositionId" = origin."positionId",
  "producedByCoverageDecisionId" = origin."decisionId",
  "reservedForOrderId" = NULL,
  "reservedForPositionId" = NULL,
  "reservedByProposalId" = NULL,
  "reservedByCoverageDecisionId" = NULL,
  "reservedAt" = NULL
FROM "_warehouse_roll_production_origins" AS origin
WHERE origin."rollId" = roll."id";

ALTER TABLE "warehouse_rolls"
  ENABLE TRIGGER "warehouse_rolls_coverage_validate_write";

ALTER TABLE "warehouse_rolls"
  ADD CONSTRAINT "warehouse_rolls_produced_for_order_fkey"
    FOREIGN KEY ("producedForOrderId")
    REFERENCES "commercial_orders"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_rolls_produced_for_position_fkey"
    FOREIGN KEY ("producedForPositionId")
    REFERENCES "commercial_order_positions"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  ADD CONSTRAINT "warehouse_rolls_produced_by_coverage_decision_fkey"
    FOREIGN KEY ("producedByCoverageDecisionId")
    REFERENCES "warehouse_coverage_decisions"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

CREATE INDEX "warehouse_rolls_client_production_idx"
  ON "warehouse_rolls"(
    "producedForOrderId",
    "warehouseStatus",
    "producedByCoverageDecisionId",
    "rollCode"
  );

CREATE FUNCTION "warehouse_roll_validate_production_provenance"()
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
    OR NEW."reservedForOrderId" IS NOT NULL
    OR NEW."reservedForPositionId" IS NOT NULL
    OR NEW."reservedByProposalId" IS NOT NULL
    OR NEW."reservedByCoverageDecisionId" IS NOT NULL
    OR NEW."reservedAt" IS NOT NULL
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

CREATE TRIGGER "warehouse_rolls_validate_production_provenance"
BEFORE INSERT OR UPDATE ON "warehouse_rolls"
FOR EACH ROW EXECUTE FUNCTION "warehouse_roll_validate_production_provenance"();

COMMIT;
