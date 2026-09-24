import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { OperatorSessionService } from './operator-session.service';

function setup() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    post: {
      findUnique: jest.fn().mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' }),
      update: jest.fn().mockResolvedValue({ id: 'post-1', status: 'broken' }),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({ id: 'sess-1' }),
      create: jest.fn().mockResolvedValue({
        id: 'sess-1',
        operatorId: 'op-1',
        postId: 'post-1',
        shiftId: 'shift-1',
        status: 'active',
        startedAt: new Date(),
        endedAt: null,
      }),
    },
    rollDispatchItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    shiftBagUsage: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    shift: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'shift-1',
        status: 'planned',
        plannedStartAt: new Date(Date.now() - 60_000),
        plannedEndAt: new Date(Date.now() + 60_000),
      }),
      create: jest.fn().mockResolvedValue({ id: 'shift-1' }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'shift-1',
        status: 'planned',
        plannedStartAt: new Date(Date.now() - 60_000),
        plannedEndAt: new Date(Date.now() + 60_000),
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorShiftMachineAssignment: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'assignment-1',
          shiftId: 'shift-1',
          operatorId: 'op-1',
          postId: 'post-1',
          status: 'planned',
          lockedAt: null,
          shift: {
            id: 'shift-1',
            status: 'planned',
            plannedStartAt: new Date(Date.now() - 60_000),
            plannedEndAt: new Date(Date.now() + 60_000),
          },
        },
      ]),
      findFirst: jest.fn().mockResolvedValue({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'op-1',
        postId: 'post-1',
        status: 'planned',
        lockedAt: null,
        shift: {
          id: 'shift-1',
          status: 'planned',
          plannedStartAt: new Date(Date.now() - 60_000),
          plannedEndAt: new Date(Date.now() + 60_000),
        },
      }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'op-1',
        postId: 'post-1',
        status: 'planned',
        lockedAt: null,
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionProblem: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'prob-1', type: 'machine_breakdown' }),
    },
  };
  prisma.$queryRaw = jest.fn().mockResolvedValue([]);
  prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma));
  const audit = { record: jest.fn() };
  const deviceReadiness = {
    require: jest.fn().mockResolvedValue({ ready: true, code: 'READY' }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    prisma,
    audit,
    deviceReadiness,
    service: new OperatorSessionService(prisma, audit as any, deviceReadiness as any),
  };
}

const operator = { userId: 'op-1', role: 'operator' as const };

