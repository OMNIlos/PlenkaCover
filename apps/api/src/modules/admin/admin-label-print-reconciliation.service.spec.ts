import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminLabelPrintReconciliationService } from './admin-label-print-reconciliation.service';

const actor = { userId: 'admin-1', role: 'admin' as const };
const operationKey = '6ae53c5c-8649-44b9-aeb7-32ebeadc4937';

function setup() {
  const job = {
    id: 'job-1',
    status: 'delivery_unknown',
    postId: 'post-1',
    operatorRollLineId: 'line-1',
    line: {
      id: 'line-1',
      step: 'qr_print',
      labelState: 'delivery_unknown',
      warehouseState: 'not_ready',
      rollDispatchItem: { id: 'dispatch-1', rollCode: 'ROLL-1', status: 'assigned' },
    },
  };
  const tx = {
    gatewayCommand: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    labelPrintReconciliation: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data })),
    },
    labelPrintJob: {
      findUnique: jest.fn().mockResolvedValue(job),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(undefined),
    },
    post: { findUnique: jest.fn().mockResolvedValue({ id: 'post-1' }) },
    operatorRollLine: { update: jest.fn().mockResolvedValue(undefined) },
    operatorRollOperation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    domainEvent: { create: jest.fn() },
  };
  const prisma = {
    labelPrintReconciliation: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((work) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new AdminLabelPrintReconciliationService(prisma as never, audit as never);
  return { service, prisma, tx, audit, job };
}

describe('AdminLabelPrintReconciliationService', () => {
  it('rejects a physical decision while the exact gateway command is still active', async () => {
    const { service, tx, audit } = setup();
    tx.gatewayCommand.findFirst.mockResolvedValue({ id: 'active-command' });
    await expect(service.reconcile(actor, 'job-1', { operationKey, outcome: 'not_printed', reason: 'Проверили принтер' }))
      .rejects.toMatchObject({ response: { code: 'ADMIN_PRINT_COMMAND_IN_PROGRESS' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records an observed label and advances the line to exact-QR verification', async () => {
    const { service, tx, audit } = setup();

    const result = await service.reconcile(actor, 'job-1', {
      operationKey,
      outcome: 'label_observed',
      reason: 'Этикетка фактически вышла из принтера',
    });

    expect(tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'submitted',
        failureReason: 'admin_reconciled_label_observed',
      }),
    });
    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { step: 'qr_check', labelState: 'submitted' },
    });
    expect(tx.operatorRollOperation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        labelPrintJob: { id: 'job-1' }, errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
      }),
      data: expect.objectContaining({ status: 'succeeded', errorCode: null, resultStep: 'qr_check' }),
    });
    expect(tx.labelPrintReconciliation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationKey,
        printJobId: 'job-1',
        outcome: 'label_observed',
        actorId: 'admin-1',
        postId: 'post-1',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_label_print_reconciled',
        objectId: 'ROLL-1',
        reason: 'Этикетка фактически вышла из принтера',
      }),
      tx,
    );
    expect(result).toEqual({
      operationKey,
      printJobId: 'job-1',
      rollCode: 'ROLL-1',
      outcome: 'label_observed',
      step: 'qr_check',
      labelState: 'submitted',
    });
    expect(JSON.stringify(result)).not.toContain('prt_');
  });

  it('restores an unprinted first label without classifying it as a reprint', async () => {
    const { service, tx } = setup();

    const result = await service.reconcile(actor, 'job-1', {
      operationKey,
      outcome: 'not_printed',
      reason: 'Принтер пуст, этикетка не выходила',
    });

    expect(tx.labelPrintJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'failed',
        failureReason: 'admin_reconciled_not_printed',
      }),
    });
    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { step: 'qr_print', labelState: 'not_printed' },
    });
    expect(result).toMatchObject({ step: 'qr_print', labelState: 'not_printed' });
  });

  it('keeps a genuine reprint when an earlier label was submitted', async () => {
    const { service, tx, job } = setup();
    tx.labelPrintJob.findUnique.mockResolvedValue({
      ...job,
      line: { ...job.line, step: 'handover' },
    });
    tx.labelPrintJob.findFirst.mockResolvedValue({ id: 'job-previous' });

    const result = await service.reconcile(actor, 'job-1', {
      operationKey,
      outcome: 'not_printed',
      reason: 'Повторная этикетка не вышла',
    });

    expect(tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1' },
      data: { step: 'handover', labelState: 'reprint_requested' },
    });
    expect(result).toMatchObject({ step: 'handover', labelState: 'reprint_requested' });
  });

  it('locks Post, roll dispatch, print job and line in physical-finalization order', async () => {
    const { service, tx } = setup();

    await service.reconcile(actor, 'job-1', {
      operationKey,
      outcome: 'label_observed',
      reason: 'Этикетка видна',
    });

    const lockedTables = tx.$queryRaw.mock.calls.map((call) =>
      (call[0] as { strings: string[] }).strings.join(' '),
    );
    expect(lockedTables).toHaveLength(4);
    expect(lockedTables[0]).toContain('posts');
    expect(lockedTables[1]).toContain('roll_dispatch_items');
    expect(lockedTables[2]).toContain('label_print_jobs');
    expect(lockedTables[3]).toContain('operator_roll_lines');
  });

  it('fails closed when the job moves to another post before locked revalidation', async () => {
    const { service, tx, job } = setup();
    tx.labelPrintJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce({ ...job, postId: 'post-2' });

    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_LABEL_RECONCILIATION_INVALID_STATE' }),
    });
    expect(tx.labelPrintJob.update).not.toHaveBeenCalled();
    expect(tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('retries PostgreSQL 40001 surfaced by a raw FOR UPDATE as Prisma P2010', async () => {
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
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).resolves.toMatchObject({ printJobId: 'job-1', labelState: 'submitted' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns a stable conflict when both serialization attempts fail', async () => {
    const { service, prisma } = setup();
    const rawSerializationFailure = new Prisma.PrismaClientKnownRequestError(
      'could not serialize access due to concurrent update',
      {
        code: 'P2010',
        clientVersion: '6.19.3',
        meta: { code: '40001', message: 'could not serialize access due to concurrent update' },
      },
    );
    const prismaSerializationFailure = new Prisma.PrismaClientKnownRequestError(
      'Transaction failed due to a write conflict or a deadlock',
      { code: 'P2034', clientVersion: '6.19.3' },
    );
    prisma.$transaction
      .mockRejectedValueOnce(rawSerializationFailure)
      .mockRejectedValueOnce(prismaSerializationFailure);

    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_LABEL_RECONCILIATION_CONCURRENT' }),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('returns the committed exact replay when a serialization retry sees an already-reconciled job', async () => {
    const { service, prisma, tx, job } = setup();
    const stored = {
      operationKey,
      printJobId: 'job-1',
      rollCode: 'ROLL-1',
      outcome: 'label_observed',
      step: 'qr_check',
      labelState: 'submitted',
    } as const;
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
      .mockImplementationOnce((work) => {
        tx.labelPrintJob.findUnique.mockResolvedValueOnce({ ...job, status: 'submitted' });
        tx.labelPrintReconciliation.findUnique.mockResolvedValueOnce({
          operationKey,
          printJobId: 'job-1',
          outcome: 'label_observed',
          reason: 'Этикетка видна',
          result: stored,
        });
        return work(tx);
      });

    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'label_observed',
        reason: 'Этикетка видна',
      }),
    ).resolves.toEqual(stored);
    expect(tx.labelPrintJob.update).not.toHaveBeenCalled();
    expect(tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('returns an exact idempotent replay without a second mutation', async () => {
    const { service, prisma, tx } = setup();
    const result = {
      operationKey,
      printJobId: 'job-1',
      rollCode: 'ROLL-1',
      outcome: 'not_printed',
      step: 'qr_print',
      labelState: 'not_printed',
    };
    prisma.labelPrintReconciliation.findUnique.mockResolvedValue({
      operationKey,
      printJobId: 'job-1',
      outcome: 'not_printed',
      reason: 'Этикетка не вышла',
      result,
    });

    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетка не вышла',
      }),
    ).resolves.toEqual(result);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.labelPrintJob.update).not.toHaveBeenCalled();
  });

  it('rejects operation-key reuse with a different intent', async () => {
    const { service, prisma } = setup();
    prisma.labelPrintReconciliation.findUnique.mockResolvedValue({
      operationKey,
      printJobId: 'job-1',
      outcome: 'label_observed',
      reason: 'Этикетка видна',
      result: {},
    });

    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетки нет',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires a durable user identity and an unresolved print state', async () => {
    const { service, tx, job } = setup();
    await expect(
      service.reconcile({ ...actor, userId: null }, 'job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетки нет',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    tx.labelPrintJob.findUnique.mockResolvedValue({ ...job, status: 'submitted' });
    await expect(
      service.reconcile(actor, 'job-1', {
        operationKey,
        outcome: 'not_printed',
        reason: 'Этикетки нет',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
