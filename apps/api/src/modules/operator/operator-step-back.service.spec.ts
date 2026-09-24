import { ConflictException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OperatorOperationService } from './operator-operation.service';
import { OperatorRollOwnershipService } from './operator-roll-ownership.service';
import { OperatorStepBackService } from './operator-step-back.service';

const actor = { userId: 'operator-a', role: 'operator' as const };
const operationKey = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-a',
    step: 'qr_print',
    labelState: 'not_printed',
    warehouseState: 'not_ready',
    spoolKg: 1.2,
    grossKg: 11.2,
    netKg: 10,
    toleranceOk: true,
    rollDispatchItem: {
      status: 'assigned',
      rollCode: 'ROLL-001',
    },
    ...overrides,
  };
}

function setup(lineSnapshot = line()) {
  const tx = {
    operatorRollLine: {
      update: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({
          ...lineSnapshot,
          ...data,
        }),
      ),
    },
    labelPrintJob: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    weightCapture: {
      update: jest.fn(),
      delete: jest.fn(),
    },
  } as any;
  const prisma = {
    $transaction: jest.fn().mockImplementation((operation) => operation(tx)),
  } as unknown as PrismaService;
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-a' }),
  } as unknown as AuditService;
  const ownership = {
    lockOwned: jest.fn().mockResolvedValue({
      session: { id: 'session-a', postId: 'post-a' },
      line: lineSnapshot,
    }),
  } as unknown as OperatorRollOwnershipService;
  const operations = {
    claim: jest.fn().mockResolvedValue({
      kind: 'claimed',
      operation: { id: 'operation-a' },
      recoveryFromId: null,
    }),
    assertNoPhysicalOperationInProgress: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
  } as unknown as OperatorOperationService;
  const service = new OperatorStepBackService(prisma, audit, ownership, operations);
  return {
    service,
    tx,
    prisma,
    audit: audit as unknown as { record: jest.Mock },
    ownership: ownership as unknown as { lockOwned: jest.Mock },
    operations: operations as unknown as {
      claim: jest.Mock;
      assertNoPhysicalOperationInProgress: jest.Mock;
      complete: jest.Mock;
    },
  };
}

describe('OperatorStepBackService', () => {
  it('reopens spool weight without changing append-only captures', async () => {
    const context = setup(
      line({
        step: 'roll_weight',
        spoolKg: 1.25,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      }),
    );

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).resolves.toEqual({
      rollCode: 'ROLL-001',
      previousStep: 'roll_weight',
      step: 'spool_weight',
    });
    expect(context.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: {
        step: 'spool_weight',
        spoolKg: null,
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    expect(context.tx.weightCapture.update).not.toHaveBeenCalled();
    expect(context.tx.weightCapture.delete).not.toHaveBeenCalled();
  });

  it('reopens roll weight while preserving the current spool projection', async () => {
    const context = setup();

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).resolves.toEqual({
      rollCode: 'ROLL-001',
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
    expect(context.tx.operatorRollLine.update).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      data: {
        step: 'roll_weight',
        grossKg: null,
        netKg: null,
        toleranceOk: null,
      },
    });
    expect(context.tx.operatorRollLine.update.mock.calls[0][0].data).not.toHaveProperty(
      'spoolKg',
    );
  });

  it('records one append-only correction event with old and new projections', async () => {
    const context = setup();

    await context.service.stepBack(actor, 'ROLL-001', { operationKey });

    expect(context.audit.record).toHaveBeenCalledWith(
      {
        type: 'audit:operator_roll_step_reopened',
        actorRole: 'operator',
        actorId: 'operator-a',
        objectId: 'ROLL-001',
        oldValue: {
          step: 'qr_print',
          spoolKg: 1.2,
          grossKg: 11.2,
          netKg: 10,
          toleranceOk: true,
          labelState: 'not_printed',
        },
        newValue: {
          step: 'roll_weight',
          spoolKg: 1.2,
          grossKg: null,
          netKg: null,
          toleranceOk: null,
          labelState: 'not_printed',
        },
        reason: 'operator_accidental_touch_correction',
        detail: {
          operationId: 'operation-a',
          operationKey,
          postId: 'post-a',
          sessionId: 'session-a',
        },
      },
      context.tx,
    );
    expect(context.operations.complete).toHaveBeenCalledWith(
      context.tx,
      'operation-a',
      {
        resultStep: 'roll_weight',
        httpStatus: 200,
      },
    );
  });

  it('replays the stored successful transition without a second mutation or event', async () => {
    const context = setup();
    context.operations.claim.mockResolvedValueOnce({
      kind: 'replay',
      operation: {
        id: 'operation-a',
        expectedStep: 'qr_print',
        resultStep: 'roll_weight',
      },
    });

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).resolves.toEqual({
      rollCode: 'ROLL-001',
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
    expect(context.audit.record).not.toHaveBeenCalled();
    expect(context.operations.complete).not.toHaveBeenCalled();
  });

  it('rejects a step that has no safe predecessor', async () => {
    const context = setup(line({ step: 'qr_check' }));

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_STEP_CONFLICT' }),
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('rejects return after a print job has been created', async () => {
    const context = setup();
    context.tx.labelPrintJob.findFirst.mockResolvedValueOnce({ id: 'print-job-a' });

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_STEP_BACK_PRINT_STARTED',
      }),
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('rejects return after label state leaves not_printed', async () => {
    const context = setup(line({ labelState: 'submitted' }));

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_STEP_BACK_PRINT_STARTED',
      }),
    });
    expect(context.tx.labelPrintJob.findFirst).not.toHaveBeenCalled();
  });

  it('reports the irreversible print boundary after the line advanced to QR check', async () => {
    const context = setup(
      line({
        step: 'qr_check',
        labelState: 'submitted',
      }),
    );

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_STEP_BACK_PRINT_STARTED',
      }),
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('rejects return while a physical operation is in progress', async () => {
    const context = setup();
    context.operations.assertNoPhysicalOperationInProgress.mockRejectedValueOnce(
      new ConflictException({
        code: 'OPERATOR_PHYSICAL_OPERATION_IN_PROGRESS',
        message: 'busy',
      }),
    );

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_PHYSICAL_OPERATION_IN_PROGRESS',
      }),
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('rejects a terminal dispatch before changing its roll projection', async () => {
    const context = setup(
      line({
        rollDispatchItem: {
          status: 'done',
          rollCode: 'ROLL-001',
        },
      }),
    );

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_DISPATCH_TERMINAL',
      }),
    });
    expect(context.tx.operatorRollLine.update).not.toHaveBeenCalled();
  });

  it('preserves ownership and active-session failures', async () => {
    const context = setup();
    context.ownership.lockOwned.mockRejectedValueOnce(
      new ConflictException({
        code: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
        message: 'session required',
      }),
    );

    await expect(
      context.service.stepBack(actor, 'ROLL-001', { operationKey }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
      }),
    });
    expect(context.operations.claim).not.toHaveBeenCalled();
  });
});