function uniqueRace() {
  return new PrismaClientKnownRequestError('unique race', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('OperatorSessionService', () => {
  it('open: resolves assigned post, creates an active session, audits opened', async () => {
    const { prisma, audit, deviceReadiness, service } = setup();
    const res = await service.open(operator, 'POST-1');
    expect(prisma.post.findUnique).toHaveBeenCalledWith({ where: { code: 'POST-1' } });
    expect(prisma.operatorPostSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operatorId: 'op-1', postId: 'post-1', status: 'active' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_post_session_opened', actorId: 'op-1' }),
      prisma,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(deviceReadiness.require).toHaveBeenCalledWith('post-1', 'operator.shift.open', prisma);
    expect(deviceReadiness.require).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('sess-1');
  });

  it('open: claims every unfinished roll waiting at the post for the incoming operator', async () => {
    const { prisma, audit, service } = setup();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { id: 'dispatch-1', rollCode: 'A-3-roll-1' },
      { id: 'dispatch-2', rollCode: 'A-18-roll-1' },
    ]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 2 });

    await service.open(operator, 'POST-1');

    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith({
      where: {
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: 'post-1',
        status: { in: ['assigned', 'deferred'] },
      },
      select: { id: true, rollCode: true },
      orderBy: [{ queueRank: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['dispatch-1', 'dispatch-2'] },
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: 'post-1',
        status: { in: ['assigned', 'deferred'] },
      },
      data: {
        assignedOperatorId: 'op-1',
        plannedShiftId: 'shift-1',
        workplaceId: 'post-1',
        machineId: 'POST-1',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_bulk_assigned',
        actorId: 'op-1',
        objectId: 'shift-1',
        oldValue: { operatorId: null, shiftId: null, postId: 'post-1' },
        newValue: {
          operatorId: 'op-1',
          shiftId: 'shift-1',
          postId: 'post-1',
          machineId: 'POST-1',
        },
        reason: 'Автоматическая передача незавершённых рулонов следующему оператору поста',
        detail: expect.objectContaining({
          count: 2,
          rollCodes: ['A-3-roll-1', 'A-18-roll-1'],
          sessionId: 'sess-1',
          automaticPostHandover: true,
        }),
      }),
      prisma,
    );
  });

  it('open: keeps a manually prepared shift from reclaiming the old post backlog', async () => {
    const { prisma, audit, service } = setup();
    prisma.rollDispatchItem.findFirst.mockResolvedValue({ id: 'dispatch-selected' });
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { id: 'dispatch-old', rollCode: 'A-3-roll-2' },
    ]);

    await service.open(operator, 'POST-1');

    expect(prisma.rollDispatchItem.findFirst).toHaveBeenCalledWith({
      where: {
        assignedOperatorId: 'op-1',
        plannedShiftId: 'shift-1',
        status: { notIn: ['done', 'ready_for_warehouse'] },
      },
      select: { id: true },
    });
    expect(prisma.rollDispatchItem.findMany).not.toHaveBeenCalled();
    expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:roll_dispatch_bulk_assigned' }),
      prisma,
    );
  });

  it('handoff after close: assigns the post backlog to the first eligible later session', async () => {
    const { prisma, audit, service } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'sess-next',
          operatorId: 'op-2',
          postId: 'post-1',
          shiftId: 'shift-2',
          postCode: 'POST-1',
        },
      ])
      .mockResolvedValueOnce([]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      { id: 'dispatch-1', rollCode: 'A-3-roll-1' },
    ]);
    prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 1 });

    await service.handoffPostBacklogAfterCloseInTransaction(prisma, operator, {
      id: 'sess-old',
      postId: 'post-1',
      startedAt: new Date('2026-09-03T06:00:00.000Z'),
    });

    expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['dispatch-1'] },
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: 'post-1',
        status: { in: ['assigned', 'deferred'] },
      },
      data: {
        assignedOperatorId: 'op-2',
        plannedShiftId: 'shift-2',
        workplaceId: 'post-1',
        machineId: 'POST-1',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:roll_dispatch_bulk_assigned',
        actorId: 'op-1',
        newValue: expect.objectContaining({ operatorId: 'op-2', shiftId: 'shift-2' }),
        detail: expect.objectContaining({
          sessionId: 'sess-next',
          sourceSessionId: 'sess-old',
          selectionRule: 'first_active_session_after_predecessor',
        }),
      }),
      prisma,
    );
  });

  it('open: revalidates locked topology before reusing the same active operator/post row', async () => {
    const { prisma, audit, service } = setup();
    const active = {
      id: 'sess-existing',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(active).mockResolvedValueOnce(null);
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 60_000),
      plannedEndAt: new Date(Date.now() + 60_000),
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: new Date(),
    });

    await expect(service.open(operator, 'POST-1')).resolves.toBe(active);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(prisma.post.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.shift.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.operatorShiftMachineAssignment.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: replays the same active session while its devices are temporarily offline', async () => {
    const { prisma, audit, deviceReadiness, service } = setup();
    const active = {
      id: 'sess-existing',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(active).mockResolvedValueOnce(null);
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 60_000),
      plannedEndAt: new Date(Date.now() + 60_000),
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: new Date(),
    });
    deviceReadiness.require.mockRejectedValue(new Error('devices offline'));

    await expect(service.open(operator, 'POST-1')).resolves.toBe(active);

    expect(deviceReadiness.require).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: fails closed instead of reusing an active session with planned topology', async () => {
    const { prisma, audit, service } = setup();
    const active = {
      id: 'sess-existing',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(active);

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });

    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: rejects a same-session reuse when its post became broken before the locks', async () => {
    const { prisma, audit, service } = setup();
    const active = {
      id: 'sess-existing',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(active);
    prisma.post.findUnique
      .mockResolvedValueOnce({ id: 'post-1', code: 'POST-1', status: 'active' })
      .mockResolvedValueOnce({ id: 'post-1', code: 'POST-1', status: 'broken' });

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: resolves the current shift through this operator assignment', async () => {
    const { prisma, service } = setup();
    const assignment = {
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'planned',
      lockedAt: null,
    };
    prisma.shift.findFirst.mockResolvedValue({
      id: 'unrelated-shift',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 30_000),
      plannedEndAt: new Date(Date.now() + 60_000),
    });
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        ...assignment,
        shift: {
          id: 'shift-1',
          status: 'planned',
          plannedStartAt: new Date(Date.now() - 60_000),
          plannedEndAt: new Date(Date.now() + 60_000),
        },
      },
    ]);
    prisma.operatorShiftMachineAssignment.findUnique.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve('id' in where ? assignment : null),
    );

    await expect(service.open(operator, 'POST-1')).resolves.toMatchObject({ id: 'sess-1' });

    expect(prisma.operatorShiftMachineAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operatorId: 'op-1',
          shift: { status: { in: ['planned', 'open'] } },
        }),
        take: 2,
      }),
    );
  });

  it('open: rejects multiple planned or open assignments without mutating session state', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'op-1',
        postId: 'post-1',
        status: 'planned',
        shift: { id: 'shift-1', status: 'planned' },
      },
      {
        id: 'assignment-2',
        shiftId: 'shift-2',
        operatorId: 'op-1',
        postId: 'post-2',
        status: 'locked',
        shift: { id: 'shift-2', status: 'open' },
      },
    ]);

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: {
        code: 'OPERATOR_POST_SESSION_ASSIGNMENT_AMBIGUOUS',
        message: 'Operator has multiple current shift assignments',
      },
    });
    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: does not reuse a same-post active session from another shift', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce({
      id: 'sess-existing',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'old-shift',
      status: 'active',
    });

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_OPERATOR_CONFLICT' }),
    });
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
  });

  it('open: fails closed for an active session without a shift binding', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce({
      id: 'sess-legacy',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: null,
      status: 'active',
    });

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
  });

  it('open: 404 when the post code is unknown', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue(null);
    await expect(service.open(operator, 'GHOST')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('open: allows another operator to work on the same post', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'other',
      operatorId: 'op-2',
      postId: 'post-1',
      status: 'active',
    });
    await expect(service.open(operator, 'POST-1')).resolves.toMatchObject({ id: 'sess-1' });
    expect(prisma.operatorPostSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operatorId: 'op-1', postId: 'post-1' }),
      }),
    );
  });

  it('open: rejects a post that is not assigned to the operator for the shift', async () => {
    const { prisma, service } = setup();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-2', code: 'POST-2', status: 'active' });

    await expect(service.open(operator, 'POST-2')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
  });

  it('open: rejects an operator without a planned machine for the shift', async () => {
    const { prisma, service } = setup();
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([]);

    await expect(service.open(operator, 'POST-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
  });

  it('open: locks the planned machine assignment', async () => {
    const { prisma, service } = setup();

    await service.open(operator, 'POST-1');

    expect(prisma.operatorShiftMachineAssignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'assignment-1',
          shiftId: 'shift-1',
          operatorId: 'op-1',
          postId: 'post-1',
          status: 'planned',
        },
        data: expect.objectContaining({ status: 'locked', lockedAt: expect.any(Date) }),
      }),
    );
  });

  it('open: rejects when no planned shift is active', async () => {
    const { prisma, service } = setup();
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([]);
    await expect(service.open(operator, 'POST-1')).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.shift.create).not.toHaveBeenCalled();
  });

  it('open: rejects when the post becomes broken before locked revalidation', async () => {
    const { prisma, audit, service } = setup();
    prisma.post.findUnique
      .mockResolvedValueOnce({ id: 'post-1', code: 'POST-1', status: 'active' })
      .mockResolvedValueOnce({ id: 'post-1', code: 'POST-1', status: 'broken' });

    let failure: unknown;
    try {
      await service.open(operator, 'POST-1');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
    });
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: rejects when the assignment moves before locked revalidation', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorShiftMachineAssignment.findMany.mockResolvedValue([
      {
        id: 'assignment-1',
        shiftId: 'shift-1',
        operatorId: 'op-1',
        postId: 'post-1',
        status: 'planned',
        lockedAt: null,
        shift: {
          id: 'shift-1',
          status: 'planned',
          plannedStartAt: new Date(Date.now() - 60_000),
          plannedEndAt: new Date(Date.now() + 60_000),
        },
      },
    ]);
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValueOnce({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-2',
      status: 'planned',
      lockedAt: null,
    });

    let failure: unknown;
    try {
      await service.open(operator, 'POST-1');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
    });
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: rejects when the assignment is completed before locked revalidation', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValueOnce({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'completed',
      lockedAt: new Date(),
    });

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: reuses a same-shift session committed while waiting for the topology lock', async () => {
    const { prisma, audit, service } = setup();
    const concurrent = {
      id: 'sess-concurrent',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst
      .mockResolvedValueOnce(concurrent)
      .mockResolvedValueOnce(null);
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 60_000),
      plannedEndAt: new Date(Date.now() + 60_000),
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: new Date(),
    });

    await expect(service.open(operator, 'POST-1')).resolves.toBe(concurrent);
    expect(prisma.operatorPostSession.create).not.toHaveBeenCalled();
    expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: resolves a P2002 race to the concurrently-created same logical session', async () => {
    const { prisma, audit, service } = setup();
    const active = {
      id: 'sess-race',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.$transaction.mockRejectedValueOnce(uniqueRace());
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce(active);
    prisma.shift.findUnique.mockResolvedValue({
      id: 'shift-1',
      status: 'open',
      plannedStartAt: new Date(Date.now() - 60_000),
      plannedEndAt: new Date(Date.now() + 60_000),
    });
    prisma.operatorShiftMachineAssignment.findUnique.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'op-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: new Date(),
    });

    await expect(service.open(operator, 'POST-1')).resolves.toBe(active);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: revalidates a broken post instead of unlocked reuse after a P2002 race', async () => {
    const { prisma, audit, service } = setup();
    prisma.$transaction.mockRejectedValueOnce(uniqueRace());
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      code: 'POST-1',
      status: 'broken',
    });
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-race',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });

    await expect(service.open(operator, 'POST-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: maps a P2002 operator race to the stable other-post conflict', async () => {
    const { prisma, service } = setup();
    prisma.$transaction.mockRejectedValueOnce(uniqueRace());
    prisma.operatorPostSession.findFirst.mockResolvedValueOnce({
      id: 'sess-race',
      operatorId: 'op-1',
      postId: 'post-2',
      shiftId: 'shift-1',
      status: 'active',
    });

    await expect(service.open(operator, 'POST-1')).rejects.toThrow(
      'Operator already has an active session at another post',
    );
  });

  it('open: maps unexplained P2002 to a stable coded 409 after reread', async () => {
    const { prisma, audit, service } = setup();
    prisma.$transaction.mockRejectedValueOnce(uniqueRace()).mockRejectedValueOnce(uniqueRace());

    let failure: unknown;
    try {
      await service.open(operator, 'POST-1');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getStatus()).toBe(409);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      code: 'OPERATOR_POST_SESSION_RACE_CONFLICT',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('open: does not audit when create fails inside the transaction', async () => {
    const { prisma, audit, service } = setup();
    const failure = new Error('create failed');
    prisma.operatorPostSession.create.mockRejectedValueOnce(failure);

    await expect(service.open(operator, 'POST-1')).rejects.toBe(failure);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('close: ends the active session and audits closed', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });
    prisma.operatorPostSession.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.close(operator)).resolves.toEqual({ ok: true });
    expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sess-1', status: 'active' },
        data: expect.objectContaining({ status: 'closed' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:operator_post_session_closed' }),
      prisma,
    );
  });

  it('close: idempotent when there is no active session', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue(null);
    await expect(service.close(operator)).resolves.toEqual({ ok: true });
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('close: locks and rereads the session before deciding it is still active', async () => {
    const { prisma, audit, service } = setup();
    let active: Record<string, unknown> | null = {
      id: 'sess-1',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockImplementation(async () => active);
    prisma.$queryRaw.mockImplementationOnce(async () => {
      active = null;
      return [];
    });

    await expect(service.close(operator)).resolves.toEqual({ ok: true });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('close: can recover a legacy active session without a shift binding', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-legacy',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: null,
      status: 'active',
    });
    prisma.operatorPostSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.close(operator)).resolves.toEqual({ ok: true });

    expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sess-legacy', status: 'active' } }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('close: rejects a bagged session so ShiftBagUsage and bag cannot be stranded', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });
    prisma.shiftBagUsage.findFirst.mockResolvedValue({ id: 'usage-1' });

    await expect(service.close(operator)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_OPEN_BAG_USAGE' }),
    });
    expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('close: audits exactly once when two callers observe the same active row', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      status: 'active',
    });
    prisma.operatorPostSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(Promise.all([service.close(operator), service.close(operator)])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('requireActive: returns the active session', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    });
    await expect(service.requireActive('op-1')).resolves.toMatchObject({ postId: 'post-1' });
  });

  it('requireActive: 409 when there is no active session', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue(null);
    await expect(service.requireActive('op-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('requireActive: fails closed for a legacy active session without a shift binding', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-legacy',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: null,
      status: 'active',
    });

    await expect(service.requireActive('op-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT' }),
    });
  });

  it('getCurrent: projects the post without leaking the agent token hash (ТЗ §8)', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
    });
    await service.getCurrent('op-1');
    const arg = prisma.operatorPostSession.findFirst.mock.calls.at(-1)?.[0];
    // The post is fetched with a whitelist select — the per-post agent secret is never selected.
    expect(arg.include.post.select).toBeDefined();
    expect(arg.include.post.select.agentTokenHash).toBeUndefined();
    expect(arg.include.post.select.code).toBe(true);
  });

  it('reportMachineBreakdown: persists the structured subtype in one problem and both events', async () => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });

    const problem = await service.reportMachineBreakdown(operator, {
      type: 'screw_jam',
      details: 'Шнек не вращается',
    });

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { status: 'broken' },
    });
    expect(prisma.productionProblem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'machine_breakdown',
          machineBreakdownType: 'screw_jam',
          postId: 'post-1',
          actorRole: 'operator',
          reason: 'Клин шнека — Шнек не вращается',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledTimes(2);
    for (const eventType of [
      'problem:machine_breakdown_reported',
      'notification:production_problem_received',
    ]) {
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: eventType,
          objectId: 'post-1',
          reason: 'Клин шнека — Шнек не вращается',
          detail: expect.objectContaining({
            machineBreakdownType: 'screw_jam',
            machineBreakdownDetails: 'Шнек не вращается',
          }),
        }),
        prisma,
      );
    }
    expect(problem.id).toBe('prob-1');
  });

  it.each([
    ['screw_jam', 'Клин шнека'],
    ['extruder_stopped', 'Экструдер остановился'],
    ['drive_stopped', 'Остановка привода'],
    ['belt_break', 'Обрыв ремня'],
    ['other', 'Другая поломка'],
  ] as const)('reportMachineBreakdown: derives the human reason for %s', async (type, label) => {
    const { prisma, audit, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' });

    await service.reportMachineBreakdown(operator, { type });

    expect(prisma.productionProblem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ machineBreakdownType: type, reason: label }),
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    for (const call of audit.record.mock.calls) {
      expect(call[0].detail).toEqual(
        expect.objectContaining({
          machineBreakdownType: type,
          machineBreakdownDetails: null,
        }),
      );
    }
  });

  it('reportMachineBreakdown: 409 without an active session', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue(null);
    await expect(
      service.reportMachineBreakdown(operator, { type: 'other' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reportMachineBreakdown: idempotent when the post is already broken with an open problem', async () => {
    const { prisma, service } = setup();
    prisma.operatorPostSession.findFirst.mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
    });
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'broken' });
    prisma.productionProblem.findFirst.mockResolvedValue({ id: 'prob-open', status: 'open' });

    const problem = await service.reportMachineBreakdown(operator, { type: 'other' });

    expect(problem.id).toBe('prob-open');
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
  });

  it('reportMachineBreakdown: locks and revalidates the post before an idempotent retry', async () => {
    const { prisma, audit, service } = setup();
    const session = {
      id: 'sess-1',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    const existing = {
      id: 'prob-open',
      type: 'machine_breakdown',
      postId: 'post-1',
      status: 'open',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValue(session);
    prisma.post.findUnique.mockImplementation(async () => ({
      id: 'post-1',
      code: 'POST-1',
      status: prisma.$queryRaw.mock.calls.length > 0 ? 'broken' : 'active',
    }));
    prisma.productionProblem.findFirst.mockResolvedValue(existing);

    await expect(service.reportMachineBreakdown(operator, { type: 'other' })).resolves.toBe(
      existing,
    );

    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.post.findUnique.mock.invocationCallOrder.at(-1),
    );
    expect(prisma.post.update).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('reportMachineBreakdown: rolls back post and problem when a required audit fact fails', async () => {
    const { prisma, audit, service } = setup();
    const session = {
      id: 'sess-atomic',
      operatorId: 'op-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
    };
    prisma.operatorPostSession.findFirst.mockResolvedValue(session);

    let committed = { postStatus: 'active', problemCount: 0 };
    let transactionClient: typeof prisma;
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => {
      const staged = { ...committed };
      transactionClient = {
        ...prisma,
        post: {
          ...prisma.post,
          findUnique: jest
            .fn()
            .mockResolvedValue({ id: 'post-1', code: 'POST-1', status: 'active' }),
          update: jest.fn(async () => {
            staged.postStatus = 'broken';
            return { id: 'post-1', code: 'POST-1', status: 'broken' };
          }),
        },
        productionProblem: {
          ...prisma.productionProblem,
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(async () => {
            staged.problemCount += 1;
            return { id: 'prob-atomic', type: 'machine_breakdown', postId: 'post-1' };
          }),
        },
      };
      const result = await callback(transactionClient);
      committed = staged;
      return result;
    });
    const auditClients: unknown[] = [];
    audit.record.mockImplementation(async (input: { type: string }, client: unknown) => {
      auditClients.push(client);
      if (input.type === 'notification:production_problem_received') {
        throw new Error('Notification audit unavailable');
      }
    });

    await expect(service.reportMachineBreakdown(operator, { type: 'screw_jam' })).rejects.toThrow(
      'Notification audit unavailable',
    );

    expect(committed).toEqual({ postStatus: 'active', problemCount: 0 });
    expect(auditClients).toEqual([transactionClient, transactionClient]);
  });
});
