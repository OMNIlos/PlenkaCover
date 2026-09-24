BEGIN;

ALTER TABLE "commercial_orders"
  ADD COLUMN "cancellationStatus" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "cancellationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledById" TEXT,
  ADD COLUMN "cancellationReason" VARCHAR(500);

ALTER TABLE "roll_dispatch_items"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" VARCHAR(500);

ALTER TABLE "finance_orders"
  ADD COLUMN "productionClearedAt" TIMESTAMP(3);

ALTER TABLE "payment_operations"
  ADD COLUMN "paymentScheduleId" TEXT,
  ADD COLUMN "reversesOperationId" TEXT;

ALTER TABLE "finance_payment_update_commands"
  ADD COLUMN "requestedStatus" TEXT,
  ADD COLUMN "previousStatus" TEXT,
  ADD COLUMN "amountPaid" DECIMAL(18, 2),
  ADD COLUMN "result" JSONB;

ALTER TABLE "operator_shift_machine_assignments"
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" VARCHAR(500);

ALTER TABLE "operator_machine_changes"
  ADD COLUMN "cancelOperationKey" UUID,
  ADD COLUMN "cancelRequestFingerprint" CHAR(64),
  ADD COLUMN "cancellationReason" VARCHAR(500),
  ADD COLUMN "cancelledById" TEXT;

CREATE TABLE "commercial_order_amendment_commands" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "kind" TEXT NOT NULL,
  "expectedOrderVersion" INTEGER NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actorRole" "Role" NOT NULL,
  "actorId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commercial_order_amendment_commands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "finance_payment_correction_commands" (
  "id" TEXT NOT NULL,
  "financeOrderId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actorRole" "Role" NOT NULL,
  "actorId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "finance_payment_correction_commands_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operator_shift_machine_assignment_cancellation_commands" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actorRole" "Role" NOT NULL,
  "actorId" TEXT,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_shift_machine_assignment_cancellation_commands_pkey"
    PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "commercial_order_amendment_commands_operationKey_key"
  ON "commercial_order_amendment_commands" ("operationKey");
CREATE INDEX "commercial_order_amendment_commands_orderId_createdAt_idx"
  ON "commercial_order_amendment_commands" ("orderId", "createdAt");

CREATE UNIQUE INDEX "finance_payment_correction_commands_targetKey_key"
  ON "finance_payment_correction_commands" ("targetKey");
CREATE UNIQUE INDEX "finance_payment_correction_commands_financeOrderId_operationKey_key"
  ON "finance_payment_correction_commands" ("financeOrderId", "operationKey");
CREATE INDEX "finance_payment_correction_commands_financeOrderId_createdAt_idx"
  ON "finance_payment_correction_commands" ("financeOrderId", "createdAt");

CREATE UNIQUE INDEX
  "operator_shift_machine_assignment_cancellation_commands_assignmentId_key"
  ON "operator_shift_machine_assignment_cancellation_commands" ("assignmentId");
CREATE UNIQUE INDEX
  "operator_shift_machine_assignment_cancellation_commands_operationKey_key"
  ON "operator_shift_machine_assignment_cancellation_commands" ("operationKey");

CREATE UNIQUE INDEX "payment_operations_reversesOperationId_key"
  ON "payment_operations" ("reversesOperationId");
CREATE INDEX "payment_operations_paymentScheduleId_idx"
  ON "payment_operations" ("paymentScheduleId");
CREATE UNIQUE INDEX "operator_machine_changes_cancelOperationKey_key"
  ON "operator_machine_changes" ("cancelOperationKey");

CREATE UNIQUE INDEX "operator_shift_machine_assignments_active_shift_operator_uq"
  ON "operator_shift_machine_assignments" ("shiftId", "operatorId")
  WHERE "status" IN ('planned', 'locked', 'breakdown_reassigned');
CREATE UNIQUE INDEX "operator_shift_machine_assignments_active_shift_post_uq"
  ON "operator_shift_machine_assignments" ("shiftId", "postId")
  WHERE "status" IN ('planned', 'locked', 'breakdown_reassigned');

DROP INDEX "operator_shift_machine_assignments_shiftId_operatorId_key";
DROP INDEX "operator_shift_machine_assignments_shiftId_postId_key";

ALTER TABLE "commercial_order_amendment_commands"
  ADD CONSTRAINT "commercial_order_amendment_commands_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "commercial_orders" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "finance_payment_correction_commands"
  ADD CONSTRAINT "finance_payment_correction_commands_financeOrderId_fkey"
  FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operator_shift_machine_assignment_cancellation_commands"
  ADD CONSTRAINT "operator_shift_machine_assignment_cancellation_commands_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "operator_shift_machine_assignments" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_operations"
  ADD CONSTRAINT "payment_operations_paymentScheduleId_fkey"
  FOREIGN KEY ("paymentScheduleId") REFERENCES "payment_schedules" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payment_operations_reversesOperationId_fkey"
  FOREIGN KEY ("reversesOperationId") REFERENCES "payment_operations" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "finance_orders" AS fo
SET "productionClearedAt" = COALESCE(
  co."financeConfirmedAt",
  fo."updatedAt",
  co."updatedAt"
)
FROM "commercial_orders" AS co
WHERE co."id" = fo."commercialOrderId"
  AND fo."productionClearedAt" IS NULL
  AND (
    EXISTS (
      SELECT 1
      FROM "production_orders" AS po
      WHERE po."commercialOrderId" = co."id"
    )
    OR (
      fo."invoiceStatus" = 'invoiced'
      AND (
        (
          EXISTS (
            SELECT 1
            FROM "payment_policies" AS pp
            WHERE pp."financeOrderId" = fo."id"
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "payment_policies" AS pp
            JOIN "payment_policy_stages" AS stage
              ON stage."paymentPolicyId" = pp."id"
            WHERE pp."financeOrderId" = fo."id"
              AND stage."trigger" = 'invoice_issued'
              AND NOT EXISTS (
                SELECT 1
                FROM "payment_schedules" AS schedule
                WHERE schedule."paymentPolicyStageId" = stage."id"
                  AND schedule."kind" = 'invoice_prepayment'
                  AND schedule."status" = 'paid'
              )
          )
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM "payment_policies" AS pp
            WHERE pp."financeOrderId" = fo."id"
          )
          AND (
            fo."paymentTermsType" = 'postpay_100_30d'
            OR (
              fo."paymentTermsType" = 'prepay_50_postpay_50_30d'
              AND EXISTS (
                SELECT 1
                FROM "payment_schedules" AS schedule
                WHERE schedule."financeOrderId" = fo."id"
                  AND schedule."kind" = 'invoice_prepayment'
                  AND schedule."status" = 'paid'
              )
            )
          )
        )
      )
    )
  );

COMMIT;
