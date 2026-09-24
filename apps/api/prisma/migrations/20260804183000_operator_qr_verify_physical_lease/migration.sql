-- QR verification is physical scanner I/O and therefore uses the same fenced lease as scale
-- reads and label printing. Refuse to reinterpret an ambiguous in-flight legacy scan.
BEGIN;

LOCK TABLE "operator_roll_operations" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "operator_roll_operations"
    WHERE "action" = 'qr_verify'
      AND "status" = 'in_progress'
      AND (
        "attempt" < 1
        OR "leaseToken" IS NULL
        OR "leaseExpiresAt" IS NULL
        OR "completedAt" IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'Unfenced in-progress QR verification exists; reconcile it before migration';
  END IF;
END $$;

-- The previous constraint classifies qr_verify as non-physical and therefore requires
-- attempt=0. Remove it inside the same transaction before backfilling terminal QR rows;
-- otherwise the backfill violates the very constraint this migration replaces.
ALTER TABLE "operator_roll_operations"
  DROP CONSTRAINT "operator_roll_operations_physical_lease_check";

UPDATE "operator_roll_operations"
SET "attempt" = 1
WHERE "action" = 'qr_verify'
  AND "status" <> 'in_progress'
  AND "attempt" = 0;

ALTER TABLE "operator_roll_operations"
  ADD CONSTRAINT "operator_roll_operations_physical_lease_check"
    CHECK (
      (
        "action" IN (
          'spool_weight',
          'roll_weight',
          'roll_reweigh',
          'defect',
          'qr_print',
          'qr_verify'
        )
        AND "attempt" >= 1
        AND (
          (
            "status" = 'in_progress'
            AND "leaseToken" IS NOT NULL
            AND "leaseExpiresAt" IS NOT NULL
            AND "completedAt" IS NULL
          )
          OR
          (
            "status" <> 'in_progress'
            AND "leaseToken" IS NULL
            AND "leaseExpiresAt" IS NULL
          )
        )
      )
      OR
      (
        "action" NOT IN (
          'spool_weight',
          'roll_weight',
          'roll_reweigh',
          'defect',
          'qr_print',
          'qr_verify'
        )
        AND "attempt" = 0
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
      )
    );

COMMIT;
