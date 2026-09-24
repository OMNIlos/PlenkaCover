BEGIN;

ALTER TABLE "warehouse_pallets"
  ADD COLUMN "voidedAt" TIMESTAMP(3),
  ADD COLUMN "voidedById" TEXT,
  ADD COLUMN "voidReason" TEXT;

UPDATE "warehouse_pallets"
SET
  "voidedAt" = COALESCE("sealedAt", "updatedAt", "createdAt"),
  "voidedById" = COALESCE("sealedById", "openedById"),
  "voidReason" = 'other'
WHERE "status" = 'voided';

ALTER TABLE "warehouse_pallets"
  DROP CONSTRAINT "warehouse_pallets_seal_state_check";

ALTER TABLE "warehouse_pallets"
  ADD CONSTRAINT "warehouse_pallets_seal_state_check"
    CHECK (
      ("status" = 'open' AND "closeRequestId" IS NULL AND "sealedAt" IS NULL)
      OR
      ("status" = 'sealed' AND "closeRequestId" IS NOT NULL AND "sealedAt" IS NOT NULL)
      OR
      (
        "status" = 'voided'
        AND (
          ("closeRequestId" IS NULL AND "sealedAt" IS NULL)
          OR
          ("closeRequestId" IS NOT NULL AND "sealedAt" IS NOT NULL)
        )
      )
    ),
  ADD CONSTRAINT "warehouse_pallets_void_state_check"
    CHECK (
      (
        "status" IN ('open', 'sealed')
        AND "voidedAt" IS NULL
        AND "voidedById" IS NULL
        AND "voidReason" IS NULL
      )
      OR
      (
        "status" = 'voided'
        AND "voidedAt" IS NOT NULL
        AND "voidReason" IN (
          'empty_after_last_release',
          'wrong_composition',
          'print_problem',
          'other'
        )
      )
    );

COMMIT;
