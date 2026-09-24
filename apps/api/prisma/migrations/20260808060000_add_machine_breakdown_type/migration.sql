ALTER TABLE "production_problems"
  ADD COLUMN "machineBreakdownType" TEXT;

ALTER TABLE "production_problems"
  ADD CONSTRAINT "production_problems_machine_breakdown_type_check"
  CHECK (
    "machineBreakdownType" IS NULL
    OR (
      "type" = 'machine_breakdown'
      AND "machineBreakdownType" IN (
        'screw_jam',
        'extruder_stopped',
        'drive_stopped',
        'belt_break',
        'other'
      )
    )
  );
