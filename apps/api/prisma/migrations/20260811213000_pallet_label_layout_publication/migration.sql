CREATE TABLE "pallet_label_layout_versions" (
  "id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "sourceDocumentId" VARCHAR(200) NOT NULL,
  "publishedById" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "activatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pallet_label_layout_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pallet_label_layout_publish_commands" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "profile" TEXT NOT NULL,
  "expectedActivePublicationId" TEXT,
  "sourceDocumentId" VARCHAR(200) NOT NULL,
  "actorId" TEXT NOT NULL,
  "resultPublicationId" TEXT NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pallet_label_layout_publish_commands_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "pallet_list_documents" ADD COLUMN "layoutPublicationId" TEXT;

CREATE UNIQUE INDEX "pallet_label_layout_versions_profile_version_key"
  ON "pallet_label_layout_versions"("profile", "version");
CREATE INDEX "pallet_label_layout_versions_active_idx"
  ON "pallet_label_layout_versions"("profile", "activatedAt", "id");
CREATE INDEX "pallet_label_layout_versions_source_idx"
  ON "pallet_label_layout_versions"("sourceDocumentId");
CREATE INDEX "pallet_label_layout_versions_publisher_idx"
  ON "pallet_label_layout_versions"("publishedById");
CREATE UNIQUE INDEX "pallet_label_layout_publish_commands_operationKey_key"
  ON "pallet_label_layout_publish_commands"("operationKey");
CREATE INDEX "pallet_label_layout_publish_commands_profile_created_idx"
  ON "pallet_label_layout_publish_commands"("profile", "createdAt", "id");
CREATE INDEX "pallet_label_layout_publish_commands_source_idx"
  ON "pallet_label_layout_publish_commands"("sourceDocumentId");
CREATE INDEX "pallet_label_layout_publish_commands_actor_idx"
  ON "pallet_label_layout_publish_commands"("actorId");
CREATE INDEX "pallet_label_layout_publish_commands_result_idx"
  ON "pallet_label_layout_publish_commands"("resultPublicationId");
CREATE INDEX "pallet_list_documents_layout_publication_idx"
  ON "pallet_list_documents"("layoutPublicationId");

ALTER TABLE "pallet_label_layout_versions"
  ADD CONSTRAINT "pallet_label_layout_versions_publishedById_fkey"
  FOREIGN KEY ("publishedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pallet_label_layout_publish_commands"
  ADD CONSTRAINT "pallet_label_layout_publish_commands_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pallet_label_layout_publish_commands"
  ADD CONSTRAINT "pallet_label_layout_publish_commands_resultPublicationId_fkey"
  FOREIGN KEY ("resultPublicationId") REFERENCES "pallet_label_layout_versions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "pallet_list_documents"
  ADD CONSTRAINT "pallet_list_documents_layoutPublicationId_fkey"
  FOREIGN KEY ("layoutPublicationId") REFERENCES "pallet_label_layout_versions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION pallet_label_layout_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pallet-label layout publication history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pallet_label_layout_versions_immutable"
BEFORE UPDATE OR DELETE ON "pallet_label_layout_versions"
FOR EACH ROW EXECUTE FUNCTION pallet_label_layout_append_only();

CREATE TRIGGER "pallet_label_layout_publish_commands_immutable"
BEFORE UPDATE OR DELETE ON "pallet_label_layout_publish_commands"
FOR EACH ROW EXECUTE FUNCTION pallet_label_layout_append_only();

CREATE FUNCTION pallet_list_document_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."payload" IS DISTINCT FROM NEW."payload"
    OR OLD."layoutPublicationId" IS DISTINCT FROM NEW."layoutPublicationId"
  THEN
    RAISE EXCEPTION 'pallet-list immutable snapshot fields cannot change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pallet_list_document_snapshot_immutable"
BEFORE UPDATE ON "pallet_list_documents"
FOR EACH ROW EXECUTE FUNCTION pallet_list_document_snapshot_immutable();
