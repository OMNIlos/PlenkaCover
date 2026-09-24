ALTER TABLE "commercial_orders"
ADD COLUMN "requestFingerprint" CHAR(64);

ALTER TABLE "commercial_orders"
ADD CONSTRAINT "commercial_orders_requestFingerprint_format_check"
CHECK (
  "requestFingerprint" IS NULL OR
  "requestFingerprint" ~ '^[0-9a-f]{64}$'
);
