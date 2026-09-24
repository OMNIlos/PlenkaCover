BEGIN;

CREATE TABLE "spool_stock_receipts" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "spoolTypeKey" VARCHAR(200) NOT NULL,
  "spoolTypeLabel" VARCHAR(200) NOT NULL,
  "quantityMillimeters" BIGINT NOT NULL,
  "priceReferenceId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "receivedById" TEXT NOT NULL,
  "receivedByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spool_stock_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spool_stock_receipts_fingerprint_ck"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "spool_stock_receipts_type_ck"
    CHECK (
      length(btrim("spoolTypeKey")) BETWEEN 1 AND 200
      AND length(btrim("spoolTypeLabel")) BETWEEN 1 AND 200
    ),
  CONSTRAINT "spool_stock_receipts_quantity_positive_ck"
    CHECK ("quantityMillimeters" > 0 AND "quantityMillimeters" <= 9007199254740991)
);

CREATE UNIQUE INDEX "spool_stock_receipts_operationKey_key"
  ON "spool_stock_receipts"("operationKey");
CREATE INDEX "spool_stock_receipts_spoolTypeKey_receivedAt_id_idx"
  ON "spool_stock_receipts"("spoolTypeKey", "receivedAt", "id");

ALTER TABLE "spool_stock_receipts"
  ADD CONSTRAINT "spool_stock_receipts_priceReferenceId_fkey"
  FOREIGN KEY ("priceReferenceId") REFERENCES "spool_price_references"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "spool_stock_receipts"
  ADD CONSTRAINT "spool_stock_receipts_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "spool_stock_receipts_append_only"
BEFORE UPDATE OR DELETE ON "spool_stock_receipts"
FOR EACH ROW EXECUTE FUNCTION "reject_production_cost_history_mutation"();

CREATE TRIGGER "spool_stock_receipts_no_truncate"
BEFORE TRUNCATE ON "spool_stock_receipts"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_production_cost_history_mutation"();

COMMIT;
