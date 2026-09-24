BEGIN;

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
        AND "systemActorKey" IS NOT NULL
        AND "systemActorKey" IN (
          'warehouse_coverage_engine',
          'warehouse-pallet-cutover',
          'onec_finance_sync',
          'production_cost_reconciler'
        )
      )
    ) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'existing domain event violates actor XOR policy'
      USING ERRCODE = '23514',
            CONSTRAINT = 'domain_events_actor_xor_production_cost_v2';
  END IF;
END
$domain_event_actor_preflight$;

ALTER TABLE "domain_events"
  ADD CONSTRAINT "domain_events_actor_xor_production_cost_v2"
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
        AND "systemActorKey" IS NOT NULL
        AND "systemActorKey" IN (
          'warehouse_coverage_engine',
          'warehouse-pallet-cutover',
          'onec_finance_sync',
          'production_cost_reconciler'
        )
      )
    ) IS TRUE
  ) NOT VALID;

ALTER TABLE "domain_events"
  VALIDATE CONSTRAINT "domain_events_actor_xor_production_cost_v2";

LOCK TABLE "domain_events" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "domain_events"
  DROP CONSTRAINT "domain_events_actor_xor";

ALTER TABLE "domain_events"
  RENAME CONSTRAINT "domain_events_actor_xor_production_cost_v2" TO "domain_events_actor_xor";

CREATE TABLE "spool_price_references" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "spoolTypeKey" VARCHAR(200) NOT NULL,
  "spoolTypeLabel" VARCHAR(200) NOT NULL,
  "priceKopecksPerMeter" BIGINT NOT NULL,
  "source" VARCHAR(200) NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdByRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "spool_price_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spool_price_references_request_fingerprint_ck"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "spool_price_references_key_nonblank_ck"
    CHECK (length(btrim("spoolTypeKey")) BETWEEN 1 AND 200),
  CONSTRAINT "spool_price_references_label_nonblank_ck"
    CHECK (length(btrim("spoolTypeLabel")) BETWEEN 1 AND 200),
  CONSTRAINT "spool_price_references_price_positive_ck"
    CHECK ("priceKopecksPerMeter" > 0 AND "priceKopecksPerMeter" <= 9007199254740991),
  CONSTRAINT "spool_price_references_source_nonblank_ck"
    CHECK (length(btrim("source")) BETWEEN 1 AND 200),
  CONSTRAINT "spool_price_references_reason_nonblank_ck"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX "spool_price_references_operationKey_key"
  ON "spool_price_references"("operationKey");
CREATE UNIQUE INDEX "spool_price_references_spoolTypeKey_effectiveFrom_key"
  ON "spool_price_references"("spoolTypeKey", "effectiveFrom");
CREATE INDEX "spool_price_references_spoolTypeKey_effectiveFrom_id_idx"
  ON "spool_price_references"("spoolTypeKey", "effectiveFrom", "id");
