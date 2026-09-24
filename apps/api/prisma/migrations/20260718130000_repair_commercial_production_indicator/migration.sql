-- `in_progress` was emitted by the pilot seed but has never been part of the
-- PRODUCTION_INDICATORS contract. Canonicalize existing pilot-era rows without
-- changing their business meaning or queue ordering timestamps.
UPDATE "commercial_orders"
SET "productionIndicator" = 'in_production'
WHERE "productionIndicator" = 'in_progress';
