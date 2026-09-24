BEGIN;

ALTER TABLE "warehouse_pallets"
  DROP CONSTRAINT "warehouse_pallets_seal_state_check",
  DROP CONSTRAINT "warehouse_pallets_status_check";

ALTER TABLE "warehouse_pallets"
  ADD CONSTRAINT "warehouse_pallets_status_check"
    CHECK ("status" IN ('open', 'sealed', 'voided')),
  ADD CONSTRAINT "warehouse_pallets_seal_state_check"
    CHECK (
      ("status" = 'open' AND "closeRequestId" IS NULL AND "sealedAt" IS NULL)
      OR
      ("status" IN ('sealed', 'voided') AND "closeRequestId" IS NOT NULL AND "sealedAt" IS NOT NULL)
    );

ALTER TABLE "warehouse_pallet_items"
  ADD COLUMN "releasedAt" TIMESTAMP(3),
  ADD COLUMN "releasedById" TEXT,
  ADD COLUMN "releaseReason" TEXT;

ALTER TABLE "warehouse_pallet_items"
  ADD CONSTRAINT "warehouse_pallet_items_release_state_check"
  CHECK (
    (
      "releasedAt" IS NULL
      AND "releasedById" IS NULL
      AND "releaseReason" IS NULL
    )
    OR
    (
      "releasedAt" IS NOT NULL
      AND "releaseReason" IS NOT NULL
      AND char_length(btrim("releaseReason")) BETWEEN 1 AND 500
    )
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "warehouse_pallet_items"
    WHERE "releasedAt" IS NULL
    GROUP BY "scanRowId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'warehouse pallet selection migration found duplicate active scan memberships';
  END IF;
END
$$;

DROP INDEX "warehouse_pallet_items_scan_row_id_key";

CREATE UNIQUE INDEX "warehouse_pallet_items_active_scan_row_uq"
  ON "warehouse_pallet_items" ("scanRowId")
  WHERE "releasedAt" IS NULL;

CREATE OR REPLACE FUNCTION "warehouse_coverage_decision_has_physical_facts"(decision_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path FROM CURRENT
AS $$
  SELECT
    EXISTS (
      SELECT 1
      FROM "warehouse_rolls"
      WHERE "producedByCoverageDecisionId" = decision_id
    )
    OR EXISTS (
      SELECT 1
      FROM "warehouse_acceptance_tasks" task
      WHERE task."coverageDecisionId" = decision_id
        AND (
          task."status" NOT IN ('open', 'cancelled')
          OR EXISTS (
            SELECT 1 FROM "warehouse_operations" operation
            WHERE operation."taskId" = task."id"
          )
          OR EXISTS (
            SELECT 1 FROM "warehouse_pallets" pallet
            WHERE pallet."taskId" = task."id"
              AND pallet."status" <> 'voided'
          )
          OR EXISTS (
            SELECT 1
            FROM "scan_rows" scan
            WHERE scan."taskId" = task."id"
              AND (
                scan."scanStatus" <> 'expected'
                OR scan."lastScanAt" IS NOT NULL
                OR scan."scannedByName" IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM "warehouse_operations" operation
                  WHERE operation."scanRowId" = scan."id"
                )
                OR EXISTS (
                  SELECT 1 FROM "warehouse_pallet_items" item
                  WHERE item."scanRowId" = scan."id"
                    AND item."releasedAt" IS NULL
                    AND EXISTS (
                      SELECT 1 FROM "warehouse_pallets" item_pallet
                      WHERE item_pallet."id" = item."palletId"
                        AND item_pallet."status" <> 'voided'
                    )
                )
              )
          )
        )
    );
$$;

ALTER TABLE "pallet_list_documents"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" TEXT,
  ADD COLUMN "voidReasonCode" TEXT,
  ADD COLUMN "voidNote" TEXT;

ALTER TABLE "pallet_list_documents"
  ADD CONSTRAINT "pallet_list_documents_void_reason_check"
    CHECK (
      "voidReasonCode" IS NULL
      OR "voidReasonCode" IN ('wrong_composition', 'print_problem', 'other')
    ),
  ADD CONSTRAINT "pallet_list_documents_void_note_check"
    CHECK ("voidNote" IS NULL OR char_length("voidNote") <= 500),
  ADD CONSTRAINT "pallet_list_documents_void_state_check"
    CHECK (
      (
        "voidedAt" IS NULL
        AND "voidedById" IS NULL
        AND "voidReasonCode" IS NULL
        AND "voidNote" IS NULL
      )
      OR
      (
        "voidedAt" IS NOT NULL
        AND "voidedById" IS NOT NULL
        AND "voidReasonCode" IS NOT NULL
      )
    );

CREATE TABLE "warehouse_pallet_commands" (
  "id" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "kind" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "scanRowId" TEXT,
  "palletId" TEXT,
  "actorId" TEXT,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "warehouse_pallet_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "warehouse_pallet_commands_kind_check"
    CHECK ("kind" IN ('set_selection', 'void_pallet')),
  CONSTRAINT "warehouse_pallet_commands_fingerprint_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "warehouse_pallet_commands_scope_check"
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
    )
);

CREATE UNIQUE INDEX "warehouse_pallet_commands_operationKey_key"
  ON "warehouse_pallet_commands" ("operationKey");
CREATE INDEX "warehouse_pallet_commands_task_created_idx"
  ON "warehouse_pallet_commands" ("taskId", "createdAt", "id");

CREATE FUNCTION "reject_warehouse_pallet_command_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'warehouse pallet commands are append-only';
END
$$;

CREATE TRIGGER "warehouse_pallet_commands_append_only"
BEFORE UPDATE OR DELETE ON "warehouse_pallet_commands"
FOR EACH ROW EXECUTE FUNCTION "reject_warehouse_pallet_command_mutation"();

CREATE TRIGGER "warehouse_pallet_commands_no_truncate"
BEFORE TRUNCATE ON "warehouse_pallet_commands"
FOR EACH STATEMENT EXECUTE FUNCTION "reject_warehouse_pallet_command_mutation"();

COMMIT;
