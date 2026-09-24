-- Extend production roll planning with a canonical queue, shift and safe snapshots.
ALTER TABLE "roll_dispatch_items"
  ADD COLUMN "plannedLengthM" DOUBLE PRECISION,
  ADD COLUMN "characteristicsSnapshot" JSONB,
  ADD COLUMN "plannedShiftId" TEXT,
  ADD COLUMN "queueRank" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completedAt" TIMESTAMP(3);

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "priority" DESC, "createdAt", "id") AS rank
  FROM "roll_dispatch_items"
)
UPDATE "roll_dispatch_items" AS item
SET "queueRank" = ranked.rank
FROM ranked
WHERE ranked."id" = item."id";

-- Existing shifts become explicit eight-hour windows; new shifts start as plans.
ALTER TABLE "shifts"
  ADD COLUMN "plannedStartAt" TIMESTAMP(3),
  ADD COLUMN "plannedEndAt" TIMESTAMP(3);

UPDATE "shifts"
SET
  "plannedStartAt" = COALESCE("startedAt", "createdAt"),
  "plannedEndAt" = COALESCE("endedAt", COALESCE("startedAt", "createdAt") + INTERVAL '8 hours');

ALTER TABLE "shifts"
  ALTER COLUMN "plannedStartAt" SET NOT NULL,
  ALTER COLUMN "plannedEndAt" SET NOT NULL,
  ALTER COLUMN "startedAt" DROP NOT NULL,
  ALTER COLUMN "startedAt" DROP DEFAULT,
  ALTER COLUMN "status" SET DEFAULT 'planned';

CREATE TABLE "operator_shift_machine_assignments" (
  "id" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "postId" TEXT NOT NULL,
  "previousPostId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'planned',
  "lockedAt" TIMESTAMP(3),
  "breakdownReason" TEXT,
  "reassignedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "operator_shift_machine_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_shift_machine_assignments_shiftId_operatorId_key"
  ON "operator_shift_machine_assignments"("shiftId", "operatorId");
CREATE UNIQUE INDEX "operator_shift_machine_assignments_shiftId_postId_key"
  ON "operator_shift_machine_assignments"("shiftId", "postId");
CREATE INDEX "operator_shift_machine_assignments_operatorId_status_idx"
  ON "operator_shift_machine_assignments"("operatorId", "status");
CREATE INDEX "roll_dispatch_items_plannedShiftId_idx"
  ON "roll_dispatch_items"("plannedShiftId");
CREATE INDEX "roll_dispatch_items_queueRank_idx"
  ON "roll_dispatch_items"("queueRank");

-- Prototype fixtures used frontend-only operator ids (for example operator-line-a).
-- They are not valid identity facts, so make only those orphan rows honestly unassigned
-- before enforcing the real User relation. Physical rolls and valid assignments are preserved.
UPDATE "roll_dispatch_items" AS item
SET "assignedOperatorId" = NULL, "status" = 'new'
WHERE item."assignedOperatorId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "users" AS actor WHERE actor."id" = item."assignedOperatorId"
  );

ALTER TABLE "roll_dispatch_items"
  ADD CONSTRAINT "roll_dispatch_items_plannedShiftId_fkey"
  FOREIGN KEY ("plannedShiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "roll_dispatch_items"
  ADD CONSTRAINT "roll_dispatch_items_assignedOperatorId_fkey"
  FOREIGN KEY ("assignedOperatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "operator_shift_machine_assignments"
  ADD CONSTRAINT "operator_shift_machine_assignments_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_machine_assignments"
  ADD CONSTRAINT "operator_shift_machine_assignments_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_machine_assignments"
  ADD CONSTRAINT "operator_shift_machine_assignments_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_shift_machine_assignments"
  ADD CONSTRAINT "operator_shift_machine_assignments_previousPostId_fkey"
  FOREIGN KEY ("previousPostId") REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "operator_shift_machine_assignments"
  ADD CONSTRAINT "operator_shift_machine_assignments_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
