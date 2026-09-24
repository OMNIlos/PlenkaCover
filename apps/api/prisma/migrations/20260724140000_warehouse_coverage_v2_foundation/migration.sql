BEGIN;

LOCK TABLE "domain_events" IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "domain_events"
ADD COLUMN "actorKind" TEXT,
ADD COLUMN "systemActorKey" TEXT;

UPDATE "domain_events"
SET "actorKind" = 'user'
WHERE "actorKind" IS NULL;

ALTER TABLE "domain_events"
ALTER COLUMN "actorKind" SET DEFAULT 'user',
ALTER COLUMN "actorKind" SET NOT NULL,
ALTER COLUMN "actorRole" DROP NOT NULL;

ALTER TABLE "domain_events"
DROP CONSTRAINT "domain_events_actorId_fkey";

ALTER TABLE "domain_events"
ADD CONSTRAINT "domain_events_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "domain_events"
ADD CONSTRAINT "domain_events_actor_xor"
CHECK (
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
    AND "systemActorKey" IS NOT DISTINCT FROM 'warehouse_coverage_engine'
  )
);

CREATE FUNCTION "reject_domain_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'domain_events is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'domain_events_append_only';
END
$$;

CREATE TRIGGER "domain_events_append_only"
BEFORE UPDATE OR DELETE ON "domain_events"
FOR EACH ROW
EXECUTE FUNCTION "reject_domain_event_mutation"();

CREATE TRIGGER "domain_events_append_only_truncate"
BEFORE TRUNCATE ON "domain_events"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_domain_event_mutation"();

COMMIT;
