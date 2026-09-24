ALTER TABLE "commercial_orders"
ADD COLUMN "shipmentCompletedAt" TIMESTAMP(3);

ALTER TABLE "finance_orders"
ADD COLUMN "paymentTermsType" TEXT,
ADD COLUMN "invoiceIssuedAt" TIMESTAMP(3);

ALTER TABLE "payment_schedules"
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'legacy';

CREATE INDEX "payment_schedules_financeOrderId_kind_status_idx"
ON "payment_schedules"("financeOrderId", "kind", "status");
