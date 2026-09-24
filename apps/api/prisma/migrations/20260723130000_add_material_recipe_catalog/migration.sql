BEGIN;

LOCK TABLE "raw_material_stocks" IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION "trim_material_catalog_name"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT btrim(
    value,
    E' \t\n\r\f'
      || U&'\000B\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  )
$$;

CREATE FUNCTION "normalize_material_catalog_name"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN canonical_name = 'aйка' THEN 'айка'
    ELSE canonical_name
  END
  FROM (
    SELECT lower(
      normalize(
        "trim_material_catalog_name"(value),
        NFKC
      ) COLLATE "ru-RU-x-icu"
    ) AS canonical_name
  ) AS normalized
$$;

-- Existing warehouse facts must map one-to-one to catalog definitions. Refuse
-- ambiguous history instead of silently merging or renaming a disputed stock.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "raw_material_stocks"
    WHERE "normalize_material_catalog_name"("label") = ''
  ) THEN
    RAISE EXCEPTION 'Blank raw material stock labels must be repaired before catalog migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "raw_material_stocks"
    GROUP BY "normalize_material_catalog_name"("label")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Case-insensitive duplicate raw material stock labels must be reconciled before catalog migration';
  END IF;
END
$$;

CREATE TABLE "raw_material_definitions" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'custom',
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdById" TEXT,
  "createdByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "raw_material_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "raw_material_definitions_name_length_check"
    CHECK (
      "name" = "trim_material_catalog_name"("name")
      AND char_length("name") BETWEEN 1 AND 120
    ),
  CONSTRAINT "raw_material_definitions_normalized_name_check"
    CHECK (
      char_length("normalizedName") BETWEEN 1 AND 120
      AND "normalizedName" = "normalize_material_catalog_name"("name")
    ),
  CONSTRAINT "raw_material_definitions_kind_check"
    CHECK ("kind" IN ('base', 'custom')),
  CONSTRAINT "raw_material_definitions_status_check"
    CHECK ("status" IN ('active', 'archived'))
);

CREATE TABLE "recipe_definitions" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "clientRequestId" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdById" TEXT,
  "createdByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "recipe_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recipe_definitions_name_length_check"
    CHECK (
      "name" = "trim_material_catalog_name"("name")
      AND char_length("name") BETWEEN 1 AND 120
    ),
  CONSTRAINT "recipe_definitions_normalized_name_check"
    CHECK (
      char_length("normalizedName") BETWEEN 1 AND 120
      AND "normalizedName" = "normalize_material_catalog_name"("name")
    ),
  CONSTRAINT "recipe_definitions_status_check"
    CHECK ("status" IN ('active', 'archived')),
  CONSTRAINT "recipe_definitions_request_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "recipe_definition_versions" (
  "id" TEXT NOT NULL,
  "recipeDefinitionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recipe_definition_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recipe_definition_versions_version_positive_check"
    CHECK ("version" > 0)
);

CREATE TABLE "recipe_ingredients" (
  "id" TEXT NOT NULL,
  "recipeDefinitionVersionId" TEXT NOT NULL,
  "rawMaterialDefinitionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "shareBasisPoints" INTEGER NOT NULL,

  CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recipe_ingredients_sequence_positive_check"
    CHECK ("sequence" > 0),
  CONSTRAINT "recipe_ingredients_share_range_check"
    CHECK ("shareBasisPoints" BETWEEN 1 AND 10000)
);

CREATE UNIQUE INDEX "raw_material_definitions_normalizedName_key"
  ON "raw_material_definitions"("normalizedName");
CREATE UNIQUE INDEX "recipe_definitions_normalizedName_key"
  ON "recipe_definitions"("normalizedName");
CREATE UNIQUE INDEX "recipe_definitions_clientRequestId_key"
  ON "recipe_definitions"("clientRequestId");
CREATE UNIQUE INDEX "recipe_definition_versions_recipeDefinitionId_version_key"
  ON "recipe_definition_versions"("recipeDefinitionId", "version");
CREATE UNIQUE INDEX
  "recipe_ingredients_recipeDefinitionVersionId_rawMaterialDefinitionId_key"
  ON "recipe_ingredients"("recipeDefinitionVersionId", "rawMaterialDefinitionId");
CREATE UNIQUE INDEX "recipe_ingredients_recipeDefinitionVersionId_sequence_key"
  ON "recipe_ingredients"("recipeDefinitionVersionId", "sequence");

ALTER TABLE "raw_material_stocks"
  ADD COLUMN "rawMaterialDefinitionId" TEXT;

ALTER TABLE "commercial_order_positions"
  ADD COLUMN "baseRawMaterialDefinitionId" TEXT,
  ADD COLUMN "recipeDefinitionVersionId" TEXT,
  ADD CONSTRAINT "commercial_order_positions_material_selection_check"
    CHECK (
      NOT (
        "baseRawMaterialDefinitionId" IS NOT NULL
        AND "recipeDefinitionVersionId" IS NOT NULL
      )
    );

