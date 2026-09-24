ALTER TABLE "production_problems"
  ADD COLUMN "type" TEXT NOT NULL DEFAULT 'general',
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedById" TEXT;

ALTER TABLE "roll_dispatch_items"
  ADD COLUMN "positionSequence" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rawMaterialId" TEXT,
  ADD COLUMN "recipeVersion" TEXT;

UPDATE "roll_dispatch_items"
SET "rawMaterialId" = "characteristicsSnapshot"->>'rawMaterialId'
WHERE "characteristicsSnapshot" IS NOT NULL;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "productionOrderId", COALESCE("orderLineId", "id")
      ORDER BY "queueRank", "createdAt", "id"
    )::INTEGER AS position_sequence
  FROM "roll_dispatch_items"
)
UPDATE "roll_dispatch_items" AS item
SET "positionSequence" = ranked.position_sequence
FROM ranked
WHERE ranked."id" = item."id";

CREATE INDEX "production_problems_type_status_idx"
  ON "production_problems"("type", "status");
CREATE INDEX "roll_dispatch_items_orderLineId_positionSequence_idx"
  ON "roll_dispatch_items"("orderLineId", "positionSequence");
