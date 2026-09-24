-- S6: 1С-compatibility — externalId (=Ref_Key) + sourceVersion (=DataVersion) on exchange
-- entities, and a generalized SourceSnapshot (polymorphic by subject). Nullable unique columns:
-- existing rows keep NULL (Postgres allows multiple NULLs under a UNIQUE index).

-- AlterTable: exchange entities get externalId + sourceVersion
ALTER TABLE "counterparties"      ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;
ALTER TABLE "commercial_orders"   ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;
ALTER TABLE "finance_orders"      ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;
ALTER TABLE "payment_operations"  ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;
ALTER TABLE "warehouse_rolls"     ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;
ALTER TABLE "raw_material_stocks" ADD COLUMN "externalId" TEXT, ADD COLUMN "sourceVersion" TEXT;

-- AlterTable: generalize SourceSnapshot
ALTER TABLE "source_snapshots"
  ADD COLUMN "subjectType" TEXT,
  ADD COLUMN "subjectId" TEXT,
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "sourceVersion" TEXT;

-- Unique indexes on externalId
CREATE UNIQUE INDEX "counterparties_externalId_key"      ON "counterparties"("externalId");
CREATE UNIQUE INDEX "commercial_orders_externalId_key"   ON "commercial_orders"("externalId");
CREATE UNIQUE INDEX "finance_orders_externalId_key"      ON "finance_orders"("externalId");
CREATE UNIQUE INDEX "payment_operations_externalId_key"  ON "payment_operations"("externalId");
CREATE UNIQUE INDEX "warehouse_rolls_externalId_key"     ON "warehouse_rolls"("externalId");
CREATE UNIQUE INDEX "raw_material_stocks_externalId_key" ON "raw_material_stocks"("externalId");

-- SourceSnapshot lookup indexes
CREATE INDEX "source_snapshots_subjectType_subjectId_idx" ON "source_snapshots"("subjectType", "subjectId");
CREATE INDEX "source_snapshots_externalId_idx"            ON "source_snapshots"("externalId");
