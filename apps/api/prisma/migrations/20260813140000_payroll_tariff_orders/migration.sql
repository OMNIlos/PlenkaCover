BEGIN;

-- Register the one-shot bootstrap actor without weakening the closed actor vocabulary.
DO $domain_event_actor_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "domain_events"
    WHERE (
      (
        "actorKind" = 'user'
        AND "actorRole" IS NOT NULL
        AND "systemActorKey" IS NULL
      )
      OR
      (
        "actorKind" = 'system'
        AND "actorRole" IS NULL
        AND "actorId" IS NULL
        AND "systemActorKey" IN (
          'warehouse_coverage_engine',
          'warehouse-pallet-cutover',
          'onec_finance_sync',
          'production_cost_reconciler',
          'payroll_tariff_bootstrap'
        )
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'existing domain event violates actor XOR policy'
      USING ERRCODE = '23514',
            CONSTRAINT = 'domain_events_actor_xor_payroll_tariff_v2';
  END IF;
END
$domain_event_actor_preflight$;

ALTER TABLE "domain_events"
  ADD CONSTRAINT "domain_events_actor_xor_payroll_tariff_v2"
  CHECK (
    (
      (
        "actorKind" = 'user'
        AND "actorRole" IS NOT NULL
        AND "systemActorKey" IS NULL
      )
      OR
      (
        "actorKind" = 'system'
        AND "actorRole" IS NULL
        AND "actorId" IS NULL
        AND "systemActorKey" IN (
          'warehouse_coverage_engine',
          'warehouse-pallet-cutover',
          'onec_finance_sync',
          'production_cost_reconciler',
          'payroll_tariff_bootstrap'
        )
      )
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE "domain_events"
  VALIDATE CONSTRAINT "domain_events_actor_xor_payroll_tariff_v2";

LOCK TABLE "domain_events" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "domain_events"
  DROP CONSTRAINT "domain_events_actor_xor";

ALTER TABLE "domain_events"
  RENAME CONSTRAINT "domain_events_actor_xor_payroll_tariff_v2" TO "domain_events_actor_xor";

CREATE TABLE "payroll_tariff_orders" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'RUB',
  "matrix" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdById" TEXT,
  "updatedById" TEXT,
  "publishedById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),

  CONSTRAINT "payroll_tariff_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_tariff_orders_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "payroll_tariff_orders_status_check"
    CHECK ("status" IN ('draft', 'published')),
  CONSTRAINT "payroll_tariff_orders_currency_check"
    CHECK ("currency" = 'RUB'),
  CONSTRAINT "payroll_tariff_orders_revision_check"
    CHECK ("revision" >= 1),
  CONSTRAINT "payroll_tariff_orders_creator_check"
    CHECK (
      "createdById" IS NOT NULL
      OR "id" = 'payroll-tariff-order-8-09-25-2025-09-29'
    ),
  CONSTRAINT "payroll_tariff_orders_publication_check"
    CHECK (
      (
        "status" = 'draft'
        AND "publishedAt" IS NULL
        AND "publishedById" IS NULL
      )
      OR
      (
        "status" = 'published'
        AND "publishedAt" IS NOT NULL
        AND (
          "publishedById" IS NOT NULL
          OR "id" = 'payroll-tariff-order-8-09-25-2025-09-29'
        )
      )
    )
);

CREATE TABLE "payroll_tariff_order_commands" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "resultSnapshot" JSONB NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payroll_tariff_order_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_tariff_order_commands_action_check"
    CHECK ("action" IN ('create', 'update', 'publish')),
  CONSTRAINT "payroll_tariff_order_commands_operation_key_v4_check"
    CHECK (
      substring("operationKey"::text from 15 for 1) = '4'
      AND substring("operationKey"::text from 20 for 1) ~ '^[89ab]$'
    ),
  CONSTRAINT "payroll_tariff_order_commands_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "payroll_tariff_order_commands_result_check"
    CHECK (jsonb_typeof("resultSnapshot") = 'object')
);

CREATE UNIQUE INDEX "payroll_tariff_orders_published_effective_from_uq"
  ON "payroll_tariff_orders"("effectiveFrom")
  WHERE "status" = 'published';
CREATE INDEX "payroll_tariff_orders_schedule_idx"
  ON "payroll_tariff_orders"("status", "effectiveFrom" DESC, "id");
CREATE UNIQUE INDEX "payroll_tariff_order_commands_operationKey_key"
  ON "payroll_tariff_order_commands"("operationKey");
CREATE INDEX "payroll_tariff_order_commands_orderId_createdAt_id_idx"
  ON "payroll_tariff_order_commands"("orderId", "createdAt", "id");

ALTER TABLE "payroll_tariff_orders"
  ADD CONSTRAINT "payroll_tariff_orders_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_tariff_orders"
  ADD CONSTRAINT "payroll_tariff_orders_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_tariff_orders"
  ADD CONSTRAINT "payroll_tariff_orders_publishedById_fkey"
  FOREIGN KEY ("publishedById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_tariff_order_commands"
  ADD CONSTRAINT "payroll_tariff_order_commands_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "payroll_tariff_orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payroll_tariff_order_commands"
  ADD CONSTRAINT "payroll_tariff_order_commands_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "guard_payroll_tariff_order_history"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR OLD."status" = 'published' THEN
    RAISE EXCEPTION 'published payroll tariff order history is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'payroll_tariff_orders_lifecycle_guard';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "payroll_tariff_orders_lifecycle_guard"
BEFORE UPDATE OR DELETE ON "payroll_tariff_orders"
FOR EACH ROW EXECUTE FUNCTION "guard_payroll_tariff_order_history"();
CREATE TRIGGER "payroll_tariff_orders_no_truncate"
BEFORE TRUNCATE ON "payroll_tariff_orders"
FOR EACH STATEMENT EXECUTE FUNCTION "guard_payroll_tariff_order_history"();

CREATE FUNCTION "reject_payroll_tariff_order_command_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'payroll tariff order commands are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'payroll_tariff_order_commands_append_only';
END
$$;

CREATE TRIGGER "payroll_tariff_order_commands_append_only"
BEFORE UPDATE OR DELETE ON "payroll_tariff_order_commands"
FOR EACH ROW EXECUTE FUNCTION "reject_payroll_tariff_order_command_mutation"();
CREATE TRIGGER "payroll_tariff_order_commands_no_truncate"
BEFORE TRUNCATE ON "payroll_tariff_order_commands"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_payroll_tariff_order_command_mutation"();

INSERT INTO "payroll_tariff_orders" (
  "id",
  "name",
  "status",
  "effectiveFrom",
  "currency",
  "matrix",
  "revision",
  "createdById",
  "updatedById",
  "publishedById",
  "createdAt",
  "updatedAt",
  "publishedAt"
) VALUES (
  'payroll-tariff-order-8-09-25-2025-09-29',
  'Приказ № 8-09/25',
  'published',
  '2025-09-28 21:00:00+00'::TIMESTAMPTZ,
  'RUB',
  '{
    "schemaVersion": 1,
    "ladders": {
      "urp12h": [
        {"maxInclusiveGrams": 750000, "primaryRateKopecksPerKg": 400, "secondaryRateKopecksPerKg": 500},
        {"maxInclusiveGrams": 1000000, "primaryRateKopecksPerKg": 450, "secondaryRateKopecksPerKg": 550},
        {"maxInclusiveGrams": 1250000, "primaryRateKopecksPerKg": 500, "secondaryRateKopecksPerKg": 600},
        {"maxInclusiveGrams": null, "primaryRateKopecksPerKg": 550, "secondaryRateKopecksPerKg": 650}
      ],
      "urp24h": [
        {"maxInclusiveGrams": 1500000, "primaryRateKopecksPerKg": 400, "secondaryRateKopecksPerKg": 500},
        {"maxInclusiveGrams": 2000000, "primaryRateKopecksPerKg": 450, "secondaryRateKopecksPerKg": 550},
        {"maxInclusiveGrams": 2500000, "primaryRateKopecksPerKg": 500, "secondaryRateKopecksPerKg": 600},
        {"maxInclusiveGrams": null, "primaryRateKopecksPerKg": 550, "secondaryRateKopecksPerKg": 650}
      ],
      "abc12h": [
        {"maxInclusiveGrams": 1300000, "standardRateKopecksPerKg": 450, "blackWhiteRateKopecksPerKg": 500},
        {"maxInclusiveGrams": null, "standardRateKopecksPerKg": 500, "blackWhiteRateKopecksPerKg": 550}
      ],
      "abc24h": [
        {"maxInclusiveGrams": 2600000, "standardRateKopecksPerKg": 450, "blackWhiteRateKopecksPerKg": 500},
        {"maxInclusiveGrams": null, "standardRateKopecksPerKg": 500, "blackWhiteRateKopecksPerKg": 550}
      ]
    },
    "specialRules": {
      "thinRoll": {"enabled": true, "maxExclusiveGrams": 7000, "rateKopecksPerKg": 650},
      "alabuga": {
        "enabled": true,
        "machineFamily": "abc_new",
        "normalizedLegalName": "ОЭЗ ППТ АЛАБУГА АО",
        "rateKopecksPerKg": 400
      }
    }
  }'::JSONB,
  1,
  NULL,
  NULL,
  NULL,
  '2025-09-28 21:00:00+00'::TIMESTAMPTZ,
  '2025-09-28 21:00:00+00'::TIMESTAMPTZ,
  '2025-09-28 21:00:00+00'::TIMESTAMPTZ
);

INSERT INTO "domain_events" (
  "id",
  "family",
  "type",
  "objectId",
  "actorKind",
  "actorRole",
  "actorId",
  "systemActorKey",
  "label",
  "detail",
  "newValue",
  "createdAt"
) VALUES (
  'payroll-tariff-order-8-09-25-bootstrap-event',
  'audit',
  'audit:payroll_tariff_order_created',
  'payroll-tariff-order-8-09-25-2025-09-29',
  'system',
  NULL,
  NULL,
  'payroll_tariff_bootstrap',
  'Создан приказ по тарифам зарплаты № 8-09/25',
  jsonb_build_object(
    'bootstrap', true,
    'status', 'published',
    'effectiveFrom', '2025-09-29',
    'revision', 1
  ),
  jsonb_build_object(
    'id', 'payroll-tariff-order-8-09-25-2025-09-29',
    'name', 'Приказ № 8-09/25',
    'effectiveFrom', '2025-09-29',
    'currency', 'RUB'
  ),
  '2025-09-28 21:00:00+00'::TIMESTAMPTZ
);

COMMIT;
