ALTER TABLE "commercial_orders"
  ADD COLUMN "commercialStage" TEXT NOT NULL DEFAULT 'incoming',
  ADD COLUMN "draftedAt" TIMESTAMP(3),
  ADD COLUMN "sentToFinanceAt" TIMESTAMP(3),
  ADD COLUMN "financeConfirmedAt" TIMESTAMP(3),
  ADD COLUMN "commercialLockedAt" TIMESTAMP(3);

UPDATE "commercial_orders"
SET
  "commercialStage" = 'sent_to_finance',
  "sentToFinanceAt" = COALESCE("sentToFinanceAt", "createdAt")
WHERE "id" IN (
  SELECT "commercialOrderId" FROM "finance_orders"
);

UPDATE "commercial_orders"
SET
  "commercialStage" = 'in_work',
  "sentToFinanceAt" = COALESCE("sentToFinanceAt", "updatedAt"),
  "financeConfirmedAt" = COALESCE("financeConfirmedAt", "updatedAt"),
  "commercialLockedAt" = COALESCE("commercialLockedAt", "updatedAt")
WHERE "paymentStatus" IN ('partial', 'paid');

UPDATE "commercial_orders" co
SET
  "commercialStage" = 'in_work',
  "paymentStatus" = fo."paymentStatus",
  "sentToFinanceAt" = COALESCE(co."sentToFinanceAt", fo."createdAt", co."updatedAt"),
  "financeConfirmedAt" = COALESCE(co."financeConfirmedAt", fo."updatedAt", co."updatedAt"),
  "commercialLockedAt" = COALESCE(co."commercialLockedAt", fo."updatedAt", co."updatedAt")
FROM "finance_orders" fo
WHERE fo."commercialOrderId" = co."id"
  AND fo."paymentStatus" IN ('partial', 'paid');
