-- Coverage projections and normalized recheck memberships may have no reason
-- when there is no uncertainty. Calculation state checks still require the
-- exact non-empty reason set for every persisted availability.
CREATE OR REPLACE FUNCTION "warehouse_coverage_is_reason_codes"(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path FROM CURRENT
AS $$
  SELECT
    "warehouse_coverage_is_sorted_unique_text_array"(value, false)
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(value) AS reason(code)
      WHERE code NOT IN (
        'full_cover_available',
        'no_compatible_rolls',
        'only_partial_cover',
        'order_spec_incomplete',
        'roll_facts_incomplete',
        'roll_ownership_unverified',
        'unsupported_policy_version',
        'inventory_changed',
        'warehouse_recheck_pending'
      )
    );
$$;
