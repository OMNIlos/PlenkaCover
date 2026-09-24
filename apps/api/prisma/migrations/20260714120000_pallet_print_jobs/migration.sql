CREATE TABLE "pallet_print_jobs" (
    "id" TEXT NOT NULL,
    "palletListDocumentId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "printerId" TEXT NOT NULL,
    "gatewayCommandId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "failureReason" TEXT,
    "reason" TEXT,
    "replacesJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "pallet_print_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pallet_print_jobs_requestId_key"
  ON "pallet_print_jobs"("requestId");
CREATE INDEX "pallet_print_jobs_palletListDocumentId_createdAt_idx"
  ON "pallet_print_jobs"("palletListDocumentId", "createdAt");
CREATE INDEX "pallet_print_jobs_printerId_createdAt_idx"
  ON "pallet_print_jobs"("printerId", "createdAt");

ALTER TABLE "pallet_print_jobs"
  ADD CONSTRAINT "pallet_print_jobs_palletListDocumentId_fkey"
  FOREIGN KEY ("palletListDocumentId") REFERENCES "pallet_list_documents"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pallet_print_jobs"
  ADD CONSTRAINT "pallet_print_jobs_replacesJobId_fkey"
  FOREIGN KEY ("replacesJobId") REFERENCES "pallet_print_jobs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
