INSERT INTO "counterparties"
  ("id", "displayName", "legalName", "inn", "billingSource", "syncStatus", "externalId")
VALUES
  ('cp-uralpak', 'УралПак', 'ООО «УралПак»', '0268042190', 'mock_1C', 'needs_discovery', 'mock-counterparty-uralpak'),
  ('cp-paketprom', 'ПакетПром', 'ООО «ПакетПром»', '0274011180', 'mock_1C', 'needs_discovery', 'mock-counterparty-paketprom'),
  ('cp-severpak', 'СеверПак', 'ООО «СеверПак»', '0278123400', 'mock_1C', 'needs_discovery', 'mock-counterparty-severpak')
ON CONFLICT ("id") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "legalName" = COALESCE("counterparties"."legalName", EXCLUDED."legalName"),
  "inn" = COALESCE("counterparties"."inn", EXCLUDED."inn"),
  "billingSource" = COALESCE("counterparties"."billingSource", EXCLUDED."billingSource"),
  "syncStatus" = COALESCE("counterparties"."syncStatus", EXCLUDED."syncStatus"),
  "externalId" = COALESCE("counterparties"."externalId", EXCLUDED."externalId");

INSERT INTO "counterparty_order_templates"
  (
    "id",
    "counterpartyId",
    "name",
    "description",
    "status",
    "ownerRole",
    "positions",
    "usageCount",
    "lastUsedAt",
    "createdAt",
    "updatedAt"
  )
