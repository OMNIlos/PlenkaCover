import { ServiceUnavailableException } from '@nestjs/common';
import { ProductionShiftCommandService } from './production-shift-command.service';

const ACTOR = { userId: 'lead-1', role: 'production_lead' as const };
const CREATE_SHIFT = {
  operatorId: 'operator-1',
  postId: 'post-2',
  label: ' Ночная линия ',
  operationKey: '311f7d31-cf3d-4a51-af22-a961bc84e24a',
};

function assignedDispatch(
  id: string,
  assignedOperatorId = CREATE_SHIFT.operatorId,
  productionOrderId = 'production-order-1',
) {
  return {
    id,
    productionOrderId,
    assignedOperatorId,
    status: 'assigned',
    plannedShiftId: null,
    plannedShift: null,
  };
}

function setup() {
  const shift = {
    id: 'shift-1',
    label: 'Ночная линия',
    plannedStartAt: null,
    plannedEndAt: null,
    status: 'planned',
    operationKey: CREATE_SHIFT.operationKey,
  };
  const assignment = {
    id: 'assignment-1',
    shiftId: shift.id,
    operatorId: CREATE_SHIFT.operatorId,
    postId: CREATE_SHIFT.postId,
    status: 'planned',
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: CREATE_SHIFT.operatorId,
        displayName: 'Хабибулин Руслан',
        role: 'operator',
        isActive: true,
      }),
    },
    post: {
      findUnique: jest.fn().mockResolvedValue({
        id: CREATE_SHIFT.postId,
        code: 'POST-2',
        status: 'active',
      }),
    },
    shift: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(shift),
      update: jest.fn(),
    },
    operatorShiftMachineAssignment: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(assignment),
    },
    rollDispatchItem: {
      findMany: jest
        .fn()
        .mockResolvedValue([assignedDispatch('dispatch-2'), assignedDispatch('dispatch-1')]),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    operatorMachineChange: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    shiftBagUsage: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'usage-1',
        sessionId: 'session-1',
        endKg: null,
        closedAt: null,
      }),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockImplementation(({ where }: any) =>
        where.postId === 'post-2'
          ? null
          : {
              id: 'session-1',
              operatorId: CREATE_SHIFT.operatorId,
              postId: 'post-1',
              shiftId: shift.id,
              status: 'active',
            },
      ),
    },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const audit = { record: jest.fn() };
  const production = { publishProductionOrderWhenReady: jest.fn().mockResolvedValue(undefined) };
  const deviceReadiness = {
    require: jest.fn().mockResolvedValue({ ready: true, code: 'READY' }),
  };
  return {
    service: new ProductionShiftCommandService(
      prisma,
      audit as any,
      production as any,
      deviceReadiness as any,
    ),
    prisma,
    audit,
    production,
    deviceReadiness,
    shift,
    assignment,
  };
}

