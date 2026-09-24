BEGIN;

CREATE TABLE "warehouse_reserve_roll_commands" (
    "id" TEXT NOT NULL,
    "operationKey" UUID NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "rollId" TEXT NOT NULL,
    "sourceOrderId" TEXT NOT NULL,
    "sourcePositionId" TEXT NOT NULL,
    "actorRole" "Role" NOT NULL,
    "actorId" TEXT,
    "resultSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_reserve_roll_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_reserve_roll_commands_operationKey_key"
    ON "warehouse_reserve_roll_commands"("operationKey");

CREATE UNIQUE INDEX "warehouse_reserve_roll_commands_rollId_key"
    ON "warehouse_reserve_roll_commands"("rollId");

CREATE UNIQUE INDEX "warehouse_reserve_roll_commands_sourcePositionId_key"
    ON "warehouse_reserve_roll_commands"("sourcePositionId");

CREATE INDEX "warehouse_reserve_roll_commands_sourceOrderId_createdAt_id_idx"
    ON "warehouse_reserve_roll_commands"("sourceOrderId", "createdAt", "id");

ALTER TABLE "warehouse_reserve_roll_commands"
    ADD CONSTRAINT "warehouse_reserve_roll_commands_rollId_fkey"
    FOREIGN KEY ("rollId") REFERENCES "warehouse_rolls"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "warehouse_reserve_roll_commands"
    ADD CONSTRAINT "warehouse_reserve_roll_commands_sourceOrderId_fkey"
    FOREIGN KEY ("sourceOrderId") REFERENCES "commercial_orders"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "warehouse_reserve_roll_commands"
    ADD CONSTRAINT "warehouse_reserve_roll_commands_sourcePositionId_fkey"
    FOREIGN KEY ("sourcePositionId") REFERENCES "commercial_order_positions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
