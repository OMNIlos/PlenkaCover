import { NotFoundException } from '@nestjs/common';
import { OperatorOrderMassService } from './operator-order-mass.service';

const AT = new Date('2026-08-08T06:00:00.000Z');

type Capture = {
  id: string;
  operatorRollLineId: string;
  kind: string;
  stable: boolean;
  netKg: number | null;
  supersedesCaptureId: string | null;
  createdAt: Date;
};

function capture(
  id: string,
  operatorRollLineId: string,
  netKg: number,
  supersedesCaptureId: string | null = null,
): Capture {
  return {
    id,
    operatorRollLineId,
    kind: 'roll',
    stable: true,
    netKg,
    supersedesCaptureId,
    createdAt: new Date(AT.getTime() + Number(id.replace(/\D/gu, '') || 0)),
  };
}

function dispatch(
  id: string,
  planKg: number,
  captures: Capture[] = [],
  replacesDispatchItemId: string | null = null,
  orderLineId = 'position-1',
  status = 'assigned',
  dispatchPlanKg: number | null = planKg,
) {
  const lineId = `line-${id}`;
  return {
    id,
    orderLineId,
    status,
    replacesDispatchItemId,
    plannedWeightKg: dispatchPlanKg,
    operatorLine: {
      id: lineId,
      planKg,
      weightCaptures: captures.map((item) => ({ ...item, operatorRollLineId: lineId })),
    },
  };
}

function context(items: ReturnType<typeof dispatch>[], ownsOrder = true) {
  const prisma = {
    productionOrder: {
      findFirst: jest.fn().mockResolvedValue(ownsOrder ? { id: 'production-order-1' } : null),
      findUnique: jest.fn().mockResolvedValue({ id: 'production-order-1', dispatchItems: items }),
    },
  };
  return {
    prisma,
    service: new OperatorOrderMassService(prisma as never),
  };
}

