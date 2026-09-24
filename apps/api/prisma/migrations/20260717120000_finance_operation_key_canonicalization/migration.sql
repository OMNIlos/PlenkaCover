BEGIN;

LOCK TABLE "payment_operations", "sync_journals" IN SHARE ROW EXCLUSIVE MODE;

-- A case-colliding pair can represent duplicate money or two external pulls. Choosing a winner
-- automatically would destroy disputed facts, so an affected upgrade fails atomically and requires
-- explicit reconciliation before it can be deployed again.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "payment_operations"
    GROUP BY "financeOrderId", lower("operationKey")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'case-colliding payment operation keys require explicit financial reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "sync_journals"
    WHERE "operationKey" IS NOT NULL
    GROUP BY lower("operationKey")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'case-colliding source retry operation keys require explicit integration reconciliation';
  END IF;
END
$$;

UPDATE "payment_operations"
SET "operationKey" = lower("operationKey")
WHERE "operationKey" <> lower("operationKey");

UPDATE "sync_journals"
SET "operationKey" = lower("operationKey")
WHERE "operationKey" IS NOT NULL
  AND "operationKey" <> lower("operationKey");

ALTER TABLE "payment_operations"
  ADD CONSTRAINT "payment_operations_operationKey_lowercase_check"
  CHECK ("operationKey" = lower("operationKey"));

ALTER TABLE "sync_journals"
  ADD CONSTRAINT "sync_journals_operationKey_lowercase_check"
  CHECK ("operationKey" IS NULL OR "operationKey" = lower("operationKey"));

COMMIT;
