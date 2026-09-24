-- CreateEnum
CREATE TYPE "Role" AS ENUM ('commercial', 'production_lead', 'operator', 'warehouse', 'finance', 'director', 'admin');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_events" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectId" TEXT,
    "actorRole" "Role" NOT NULL,
    "actorId" TEXT,
    "label" TEXT,
    "detail" JSONB,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "sourceSnapshotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counterparties" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "inn" TEXT,
    "billingSource" TEXT NOT NULL DEFAULT 'manual_platform',
    "syncStatus" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counterparties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "creatorRole" "Role" NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "requestType" TEXT NOT NULL DEFAULT 'client_order',
    "productionIndicator" TEXT NOT NULL DEFAULT 'not_started',
    "warehouseCoverStatus" TEXT NOT NULL DEFAULT 'not_checked',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "shipmentStatus" TEXT NOT NULL DEFAULT 'not_shipped',
    "recipeOwnerRole" "Role" NOT NULL DEFAULT 'commercial',
    "delegationMarker" BOOLEAN NOT NULL DEFAULT false,
    "commercialConfirmationPolicy" TEXT NOT NULL DEFAULT 'required',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commercial_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commercial_order_positions" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rollCount" INTEGER NOT NULL,
    "filmType" TEXT NOT NULL,
    "actualThickness" TEXT NOT NULL,
    "accountingThickness" TEXT NOT NULL,
    "rawMaterialId" TEXT,
    "spoolType" TEXT,
    "birka" TEXT,
    "warehouseCoverStatus" TEXT NOT NULL DEFAULT 'not_checked',

    CONSTRAINT "commercial_order_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_snapshots" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "recipeOwnerRole" "Role" NOT NULL DEFAULT 'commercial',
    "parameters" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recipe_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_cover_proposals" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "coverType" TEXT NOT NULL,
    "coverQty" INTEGER NOT NULL,
    "reserveQty" INTEGER NOT NULL DEFAULT 0,
    "productionQty" INTEGER NOT NULL DEFAULT 0,
    "matchedRollIds" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'full_proposed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_cover_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_problems" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "positionId" TEXT,
    "rollId" TEXT,
    "actorRole" "Role" NOT NULL,
    "reason" TEXT NOT NULL,
    "recovery" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_problems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_externalId_key" ON "users"("externalId");

-- CreateIndex
CREATE INDEX "domain_events_objectId_idx" ON "domain_events"("objectId");

-- CreateIndex
CREATE INDEX "domain_events_family_idx" ON "domain_events"("family");

-- CreateIndex
CREATE INDEX "domain_events_type_idx" ON "domain_events"("type");

-- CreateIndex
CREATE INDEX "domain_events_createdAt_idx" ON "domain_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commercial_orders_orderNumber_key" ON "commercial_orders"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_snapshots_positionId_key" ON "recipe_snapshots"("positionId");

-- AddForeignKey
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_orders" ADD CONSTRAINT "commercial_orders_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commercial_order_positions" ADD CONSTRAINT "commercial_order_positions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_snapshots" ADD CONSTRAINT "recipe_snapshots_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "commercial_order_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_cover_proposals" ADD CONSTRAINT "warehouse_cover_proposals_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_problems" ADD CONSTRAINT "production_problems_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
