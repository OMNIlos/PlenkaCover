import type { Actor } from '../auth/actor';
import type { PrismaService } from '../prisma/prisma.service';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from './payroll-tariff-engine';
import { PayrollTariffOrderService } from './payroll-tariff-order.service';

const ACTOR: Actor = {
  userId: 'director-1',
  role: 'director',
  capabilities: ['payroll_tariff:manage'],
};
const OTHER_ACTOR: Actor = { ...ACTOR, userId: 'director-2' };
const CREATE_KEY = '123e4567-e89b-42d3-a456-426614174000';
const UPDATE_KEY = '123e4567-e89b-42d3-a456-426614174001';

function matrix() {
  return structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    name: 'Приказ № 9-08/26',
    status: 'draft',
    effectiveFrom: new Date('2026-08-20T21:00:00.000Z'),
    currency: 'RUB',
    matrix: matrix(),
    revision: 1,
    createdById: ACTOR.userId,
    updatedById: ACTOR.userId,
    publishedById: null,
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    updatedAt: new Date('2026-08-13T09:00:00.000Z'),
    publishedAt: null,
    ...overrides,
  };
}

function setup() {
  const created = row();
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    payrollTariffOrder: {
      findUnique: jest.fn().mockResolvedValue(created),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(created),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    payrollTariffOrderCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'command-1' }),
    },
    domainEvent: { create: jest.fn().mockResolvedValue({ id: 'event-1' }) },
  };
  const prisma = {
    payrollTariffOrder: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(created),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    payrollTariffOrderCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new PayrollTariffOrderService(prisma as unknown as PrismaService, audit as never);
  return { audit, created, prisma, service, tx };
}

