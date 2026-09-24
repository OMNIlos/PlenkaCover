-- Penalties addressed to a concrete employee must point to a real account.
UPDATE "penalties" AS p
SET "employeeId" = NULL
WHERE "employeeId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" AS u WHERE u."id" = p."employeeId");

CREATE INDEX "penalties_employeeId_idx" ON "penalties"("employeeId");

ALTER TABLE "penalties"
ADD CONSTRAINT "penalties_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
