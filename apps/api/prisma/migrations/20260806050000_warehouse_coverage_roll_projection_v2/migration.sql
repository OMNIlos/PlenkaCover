BEGIN;

CREATE FUNCTION "warehouse_coverage_roll_specification_shape"(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  actual_keys TEXT[];
  expected_keys CONSTANT TEXT[] := ARRAY[
    'accountingThicknessMicron',
    'actualThicknessMicron',
    'birka',
    'filmType',
    'materialLabel',
    'netKg',
    'plannedLengthM',
    'spoolType',
    'widthMm'
  ];
  key TEXT;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(item ORDER BY item)
  INTO actual_keys
  FROM jsonb_object_keys(value) AS keys(item);

  IF actual_keys IS DISTINCT FROM expected_keys THEN
    RETURN false;
  END IF;

  FOREACH key IN ARRAY ARRAY['filmType', 'spoolType', 'birka', 'materialLabel']
  LOOP
    IF jsonb_typeof(value -> key) NOT IN ('string', 'null')
      OR (
        jsonb_typeof(value -> key) = 'string'
        AND length(btrim(value ->> key)) = 0
      )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  FOREACH key IN ARRAY ARRAY[
    'actualThicknessMicron',
    'accountingThicknessMicron',
    'widthMm',
    'plannedLengthM',
    'netKg'
  ]
  LOOP
    IF jsonb_typeof(value -> key) NOT IN ('number', 'null')
      OR (
        jsonb_typeof(value -> key) = 'number'
        AND (value ->> key)::numeric <= 0
      )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION "warehouse_coverage_finance_roll_shape"(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  actual_keys TEXT[];
  legacy_keys CONSTANT TEXT[] := ARRAY['positionId', 'rollCode'];
  v2_keys CONSTANT TEXT[] := ARRAY[
    'availability',
    'batchCode',
    'grossKg',
    'locationLabel',
    'matched',
    'positionId',
    'receivedAt',
    'requested',
    'rollCode',
    'source',
    'spoolKg'
  ];
  key TEXT;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;

  SELECT array_agg(item ORDER BY item)
  INTO actual_keys
  FROM jsonb_object_keys(value) AS keys(item);

  IF actual_keys = legacy_keys THEN
    RETURN jsonb_typeof(value -> 'positionId') = 'string'
      AND jsonb_typeof(value -> 'rollCode') = 'string'
      AND length(btrim(value ->> 'positionId')) > 0
      AND length(btrim(value ->> 'rollCode')) > 0;
  END IF;

  IF actual_keys IS DISTINCT FROM v2_keys
    OR jsonb_typeof(value -> 'positionId') <> 'string'
    OR jsonb_typeof(value -> 'rollCode') <> 'string'
    OR jsonb_typeof(value -> 'source') <> 'string'
    OR jsonb_typeof(value -> 'locationLabel') <> 'string'
    OR jsonb_typeof(value -> 'availability') <> 'string'
    OR length(btrim(value ->> 'positionId')) = 0
    OR length(btrim(value ->> 'rollCode')) = 0
    OR length(btrim(value ->> 'locationLabel')) = 0
    OR value ->> 'source' NOT IN ('platform', 'production', 'legacy')
    OR value ->> 'availability' NOT IN ('available', 'reserved')
    OR jsonb_typeof(value -> 'batchCode') NOT IN ('string', 'null')
    OR (
      jsonb_typeof(value -> 'batchCode') = 'string'
      AND length(btrim(value ->> 'batchCode')) = 0
    )
    OR jsonb_typeof(value -> 'receivedAt') NOT IN ('string', 'null')
    OR (
      jsonb_typeof(value -> 'receivedAt') = 'string'
      AND value ->> 'receivedAt'
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )
    OR NOT "warehouse_coverage_roll_specification_shape"(value -> 'requested')
    OR NOT "warehouse_coverage_roll_specification_shape"(value -> 'matched')
  THEN
    RETURN false;
  END IF;

  FOREACH key IN ARRAY ARRAY['grossKg', 'spoolKg']
  LOOP
    IF jsonb_typeof(value -> key) NOT IN ('number', 'null')
      OR (
        jsonb_typeof(value -> key) = 'number'
        AND (value ->> key)::numeric <= 0
      )
    THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION "warehouse_coverage_has_exact_keys"(
  value JSONB,
  expected TEXT[]
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  actual_keys TEXT[];
  expected_keys TEXT[];
BEGIN
  SELECT array_agg(key ORDER BY key)
  INTO actual_keys
  FROM jsonb_object_keys(value) AS keys(key);

  SELECT array_agg(key ORDER BY key)
  INTO expected_keys
  FROM unnest(expected) AS keys(key);

  IF expected_keys = ARRAY['positionId', 'rollCode'] THEN
    RETURN "warehouse_coverage_finance_roll_shape"(value);
  END IF;

  RETURN jsonb_typeof(value) = 'object'
    AND actual_keys IS NOT DISTINCT FROM expected_keys;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

COMMIT;
