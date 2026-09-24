-- Additive nullable facts: legacy Big-Bags stay honestly unknown until a warehouse
-- supplier snapshot or a confirmed registration scan exists.
ALTER TABLE "big_bag_units"
  ADD COLUMN "supplierName" TEXT,
  ADD COLUMN "receivedAt" TIMESTAMP(3);
