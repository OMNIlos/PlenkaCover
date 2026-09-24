ALTER TABLE "warehouse_rolls"
ADD COLUMN "receivedAt" TIMESTAMP(3);

UPDATE "warehouse_rolls"
SET "receivedAt" = "updatedAt"
WHERE "receivedAt" IS NULL
  AND "warehouseStatus" IN ('received', 'delivered', 'shipped');
