ALTER TABLE "warehouse_acceptance_tasks"
ADD COLUMN "deliveryScopeKey" TEXT;

CREATE UNIQUE INDEX "warehouse_acceptance_tasks_deliveryScopeKey_key"
ON "warehouse_acceptance_tasks"("deliveryScopeKey");
