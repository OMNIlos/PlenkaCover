CREATE INDEX CONCURRENTLY "warehouse_rolls_inventory_received_at_id_idx"
  ON "warehouse_rolls" ("receivedAt", "id");
