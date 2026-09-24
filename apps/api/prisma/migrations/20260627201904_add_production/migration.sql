-- CreateTable
CREATE TABLE "production_orders" (
    "id" TEXT NOT NULL,
    "commercialOrderId" TEXT NOT NULL,
    "indicator" TEXT NOT NULL DEFAULT 'needs_production',
    "approvalState" TEXT NOT NULL DEFAULT 'pending',
    "assignedOwnerId" TEXT,
    "blockers" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roll_dispatch_items" (
    "id" TEXT NOT NULL,
    "rollCode" TEXT NOT NULL,
    "productionOrderId" TEXT NOT NULL,
    "orderLineId" TEXT,
    "filmType" TEXT,
    "plannedWeightKg" DOUBLE PRECISION,
    "assignedOperatorId" TEXT,
    "machineId" TEXT,
    "workplaceId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'new',
    "bulkGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roll_dispatch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_assignments" (
    "id" TEXT NOT NULL,
    "rollDispatchItemId" TEXT,
    "productionOrderId" TEXT,
    "machineId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_commercialOrderId_key" ON "production_orders"("commercialOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "roll_dispatch_items_rollCode_key" ON "roll_dispatch_items"("rollCode");

-- CreateIndex
CREATE INDEX "roll_dispatch_items_assignedOperatorId_idx" ON "roll_dispatch_items"("assignedOperatorId");

-- CreateIndex
CREATE INDEX "roll_dispatch_items_status_idx" ON "roll_dispatch_items"("status");

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_commercialOrderId_fkey" FOREIGN KEY ("commercialOrderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roll_dispatch_items" ADD CONSTRAINT "roll_dispatch_items_productionOrderId_fkey" FOREIGN KEY ("productionOrderId") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
