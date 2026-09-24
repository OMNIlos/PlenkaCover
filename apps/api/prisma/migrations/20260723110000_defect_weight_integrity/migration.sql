BEGIN;

-- Keep the legacy preflight and the following DDL in one write-fenced window.
-- Without this lock a concurrent writer could insert another open legacy defect
-- between the check and trigger installation.
LOCK TABLE "production_problems" IN ACCESS EXCLUSIVE MODE;

-- Every existing open defect problem lacks the new exact defect link. Refuse to
-- guess one during deploy; production must resolve these legacy rows first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "production_problems"
    WHERE "type" = 'defect'
      AND "status" = 'open'
  ) THEN
    RAISE EXCEPTION 'Open defect problems must be resolved before defect provenance migration';
  END IF;
END $$;

ALTER TABLE "defect_records"
    ADD COLUMN "weightCaptureId" TEXT;

ALTER TABLE "production_problems"
    ADD COLUMN "defectRecordId" TEXT;

CREATE UNIQUE INDEX "defect_records_weightCaptureId_key"
    ON "defect_records"("weightCaptureId");

CREATE UNIQUE INDEX "production_problems_defectRecordId_key"
    ON "production_problems"("defectRecordId");

ALTER TABLE "defect_records"
    ADD CONSTRAINT "defect_records_weightCaptureId_fkey"
    FOREIGN KEY ("weightCaptureId") REFERENCES "weight_captures"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "production_problems"
    ADD CONSTRAINT "production_problems_defectRecordId_fkey"
    FOREIGN KEY ("defectRecordId") REFERENCES "defect_records"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE UNIQUE INDEX "production_problems_one_open_defect_per_roll_idx"
ON "production_problems" ("rollId")
WHERE "type" = 'defect' AND "status" = 'open' AND "rollId" IS NOT NULL;

CREATE FUNCTION "guard_defect_weight_capture_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."weightCaptureId" IS NOT NULL THEN
      RAISE EXCEPTION 'Linked defect evidence cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."weightCaptureId" IS NOT NULL
     AND NEW."weightCaptureId" IS DISTINCT FROM OLD."weightCaptureId" THEN
    RAISE EXCEPTION 'Linked defect evidence cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "defect_records_weight_capture_update_guard"
BEFORE UPDATE OF "weightCaptureId" ON "defect_records"
FOR EACH ROW EXECUTE FUNCTION "guard_defect_weight_capture_link"();

CREATE TRIGGER "defect_records_weight_capture_delete_guard"
BEFORE DELETE ON "defect_records"
FOR EACH ROW EXECUTE FUNCTION "guard_defect_weight_capture_link"();

CREATE FUNCTION "guard_problem_defect_record_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."defectRecordId" IS NOT NULL THEN
      RAISE EXCEPTION 'Linked defect problem cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."defectRecordId" IS NOT NULL
     AND NEW."defectRecordId" IS DISTINCT FROM OLD."defectRecordId" THEN
    RAISE EXCEPTION 'Linked defect problem cannot be changed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "production_problems_defect_record_update_guard"
BEFORE UPDATE OF "defectRecordId" ON "production_problems"
FOR EACH ROW EXECUTE FUNCTION "guard_problem_defect_record_link"();

CREATE TRIGGER "production_problems_defect_record_delete_guard"
BEFORE DELETE ON "production_problems"
FOR EACH ROW EXECUTE FUNCTION "guard_problem_defect_record_link"();

CREATE FUNCTION "require_open_defect_record_link"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."type" = 'defect'
     AND NEW."status" = 'open'
     AND NEW."defectRecordId" IS NULL THEN
    RAISE EXCEPTION 'Open defect problems require an exact defect record'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "production_problems_open_defect_link_guard"
BEFORE INSERT OR UPDATE ON "production_problems"
FOR EACH ROW EXECUTE FUNCTION "require_open_defect_record_link"();

COMMIT;
