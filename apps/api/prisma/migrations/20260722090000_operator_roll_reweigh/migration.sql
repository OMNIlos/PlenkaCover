ALTER TABLE "weight_captures"
ADD COLUMN "supersedesCaptureId" TEXT;

CREATE UNIQUE INDEX "weight_captures_supersedesCaptureId_key"
ON "weight_captures"("supersedesCaptureId");

ALTER TABLE "weight_captures"
ADD CONSTRAINT "weight_captures_supersedesCaptureId_fkey"
FOREIGN KEY ("supersedesCaptureId") REFERENCES "weight_captures"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "weight_captures"
ADD CONSTRAINT "weight_captures_no_self_supersession_check"
CHECK ("id" <> "supersedesCaptureId");
