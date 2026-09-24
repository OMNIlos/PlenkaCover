BEGIN;

ALTER TABLE "defect_bags"
  ADD COLUMN "defectType" TEXT,
  ADD CONSTRAINT "defect_bags_type_check"
    CHECK ("defectType" IS NULL OR "defectType" IN ('secondary', 'aika', 'primary'));

COMMIT;
