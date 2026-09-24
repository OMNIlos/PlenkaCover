DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "domain_events"
    WHERE "type" IN (
      'audit:pallet_list_print_requested',
      'audit:pallet_list_reprint_requested'
    )
      AND "detail"->>'channel' = 'browser_system_print'
      AND "detail"->>'requestId' IS NOT NULL
    GROUP BY lower("detail"->>'requestId')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot canonicalize pallet system print request ids: case-insensitive duplicates exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "domain_events_pallet_system_print_request_id_ci_key"
ON "domain_events" (lower("detail"->>'requestId'))
WHERE "type" IN (
  'audit:pallet_list_print_requested',
  'audit:pallet_list_reprint_requested'
)
  AND "detail"->>'channel' = 'browser_system_print'
  AND "detail"->>'requestId' IS NOT NULL;
