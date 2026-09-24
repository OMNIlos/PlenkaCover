-- 1C permits distinct nomenclature rows to share the same display name.
-- Keep the exact source-owned display name while allowing a deterministic,
-- bounded internal identity for the second and subsequent Ref_Key values.
ALTER TABLE "raw_material_definitions"
  DROP CONSTRAINT "raw_material_definitions_normalized_name_check";

ALTER TABLE "raw_material_definitions"
  ADD CONSTRAINT "raw_material_definitions_normalized_name_check"
  CHECK (
    char_length("normalizedName") BETWEEN 1 AND 120
    AND (
      "normalizedName" = "normalize_material_catalog_name"("name")
      OR (
        "externalId" IS NOT NULL
        AND "normalizedName" =
          left(
            "normalize_material_catalog_name"("name"),
            greatest(
              0,
              120 - char_length(' · 1c:' || lower("externalId"))
            )
          ) || ' · 1c:' || lower("externalId")
      )
    )
  );
