-- CreateTable
CREATE TABLE "operator_roll_lines" (
    "id" TEXT NOT NULL,
    "rollDispatchItemId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "groupId" TEXT,
    "planKg" DOUBLE PRECISION,
    "spoolKg" DOUBLE PRECISION,
    "grossKg" DOUBLE PRECISION,
    "netKg" DOUBLE PRECISION,
    "toleranceOk" BOOLEAN,
    "step" TEXT NOT NULL DEFAULT 'assigned',
    "labelState" TEXT NOT NULL DEFAULT 'not_printed',
    "warehouseState" TEXT NOT NULL DEFAULT 'not_ready',
    "qrCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_roll_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weight_captures" (
    "id" TEXT NOT NULL,
    "operatorRollLineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deviceId" TEXT,
    "deviceStatus" TEXT NOT NULL DEFAULT 'ready',
    "stable" BOOLEAN NOT NULL DEFAULT true,
    "grossKg" DOUBLE PRECISION,
    "spoolKg" DOUBLE PRECISION,
    "netKg" DOUBLE PRECISION,
    "toleranceOk" BOOLEAN,
    "actorRole" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weight_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "defect_records" (
    "id" TEXT NOT NULL,
    "operatorRollLineId" TEXT NOT NULL,
    "sourceRole" "Role" NOT NULL,
    "weightKg" DOUBLE PRECISION,
    "comment" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "defect_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_print_jobs" (
    "id" TEXT NOT NULL,
    "operatorRollLineId" TEXT NOT NULL,
    "printerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'printed',
    "reason" TEXT,
    "replacesJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "big_bag_units" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "currentKg" DOUBLE PRECISION,
    "lastMeasuredKg" DOUBLE PRECISION,
    "lastActorRole" "Role",
    "lastMeasuredAt" TIMESTAMP(3),
    "machineId" TEXT,

    CONSTRAINT "big_bag_units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_roll_lines_rollDispatchItemId_key" ON "operator_roll_lines"("rollDispatchItemId");

-- CreateIndex
CREATE UNIQUE INDEX "operator_roll_lines_qrCode_key" ON "operator_roll_lines"("qrCode");

-- CreateIndex
CREATE UNIQUE INDEX "big_bag_units_code_key" ON "big_bag_units"("code");

-- AddForeignKey
ALTER TABLE "operator_roll_lines" ADD CONSTRAINT "operator_roll_lines_rollDispatchItemId_fkey" FOREIGN KEY ("rollDispatchItemId") REFERENCES "roll_dispatch_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weight_captures" ADD CONSTRAINT "weight_captures_operatorRollLineId_fkey" FOREIGN KEY ("operatorRollLineId") REFERENCES "operator_roll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "defect_records" ADD CONSTRAINT "defect_records_operatorRollLineId_fkey" FOREIGN KEY ("operatorRollLineId") REFERENCES "operator_roll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_print_jobs" ADD CONSTRAINT "label_print_jobs_operatorRollLineId_fkey" FOREIGN KEY ("operatorRollLineId") REFERENCES "operator_roll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