function setupFinalization(status: 'awaiting_final_weight' | 'ready' | 'completed') {
  const change = {
    id: 'change-1',
    assignmentId: 'assignment-1',
    shiftId: 'shift-1',
    operatorId: 'operator-1',
    fromPostId: 'post-1',
    toPostId: 'post-2',
    reason: 'Плановая переналадка',
    operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
    status,
    requestedAt: new Date('2026-07-27T09:00:00.000Z'),
    readyAt: status === 'ready' ? new Date('2026-07-27T09:01:00.000Z') : null,
    completedAt: status === 'completed' ? new Date('2026-07-27T09:02:00.000Z') : null,
    cancelledAt: null,
    updatedAt: new Date('2026-07-27T09:02:00.000Z'),
    fromPost: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1' },
    toPost: { id: 'post-2', code: 'POST-2', name: 'Экструдер 2' },
  };
  const session = {
    id: 'session-1',
    operatorId: 'operator-1',
    shiftId: 'shift-1',
    postId: 'post-1',
    status: 'active',
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    $transaction: jest.fn(),
    operatorMachineChange: {
      findUnique: jest.fn().mockResolvedValue(change),
      update: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ ...change, ...data })),
    },
    operatorShiftMachineAssignment: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'assignment-1',
        operatorId: 'operator-1',
        shiftId: 'shift-1',
        postId: 'post-1',
        status: 'locked',
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    post: {
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve({
          id: where.id,
          code: where.id === 'post-1' ? 'POST-1' : 'POST-2',
          status: 'active',
        }),
      ),
      update: jest.fn(),
    },
    operatorPostSession: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(where.postId === 'post-2' ? null : session),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    deviceRuntime: {
      findMany: jest.fn().mockResolvedValue([{ id: 'scale-1', status: 'ready' }]),
    },
    shiftBagUsage: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(
        status === 'awaiting_final_weight'
          ? [
              {
                id: 'usage-1',
                bigBagId: 'bag-1',
                bigBag: { id: 'bag-1', code: 'BAG-1', currentKg: 200 },
              },
            ]
          : [],
      ),
      update: jest.fn(),
    },
    bigBagUnit: { update: jest.fn() },
    rollDispatchItem: {
      findMany: jest.fn().mockResolvedValue([{ id: 'dispatch-1', rollCode: 'ROLL-1' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorRollLine: { update: jest.fn() },
    weightCapture: { update: jest.fn() },
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const audit = { record: jest.fn() };
  const production = { publishProductionOrderWhenReady: jest.fn().mockResolvedValue(undefined) };
  const deviceReadiness = {
    require: jest.fn().mockResolvedValue({ ready: true, code: 'READY' }),
  };
  const scale = {
    read: jest.fn().mockResolvedValue({
      deviceId: 'scale-1',
      status: 'ready',
      stable: true,
      grossKg: 175,
    }),
  };
  return {
    service: new ProductionShiftCommandService(
      prisma,
      audit as any,
      production as any,
      deviceReadiness as any,
      scale as any,
    ),
    prisma,
    audit,
    production,
    deviceReadiness,
    scale,
    change,
  };
}

function setupCancellation(
  status: 'requested' | 'awaiting_final_weight' | 'ready' | 'completed' | 'cancelled' = 'ready',
) {
  let change = {
    id: 'change-cancel',
    assignmentId: 'assignment-1',
    shiftId: 'shift-1',
    operatorId: 'operator-1',
    fromPostId: 'post-1',
    toPostId: 'post-2',
    reason: 'Плановая переналадка',
    operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
    status,
    requestedAt: new Date('2026-08-04T09:00:00.000Z'),
    readyAt: status === 'ready' ? new Date('2026-08-04T09:01:00.000Z') : null,
    completedAt: status === 'completed' ? new Date('2026-08-04T09:02:00.000Z') : null,
    cancelledAt: status === 'cancelled' ? new Date('2026-08-04T09:03:00.000Z') : null,
    cancelOperationKey: status === 'cancelled' ? '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79' : null,
    cancelRequestFingerprint: null as string | null,
    cancellationReason: status === 'cancelled' ? 'Назначение исправлено' : null,
    cancelledById: status === 'cancelled' ? ACTOR.userId : null,
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: change.id }]),
    $transaction: jest.fn(),
    operatorMachineChange: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.id) return where.id === change.id ? change : null;
        if (where.cancelOperationKey) {
          return where.cancelOperationKey === change.cancelOperationKey ? change : null;
        }
        return null;
      }),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (
          where.id !== change.id ||
          !where.status.in.includes(change.status) ||
          change.cancelOperationKey !== null
        ) {
          return { count: 0 };
        }
        change = { ...change, ...data };
        return { count: 1 };
      }),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    domainEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  let transactionQueue = Promise.resolve();
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => {
    const run = transactionQueue.then(() => callback(prisma));
    transactionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
  const audit = { record: jest.fn() };
  const production = { publishProductionOrderWhenReady: jest.fn() };
  const deviceReadiness = { require: jest.fn() };
  const service = new ProductionShiftCommandService(
    prisma,
    audit as any,
    production as any,
    deviceReadiness as any,
  );
  return {
    service,
    prisma,
    audit,
    current: () => change,
  };
}

