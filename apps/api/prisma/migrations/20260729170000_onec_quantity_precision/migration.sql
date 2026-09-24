-- 1C quantities carry sub-cent precision (for example kilograms to grams).
-- Widening the scale prevents a stable source value from appearing changed after persistence.

ALTER TABLE "onec_invoice_lines"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,6);

ALTER TABLE "onec_shipment_lines"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,6);

ALTER TABLE "onec_stock_balances"
  ALTER COLUMN "quantity" TYPE DECIMAL(18,6);
