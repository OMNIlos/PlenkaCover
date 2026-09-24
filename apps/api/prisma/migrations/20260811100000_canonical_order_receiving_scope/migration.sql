-- Additive only: legacy receiving tasks and append-only events remain untouched.
ALTER TABLE "warehouse_acceptance_tasks"
ADD COLUMN "receivingScopeKey" TEXT;

CREATE UNIQUE INDEX "warehouse_acceptance_tasks_receivingScopeKey_key"
ON "warehouse_acceptance_tasks"("receivingScopeKey");

-- Operator release is a new append-only Big-Bag weight fact; retain every legacy kind.
ALTER TABLE "big_bag_movements"
DROP CONSTRAINT "big_bag_movements_kind_check",
ADD CONSTRAINT "big_bag_movements_kind_check"
CHECK ("kind" IN ('registration', 'to_production', 'to_warehouse', 'operator_shift_release'));
