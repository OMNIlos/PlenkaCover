ALTER TABLE "users"
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
ADD COLUMN "lastLoginAt" TIMESTAMP(3),
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "sessions"
ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'full';

ALTER TABLE "sessions"
ADD CONSTRAINT "sessions_purpose_check"
CHECK ("purpose" IN ('full', 'password_setup'));

ALTER TABLE "access_templates"
ADD COLUMN "name" TEXT,
ADD COLUMN "capabilityGrants" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "capabilityDenials" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

UPDATE "access_templates"
SET "name" = "role"::text
WHERE "name" IS NULL;

ALTER TABLE "access_templates"
ALTER COLUMN "name" SET NOT NULL;

CREATE TABLE "user_capability_overrides" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_capability_overrides_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_capability_overrides_effect_check" CHECK ("effect" IN ('allow', 'deny'))
);

CREATE UNIQUE INDEX "user_capability_overrides_userId_capability_key"
ON "user_capability_overrides"("userId", "capability");
CREATE INDEX "user_capability_overrides_createdById_idx"
ON "user_capability_overrides"("createdById");
CREATE INDEX "user_capability_overrides_updatedById_idx"
ON "user_capability_overrides"("updatedById");

ALTER TABLE "user_capability_overrides"
ADD CONSTRAINT "user_capability_overrides_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_capability_overrides"
ADD CONSTRAINT "user_capability_overrides_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_capability_overrides"
ADD CONSTRAINT "user_capability_overrides_updatedById_fkey"
FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