ALTER TABLE "recipe_snapshots"
  ADD COLUMN "recipeDefinitionId" TEXT,
  ADD COLUMN "recipeDefinitionVersionId" TEXT,
  ADD COLUMN "recipeVersionNumber" INTEGER,
  ADD COLUMN "recipeName" TEXT,
  ADD COLUMN "ingredients" JSONB;

INSERT INTO "raw_material_definitions" (
  "id",
  "name",
  "normalizedName",
  "kind",
  "status",
  "createdByRole",
  "createdAt",
  "updatedAt"
)
VALUES
  (
    'rmd-base-primary',
    'Первичное',
    'первичное',
    'base',
    'active',
    'admin',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'rmd-base-secondary',
    'Вторичное',
    'вторичное',
    'base',
    'active',
    'admin',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'rmd-base-aika',
    'Айка',
    'айка',
    'base',
    'active',
    'admin',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "raw_material_definitions" (
  "id",
  "name",
  "normalizedName",
  "kind",
  "status",
  "createdByRole",
  "createdAt",
  "updatedAt"
)
SELECT
  'rmd-stock-' || stock."id",
  "trim_material_catalog_name"(stock."label"),
  "normalize_material_catalog_name"(stock."label"),
  'custom',
  'active',
  'admin',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "raw_material_stocks" AS stock
ON CONFLICT ("normalizedName") DO NOTHING;

UPDATE "raw_material_stocks" AS stock
SET "rawMaterialDefinitionId" = definition."id"
FROM "raw_material_definitions" AS definition
WHERE definition."normalizedName" = "normalize_material_catalog_name"(stock."label");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "raw_material_stocks"
    WHERE "rawMaterialDefinitionId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Raw material stock catalog backfill left an unlinked fact';
  END IF;
END
$$;

CREATE UNIQUE INDEX "raw_material_stocks_rawMaterialDefinitionId_key"
  ON "raw_material_stocks"("rawMaterialDefinitionId");

ALTER TABLE "raw_material_stocks"
  ADD CONSTRAINT "raw_material_stocks_rawMaterialDefinitionId_fkey"
  FOREIGN KEY ("rawMaterialDefinitionId")
  REFERENCES "raw_material_definitions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "recipe_definition_versions"
  ADD CONSTRAINT "recipe_definition_versions_recipeDefinitionId_fkey"
  FOREIGN KEY ("recipeDefinitionId")
  REFERENCES "recipe_definitions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "recipe_ingredients"
  ADD CONSTRAINT "recipe_ingredients_recipeDefinitionVersionId_fkey"
  FOREIGN KEY ("recipeDefinitionVersionId")
  REFERENCES "recipe_definition_versions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE,
  ADD CONSTRAINT "recipe_ingredients_rawMaterialDefinitionId_fkey"
  FOREIGN KEY ("rawMaterialDefinitionId")
  REFERENCES "raw_material_definitions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "commercial_order_positions"
  ADD CONSTRAINT "commercial_order_positions_baseRawMaterialDefinitionId_fkey"
  FOREIGN KEY ("baseRawMaterialDefinitionId")
  REFERENCES "raw_material_definitions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE,
  ADD CONSTRAINT "commercial_order_positions_recipeDefinitionVersionId_fkey"
  FOREIGN KEY ("recipeDefinitionVersionId")
  REFERENCES "recipe_definition_versions"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE FUNCTION "reject_immutable_recipe_catalog_row"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "recipe_definition_versions_immutable_guard"
BEFORE UPDATE OR DELETE ON "recipe_definition_versions"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_recipe_catalog_row"();

CREATE TRIGGER "recipe_ingredients_immutable_guard"
BEFORE UPDATE OR DELETE ON "recipe_ingredients"
FOR EACH ROW EXECUTE FUNCTION "reject_immutable_recipe_catalog_row"();

CREATE FUNCTION "validate_recipe_version_composition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  version_id TEXT;
  ingredient_count INTEGER;
  total_share INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'recipe_definition_versions' THEN
    version_id := NEW."id";
  ELSE
    version_id := NEW."recipeDefinitionVersionId";
  END IF;

  SELECT COUNT(*)::INTEGER, COALESCE(SUM("shareBasisPoints"), 0)::INTEGER
  INTO ingredient_count, total_share
  FROM "recipe_ingredients"
  WHERE "recipeDefinitionVersionId" = version_id;

  IF ingredient_count NOT BETWEEN 1 AND 50 OR total_share <> 10000 THEN
    RAISE EXCEPTION
      'Recipe version % must contain 1 to 50 ingredients totaling 10000 basis points',
      version_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- A version INSERT trigger is required as well as the ingredient trigger: an
-- empty version produces no ingredient event but must still fail at commit.
CREATE CONSTRAINT TRIGGER "recipe_definition_versions_composition_check"
AFTER INSERT ON "recipe_definition_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_recipe_version_composition"();

CREATE CONSTRAINT TRIGGER "recipe_ingredients_composition_check"
AFTER INSERT ON "recipe_ingredients"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "validate_recipe_version_composition"();

COMMIT;
