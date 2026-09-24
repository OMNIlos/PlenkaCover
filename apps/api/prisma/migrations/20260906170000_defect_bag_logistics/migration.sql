BEGIN;

CREATE TABLE "defect_bags" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "postSessionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'weighed',
  "weightKg" DOUBLE PRECISION NOT NULL,
  "recordedDefectKg" DOUBLE PRECISION NOT NULL,
  "differenceKg" DOUBLE PRECISION NOT NULL,
  "scaleDeviceId" TEXT NOT NULL,
  "scaleStatus" TEXT NOT NULL,
  "scaleStable" BOOLEAN NOT NULL,
  "weighOperationKey" UUID NOT NULL,
  "weighedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "defect_bags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defect_bags_code_check" CHECK ("code" ~ '^DEF-[A-Za-z0-9_-]+$'),
  CONSTRAINT "defect_bags_status_check"
    CHECK ("status" IN ('weighed', 'ready_for_warehouse', 'received', 'shipped')),
  CONSTRAINT "defect_bags_weight_check" CHECK ("weightKg" >= 0 AND "weightKg" <= 10000),
  CONSTRAINT "defect_bags_recorded_weight_check"
    CHECK ("recordedDefectKg" >= 0 AND "recordedDefectKg" <= 10000),
  CONSTRAINT "defect_bags_difference_check"
    CHECK ("differenceKg" >= -10000 AND "differenceKg" <= 10000),
  CONSTRAINT "defect_bags_scale_evidence_check"
    CHECK ("scaleStatus" = 'ready' AND "scaleStable" = true),
  CONSTRAINT "defect_bags_postSessionId_fkey"
    FOREIGN KEY ("postSessionId") REFERENCES "operator_post_sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "defect_bags_code_key" ON "defect_bags"("code");
CREATE UNIQUE INDEX "defect_bags_postSessionId_key" ON "defect_bags"("postSessionId");
CREATE UNIQUE INDEX "defect_bags_weighOperationKey_key"
  ON "defect_bags"("weighOperationKey");
CREATE INDEX "defect_bags_status_weighedAt_id_idx"
  ON "defect_bags"("status", "weighedAt", "id");

CREATE TABLE "defect_bag_scan_tokens" (
  "defectBagId" TEXT NOT NULL,
  "token" VARCHAR(68) NOT NULL DEFAULT ('bbt_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "defect_bag_scan_tokens_pkey" PRIMARY KEY ("defectBagId"),
  CONSTRAINT "defect_bag_scan_tokens_token_check" CHECK ("token" ~ '^bbt_[0-9a-f]{64}$'),
  CONSTRAINT "defect_bag_scan_tokens_defectBagId_fkey"
    FOREIGN KEY ("defectBagId") REFERENCES "defect_bags"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "defect_bag_scan_tokens_token_key"
  ON "defect_bag_scan_tokens"("token");

CREATE TABLE "defect_bag_label_print_jobs" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "defectBagId" TEXT NOT NULL,
  "printerId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "reason" TEXT,
  "replacesJobId" TEXT,
  "actorId" TEXT NOT NULL,
  "postSessionId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "leaseToken" UUID NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "gatewayCommandId" TEXT,
  "failureReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "defect_bag_label_print_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defect_bag_print_jobs_status_check"
    CHECK ("status" IN ('queued', 'submitted', 'failed', 'delivery_unknown')),
  CONSTRAINT "defect_bag_print_jobs_reason_check"
    CHECK ("reason" IS NULL OR length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "defect_bag_print_jobs_retry_reason_check"
    CHECK ("replacesJobId" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "defect_bag_print_jobs_failure_reason_check"
    CHECK ("failureReason" IS NULL OR length("failureReason") <= 500),
  CONSTRAINT "defect_bag_print_jobs_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "defect_bag_label_print_jobs_defectBagId_fkey"
    FOREIGN KEY ("defectBagId") REFERENCES "defect_bags"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_label_print_jobs_replacesJobId_fkey"
    FOREIGN KEY ("replacesJobId") REFERENCES "defect_bag_label_print_jobs"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_label_print_jobs_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_label_print_jobs_postSessionId_fkey"
    FOREIGN KEY ("postSessionId") REFERENCES "operator_post_sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_label_print_jobs_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "posts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "defect_bag_label_print_jobs_operationKey_key"
  ON "defect_bag_label_print_jobs"("operationKey");
CREATE UNIQUE INDEX "defect_bag_label_print_jobs_replacesJobId_key"
  ON "defect_bag_label_print_jobs"("replacesJobId");
CREATE INDEX "defect_bag_label_print_jobs_defectBagId_createdAt_idx"
  ON "defect_bag_label_print_jobs"("defectBagId", "createdAt");
CREATE INDEX "defect_bag_label_print_jobs_postSessionId_createdAt_idx"
  ON "defect_bag_label_print_jobs"("postSessionId", "createdAt");

CREATE TABLE "defect_bag_movements" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "defectBagId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "postId" TEXT,
  "deviceId" TEXT,
  "captureChannel" TEXT NOT NULL DEFAULT 'warehouse_browser_hid',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "defect_bag_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "defect_bag_movements_kind_check" CHECK ("kind" IN ('receive', 'ship')),
  CONSTRAINT "defect_bag_movements_capture_channel_check"
    CHECK ("captureChannel" = 'warehouse_browser_hid'),
  CONSTRAINT "defect_bag_movements_defectBagId_fkey"
    FOREIGN KEY ("defectBagId") REFERENCES "defect_bags"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_movements_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_movements_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "sessions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "defect_bag_movements_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "posts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "defect_bag_movements_operationKey_key"
  ON "defect_bag_movements"("operationKey");
CREATE UNIQUE INDEX "defect_bag_movements_defectBagId_kind_key"
  ON "defect_bag_movements"("defectBagId", "kind");
CREATE INDEX "defect_bag_movements_kind_createdAt_id_idx"
  ON "defect_bag_movements"("kind", "createdAt", "id");

COMMIT;
