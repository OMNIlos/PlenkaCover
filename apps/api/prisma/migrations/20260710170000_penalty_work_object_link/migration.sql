ALTER TABLE "penalties"
ADD COLUMN "sourceProductionOrderId" TEXT,
ADD COLUMN "sourceOrderNumber" TEXT,
ADD COLUMN "sourceRollCode" TEXT;

CREATE INDEX "penalties_sourceProductionOrderId_idx"
ON "penalties"("sourceProductionOrderId");
