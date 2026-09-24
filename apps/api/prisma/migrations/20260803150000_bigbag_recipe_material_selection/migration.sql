ALTER TABLE "big_bag_units"
  ADD COLUMN "materialSelectionKind" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "baseRawMaterialDefinitionId" TEXT,
  ADD COLUMN "recipeDefinitionVersionId" TEXT,
  ADD COLUMN "recipeName" TEXT,
  ADD COLUMN "recipeVersionNumber" INTEGER,
  ADD COLUMN "composition" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_material_selection_check"
  CHECK (
    ("materialSelectionKind" = 'legacy'
      AND "baseRawMaterialDefinitionId" IS NULL
      AND "recipeDefinitionVersionId" IS NULL)
    OR
    ("materialSelectionKind" = 'material'
      AND "baseRawMaterialDefinitionId" IS NOT NULL
      AND "recipeDefinitionVersionId" IS NULL)
    OR
    ("materialSelectionKind" = 'recipe'
      AND "baseRawMaterialDefinitionId" IS NULL
      AND "recipeDefinitionVersionId" IS NOT NULL)
  );

CREATE INDEX "big_bag_units_baseRawMaterialDefinitionId_idx"
  ON "big_bag_units"("baseRawMaterialDefinitionId");

CREATE INDEX "big_bag_units_recipeDefinitionVersionId_idx"
  ON "big_bag_units"("recipeDefinitionVersionId");

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_baseRawMaterialDefinitionId_fkey"
  FOREIGN KEY ("baseRawMaterialDefinitionId")
  REFERENCES "raw_material_definitions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "big_bag_units"
  ADD CONSTRAINT "big_bag_units_recipeDefinitionVersionId_fkey"
  FOREIGN KEY ("recipeDefinitionVersionId")
  REFERENCES "recipe_definition_versions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
