import type { Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import type { AuditService } from '../../common/audit/audit.service';

type FinanceProductionState = {
  productionClearedAt?: Date | null;
  invoiceStatus: string;
  policy: { id: string; stages: Array<{ id: string; trigger: string }> } | null;
  paymentTermsType: string | null;
  schedules: Array<{
    paymentPolicyStageId: string | null;
    kind: string;
    status: string;
  }>;
} | null;

export type FinanceProductionGate =
  | 'awaiting_invoice'
  | 'awaiting_payment_terms'
  | 'awaiting_prepayment'
  | 'open';

export function financeProductionGate(financeOrder: FinanceProductionState): FinanceProductionGate {
  if (financeOrder?.productionClearedAt) return 'open';
  if (!financeOrder || financeOrder.invoiceStatus !== 'invoiced') {
    return 'awaiting_invoice';
  }

  if (financeOrder.policy) {
    const requiredStages = financeOrder.policy.stages.filter(
      (stage) => stage.trigger === 'invoice_issued',
    );
    const prepaymentSatisfied = requiredStages.every((stage) =>
      financeOrder.schedules.some(
        (row) =>
          row.paymentPolicyStageId === stage.id &&
          row.kind === 'invoice_prepayment' &&
          row.status === 'paid',
      ),
    );
    return prepaymentSatisfied ? 'open' : 'awaiting_prepayment';
  }

  if (financeOrder.paymentTermsType === 'postpay_100_30d') return 'open';
  if (financeOrder.paymentTermsType !== 'prepay_50_postpay_50_30d') {
    return 'awaiting_payment_terms';
  }

  const prepaymentSatisfied = financeOrder.schedules.some(
    (row) => row.kind === 'invoice_prepayment' && row.status === 'paid',
  );
  return prepaymentSatisfied ? 'open' : 'awaiting_prepayment';
}

export function financeAllowsProduction(financeOrder: FinanceProductionState): boolean {
  return financeProductionGate(financeOrder) === 'open';
}

export async function captureProductionClearance(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  actor: { userId: string | null; role: Role },
  financeOrderId: string,
  reason: string,
): Promise<Date | null> {
  const financeOrder = await tx.financeOrder.findUnique({
    where: { id: financeOrderId },
    select: {
      id: true,
      commercialOrderId: true,
      productionClearedAt: true,
      invoiceStatus: true,
      paymentTermsType: true,
      policy: {
        select: {
          id: true,
          stages: { select: { id: true, trigger: true } },
        },
      },
      schedules: {
        where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
        select: { paymentPolicyStageId: true, kind: true, status: true },
      },
    },
  });
  if (!financeOrder) return null;
  if (financeOrder.productionClearedAt) return financeOrder.productionClearedAt;
  if (!financeAllowsProduction(financeOrder)) return null;

  const productionClearedAt = new Date();
  const captured = await tx.financeOrder.updateMany({
    where: { id: financeOrderId, productionClearedAt: null },
    data: { productionClearedAt },
  });
  if (captured.count !== 1) {
    const winner = await tx.financeOrder.findUnique({
      where: { id: financeOrderId },
      select: { productionClearedAt: true },
    });
    return winner?.productionClearedAt ?? null;
  }

  await audit.record(
    {
      type: 'audit:finance_production_cleared',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: financeOrderId,
      reason,
      detail: {
        financeOrderId,
        commercialOrderId: financeOrder.commercialOrderId,
      },
    },
    tx,
  );
  return productionClearedAt;
}
