BEGIN;

ALTER TABLE "stock_production_templates"
  ADD COLUMN "normalizedName" TEXT;

UPDATE "stock_production_templates"
SET
  "name" = normalize("trim_material_catalog_name"("name"), NFKC),
  "normalizedName" = "normalize_material_catalog_name"("name");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "stock_production_templates"
    WHERE
      "normalizedName" = ''
      OR char_length("name") > 200
      OR char_length("normalizedName") > 200
  ) THEN
    RAISE EXCEPTION
      'Stock production template names must normalize to between 1 and 200 characters';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "stock_production_templates"
    GROUP BY "normalizedName"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Case-insensitive duplicate stock production template names must be reconciled';
  END IF;
END
$$;

ALTER TABLE "stock_production_templates"
  ALTER COLUMN "normalizedName" SET NOT NULL,
  ADD CONSTRAINT "stock_production_templates_name_check"
    CHECK (
      "name" = normalize("trim_material_catalog_name"("name"), NFKC)
      AND char_length("name") BETWEEN 1 AND 200
    ),
  ADD CONSTRAINT "stock_production_templates_normalized_name_check"
    CHECK (
      char_length("normalizedName") BETWEEN 1 AND 200
      AND "normalizedName" = "normalize_material_catalog_name"("name")
    );

CREATE UNIQUE INDEX "stock_production_templates_normalizedName_key"
  ON "stock_production_templates"("normalizedName");

COMMIT;
