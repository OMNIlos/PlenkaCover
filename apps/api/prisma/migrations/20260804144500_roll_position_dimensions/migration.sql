ALTER TABLE "commercial_order_positions"
  ADD COLUMN "manualBirka" TEXT,
  ADD COLUMN "widthMm" DOUBLE PRECISION,
  ADD COLUMN "plannedLengthM" DOUBLE PRECISION;

ALTER TABLE "roll_dispatch_items"
  ADD COLUMN "widthMm" DOUBLE PRECISION;

ALTER TABLE "commercial_order_positions"
  ADD CONSTRAINT "commercial_order_positions_width_mm_ck"
    CHECK ("widthMm" IS NULL OR "widthMm" > 0),
  ADD CONSTRAINT "commercial_order_positions_planned_length_m_ck"
    CHECK ("plannedLengthM" IS NULL OR "plannedLengthM" > 0);

ALTER TABLE "roll_dispatch_items"
  ADD CONSTRAINT "roll_dispatch_items_width_mm_ck"
    CHECK ("widthMm" IS NULL OR "widthMm" > 0),
  ADD CONSTRAINT "roll_dispatch_items_planned_length_m_ck"
    CHECK ("plannedLengthM" IS NULL OR "plannedLengthM" > 0);
