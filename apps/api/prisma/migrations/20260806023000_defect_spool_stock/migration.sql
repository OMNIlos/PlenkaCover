BEGIN;

CREATE TABLE "spool_stock_movements" (
    "id" TEXT NOT NULL,
    "defectRecordId" TEXT NOT NULL,
    "rollCode" TEXT NOT NULL,
    "spoolType" TEXT NOT NULL,
    "tareKg" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "location" TEXT NOT NULL DEFAULT 'warehouse',
    "returnedByRole" "Role" NOT NULL,
    "returnedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spool_stock_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "spool_stock_movements_quantity_check" CHECK ("quantity" = 1),
    CONSTRAINT "spool_stock_movements_tare_check" CHECK ("tareKg" > 0),
    CONSTRAINT "spool_stock_movements_location_check" CHECK ("location" = 'warehouse')
);

CREATE UNIQUE INDEX "spool_stock_movements_defectRecordId_key"
    ON "spool_stock_movements"("defectRecordId");

CREATE INDEX "spool_stock_movements_stock_idx"
    ON "spool_stock_movements"("spoolType", "location", "createdAt", "id");

ALTER TABLE "spool_stock_movements"
    ADD CONSTRAINT "spool_stock_movements_defectRecordId_fkey"
    FOREIGN KEY ("defectRecordId") REFERENCES "defect_records"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
