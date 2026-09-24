BEGIN;

-- Gateway command timestamps are UTC-naive `timestamp` values. Make database-generated values
-- use the same wall-clock domain as Prisma's JavaScript Date writes, independently of the
-- PostgreSQL session timezone.
ALTER TABLE "gateway_commands"
  ALTER COLUMN "createdAt" SET DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  ALTER COLUMN "deadlineAt" SET DEFAULT (
    (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '30 seconds'
  );

-- Keep the temporary predecessor lease writer compatible with the canonical UTC-naive clock.
CREATE OR REPLACE FUNCTION "gateway_commands_legacy_lease_compat"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'in_flight'
     AND (NEW."leaseToken" IS NULL OR NEW."leaseExpiresAt" IS NULL) THEN
    NEW."leaseToken" := COALESCE(NEW."leaseToken", 'legacy-' || gen_random_uuid()::text);
    NEW."leaseExpiresAt" := COALESCE(
      NEW."leaseExpiresAt",
      CASE
        WHEN NEW."kind" IN ('print', 'device_recover') THEN NEW."deadlineAt"
        ELSE LEAST(
          NEW."deadlineAt",
          (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '18 seconds'
        )
      END
    );
    IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'in_flight' THEN
      NEW."attempt" := COALESCE(NEW."attempt", 0) + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
