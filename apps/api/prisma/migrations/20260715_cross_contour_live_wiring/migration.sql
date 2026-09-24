-- Route one explicit open warehouse-cover task per commercial order.
ALTER TABLE "order_resolution_cases"
ADD COLUMN "openScopeKey" TEXT;

CREATE UNIQUE INDEX "order_resolution_cases_openScopeKey_key"
ON "order_resolution_cases"("openScopeKey");

DROP INDEX IF EXISTS "order_resolution_cases_ownerRole_status_updatedAt_idx";

CREATE INDEX "order_resolution_cases_ownerRole_status_updatedAt_id_idx"
ON "order_resolution_cases"("ownerRole", "status", "updatedAt", "id");

-- Stable append-only event pagination; no DomainEvent row is rewritten or removed.
CREATE INDEX "domain_events_type_createdAt_id_idx"
ON "domain_events"("type", "createdAt", "id");
