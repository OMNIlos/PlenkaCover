-- Warehouse physical-integrity boundary: opaque immutable labels, browser/post binding and
-- durable idempotency for scan/weight/damage facts. This migration intentionally invalidates
-- legacy QR labels; affected lines are marked for reprint instead of pretending they remain valid.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "scan_rows"
    WHERE "scanStatus" IN ('expected', 'accepted', 'reserved', 'damaged')
    GROUP BY "taskId", "rollCode"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'warehouse intake integrity preflight failed: duplicate canonical scan rows';
  END IF;
END
$$;

-- A printed legacy operator label must have a physical-roll owner before its opaque token can be
-- issued. This does not fabricate a warehouse receipt: only already recorded warehouse states are
-- preserved; every other line remains not_ready until the normal handover transition.
INSERT INTO "warehouse_rolls" (
  "id",
  "rollCode",
  "warehouseStatus",
  "createdAt",
  "updatedAt"
)
SELECT
  'legacy-label-' || md5(dispatch."rollCode"),
  dispatch."rollCode",
  CASE
    WHEN line."warehouseState" IN ('sent', 'received', 'delivered', 'defect')
      THEN line."warehouseState"
    ELSE 'not_ready'
  END,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "operator_roll_lines" AS line
JOIN "roll_dispatch_items" AS dispatch ON dispatch."id" = line."rollDispatchItemId"
WHERE line."qrCode" IS NOT NULL
ON CONFLICT ("rollCode") DO NOTHING;

CREATE TABLE "roll_scan_tokens" (
  "rollCode" TEXT NOT NULL,
  "token" VARCHAR(68) NOT NULL DEFAULT (
    'prt_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  ),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "roll_scan_tokens_pkey" PRIMARY KEY ("rollCode"),
  CONSTRAINT "roll_scan_tokens_token_format_check"
    CHECK ("token" ~ '^prt_[0-9a-f]{64}$'),
  CONSTRAINT "roll_scan_tokens_rollCode_fkey"
    FOREIGN KEY ("rollCode") REFERENCES "warehouse_rolls"("rollCode")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "roll_scan_tokens_token_key" ON "roll_scan_tokens"("token");

INSERT INTO "roll_scan_tokens" ("rollCode")
SELECT "rollCode"
FROM "warehouse_rolls"
ON CONFLICT ("rollCode") DO NOTHING;

CREATE FUNCTION "reject_roll_scan_token_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'roll scan tokens are immutable';
END
$$;

CREATE TRIGGER "roll_scan_tokens_immutable"
BEFORE UPDATE OR DELETE ON "roll_scan_tokens"
FOR EACH ROW EXECUTE FUNCTION "reject_roll_scan_token_mutation"();

UPDATE "operator_roll_lines"
SET "labelState" = 'reprint_requested'
WHERE "qrCode" IS NOT NULL
  AND "labelState" IN ('printed', 'verified');

ALTER TABLE "operator_roll_lines" DROP COLUMN "qrCode";
ALTER TABLE "warehouse_acceptance_tasks" DROP COLUMN "lastScan";

ALTER TABLE "sessions"
  ADD COLUMN "warehousePostId" TEXT,
  ADD COLUMN "warehousePostBoundAt" TIMESTAMP(3);

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_warehousePostId_fkey"
  FOREIGN KEY ("warehousePostId") REFERENCES "posts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "sessions_warehousePostId_idx" ON "sessions"("warehousePostId");

CREATE TABLE "warehouse_operations" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'in_progress',
  "taskId" TEXT NOT NULL,
  "scanRowId" TEXT NOT NULL,
  "rollCode" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "deviceId" TEXT,
  "requestFingerprint" TEXT NOT NULL,
  "safeResult" JSONB,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "warehouse_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_operations_status_check"
    CHECK ("status" IN ('in_progress', 'succeeded', 'failed')),
  CONSTRAINT "warehouse_operations_kind_check"
    CHECK ("kind" IN ('receiving_scan', 'reserve_scan', 'delivery_scan', 'control_weight', 'mark_damaged')),
  CONSTRAINT "warehouse_operations_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "warehouse_operations_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "warehouse_acceptance_tasks"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_operations_scanRowId_fkey"
    FOREIGN KEY ("scanRowId") REFERENCES "scan_rows"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_operations_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_operations_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_operations_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "posts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "warehouse_operations_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "device_runtimes"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "warehouse_operations_operationKey_key"
  ON "warehouse_operations"("operationKey");
CREATE INDEX "warehouse_operations_taskId_createdAt_idx"
  ON "warehouse_operations"("taskId", "createdAt");
CREATE INDEX "warehouse_operations_rollCode_createdAt_idx"
  ON "warehouse_operations"("rollCode", "createdAt");
CREATE UNIQUE INDEX "warehouse_operations_active_kind_row_key"
  ON "warehouse_operations"("kind", "scanRowId")
  WHERE "status" IN ('in_progress', 'succeeded');

CREATE UNIQUE INDEX "scan_rows_canonical_task_roll_key"
  ON "scan_rows"("taskId", "rollCode")
  WHERE "scanStatus" IN ('expected', 'accepted', 'reserved', 'damaged');

ALTER TABLE "weight_captures" ADD COLUMN "warehouseOperationId" TEXT;
CREATE UNIQUE INDEX "weight_captures_warehouseOperationId_key"
  ON "weight_captures"("warehouseOperationId");
ALTER TABLE "weight_captures"
  ADD CONSTRAINT "weight_captures_warehouseOperationId_fkey"
  FOREIGN KEY ("warehouseOperationId") REFERENCES "warehouse_operations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
