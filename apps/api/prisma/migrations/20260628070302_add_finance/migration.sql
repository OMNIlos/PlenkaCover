-- CreateTable
CREATE TABLE "finance_orders" (
    "id" TEXT NOT NULL,
    "commercialOrderId" TEXT NOT NULL,
    "invoiceStatus" TEXT NOT NULL DEFAULT 'not_invoiced',
    "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid',
    "amountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amountLabel" TEXT,
    "sourceStatus" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" TEXT NOT NULL,
    "financeOrderId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "terms" TEXT,
    "dueDate" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "source" TEXT NOT NULL DEFAULT 'manual_platform',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_operations" (
    "id" TEXT NOT NULL,
    "financeOrderId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual_platform',
    "createdByRole" "Role" NOT NULL,
    "reconciled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_snapshots" (
    "id" TEXT NOT NULL,
    "financeOrderId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "ownerRole" "Role" NOT NULL,
    "capturedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "staleness" TEXT,
    "parsed" JSONB,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_journals" (
    "id" TEXT NOT NULL,
    "financeOrderId" TEXT,
    "entity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "ownerRole" "Role" NOT NULL,
    "recovery" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_journals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_orders_commercialOrderId_key" ON "finance_orders"("commercialOrderId");

-- AddForeignKey
ALTER TABLE "finance_orders" ADD CONSTRAINT "finance_orders_commercialOrderId_fkey" FOREIGN KEY ("commercialOrderId") REFERENCES "commercial_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_financeOrderId_fkey" FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_operations" ADD CONSTRAINT "payment_operations_financeOrderId_fkey" FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_financeOrderId_fkey" FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_journals" ADD CONSTRAINT "sync_journals_financeOrderId_fkey" FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