VALUES
  (
    'tpl-uralpak-sleeve-80',
    'cp-uralpak',
    'УралПак · рукав 80 мкм',
    'Baseline template migrated from the frontend counterparty catalog.',
    'active',
    'production_lead',
    '[{"rollCount":3,"filmType":"Рукав","actualThickness":"80 мкм","accountingThickness":"80 мкм","rawMaterialId":"rm-pvd-15803","spoolType":"Шпуля 76 мм","birka":"Прозрачный с маркировкой","recipeParameters":[{"label":"Позиции","value":"3 рулона, рукав 80 мкм"},{"label":"Тип пленки","value":"Рукав"},{"label":"Толщина","value":"80 мкм"},{"label":"Цвет","value":"Прозрачный с маркировкой"},{"label":"Рулоны","value":"3 шт. по 41.2 кг"},{"label":"Сырье","value":"М1 по шаблону"},{"label":"Втулка","value":"76 мм"},{"label":"Расходники","value":"Скотч, этикетка, упаковка"},{"label":"Условия","value":"Счет после согласованного заказ-наряда"},{"label":"Рассрочка","value":"30 календарных дней после закрытой выдачи"},{"label":"Вид оплаты","value":"bank"}]}]'::jsonb,
    18,
    NULL,
    '2026-06-08 00:00:00.000',
    '2026-06-08 00:00:00.000'
  ),
  (
    'tpl-uralpak-sleeve-60',
    'cp-uralpak',
    'УралПак · рукав 60 мкм',
    'Baseline template migrated from the frontend counterparty catalog.',
    'active',
    'production_lead',
    '[{"rollCount":2,"filmType":"Рукав","actualThickness":"60 мкм","accountingThickness":"60 мкм","rawMaterialId":"rm-pvd-15803","spoolType":"Шпуля 76 мм","birka":"Молочный","recipeParameters":[{"label":"Позиции","value":"2 рулона, рукав 60 мкм"},{"label":"Тип пленки","value":"Рукав"},{"label":"Толщина","value":"60 мкм"},{"label":"Цвет","value":"Молочный"},{"label":"Рулоны","value":"2 шт., вес уточнить"},{"label":"Сырье","value":"М1 по шаблону"},{"label":"Втулка","value":"76 мм"},{"label":"Расходники","value":"Скотч, этикетка"},{"label":"Условия","value":"Согласование без решения директора, если нет отличий"},{"label":"Рассрочка","value":"30 календарных дней после закрытой выдачи"},{"label":"Вид оплаты","value":"bank"}]}]'::jsonb,
    12,
    NULL,
    '2026-06-07 00:00:00.000',
    '2026-06-07 00:00:00.000'
  ),
  (
    'tpl-paketprom-milk-60',
    'cp-paketprom',
    'ПакетПром · молочная пленка 60',
    'Baseline template migrated from the frontend counterparty catalog.',
    'active',
    'production_lead',
    '[{"rollCount":2,"filmType":"Полотно","actualThickness":"60 мкм","accountingThickness":"60 мкм","rawMaterialId":"rm-pvd-15803","spoolType":"Шпуля 76 мм","birka":"Молочный","recipeParameters":[{"label":"Позиции","value":"2 рулона, молочная пленка"},{"label":"Тип пленки","value":"Полотно"},{"label":"Толщина","value":"60 мкм"},{"label":"Цвет","value":"Молочный"},{"label":"Рулоны","value":"2 шт., 78 кг план"},{"label":"Сырье","value":"М1 по шаблону"},{"label":"Втулка","value":"76 мм"},{"label":"Расходники","value":"Скотч, этикетка"},{"label":"Условия","value":"Счет после согласованного заказ-наряда"},{"label":"Рассрочка","value":"14 календарных дней после закрытой выдачи"},{"label":"Вид оплаты","value":"mixed"}]}]'::jsonb,
    9,
    NULL,
    '2026-06-08 00:00:00.000',
    '2026-06-08 00:00:00.000'
  ),
  (
    'tpl-paketprom-quick',
    'cp-paketprom',
    'ПакетПром · быстрый повтор',
    'Baseline template migrated from the frontend counterparty catalog.',
    'active',
    'production_lead',
    '[{"rollCount":1,"filmType":"Повтор клиента","actualThickness":"60 мкм","accountingThickness":"60 мкм","rawMaterialId":"rm-pvd-10803","spoolType":"Шпуля 76 мм","birka":"Молочный","recipeParameters":[{"label":"Позиции","value":"1 рулон, типовой повтор"},{"label":"Тип пленки","value":"Повтор клиента"},{"label":"Толщина","value":"60 мкм"},{"label":"Цвет","value":"Молочный"},{"label":"Рулоны","value":"1 шт., вес по заявке"},{"label":"Сырье","value":"М2 допускается"},{"label":"Втулка","value":"76 мм"},{"label":"Расходники","value":"Скотч, этикетка"},{"label":"Условия","value":"Разовое применение без изменения текущих заказов"},{"label":"Рассрочка","value":"30 календарных дней после закрытой выдачи"},{"label":"Вид оплаты","value":"unknown до ручной сверки"}]}]'::jsonb,
    4,
    NULL,
    '2026-06-05 00:00:00.000',
    '2026-06-05 00:00:00.000'
  ),
  (
    'tpl-severpak-clear-40',
    'cp-severpak',
    'СеверПак · полотно 40 мкм',
    'Baseline template migrated from the frontend counterparty catalog.',
    'active',
    'production_lead',
    '[{"rollCount":4,"filmType":"Полотно","actualThickness":"40 мкм","accountingThickness":"40 мкм","rawMaterialId":"rm-pvd-15803","spoolType":"Шпуля 76 мм","birka":"Прозрачный","recipeParameters":[{"label":"Позиции","value":"4 рулона, полотно 40 мкм"},{"label":"Тип пленки","value":"Полотно"},{"label":"Толщина","value":"40 мкм"},{"label":"Цвет","value":"Прозрачный"},{"label":"Рулоны","value":"4 шт. по 35 кг"},{"label":"Сырье","value":"М1 первичное"},{"label":"Втулка","value":"76 мм"},{"label":"Расходники","value":"Скотч, этикетка"},{"label":"Условия","value":"Рассрочка из карточки клиента"},{"label":"Рассрочка","value":"manual_review, не менять запущенные заказы без версии"},{"label":"Вид оплаты","value":"cash"}]}]'::jsonb,
    6,
    NULL,
    '2026-06-04 00:00:00.000',
    '2026-06-04 00:00:00.000'
  )
ON CONFLICT ("id") DO UPDATE SET
  "counterpartyId" = EXCLUDED."counterpartyId",
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "status" = EXCLUDED."status",
  "ownerRole" = EXCLUDED."ownerRole",
  "positions" = EXCLUDED."positions",
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "counterparty_order_templates"."positions"::text LIKE '%шаблон УралПак 80%' OR
  "counterparty_order_templates"."positions"::text LIKE '%шаблон УралПак 60%';
