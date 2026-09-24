ALTER TABLE "big_bag_units" ADD COLUMN "batchCode" TEXT;

CREATE INDEX "big_bag_units_batchCode_idx" ON "big_bag_units"("batchCode");
