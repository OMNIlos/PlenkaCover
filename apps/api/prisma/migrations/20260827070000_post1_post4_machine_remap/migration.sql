BEGIN;

-- Register the one-shot post-catalog actor without weakening the closed actor vocabulary.
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
          'payroll_tariff_bootstrap',
          'post_catalog_migration'
        )
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'existing domain event violates actor XOR policy'
      USING ERRCODE = '23514',
            CONSTRAINT = 'domain_events_actor_xor_post_catalog_v2';
  END IF;
END
$domain_event_actor_preflight$;

ALTER TABLE "domain_events"
  ADD CONSTRAINT "domain_events_actor_xor_post_catalog_v2"
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
          'payroll_tariff_bootstrap',
          'post_catalog_migration'
        )
      )
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE "domain_events"
  VALIDATE CONSTRAINT "domain_events_actor_xor_post_catalog_v2";

LOCK TABLE "domain_events" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "domain_events"
  DROP CONSTRAINT "domain_events_actor_xor";

ALTER TABLE "domain_events"
  RENAME CONSTRAINT "domain_events_actor_xor_post_catalog_v2" TO "domain_events_actor_xor";

DO $post_catalog_remap$
DECLARE
  post_count INTEGER;
  post1_id TEXT;
  post1_name TEXT;
  post4_id TEXT;
  post4_name TEXT;
  changed_count INTEGER;
  operation_key UUID := gen_random_uuid();
BEGIN
  PERFORM "id"
  FROM "posts"
  WHERE "code" IN ('POST-1', 'POST-4')
  ORDER BY "code"
  FOR UPDATE;

  SELECT
    count(*),
    max("id") FILTER (WHERE "code" = 'POST-1'),
    max("name") FILTER (WHERE "code" = 'POST-1'),
    max("id") FILTER (WHERE "code" = 'POST-4'),
    max("name") FILTER (WHERE "code" = 'POST-4')
  INTO post_count, post1_id, post1_name, post4_id, post4_name
  FROM "posts"
  WHERE "code" IN ('POST-1', 'POST-4');

  IF post_count <> 2 THEN
    RAISE EXCEPTION 'POST-1 and POST-4 must both exist for machine catalog remap'
      USING ERRCODE = '23514',
            CONSTRAINT = 'post_catalog_remap_state_ck';
  END IF;

  IF post1_name = 'Китайка старая' AND post4_name = 'Бегемот' THEN
    RETURN;
  END IF;

  IF post1_name IS DISTINCT FROM 'Бегемот'
    OR post4_name IS DISTINCT FROM 'Китайка старая'
  THEN
    RAISE EXCEPTION 'unexpected POST-1/POST-4 machine catalog state'
      USING ERRCODE = '23514',
            CONSTRAINT = 'post_catalog_remap_state_ck';
  END IF;

  UPDATE "posts"
  SET "name" = CASE "code"
    WHEN 'POST-1' THEN 'Китайка старая'
    WHEN 'POST-4' THEN 'Бегемот'
  END
  WHERE "code" IN ('POST-1', 'POST-4');

  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 2 THEN
    RAISE EXCEPTION 'machine catalog remap did not update exactly two posts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'post_catalog_remap_state_ck';
  END IF;

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
    "oldValue",
    "newValue",
    "reason",
    "createdAt"
  ) VALUES
    (
      gen_random_uuid()::TEXT,
      'admin',
      'admin.post.updated',
      post1_id,
      'system',
      NULL,
      NULL,
      'post_catalog_migration',
      'Исправлено соответствие POST-1 станку',
      jsonb_build_object('operationKey', operation_key::TEXT),
      jsonb_build_object('name', post1_name),
      jsonb_build_object('name', 'Китайка старая'),
      'Исправление соответствия POST-1/POST-4 станкам',
      CURRENT_TIMESTAMP
    ),
    (
      gen_random_uuid()::TEXT,
      'admin',
      'admin.post.updated',
      post4_id,
      'system',
      NULL,
      NULL,
      'post_catalog_migration',
      'Исправлено соответствие POST-4 станку',
      jsonb_build_object('operationKey', operation_key::TEXT),
      jsonb_build_object('name', post4_name),
      jsonb_build_object('name', 'Бегемот'),
      'Исправление соответствия POST-1/POST-4 станкам',
      CURRENT_TIMESTAMP
    );
END
$post_catalog_remap$;

COMMIT;
