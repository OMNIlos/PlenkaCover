BEGIN;

-- Keep the physical spool-return ledger when its order-scoped defect projection is purged.
-- Quantity, tare, spool type and location remain immutable facts; only provenance is detached.
ALTER TABLE "spool_stock_movements"
  DROP CONSTRAINT "spool_stock_movements_defectRecordId_fkey";

ALTER TABLE "spool_stock_movements"
  ALTER COLUMN "defectRecordId" DROP NOT NULL;

ALTER TABLE "spool_stock_movements"
  ADD CONSTRAINT "spool_stock_movements_defectRecordId_fkey"
  FOREIGN KEY ("defectRecordId") REFERENCES "defect_records"("id")
  ON DELETE SET NULL ON UPDATE RESTRICT;

COMMIT;
