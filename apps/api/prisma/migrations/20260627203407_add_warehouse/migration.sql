-- CreateTable
CREATE TABLE "warehouse_rolls" (
    "id" TEXT NOT NULL,
    "rollCode" TEXT NOT NULL,
    "positionSnapshot" JSONB,
    "ownerCounterpartyId" TEXT,
    "reservedForOrderId" TEXT,
    "warehouseStatus" TEXT NOT NULL DEFAULT 'not_ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_rolls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_acceptance_tasks" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "lastScan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_acceptance_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_rows" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "rollCode" TEXT NOT NULL,
    "fromOrderId" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'expected',
    "lastScanAt" TIMESTAMP(3),

    CONSTRAINT "scan_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pallet_list_documents" (
    "id" TEXT NOT NULL,
    "palletId" TEXT NOT NULL,
    "rollIds" JSONB NOT NULL DEFAULT '[]',
    "orderIds" JSONB NOT NULL DEFAULT '[]',
    "generatedByRole" "Role" NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "fieldSetStatus" TEXT NOT NULL DEFAULT 'contract_only',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pallet_list_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_stocks" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "actualQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'кг',
    "package" TEXT,
    "factStatus" TEXT NOT NULL DEFAULT 'warehouse_fact',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raw_material_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_rolls_rollCode_key" ON "warehouse_rolls"("rollCode");

-- CreateIndex
CREATE INDEX "warehouse_rolls_reservedForOrderId_idx" ON "warehouse_rolls"("reservedForOrderId");

-- CreateIndex
CREATE INDEX "scan_rows_taskId_idx" ON "scan_rows"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_stocks_materialId_key" ON "raw_material_stocks"("materialId");

-- AddForeignKey
ALTER TABLE "scan_rows" ADD CONSTRAINT "scan_rows_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "warehouse_acceptance_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
