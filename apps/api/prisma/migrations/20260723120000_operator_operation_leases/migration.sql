-- Physical operator operations commit their idempotency claim before USB/gateway I/O.
-- A bounded lease makes a crashed scale request retryable while a token fences the old worker.
BEGIN;

LOCK TABLE "operator_roll_operations" IN SHARE ROW EXCLUSIVE MODE;

-- An in-flight legacy physical operation has no fencing token. Refuse to guess whether a
-- printer side effect happened or whether a scale request still owns the physical scene.
-- The maintenance runbook must reconcile/close these rows before retrying this migration.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "operator_roll_operations"
    WHERE "status" = 'in_progress'
      AND "action" IN ('spool_weight', 'roll_weight', 'roll_reweigh', 'defect', 'qr_print')
  ) THEN
    RAISE EXCEPTION
      'Unfenced in-progress operator physical operations exist; reconcile them before migration';
  END IF;
END $$;

ALTER TABLE "operator_roll_operations"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Historic terminal physical operations represent one completed attempt.
UPDATE "operator_roll_operations"
SET "attempt" = 1
WHERE "action" IN ('spool_weight', 'roll_weight', 'roll_reweigh', 'defect', 'qr_print');

ALTER TABLE "operator_roll_operations"
  ADD CONSTRAINT "operator_roll_operations_attempt_check"
    CHECK ("attempt" >= 0),
  ADD CONSTRAINT "operator_roll_operations_physical_lease_check"
    CHECK (
      (
        "action" IN ('spool_weight', 'roll_weight', 'roll_reweigh', 'defect', 'qr_print')
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
        "action" NOT IN ('spool_weight', 'roll_weight', 'roll_reweigh', 'defect', 'qr_print')
        AND "attempt" = 0
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
      )
    );

CREATE INDEX "operator_roll_operations_status_leaseExpiresAt_idx"
  ON "operator_roll_operations"("status", "leaseExpiresAt");

COMMIT;
