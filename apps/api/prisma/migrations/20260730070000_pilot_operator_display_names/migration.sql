UPDATE "users"
SET "displayName" = CASE "externalId"
  WHEN 'seed-operator' THEN 'Ахметов Булат'
  WHEN 'seed-operator-2' THEN 'Хабибулин Руслан'
  WHEN 'seed-operator-3' THEN 'Гайнулин Ильназ'
  ELSE "displayName"
END
WHERE "externalId" IN ('seed-operator', 'seed-operator-2', 'seed-operator-3');
