-- CreateTable
CREATE TABLE "payment_policies" (
    "id" TEXT NOT NULL,
    "financeOrderId" TEXT NOT NULL,
    "installmentDays" INTEGER NOT NULL,
    "capturedProductionLeadDays" INTEGER NOT NULL DEFAULT 2,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_policies_installmentDays_check" CHECK ("installmentDays" >= 0),
    CONSTRAINT "payment_policies_capturedProductionLeadDays_check"
      CHECK ("capturedProductionLeadDays" >= 0)
);

-- CreateTable
CREATE TABLE "payment_policy_stages" (
    "id" TEXT NOT NULL,
    "paymentPolicyId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "percentageBasisPoints" INTEGER NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_policy_stages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_policy_stages_sequence_check" CHECK ("sequence" > 0),
    CONSTRAINT "payment_policy_stages_percentageBasisPoints_check"
      CHECK ("percentageBasisPoints" BETWEEN 1 AND 10000),
    CONSTRAINT "payment_policy_stages_offsetDays_check" CHECK ("offsetDays" >= 0),
    CONSTRAINT "payment_policy_stages_trigger_check"
      CHECK ("trigger" IN ('invoice_issued', 'full_shipment'))
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_policies_financeOrderId_key"
ON "payment_policies"("financeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_policy_stages_paymentPolicyId_sequence_key"
ON "payment_policy_stages"("paymentPolicyId", "sequence");

-- AddForeignKey
ALTER TABLE "payment_policies"
ADD CONSTRAINT "payment_policies_financeOrderId_fkey"
FOREIGN KEY ("financeOrderId") REFERENCES "finance_orders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_policy_stages"
ADD CONSTRAINT "payment_policy_stages_paymentPolicyId_fkey"
FOREIGN KEY ("paymentPolicyId") REFERENCES "payment_policies"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "payment_schedules"
ADD COLUMN "paymentPolicyStageId" TEXT,
ADD COLUMN "percentageBasisPoints" INTEGER,
ADD COLUMN "offsetDays" INTEGER;

-- Backfill fixed payment policies with stable identifiers.
INSERT INTO "payment_policies"
  ("id", "financeOrderId", "installmentDays", "capturedProductionLeadDays",
   "revision", "createdAt", "updatedAt")
SELECT
  'migrated-policy-' || "id", "id", 30, 2, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "finance_orders"
WHERE "paymentTermsType" IN ('prepay_50_postpay_50_30d', 'postpay_100_30d')
ON CONFLICT ("financeOrderId") DO NOTHING;

-- Backfill the two current fixed-policy shapes.
INSERT INTO "payment_policy_stages"
  ("id", "paymentPolicyId", "sequence", "trigger", "percentageBasisPoints",
   "offsetDays", "createdAt", "updatedAt")
SELECT
  'migrated-policy-stage-' || policy."financeOrderId" || '-1',
  policy."id",
  1,
  'invoice_issued',
  5000,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "payment_policies" AS policy
JOIN "finance_orders" AS finance_order ON finance_order."id" = policy."financeOrderId"
WHERE finance_order."paymentTermsType" = 'prepay_50_postpay_50_30d'
UNION ALL
SELECT
  'migrated-policy-stage-' || policy."financeOrderId" || '-2',
  policy."id",
  2,
  'full_shipment',
  5000,
  30,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "payment_policies" AS policy
JOIN "finance_orders" AS finance_order ON finance_order."id" = policy."financeOrderId"
WHERE finance_order."paymentTermsType" = 'prepay_50_postpay_50_30d'
UNION ALL
SELECT
  'migrated-policy-stage-' || policy."financeOrderId" || '-1',
  policy."id",
  1,
  'full_shipment',
  10000,
  30,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "payment_policies" AS policy
JOIN "finance_orders" AS finance_order ON finance_order."id" = policy."financeOrderId"
WHERE finance_order."paymentTermsType" = 'postpay_100_30d'
ON CONFLICT ("paymentPolicyId", "sequence") DO NOTHING;

-- Link one deterministic legacy schedule per finance order and kind. Any unexpected
-- duplicate remains an unlinked legacy row instead of violating the one-stage invariant.
WITH ranked_schedules AS (
  SELECT
    schedule."id",
    schedule."financeOrderId",
    CASE
      WHEN finance_order."paymentTermsType" = 'prepay_50_postpay_50_30d'
        AND schedule."kind" = 'invoice_prepayment' THEN 1
      WHEN finance_order."paymentTermsType" = 'prepay_50_postpay_50_30d'
        AND schedule."kind" = 'post_delivery' THEN 2
      WHEN finance_order."paymentTermsType" = 'postpay_100_30d'
        AND schedule."kind" = 'post_delivery' THEN 1
    END AS stage_sequence,
    ROW_NUMBER() OVER (
      PARTITION BY schedule."financeOrderId", schedule."kind"
      ORDER BY schedule."createdAt", schedule."id"
    ) AS row_number
  FROM "payment_schedules" AS schedule
  JOIN "finance_orders" AS finance_order ON finance_order."id" = schedule."financeOrderId"
  WHERE
    (finance_order."paymentTermsType" = 'prepay_50_postpay_50_30d'
      AND schedule."kind" IN ('invoice_prepayment', 'post_delivery'))
    OR (finance_order."paymentTermsType" = 'postpay_100_30d'
      AND schedule."kind" = 'post_delivery')
)
UPDATE "payment_schedules" AS schedule
SET
  "paymentPolicyStageId" = stage."id",
  "percentageBasisPoints" = stage."percentageBasisPoints",
  "offsetDays" = stage."offsetDays"
FROM ranked_schedules AS ranked
JOIN "payment_policies" AS policy ON policy."financeOrderId" = ranked."financeOrderId"
JOIN "payment_policy_stages" AS stage
  ON stage."paymentPolicyId" = policy."id" AND stage."sequence" = ranked.stage_sequence
WHERE schedule."id" = ranked."id" AND ranked.row_number = 1;

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_paymentPolicyStageId_key"
ON "payment_schedules"("paymentPolicyStageId");

-- AddForeignKey
ALTER TABLE "payment_schedules"
ADD CONSTRAINT "payment_schedules_paymentPolicyStageId_fkey"
FOREIGN KEY ("paymentPolicyStageId") REFERENCES "payment_policy_stages"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
