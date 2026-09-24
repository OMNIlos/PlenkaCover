import { Prisma } from '@prisma/client';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import type { PaymentCorrectionDto } from './dto/payment-correction.dto';
import { PaymentCorrectionService } from './payment-correction.service';

const actor = { userId: 'finance-user', role: 'finance' as const };
const operationKey = '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79';
const productionClearedAt = new Date('2026-08-04T08:00:00.000Z');

function dto(
  target: PaymentCorrectionDto['target'],
  expectedPaymentStatus: PaymentCorrectionDto['expectedPaymentStatus'] = 'paid',
): PaymentCorrectionDto {
  return {
    operationKey,
    target,
    expectedPaymentStatus,
    reason: 'Исправление ошибочного подтверждения',
  };
}

function setup() {
  let command: Record<string, unknown> | null = null;
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'finance-1' }]),
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'finance-1',
        commercialOrderId: 'order-1',
        paymentStatus: 'paid',
        productionClearedAt,
      }),
    },
    financePaymentCorrectionCommand: {
      createMany: jest.fn().mockImplementation(async ({ data }: { data: any[] }) => {
        if (command) return { count: 0 };
        command = { id: 'correction-1', result: null, ...data[0] };
        return { count: 1 };
      }),
      findUnique: jest.fn().mockImplementation(async () => command),
      update: jest.fn().mockImplementation(async ({ data }: { data: any }) => {
        if (command) command = { ...command, ...data };
        return command;
      }),
    },
    financePaymentUpdateCommand: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    paymentSchedule: {
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentOperation: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'reversal-1' }),
    },
  };
  let queue = Promise.resolve();
  const prisma = {
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => {
      const run = queue.then(() => work(tx));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const audit = { record: jest.fn() };
  const paymentState = {
    recompute: jest.fn().mockResolvedValue({
      paymentStatus: 'unpaid',
      productionClearedAt,
    }),
  };
  const service = new PaymentCorrectionService(
    prisma as never,
    audit as never,
    paymentState as never,
  );
  return { audit, paymentState, service, tx };
}

describe('PaymentCorrectionService', () => {
  it('restores an addressable status update and only its captured schedule transitions', async () => {
    const { audit, paymentState, service, tx } = setup();
    tx.financePaymentUpdateCommand.findUnique.mockResolvedValue({
      id: 'update-1',
      financeOrderId: 'finance-1',
      requestedStatus: 'paid',
      previousStatus: 'unpaid',
      createdAt: new Date('2026-08-04T09:00:00.000Z'),
      result: {
        scheduleTransitions: [
          { scheduleId: 'schedule-1', previousStatus: 'unpaid', requestedStatus: 'paid' },
        ],
      },
    });
    tx.financePaymentUpdateCommand.findFirst.mockResolvedValue(null);
    tx.paymentOperation.findFirst.mockResolvedValue(null);

    await expect(
      service.correct(actor, 'finance-1', dto({ kind: 'payment_update', id: 'update-1' })),
    ).resolves.toEqual({
      commandId: 'correction-1',
      targetKind: 'payment_update',
      targetId: 'update-1',
      reversalOperationId: null,
      paymentStatus: 'unpaid',
      productionClearedAt: productionClearedAt.toISOString(),
    });
    expect(tx.paymentSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'schedule-1',
        financeOrderId: 'finance-1',
        status: 'paid',
      },
      data: { status: 'unpaid' },
    });
    expect(tx.paymentOperation.create).not.toHaveBeenCalled();
    expect(paymentState.recompute).toHaveBeenCalledWith(tx, 'finance-1', 'unpaid');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:manual_payment_corrected',
        reason: 'Исправление ошибочного подтверждения',
      }),
      tx,
    );
  });

  it('reverses one selected manual schedule confirmation and derives the remaining state', async () => {
    const { paymentState, service, tx } = setup();
    tx.paymentSchedule.findFirst.mockResolvedValue({
      id: 'schedule-1',
      financeOrderId: 'finance-1',
      status: 'paid',
      source: 'payment_policy',
    });
    tx.paymentOperation.findFirst
      .mockResolvedValueOnce({
        id: 'payment-1',
        financeOrderId: 'finance-1',
        paymentScheduleId: 'schedule-1',
        amount: new Prisma.Decimal(500),
        source: 'manual_platform',
        reconciled: true,
        reversesOperationId: null,
        reversal: null,
        createdAt: new Date('2026-08-04T09:00:00.000Z'),
      })
      .mockResolvedValueOnce(null);
    paymentState.recompute.mockResolvedValue({
      paymentStatus: 'partial',
      productionClearedAt,
    });

    const result = await service.correct(
      actor,
      'finance-1',
      dto({ kind: 'schedule_confirmation', id: 'schedule-1' }),
    );

    expect(result.paymentStatus).toBe('partial');
    expect(tx.paymentOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        financeOrderId: 'finance-1',
        operationKey,
        operationType: 'manual_adjustment',
        amount: new Prisma.Decimal(-500),
        source: 'manual_platform',
        reconciled: true,
        reversesOperationId: 'payment-1',
        paymentScheduleId: 'schedule-1',
      }),
      select: { id: true },
    });
  });

  it('rejects a 1C operation without creating a false reversal', async () => {
    const { service, tx } = setup();
    tx.paymentOperation.findUnique.mockResolvedValue({
      id: 'onec-operation',
      financeOrderId: 'finance-1',
      paymentScheduleId: null,
      amount: new Prisma.Decimal(1000),
      source: '1C',
      reconciled: true,
      reversesOperationId: null,
      reversal: null,
      createdAt: new Date('2026-08-04T09:00:00.000Z'),
    });

    await expect(
      service.correct(actor, 'finance-1', dto({ kind: 'payment_operation', id: 'onec-operation' })),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_SOURCE_CORRECTION_REQUIRED' },
    });
    expect(tx.paymentOperation.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent exact retries into one reversal and one stored result', async () => {
    const { service, tx } = setup();
    tx.paymentOperation.findUnique.mockResolvedValue({
      id: 'manual-operation',
      financeOrderId: 'finance-1',
      paymentScheduleId: null,
      amount: new Prisma.Decimal(1000),
      source: 'manual_platform',
      reconciled: true,
      reversesOperationId: null,
      reversal: null,
      createdAt: new Date('2026-08-04T09:00:00.000Z'),
    });
    const input = dto({ kind: 'payment_operation', id: 'manual-operation' });

    const [first, second] = await Promise.all([
      service.correct(actor, 'finance-1', input),
      service.correct(actor, 'finance-1', input),
    ]);

    expect(second).toEqual(first);
    expect(tx.paymentOperation.create).toHaveBeenCalledTimes(1);
    expect(tx.financePaymentCorrectionCommand.update).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an operation key with different correction data', async () => {
    const { service, tx } = setup();
    tx.financePaymentCorrectionCommand.createMany.mockResolvedValue({ count: 0 });
    tx.financePaymentCorrectionCommand.findUnique.mockResolvedValue({
      id: 'correction-existing',
      financeOrderId: 'finance-1',
      operationKey,
      requestFingerprint: requestFingerprint({
        financeOrderId: 'finance-1',
        operationKey,
        target: { kind: 'payment_operation', id: 'different-operation' },
        expectedPaymentStatus: 'paid',
        reason: 'Другая причина',
      }),
      targetKind: 'payment_operation',
      targetId: 'different-operation',
      targetKey: 'finance-1:payment_operation:different-operation',
      result: null,
    });

    await expect(
      service.correct(
        actor,
        'finance-1',
        dto({ kind: 'payment_operation', id: 'manual-operation' }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PAYMENT_CORRECTION_OPERATION_KEY_CONFLICT' },
    });
    expect(tx.paymentOperation.create).not.toHaveBeenCalled();
  });
});
