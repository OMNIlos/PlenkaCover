BEGIN;

ALTER TABLE "posts"
  ADD COLUMN "commissioningState" TEXT NOT NULL DEFAULT 'uncommissioned',
  ADD COLUMN "commissionedAt" TIMESTAMP(3),
  ADD COLUMN "agentProtocolVersion" INTEGER,
  ADD COLUMN "agentPackageVersion" TEXT,
  ADD COLUMN "agentReleaseCommit" TEXT,
  ADD COLUMN "agentBootId" TEXT,
  ADD COLUMN "agentStartedAt" TIMESTAMP(3),
  ADD COLUMN "agentCapabilities" JSONB,
  ADD COLUMN "agentCompatibility" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "device_runtimes"
  ADD COLUMN "driverName" TEXT,
  ADD COLUMN "driverVersion" TEXT,
  ADD COLUMN "configFingerprint" TEXT,
  ADD COLUMN "lastProbeAt" TIMESTAMP(3);

ALTER TABLE "posts"
  ADD CONSTRAINT "posts_commissioning_state_check"
    CHECK ("commissioningState" IN ('uncommissioned', 'commissioning', 'commissioned', 'revoked')),
  ADD CONSTRAINT "posts_agent_compatibility_check"
    CHECK ("agentCompatibility" IN ('unknown', 'compatible', 'upgrade_required', 'unsupported')),
  ADD CONSTRAINT "posts_agent_protocol_version_check"
    CHECK ("agentProtocolVersion" IS NULL OR "agentProtocolVersion" > 0),
  ADD CONSTRAINT "posts_agent_release_commit_check"
    CHECK (
      "agentReleaseCommit" IS NULL
      OR "agentReleaseCommit" ~ '^[0-9a-f]{7,64}$'
    );

ALTER TABLE "device_runtimes"
  ADD CONSTRAINT "device_runtimes_config_fingerprint_check"
    CHECK (
      "configFingerprint" IS NULL
      OR "configFingerprint" ~ '^[0-9a-f]{64}$'
    );

CREATE INDEX "posts_commissioningState_agentCompatibility_idx"
  ON "posts"("commissioningState", "agentCompatibility");

CREATE INDEX "device_runtimes_postId_kind_isEnabled_idx"
  ON "device_runtimes"("postId", "kind", "isEnabled");

COMMIT;
