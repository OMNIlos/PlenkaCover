BEGIN;

-- Resolve a physically ambiguous pallet-label delivery through one explicit admin decision.
-- The journal stores a safe projection only and is immutable outside the guarded pilot reset.
CREATE TABLE "pallet_print_reconciliations" (
    "id" TEXT NOT NULL,
    "operationKey" UUID NOT NULL,
    "printJobId" TEXT NOT NULL,
    "palletListDocumentId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pallet_print_reconciliations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pallet_print_reconciliations_outcome_check"
      CHECK ("outcome" IN ('label_observed', 'not_printed')),
    CONSTRAINT "pallet_print_reconciliations_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500)
);

CREATE UNIQUE INDEX "pallet_print_reconciliations_operationKey_key"
  ON "pallet_print_reconciliations"("operationKey");
CREATE UNIQUE INDEX "pallet_print_reconciliations_printJobId_key"
  ON "pallet_print_reconciliations"("printJobId");
CREATE INDEX "pallet_print_reconciliations_document_created_at_idx"
  ON "pallet_print_reconciliations"("palletListDocumentId", "createdAt");

ALTER TABLE "pallet_print_reconciliations"
  ADD CONSTRAINT "pallet_print_reconciliations_printJobId_fkey"
  FOREIGN KEY ("printJobId") REFERENCES "pallet_print_jobs"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pallet_print_reconciliations"
  ADD CONSTRAINT "pallet_print_reconciliations_palletListDocumentId_fkey"
  FOREIGN KEY ("palletListDocumentId") REFERENCES "pallet_list_documents"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pallet_print_reconciliations"
  ADD CONSTRAINT "pallet_print_reconciliations_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION reject_pallet_print_reconciliation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pallet_print_reconciliations is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pallet_print_reconciliations_append_only"
BEFORE UPDATE OR DELETE ON "pallet_print_reconciliations"
FOR EACH ROW EXECUTE FUNCTION reject_pallet_print_reconciliation_mutation();

CREATE TRIGGER "pallet_print_reconciliations_no_truncate"
BEFORE TRUNCATE ON "pallet_print_reconciliations"
FOR EACH STATEMENT EXECUTE FUNCTION reject_pallet_print_reconciliation_mutation();

COMMIT;
