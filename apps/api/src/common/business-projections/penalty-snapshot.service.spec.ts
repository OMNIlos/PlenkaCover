import { Reflector } from '@nestjs/core';
import { CapabilityGuard } from '../auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../auth/require-capabilities.decorator';
import { capabilitiesForRole, type Role } from '@plenka/contracts';
import { PenaltySnapshotController } from './penalty-snapshot.controller';
import { PenaltySnapshotService } from './penalty-snapshot.service';

const createdAt = new Date('2026-08-08T08:00:00.000Z');

function row(
  id: string,
  overrides: Partial<{
    employeeId: string | null;
    employee: { displayName: string } | null;
    targetRole: 'operator' | 'production_lead';
    amount: number;
    reason: string;
    status: 'issued' | 'disputed' | 'cancelled';
  }> = {},
) {
  return {
    id,
    employeeId: 'operator-1',
    employee: { displayName: 'Илья Ковалёв' },
    targetRole: 'operator' as const,
    amount: 10.005,
    reason: 'Брак',
    sourceObjectId: 'roll-1',
    sourceProductionOrderId: 'order-1',
    sourceOrderNumber: 'A-101',
    sourceRollCode: 'A-101-1',
    authorRole: 'production_lead' as const,
    status: 'issued' as const,
    createdAt,
    ...overrides,
  };
}

function setup(rows: ReturnType<typeof row>[]) {
  const prisma = { penalty: { findMany: jest.fn().mockResolvedValue(rows) } };
  return { prisma, service: new PenaltySnapshotService(prisma as never) };
}

function context(handler: (...args: never[]) => unknown, role: Role) {
  return {
    getHandler: () => handler,
    getClass: () => PenaltySnapshotController,
    switchToHttp: () => ({
      getRequest: () => ({
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      }),
    }),
  } as never;
}

describe('PenaltySnapshotService', () => {
  it('returns the exact empty snapshot from one persisted selection', async () => {
    const { prisma, service } = setup([]);

    await expect(service.read({})).resolves.toEqual({
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    });
    expect(prisma.penalty.findMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    { rows: [row('penalty-1')], count: 1, amount: 1001 },
    { rows: [row('penalty-1'), row('penalty-2', { amount: 20.004 })], count: 2, amount: 3001 },
  ])(
    'aggregates $count selected rows from their projected integer kopecks',
    async ({ rows, count, amount }) => {
      const { service } = setup(rows);

      await expect(service.read({})).resolves.toMatchObject({
        summary: { totalCount: count, totalAmountKopecks: amount, topReason: 'брак' },
      });
    },
  );

  it('applies target, status, and employee filters to the same single query', async () => {
    const selected = row('lead-penalty', {
      employeeId: 'lead-7',
      targetRole: 'production_lead',
      status: 'cancelled',
    });
    const { prisma, service } = setup([selected]);

    const snapshot = await service.read({
      targetRole: 'production_lead',
      status: 'cancelled',
      employeeId: 'lead-7',
    });

    expect(prisma.penalty.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.penalty.findMany).toHaveBeenCalledWith({
      where: {
        targetRole: 'production_lead',
        status: 'cancelled',
        employeeId: 'lead-7',
      },
      select: expect.objectContaining({ employeeId: true, employee: expect.any(Object) }),
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.summary.totalCount).toBe(snapshot.items.length);
  });

  it('preserves a penalty whose employee relation is missing', async () => {
    const { service } = setup([
      row('orphaned', { employeeId: 'deleted-employee-9', employee: null }),
    ]);

    await expect(service.read({})).resolves.toMatchObject({
      items: [
        {
          id: 'orphaned',
          employeeId: 'deleted-employee-9',
          displayName: null,
          amountKopecks: 1001,
        },
      ],
      summary: { totalCount: 1 },
    });
  });

  it('keeps operator and production-lead rows together in an unfiltered snapshot', async () => {
    const { service } = setup([
      row('operator-penalty'),
      row('lead-penalty', {
        employeeId: 'lead-1',
        employee: { displayName: 'Анна Петрова' },
        targetRole: 'production_lead',
        amount: 5,
      }),
    ]);

    const snapshot = await service.read({});

    expect(snapshot.items.map((item) => item.targetRole)).toEqual(['operator', 'production_lead']);
    expect(snapshot.summary).toMatchObject({ totalCount: 2, totalAmountKopecks: 1501 });
  });

  it('chooses the lexicographically smallest normalized Russian reason on a count tie', async () => {
    const { service } = setup([
      row('one', { reason: '  Вес  ' }),
      row('two', { reason: 'БРАК' }),
      row('three', { reason: 'вес' }),
      row('four', { reason: ' брак ' }),
    ]);

    await expect(service.read({})).resolves.toMatchObject({
      summary: { totalCount: 4, topReason: 'брак' },
    });
  });
});

describe('PenaltySnapshotController access', () => {
  const guard = new CapabilityGuard(new Reflector());
  const handler = PenaltySnapshotController.prototype.snapshot;

  it('delegates both Production and Director reads to the same snapshot service', async () => {
    const snapshot = {
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    };
    const service = { read: jest.fn().mockResolvedValue(snapshot) };
    const controller = new PenaltySnapshotController(service as never);

    await expect(controller.snapshot({ targetRole: 'operator' })).resolves.toBe(snapshot);
    expect(service.read).toHaveBeenCalledTimes(1);
    expect(service.read).toHaveBeenCalledWith({ targetRole: 'operator' });
  });

  it('requires penalty:read and grants it only to Production and Director', () => {
    expect(new Reflector().get(REQUIRE_CAPABILITIES, handler)).toEqual(['penalty:read']);
    expect(guard.canActivate(context(handler, 'production_lead'))).toBe(true);
    expect(guard.canActivate(context(handler, 'director'))).toBe(true);
    for (const role of ['commercial', 'operator', 'warehouse', 'finance', 'admin'] as const) {
      expect(() => guard.canActivate(context(handler, role))).toThrow();
    }
  });
});