describe('PayrollTariffOrderService', () => {
  it('uses Moscow calendar dates for active/latest/minimum publication metadata', async () => {
    const { prisma, service } = setup();
    prisma.payrollTariffOrder.findMany.mockResolvedValue([
      row({
        id: 'legacy',
        name: 'Приказ № 8-09/25',
        status: 'published',
        effectiveFrom: new Date('2025-09-28T21:00:00.000Z'),
        publishedAt: new Date('2025-09-28T21:00:00.000Z'),
      }),
      row({
        id: 'future',
        status: 'published',
        effectiveFrom: new Date('2026-08-19T21:00:00.000Z'),
        publishedAt: new Date('2026-08-13T10:00:00.000Z'),
      }),
    ]);

    await expect(service.list(new Date('2026-08-13T20:59:59.999Z'))).resolves.toMatchObject({
      activeOrderId: 'legacy',
      latestPublishedOrderId: 'future',
      minimumPublishEffectiveFrom: '2026-08-21',
      timezone: 'Europe/Moscow',
    });
  });

  it.each([
    ['', 'name', 'invalid_length'],
    ['x'.repeat(201), 'name', 'invalid_length'],
  ])('rejects invalid draft name %p before writes', async (name, path, code) => {
    const { audit, service, tx } = setup();
    await expect(
      service.create(ACTOR, {
        operationKey: CREATE_KEY,
        name,
        effectiveFrom: '2026-08-21',
        matrix: matrix(),
      }),
    ).rejects.toMatchObject({ fieldErrors: [expect.objectContaining({ path, code })] });
    expect(tx.payrollTariffOrder.create).not.toHaveBeenCalled();
    expect(tx.payrollTariffOrderCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns parser field paths and leaves the transaction write-free', async () => {
    const { audit, service, tx } = setup();
    const invalid = matrix();
    invalid.ladders.urp12h[1]!.maxInclusiveGrams = 750_000;

    await expect(
      service.create(ACTOR, {
        operationKey: CREATE_KEY,
        name: 'Приказ № 9-08/26',
        effectiveFrom: '2026-08-21',
        matrix: invalid,
      }),
    ).rejects.toMatchObject({
      code: 'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({
          path: 'ladders.urp12h[1].maxInclusiveGrams',
          code: 'threshold_not_increasing',
        }),
      ]),
    });
    expect(tx.payrollTariffOrder.create).not.toHaveBeenCalled();
    expect(tx.payrollTariffOrderCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a stale revision and a published mutation before command/audit writes', async () => {
    const stale = setup();
    stale.tx.payrollTariffOrder.findUnique.mockResolvedValue(row({ revision: 2 }));
    await expect(
      stale.service.update(ACTOR, 'draft-1', {
        operationKey: UPDATE_KEY,
        expectedRevision: 1,
        name: 'Приказ № 9-08/26',
        effectiveFrom: '2026-08-21',
        matrix: matrix(),
      }),
    ).rejects.toMatchObject({ code: 'PAYROLL_TARIFF_ORDER_DRAFT_STALE' });
    expect(stale.tx.payrollTariffOrder.updateMany).not.toHaveBeenCalled();
    expect(stale.tx.payrollTariffOrderCommand.create).not.toHaveBeenCalled();
    expect(stale.audit.record).not.toHaveBeenCalled();

    const published = setup();
    published.tx.payrollTariffOrder.findUnique.mockResolvedValue(
      row({ status: 'published', publishedAt: new Date() }),
    );
    await expect(
      published.service.update(ACTOR, 'draft-1', {
        operationKey: UPDATE_KEY,
        expectedRevision: 1,
        name: 'Приказ № 9-08/26',
        effectiveFrom: '2026-08-21',
        matrix: matrix(),
      }),
    ).rejects.toMatchObject({ code: 'PAYROLL_TARIFF_ORDER_PUBLISHED_IMMUTABLE' });
    expect(published.tx.payrollTariffOrder.updateMany).not.toHaveBeenCalled();
  });

  it('reviews the exact revision/hash against tomorrow and the latest publication', async () => {
    const { prisma, service } = setup();
    prisma.payrollTariffOrder.findUnique.mockResolvedValue(row());
    prisma.payrollTariffOrder.findFirst.mockResolvedValue({
      effectiveFrom: new Date('2026-08-19T21:00:00.000Z'),
    });

    await expect(
      service.review('draft-1', { expectedRevision: 1 }, new Date('2026-08-13T21:00:00.000Z')),
    ).resolves.toMatchObject({
      orderId: 'draft-1',
      revision: 1,
      matrixHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      minimumPublishEffectiveFrom: '2026-08-21',
      publishable: true,
      fieldErrors: [],
    });
  });

  it('publishes only after locking, fresh review and an exact matrix hash', async () => {
    const { audit, service, tx } = setup();
    const reviewedHash = (
      await service.review('draft-1', { expectedRevision: 1 }, new Date('2026-08-13T12:00:00.000Z'))
    ).matrixHash;
    tx.payrollTariffOrder.findUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(
      row({
        status: 'published',
        publishedAt: new Date('2026-08-13T12:00:00.000Z'),
        publishedById: ACTOR.userId,
      }),
    );

    await expect(
      service.publish(
        ACTOR,
        'draft-1',
        {
          operationKey: UPDATE_KEY,
          expectedRevision: 1,
          reviewedMatrixHash: reviewedHash,
        },
        new Date('2026-08-13T12:00:00.000Z'),
      ),
    ).resolves.toMatchObject({ order: { status: 'published' }, replayed: false });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.payrollTariffOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-1', status: 'draft', revision: 1 },
      data: expect.objectContaining({
        status: 'published',
        publishedById: ACTOR.userId,
      }),
    });
    expect(tx.payrollTariffOrderCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'publish' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:payroll_tariff_order_published' }),
      tx,
    );
  });

  it('rejects a stale review hash before publication, journal and audit writes', async () => {
    const { audit, service, tx } = setup();
    await expect(
      service.publish(
        ACTOR,
        'draft-1',
        {
          operationKey: UPDATE_KEY,
          expectedRevision: 1,
          reviewedMatrixHash: '0'.repeat(64),
        },
        new Date('2026-08-13T12:00:00.000Z'),
      ),
    ).rejects.toMatchObject({ code: 'PAYROLL_TARIFF_ORDER_DRAFT_STALE' });
    expect(tx.payrollTariffOrder.updateMany).not.toHaveBeenCalled();
    expect(tx.payrollTariffOrderCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns structured review errors for today and a duplicate latest date', async () => {
    const { prisma, service } = setup();
    prisma.payrollTariffOrder.findUnique.mockResolvedValue(
      row({ effectiveFrom: new Date('2026-08-13T21:00:00.000Z') }),
    );
    prisma.payrollTariffOrder.findFirst.mockResolvedValue({
      effectiveFrom: new Date('2026-08-13T21:00:00.000Z'),
    });

    await expect(
      service.review('draft-1', { expectedRevision: 1 }, new Date('2026-08-14T12:00:00.000Z')),
    ).resolves.toMatchObject({
      minimumPublishEffectiveFrom: '2026-08-15',
      publishable: false,
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ code: 'past_or_today' }),
        expect.objectContaining({ code: 'effective_date_duplicate' }),
      ]),
    });
  });

  it('replays an exact command without a second order or event write', async () => {
    const { audit, service, tx } = setup();
    const input = {
      operationKey: CREATE_KEY,
      name: 'Приказ № 9-08/26',
      effectiveFrom: '2026-08-21',
      matrix: matrix(),
    };

    const first = await service.create(ACTOR, input);
    const stored = tx.payrollTariffOrderCommand.create.mock.calls[0]![0].data;
    tx.payrollTariffOrderCommand.findUnique.mockResolvedValue({
      requestFingerprint: stored.requestFingerprint,
      resultSnapshot: stored.resultSnapshot,
    });
    const replay = await service.create(ACTOR, input);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(tx.payrollTariffOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.payrollTariffOrderCommand.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects operation-key payload or actor reuse before mutation', async () => {
    const { audit, service, tx } = setup();
    const input = {
      operationKey: CREATE_KEY,
      name: 'Приказ № 9-08/26',
      effectiveFrom: '2026-08-21',
      matrix: matrix(),
    };
    await service.create(ACTOR, input);
    const stored = tx.payrollTariffOrderCommand.create.mock.calls[0]![0].data;
    tx.payrollTariffOrderCommand.findUnique.mockResolvedValue({
      requestFingerprint: stored.requestFingerprint,
      resultSnapshot: stored.resultSnapshot,
    });

    await expect(service.create(ACTOR, { ...input, name: 'Другой приказ' })).rejects.toMatchObject({
      code: 'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
    });
    await expect(service.create(OTHER_ACTOR, input)).rejects.toMatchObject({
      code: 'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
    });
    expect(tx.payrollTariffOrder.create).toHaveBeenCalledTimes(1);
    expect(tx.payrollTariffOrderCommand.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
