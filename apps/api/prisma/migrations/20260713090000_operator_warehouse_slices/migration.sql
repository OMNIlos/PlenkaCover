-- Operator + warehouse slices (design 2026-07-13): big-bag lifecycle, shift bag usage,
-- intake operation codes, pallet payload snapshot, deferred-step restore.

-- BigBagUnit: warehouse-created card + lifecycle status
ALTER TABLE "big_bag_units" ADD COLUMN "materialId" TEXT;
ALTER TABLE "big_bag_units" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'available';
ALTER TABLE "big_bag_units" ADD COLUMN "initialKg" DOUBLE PRECISION;
ALTER TABLE "big_bag_units" ADD COLUMN "createdByRole" "Role";
ALTER TABLE "big_bag_units" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ShiftBagUsage: bags taken into an operator post-session
CREATE TABLE "shift_bag_usages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "bigBagId" TEXT NOT NULL,
    "startKg" DOUBLE PRECISION NOT NULL,
    "endKg" DOUBLE PRECISION,
    "addedReason" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "shift_bag_usages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shift_bag_usages_sessionId_bigBagId_key" ON "shift_bag_usages"("sessionId", "bigBagId");
CREATE INDEX "shift_bag_usages_bigBagId_idx" ON "shift_bag_usages"("bigBagId");

ALTER TABLE "shift_bag_usages" ADD CONSTRAINT "shift_bag_usages_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "operator_post_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "shift_bag_usages" ADD CONSTRAINT "shift_bag_usages_bigBagId_fkey"
    FOREIGN KEY ("bigBagId") REFERENCES "big_bag_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WarehouseAcceptanceTask: searchable operation code (ПР-ДДММ-NN)
ALTER TABLE "warehouse_acceptance_tasks" ADD COLUMN "operationCode" TEXT;
CREATE UNIQUE INDEX "warehouse_acceptance_tasks_operationCode_key" ON "warehouse_acceptance_tasks"("operationCode");

-- ScanRow: «Собрал» attribution
ALTER TABLE "scan_rows" ADD COLUMN "scannedByName" TEXT;

-- PalletListDocument: draft field-set snapshot
ALTER TABLE "pallet_list_documents" ADD COLUMN "payload" JSONB;

-- OperatorRollLine: restore step for deferred rolls
ALTER TABLE "operator_roll_lines" ADD COLUMN "deferredFromStep" TEXT;
