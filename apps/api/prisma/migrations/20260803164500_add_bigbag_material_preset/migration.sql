ALTER TABLE "big_bag_units"
  ADD COLUMN "materialPreset" TEXT;

ALTER TABLE "big_bag_units"
  DROP CONSTRAINT "big_bag_units_material_selection_check";

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_material_selection_check"
  CHECK (
    ("materialSelectionKind" = 'legacy'
      AND "materialPreset" IS NULL
      AND "baseRawMaterialDefinitionId" IS NULL
      AND "recipeDefinitionVersionId" IS NULL)
    OR
    ("materialSelectionKind" = 'material'
      AND "materialPreset" IS NULL
      AND "baseRawMaterialDefinitionId" IS NOT NULL
      AND "recipeDefinitionVersionId" IS NULL)
    OR
    ("materialSelectionKind" = 'recipe'
      AND "materialPreset" IS NULL
      AND "baseRawMaterialDefinitionId" IS NULL
      AND "recipeDefinitionVersionId" IS NOT NULL)
    OR
    ("materialSelectionKind" = 'preset'
      AND "materialPreset" IN (
        'secondary',
        'aika',
        'primary_tape',
        'pvd_tsp',
        'danaflex',
        'stretch'
      )
      AND "baseRawMaterialDefinitionId" IS NULL
      AND "recipeDefinitionVersionId" IS NULL)
  );
