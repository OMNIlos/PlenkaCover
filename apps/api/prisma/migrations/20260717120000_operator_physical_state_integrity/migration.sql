-- Durable browser/business idempotency journal. This deliberately stores only safe
-- provenance and result references; raw QR/scale/printer payloads remain out of this table.
CREATE TABLE "operator_roll_operations" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "operatorRollLineId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "postSessionId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "deviceId" TEXT,
    "requestFingerprint" TEXT NOT NULL,
    "expectedStep" TEXT NOT NULL,
    "resultStep" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "resultRef" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "operator_roll_operations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "weight_captures"
    ADD COLUMN "actorId" TEXT,
    ADD COLUMN "postSessionId" TEXT,
    ADD COLUMN "operationId" TEXT;

ALTER TABLE "label_print_jobs"
    ADD COLUMN "operationId" TEXT,
    ADD COLUMN "actorId" TEXT,
    ADD COLUMN "postSessionId" TEXT,
    ADD COLUMN "postId" TEXT,
    ADD COLUMN "gatewayCommandId" TEXT,
    ADD COLUMN "failureReason" TEXT,
    ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "operator_roll_operations_operationKey_key"
    ON "operator_roll_operations"("operationKey");
CREATE INDEX "operator_roll_operations_line_action_created_idx"
    ON "operator_roll_operations"("operatorRollLineId", "action", "createdAt");
CREATE INDEX "operator_roll_operations_actor_created_idx"
    ON "operator_roll_operations"("actorId", "createdAt");
CREATE INDEX "operator_roll_operations_post_created_idx"
    ON "operator_roll_operations"("postId", "createdAt");
CREATE UNIQUE INDEX "operator_roll_operations_one_in_progress_per_line"
    ON "operator_roll_operations"("operatorRollLineId")
    WHERE "status" = 'in_progress';

CREATE UNIQUE INDEX "weight_captures_operationId_key" ON "weight_captures"("operationId");
CREATE UNIQUE INDEX "label_print_jobs_operationId_key" ON "label_print_jobs"("operationId");

ALTER TABLE "operator_roll_operations"
    ADD CONSTRAINT "operator_roll_operations_line_fkey"
    FOREIGN KEY ("operatorRollLineId") REFERENCES "operator_roll_lines"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "operator_roll_operations_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "operator_roll_operations_session_fkey"
    FOREIGN KEY ("postSessionId") REFERENCES "operator_post_sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "operator_roll_operations_post_fkey"
    FOREIGN KEY ("postId") REFERENCES "posts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "operator_roll_operations_device_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "device_runtimes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "weight_captures"
    ADD CONSTRAINT "weight_captures_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "weight_captures_session_fkey"
    FOREIGN KEY ("postSessionId") REFERENCES "operator_post_sessions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "weight_captures_operation_fkey"
    FOREIGN KEY ("operationId") REFERENCES "operator_roll_operations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "label_print_jobs"
    ADD CONSTRAINT "label_print_jobs_operation_fkey"
    FOREIGN KEY ("operationId") REFERENCES "operator_roll_operations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "label_print_jobs_actor_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "label_print_jobs_session_fkey"
    FOREIGN KEY ("postSessionId") REFERENCES "operator_post_sessions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "label_print_jobs_post_fkey"
    FOREIGN KEY ("postId") REFERENCES "posts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing databases may contain hand-created duplicate enabled bindings. Refuse to
-- choose or delete one silently: an operator must repair the topology before deploy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "device_runtimes"
    WHERE "isEnabled" = true AND "postId" IS NOT NULL
    GROUP BY "postId", "kind"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Ambiguous enabled device bindings: repair duplicate post/kind rows before migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "device_runtimes_one_enabled_kind_per_post"
    ON "device_runtimes"("postId", "kind")
    WHERE "isEnabled" = true AND "postId" IS NOT NULL;
