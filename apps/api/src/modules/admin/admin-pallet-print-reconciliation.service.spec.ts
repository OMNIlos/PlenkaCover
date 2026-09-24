import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPalletPrintReconciliationService } from './admin-pallet-print-reconciliation.service';

const actor = { userId: 'admin-1', role: 'admin' as const };
const operationKey = '6ae53c5c-8649-44b9-aeb7-32ebeadc4937';

function setup() {
  const job = {
    id: 'pallet-job-1',
    palletListDocumentId: 'pallet-list-1',
    requestId: 'request-1',
    printerId: 'printer-1',
    gatewayCommandId: 'gateway-command-1',
    status: 'delivery_unknown',
    failureReason: 'transport detail that must stay private',
    completedAt: new Date('2026-08-06T10:00:00.000Z'),
    document: {
      id: 'pallet-list-1',
      palletId: 'pallet-1',
    },
  };
  const tx = {
    gatewayCommand: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    palletPrintReconciliation: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
    },
    palletPrintJob: {
      findUnique: jest.fn().mockResolvedValue(job),
      update: jest.fn().mockResolvedValue(undefined),
    },
    domainEvent: { create: jest.fn() },
  };
  const prisma = {
    palletPrintReconciliation: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    palletPrintJob: {
      findUnique: jest.fn().mockResolvedValue(job),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((work) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminPalletPrintReconciliationService(prisma as never, audit as never);
  return { service, prisma, tx, audit, job };
}

describe('AdminPalletPrintReconciliationService', () => {
  it('rejects a physical decision while the exact gateway command is still active', async () => {
    const { service, tx, audit } = setup();
    tx.gatewayCommand.findFirst.mockResolvedValue({ id: 'active-command' });
    await expect(service.reconcile(actor, 'pallet-job-1', { operationKey, outcome: 'not_printed', reason: 'Проверили принтер' }))
      .rejects.toMatchObject({ response: { code: 'ADMIN_PRINT_COMMAND_IN_PROGRESS' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lists only unresolved ambiguous pallet jobs newest first with a safe bounded projection', async () => {
    const { service, prisma } = setup();
    prisma.palletPrintJob.findMany.mockResolvedValue([
      {
        id: 'pallet-job-2',
        palletListDocumentId: 'pallet-list-2',
        status: 'delivery_unknown',
        createdAt: new Date('2026-08-06T12:00:00.000Z'),
        completedAt: new Date('2026-08-06T12:01:00.000Z'),
        document: { palletId: 'PALLET-2' },
      },
    ]);

    const result = await service.listUnresolved(2);

    expect(prisma.palletPrintJob.findMany).toHaveBeenCalledWith({
      where: {
        status: 'delivery_unknown',
        reconciliation: { is: null },
      },
      select: {
        id: true,
        palletListDocumentId: true,
        status: true,
        createdAt: true,
        completedAt: true,
        document: { select: { palletId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
    expect(result).toEqual([
      {
        printJobId: 'pallet-job-2',
        palletListDocumentId: 'pallet-list-2',
        palletId: 'PALLET-2',
        status: 'delivery_unknown',
        createdAt: '2026-08-06T12:00:00.000Z',
        completedAt: '2026-08-06T12:01:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /token|raw|bitmap|gateway|failureReason|printerId|requestId/i,
    );
  });

  it.each([
    [undefined, 25],
    [0, 1],
    [100, 50],
    [Number.NaN, 25],
  ])('bounds an internal unresolved-list limit of %s to %s', async (requested, expected) => {
    const { service, prisma } = setup();

    await service.listUnresolved(requested);

    expect(prisma.palletPrintJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: expected }),
    );
  });

  it('records an observed pallet label as submitted without scheduling another print', async () => {
    const { service, tx, audit } = setup();

    const result = await service.reconcile(actor, 'pallet-job-1', {
      operationKey,
      outcome: 'label_observed',
      reason: 'Палетная этикетка фактически вышла из принтера',
    });

    expect(tx.palletPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'pallet-job-1' },
      data: {
        status: 'submitted',
        failureReason: 'admin_reconciled_label_observed',
        completedAt: new Date('2026-08-06T10:00:00.000Z'),
      },
    });
    expect(tx.palletPrintReconciliation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationKey,
        printJobId: 'pallet-job-1',
        palletListDocumentId: 'pallet-list-1',
        actorId: 'admin-1',
        outcome: 'label_observed',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:pallet_list_print_reconciled',
        actorRole: 'admin',
        actorId: 'admin-1',
        objectId: 'pallet-list-1',
        oldValue: { printStatus: 'delivery_unknown' },
        newValue: { printStatus: 'submitted' },
        reason: 'Палетная этикетка фактически вышла из принтера',
        detail: {
          operationKey,
          printJobId: 'pallet-job-1',
          outcome: 'label_observed',
        },
      },
      tx,
    );
    expect(result).toEqual({
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      status: 'submitted',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /token|raw|bitmap|gateway|failureReason|printerId|requestId/i,
    );
  });

  it('marks a confirmed non-print failed so a later warehouse print is no longer blocked', async () => {
    const { service, tx } = setup();

    const result = await service.reconcile(actor, 'pallet-job-1', {
      operationKey,
      outcome: 'not_printed',
      reason: 'На выходе принтера этикетки нет',
    });

    expect(tx.palletPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'pallet-job-1' },
      data: {
        status: 'failed',
        failureReason: 'admin_reconciled_not_printed',
        completedAt: new Date('2026-08-06T10:00:00.000Z'),
      },
    });
    expect(result).toEqual({
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'not_printed',
      status: 'failed',
    });
  });

  it('returns an exact idempotent replay without a second mutation', async () => {
    const { service, prisma } = setup();
    const stored = {
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      status: 'submitted',
    } as const;
    prisma.palletPrintReconciliation.findUnique.mockResolvedValue({
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      reason: 'Этикетка видна',
      result: stored,
    });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).resolves.toEqual(stored);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['another job', 'pallet-job-2', 'label_observed' as const, 'Этикетка видна'],
    ['another outcome', 'pallet-job-1', 'not_printed' as const, 'Этикетка видна'],
    ['another reason', 'pallet-job-1', 'label_observed' as const, 'Этикетка не видна'],
  ])('rejects operation-key reuse for %s', async (_case, jobId, outcome, reason) => {
    const { service, prisma } = setup();
    prisma.palletPrintReconciliation.findUnique.mockResolvedValue({
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      reason: 'Этикетка видна',
      result: {},
    });

    await expect(
      service.reconcile(actor, jobId, {
        operationKey,
        outcome,
        reason,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_PALLET_PRINT_RECONCILIATION_KEY_CONFLICT' }),
    });
  });

  it('allows only one immutable reconciliation per pallet print job', async () => {
    const { service, tx } = setup();
    tx.palletPrintReconciliation.findFirst.mockResolvedValue({
      operationKey: '76e1f0e5-7a2d-4c78-869d-752f23a15f6a',
      printJobId: 'pallet-job-1',
      outcome: 'label_observed',
      reason: 'Этикетка уже подтверждена',
      result: {},
    });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Вторая проверка противоречит первой',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_ALREADY_RESOLVED',
      }),
    });
    expect(tx.palletPrintJob.update).not.toHaveBeenCalled();
  });

  it('reports an already committed different-key decision as already resolved', async () => {
    const { service, tx, job } = setup();
    tx.palletPrintJob.findUnique.mockResolvedValue({ ...job, status: 'submitted' });
    tx.palletPrintReconciliation.findFirst.mockResolvedValue({
      operationKey: '76e1f0e5-7a2d-4c78-869d-752f23a15f6a',
    });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Вторая проверка противоречит первой',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_ALREADY_RESOLVED',
      }),
    });
    expect(tx.palletPrintJob.update).not.toHaveBeenCalled();
  });

  it('locks document before print job and revalidates the locked state', async () => {
    const { service, tx, job } = setup();
    tx.palletPrintJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, status: 'submitted' });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_INVALID_STATE',
      }),
    });
    const lockedTables = tx.$queryRaw.mock.calls.map((call) =>
      (call[0] as { strings: string[] }).strings.join(' '),
    );
    expect(lockedTables).toHaveLength(2);
    expect(lockedTables[0]).toContain('pallet_list_documents');
    expect(lockedTables[1]).toContain('pallet_print_jobs');
    expect(tx.palletPrintJob.update).not.toHaveBeenCalled();
  });

  it('retries PostgreSQL serialization conflicts once and then succeeds', async () => {
    const { service, prisma, tx } = setup();
    const serializationFailure = new Prisma.PrismaClientKnownRequestError(
      'could not serialize access due to concurrent update',
      {
        code: 'P2010',
        clientVersion: '6.19.3',
        meta: { code: '40001', message: 'could not serialize access due to concurrent update' },
      },
    );
    prisma.$transaction
      .mockRejectedValueOnce(serializationFailure)
      .mockImplementationOnce((work) => work(tx));

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).resolves.toMatchObject({ status: 'submitted' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns an exact concurrent replay after an operation-key unique conflict', async () => {
    const { service, prisma } = setup();
    const stored = {
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      status: 'submitted',
    } as const;
    const uniqueConflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    prisma.$transaction.mockRejectedValue(uniqueConflict);
    prisma.palletPrintReconciliation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      operationKey,
      printJobId: 'pallet-job-1',
      palletListDocumentId: 'pallet-list-1',
      outcome: 'label_observed',
      reason: 'Этикетка видна',
      result: stored,
    });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).resolves.toEqual(stored);
  });

  it('maps a different-key one-job unique conflict to an immutable resolution conflict', async () => {
    const { service, prisma } = setup();
    const uniqueConflict = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    prisma.$transaction.mockRejectedValue(uniqueConflict);
    prisma.palletPrintReconciliation.findFirst.mockResolvedValue({
      operationKey: '76e1f0e5-7a2d-4c78-869d-752f23a15f6a',
    });

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетка не вышла',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_ALREADY_RESOLVED',
      }),
    });
  });

  it('returns a stable conflict after two serialization failures', async () => {
    const { service, prisma } = setup();
    const serializationFailure = new Prisma.PrismaClientKnownRequestError(
      'could not serialize access due to concurrent update',
      {
        code: 'P2010',
        clientVersion: '6.19.3',
        meta: { code: '40001', message: 'could not serialize access due to concurrent update' },
      },
    );
    prisma.$transaction.mockRejectedValue(serializationFailure);

    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ADMIN_PALLET_PRINT_RECONCILIATION_CONCURRENT',
      }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('requires a durable admin identity and an unresolved delivery state', async () => {
    const { service, tx, job } = setup();
    await expect(
      service.reconcile({ ...actor, userId: null }, 'pallet-job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетки нет',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    tx.palletPrintJob.findUnique.mockResolvedValue({ ...job, status: 'submitted' });
    await expect(
      service.reconcile(actor, 'pallet-job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетки нет',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
