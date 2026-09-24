BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "shift_bag_usages"
    WHERE "startKg" <= 0
       OR "startKg" >= 'Infinity'::double precision
       OR "startKg" = 'NaN'::double precision
       OR ("endKg" IS NULL) <> ("closedAt" IS NULL)
       OR "endKg" < 0
       OR "endKg" > "startKg"
       OR "endKg" >= 'Infinity'::double precision
       OR "endKg" = 'NaN'::double precision
  ) THEN
    RAISE EXCEPTION 'existing shift BigBag usage cannot be represented as an immutable episode';
  END IF;
END
$$;

CREATE TABLE "shift_bag_usage_episodes" (
    "id" TEXT NOT NULL,
    "usageId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startKg" DOUBLE PRECISION NOT NULL,
    "endKg" DOUBLE PRECISION,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "closeKind" TEXT,

    CONSTRAINT "shift_bag_usage_episodes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shift_bag_usage_episodes_sequence_check"
      CHECK ("sequence" > 0),
    CONSTRAINT "shift_bag_usage_episodes_start_weight_check"
      CHECK (
        "startKg" > 0
        AND "startKg" < 'Infinity'::double precision
        AND "startKg" <> 'NaN'::double precision
      ),
    CONSTRAINT "shift_bag_usage_episodes_end_weight_check"
      CHECK (
        "endKg" IS NULL
        OR (
          "endKg" >= 0
          AND "endKg" <= "startKg"
          AND "endKg" < 'Infinity'::double precision
          AND "endKg" <> 'NaN'::double precision
        )
      ),
    CONSTRAINT "shift_bag_usage_episodes_lifecycle_check"
      CHECK (
        (
          "endKg" IS NULL
          AND "closedAt" IS NULL
          AND "closeKind" IS NULL
        )
        OR (
          "endKg" IS NOT NULL
          AND "closedAt" IS NOT NULL
          AND "closeKind" IN ('released', 'shift_closed')
        )
      ),
    CONSTRAINT "shift_bag_usage_episodes_usageId_fkey"
      FOREIGN KEY ("usageId") REFERENCES "shift_bag_usages"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "shift_bag_usage_episodes_usageId_sequence_key"
  ON "shift_bag_usage_episodes"("usageId", "sequence");

CREATE UNIQUE INDEX "shift_bag_usage_episodes_one_open_per_usage_idx"
  ON "shift_bag_usage_episodes"("usageId")
  WHERE "closedAt" IS NULL;

CREATE INDEX "shift_bag_usage_episodes_usageId_openedAt_id_idx"
  ON "shift_bag_usage_episodes"("usageId", "openedAt", "id");

INSERT INTO "shift_bag_usage_episodes" (
  "id",
  "usageId",
  "sequence",
  "startKg",
  "endKg",
  "openedAt",
  "closedAt",
  "closeKind"
)
SELECT
  'sbe-' || md5(usage."id"),
  usage."id",
  1,
  usage."startKg",
  usage."endKg",
  usage."createdAt",
  usage."closedAt",
  CASE
    WHEN usage."closedAt" IS NULL THEN NULL
    WHEN NULLIF(btrim(usage."releasedReason"), '') IS NOT NULL THEN 'released'
    ELSE 'shift_closed'
  END
FROM "shift_bag_usages" AS usage;

CREATE FUNCTION "guard_shift_bag_usage_episode_history"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'shift BigBag episode history is append-only';
  END IF;

  IF OLD."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'closed shift BigBag episode history is immutable';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."usageId" IS DISTINCT FROM OLD."usageId"
     OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
     OR NEW."startKg" IS DISTINCT FROM OLD."startKg"
     OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'shift BigBag episode identity and start fact are immutable';
  END IF;

  IF NEW."endKg" IS NULL OR NEW."closedAt" IS NULL OR NEW."closeKind" IS NULL THEN
    RAISE EXCEPTION 'an open shift BigBag episode can only transition to a complete close fact';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "shift_bag_usage_episodes_history_guard"
  BEFORE UPDATE OR DELETE ON "shift_bag_usage_episodes"
  FOR EACH ROW EXECUTE FUNCTION "guard_shift_bag_usage_episode_history"();

CREATE TRIGGER "shift_bag_usage_episodes_no_truncate"
  BEFORE TRUNCATE ON "shift_bag_usage_episodes"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_shift_bag_usage_episode_history"();

COMMIT;
