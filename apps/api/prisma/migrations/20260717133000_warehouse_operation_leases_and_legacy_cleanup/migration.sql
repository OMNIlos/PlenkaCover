-- Remove legacy scanner observations from business storage. Before the opaque-token boundary,
-- rejected scanner bytes were persisted in scan_rows.rollCode. Rejected observations are now
-- represented by append-only safe audit facts and must not remain in business tables/backups.
DELETE FROM "scan_rows"
WHERE "scanStatus" NOT IN ('expected', 'accepted', 'reserved', 'damaged');

ALTER TABLE "warehouse_operations"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "warehouse_operations"
  DROP CONSTRAINT "warehouse_operations_status_check";

-- A process that was interrupted while the preceding migration version was active cannot prove
-- whether its external scale read completed. Terminalize that unleased two-phase claim instead of
-- leaving the roll blocked forever or fabricating a captured weight.
UPDATE "warehouse_operations"
SET
  "status" = 'expired',
  "errorCode" = 'WAREHOUSE_CONTROL_WEIGHT_LEASE_EXPIRED',
  "httpStatus" = 503,
  "completedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'control_weight'
  AND "status" = 'in_progress';

ALTER TABLE "warehouse_operations"
  ADD CONSTRAINT "warehouse_operations_status_check"
    CHECK ("status" IN ('in_progress', 'succeeded', 'failed', 'expired')),
  ADD CONSTRAINT "warehouse_operations_attempt_check"
    CHECK ("attempt" >= 1),
  ADD CONSTRAINT "warehouse_operations_lease_pair_check"
    CHECK (
      (
        "kind" = 'control_weight'
        AND "status" = 'in_progress'
        AND "leaseToken" IS NOT NULL
        AND "leaseExpiresAt" IS NOT NULL
      )
      OR (
        NOT ("kind" = 'control_weight' AND "status" = 'in_progress')
        AND "leaseToken" IS NULL
        AND "leaseExpiresAt" IS NULL
      )
    );

CREATE INDEX "warehouse_operations_leaseExpiresAt_idx"
  ON "warehouse_operations"("leaseExpiresAt");
