BEGIN;

ALTER TABLE "defect_bags"
  DROP CONSTRAINT "defect_bags_scale_evidence_check",
  ALTER COLUMN "scaleDeviceId" DROP NOT NULL,
  ALTER COLUMN "scaleStatus" DROP NOT NULL,
  ALTER COLUMN "scaleStable" DROP NOT NULL,
  ADD COLUMN "captureChannel" TEXT NOT NULL DEFAULT 'machine_post_scale',
  ADD CONSTRAINT "defect_bags_capture_evidence_check" CHECK (
    (
      "captureChannel" = 'machine_post_scale'
      AND "scaleDeviceId" IS NOT NULL
      AND "scaleStatus" = 'ready'
      AND "scaleStable" = true
    ) OR (
      "captureChannel" = 'operator_manual'
      AND "scaleDeviceId" IS NULL
      AND "scaleStatus" IS NULL
      AND "scaleStable" IS NULL
    )
  );

COMMIT;
