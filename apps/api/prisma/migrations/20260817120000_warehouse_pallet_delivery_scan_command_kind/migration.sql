BEGIN;

ALTER TABLE "warehouse_pallet_commands"
  DROP CONSTRAINT "warehouse_pallet_commands_kind_check",
  DROP CONSTRAINT "warehouse_pallet_commands_scope_check";

ALTER TABLE "warehouse_pallet_commands"
  ADD CONSTRAINT "warehouse_pallet_commands_kind_check"
    CHECK ("kind" IN ('set_selection', 'void_pallet', 'pallet_handoff_scan', 'pallet_delivery_scan')) NOT VALID,
  ADD CONSTRAINT "warehouse_pallet_commands_scope_check"
    CHECK (
      (
        "kind" = 'set_selection'
        AND "scanRowId" IS NOT NULL
      )
      OR
      (
        "kind" = 'void_pallet'
        AND "scanRowId" IS NULL
        AND "palletId" IS NOT NULL
      )
      OR
      (
        "kind" = 'pallet_handoff_scan'
        AND "scanRowId" IS NULL
        AND "palletId" IS NOT NULL
      )
      OR
      (
        "kind" = 'pallet_delivery_scan'
        AND "scanRowId" IS NULL
        AND "palletId" IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE "warehouse_pallet_commands"
  VALIDATE CONSTRAINT "warehouse_pallet_commands_kind_check",
  VALIDATE CONSTRAINT "warehouse_pallet_commands_scope_check";

COMMIT;
