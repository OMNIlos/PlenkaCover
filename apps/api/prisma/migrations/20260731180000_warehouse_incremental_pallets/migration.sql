BEGIN;

CREATE TABLE "warehouse_pallets" (
  "id" TEXT NOT NULL,
  "palletCode" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sequenceNo" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "closeRequestId" UUID,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedById" TEXT,
  "sealedAt" TIMESTAMP(3),
  "sealedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "warehouse_pallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_pallets_status_check"
    CHECK ("status" IN ('open', 'sealed')),
  CONSTRAINT "warehouse_pallets_seal_state_check"
    CHECK (
      ("status" = 'open' AND "closeRequestId" IS NULL AND "sealedAt" IS NULL)
      OR
      ("status" = 'sealed' AND "closeRequestId" IS NOT NULL AND "sealedAt" IS NOT NULL)
    )
);

CREATE TABLE "warehouse_pallet_items" (
  "id" TEXT NOT NULL,
  "palletId" TEXT NOT NULL,
  "scanRowId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "rollCode" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "assignedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "warehouse_pallet_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_pallet_items_position_check" CHECK ("position" > 0)
);

ALTER TABLE "pallet_list_documents"
  ADD COLUMN "warehousePalletId" TEXT,
  ADD COLUMN "acceptanceTaskId" TEXT,
  ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE "pallet_list_documents"
  ADD CONSTRAINT "pallet_list_documents_origin_check"
  CHECK ("origin" IN ('legacy', 'physical_pallet'));

CREATE UNIQUE INDEX "warehouse_pallets_palletCode_key"
  ON "warehouse_pallets"("palletCode");
CREATE UNIQUE INDEX "warehouse_pallets_closeRequestId_key"
  ON "warehouse_pallets"("closeRequestId");
CREATE UNIQUE INDEX "warehouse_pallets_id_order_id_key"
  ON "warehouse_pallets"("id", "orderId");
CREATE UNIQUE INDEX "warehouse_pallets_order_id_sequence_no_key"
  ON "warehouse_pallets"("orderId", "sequenceNo");
CREATE INDEX "warehouse_pallets_task_id_status_idx"
  ON "warehouse_pallets"("taskId", "status");
CREATE UNIQUE INDEX "warehouse_pallets_one_open_per_task_uq"
  ON "warehouse_pallets"("taskId")
  WHERE "status" = 'open';

CREATE UNIQUE INDEX "warehouse_pallet_items_scan_row_id_key"
  ON "warehouse_pallet_items"("scanRowId");
CREATE UNIQUE INDEX "warehouse_pallet_items_pallet_id_position_key"
  ON "warehouse_pallet_items"("palletId", "position");
CREATE INDEX "warehouse_pallet_items_pallet_id_accepted_at_idx"
  ON "warehouse_pallet_items"("palletId", "acceptedAt");

CREATE UNIQUE INDEX "pallet_list_documents_warehousePalletId_key"
  ON "pallet_list_documents"("warehousePalletId");
CREATE INDEX "pallet_list_documents_task_created_at_idx"
  ON "pallet_list_documents"("acceptanceTaskId", "createdAt");

ALTER TABLE "warehouse_pallets"
  ADD CONSTRAINT "warehouse_pallets_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "warehouse_acceptance_tasks"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_pallets"
  ADD CONSTRAINT "warehouse_pallets_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_pallet_items"
  ADD CONSTRAINT "warehouse_pallet_items_palletId_orderId_fkey"
  FOREIGN KEY ("palletId", "orderId") REFERENCES "warehouse_pallets"("id", "orderId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_pallet_items"
  ADD CONSTRAINT "warehouse_pallet_items_scanRowId_fkey"
  FOREIGN KEY ("scanRowId") REFERENCES "scan_rows"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pallet_list_documents"
  ADD CONSTRAINT "pallet_list_documents_warehousePalletId_fkey"
  FOREIGN KEY ("warehousePalletId") REFERENCES "warehouse_pallets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pallet_list_documents"
  ADD CONSTRAINT "pallet_list_documents_acceptanceTaskId_fkey"
  FOREIGN KEY ("acceptanceTaskId") REFERENCES "warehouse_acceptance_tasks"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
