BEGIN;

-- Planned windows are legacy metadata. New individual shifts use actual server timestamps.
ALTER TABLE "shifts" ALTER COLUMN "plannedStartAt" DROP NOT NULL;
ALTER TABLE "shifts" ALTER COLUMN "plannedEndAt" DROP NOT NULL;

CREATE TABLE "operator_machine_changes" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "fromPostId" TEXT NOT NULL,
  "toPostId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "operationKey" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "operator_machine_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_machine_changes_operation_key_key"
  ON "operator_machine_changes"("operationKey");
CREATE INDEX "operator_machine_changes_assignmentId_status_idx"
  ON "operator_machine_changes"("assignmentId", "status");
CREATE INDEX "operator_machine_changes_shiftId_status_idx"
  ON "operator_machine_changes"("shiftId", "status");
CREATE INDEX "operator_machine_changes_operatorId_status_idx"
  ON "operator_machine_changes"("operatorId", "status");
CREATE INDEX "operator_machine_changes_fromPostId_status_idx"
  ON "operator_machine_changes"("fromPostId", "status");
CREATE INDEX "operator_machine_changes_toPostId_status_idx"
  ON "operator_machine_changes"("toPostId", "status");

ALTER TABLE "operator_machine_changes"
  ADD CONSTRAINT "operator_machine_changes_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "operator_shift_machine_assignments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_machine_changes"
  ADD CONSTRAINT "operator_machine_changes_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "shifts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_machine_changes"
  ADD CONSTRAINT "operator_machine_changes_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_machine_changes"
  ADD CONSTRAINT "operator_machine_changes_fromPostId_fkey"
  FOREIGN KEY ("fromPostId") REFERENCES "posts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_machine_changes"
  ADD CONSTRAINT "operator_machine_changes_toPostId_fkey"
  FOREIGN KEY ("toPostId") REFERENCES "posts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
