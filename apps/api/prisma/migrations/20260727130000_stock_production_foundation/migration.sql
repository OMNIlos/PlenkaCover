BEGIN;

-- Application validation keeps counterparties mandatory for client orders.
ALTER TABLE "commercial_orders" ALTER COLUMN "counterpartyId" DROP NOT NULL;
ALTER TABLE "commercial_orders" ADD COLUMN "stockBatchCode" TEXT;

ALTER TABLE "warehouse_rolls"
  ADD COLUMN "producedForStockOrderId" TEXT;

CREATE UNIQUE INDEX "commercial_orders_stockBatchCode_key"
  ON "commercial_orders"("stockBatchCode");
CREATE INDEX "commercial_orders_requestType_stockBatchCode_idx"
  ON "commercial_orders"("requestType", "stockBatchCode");
CREATE INDEX "warehouse_rolls_producedForStockOrderId_warehouseStatus_idx"
  ON "warehouse_rolls"("producedForStockOrderId", "warehouseStatus");

ALTER TABLE "warehouse_rolls"
  ADD CONSTRAINT "warehouse_rolls_producedForStockOrderId_fkey"
  FOREIGN KEY ("producedForStockOrderId") REFERENCES "commercial_orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
