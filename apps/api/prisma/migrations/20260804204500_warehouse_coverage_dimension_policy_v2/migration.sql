BEGIN;

ALTER TABLE "warehouse_coverage_calculations"
  DROP CONSTRAINT "warehouse_coverage_calculations_policy_version_ck",
  ADD CONSTRAINT "warehouse_coverage_calculations_policy_version_ck"
    CHECK (
      "policyVersion" IN (
        'warehouse-coverage-policy/v1',
        'warehouse-coverage-policy/v2'
      )
    );

-- Published V1 facts are append-only evidence and remain untouched. The insert
-- validator advances atomically so every new fact must use the complete V2 shape.
CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_fact"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  actual_keys TEXT[];
  expected_keys CONSTANT TEXT[] := ARRAY[
    'accountingThicknessMilliMicron',
    'actualThicknessMilliMicron',
    'actualWeightMilliKg',
    'birka',
    'filmType',
    'ingredients',
    'ownerCounterpartyId',
    'plannedLengthMilliM',
    'plannedWeightMilliKg',
    'policyVersion',
    'recipeDefinitionId',
    'recipeDefinitionVersionId',
    'recipeId',
    'recipeVersion',
    'recipeVersionNumber',
    'rollCode',
    'sourceOrderId',
    'sourcePositionId',
    'spoolType',
    'widthMilliMm'
  ];
  ingredient_ids TEXT[];
  canonical_ingredient_ids TEXT[];
  ingredient_total BIGINT;
  roll_code TEXT;
  actor_matches BOOLEAN;
