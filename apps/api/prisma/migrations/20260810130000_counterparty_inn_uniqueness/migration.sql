BEGIN;

DO $$
DECLARE
  duplicate_inn TEXT;
BEGIN
  SELECT NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '')
  INTO duplicate_inn
  FROM "counterparties"
  WHERE "billingSource" = 'manual_platform'
    AND "inn" IS NOT NULL
    AND NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '') IS NOT NULL
  GROUP BY NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '')
  HAVING COUNT(*) > 1
  ORDER BY NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '')
  LIMIT 1;

  IF duplicate_inn IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate canonical counterparty INN: %', duplicate_inn
      USING
        ERRCODE = 'unique_violation',
        CONSTRAINT = 'counterparties_manual_inn_key';
  END IF;
END
$$;

UPDATE "counterparties"
SET "inn" = NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '')
WHERE "billingSource" = 'manual_platform'
  AND "inn" IS DISTINCT FROM
  NULLIF(upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g')), '');

CREATE UNIQUE INDEX "counterparties_manual_inn_key"
  ON "counterparties" (
    upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g'))
  )
WHERE "billingSource" = 'manual_platform'
  AND "inn" IS NOT NULL;

COMMIT;
