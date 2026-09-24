BEGIN;

CREATE TABLE "material_price_references" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "rawMaterialDefinitionId" TEXT NOT NULL,
  "priceKopecksPerKg" INTEGER NOT NULL,
  "source" VARCHAR(200) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdById" TEXT,
  "createdByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "material_price_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "material_price_references_price_positive_ck"
    CHECK ("priceKopecksPerKg" > 0),
  CONSTRAINT "material_price_references_source_nonblank_ck"
    CHECK (length(btrim("source")) > 0),
  CONSTRAINT "material_price_references_reason_nonblank_ck"
    CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX "material_price_references_operationKey_key"
  ON "material_price_references"("operationKey");
CREATE UNIQUE INDEX "material_price_references_material_effective_key"
  ON "material_price_references"("rawMaterialDefinitionId", "effectiveFrom");
CREATE INDEX "material_price_references_material_effective_id_idx"
  ON "material_price_references"("rawMaterialDefinitionId", "effectiveFrom", "id");
ALTER TABLE "material_price_references"
  ADD CONSTRAINT "material_price_references_rawMaterialDefinitionId_fkey"
  FOREIGN KEY ("rawMaterialDefinitionId") REFERENCES "raw_material_definitions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "additional_production_costs" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "rollDispatchItemId" TEXT,
  "productionOrderId" TEXT,
  "allocationBasis" VARCHAR(32) NOT NULL,
  "amountKopecks" INTEGER NOT NULL,
  "source" VARCHAR(200) NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdById" TEXT,
  "createdByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "additional_production_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "additional_production_costs_amount_nonnegative_ck"
    CHECK ("amountKopecks" >= 0),
  CONSTRAINT "additional_production_costs_source_nonblank_ck"
    CHECK (length(btrim("source")) > 0),
  CONSTRAINT "additional_production_costs_reason_nonblank_ck"
    CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "additional_production_costs_target_ck"
    CHECK (
      ("rollDispatchItemId" IS NOT NULL AND "productionOrderId" IS NULL
        AND "allocationBasis" = 'direct')
      OR
      ("rollDispatchItemId" IS NULL AND "productionOrderId" IS NOT NULL
        AND "allocationBasis" = 'finished_net_kg')
    )
);

CREATE UNIQUE INDEX "additional_production_costs_operationKey_key"
  ON "additional_production_costs"("operationKey");
CREATE INDEX "additional_production_costs_roll_effective_id_idx"
  ON "additional_production_costs"("rollDispatchItemId", "effectiveAt", "id");
CREATE INDEX "additional_production_costs_order_effective_id_idx"
  ON "additional_production_costs"("productionOrderId", "effectiveAt", "id");
ALTER TABLE "additional_production_costs"
  ADD CONSTRAINT "additional_production_costs_rollDispatchItemId_fkey"
  FOREIGN KEY ("rollDispatchItemId") REFERENCES "roll_dispatch_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "additional_production_costs"
  ADD CONSTRAINT "additional_production_costs_productionOrderId_fkey"
  FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
