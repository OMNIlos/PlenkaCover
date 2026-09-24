ALTER TABLE "device_runtimes"
ADD COLUMN "code" TEXT,
ADD COLUMN "label" TEXT,
ADD COLUMN "connectionKind" TEXT,
ADD COLUMN "isEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "device_runtimes_code_key" ON "device_runtimes"("code");

CREATE TABLE "operational_checks" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "summary" JSONB NOT NULL,
  "diagnosticRef" TEXT,
  "actorId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_checks_scope_check"
    CHECK ("scope" IN ('onec', 'device', 'post', 'platform')),
  CONSTRAINT "operational_checks_status_check"
    CHECK ("status" IN ('passed', 'degraded', 'failed'))
);

CREATE INDEX "operational_checks_scope_completedAt_idx"
ON "operational_checks"("scope", "completedAt");
CREATE INDEX "operational_checks_targetType_targetId_idx"
ON "operational_checks"("targetType", "targetId");

CREATE TABLE "operational_incidents" (
  "id" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "severity" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "recovery" TEXT NOT NULL,
  "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  CONSTRAINT "operational_incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_incidents_scope_check"
    CHECK ("scope" IN ('onec', 'device', 'post', 'platform')),
  CONSTRAINT "operational_incidents_severity_check"
    CHECK ("severity" IN ('info', 'warning', 'critical')),
  CONSTRAINT "operational_incidents_status_check"
    CHECK ("status" IN ('open', 'acknowledged', 'resolved'))
);

CREATE UNIQUE INDEX "operational_incidents_fingerprint_key"
ON "operational_incidents"("fingerprint");
CREATE INDEX "operational_incidents_scope_status_idx"
ON "operational_incidents"("scope", "status");
CREATE INDEX "operational_incidents_severity_status_idx"
ON "operational_incidents"("severity", "status");
