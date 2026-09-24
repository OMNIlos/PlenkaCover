import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  assignmentCancellationFingerprintInput,
  ProductionAssignmentCancellationService,
} from './production-assignment-cancellation.service';

const actor = { userId: 'production-user', role: 'production_lead' as const };
const operationKey = '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79';
const dto = {
  operationKey,
  reason: 'Оператор назначен на другой пост',
};

function untouchedDispatch(id: string) {
  return {
    id,
    status: 'assigned',
    completedAt: null,
    coverageFactId: null,
    operatorLine: null,
  };
}

function setup() {
  let command: Record<string, unknown> | null = null;
  const assignment = {
    id: 'assignment-1',
    shiftId: 'shift-1',
    operatorId: 'operator-1',
    postId: 'post-1',
    status: 'planned',
    lockedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    shift: { id: 'shift-1', status: 'planned' },
  };
  let dispatchItems = [untouchedDispatch('dispatch-2'), untouchedDispatch('dispatch-1')];
  const tx: any = {
    $queryRaw: jest.fn().mockImplementation(async (query: { strings?: readonly string[] }) =>
      query.strings?.join('').includes('roll_dispatch_items')
        ? dispatchItems
            .map(({ id }) => ({ id }))
            .sort((left, right) => left.id.localeCompare(right.id))
        : [],
    ),
    operatorShiftMachineAssignment: {
      findUnique: jest.fn().mockResolvedValue(assignment),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorShiftMachineAssignmentCancellationCommand: {
      createMany: jest.fn().mockImplementation(async ({ data }: { data: any[] }) => {
        if (command) return { count: 0 };
        command = { id: 'command-1', result: null, ...data[0] };
        return { count: 1 };
      }),
      findUnique: jest.fn().mockImplementation(async () => command),
      update: jest.fn().mockImplementation(async ({ data }: { data: any }) => {
        if (command) command = { ...command, ...data };
        return command;
      }),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    rollDispatchItem: {
      findMany: jest
        .fn()
        .mockImplementation(async () =>
          [...dispatchItems].sort((left, right) => left.id.localeCompare(right.id)),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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
  const service = new ProductionAssignmentCancellationService(prisma as never, audit as never);
  return {
    assignment,
    audit,
    service,
    setDispatchItems: (rows: ReturnType<typeof untouchedDispatch>[]) => {
      dispatchItems = rows;
    },
    tx,
  };
}

describe('ProductionAssignmentCancellationService', () => {
  it('cancels an untouched planned assignment and releases only its future dispatch rows', async () => {
    const { audit, service, tx } = setup();

    await expect(service.cancel(actor, 'shift-1', 'assignment-1', dto)).resolves.toEqual({
      commandId: 'command-1',
      assignmentId: 'assignment-1',
      shiftId: 'shift-1',
      status: 'cancelled',
      releasedDispatchItemIds: ['dispatch-1', 'dispatch-2'],
      shiftClosed: false,
    });
    expect(tx.rollDispatchItem.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.rollDispatchItem.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'dispatch-1',
        status: 'assigned',
        assignedOperatorId: 'operator-1',
        plannedShiftId: 'shift-1',
        postId: 'post-1',
      },
      data: {
        assignedOperatorId: null,
        postId: null,
        machineId: null,
        workplaceId: null,
        plannedShiftId: null,
        status: 'new',
      },
    });
    expect(tx.operatorShiftMachineAssignment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'assignment-1',
        shiftId: 'shift-1',
        status: 'planned',
        lockedAt: null,
      },
      data: {
        status: 'cancelled',
        cancelledAt: expect.any(Date),
        cancellationReason: dto.reason,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_shift_machine_assignment_cancelled',
        objectId: 'assignment-1',
        reason: dto.reason,
      }),
      tx,
    );
  });

  it('rejects cancellation after any operator post session exists', async () => {
    const { service, tx } = setup();
    tx.operatorPostSession.findFirst.mockResolvedValue({ id: 'session-1', status: 'closed' });

    await expect(service.cancel(actor, 'shift-1', 'assignment-1', dto)).rejects.toMatchObject({
      response: { code: 'MACHINE_ASSIGNMENT_ALREADY_STARTED' },
    });
    expect(tx.rollDispatchItem.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['weight', { ...untouchedDispatch('dispatch-1'), operatorLine: { spoolKg: 2 } }],
    [
      'operation',
      {
        ...untouchedDispatch('dispatch-1'),
        operatorLine: {
          spoolKg: null,
          grossKg: null,
          netKg: null,
          warehouseState: 'not_ready',
          weightCaptures: [],
          labelJobs: [],
          operations: [{ id: 'operation-1' }],
        },
      },
    ],
    ['completed status', { ...untouchedDispatch('dispatch-1'), status: 'done' }],
  ])('preserves physical facts and rejects cancellation with %s', async (_name, row) => {
    const { service, setDispatchItems, tx } = setup();
    setDispatchItems([row as ReturnType<typeof untouchedDispatch>]);

    await expect(service.cancel(actor, 'shift-1', 'assignment-1', dto)).rejects.toMatchObject({
      response: { code: 'MACHINE_ASSIGNMENT_HAS_PHYSICAL_FACTS' },
    });
    expect(tx.rollDispatchItem.updateMany).not.toHaveBeenCalled();
  });

  it('replays the same operation key without repeating mutations', async () => {
    const { audit, service, tx } = setup();

    const [first, second] = await Promise.all([
      service.cancel(actor, 'shift-1', 'assignment-1', dto),
      service.cancel(actor, 'shift-1', 'assignment-1', dto),
    ]);

    expect(second).toEqual(first);
    expect(tx.operatorShiftMachineAssignment.updateMany).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an operation key with a different reason', async () => {
    const { service, tx } = setup();
    tx.operatorShiftMachineAssignmentCancellationCommand.createMany.mockResolvedValue({ count: 0 });
    tx.operatorShiftMachineAssignmentCancellationCommand.findUnique.mockResolvedValue({
      id: 'command-existing',
      assignmentId: 'assignment-1',
      operationKey,
      requestFingerprint: requestFingerprint(
        assignmentCancellationFingerprintInput('shift-1', 'assignment-1', {
          operationKey,
          reason: 'Другая причина',
        }),
      ),
      result: null,
    });

    await expect(service.cancel(actor, 'shift-1', 'assignment-1', dto)).rejects.toMatchObject({
      response: { code: 'MACHINE_ASSIGNMENT_CANCELLATION_OPERATION_KEY_CONFLICT' },
    });
    expect(tx.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
  });
});