ALTER TABLE "spool_price_references"
  ADD CONSTRAINT "spool_price_references_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "roll_production_cost_snapshots" (
  "id" TEXT NOT NULL,
  "rollDispatchItemId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "supersedesSnapshotId" TEXT,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "calculationFingerprint" CHAR(64) NOT NULL,
  "calculationVersion" VARCHAR(32) NOT NULL,
  "basis" VARCHAR(16) NOT NULL DEFAULT 'actual',
  "basisWeightGrams" INTEGER NOT NULL,
  "producedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "materialAmountKopecks" BIGINT,
  "spoolAmountKopecks" BIGINT,
  "payrollAmountKopecks" BIGINT,
  "additionalAmountKopecks" BIGINT NOT NULL,
  "totalAmountKopecks" BIGINT,
  "totalKopecksPerKg" BIGINT,
  "unresolvedReasons" JSONB NOT NULL,
  "sourceSnapshot" JSONB NOT NULL,
  "actorId" TEXT,
  "actorRole" "Role",
  "systemActorKey" VARCHAR(100),
  "correctionReason" VARCHAR(500),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roll_production_cost_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roll_production_cost_snapshots_version_positive_ck"
    CHECK ("version" > 0),
  CONSTRAINT "roll_production_cost_snapshots_fingerprints_ck"
    CHECK (
      "requestFingerprint" ~ '^[0-9a-f]{64}$'
      AND "calculationFingerprint" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "roll_production_cost_snapshots_calculation_version_ck"
    CHECK (length(btrim("calculationVersion")) BETWEEN 1 AND 32),
  CONSTRAINT "roll_production_cost_snapshots_basis_ck"
    CHECK ("basis" = 'actual' AND "basisWeightGrams" > 0),
  CONSTRAINT "roll_production_cost_snapshots_period_ck"
    CHECK ("closedAt" >= "producedAt"),
  CONSTRAINT "roll_production_cost_snapshots_status_ck"
    CHECK ("status" IN ('complete', 'partial')),
  CONSTRAINT "roll_production_cost_snapshots_amounts_ck"
    CHECK (
      (
        "materialAmountKopecks" IS NULL
        OR ("materialAmountKopecks" >= 0 AND "materialAmountKopecks" <= 9007199254740991)
      )
      AND (
        "spoolAmountKopecks" IS NULL
        OR ("spoolAmountKopecks" >= 0 AND "spoolAmountKopecks" <= 9007199254740991)
      )
      AND (
        "payrollAmountKopecks" IS NULL
        OR ("payrollAmountKopecks" >= 0 AND "payrollAmountKopecks" <= 9007199254740991)
      )
      AND (
        "additionalAmountKopecks" >= 0
        AND "additionalAmountKopecks" <= 9007199254740991
      )
      AND (
        "totalAmountKopecks" IS NULL
        OR ("totalAmountKopecks" >= 0 AND "totalAmountKopecks" <= 9007199254740991)
      )
      AND (
        "totalKopecksPerKg" IS NULL
        OR ("totalKopecksPerKg" >= 0 AND "totalKopecksPerKg" <= 9007199254740991)
      )
    ),
  CONSTRAINT "roll_production_cost_snapshots_json_shape_ck"
    CHECK (
      jsonb_typeof("unresolvedReasons") = 'array'
      AND jsonb_typeof("sourceSnapshot") = 'object'
    ),
  CONSTRAINT "roll_production_cost_snapshots_completeness_ck"
    CHECK (
      (
        "status" = 'complete'
        AND "materialAmountKopecks" IS NOT NULL
        AND "spoolAmountKopecks" IS NOT NULL
        AND "payrollAmountKopecks" IS NOT NULL
        AND "totalAmountKopecks" IS NOT NULL
        AND "totalKopecksPerKg" IS NOT NULL
        AND "totalAmountKopecks" = "materialAmountKopecks"
          + "spoolAmountKopecks"
          + "payrollAmountKopecks"
          + "additionalAmountKopecks"
        AND "totalKopecksPerKg" = FLOOR(
          (
            "totalAmountKopecks"::numeric * 2000
            + "basisWeightGrams"::numeric
          ) / ("basisWeightGrams"::numeric * 2)
        )
        AND "unresolvedReasons" = '[]'::jsonb
      )
      OR
      (
        "status" = 'partial'
        AND "totalAmountKopecks" IS NULL
        AND "totalKopecksPerKg" IS NULL
        AND jsonb_array_length("unresolvedReasons") > 0
      )
    ),
  CONSTRAINT "roll_production_cost_snapshots_actor_xor_ck"
    CHECK (
      (
        "actorId" IS NOT NULL
        AND "actorRole" IS NOT NULL
        AND "systemActorKey" IS NULL
        AND length(btrim("correctionReason")) BETWEEN 1 AND 500
      )
      OR
      (
        "actorId" IS NULL
        AND "actorRole" IS NULL
        AND "systemActorKey" = 'production_cost_reconciler'
        AND "correctionReason" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "roll_production_cost_snapshots_supersedesSnapshotId_key"
  ON "roll_production_cost_snapshots"("supersedesSnapshotId");
CREATE UNIQUE INDEX "roll_production_cost_snapshots_operationKey_key"
  ON "roll_production_cost_snapshots"("operationKey");
CREATE UNIQUE INDEX "roll_production_cost_snapshots_rollDispatchItemId_version_key"
  ON "roll_production_cost_snapshots"("rollDispatchItemId", "version");
CREATE INDEX "roll_production_cost_snapshots_rollDispatchItemId_createdAt_id_idx"
  ON "roll_production_cost_snapshots"("rollDispatchItemId", "createdAt", "id");
CREATE INDEX "roll_production_cost_snapshots_status_createdAt_id_idx"
  ON "roll_production_cost_snapshots"("status", "createdAt", "id");
ALTER TABLE "roll_production_cost_snapshots"
  ADD CONSTRAINT "roll_production_cost_snapshots_rollDispatchItemId_fkey"
  FOREIGN KEY ("rollDispatchItemId") REFERENCES "roll_dispatch_items"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "roll_production_cost_snapshots"
  ADD CONSTRAINT "roll_production_cost_snapshots_supersedesSnapshotId_fkey"
  FOREIGN KEY ("supersedesSnapshotId") REFERENCES "roll_production_cost_snapshots"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "roll_production_cost_snapshots"
  ADD CONSTRAINT "roll_production_cost_snapshots_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "validate_production_cost_snapshot_version"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  predecessor RECORD;
  predecessor_count INTEGER;
BEGIN
  IF NEW."version" = 1 THEN
    IF NEW."supersedesSnapshotId" IS NOT NULL OR NEW."actorId" IS NOT NULL THEN
      RAISE EXCEPTION 'first production cost snapshot must be system-created without a predecessor';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."supersedesSnapshotId" IS NULL THEN
    RAISE EXCEPTION 'later production cost snapshot requires a predecessor';
  END IF;
  EXECUTE format(
    'SELECT "rollDispatchItemId", "version", "status", "calculationFingerprint"
       FROM %I.%I
      WHERE "id" = $1',
    TG_TABLE_SCHEMA,
    TG_TABLE_NAME
  )
  INTO predecessor
  USING NEW."supersedesSnapshotId";
  GET DIAGNOSTICS predecessor_count = ROW_COUNT;
  IF predecessor_count <> 1
     OR predecessor."rollDispatchItemId" IS DISTINCT FROM NEW."rollDispatchItemId"
     OR predecessor."version" + 1 <> NEW."version" THEN
    RAISE EXCEPTION 'production cost snapshot predecessor is invalid';
  END IF;
  IF NEW."systemActorKey" IS NOT NULL
     AND (
       predecessor."status" <> 'partial'
       OR predecessor."calculationFingerprint" = NEW."calculationFingerprint"
     ) THEN
    RAISE EXCEPTION 'automatic production cost successor requires a changed partial predecessor';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "roll_production_cost_snapshots_version_guard"
BEFORE INSERT ON "roll_production_cost_snapshots"
FOR EACH ROW EXECUTE FUNCTION "validate_production_cost_snapshot_version"();

CREATE FUNCTION "reject_production_cost_history_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'production_cost_history_append_only';
END
$$;

CREATE TRIGGER "spool_price_references_append_only"
BEFORE UPDATE OR DELETE ON "spool_price_references"
FOR EACH ROW EXECUTE FUNCTION "reject_production_cost_history_mutation"();
CREATE TRIGGER "spool_price_references_no_truncate"
BEFORE TRUNCATE ON "spool_price_references"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_production_cost_history_mutation"();

CREATE TRIGGER "roll_production_cost_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "roll_production_cost_snapshots"
FOR EACH ROW EXECUTE FUNCTION "reject_production_cost_history_mutation"();
CREATE TRIGGER "roll_production_cost_snapshots_no_truncate"
BEFORE TRUNCATE ON "roll_production_cost_snapshots"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_production_cost_history_mutation"();

COMMIT;
