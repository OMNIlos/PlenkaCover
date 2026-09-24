import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from './payroll-tariff-engine';
import { PayrollTariffOrderRepository } from './payroll-tariff-order.repository';

function mutableLegacyMatrix(): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(LEGACY_PAYROLL_TARIFF_MATRIX_V1)) as Prisma.InputJsonValue;
}

function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-legacy',
    name: 'Приказ № 8-09/25',
    effectiveFrom: new Date('2025-09-28T21:00:00.000Z'),
    currency: 'RUB',
    matrix: mutableLegacyMatrix(),
    revision: 1,
    ...overrides,
  };
}

function repositoryWith(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { payrollTariffOrder: { findMany } } as unknown as PrismaService;
  return { findMany, repository: new PayrollTariffOrderRepository(prisma) };
}

describe('payroll tariff order repository', () => {
  it('loads every published version through one inclusive max basis query', async () => {
    const rows = [
      publishedRow(),
      publishedRow({
        id: 'order-next',
        name: 'Приказ № 9-08/26',
        effectiveFrom: new Date('2026-08-16T21:00:00.000Z'),
        revision: 3,
      }),
    ];
    const { findMany, repository } = repositoryWith(rows);
    const maxBasisAt = new Date('2026-08-20T12:00:00.000Z');

    const schedule = await repository.loadPublishedSchedule(maxBasisAt);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'published', effectiveFrom: { lte: maxBasisAt } },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        effectiveFrom: true,
        currency: true,
        matrix: true,
        revision: true,
      },
    });
    expect(schedule).toHaveLength(2);
    expect(schedule[0]).toMatchObject({
      reference: {
        id: 'order-legacy',
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
      },
      effectiveFromMs: Date.parse('2025-09-28T21:00:00.000Z'),
      revision: 1,
      matrixHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(schedule[0]!.matrix).toEqual(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    expect(schedule[0]!.matrix).not.toBe(rows[0]!.matrix);
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule[0])).toBe(true);
    expect(Object.isFrozen(schedule[0]!.reference)).toBe(true);
  });

  it('uses the supplied transaction client without a second query', async () => {
    const { findMany: rootFindMany, repository } = repositoryWith([]);
    const txFindMany = jest.fn().mockResolvedValue([publishedRow()]);
    const tx = {
      payrollTariffOrder: { findMany: txFindMany },
    } as unknown as Prisma.TransactionClient;

    await expect(
      repository.loadPublishedSchedule(new Date('2026-08-20T12:00:00.000Z'), tx),
    ).resolves.toHaveLength(1);
    expect(txFindMany).toHaveBeenCalledTimes(1);
    expect(rootFindMany).not.toHaveBeenCalled();
  });

  it('batch-loads exact immutable replay versions through one transaction query', async () => {
    const { findMany: rootFindMany, repository } = repositoryWith([]);
    const txFindMany = jest
      .fn()
      .mockResolvedValue([
        publishedRow(),
        publishedRow({ id: 'order-next', name: 'Приказ следующий' }),
      ]);
    const tx = {
      payrollTariffOrder: { findMany: txFindMany },
    } as unknown as Prisma.TransactionClient;

    const schedule = await repository.loadPublishedOrdersByIds(
      ['order-next', 'order-legacy', 'order-next'],
      tx,
    );

    expect(txFindMany).toHaveBeenCalledTimes(1);
    expect(txFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['order-legacy', 'order-next'] }, status: 'published' },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        effectiveFrom: true,
        currency: true,
        matrix: true,
        revision: true,
      },
    });
    expect(schedule.map(({ reference }) => reference.id)).toEqual(['order-legacy', 'order-next']);
    expect(rootFindMany).not.toHaveBeenCalled();
  });

  it('fails closed with a safe code for a corrupt persisted matrix', async () => {
    const rawSecret = 'raw-device-payload-must-not-leak';
    const { repository } = repositoryWith([
      publishedRow({ matrix: { schemaVersion: 1, rawSecret } }),
    ]);

    await expect(
      repository.loadPublishedSchedule(new Date('2026-08-20T12:00:00.000Z')),
    ).rejects.toMatchObject({
      code: 'PAYROLL_TARIFF_ORDER_CORRUPT',
      message: expect.not.stringContaining(rawSecret),
    });
  });
});
