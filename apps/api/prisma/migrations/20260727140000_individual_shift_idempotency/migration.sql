BEGIN;

-- Legacy shifts predate browser-command idempotency. New individual shifts persist both
-- the command UUID and its canonical SHA-256 fingerprint; nullable columns preserve history.
ALTER TABLE "shifts"
  ADD COLUMN "operationKey" UUID,
  ADD COLUMN "requestFingerprint" CHAR(64),
  ADD COLUMN "commandResult" JSONB;

CREATE UNIQUE INDEX "shifts_operationKey_key" ON "shifts"("operationKey");

COMMIT;
