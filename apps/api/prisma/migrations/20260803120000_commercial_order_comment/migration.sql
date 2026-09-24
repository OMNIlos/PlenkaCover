BEGIN;

ALTER TABLE "commercial_orders"
  ADD COLUMN "comment" TEXT,
  ADD COLUMN "commentVersion" INTEGER NOT NULL DEFAULT 1;

COMMIT;
