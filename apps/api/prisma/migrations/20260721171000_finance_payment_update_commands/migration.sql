-- A payment-status change is a durable command claim, not a payment operation. Exact retries
-- reuse this journal row; only the transaction that inserts it may mutate the finance aggregate.
CREATE TABLE "finance_payment_update_commands" (
  "id" TEXT NOT NULL,
  "financeOrderId" TEXT NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "actorRole" "Role" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "finance_payment_update_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "finance_payment_update_commands_operationKey_format_check"
    CHECK (
      "operationKey"::text ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ),
  CONSTRAINT "finance_payment_update_commands_requestFingerprint_format_check"
    CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "finance_payment_update_commands_financeOrderId_fkey"
    FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "finance_payment_update_commands_financeOrderId_operationKey_key"
  ON "finance_payment_update_commands"("financeOrderId", "operationKey");
