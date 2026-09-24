BEGIN;

CREATE TABLE "stock_production_templates" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "positions" JSONB NOT NULL,
  "usageCount" INTEGER NOT NULL DEFAULT 0,
  "lastUsedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "stock_production_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_production_template_versions" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "positions" JSONB NOT NULL,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_production_template_versions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "commercial_orders"
  ADD COLUMN "stockProductionTemplateId" TEXT,
  ADD COLUMN "stockProductionTemplateName" TEXT,
  ADD COLUMN "stockProductionTemplateVersionId" TEXT;

CREATE UNIQUE INDEX "stock_production_templates_name_key"
  ON "stock_production_templates"("name");
CREATE INDEX "stock_production_templates_status_updatedAt_idx"
  ON "stock_production_templates"("status", "updatedAt");
CREATE UNIQUE INDEX "stock_production_template_versions_templateId_version_key"
  ON "stock_production_template_versions"("templateId", "version");
CREATE INDEX "stock_production_template_versions_templateId_createdAt_idx"
  ON "stock_production_template_versions"("templateId", "createdAt");
CREATE INDEX "commercial_orders_requestType_stockProductionTemplateId_idx"
  ON "commercial_orders"("requestType", "stockProductionTemplateId");

ALTER TABLE "stock_production_template_versions"
  ADD CONSTRAINT "stock_production_template_versions_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "stock_production_templates"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commercial_orders"
  ADD CONSTRAINT "commercial_orders_stockProductionTemplateId_fkey"
  FOREIGN KEY ("stockProductionTemplateId") REFERENCES "stock_production_templates"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commercial_orders"
  ADD CONSTRAINT "commercial_orders_stockProductionTemplateVersionId_fkey"
  FOREIGN KEY ("stockProductionTemplateVersionId")
  REFERENCES "stock_production_template_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
