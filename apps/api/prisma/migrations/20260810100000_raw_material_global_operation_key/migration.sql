BEGIN;

DO $$
DECLARE
  duplicate_operation_key TEXT;
BEGIN
  SELECT lower("detail"->>'operationKey')
  INTO duplicate_operation_key
  FROM "domain_events"
  WHERE "type" IN (
    'audit:inventory_manual_correction',
    'audit:raw_material_received'
  )
    AND "detail" ? 'operationKey'
    AND "detail"->>'operationKey' IS NOT NULL
  GROUP BY lower("detail"->>'operationKey')
  HAVING COUNT(*) > 1
  ORDER BY lower("detail"->>'operationKey')
  LIMIT 1;

  IF duplicate_operation_key IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate raw-material operationKey: %', duplicate_operation_key
      USING
        ERRCODE = 'unique_violation',
        CONSTRAINT = 'domain_events_raw_material_operation_key_key';
  END IF;
END
$$;

CREATE UNIQUE INDEX "domain_events_raw_material_operation_key_key"
  ON "domain_events" ((lower("detail"->>'operationKey')))
  WHERE "type" IN (
    'audit:inventory_manual_correction',
    'audit:raw_material_received'
  )
    AND "detail" ? 'operationKey'
    AND "detail"->>'operationKey' IS NOT NULL;

COMMIT;
