BEGIN;

ALTER TABLE "warehouse_operations"
  ALTER COLUMN "postId" DROP NOT NULL,
  ADD COLUMN "captureChannel" TEXT NOT NULL DEFAULT 'machine_post_gateway';

ALTER TABLE "warehouse_operations"
  ADD CONSTRAINT "warehouse_operations_capture_channel_check"
    CHECK (
      "captureChannel" IN (
        'warehouse_browser_hid',
        'machine_post_gateway',
        'warehouse_role_action'
      )
    );

COMMIT;
