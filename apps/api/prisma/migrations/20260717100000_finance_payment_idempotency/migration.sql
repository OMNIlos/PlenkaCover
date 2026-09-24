-- Every payment operation needs a durable idempotency key. Existing operations receive
-- deterministic UUIDv4-shaped keys so the migration is safe on an already seeded/test VPS.
ALTER TABLE "payment_operations" ADD COLUMN "operationKey" TEXT;

WITH legacy_keys AS (
  SELECT
    "id",
    md5('legacy-payment-operation:' || "id") AS hash
  FROM "payment_operations"
)
UPDATE "payment_operations" AS operation
SET "operationKey" =
  substr(legacy.hash, 1, 8) || '-' ||
  substr(legacy.hash, 9, 4) || '-' ||
  '4' || substr(legacy.hash, 14, 3) || '-' ||
  '8' || substr(legacy.hash, 18, 3) || '-' ||
  substr(legacy.hash, 21, 12)
FROM legacy_keys AS legacy
WHERE operation."id" = legacy."id";

ALTER TABLE "payment_operations" ALTER COLUMN "operationKey" SET NOT NULL;

CREATE UNIQUE INDEX "payment_operations_financeOrderId_operationKey_key"
ON "payment_operations"("financeOrderId", "operationKey");
