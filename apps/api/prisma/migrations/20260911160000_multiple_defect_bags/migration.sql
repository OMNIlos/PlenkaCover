-- A post-session can hand over several individually weighed and labelled defect bags.
DROP INDEX "defect_bags_postSessionId_key";
CREATE INDEX "defect_bags_postSessionId_weighedAt_id_idx"
  ON "defect_bags"("postSessionId", "weighedAt", "id");
