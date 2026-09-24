-- Resolve a physically ambiguous label delivery through an explicit, durable admin decision.
-- The journal is append-only and stores only a safe business result (never the label token/raw I/O).
CREATE TABLE "label_print_reconciliations" (
    "id" TEXT NOT NULL,
    "operationKey" UUID NOT NULL,
    "printJobId" TEXT NOT NULL,
    "operatorRollLineId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_print_reconciliations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "label_print_reconciliations_outcome_check"
      CHECK ("outcome" IN ('label_observed', 'not_printed')),
    CONSTRAINT "label_print_reconciliations_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500)
);

CREATE UNIQUE INDEX "label_print_reconciliations_operationKey_key"
  ON "label_print_reconciliations"("operationKey");
CREATE INDEX "label_print_reconciliations_printJobId_createdAt_idx"
  ON "label_print_reconciliations"("printJobId", "createdAt");
CREATE INDEX "label_print_reconciliations_operatorRollLineId_createdAt_idx"
  ON "label_print_reconciliations"("operatorRollLineId", "createdAt");

ALTER TABLE "label_print_reconciliations"
  ADD CONSTRAINT "label_print_reconciliations_printJobId_fkey"
  FOREIGN KEY ("printJobId") REFERENCES "label_print_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_print_reconciliations"
  ADD CONSTRAINT "label_print_reconciliations_operatorRollLineId_fkey"
  FOREIGN KEY ("operatorRollLineId") REFERENCES "operator_roll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_print_reconciliations"
  ADD CONSTRAINT "label_print_reconciliations_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "label_print_reconciliations"
  ADD CONSTRAINT "label_print_reconciliations_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION reject_label_print_reconciliation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'label_print_reconciliations is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "label_print_reconciliations_append_only"
BEFORE UPDATE OR DELETE ON "label_print_reconciliations"
FOR EACH ROW EXECUTE FUNCTION reject_label_print_reconciliation_mutation();
