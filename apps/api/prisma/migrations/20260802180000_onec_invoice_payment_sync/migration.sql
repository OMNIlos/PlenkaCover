-- Commercial supplies context only; 1С remains the source of the official invoice amount.
ALTER TABLE "commercial_orders"
ADD COLUMN "commercialFinanceNote" VARCHAR(2000);

CREATE TABLE "commercial_finance_note_commands" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "commercial_finance_note_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commercial_finance_note_commands_operationKey_key"
ON "commercial_finance_note_commands"("operationKey");

CREATE INDEX "commercial_finance_note_commands_orderId_createdAt_idx"
ON "commercial_finance_note_commands"("orderId", "createdAt");

ALTER TABLE "commercial_finance_note_commands"
ADD CONSTRAINT "commercial_finance_note_commands_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "commercial_orders"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fixed precision is mandatory for money facts.
ALTER TABLE "finance_orders"
ALTER COLUMN "amountValue" TYPE DECIMAL(18,2)
USING ROUND("amountValue"::numeric, 2);

ALTER TABLE "payment_schedules"
ALTER COLUMN "amount" TYPE DECIMAL(18,2)
USING ROUND("amount"::numeric, 2);

ALTER TABLE "payment_operations"
ALTER COLUMN "amount" TYPE DECIMAL(18,2)
USING ROUND("amount"::numeric, 2);

-- Safe current invoice projection on the finance aggregate.
ALTER TABLE "finance_orders"
ADD COLUMN "invoiceSyncState" TEXT NOT NULL DEFAULT 'not_synced',
ADD COLUMN "invoiceNumber" TEXT,
ADD COLUMN "invoiceCurrency" TEXT,
ADD COLUMN "invoiceCandidates" JSONB,
ADD COLUMN "invoiceSourceCheckedAt" TIMESTAMP(3);

-- A policy revision captures the exact posted invoice on which it was calculated.
ALTER TABLE "payment_policies"
ADD COLUMN "invoiceExternalId" TEXT,
ADD COLUMN "invoiceSourceVersion" TEXT,
ADD COLUMN "capturedInvoiceAmount" DECIMAL(18,2),
ADD COLUMN "capturedInvoiceCurrency" TEXT;

-- Safe typed 1С mirrors used by exact matching and business projections.
ALTER TABLE "onec_invoices"
ADD COLUMN "currency" TEXT,
ADD COLUMN "orderReference" TEXT,
ADD COLUMN "subtotal" DECIMAL(18,2),
ADD COLUMN "taxTotal" DECIMAL(18,2);

ALTER TABLE "onec_invoice_lines"
ADD COLUMN "taxRate" TEXT,
ADD COLUMN "taxAmount" DECIMAL(18,2);

ALTER TABLE "onec_payments"
ADD COLUMN "currency" TEXT,
ADD COLUMN "orderReference" TEXT,
ADD COLUMN "invoiceNumberReference" TEXT,
ADD COLUMN "documentBasisType" TEXT;

CREATE TABLE "finance_payment_receipts" (
  "id" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "number" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3),
  "amount" DECIMAL(18,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "counterpartyExternalId" TEXT,
  "invoiceExternalId" TEXT,
  "invoiceNumberReference" TEXT,
  "orderReference" TEXT,
  "posted" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "sourceStatus" TEXT NOT NULL DEFAULT 'fresh',
  "matchState" TEXT NOT NULL DEFAULT 'pending',
  "matchKind" TEXT,
  "candidateFinanceOrderIds" JSONB,
  "lastMatchedAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "finance_payment_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "finance_payment_allocation_commands" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actorRole" "Role" NOT NULL,
  "actorId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "finance_payment_allocation_commands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "finance_payment_allocations" (
  "id" TEXT NOT NULL,
  "allocationKey" CHAR(64) NOT NULL,
  "receiptId" TEXT NOT NULL,
  "financeOrderId" TEXT NOT NULL,
  "scheduleId" TEXT,
  "amount" DECIMAL(18,2) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'applied',
  "matchKind" TEXT NOT NULL,
  "reason" VARCHAR(500),
  "reversesId" TEXT,
  "commandId" TEXT,
  "createdByRole" "Role",
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "finance_payment_allocations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payment_operations"
ADD COLUMN "paymentAllocationId" TEXT;

CREATE UNIQUE INDEX "finance_payment_receipts_externalId_key"
ON "finance_payment_receipts"("externalId");

CREATE INDEX "finance_payment_receipts_receivedAt_idx"
ON "finance_payment_receipts"("receivedAt");

CREATE INDEX "finance_payment_receipts_invoiceExternalId_idx"
ON "finance_payment_receipts"("invoiceExternalId");

CREATE INDEX "finance_payment_receipts_orderReference_idx"
ON "finance_payment_receipts"("orderReference");

CREATE UNIQUE INDEX "finance_payment_allocation_commands_operationKey_key"
ON "finance_payment_allocation_commands"("operationKey");

CREATE INDEX "finance_payment_allocation_commands_receiptId_createdAt_idx"
ON "finance_payment_allocation_commands"("receiptId", "createdAt");

CREATE UNIQUE INDEX "finance_payment_allocations_allocationKey_key"
ON "finance_payment_allocations"("allocationKey");

CREATE UNIQUE INDEX "finance_payment_allocations_reversesId_key"
ON "finance_payment_allocations"("reversesId");

CREATE INDEX "finance_payment_allocations_receiptId_createdAt_idx"
ON "finance_payment_allocations"("receiptId", "createdAt");

CREATE INDEX "finance_payment_allocations_financeOrderId_createdAt_idx"
ON "finance_payment_allocations"("financeOrderId", "createdAt");

CREATE INDEX "finance_payment_allocations_scheduleId_createdAt_idx"
ON "finance_payment_allocations"("scheduleId", "createdAt");

CREATE UNIQUE INDEX "payment_operations_paymentAllocationId_key"
ON "payment_operations"("paymentAllocationId");

ALTER TABLE "finance_payment_allocation_commands"
ADD CONSTRAINT "finance_payment_allocation_commands_receiptId_fkey"
FOREIGN KEY ("receiptId") REFERENCES "finance_payment_receipts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_allocations"
ADD CONSTRAINT "finance_payment_allocations_receiptId_fkey"
FOREIGN KEY ("receiptId") REFERENCES "finance_payment_receipts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_allocations"
ADD CONSTRAINT "finance_payment_allocations_financeOrderId_fkey"
FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_allocations"
ADD CONSTRAINT "finance_payment_allocations_scheduleId_fkey"
FOREIGN KEY ("scheduleId") REFERENCES "payment_schedules"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_allocations"
ADD CONSTRAINT "finance_payment_allocations_reversesId_fkey"
FOREIGN KEY ("reversesId") REFERENCES "finance_payment_allocations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_allocations"
ADD CONSTRAINT "finance_payment_allocations_commandId_fkey"
FOREIGN KEY ("commandId") REFERENCES "finance_payment_allocation_commands"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_operations"
ADD CONSTRAINT "payment_operations_paymentAllocationId_fkey"
FOREIGN KEY ("paymentAllocationId") REFERENCES "finance_payment_allocations"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy retry rows remain replayable; new exact-invoice commands persist a canonical payload hash.
ALTER TABLE "sync_journals"
ADD COLUMN "requestFingerprint" CHAR(64);
