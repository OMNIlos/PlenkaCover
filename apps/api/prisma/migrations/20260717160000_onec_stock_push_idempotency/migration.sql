CREATE TABLE "onec_stock_push_operations" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "actorId" TEXT NOT NULL,
  "snapshotHash" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "safeResult" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "onec_stock_push_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "onec_stock_push_operations_status_check"
    CHECK ("status" IN ('in_progress', 'succeeded', 'outcome_unknown')),
  CONSTRAINT "snapshotHash_lowercase_sha256_check"
    CHECK ("snapshotHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "onec_stock_push_operations_result_check"
    CHECK (
      ("status" = 'in_progress' AND "safeResult" IS NULL AND "completedAt" IS NULL)
      OR ("status" = 'succeeded' AND "safeResult" IS NOT NULL AND "completedAt" IS NOT NULL)
      OR ("status" = 'outcome_unknown' AND "safeResult" IS NULL AND "completedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "onec_stock_push_operations_operationKey_key"
  ON "onec_stock_push_operations"("operationKey");
CREATE UNIQUE INDEX "onec_stock_push_operations_snapshotHash_key"
  ON "onec_stock_push_operations"("snapshotHash");
CREATE INDEX "onec_stock_push_operations_actorId_createdAt_idx"
  ON "onec_stock_push_operations"("actorId", "createdAt");

ALTER TABLE "onec_stock_push_operations"
  ADD CONSTRAINT "onec_stock_push_operations_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