describe('ProductionShiftCommandService', () => {
  it('builds an informative default label from the date, operator and post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T08:00:00.000Z'));
    try {
      const { service, prisma } = setup();

      await service.createIndividualShift(ACTOR, { ...CREATE_SHIFT, label: undefined });

      expect(prisma.shift.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          label: 'Смена 07.09.2026 · Хабибулин Руслан · POST-2',
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows another operator to plan the same post in a separate individual shift', async () => {
    const { service, prisma, assignment } = setup();
    prisma.operatorShiftMachineAssignment.findFirst.mockImplementation(
      async ({ where }: { where: { OR?: unknown } }) =>
        where.OR ? { id: 'other-planned-assignment' } : null,
    );

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toMatchObject({
      assignment,
    });
    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
  });

  it('plans an individual shift while the post equipment is temporarily unavailable', async () => {
    const { service, prisma, assignment, deviceReadiness } = setup();
    deviceReadiness.require.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'POST_DEVICE_NOT_READY',
        message: 'Требуемое оборудование поста сейчас недоступно.',
      }),
    );

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toMatchObject({
      assignment,
    });
    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
    expect(deviceReadiness.require).not.toHaveBeenCalled();
  });

  it('automatically attaches unfinished rows already assigned to the operator', async () => {
    const { service, prisma, audit, production, shift, assignment } = setup();

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toEqual({
      shift,
      assignment,
      dispatchItemIds: ['dispatch-1', 'dispatch-2'],
    });

    const operatorLock = prisma.$queryRaw.mock.calls[0][0] as { strings: readonly string[] };
    expect(operatorLock.strings.join('?')).toContain('FOR NO KEY UPDATE');
    expect(prisma.shift.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        plannedStartAt: null,
        plannedEndAt: null,
        operationKey: CREATE_SHIFT.operationKey,
      }),
    });
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shift: { status: { in: ['planned', 'open'] } },
        }),
      }),
    );
    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith({
      where: {
        assignedOperatorId: CREATE_SHIFT.operatorId,
        status: { notIn: ['done', 'ready_for_warehouse'] },
        plannedShiftId: null,
      },
      select: {
        id: true,
        productionOrderId: true,
      },
    });
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['dispatch-1', 'dispatch-2'] },
        assignedOperatorId: CREATE_SHIFT.operatorId,
        status: { notIn: ['done', 'ready_for_warehouse'] },
        plannedShiftId: null,
      },
      data: {
        assignedOperatorId: CREATE_SHIFT.operatorId,
        postId: CREATE_SHIFT.postId,
        machineId: 'POST-2',
        workplaceId: CREATE_SHIFT.postId,
        plannedShiftId: shift.id,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_shift_machine_assigned',
        objectId: assignment.id,
      }),
      prisma,
    );
    expect(prisma.shift.update).toHaveBeenCalledWith({
      where: { id: shift.id },
      data: {
        commandResult: {
          shift,
          assignment,
          dispatchItemIds: ['dispatch-1', 'dispatch-2'],
        },
      },
    });
    expect(production.publishProductionOrderWhenReady).toHaveBeenCalledWith(
      ACTOR,
      'production-order-1',
      {
        requireComplete: false,
      },
    );
  });

  it('prefers explicit unbound assignments over stale rolls from closed shifts', async () => {
    const { service, prisma } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([assignedDispatch('dispatch-selected')]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.createIndividualShift(ACTOR, CREATE_SHIFT);

    expect(result.dispatchItemIds).toEqual(['dispatch-selected']);
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ plannedShiftId: null }),
      }),
    );
    expect(prisma.rollDispatchItem.findMany.mock.calls[1][0].where).not.toHaveProperty(
      'plannedShift',
    );
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['dispatch-selected'] },
          plannedShiftId: null,
        }),
      }),
    );
  });

  it('carries closed-shift rolls when no explicit unbound assignment exists', async () => {
    const { service, prisma } = setup();
    const carried = {
      ...assignedDispatch('dispatch-carried'),
      plannedShiftId: 'closed-shift',
      plannedShift: { status: 'closed' },
    };
    prisma.rollDispatchItem.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([carried]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.createIndividualShift(ACTOR, CREATE_SHIFT);

    expect(result.dispatchItemIds).toEqual(['dispatch-carried']);
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ plannedShift: { status: 'closed' } }),
      }),
    );
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['dispatch-carried'] },
          plannedShift: { status: 'closed' },
        }),
      }),
    );
  });

  it('publishes affected orders only after the shift transaction releases its locks', async () => {
    const { service, prisma, production } = setup();
    let transactionOpen = false;
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      transactionOpen = true;
      try {
        return await callback(prisma);
      } finally {
        transactionOpen = false;
      }
    });
    production.publishProductionOrderWhenReady.mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
    });

    await service.createIndividualShift(ACTOR, CREATE_SHIFT);

    expect(production.publishProductionOrderWhenReady).toHaveBeenCalledTimes(1);
  });

  it('retries post-commit publication through an idempotent shift replay', async () => {
    const { service, prisma, production, shift, assignment } = setup();
    production.publishProductionOrderWhenReady
      .mockRejectedValueOnce(new Error('Publication unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).rejects.toThrow(
      'Publication unavailable',
    );

    const requestFingerprint = prisma.shift.create.mock.calls[0][0].data.requestFingerprint;
    prisma.shift.findUnique.mockResolvedValue({
      requestFingerprint,
      commandResult: { shift, assignment, dispatchItemIds: ['dispatch-1', 'dispatch-2'] },
    });

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toEqual({
      shift,
      assignment,
      dispatchItemIds: ['dispatch-1', 'dispatch-2'],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(production.publishProductionOrderWhenReady).toHaveBeenCalledTimes(2);
  });

  it('creates an empty individual shift without a browser-selected queue', async () => {
    const { service, prisma, production, shift, assignment } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toEqual({
      shift,
      assignment,
      dispatchItemIds: [],
    });

    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(production.publishProductionOrderWhenReady).not.toHaveBeenCalled();
  });

  it('rejects when an automatically selected assignment changes before the CAS update', async () => {
    const { service, prisma } = setup();
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).rejects.toThrow(
      /изменились во время/u,
    );
  });

  it('replays the same individual-shift key without a second transaction', async () => {
    const { service, prisma, shift, assignment } = setup();
    await service.createIndividualShift(ACTOR, CREATE_SHIFT);
    const requestFingerprint = prisma.shift.create.mock.calls[0][0].data.requestFingerprint;
    prisma.shift.findUnique.mockResolvedValue({
      requestFingerprint,
      commandResult: { shift, assignment, dispatchItemIds: ['dispatch-1', 'dispatch-2'] },
    });

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toEqual({
      shift,
      assignment,
      dispatchItemIds: ['dispatch-1', 'dispatch-2'],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('replays an identical command that committed while the request waited for shift locks', async () => {
    const { service, prisma, audit, shift, assignment } = setup();
    prisma.shift.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const first = await service.createIndividualShift(ACTOR, CREATE_SHIFT);
    const requestFingerprint = prisma.shift.create.mock.calls[0][0].data.requestFingerprint;
    prisma.shift.findUnique.mockResolvedValueOnce({
      requestFingerprint,
      commandResult: first,
    });

    await expect(service.createIndividualShift(ACTOR, CREATE_SHIFT)).resolves.toEqual({
      shift,
      assignment,
      dispatchItemIds: ['dispatch-1', 'dispatch-2'],
    });
    expect(prisma.shift.create).toHaveBeenCalledTimes(1);
    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects a reused individual-shift key with a different fingerprint', async () => {
    const { service, prisma, shift, assignment } = setup();
    await service.createIndividualShift(ACTOR, CREATE_SHIFT);
    const requestFingerprint = prisma.shift.create.mock.calls[0][0].data.requestFingerprint;
    prisma.shift.findUnique.mockResolvedValue({
      requestFingerprint,
      commandResult: { shift, assignment, dispatchItemIds: ['dispatch-1', 'dispatch-2'] },
    });

    await expect(
      service.createIndividualShift(ACTOR, { ...CREATE_SHIFT, label: 'Другая смена' }),
    ).rejects.toThrow(/operationKey/u);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a different command that reused the key while waiting for shift locks', async () => {
    const { service, prisma, audit } = setup();
    prisma.shift.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await service.createIndividualShift(ACTOR, CREATE_SHIFT);
    const requestFingerprint = prisma.shift.create.mock.calls[0][0].data.requestFingerprint;
    prisma.shift.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      requestFingerprint,
      commandResult: prisma.shift.update.mock.calls[0][0].data.commandResult,
    });

    await expect(
      service.createIndividualShift(ACTOR, { ...CREATE_SHIFT, label: 'Другая смена' }),
    ).rejects.toThrow(/operationKey/u);
    expect(prisma.shift.create).toHaveBeenCalledTimes(1);
    expect(prisma.operatorShiftMachineAssignment.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('persists a pending intentional move when the current BigBag lacks final evidence', async () => {
    const { service, prisma } = setup();
    prisma.operatorShiftMachineAssignment.findUnique = jest.fn().mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      postId: 'post-1',
      status: 'locked',
      post: { id: 'post-1', status: 'active' },
    });
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-2',
      code: 'POST-2',
      status: 'active',
    });
    prisma.operatorMachineChange.create.mockResolvedValue({
      id: 'change-1',
      assignmentId: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      fromPostId: 'post-1',
      toPostId: 'post-2',
      reason: 'Плановая переналадка',
      operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
      status: 'awaiting_final_weight',
    });

    await expect(
      service.requestMachineChange(ACTOR, 'assignment-1', {
        postId: 'post-2',
        reason: 'Плановая переналадка',
        operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
      }),
    ).resolves.toMatchObject({
      id: 'change-1',
      status: 'awaiting_final_weight',
    });

    expect(prisma.operatorMachineChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assignmentId: 'assignment-1',
        status: 'awaiting_final_weight',
      }),
    });
  });

  it('marks an intentional move ready immediately when the active session has no BigBag', async () => {
    const { service, prisma, audit } = setup();
    prisma.operatorShiftMachineAssignment.findUnique = jest.fn().mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      postId: 'post-1',
      status: 'locked',
    });
    prisma.shiftBagUsage.findFirst.mockResolvedValue(null);
    prisma.operatorMachineChange.create.mockResolvedValue({
      id: 'change-ready',
      assignmentId: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      fromPostId: 'post-1',
      toPostId: 'post-2',
      reason: 'Плановая переналадка',
      operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
      status: 'ready',
    });

    await expect(
      service.requestMachineChange(ACTOR, 'assignment-1', {
        postId: 'post-2',
        reason: 'Плановая переналадка',
        operationKey: '7124a05d-b66e-4118-8652-fc00c8281caf',
      }),
    ).resolves.toMatchObject({ status: 'ready' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_machine_change_ready' }),
      prisma,
    );
  });

  it('finalizes with stable BigBag evidence without marking the healthy source post broken', async () => {
    const { service, prisma, audit, scale } = setupFinalization('awaiting_final_weight');

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).resolves.toMatchObject({ status: 'completed' });

    expect(prisma.shiftBagUsage.update).toHaveBeenCalledWith({
      where: { id: 'usage-1' },
      data: { endKg: 175, closedAt: expect.any(Date) },
    });
    expect(scale.read).toHaveBeenCalledWith(
      {
        deviceId: 'scale-1',
        expectedPostId: 'post-1',
        expectedKind: 'scale',
      },
      'control',
    );
    expect(prisma.operatorShiftMachineAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          previousPostId: 'post-1',
          postId: 'post-2',
        }),
      }),
    );
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ['ready_for_warehouse', 'done'] },
        }),
        data: {
          postId: 'post-2',
          workplaceId: 'post-2',
          machineId: 'POST-2',
        },
      }),
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.update).not.toHaveBeenCalled();
    expect(prisma.weightCapture.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:operator_machine_change_completed',
        objectId: 'assignment-1',
      }),
      prisma,
    );
  });

  it('rejects finalization by a different operator', async () => {
    const { service, prisma } = setupFinalization('ready');

    await expect(
      service.finalizeMachineChange({ userId: 'operator-2', role: 'operator' }, 'change-1'),
    ).rejects.toThrow(/назначенный оператор/u);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an unstable BigBag final reading without mutating the move', async () => {
    const { service, prisma, scale } = setupFinalization('awaiting_final_weight');
    scale.read.mockResolvedValue({
      deviceId: 'scale-1',
      status: 'ready',
      stable: false,
      grossKg: 175,
    });

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).rejects.toThrow(/стабильный/u);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
  });

  it('requires an explicit BigBag when multiple usages are open', async () => {
    const { service, prisma, scale } = setupFinalization('awaiting_final_weight');
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        bigBag: { id: 'bag-1', code: 'BAG-1', currentKg: 200 },
      },
      {
        id: 'usage-2',
        bigBagId: 'bag-2',
        bigBag: { id: 'bag-2', code: 'BAG-2', currentKg: 300 },
      },
    ]);

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).rejects.toThrow(/Укажите Big-Bag/u);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(scale.read).not.toHaveBeenCalled();
    expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
  });

  it('records only the selected BigBag and keeps the move pending for the remaining bag', async () => {
    const { service, prisma, audit } = setupFinalization('awaiting_final_weight');
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        bigBag: { id: 'bag-1', code: 'BAG-1', currentKg: 200 },
      },
      {
        id: 'usage-2',
        bigBagId: 'bag-2',
        bigBag: { id: 'bag-2', code: 'BAG-2', currentKg: 300 },
      },
    ]);

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1', {
        bigBagId: 'bag-1',
      }),
    ).resolves.toEqual({
      changeId: 'change-1',
      status: 'awaiting_final_weight',
      remainingBigBags: [{ id: 'bag-2', code: 'BAG-2' }],
      completedAt: null,
    });

    expect(prisma.shiftBagUsage.update).toHaveBeenCalledWith({
      where: { id: 'usage-1' },
      data: { endKg: 175, closedAt: expect.any(Date) },
    });
    expect(prisma.bigBagUnit.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bag-1' } }),
    );
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:bigbag_weight_recorded',
        objectId: 'BAG-1',
      }),
      prisma,
    );
  });

  it('never attributes captured evidence to a different BigBag after a concurrent close', async () => {
    const { service, prisma, scale } = setupFinalization('awaiting_final_weight');
    const bothUsages = [
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        bigBag: { id: 'bag-1', code: 'BAG-1', currentKg: 200 },
      },
      {
        id: 'usage-2',
        bigBagId: 'bag-2',
        bigBag: { id: 'bag-2', code: 'BAG-2', currentKg: 300 },
      },
    ];
    const secondUsage = [bothUsages[1]];
    prisma.shiftBagUsage.findMany
      .mockResolvedValueOnce(bothUsages)
      .mockResolvedValueOnce(bothUsages)
      .mockResolvedValueOnce(secondUsage)
      .mockResolvedValueOnce(secondUsage);

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1', {
        bigBagId: 'bag-1',
      }),
    ).resolves.toEqual({
      changeId: 'change-1',
      status: 'awaiting_final_weight',
      remainingBigBags: [{ id: 'bag-2', code: 'BAG-2' }],
      completedAt: null,
    });

    expect(scale.read).toHaveBeenCalledTimes(1);
    expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
    expect(prisma.bigBagUnit.update).not.toHaveBeenCalled();
  });

  it('replays a completed finalization without duplicate events', async () => {
    const { service, prisma, audit } = setupFinalization('completed');

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps a ready change pending when a BigBag opens after the request', async () => {
    const { service, prisma } = setupFinalization('ready');
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'late-usage',
        bigBagId: 'late-bag',
        bigBag: { id: 'late-bag', code: 'LATE-BAG', currentKg: 250 },
      },
    ]);

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).resolves.toMatchObject({ status: 'awaiting_final_weight' });

    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorMachineChange.update).toHaveBeenCalledWith({
      where: { id: 'change-1' },
      data: { status: 'awaiting_final_weight', readyAt: null },
    });
  });

  it('moves every unfinished row in the operator shift regardless of its stale post binding', async () => {
    const { service, prisma } = setupFinalization('ready');
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { id: 'dispatch-null-post', rollCode: 'ROLL-NULL' },
      { id: 'dispatch-stale-post', rollCode: 'ROLL-STALE' },
    ]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).resolves.toMatchObject({ status: 'completed' });

    const move = prisma.rollDispatchItem.updateMany.mock.calls[0][0];
    expect(move.where).toEqual({
      id: { in: ['dispatch-null-post', 'dispatch-stale-post'] },
      assignedOperatorId: 'operator-1',
      plannedShiftId: 'shift-1',
      status: { notIn: ['ready_for_warehouse', 'done'] },
    });
    expect(move.where).not.toHaveProperty('postId');
  });

  it('rejects finalization when the target post becomes occupied', async () => {
    const { service, prisma } = setupFinalization('ready');
    prisma.operatorPostSession.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.postId === 'post-2'
          ? { id: 'foreign-session', operatorId: 'operator-2' }
          : {
              id: 'session-1',
              operatorId: 'operator-1',
              shiftId: 'shift-1',
              postId: 'post-1',
              status: 'active',
            },
      ),
    );

    await expect(
      service.finalizeMachineChange({ userId: 'operator-1', role: 'operator' }, 'change-1'),
    ).rejects.toThrow(/занят/u);
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
  });

  it('restores the current machine-change operation from durable state', async () => {
    const { service, prisma, change } = setupFinalization('awaiting_final_weight');
    prisma.operatorMachineChange.findFirst = jest.fn().mockResolvedValue(change);

    await expect(service.getCurrentMachineChange({ userId: 'operator-1' })).resolves.toMatchObject({
      id: change.id,
      fromPost: change.fromPost,
      toPost: change.toPost,
      needsFinalWeight: true,
      pendingBigBags: [{ id: 'bag-1', code: 'BAG-1' }],
      requestedAt: '2026-07-27T09:00:00.000Z',
    });
    expect(prisma.operatorMachineChange.findFirst).toHaveBeenCalledWith({
      where: {
        operatorId: 'operator-1',
        shift: { status: { in: ['planned', 'open'] } },
      },
      include: {
        fromPost: { select: { id: true, code: true, name: true } },
        toPost: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('returns no current operation when the latest machine change was cancelled', async () => {
    const { service, prisma, change } = setupFinalization('ready');
    prisma.operatorMachineChange.findFirst = jest.fn().mockResolvedValue({
      ...change,
      status: 'cancelled',
      cancelledAt: new Date('2026-08-04T09:03:00.000Z'),
      cancellationReason: 'Назначение исправлено',
      cancelledById: ACTOR.userId,
    });

    await expect(service.getCurrentMachineChange({ userId: 'operator-1' })).resolves.toBeNull();
  });

  it.each(['requested', 'awaiting_final_weight', 'ready'] as const)(
    'cancels a %s machine change without changing assignment, session or post',
    async (status) => {
      const { service, prisma, audit } = setupCancellation(status);

      await expect(
        service.cancelMachineChange(ACTOR, 'change-cancel', {
          operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
          reason: '  Назначение исправлено  ',
        }),
      ).resolves.toMatchObject({
        changeId: 'change-cancel',
        status: 'cancelled',
        cancellationReason: 'Назначение исправлено',
      });
      expect(prisma.operatorMachineChange.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'change-cancel',
          status: { in: ['requested', 'awaiting_final_weight', 'ready'] },
          cancelOperationKey: null,
        },
        data: {
          status: 'cancelled',
          cancelledAt: expect.any(Date),
          cancelOperationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
          cancelRequestFingerprint: expect.any(String),
          cancellationReason: 'Назначение исправлено',
          cancelledById: ACTOR.userId,
        },
      });
      expect(prisma.operatorShiftMachineAssignment).toBeUndefined();
      expect(prisma.operatorPostSession.findFirst).toHaveBeenCalled();
      expect(prisma.operatorPostSession.updateMany).toBeUndefined();
      expect(prisma.post).toBeUndefined();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audit:operator_machine_change_cancelled',
          objectId: 'assignment-1',
          reason: 'Назначение исправлено',
        }),
        prisma,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification:operator_machine_change_cancelled',
          detail: expect.objectContaining({
            recipientRoles: ['operator', 'production_lead'],
            recipientUserIds: ['operator-1'],
          }),
        }),
        prisma,
      );
    },
  );

  it('rejects cancellation after a machine-change final physical weight was recorded', async () => {
    const { service, prisma } = setupCancellation('awaiting_final_weight');
    prisma.domainEvent.findFirst.mockResolvedValue({ id: 'final-weight-event' });

    await expect(
      service.cancelMachineChange(ACTOR, 'change-cancel', {
        operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
        reason: 'Назначение исправлено',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MACHINE_CHANGE_HAS_PHYSICAL_FACTS' },
    });
    expect(prisma.operatorMachineChange.updateMany).not.toHaveBeenCalled();
  });

  it('rejects cancellation after the machine change completed', async () => {
    const { service, prisma } = setupCancellation('completed');

    await expect(
      service.cancelMachineChange(ACTOR, 'change-cancel', {
        operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
        reason: 'Назначение исправлено',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MACHINE_CHANGE_HAS_PHYSICAL_FACTS' },
    });
    expect(prisma.operatorMachineChange.updateMany).not.toHaveBeenCalled();
  });

  it('replays an exact cancellation and rejects a different cancellation key', async () => {
    const first = setupCancellation('ready');
    const input = {
      operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
      reason: 'Назначение исправлено',
    };
    const result = await first.service.cancelMachineChange(ACTOR, 'change-cancel', input);
    await expect(first.service.cancelMachineChange(ACTOR, 'change-cancel', input)).resolves.toEqual(
      result,
    );
    expect(first.prisma.operatorMachineChange.updateMany).toHaveBeenCalledTimes(1);

    await expect(
      first.service.cancelMachineChange(ACTOR, 'change-cancel', {
        ...input,
        reason: 'Другая причина',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MACHINE_CHANGE_CANCELLATION_OPERATION_KEY_CONFLICT' },
    });
    await expect(
      first.service.cancelMachineChange(ACTOR, 'change-cancel', {
        ...input,
        operationKey: '8cefb6e4-7a24-44b7-81d7-11343203311d',
      }),
    ).rejects.toMatchObject({
      response: { code: 'MACHINE_CHANGE_ALREADY_CANCELLED' },
    });
  });

  it('allows exactly one terminal result when cancellation wins a finalize race', async () => {
    const { service: cancellationService, prisma, current } = setupCancellation('ready');
    const finalization = setupFinalization('ready');
    finalization.prisma.$transaction = prisma.$transaction;
    finalization.prisma.operatorMachineChange.findUnique.mockImplementation(async () => current());

    const [cancelled, completed] = await Promise.allSettled([
      cancellationService.cancelMachineChange(ACTOR, 'change-cancel', {
        operationKey: '27c8446a-9f62-4fef-b1ca-fb8b2f67ec79',
        reason: 'Назначение исправлено',
      }),
      finalization.service.finalizeMachineChange(
        { userId: 'operator-1', role: 'operator' },
        'change-cancel',
      ),
    ]);

    expect(cancelled.status).toBe('fulfilled');
    expect(completed.status).toBe('rejected');
    expect(current().status).toBe('cancelled');
  });
});
