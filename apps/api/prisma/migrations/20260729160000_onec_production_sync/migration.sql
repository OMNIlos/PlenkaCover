-- Production 1C Fresh read-only synchronization.
-- Additive only: existing ERP facts and documents are not rewritten.

ALTER TABLE "counterparties"
  ADD COLUMN "kpp" TEXT,
  ADD COLUMN "sourceCode" TEXT;

ALTER TABLE "raw_material_definitions"
  ADD COLUMN "externalId" TEXT,
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "sourceCode" TEXT,
  ADD COLUMN "sourceArticle" TEXT,
  ADD COLUMN "sourceUnit" TEXT,
  ADD COLUMN "sourceKind" TEXT;

ALTER TABLE "source_snapshots"
  ADD COLUMN "sourceFingerprint" TEXT;

CREATE TABLE "onec_sync_runs" (
  "id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "activeScopeKey" TEXT,
  "actorId" TEXT,
  "actorRole" "Role",
  "counters" JSONB,
  "errorCode" TEXT,
  "recovery" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onec_nomenclature_items" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "code" TEXT NOT NULL,
  "article" TEXT,
  "name" TEXT NOT NULL,
  "fullName" TEXT,
  "kindExternalId" TEXT,
  "kindName" TEXT,
  "unitExternalId" TEXT,
  "unitName" TEXT,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "archived" BOOLEAN NOT NULL DEFAULT false,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawMaterialDefinitionId" TEXT,
  CONSTRAINT "onec_nomenclature_items_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_organizations" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "fullName" TEXT,
  "inn" TEXT,
  "kpp" TEXT,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_organizations_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_warehouses" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "warehouseType" TEXT,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_warehouses_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_invoices" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "number" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "posted" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "counterpartyExternalId" TEXT,
  "organizationExternalId" TEXT,
  "currencyExternalId" TEXT,
  "total" DECIMAL(18,2) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_invoices_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_invoice_lines" (
  "id" TEXT NOT NULL,
  "invoiceExternalId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "nomenclatureExternalId" TEXT,
  "name" TEXT,
  "quantity" DECIMAL(18,2) NOT NULL,
  "price" DECIMAL(18,2) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "unitExternalId" TEXT,
  CONSTRAINT "onec_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onec_payments" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "number" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "posted" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "counterpartyExternalId" TEXT,
  "organizationExternalId" TEXT,
  "amount" DECIMAL(18,2) NOT NULL,
  "documentBasisExternalId" TEXT,
  "invoiceExternalId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_payments_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_shipments" (
  "externalId" TEXT NOT NULL,
  "sourceVersion" TEXT,
  "number" TEXT NOT NULL,
  "date" TIMESTAMP(3),
  "posted" BOOLEAN NOT NULL DEFAULT false,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "counterpartyExternalId" TEXT,
  "organizationExternalId" TEXT,
  "total" DECIMAL(18,2) NOT NULL,
  "invoiceExternalId" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_shipments_pkey" PRIMARY KEY ("externalId")
);

CREATE TABLE "onec_shipment_lines" (
  "id" TEXT NOT NULL,
  "shipmentExternalId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "nomenclatureExternalId" TEXT,
  "name" TEXT,
  "quantity" DECIMAL(18,2) NOT NULL,
  "price" DECIMAL(18,2) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "unitExternalId" TEXT,
  CONSTRAINT "onec_shipment_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "onec_stock_balances" (
  "id" TEXT NOT NULL,
  "accountExternalId" TEXT NOT NULL,
  "accountCode" TEXT NOT NULL,
  "organizationExternalId" TEXT NOT NULL,
  "nomenclatureExternalId" TEXT NOT NULL,
  "quantity" DECIMAL(18,2) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "onec_stock_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onec_sync_runs_activeScopeKey_key"
  ON "onec_sync_runs"("activeScopeKey");
CREATE INDEX "onec_sync_runs_status_startedAt_idx"
  ON "onec_sync_runs"("status", "startedAt");

CREATE UNIQUE INDEX "onec_nomenclature_items_rawMaterialDefinitionId_key"
  ON "onec_nomenclature_items"("rawMaterialDefinitionId");
CREATE INDEX "onec_nomenclature_items_kindName_archived_deleted_idx"
  ON "onec_nomenclature_items"("kindName", "archived", "deleted");
CREATE INDEX "onec_nomenclature_items_code_idx"
  ON "onec_nomenclature_items"("code");

CREATE INDEX "onec_organizations_code_idx" ON "onec_organizations"("code");
CREATE INDEX "onec_warehouses_code_idx" ON "onec_warehouses"("code");
CREATE INDEX "onec_invoices_date_idx" ON "onec_invoices"("date");
CREATE INDEX "onec_invoices_counterpartyExternalId_idx"
  ON "onec_invoices"("counterpartyExternalId");

CREATE UNIQUE INDEX "onec_invoice_lines_invoiceExternalId_lineNumber_key"
  ON "onec_invoice_lines"("invoiceExternalId", "lineNumber");
CREATE INDEX "onec_invoice_lines_nomenclatureExternalId_idx"
  ON "onec_invoice_lines"("nomenclatureExternalId");

CREATE INDEX "onec_payments_date_idx" ON "onec_payments"("date");
CREATE INDEX "onec_payments_counterpartyExternalId_idx"
  ON "onec_payments"("counterpartyExternalId");
CREATE INDEX "onec_payments_invoiceExternalId_idx"
  ON "onec_payments"("invoiceExternalId");

CREATE INDEX "onec_shipments_date_idx" ON "onec_shipments"("date");
CREATE INDEX "onec_shipments_counterpartyExternalId_idx"
  ON "onec_shipments"("counterpartyExternalId");
CREATE INDEX "onec_shipments_invoiceExternalId_idx"
  ON "onec_shipments"("invoiceExternalId");

CREATE UNIQUE INDEX "onec_shipment_lines_shipmentExternalId_lineNumber_key"
  ON "onec_shipment_lines"("shipmentExternalId", "lineNumber");
CREATE INDEX "onec_shipment_lines_nomenclatureExternalId_idx"
  ON "onec_shipment_lines"("nomenclatureExternalId");

CREATE INDEX "onec_stock_balances_accountCode_idx"
  ON "onec_stock_balances"("accountCode");
CREATE UNIQUE INDEX "onec_stock_balances_accountExternalId_organizationExternalI_key"
  ON "onec_stock_balances"(
    "accountExternalId",
    "organizationExternalId",
    "nomenclatureExternalId"
  );

CREATE UNIQUE INDEX "raw_material_definitions_externalId_key"
  ON "raw_material_definitions"("externalId");
CREATE UNIQUE INDEX "source_snapshots_sourceFingerprint_key"
  ON "source_snapshots"("sourceFingerprint");

ALTER TABLE "onec_nomenclature_items"
  ADD CONSTRAINT "onec_nomenclature_items_rawMaterialDefinitionId_fkey"
  FOREIGN KEY ("rawMaterialDefinitionId")
  REFERENCES "raw_material_definitions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onec_invoice_lines"
  ADD CONSTRAINT "onec_invoice_lines_invoiceExternalId_fkey"
  FOREIGN KEY ("invoiceExternalId")
  REFERENCES "onec_invoices"("externalId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "onec_invoice_lines"
  ADD CONSTRAINT "onec_invoice_lines_nomenclatureExternalId_fkey"
  FOREIGN KEY ("nomenclatureExternalId")
  REFERENCES "onec_nomenclature_items"("externalId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onec_payments"
  ADD CONSTRAINT "onec_payments_invoiceExternalId_fkey"
  FOREIGN KEY ("invoiceExternalId")
  REFERENCES "onec_invoices"("externalId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onec_shipments"
  ADD CONSTRAINT "onec_shipments_invoiceExternalId_fkey"
  FOREIGN KEY ("invoiceExternalId")
  REFERENCES "onec_invoices"("externalId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onec_shipment_lines"
  ADD CONSTRAINT "onec_shipment_lines_shipmentExternalId_fkey"
  FOREIGN KEY ("shipmentExternalId")
  REFERENCES "onec_shipments"("externalId")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "onec_shipment_lines"
  ADD CONSTRAINT "onec_shipment_lines_nomenclatureExternalId_fkey"
  FOREIGN KEY ("nomenclatureExternalId")
  REFERENCES "onec_nomenclature_items"("externalId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "onec_stock_balances"
  ADD CONSTRAINT "onec_stock_balances_organizationExternalId_fkey"
  FOREIGN KEY ("organizationExternalId")
  REFERENCES "onec_organizations"("externalId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "onec_stock_balances"
  ADD CONSTRAINT "onec_stock_balances_nomenclatureExternalId_fkey"
  FOREIGN KEY ("nomenclatureExternalId")
  REFERENCES "onec_nomenclature_items"("externalId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
