CREATE INDEX "wc_analytics_scan_idx"
  ON "weight_captures"("kind", "stable", "createdAt", "id");

CREATE INDEX "wc_line_canon_idx"
  ON "weight_captures"("operatorRollLineId", "kind", "stable", "createdAt", "id");

CREATE INDEX "wc_session_scan_idx"
  ON "weight_captures"("postSessionId", "kind", "stable", "createdAt", "id");

CREATE INDEX "sbu_analytics_period_idx"
  ON "shift_bag_usages"("createdAt", "id", "closedAt");

CREATE INDEX "sbu_bag_period_idx"
  ON "shift_bag_usages"("bigBagId", "createdAt", "closedAt", "id");

CREATE INDEX "sbu_closed_period_idx"
  ON "shift_bag_usages"("closedAt", "id");

CREATE INDEX "bbu_active_period_idx"
  ON "big_bag_units"("status", "createdAt", "id");

CREATE INDEX "ops_closed_period_idx"
  ON "operator_post_sessions"("status", "endedAt", "id");
