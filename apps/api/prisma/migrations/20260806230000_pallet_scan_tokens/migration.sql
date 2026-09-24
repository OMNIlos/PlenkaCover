BEGIN;

CREATE TABLE "pallet_scan_tokens" (
  "documentId" TEXT NOT NULL,
  "token" VARCHAR(68) NOT NULL DEFAULT (
    'plt_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  ),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "pallet_scan_tokens_pkey" PRIMARY KEY ("documentId"),
  CONSTRAINT "pallet_scan_tokens_token_format_check"
    CHECK ("token" ~ '^plt_[0-9a-f]{64}$'),
  CONSTRAINT "pallet_scan_tokens_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "pallet_list_documents"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "pallet_scan_tokens_token_key" ON "pallet_scan_tokens"("token");

CREATE FUNCTION "ensure_pallet_scan_token"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "pallet_scan_tokens" ("documentId")
  VALUES (NEW."id")
  ON CONFLICT ("documentId") DO NOTHING;
  RETURN NEW;
END
$$;

CREATE TRIGGER "pallet_list_documents_scan_token"
AFTER INSERT ON "pallet_list_documents"
FOR EACH ROW EXECUTE FUNCTION "ensure_pallet_scan_token"();

INSERT INTO "pallet_scan_tokens" ("documentId")
SELECT "id"
FROM "pallet_list_documents"
ON CONFLICT ("documentId") DO NOTHING;

CREATE FUNCTION "reject_pallet_scan_token_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'pallet scan tokens are immutable';
END
$$;

CREATE TRIGGER "pallet_scan_tokens_immutable"
BEFORE UPDATE OR DELETE ON "pallet_scan_tokens"
FOR EACH ROW EXECUTE FUNCTION "reject_pallet_scan_token_mutation"();

COMMIT;
