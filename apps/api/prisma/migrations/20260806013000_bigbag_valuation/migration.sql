ALTER TABLE "big_bag_units"
  ADD COLUMN "priceKopecksPerKg" INTEGER,
  ADD COLUMN "priceSource" TEXT,
  ADD COLUMN "priceEffectiveAt" TIMESTAMP(3);

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_price_non_negative_check"
  CHECK ("priceKopecksPerKg" IS NULL OR "priceKopecksPerKg" >= 0);

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_price_provenance_check"
  CHECK (
    ("priceKopecksPerKg" IS NULL AND "priceSource" IS NULL AND "priceEffectiveAt" IS NULL)
    OR
    ("priceKopecksPerKg" IS NOT NULL AND "priceSource" IS NOT NULL AND "priceEffectiveAt" IS NOT NULL)
  );
