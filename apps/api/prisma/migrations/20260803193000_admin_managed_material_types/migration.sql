ALTER TABLE "raw_material_definitions"
  ADD COLUMN "isProductionSelectable" BOOLEAN NOT NULL DEFAULT false;

UPDATE "raw_material_definitions"
SET "isProductionSelectable" = false;

DO $$
DECLARE
  material RECORD;
  existing_id TEXT;
BEGIN
  FOR material IN
    SELECT *
    FROM (
      VALUES
        ('rmd-base-secondary', 'Вторичка'),
        ('rmd-base-aika', 'Айка'),
        ('rmd-base-primary', 'Первичка ленты'),
        ('rmd-base-pvd-tsp', 'ПВД ТСП'),
        ('rmd-base-danaflex', 'Данафлекс'),
        ('rmd-base-stretch', 'Стрейч')
    ) AS desired("id", "name")
  LOOP
    SELECT definition."id"
    INTO existing_id
    FROM "raw_material_definitions" definition
    WHERE definition."normalizedName" = "normalize_material_catalog_name"(material."name")
    ORDER BY definition."id"
    LIMIT 1;

    IF existing_id IS NOT NULL THEN
      UPDATE "raw_material_definitions"
      SET
        "name" = material."name",
        "kind" = 'base',
        "status" = 'active',
        "isProductionSelectable" = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = existing_id;
    ELSIF EXISTS (
      SELECT 1
      FROM "raw_material_definitions"
      WHERE "id" = material."id"
    ) THEN
      UPDATE "raw_material_definitions"
      SET
        "name" = material."name",
        "normalizedName" = "normalize_material_catalog_name"(material."name"),
        "kind" = 'base',
        "status" = 'active',
        "isProductionSelectable" = true,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = material."id";
    ELSE
      INSERT INTO "raw_material_definitions" (
        "id",
        "name",
        "normalizedName",
        "kind",
        "status",
        "isProductionSelectable",
        "createdByRole",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        material."id",
        material."name",
        "normalize_material_catalog_name"(material."name"),
        'base',
        'active',
        true,
        'admin',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      );
    END IF;

    existing_id := NULL;
  END LOOP;
END
$$;

CREATE INDEX "raw_material_definitions_isProductionSelectable_status_idx"
  ON "raw_material_definitions"("isProductionSelectable", "status");
