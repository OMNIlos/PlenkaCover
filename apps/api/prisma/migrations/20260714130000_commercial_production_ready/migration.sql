-- Production-ready commercial workspace: additive schema hardening.

ALTER TABLE "counterparty_order_templates"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "counterparty_order_template_versions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "positions" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "counterparty_order_template_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "counterparty_order_template_versions_templateId_version_key"
ON "counterparty_order_template_versions"("templateId", "version");
CREATE INDEX "counterparty_order_template_versions_templateId_createdAt_idx"
ON "counterparty_order_template_versions"("templateId", "createdAt");
ALTER TABLE "counterparty_order_template_versions"
ADD CONSTRAINT "counterparty_order_template_versions_templateId_fkey"
FOREIGN KEY ("templateId") REFERENCES "counterparty_order_templates"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commercial_orders"
ADD COLUMN "title" TEXT,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "clientRequestId" TEXT,
ADD COLUMN "counterpartyTemplateVersionId" TEXT;

CREATE UNIQUE INDEX "commercial_orders_clientRequestId_key"
ON "commercial_orders"("clientRequestId");
CREATE INDEX "commercial_orders_commercialStage_updatedAt_id_idx"
ON "commercial_orders"("commercialStage", "updatedAt", "id");
CREATE INDEX "commercial_orders_createdAt_id_idx"
ON "commercial_orders"("createdAt", "id");
CREATE INDEX "commercial_orders_paymentStatus_shipmentStatus_idx"
ON "commercial_orders"("paymentStatus", "shipmentStatus");
ALTER TABLE "commercial_orders"
ADD CONSTRAINT "commercial_orders_counterpartyTemplateVersionId_fkey"
FOREIGN KEY ("counterpartyTemplateVersionId")
REFERENCES "counterparty_order_template_versions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "commercial_order_positions"
ADD COLUMN "comment" TEXT,
ADD COLUMN "plannedWeightKg" DOUBLE PRECISION,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "commercial_order_positions" SET "updatedAt" = CURRENT_TIMESTAMP;
ALTER TABLE "commercial_order_positions" ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE INDEX "commercial_order_positions_orderId_updatedAt_idx"
ON "commercial_order_positions"("orderId", "updatedAt");

