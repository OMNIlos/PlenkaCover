BEGIN;

ALTER TABLE "warehouse_roll_coverage_facts"
  DROP CONSTRAINT "warehouse_coverage_facts_source_ck",
  ADD CONSTRAINT "warehouse_coverage_facts_source_ck"
    CHECK (
      "source" IN (
        'production_handover',
        'warehouse_recheck',
        'migration_backfill',
        'manual_platform'
      )
    );

COMMIT;