BEGIN
  IF jsonb_typeof(NEW."spec") <> 'object' THEN
    RAISE EXCEPTION 'coverage spec must be a canonical object';
  END IF;
  SELECT array_agg(key ORDER BY key)
  INTO actual_keys
  FROM jsonb_object_keys(NEW."spec") AS keys(key);
  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RAISE EXCEPTION 'coverage spec canonical keys mismatch';
  END IF;

  IF
    jsonb_typeof(NEW."spec" -> 'rollCode') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'filmType') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'birka') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'spoolType') <> 'string'
    OR jsonb_typeof(NEW."spec" -> 'policyVersion') <> 'string'
    OR NEW."spec" ->> 'policyVersion'
      IS DISTINCT FROM 'warehouse-coverage-policy/v2'
    OR jsonb_typeof(NEW."spec" -> 'actualThicknessMilliMicron') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'accountingThicknessMilliMicron') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'widthMilliMm') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'plannedLengthMilliM') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'actualWeightMilliKg') <> 'number'
    OR jsonb_typeof(NEW."spec" -> 'plannedWeightMilliKg') <> 'number'
    OR (NEW."spec" ->> 'actualThicknessMilliMicron') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'accountingThicknessMilliMicron') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'widthMilliMm') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'plannedLengthMilliM') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'actualWeightMilliKg') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'plannedWeightMilliKg') !~ '^[0-9]+$'
    OR (NEW."spec" ->> 'actualThicknessMilliMicron')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'accountingThicknessMilliMicron')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'widthMilliMm')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'plannedLengthMilliM')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'actualWeightMilliKg')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR (NEW."spec" ->> 'plannedWeightMilliKg')::numeric NOT BETWEEN 1 AND 9007199254740991
    OR length(btrim(NEW."spec" ->> 'rollCode')) = 0
    OR length(btrim(NEW."spec" ->> 'filmType')) = 0
    OR length(btrim(NEW."spec" ->> 'birka')) = 0
    OR length(btrim(NEW."spec" ->> 'spoolType')) = 0
  THEN
    RAISE EXCEPTION 'coverage spec canonical scalar types mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('sourceOrderId'),
        ('sourcePositionId'),
        ('ownerCounterpartyId'),
        ('recipeId'),
        ('recipeVersion'),
        ('recipeDefinitionId'),
        ('recipeDefinitionVersionId')
    ) AS nullable_string(key)
    WHERE jsonb_typeof(NEW."spec" -> key) NOT IN ('string', 'null')
      OR (
        jsonb_typeof(NEW."spec" -> key) = 'string'
        AND length(btrim(NEW."spec" ->> key)) = 0
      )
  ) OR jsonb_typeof(NEW."spec" -> 'recipeVersionNumber') NOT IN ('number', 'null')
    OR (
      jsonb_typeof(NEW."spec" -> 'recipeVersionNumber') = 'number'
      AND (
        (NEW."spec" ->> 'recipeVersionNumber') !~ '^[1-9][0-9]*$'
        OR (NEW."spec" ->> 'recipeVersionNumber')::numeric > 9007199254740991
      )
    )
  THEN
    RAISE EXCEPTION 'coverage spec nullable provenance types mismatch';
  END IF;

  IF jsonb_typeof(NEW."spec" -> 'ingredients') <> 'array'
    OR jsonb_array_length(NEW."spec" -> 'ingredients') = 0
  THEN
    RAISE EXCEPTION 'coverage spec ingredients must be nonempty';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW."spec" -> 'ingredients') AS rows(item)
    WHERE jsonb_typeof(item) <> 'object'
      OR (
        SELECT array_agg(key ORDER BY key)
        FROM jsonb_object_keys(item) AS keys(key)
      ) IS DISTINCT FROM ARRAY['rawMaterialDefinitionId', 'shareBasisPoints']
      OR jsonb_typeof(item -> 'rawMaterialDefinitionId') <> 'string'
      OR length(btrim(item ->> 'rawMaterialDefinitionId')) = 0
      OR jsonb_typeof(item -> 'shareBasisPoints') <> 'number'
      OR (item ->> 'shareBasisPoints') !~ '^[1-9][0-9]*$'
  ) THEN
    RAISE EXCEPTION 'coverage spec ingredient shape is invalid';
  END IF;
  SELECT
    array_agg(item ->> 'rawMaterialDefinitionId' ORDER BY ordinality),
    array_agg(
      DISTINCT item ->> 'rawMaterialDefinitionId'
      ORDER BY item ->> 'rawMaterialDefinitionId'
    ),
    sum((item ->> 'shareBasisPoints')::bigint)
  INTO ingredient_ids, canonical_ingredient_ids, ingredient_total
  FROM jsonb_array_elements(NEW."spec" -> 'ingredients')
    WITH ORDINALITY AS rows(item, ordinality);
  IF ingredient_ids IS DISTINCT FROM canonical_ingredient_ids
    OR ingredient_total IS DISTINCT FROM 10000
  THEN
    RAISE EXCEPTION 'coverage spec ingredients must be sorted, unique and total 10000';
  END IF;

  SELECT "rollCode" INTO roll_code
  FROM "warehouse_rolls"
  WHERE "id" = NEW."rollId";
  IF roll_code IS NULL OR NEW."spec" ->> 'rollCode' IS DISTINCT FROM roll_code THEN
    RAISE EXCEPTION 'coverage spec rollCode does not match roll';
  END IF;
  IF NEW."spec" ->> 'sourceOrderId' IS DISTINCT FROM NEW."sourceOrderId"
    OR NEW."spec" ->> 'sourcePositionId' IS DISTINCT FROM NEW."sourcePositionId"
  THEN
    RAISE EXCEPTION 'coverage spec sourceOrder/sourcePosition provenance mismatch';
  END IF;

  IF NEW."actorKind" = 'user' THEN
    SELECT EXISTS (
      SELECT 1 FROM "users"
      WHERE "id" = NEW."actorId" AND "role" = NEW."actorRole"
    ) INTO actor_matches;
    IF NOT actor_matches THEN
      RAISE EXCEPTION 'coverage fact actor role mismatch';
    END IF;
  END IF;

  IF (NEW."sourceOrderId" IS NULL) IS DISTINCT FROM (NEW."sourcePositionId" IS NULL) THEN
    RAISE EXCEPTION 'coverage fact source order and position must be paired';
  END IF;
  IF NEW."sourcePositionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "commercial_order_positions"
    WHERE "id" = NEW."sourcePositionId"
      AND "orderId" = NEW."sourceOrderId"
  ) THEN
    RAISE EXCEPTION 'coverage fact sourcePosition does not belong to sourceOrder';
  END IF;

  IF NEW."source" = 'migration_backfill' THEN
    IF NEW."actorKind" <> 'system' OR NEW."reason" IS NOT NULL THEN
      RAISE EXCEPTION 'migration_backfill source requires system actor';
    END IF;
  ELSIF NEW."source" = 'warehouse_recheck' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'warehouse'::"Role"
      OR NEW."reason" IS NULL
      OR NEW."reason" <> btrim(NEW."reason")
      OR char_length(NEW."reason") NOT BETWEEN 3 AND 500
    THEN
      RAISE EXCEPTION 'warehouse_recheck source requires warehouse actor and reason';
    END IF;
  ELSIF NEW."source" = 'production_handover' THEN
    IF NEW."actorKind" <> 'user'
      OR NEW."actorRole" <> 'operator'::"Role"
      OR NEW."sourceOrderId" IS NULL
      OR NEW."sourcePositionId" IS NULL
      OR NEW."sourceDispatchItemId" IS NULL
      OR NEW."sourceWeightCaptureId" IS NULL
      OR NEW."reason" IS NOT NULL
    THEN
      RAISE EXCEPTION 'production_handover source evidence is incomplete';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "roll_dispatch_items" dispatch
      JOIN "production_orders" production
        ON production."id" = dispatch."productionOrderId"
      JOIN "operator_roll_lines" line
        ON line."rollDispatchItemId" = dispatch."id"
      JOIN "weight_captures" capture
        ON capture."operatorRollLineId" = line."id"
      WHERE dispatch."id" = NEW."sourceDispatchItemId"
        AND dispatch."rollCode" = roll_code
        AND dispatch."orderLineId" = NEW."sourcePositionId"
        AND production."commercialOrderId" = NEW."sourceOrderId"
        AND capture."id" = NEW."sourceWeightCaptureId"
        AND capture."kind" = 'roll'
        AND capture."stable"
        AND capture."netKg" IS NOT NULL
        AND round(capture."netKg"::numeric * 1000)::bigint =
          (NEW."spec" ->> 'actualWeightMilliKg')::bigint
    ) THEN
      RAISE EXCEPTION 'production_handover dispatch or stable weight capture mismatch';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'coverage spec canonical numeric value is invalid';
END;
$$;

COMMIT;
