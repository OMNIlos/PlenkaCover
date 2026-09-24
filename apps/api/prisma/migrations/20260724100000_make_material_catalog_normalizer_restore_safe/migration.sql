BEGIN;

CREATE OR REPLACE FUNCTION "normalize_material_catalog_name"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
BEGIN ATOMIC
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
  ) AS normalized;
END;

COMMIT;