describe('OperatorOrderMassService', () => {
  it('returns the full logical order plan and zero weighed mass before captures exist', async () => {
    const { service } = context([
      dispatch('roll-1', 10),
      dispatch('roll-2', 20, [], null, 'position-2'),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toEqual({
      orderPlannedNetKg: 30,
      weighedPlannedNetKg: 0,
      actualNetKg: 0,
      deviationKg: 0,
      weighedRollCount: 0,
      totalRollCount: 2,
    });
  });

  it('compares a partial fact only with the plans of those same weighed rolls', async () => {
    const { service } = context([
      dispatch('roll-1', 10, [capture('capture-1', 'ignored', 12)]),
      dispatch('roll-2', 20, [], null, 'position-2'),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toEqual({
      orderPlannedNetKg: 30,
      weighedPlannedNetKg: 10,
      actualNetKg: 12,
      deviationKg: 2,
      weighedRollCount: 1,
      totalRollCount: 2,
    });
  });

  it('excludes the invalid A-16 canonical tail from partial mass', async () => {
    const { service } = context([
      dispatch('A-16-roll-1', 10, [capture('capture-1', 'ignored', 9.15)]),
      dispatch(
        'A-16-roll-2',
        3,
        [capture('capture-2', 'ignored', -0.55)],
        null,
        'position-2',
      ),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'A-16')).resolves.toEqual({
      orderPlannedNetKg: 13,
      weighedPlannedNetKg: 10,
      actualNetKg: 9.15,
      deviationKg: -0.85,
      weighedRollCount: 1,
      totalRollCount: 2,
    });
  });

  it.each([0, -0.001, Number.NaN])(
    'does not count canonical net %s as a weighed roll fact',
    async (netKg) => {
      const { service } = context([
        dispatch('invalid-roll', 3, [capture('capture-1', 'ignored', netKg)]),
      ]);

      await expect(
        service.getForOrder({ userId: 'operator-1' }, 'ORDER-WITH-INVALID-MASS'),
      ).resolves.toMatchObject({
        orderPlannedNetKg: 3,
        weighedPlannedNetKg: 0,
        actualNetKg: 0,
        deviationKg: 0,
        weighedRollCount: 0,
        totalRollCount: 1,
      });
    },
  );

  it('preserves a signed negative deviation and rounds kilograms to three decimals', async () => {
    const { service } = context([
      dispatch('roll-1', 10.1114, [capture('capture-1', 'ignored', 9.0004)]),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toEqual({
      orderPlannedNetKg: 10.111,
      weighedPlannedNetKg: 10.111,
      actualNetKg: 9,
      deviationKg: -1.111,
      weighedRollCount: 1,
      totalRollCount: 1,
    });
  });

  it('uses the current dispatch plan after a reversible commercial amendment', async () => {
    const amended = dispatch('roll-1', 12);
    amended.operatorLine.planKg = 10;
    const { service } = context([amended]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toMatchObject({
      orderPlannedNetKg: 12,
      weighedPlannedNetKg: 0,
      totalRollCount: 1,
    });
  });

  it('falls back to the operator line plan when the dispatch plan is absent', async () => {
    const legacy = dispatch('roll-1', 10);
    legacy.plannedWeightKg = null;
    const { service } = context([legacy]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toMatchObject({
      orderPlannedNetKg: 10,
      totalRollCount: 1,
    });
  });

  it('uses only the canonical tail of a reweigh chain', async () => {
    const base = capture('capture-1', 'ignored', 10.5);
    const reweigh = capture('capture-2', 'ignored', 11.25, base.id);
    const { service } = context([dispatch('roll-1', 10, [reweigh, base])]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toMatchObject({
      weighedPlannedNetKg: 10,
      actualNetKg: 11.25,
      deviationKg: 1.25,
      weighedRollCount: 1,
    });
  });

  it('counts a defect replacement chain as one logical roll and ignores the ancestor capture', async () => {
    const { service } = context([
      dispatch('roll-root', 10, [capture('capture-1', 'ignored', 8)]),
      dispatch('roll-replacement', 10, [capture('capture-2', 'ignored', 9)], 'roll-root'),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toEqual({
      orderPlannedNetKg: 10,
      weighedPlannedNetKg: 10,
      actualNetKg: 9,
      deviationKg: -1,
      weighedRollCount: 1,
      totalRollCount: 1,
    });
  });

  it('does not treat an ancestor fact as the fact of an unweighed replacement leaf', async () => {
    const { service } = context([
      dispatch('roll-root', 10, [capture('capture-1', 'ignored', 8)]),
      dispatch('roll-replacement', 10, [], 'roll-root'),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toMatchObject({
      orderPlannedNetKg: 10,
      weighedPlannedNetKg: 0,
      actualNetKg: 0,
      deviationKg: 0,
      weighedRollCount: 0,
      totalRollCount: 1,
    });
  });

  it('excludes cancelled future rolls from the current logical plan', async () => {
    const { service } = context([
      dispatch('roll-active', 10),
      dispatch('roll-cancelled', 20, [], null, 'position-2', 'cancelled'),
    ]);

    await expect(service.getForOrder({ userId: 'operator-1' }, 'ORD-1')).resolves.toEqual({
      orderPlannedNetKg: 10,
      weighedPlannedNetKg: 0,
      actualNetKg: 0,
      deviationKg: 0,
      weighedRollCount: 0,
      totalRollCount: 1,
    });
  });

  it('proves actor ownership first, then loads the complete order graph without unsafe fields', async () => {
    const { service, prisma } = context([
      dispatch('owned-roll', 10, [capture('capture-1', 'ignored', 10)]),
      dispatch('other-operator-roll', 20, [capture('capture-2', 'ignored', 21)]),
    ]);

    await service.getForOrder({ userId: 'operator-1' }, 'ORD-1');

    expect(prisma.productionOrder.findFirst).toHaveBeenCalledWith({
      where: {
        commercialOrder: { orderNumber: 'ORD-1' },
        dispatchItems: {
          some: { assignedOperatorId: 'operator-1', status: { not: 'new' } },
        },
      },
      select: { id: true },
    });
    const completeRead = prisma.productionOrder.findUnique.mock.calls[0]?.[0];
    expect(completeRead.where).toEqual({ id: 'production-order-1' });
    expect(completeRead.select.dispatchItems.where).toEqual({
      status: { not: 'cancelled' },
    });
    expect(JSON.stringify(completeRead.select)).not.toMatch(
      /device|gross|spool|raw|payload|operation|postSession/iu,
    );
  });

  it('is a pure idempotent GET aggregate with identical repeated results', async () => {
    const { service, prisma } = context([
      dispatch('roll-1', 10, [capture('capture-1', 'ignored', 10.5)]),
    ]);

    const first = await service.getForOrder({ userId: 'operator-1' }, 'ORD-1');
    const second = await service.getForOrder({ userId: 'operator-1' }, 'ORD-1');

    expect(second).toEqual(first);
    expect(Object.keys(prisma)).toEqual(['productionOrder']);
    expect(prisma.productionOrder.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.productionOrder.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not disclose an order outside the actor assignment boundary', async () => {
    const { service, prisma } = context([], false);

    await expect(service.getForOrder({ userId: 'operator-2' }, 'ORD-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.productionOrder.findUnique).not.toHaveBeenCalled();
  });
});
