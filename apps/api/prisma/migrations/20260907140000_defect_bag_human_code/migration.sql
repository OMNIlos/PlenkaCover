BEGIN;

WITH "legacy_shift_names" AS (
  SELECT
    s."id",
    'Смена '
      || to_char(
        (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Moscow',
        'DD.MM.YYYY'
      )
      || ' · '
      || u."displayName"
      || ' · '
      || p."code" AS "label"
  FROM "shifts" AS s
  JOIN "operator_shift_machine_assignments" AS a ON a."shiftId" = s."id"
  JOIN "users" AS u ON u."id" = a."operatorId"
  JOIN "posts" AS p ON p."id" = a."postId"
  WHERE s."label" ~ '^Смена оператора c[a-z0-9]{20,}$'
    AND (
      SELECT count(*)
      FROM "operator_shift_machine_assignments" AS candidate
      WHERE candidate."shiftId" = s."id"
    ) = 1
)
UPDATE "shifts" AS s
SET "label" = legacy."label"
FROM "legacy_shift_names" AS legacy
WHERE s."id" = legacy."id";

CREATE SEQUENCE "defect_bag_code_sequence" AS BIGINT MINVALUE 1 START WITH 1;

SELECT setval(
  'defect_bag_code_sequence',
  GREATEST((SELECT COUNT(*) FROM "defect_bags"), 1),
  EXISTS (SELECT 1 FROM "defect_bags")
);

COMMIT;