CREATE TABLE "recipe_snapshot_versions" (
    "id" TEXT NOT NULL,
    "recipeSnapshotId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parameters" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recipe_snapshot_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "recipe_snapshot_versions_recipeSnapshotId_version_key"
ON "recipe_snapshot_versions"("recipeSnapshotId", "version");
CREATE INDEX "recipe_snapshot_versions_recipeSnapshotId_createdAt_idx"
ON "recipe_snapshot_versions"("recipeSnapshotId", "createdAt");
ALTER TABLE "recipe_snapshot_versions"
ADD CONSTRAINT "recipe_snapshot_versions_recipeSnapshotId_fkey"
FOREIGN KEY ("recipeSnapshotId") REFERENCES "recipe_snapshots"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_cover_proposals"
ADD COLUMN "route" TEXT NOT NULL DEFAULT 'production_only',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "sourceCapturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "commercialApprovedById" TEXT,
ADD COLUMN "commercialApprovedAt" TIMESTAMP(3),
ADD COLUMN "technicalApprovedById" TEXT,
ADD COLUMN "technicalApprovedAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "warehouse_cover_proposals" SET "updatedAt" = CURRENT_TIMESTAMP;
ALTER TABLE "warehouse_cover_proposals" ALTER COLUMN "updatedAt" SET NOT NULL;

UPDATE "warehouse_cover_proposals"
SET "route" = CASE
    WHEN "coverType" = 'full' THEN 'full_cover'
    WHEN "coverQty" > 0 THEN 'partial_cover'
    ELSE 'production_only'
END;

CREATE INDEX "warehouse_cover_proposals_orderId_positionId_status_idx"
ON "warehouse_cover_proposals"("orderId", "positionId", "status");
CREATE INDEX "warehouse_cover_proposals_status_expiresAt_idx"
ON "warehouse_cover_proposals"("status", "expiresAt");
ALTER TABLE "warehouse_cover_proposals"
ADD CONSTRAINT "warehouse_cover_proposals_positionId_fkey"
FOREIGN KEY ("positionId") REFERENCES "commercial_order_positions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "warehouse_rolls"
ADD COLUMN "reservedForPositionId" TEXT,
ADD COLUMN "reservedByProposalId" TEXT,
ADD COLUMN "reservedAt" TIMESTAMP(3);

CREATE INDEX "warehouse_rolls_reservedForPositionId_idx"
ON "warehouse_rolls"("reservedForPositionId");
CREATE INDEX "warehouse_rolls_reservedByProposalId_idx"
ON "warehouse_rolls"("reservedByProposalId");
ALTER TABLE "warehouse_rolls"
ADD CONSTRAINT "warehouse_rolls_reservedForPositionId_fkey"
FOREIGN KEY ("reservedForPositionId") REFERENCES "commercial_order_positions"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_rolls"
ADD CONSTRAINT "warehouse_rolls_reservedByProposalId_fkey"
FOREIGN KEY ("reservedByProposalId") REFERENCES "warehouse_cover_proposals"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "warehouse_cover_matches" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "rollId" TEXT NOT NULL,
    "compatible" BOOLEAN NOT NULL DEFAULT true,
    "criteria" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_cover_matches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_cover_matches_proposalId_rollId_key"
ON "warehouse_cover_matches"("proposalId", "rollId");
CREATE INDEX "warehouse_cover_matches_rollId_idx"
ON "warehouse_cover_matches"("rollId");
ALTER TABLE "warehouse_cover_matches"
ADD CONSTRAINT "warehouse_cover_matches_proposalId_fkey"
FOREIGN KEY ("proposalId") REFERENCES "warehouse_cover_proposals"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_cover_matches"
ADD CONSTRAINT "warehouse_cover_matches_rollId_fkey"
FOREIGN KEY ("rollId") REFERENCES "warehouse_rolls"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "order_resolution_cases" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ownerRole" "Role" NOT NULL,
    "affectedPositionIds" JSONB NOT NULL DEFAULT '[]',
    "affectedRollIds" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT NOT NULL,
    "outcome" TEXT,
    "nextOwnerRole" "Role",
    "createdByRole" "Role" NOT NULL,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "order_resolution_cases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_resolution_cases_orderId_status_idx"
ON "order_resolution_cases"("orderId", "status");
CREATE INDEX "order_resolution_cases_ownerRole_status_updatedAt_idx"
ON "order_resolution_cases"("ownerRole", "status", "updatedAt");
ALTER TABLE "order_resolution_cases"
ADD CONSTRAINT "order_resolution_cases_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_receipts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    CONSTRAINT "notification_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_receipts_userId_eventId_key"
ON "notification_receipts"("userId", "eventId");
CREATE INDEX "notification_receipts_userId_readAt_idx"
ON "notification_receipts"("userId", "readAt");
CREATE INDEX "notification_receipts_eventId_idx"
ON "notification_receipts"("eventId");
ALTER TABLE "notification_receipts"
ADD CONSTRAINT "notification_receipts_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_receipts"
ADD CONSTRAINT "notification_receipts_eventId_fkey"
FOREIGN KEY ("eventId") REFERENCES "domain_events"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_acceptance_tasks"
ADD COLUMN "orderId" TEXT,
ADD COLUMN "positionId" TEXT,
ADD COLUMN "proposalId" TEXT;

CREATE INDEX "warehouse_acceptance_tasks_orderId_status_idx"
ON "warehouse_acceptance_tasks"("orderId", "status");
CREATE INDEX "warehouse_acceptance_tasks_proposalId_idx"
ON "warehouse_acceptance_tasks"("proposalId");

ALTER TABLE "finance_orders"
ALTER COLUMN "amountValue" DROP DEFAULT,
ALTER COLUMN "amountValue" DROP NOT NULL;
