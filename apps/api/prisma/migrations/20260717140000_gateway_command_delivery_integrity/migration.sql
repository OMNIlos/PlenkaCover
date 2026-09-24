-- Durable gateway command leases and idempotent result journal.
ALTER TABLE "gateway_commands"
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "resultFingerprint" TEXT;

UPDATE "gateway_commands"
SET "deadlineAt" = "createdAt" + INTERVAL '30 seconds'
WHERE "deadlineAt" IS NULL;

-- The predecessor had no lease identity but could leave rows in_flight after a process stop.
-- Reads/tests are safe to claim again; print/recovery may already have touched hardware and must
-- become an explicit uncertainty rather than either failing this migration or being reissued.
UPDATE "gateway_commands"
SET "status" = 'queued'
WHERE "status" = 'in_flight'
  AND "kind" IN ('read_scale', 'device_test');

UPDATE "gateway_commands"
SET "status" = 'delivery_unknown',
    "result" = '{"ok":false,"status":"delivery_unknown","reasonCode":"gateway_legacy_in_flight_outcome_unknown"}'::jsonb,
    "resultFingerprint" = 'ce888807e713311669c7637a4365dd5801baedfe3b0c8ddc9a9cce1631c029e8',
    "resolvedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'in_flight';

-- Temporary compatibility window for rollback to the predecessor, whose poll writer only set
-- status=in_flight. Remove this trigger in a later migration after that binary is no longer a
-- supported rollback target. New writers supply opaque leases themselves and are unchanged.
CREATE FUNCTION "gateway_commands_legacy_lease_compat"()
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
        ELSE LEAST(NEW."deadlineAt", clock_timestamp() + INTERVAL '18 seconds')
      END
    );
    IF TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'in_flight' THEN
      NEW."attempt" := COALESCE(NEW."attempt", 0) + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "gateway_commands_legacy_lease_compat_trigger"
BEFORE INSERT OR UPDATE OF "status", "leaseToken", "leaseExpiresAt"
ON "gateway_commands"
FOR EACH ROW
EXECUTE FUNCTION "gateway_commands_legacy_lease_compat"();

COMMENT ON TRIGGER "gateway_commands_legacy_lease_compat_trigger" ON "gateway_commands" IS
  'Temporary predecessor rollback writer compatibility; remove after the phased rollback window.';

ALTER TABLE "gateway_commands"
  ALTER COLUMN "deadlineAt" SET NOT NULL,
  ALTER COLUMN "deadlineAt" SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 seconds'),
  ADD CONSTRAINT "gateway_commands_attempt_nonnegative_check"
    CHECK ("attempt" >= 0),
  ADD CONSTRAINT "gateway_commands_deadline_check"
    CHECK ("deadlineAt" >= "createdAt"),
  ADD CONSTRAINT "gateway_commands_in_flight_lease_check"
    CHECK (
      "status" <> 'in_flight'
      OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    ),
  ADD CONSTRAINT "gateway_commands_result_fingerprint_check"
    CHECK (
      "resultFingerprint" IS NULL
      OR "resultFingerprint" ~ '^[0-9a-f]{64}$'
    );

DROP INDEX IF EXISTS "gateway_commands_postId_status_idx";
CREATE INDEX "gateway_commands_postId_status_deadlineAt_idx"
  ON "gateway_commands"("postId", "status", "deadlineAt");
CREATE INDEX "gateway_commands_status_leaseExpiresAt_idx"
  ON "gateway_commands"("status", "leaseExpiresAt");
