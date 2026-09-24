import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('flexible payment policy migration (e2e, real PostgreSQL)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enforces one policy per finance order and one schedule per policy stage', async () => {
    const suffix = randomUUID();
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Policy migration ${suffix}` },
    });
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `POLICY-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    const financeOrder = await prisma.financeOrder.create({
      data: { commercialOrderId: commercialOrder.id },
    });

    try {
      const policy = await prisma.paymentPolicy.create({
        data: {
          financeOrderId: financeOrder.id,
          installmentDays: 0,
          capturedProductionLeadDays: 2,
        },
      });
      const stage = await prisma.paymentPolicyStage.create({
        data: {
          paymentPolicyId: policy.id,
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 10000,
          offsetDays: 0,
        },
      });
      await expect(
        prisma.paymentPolicyStage.create({
          data: {
            paymentPolicyId: policy.id,
            sequence: 1,
            trigger: 'invoice_issued',
            percentageBasisPoints: 10000,
            offsetDays: 0,
          },
        }),
      ).rejects.toThrow();
      expect(stage.paymentPolicyId).toBe(policy.id);
    } finally {
      await prisma.financeOrder.delete({ where: { id: financeOrder.id } });
      await prisma.commercialOrder.delete({ where: { id: commercialOrder.id } });
      await prisma.counterparty.delete({ where: { id: counterparty.id } });
    }
  });
});
