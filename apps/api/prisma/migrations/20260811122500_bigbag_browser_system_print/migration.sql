BEGIN;

ALTER TABLE "big_bag_label_print_jobs"
  DROP CONSTRAINT "big_bag_label_print_jobs_status_check",
  ALTER COLUMN "printerId" DROP NOT NULL,
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'gateway';

ALTER TABLE "big_bag_label_print_jobs"
  ADD CONSTRAINT "big_bag_label_print_jobs_status_check"
  CHECK ("status" IN ('queued', 'submitted', 'uncertain', 'failed', 'intent_recorded')),
  ADD CONSTRAINT "big_bag_label_print_jobs_channel_check"
  CHECK ("channel" IN ('gateway', 'browser_system_print')),
  ADD CONSTRAINT "big_bag_label_print_jobs_printer_channel_check"
  CHECK (
    ("channel" = 'gateway' AND "printerId" IS NOT NULL)
    OR ("channel" = 'browser_system_print' AND "printerId" IS NULL)
  ),
  ADD CONSTRAINT "big_bag_label_print_jobs_channel_state_check"
  CHECK (
    ("channel" = 'gateway' AND "status" <> 'intent_recorded')
    OR (
      "channel" = 'browser_system_print'
      AND "status" = 'intent_recorded'
      AND "gatewayCommandId" IS NULL
    )
  );

COMMIT;
