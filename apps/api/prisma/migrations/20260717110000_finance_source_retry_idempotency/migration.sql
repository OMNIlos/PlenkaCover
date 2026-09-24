-- Durable source-retry claim/result fields. Nullable columns preserve historical journal rows;
-- every new finance source retry supplies a UUID operation key.
ALTER TABLE "sync_journals"
  ADD COLUMN "operationKey" TEXT,
  ADD COLUMN "activeScopeKey" TEXT,
  ADD COLUMN "sourceSnapshotId" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "sync_journals_operationKey_key" ON "sync_journals"("operationKey");
CREATE UNIQUE INDEX "sync_journals_activeScopeKey_key" ON "sync_journals"("activeScopeKey");
