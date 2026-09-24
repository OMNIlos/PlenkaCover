CREATE TABLE "counterparty_order_templates" (
    "id" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ownerRole" "Role" NOT NULL DEFAULT 'production_lead',
    "positions" JSONB NOT NULL,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counterparty_order_templates_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "commercial_orders"
  ADD COLUMN "counterpartyTemplateId" TEXT,
  ADD COLUMN "counterpartyTemplateName" TEXT;

CREATE INDEX "counterparty_order_templates_counterpartyId_status_idx"
  ON "counterparty_order_templates"("counterpartyId", "status");

ALTER TABLE "counterparty_order_templates"
  ADD CONSTRAINT "counterparty_order_templates_counterpartyId_fkey"
  FOREIGN KEY ("counterpartyId") REFERENCES "counterparties"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "commercial_orders"
  ADD CONSTRAINT "commercial_orders_counterpartyTemplateId_fkey"
  FOREIGN KEY ("counterpartyTemplateId") REFERENCES "counterparty_order_templates"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
