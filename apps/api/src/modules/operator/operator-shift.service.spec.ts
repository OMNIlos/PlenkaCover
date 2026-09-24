import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { ReleaseShiftBagDto } from './dto/shift.dto';
import { parseOperatorShiftCloseResult } from './operator-shift-close-result';
import { OperatorShiftService } from './operator-shift.service';

const OPERATOR = { userId: 'operator-1', role: 'operator' as const };
const CLOSE_OPERATION_KEY = '11111111-1111-4111-8111-111111111111';
const RELEASE_OPERATION_KEY = '22222222-2222-4222-8222-222222222222';

const EMPTY_CLOSING_PAYROLL = {
  sessionId: 'sess-1',
  shiftId: 'shift-1',
  status: 'empty' as const,
  appliedTariffOrders: [],
  summary: {
    payableAmountKopecks: 0,
    payableKg: 0,
    machineShiftCount: 0,
    unresolvedKg: 0,
    unresolvedFactCount: 0,
    excludedDefectKg: 0,
    excludedDefectRollCount: 0,
  },
  breakdown: [],
  unresolved: [],
};

function closeDto(
  bags: Array<{ bigBagId: string; endKg: number }>,
  operationKey = CLOSE_OPERATION_KEY,
) {
  return { operationKey, bags };
}

function replayCommand(data: any, resultSnapshot = data.resultSnapshot) {
  return {
    requestFingerprint: data.requestFingerprint,
    operatorId: data.operatorId,
    sessionId: data.sessionId,
    shiftId: data.shiftId,
    postId: data.postId,
    assignmentId: data.assignmentId,
    actorRole: data.actorRole,
    resultSnapshot,
    session: {
      operatorId: data.operatorId,
      shiftId: data.shiftId,
      postId: data.postId,
      status: 'closed',
      endedAt: new Date('2026-08-08T10:00:00.000Z'),
    },
    assignment: {
      operatorId: data.operatorId,
      shiftId: data.shiftId,
      postId: data.postId,
      status: 'completed',
    },
  };
}

function bag(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bag-1',
    code: 'BB-15803-01',
    material: 'ПВД 15803-020',
    materialId: 'rm-pvd-15803',
    status: 'available',
    registrationStatus: 'registered',
    location: 'production',
    initialKg: 500,
    currentKg: 500,
    lastMeasuredKg: 500,
    locationRevision: 0,
    composition: [
      {
        rawMaterialDefinitionId: 'material-pvd',
        materialId: 'rm-pvd-15803',
        name: 'RAW-COMPOSITION-MUST-NOT-LEAK',
        shareBasisPoints: 10_000,
        initialKg: 500,
      },
    ],
    ...overrides,
  };
}

function setup(overrides: { prisma?: Record<string, any>; sessions?: Record<string, any> } = {}) {
  const assignment = {
    id: 'assignment-1',
    shiftId: 'shift-1',
    operatorId: OPERATOR.userId,
    postId: 'post-1',
    status: 'locked',
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
    post: {
      findUnique: jest.fn().mockResolvedValue({ id: 'post-1', status: 'active' }),
    },
    shift: {
      findUnique: jest.fn().mockResolvedValue({ id: 'shift-1', status: 'open' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bigBagUnit: {
      findUnique: jest.fn().mockResolvedValue(bag()),
      findMany: jest
        .fn()
        .mockResolvedValue([bag(), bag({ id: 'bag-2', code: 'BB-15803-02', status: 'in_use' })]),
      update: jest.fn().mockResolvedValue(bag({ status: 'in_use' })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bigBagMovement: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(async ({ data }: any) => ({ id: 'movement-1', ...data })),
    },
    shiftBagUsage: {
      create: jest.fn().mockResolvedValue({ id: 'usage-1', bigBagId: 'bag-1', startKg: 500 }),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    shiftBagUsageEpisode: {
      create: jest.fn().mockResolvedValue({ id: 'episode-1', sequence: 1 }),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
    defectBag: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'defect-bag-1',
          code: 'DEF-sess-1',
          postSessionId: 'sess-1',
          status: 'ready_for_warehouse',
          defectType: 'secondary',
          weightKg: 2.5,
        },
      ]),
    },
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue({
        rollDispatchItem: {
          productionOrder: { commercialOrderId: 'co1' },
        },
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    rollDispatchItem: {
      findFirst: jest.fn().mockResolvedValue({
        productionOrder: { commercialOrderId: 'co1' },
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorShiftMachineAssignment: {
      findFirst: jest
        .fn()
        .mockImplementation(async (args: any) =>
          args?.where?.shiftId ? assignment : { post: { code: 'POST-1' } },
        ),
      findUnique: jest.fn().mockResolvedValue(assignment),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'sess-1',
        operatorId: OPERATOR.userId,
        postId: 'post-1',
        shiftId: 'shift-1',
        status: 'active',
        startedAt: new Date('2026-07-13T06:00:00Z'),
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    productionProblem: { create: jest.fn().mockResolvedValue({ id: 'problem-1' }) },
    operatorShiftCloseCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        resultSnapshot: data.resultSnapshot,
      })),
    },
  };
  for (const [key, value] of Object.entries(overrides.prisma ?? {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      prisma[key] &&
      typeof prisma[key] === 'object'
    ) {
      Object.assign(prisma[key], value);
    } else {
      prisma[key] = value;
    }
  }
  prisma.$transaction = jest.fn(async (cb: (tx: any) => unknown) => cb(prisma));
  const audit = { record: jest.fn() };
  const sessions: any = {
    open: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
    openInTransaction: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
    close: jest.fn().mockResolvedValue({ ok: true }),
    getCurrent: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
    requireActive: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
    lockActiveInTransaction: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
    handoffPostBacklogAfterCloseInTransaction: jest.fn().mockResolvedValue(null),
    ...overrides.sessions,
  };
  const payroll = {
    getClosingPayroll: jest.fn().mockResolvedValue(EMPTY_CLOSING_PAYROLL),
    parseClosingResult: jest.fn(
      async (
        _client: unknown,
        value: unknown,
        ownership: Parameters<typeof parseOperatorShiftCloseResult>[1],
      ) => parseOperatorShiftCloseResult(value, ownership),
    ),
  };
  const service = new (OperatorShiftService as any)(
    prisma,
    audit,
    sessions,
    payroll,
  ) as OperatorShiftService;
  return { service, prisma, audit, sessions, payroll };
}

describe('ReleaseShiftBagDto', () => {
  it('requires a stable UUID operation key for an idempotent movement fact', async () => {
    const valid = Object.assign(new ReleaseShiftBagDto(), {
      operationKey: RELEASE_OPERATION_KEY,
      endKg: 4000,
    });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = Object.assign(new ReleaseShiftBagDto(), {
      operationKey: 'retry-me',
      endKg: 4000,
    });
    expect((await validate(invalid)).map(({ property }) => property)).toContain('operationKey');
  });
});

describe('OperatorShiftService', () => {
  afterEach(() => {
    delete process.env.OPERATOR_YIELD_RATIO;
    delete process.env.OPERATOR_BALANCE_TOLERANCE;
  });

  describe('listBigBags', () => {
    it('projects bags to the operator picker view without raw fields', async () => {
      const { service, prisma } = setup();
      const bags = await service.listBigBags();
      expect(prisma.bigBagUnit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: { in: ['available', 'in_use'] },
            registrationStatus: 'registered',
            location: 'production',
          },
        }),
      );
      expect(bags[0]).toEqual({
        id: 'bag-1',
        code: 'BB-15803-01',
        material: 'ПВД 15803-020',
        materialId: 'rm-pvd-15803',
        warehouseKg: 500,
        currentKg: 500,
        status: 'available',
      });
      expect(JSON.stringify(bags)).not.toContain('RAW-COMPOSITION-MUST-NOT-LEAK');
    });
  });

  describe('open', () => {
    it('opens the post session, registers the bag and records both audit events', async () => {
      const { service, prisma, audit, sessions } = setup({
        sessions: { getCurrent: jest.fn().mockResolvedValue(null) },
      });
      await service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 });
      expect(sessions.openInTransaction).toHaveBeenCalledWith(prisma, OPERATOR, 'POST-1');
      expect(sessions.open).not.toHaveBeenCalled();
      expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            operatorId: OPERATOR.userId,
            shift: expect.objectContaining({
              status: { in: ['planned', 'open'] },
              OR: [
                { plannedStartAt: null, plannedEndAt: null },
                {
                  plannedStartAt: { lte: expect.any(Date) },
                  plannedEndAt: { gt: expect.any(Date) },
                },
              ],
            }),
          }),
          orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
        }),
      );
      expect(prisma.shiftBagUsage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sessionId: 'sess-1',
            bigBagId: 'bag-1',
            startKg: 500,
            sequence: 1,
          }),
        }),
      );
      expect(prisma.shiftBagUsageEpisode.create).toHaveBeenCalledWith({
        data: {
          usageId: 'usage-1',
          sequence: 1,
          startKg: 500,
        },
      });
      expect(prisma.bigBagUnit.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'bag-1',
            status: 'available',
            registrationStatus: 'registered',
            location: 'production',
            currentKg: 500,
          },
          data: expect.objectContaining({ status: 'in_use', currentKg: 500 }),
        }),
      );
      const eventTypes = audit.record.mock.calls.map((c: any[]) => c[0].type);
      expect(eventTypes).toContain('audit:bigbag_weight_recorded');
      expect(eventTypes).toContain('audit:operator_shift_opened');
      expect(audit.record.mock.calls.every((call: any[]) => call[1] === prisma)).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    function atomicFailureHarness(options: { claimCount?: number; failShiftAudit?: boolean }) {
      type State = {
        assignmentStatus: 'planned' | 'locked';
        bagStatus: 'available' | 'in_use';
        sessions: number;
        usages: number;
      };
      let committed: State = {
        assignmentStatus: 'planned',
        bagStatus: 'available',
        sessions: 0,
        usages: 0,
      };
      const client = (state: State) => ({
        __state: state,
        bigBagUnit: {
          findUnique: jest.fn().mockImplementation(async () => bag({ status: state.bagStatus })),
          updateMany: jest.fn().mockImplementation(async () => {
            if ((options.claimCount ?? 1) === 0) return { count: 0 };
            state.bagStatus = 'in_use';
            return { count: 1 };
          }),
        },
        shiftBagUsage: {
          count: jest.fn().mockImplementation(async () => state.usages),
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation(async () => {
            state.usages += 1;
            return { id: 'usage-1', bigBagId: 'bag-1', startKg: 500 };
          }),
        },
        shiftBagUsageEpisode: {
          create: jest.fn().mockResolvedValue({ id: 'episode-1', sequence: 1 }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
      });
      const prisma: any = {
        operatorShiftMachineAssignment: {
          findFirst: jest.fn().mockResolvedValue({ post: { code: 'POST-1' } }),
        },
      };
      Object.assign(prisma, client(committed));
      prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => {
        const draft = structuredClone(committed) as State;
        const tx = client(draft);
        const result = await callback(tx);
        committed = draft;
        return result;
      });
      const sessions: any = {
        open: jest.fn().mockImplementation(async () => {
          committed.assignmentStatus = 'locked';
          committed.sessions += 1;
          return { id: 'sess-1', postId: 'post-1', shiftId: 'shift-1' };
        }),
        openInTransaction: jest.fn().mockImplementation(async (tx: any) => {
          tx.__state.assignmentStatus = 'locked';
          tx.__state.sessions += 1;
          return { id: 'sess-1', postId: 'post-1', shiftId: 'shift-1' };
        }),
      };
      const audit = {
        record: jest.fn().mockImplementation(async ({ type }: { type: string }) => {
          if (options.failShiftAudit && type === 'audit:operator_shift_opened') {
            throw new Error('audit unavailable');
          }
        }),
      };
      return {
        service: new OperatorShiftService(prisma, audit as any, sessions, {
          getClosingPayroll: jest.fn(),
        } as never),
        state: () => committed,
      };
    }

    it('rolls back session and assignment when the Big-bag claim loses a race', async () => {
      const { service, state } = atomicFailureHarness({ claimCount: 0 });

      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 })).rejects.toThrow(
        ConflictException,
      );

      expect(state()).toEqual({
        assignmentStatus: 'planned',
        bagStatus: 'available',
        sessions: 0,
        usages: 0,
      });
    });

    it('rolls back session, assignment, bag and usage when audit fails', async () => {
      const { service, state } = atomicFailureHarness({ failShiftAudit: true });

      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 })).rejects.toThrow(
        'audit unavailable',
      );

      expect(state()).toEqual({
        assignmentStatus: 'planned',
        bagStatus: 'available',
        sessions: 0,
        usages: 0,
      });
    });

    it('rejects a bag that is already in use', async () => {
      const { service } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(bag({ status: 'in_use' })),
            findMany: jest.fn(),
            update: jest.fn(),
          },
        },
        sessions: { getCurrent: jest.fn().mockResolvedValue(null) },
      });
      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 })).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects a non-positive start weight', async () => {
      const { service } = setup();
      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 0 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('replays an exact shift open after the response was lost without duplicate facts', async () => {
      const existingUsage = {
        id: 'usage-1',
        sessionId: 'sess-1',
        bigBagId: 'bag-1',
        startKg: 500,
        endKg: null,
        closedAt: null,
        sequence: 1,
      };
      const { service, prisma, audit } = setup({
        prisma: {
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            findUnique: jest.fn().mockResolvedValue(existingUsage),
          },
        },
      });

      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 })).resolves.toEqual({
        session: expect.objectContaining({ id: 'sess-1', shiftId: 'shift-1' }),
        usage: existingUsage,
      });

      expect(prisma.shiftBagUsage.findUnique).toHaveBeenCalledWith({
        where: { sessionId_bigBagId: { sessionId: 'sess-1', bigBagId: 'bag-1' } },
      });
      expect(prisma.shiftBagUsage.create).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsageEpisode.create).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects a second shift open when the stored start facts differ', async () => {
      const { service, sessions, prisma } = setup({
        prisma: {
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            findUnique: jest.fn().mockResolvedValue({
              id: 'usage-1',
              sessionId: 'sess-1',
              bigBagId: 'bag-1',
              startKg: 499,
              endKg: null,
              closedAt: null,
              sequence: 1,
            }),
            create: jest.fn(),
            findMany: jest.fn(),
            update: jest.fn(),
          },
        },
      });
      await expect(service.open(OPERATOR, { bigBagId: 'bag-1', startKg: 500 })).rejects.toThrow(
        ConflictException,
      );
      expect(sessions.openInTransaction).toHaveBeenCalledWith(prisma, OPERATOR, 'POST-1');
    });

    it('404s on an unknown bag', async () => {
      const { service } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn(),
            update: jest.fn(),
          },
        },
        sessions: { getCurrent: jest.fn().mockResolvedValue(null) },
      });
      await expect(service.open(OPERATOR, { bigBagId: 'nope', startKg: 10 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('addBag', () => {
    it('registers an extra bag without requiring a reason', async () => {
      const { service, prisma, audit, sessions } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(bag({ currentKg: 300 })),
          },
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            create: jest.fn().mockResolvedValue({ id: 'usage-2' }),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
          },
        },
      });
      await service.addBag(OPERATOR, {
        bigBagId: 'bag-1',
        startKg: 300,
      });
      expect(prisma.shiftBagUsage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sequence: 2, addedReason: null }),
        }),
      );
      expect(prisma.shiftBagUsageEpisode.create).toHaveBeenCalledWith({
        data: {
          usageId: 'usage-2',
          sequence: 1,
          startKg: 300,
        },
      });
      expect(audit.record.mock.calls.map((c: any[]) => c[0].type)).toContain(
        'audit:operator_shift_bag_added',
      );
      expect(sessions.lockActiveInTransaction).toHaveBeenCalledWith(prisma, OPERATOR.userId);
      expect(sessions.requireActive).not.toHaveBeenCalled();
    });

    it('does not create a usage when the session closed before its transaction lock', async () => {
      const { service, prisma } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(bag({ currentKg: 300 })),
          },
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            create: jest.fn().mockResolvedValue({ id: 'usage-2' }),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
          },
        },
        sessions: {
          lockActiveInTransaction: jest
            .fn()
            .mockRejectedValue(new ConflictException('No active session')),
        },
      });

      await expect(
        service.addBag(OPERATOR, {
          bigBagId: 'bag-1',
          startKg: 300,
          reason: 'Сырьё закончилось',
        }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.shiftBagUsage.create).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
    });

    it('treats a blank legacy reason as absent', async () => {
      const { service, prisma } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(bag({ currentKg: 300 })),
          },
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            create: jest.fn().mockResolvedValue({ id: 'usage-2' }),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn(),
          },
        },
      });

      await service.addBag(OPERATOR, {
        bigBagId: 'bag-1',
        startKg: 300,
        reason: '   ',
      });

      expect(prisma.shiftBagUsage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ addedReason: null }),
        }),
      );
    });

    it('409s without an active session', async () => {
      const { service } = setup({
        sessions: {
          requireActive: jest.fn().mockRejectedValue(new ConflictException('no session')),
        },
      });
      await expect(
        service.addBag(OPERATOR, { bigBagId: 'bag-1', startKg: 300, reason: 'x' }),
      ).rejects.toThrow(ConflictException);
    });

    it('re-adds a returned bag by appending an episode to the stable session link', async () => {
      const returnedUsage = {
        id: 'usage-1',
        sessionId: 'sess-1',
        bigBagId: 'bag-1',
        startKg: 500,
        endKg: 450,
        closedAt: new Date('2026-08-08T09:00:00.000Z'),
        releasedReason: null,
        sequence: 1,
      };
      const { service, prisma } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest.fn().mockResolvedValue(bag({ currentKg: 450 })),
          },
        },
      });
      prisma.shiftBagUsage.count.mockResolvedValue(1);
      prisma.shiftBagUsage.findUnique.mockResolvedValue(returnedUsage);
      prisma.shiftBagUsage.update.mockResolvedValue({
        ...returnedUsage,
        startKg: 450,
        endKg: null,
        closedAt: null,
      });
      prisma.shiftBagUsageEpisode.findFirst.mockResolvedValue({
        sequence: 1,
        closedAt: new Date('2026-08-08T09:00:00.000Z'),
      });

      await service.addBag(OPERATOR, { bigBagId: 'bag-1', startKg: 450 });

      expect(prisma.shiftBagUsage.create).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.update).toHaveBeenCalledWith({
        where: { id: 'usage-1' },
        data: {
          startKg: 450,
          endKg: null,
          addedReason: null,
          releasedReason: null,
          closedAt: null,
        },
      });
      expect(prisma.shiftBagUsageEpisode.create).toHaveBeenCalledWith({
        data: {
          usageId: 'usage-1',
          sequence: 2,
          startKg: 450,
        },
      });
    });

    it('rejects a stale re-add weight instead of replacing the canonical released currentKg', async () => {
      const { service, prisma, audit } = setup({
        prisma: {
          bigBagUnit: {
            findUnique: jest
              .fn()
              .mockResolvedValue(
                bag({ status: 'available', currentKg: 4000, lastMeasuredKg: 4000 }),
              ),
          },
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            findUnique: jest.fn().mockResolvedValue({
              id: 'usage-1',
              sessionId: 'sess-1',
              bigBagId: 'bag-1',
              startKg: 5000,
              endKg: 4000,
              closedAt: new Date('2026-08-11T08:00:00.000Z'),
              sequence: 1,
            }),
          },
        },
      });

      await expect(
        service.addBag(OPERATOR, { bigBagId: 'bag-1', startKg: 5000 }),
      ).rejects.toMatchObject({
        response: { code: 'OPERATOR_BIGBAG_STALE_WEIGHT', currentKg: 4000 },
      });

      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsageEpisode.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('replays an exact double submit without another link, episode or audit event', async () => {
      const activeUsage = {
        id: 'usage-1',
        sessionId: 'sess-1',
        bigBagId: 'bag-1',
        startKg: 300,
        endKg: null,
        closedAt: null,
        sequence: 1,
      };
      const { service, prisma, audit } = setup();
      prisma.shiftBagUsage.count.mockResolvedValue(1);
      prisma.shiftBagUsage.findUnique.mockResolvedValue(activeUsage);

      await expect(service.addBag(OPERATOR, { bigBagId: 'bag-1', startKg: 300 })).resolves.toEqual(
        activeUsage,
      );

      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.create).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsageEpisode.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('releaseBag', () => {
    it('releases one weighed bag while the operator shift remains active', async () => {
      const openUsage = {
        id: 'usage-1',
        sessionId: 'sess-1',
        bigBagId: 'bag-1',
        startKg: 500,
        endKg: null,
        closedAt: null,
        bigBag: bag({ status: 'in_use', currentKg: 500 }),
      };
      const { service, prisma, audit, sessions } = setup({
        prisma: {
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            create: jest.fn(),
            findFirst: jest.fn().mockResolvedValue(openUsage),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
      });

      const result = await service.releaseBag(OPERATOR, 'bag-1', {
        operationKey: RELEASE_OPERATION_KEY,
        endKg: 417.2,
      });

      expect(sessions.lockActiveInTransaction).toHaveBeenCalledWith(prisma, OPERATOR.userId);
      expect(prisma.shiftBagUsage.updateMany).toHaveBeenCalledWith({
        where: { id: 'usage-1', closedAt: null },
        data: {
          endKg: 417.2,
          releasedReason: null,
          closedAt: expect.any(Date),
        },
      });
      expect(prisma.shiftBagUsageEpisode.updateMany).toHaveBeenCalledWith({
        where: { usageId: 'usage-1', closedAt: null },
        data: {
          endKg: 417.2,
          closedAt: expect.any(Date),
          closeKind: 'released',
        },
      });
      expect(prisma.bigBagUnit.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'bag-1',
          status: 'in_use',
          registrationStatus: 'registered',
          location: 'production',
        },
        data: expect.objectContaining({
          currentKg: 417.2,
          lastMeasuredKg: 417.2,
          status: 'available',
        }),
      });
      expect(prisma.bigBagMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bigBagId: 'bag-1',
          operationKey: RELEASE_OPERATION_KEY,
          kind: 'operator_shift_release',
          fromLocation: 'production',
          toLocation: 'production',
          operatorReportedKg: 417.2,
          actorId: OPERATOR.userId,
          actorRole: OPERATOR.role,
        }),
      });
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(audit.record.mock.calls.map((call: any[]) => call[0].type)).toEqual(
        expect.arrayContaining([
          'audit:bigbag_weight_recorded',
          'audit:operator_shift_bag_released',
        ]),
      );
      expect(
        audit.record.mock.calls
          .filter((call: any[]) =>
            ['audit:bigbag_weight_recorded', 'audit:operator_shift_bag_released'].includes(
              call[0].type,
            ),
          )
          .every((call: any[]) => call[0].reason === undefined),
      ).toBe(true);
      expect(result).toEqual(
        expect.objectContaining({
          bagId: 'bag-1',
          code: 'BB-15803-01',
          endKg: 417.2,
          active: false,
          status: 'available',
        }),
      );
    });

    it('rejects a bag that is not actively used by the current operator session', async () => {
      const { service, prisma } = setup();

      await expect(
        service.releaseBag(OPERATOR, 'bag-foreign', {
          operationKey: RELEASE_OPERATION_KEY,
          endKg: 100,
        }),
      ).rejects.toThrow(ConflictException);

      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a final weight above the usage start weight', async () => {
      const { service, prisma } = setup({
        prisma: {
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(1),
            create: jest.fn(),
            findFirst: jest.fn().mockResolvedValue({
              id: 'usage-1',
              sessionId: 'sess-1',
              bigBagId: 'bag-1',
              startKg: 500,
              endKg: null,
              closedAt: null,
              bigBag: bag({ status: 'in_use' }),
            }),
            findMany: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        },
      });

      await expect(
        service.releaseBag(OPERATOR, 'bag-1', {
          operationKey: RELEASE_OPERATION_KEY,
          endKg: 501,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.shiftBagUsage.updateMany).not.toHaveBeenCalled();
    });

    it('replays the same release movement without another weight, episode or audit fact', async () => {
      const releasedAt = '2026-08-11T08:00:00.000Z';
      const resultSnapshot = {
        bagId: 'bag-1',
        code: 'BB-15803-01',
        startKg: 5000,
        endKg: 4000,
        active: false,
        releasedAt,
        status: 'available',
      };
      const { service, prisma, audit, sessions } = setup();
      prisma.bigBagMovement.findUnique.mockResolvedValue({
        operationKey: RELEASE_OPERATION_KEY,
        requestFingerprint: requestFingerprint({
          command: 'operator_shift_bag_release',
          operatorId: OPERATOR.userId,
          actorRole: OPERATOR.role,
          bigBagId: 'bag-1',
          endKg: 4000,
        }),
        kind: 'operator_shift_release',
        bigBagId: 'bag-1',
        actorId: OPERATOR.userId,
        actorRole: OPERATOR.role,
        resultSnapshot,
      });

      await expect(
        service.releaseBag(OPERATOR, 'bag-1', {
          operationKey: RELEASE_OPERATION_KEY,
          endKg: 4000,
        }),
      ).resolves.toEqual(resultSnapshot);

      expect(sessions.lockActiveInTransaction).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.updateMany).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsageEpisode.updateMany).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.updateMany).not.toHaveBeenCalled();
      expect(prisma.bigBagMovement.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    function closeSetup(
      over: { captures?: any[]; defects?: any[]; usages?: any[]; rolls?: any[] } = {},
    ) {
      const usages = over.usages ?? [
        {
          id: 'usage-1',
          bigBagId: 'bag-1',
          startKg: 500,
          endKg: null,
          closedAt: null,
          releasedReason: null,
          episodes: [
            {
              sequence: 1,
              startKg: 500,
              endKg: null,
              closedAt: null,
              closeKind: null,
            },
          ],
          bigBag: bag({ status: 'in_use' }),
        },
      ];
      const captures = (
        over.captures ?? [
          { id: 'capture-1', operatorRollLineId: 'line-1', netKg: 41.4 },
          { id: 'capture-2', operatorRollLineId: 'line-2', netKg: 41.4 },
        ]
      ).map((capture, index) => ({
        id: `capture-${index + 1}`,
        operatorRollLineId: `line-${index + 1}`,
        postSessionId: 'sess-1',
        kind: 'roll',
        stable: true,
        netKg: null,
        supersedesCaptureId: null,
        createdAt: new Date(`2026-07-13T0${index + 7}:00:00.000Z`),
        ...capture,
      }));
      return setup({
        prisma: {
          shiftBagUsage: {
            count: jest.fn().mockResolvedValue(usages.length),
            findMany: jest
              .fn()
              .mockImplementation(async (args: any) =>
                args?.include?.episodes
                  ? usages
                  : usages.map(({ episodes: _episodes, ...usage }) => usage),
              ),
            update: jest.fn(),
            create: jest.fn(),
          },
          weightCapture: {
            findMany: jest
              .fn()
              .mockImplementation(
                async (args: {
                  where: { postSessionId?: string };
                  distinct?: readonly string[];
                }) => {
                  const sessionId = args.where?.postSessionId;
                  if (sessionId === undefined) return captures;
                  const sessionCaptures = captures.filter(
                    (capture) => capture.postSessionId === sessionId,
                  );
                  if (!args.distinct) return sessionCaptures;
                  return [
                    ...new Set(sessionCaptures.map((capture) => capture.operatorRollLineId)),
                  ].map((operatorRollLineId) => ({ operatorRollLineId }));
                },
              ),
          },
          defectRecord: { findMany: jest.fn().mockResolvedValue(over.defects ?? []) },
          rollDispatchItem: {
            findMany: jest.fn().mockResolvedValue(over.rolls ?? []),
            updateMany: jest.fn().mockResolvedValue({ count: over.rolls?.length ?? 0 }),
          },
        },
      });
    }

    it('freezes authoritative payroll with the completed session and assignment in one close result', async () => {
      const { service, prisma, payroll, audit } = closeSetup();
      prisma.operatorShiftMachineAssignment.count.mockResolvedValue(1);

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));

      expect(payroll.getClosingPayroll).toHaveBeenCalledWith(prisma, {
        operatorId: OPERATOR.userId,
        sessionId: 'sess-1',
        shiftId: 'shift-1',
        postId: 'post-1',
        generatedAt: expect.any(Date),
      });
      expect(prisma.operatorPostSession.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        payroll.getClosingPayroll.mock.invocationCallOrder[0],
      );
      expect(
        prisma.operatorShiftMachineAssignment.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(payroll.getClosingPayroll.mock.invocationCallOrder[0]);
      expect(result.closingPayroll).toEqual(EMPTY_CLOSING_PAYROLL);
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          operationKey: CLOSE_OPERATION_KEY,
          requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          operatorId: OPERATOR.userId,
          sessionId: 'sess-1',
          shiftId: 'shift-1',
          postId: 'post-1',
          assignmentId: 'assignment-1',
          actorRole: OPERATOR.role,
          resultSnapshot: result,
        }),
        select: { resultSnapshot: true },
      });
      expect(
        audit.record.mock.calls.filter(
          ([event]: any[]) => event.type === 'audit:operator_shift_closed',
        ),
      ).toHaveLength(1);
    });

    it('rejects final weights for bags outside the exact active close set', async () => {
      const { service, prisma } = closeSetup();

      await expect(
        service.close(
          OPERATOR,
          closeDto([
            { bigBagId: 'bag-1', endKg: 417.2 },
            { bigBagId: 'bag-unrelated', endKg: 10 },
          ]),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.operatorShiftCloseCommand.create).not.toHaveBeenCalled();
    });

    it('journals every immutable BigBag episode for one legacy closed session without reopening it', async () => {
      const legacySession = {
        id: 'sess-legacy',
        operatorId: OPERATOR.userId,
        postId: 'post-1',
        shiftId: 'shift-1',
        status: 'closed',
        startedAt: new Date('2026-07-13T06:00:00.000Z'),
        endedAt: new Date('2026-07-13T18:00:00.000Z'),
        closeCommand: null,
      };
      const { service, prisma, payroll, audit } = closeSetup({
        captures: [
          {
            id: 'capture-legacy-1',
            operatorRollLineId: 'line-legacy-1',
            postSessionId: 'sess-legacy',
            netKg: 50,
          },
          {
            id: 'capture-legacy-2',
            operatorRollLineId: 'line-legacy-2',
            postSessionId: 'sess-legacy',
            netKg: 50,
          },
        ],
        usages: [
          {
            id: 'usage-1',
            bigBagId: 'bag-1',
            startKg: 450,
            endKg: 400,
            closedAt: legacySession.endedAt,
            releasedReason: null,
            episodes: [
              {
                sequence: 1,
                startKg: 500,
                endKg: 450,
                closedAt: new Date('2026-07-13T12:00:00.000Z'),
                closeKind: 'released',
              },
              {
                sequence: 2,
                startKg: 450,
                endKg: 400,
                closedAt: legacySession.endedAt,
                closeKind: 'shift_closed',
              },
            ],
            bigBag: bag({ status: 'available', currentKg: 400 }),
          },
        ],
      });
      prisma.operatorPostSession.findFirst.mockImplementation(async ({ where }: any) =>
        where.status === 'active' ? null : legacySession,
      );
      prisma.operatorPostSession.findUnique = jest.fn().mockResolvedValue(legacySession);
      prisma.operatorShiftMachineAssignment.findMany = jest.fn().mockResolvedValue([
        {
          id: 'assignment-1',
          operatorId: OPERATOR.userId,
          shiftId: 'shift-1',
          postId: 'post-1',
          status: 'completed',
        },
      ]);
      const legacyPayroll = { ...EMPTY_CLOSING_PAYROLL, sessionId: 'sess-legacy' };
      payroll.getClosingPayroll.mockResolvedValue(legacyPayroll);

      await expect(
        service.close(
          OPERATOR,
          closeDto([{ bigBagId: 'bag-1', endKg: 399.9 }], '33333333-3333-4333-8333-333333333333'),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.operatorShiftCloseCommand.create).not.toHaveBeenCalled();

      const result = await service.close(
        OPERATOR,
        closeDto([{ bigBagId: 'bag-1', endKg: 400 }], '22222222-2222-4222-8222-222222222222'),
      );

      expect(result).toMatchObject({
        balance: {
          producedKg: 100,
          expectedUsageKg: 100,
          actualUsageKg: 100,
          status: 'ok',
        },
        problemId: null,
        releasedRollIds: [],
        closingPayroll: legacyPayroll,
      });
      expect(payroll.getClosingPayroll).toHaveBeenCalledWith(prisma, {
        operatorId: OPERATOR.userId,
        sessionId: 'sess-legacy',
        shiftId: 'shift-1',
        postId: 'post-1',
        generatedAt: legacySession.endedAt,
      });
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.operatorShiftMachineAssignment.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledTimes(1);
      expect(prisma.shiftBagUsage.findMany).toHaveBeenCalledWith({
        where: { sessionId: 'sess-legacy' },
        include: { episodes: { orderBy: { sequence: 'asc' } } },
        orderBy: { sequence: 'asc' },
      });
    });

    it('replays the frozen close result without duplicate accrual, transition, or event', async () => {
      const { service, prisma, payroll, audit } = closeSetup();
      const dto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);

      const first = await service.close(OPERATOR, dto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(replayCommand(commandData));
      const mutationCount =
        prisma.operatorPostSession.updateMany.mock.calls.length +
        prisma.operatorShiftMachineAssignment.updateMany.mock.calls.length;
      const auditCount = audit.record.mock.calls.length;

      const replay = await service.close(OPERATOR, dto);

      expect(replay).toEqual(first);
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledTimes(1);
      expect(payroll.getClosingPayroll).toHaveBeenCalledTimes(1);
      expect(
        prisma.operatorPostSession.updateMany.mock.calls.length +
          prisma.operatorShiftMachineAssignment.updateMany.mock.calls.length,
      ).toBe(mutationCount);
      expect(audit.record).toHaveBeenCalledTimes(auditCount);
    });

    it('conflicts when one operation key is reused with a changed close request', async () => {
      const { service, prisma } = closeSetup();
      const firstDto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);
      await service.close(OPERATOR, firstDto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(replayCommand(commandData));

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.1 }])),
      ).rejects.toMatchObject({
        response: { code: 'OPERATOR_SHIFT_CLOSE_OPERATION_KEY_CONFLICT' },
      });
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledTimes(1);
    });

    it('fails closed when an immutable replay snapshot is malformed', async () => {
      const { service, prisma } = closeSetup();
      const dto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);
      await service.close(OPERATOR, dto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(
        replayCommand(commandData, { malformed: true }),
      );

      await expect(service.close(OPERATOR, dto)).rejects.toMatchObject({
        response: { code: 'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID' },
      });
    });

    it('rejects replay snapshots that smuggle identity or raw payload fields', async () => {
      const { service, prisma } = closeSetup();
      const dto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);
      await service.close(OPERATOR, dto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      const forged = structuredClone(commandData.resultSnapshot) as any;
      forged.closingPayroll.operatorId = 'operator-secret';
      forged.closingPayroll.rawPayload = { deviceFrame: 'must-not-leak' };
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(
        replayCommand(commandData, forged),
      );

      await expect(service.close(OPERATOR, dto)).rejects.toMatchObject({
        response: { code: 'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID' },
      });
    });

    it.each([
      ['an active owning session', (command: any) => (command.session.status = 'active')],
      ['an incomplete owning assignment', (command: any) => (command.assignment.status = 'locked')],
      [
        'a mismatched owning actor',
        (command: any) => (command.session.operatorId = 'operator-other'),
      ],
    ])('fails closed when replay has %s', async (_name, mutate) => {
      const { service, prisma } = closeSetup();
      const dto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);
      await service.close(OPERATOR, dto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      const command = replayCommand(commandData);
      mutate(command);
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(command);

      await expect(service.close(OPERATOR, dto)).rejects.toMatchObject({
        response: { code: 'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID' },
      });
    });

    it('canonicalizes bag order so a logically identical retry replays the same command', async () => {
      const secondBag = bag({ id: 'bag-2', code: 'BB-2', status: 'in_use', currentKg: 300 });
      const { service, prisma } = closeSetup({
        usages: [
          {
            id: 'usage-1',
            bigBagId: 'bag-1',
            startKg: 500,
            endKg: null,
            closedAt: null,
            bigBag: bag({ status: 'in_use' }),
          },
          {
            id: 'usage-2',
            bigBagId: 'bag-2',
            startKg: 300,
            endKg: null,
            closedAt: null,
            bigBag: secondBag,
          },
        ],
      });
      const firstDto = closeDto([
        { bigBagId: 'bag-1', endKg: 450 },
        { bigBagId: 'bag-2', endKg: 267.2 },
      ]);
      const first = await service.close(OPERATOR, firstDto);
      const commandData = prisma.operatorShiftCloseCommand.create.mock.calls[0][0].data;
      prisma.operatorShiftCloseCommand.findUnique.mockResolvedValue(replayCommand(commandData));

      await expect(
        service.close(
          OPERATOR,
          closeDto([
            { bigBagId: 'bag-2', endKg: 267.2 },
            { bigBagId: 'bag-1', endKg: 450 },
          ]),
        ),
      ).resolves.toEqual(first);
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent same-key submissions into one command and one accrual', async () => {
      const { service, prisma, payroll, audit } = closeSetup();
      let stored: ReturnType<typeof replayCommand> | null = null;
      prisma.operatorShiftCloseCommand.findUnique.mockImplementation(async () => stored);
      prisma.operatorShiftCloseCommand.create.mockImplementation(async ({ data }: any) => {
        stored = replayCommand(data);
        return { resultSnapshot: data.resultSnapshot };
      });
      let tail: Promise<unknown> = Promise.resolve();
      prisma.$transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) => {
        const current = tail.then(() => callback(prisma));
        tail = current.catch(() => undefined);
        return current;
      });
      const dto = closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]);

      const [first, second] = await Promise.all([
        service.close(OPERATOR, dto),
        service.close(OPERATOR, dto),
      ]);

      expect(second).toEqual(first);
      expect(prisma.operatorShiftCloseCommand.create).toHaveBeenCalledTimes(1);
      expect(payroll.getClosingPayroll).toHaveBeenCalledTimes(1);
      expect(
        audit.record.mock.calls.filter(
          ([event]: any[]) => event.type === 'audit:operator_shift_closed',
        ),
      ).toHaveLength(1);
    });

    it('rolls back transition, close events, payroll result, and command when journaling fails', async () => {
      const { service, prisma, audit } = closeSetup();
      prisma.operatorShiftMachineAssignment.count.mockResolvedValue(1);
      type CloseState = {
        sessionStatus: 'active' | 'closed';
        assignmentStatus: 'locked' | 'completed';
        eventCount: number;
        commandCount: number;
      };
      let committed: CloseState = {
        sessionStatus: 'active',
        assignmentStatus: 'locked',
        eventCount: 0,
        commandCount: 0,
      };
      prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
        const draft = structuredClone(committed) as CloseState;
        const tx = {
          ...prisma,
          __closeState: draft,
          operatorPostSession: {
            ...prisma.operatorPostSession,
            updateMany: jest.fn(async () => {
              draft.sessionStatus = 'closed';
              return { count: 1 };
            }),
          },
          operatorShiftMachineAssignment: {
            ...prisma.operatorShiftMachineAssignment,
            updateMany: jest.fn(async () => {
              draft.assignmentStatus = 'completed';
              return { count: 1 };
            }),
          },
          operatorShiftCloseCommand: {
            ...prisma.operatorShiftCloseCommand,
            create: jest.fn(async () => {
              draft.commandCount += 1;
              throw new Error('journal unavailable');
            }),
          },
        };
        const result = await callback(tx);
        committed = draft;
        return result;
      });
      audit.record.mockImplementation(async (_event: unknown, tx: any) => {
        if (tx.__closeState) tx.__closeState.eventCount += 1;
      });

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
      ).rejects.toThrow('journal unavailable');

      expect(committed).toEqual({
        sessionStatus: 'active',
        assignmentStatus: 'locked',
        eventCount: 0,
        commandCount: 0,
      });
    });

    it('does not mutate the shift when its defect bag is missing', async () => {
      const { service, prisma } = closeSetup();
      prisma.defectBag.findMany.mockResolvedValue([]);

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DEFECT_BAG_REQUIRED' }),
      });
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.update).not.toHaveBeenCalled();
    });

    it('closes with an explicitly recorded zero defect weight and no label', async () => {
      const { service, prisma, audit } = closeSetup();
      prisma.defectBag.findMany.mockResolvedValue([
        {
          id: 'zero-defect',
          code: 'DEF-zero',
          postSessionId: 'sess-1',
          status: 'weighed',
          defectType: null,
          weightKg: 0,
        },
      ]);

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
      ).resolves.toMatchObject({ balance: expect.any(Object) });
      expect(prisma.operatorPostSession.updateMany).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audit:operator_shift_closed',
          detail: expect.objectContaining({
            defectBags: [expect.objectContaining({ weightKg: 0, status: 'weighed' })],
          }),
        }),
        expect.anything(),
      );
    });

    it('does not mutate the shift while its defect-bag label is unconfirmed', async () => {
      const { service, prisma } = closeSetup();
      prisma.defectBag.findMany.mockResolvedValue([
        {
          id: 'ready-bag',
          code: 'DEF-ready',
          postSessionId: 'sess-1',
          status: 'ready_for_warehouse',
          defectType: 'primary',
          weightKg: 3,
        },
        {
          id: 'defect-bag-1',
          code: 'DEF-sess-1',
          postSessionId: 'sess-1',
          status: 'weighed',
          defectType: 'secondary',
          weightKg: 2.5,
        },
      ]);

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DEFECT_BAG_LABEL_REQUIRED' }),
      });
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.shiftBagUsage.update).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.update).not.toHaveBeenCalled();
    });

    it('accounts only the canonical reweigh after loading its root history', async () => {
      const captures = [
        {
          id: 'base',
          operatorRollLineId: 'line-1',
          postSessionId: 'sess-old',
          netKg: 10,
          supersedesCaptureId: null,
          createdAt: new Date('2026-07-13T05:00:00.000Z'),
        },
        {
          id: 'legacy-duplicate',
          operatorRollLineId: 'line-1',
          postSessionId: 'sess-1',
          netKg: 20,
          supersedesCaptureId: null,
          createdAt: new Date('2026-07-13T06:30:00.000Z'),
        },
        {
          id: 'reweigh',
          operatorRollLineId: 'line-1',
          postSessionId: 'sess-1',
          netKg: 12,
          supersedesCaptureId: 'base',
          createdAt: new Date('2026-07-13T07:00:00.000Z'),
        },
      ];
      const { service } = closeSetup({ captures });

      const result = await service.computeBalance({
        id: 'sess-1',
        postId: 'post-1',
        startedAt: new Date('2026-07-13T06:00:00.000Z'),
      });

      expect(result.producedKg).toBe(12);
      expect(result.expectedUsageKg).toBe(12);
    });

    it('uses the stable roll net kilograms as an exact one-to-one expected balance', async () => {
      process.env.OPERATOR_YIELD_RATIO = '0.5';
      const { service, prisma, audit, sessions } = closeSetup();
      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));
      expect(result.balance.producedKg).toBe(82.8);
      expect(result.balance.expectedUsageKg).toBe(82.8);
      expect(result.balance.actualUsageKg).toBe(82.8);
      expect(result.balance.status).toBe('ok');
      expect(result.problemId).toBeNull();
      expect(prisma.shiftBagUsage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usage-1' },
          data: expect.objectContaining({ endKg: 417.2 }),
        }),
      );
      expect(prisma.shiftBagUsageEpisode.updateMany).toHaveBeenCalledWith({
        where: { usageId: 'usage-1', closedAt: null },
        data: {
          endKg: 417.2,
          closedAt: expect.any(Date),
          closeKind: 'shift_closed',
        },
      });
      expect(prisma.bigBagUnit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bag-1' },
          data: expect.objectContaining({ status: 'available', currentKg: 417.2 }),
        }),
      );
      // Сессия закрывается атомарным claim в той же транзакции (codex-ревью #8).
      expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-1', status: 'active' },
          data: expect.objectContaining({ status: 'closed' }),
        }),
      );
      expect(sessions.close).not.toHaveBeenCalled();
      expect(sessions.requireActive).not.toHaveBeenCalled();
      expect(sessions.lockActiveInTransaction).toHaveBeenCalledWith(prisma, OPERATOR.userId);
      expect(sessions.lockActiveInTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.shiftBagUsage.findMany.mock.invocationCallOrder[0],
      );
      expect(prisma.shiftBagUsage.findMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.weightCapture.findMany.mock.invocationCallOrder[0],
      );
      const closeEventTypes = audit.record.mock.calls.map((c: any[]) => c[0].type);
      expect(closeEventTypes).toContain('audit:operator_shift_closed');
      expect(closeEventTypes).toContain('audit:operator_post_session_closed');
      const closeEvent = audit.record.mock.calls.find(
        (call: any[]) => call[0].type === 'audit:operator_shift_closed',
      )?.[0];
      expect(closeEvent.detail.defectBag).toEqual({
        id: 'defect-bag-1',
        code: 'DEF-sess-1',
        defectType: 'secondary',
        weightKg: 2.5,
        status: 'ready_for_warehouse',
      });
      expect(closeEvent.detail.defectBags).toEqual([closeEvent.detail.defectBag]);
      expect(JSON.stringify(closeEvent)).not.toContain('bbt_');
    });

    it.each(['spool_weight', 'roll_weight', 'qr_print', 'qr_check', 'handover'] as const)(
      'automatically defers a roll from %s and closes the shift',
      async (step) => {
        const { service, prisma, audit } = closeSetup({
          rolls: [
            {
              id: 'dispatch-started',
              rollCode: 'ROLL-STARTED',
              assignedOperatorId: OPERATOR.userId,
              plannedShiftId: 'shift-1',
              postId: 'post-1',
              status: 'assigned',
              operatorLine: {
                id: 'line-started',
                step,
                deferredFromStep: null,
              },
            },
          ],
        });

        const result = await service.close(
          OPERATOR,
          closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]),
        );

        expect(result.releasedRollIds).toEqual([]);
        expect(prisma.operatorRollLine.updateMany).toHaveBeenCalledWith({
          where: { id: 'line-started', step, deferredFromStep: null },
          data: { step: 'deferred', deferredFromStep: step },
        });
        expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['dispatch-started'] },
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: { in: ['assigned', 'deferred'] },
          },
          data: {
            assignedOperatorId: null,
            plannedShiftId: null,
            status: 'deferred',
          },
        });
        expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith({
          where: { id: 'sess-1', status: 'active' },
          data: { status: 'closed', endedAt: expect.any(Date) },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'audit:roll_deferred',
            actorId: OPERATOR.userId,
            objectId: 'ROLL-STARTED',
            oldValue: { step, status: 'assigned' },
            newValue: { step: 'deferred', deferredFromStep: step, status: 'deferred' },
            reason: 'Автоматически отложен при сдаче смены',
            detail: expect.objectContaining({
              sessionId: 'sess-1',
              postId: 'post-1',
              automaticShiftClose: true,
            }),
          }),
          prisma,
        );
      },
    );

    it('leaves untouched rolls at the post for the next operator when closing the shift', async () => {
      const { service, prisma, audit } = closeSetup({
        rolls: [
          {
            id: 'dispatch-unstarted',
            rollCode: 'ROLL-UNSTARTED',
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: 'assigned',
            operatorLine: {
              id: 'line-unstarted',
              step: 'assigned',
              deferredFromStep: null,
            },
          },
        ],
      });

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));

      expect(result.releasedRollIds).toEqual(['ROLL-UNSTARTED']);
      expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['dispatch-unstarted'] },
          assignedOperatorId: OPERATOR.userId,
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          status: { in: ['assigned', 'deferred'] },
        },
        data: {
          assignedOperatorId: null,
          plannedShiftId: null,
          status: 'assigned',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audit:roll_assignment_released',
          objectId: 'shift-1',
          newValue: { operatorId: null, shiftId: null, postId: 'post-1' },
          detail: expect.objectContaining({
            rollCodes: ['ROLL-UNSTARTED'],
            reasonCode: 'operator_shift_closed_post_backlog',
          }),
        }),
        prisma,
      );
    });

    it('resets a deferred-but-unaccepted roll before releasing it', async () => {
      const { service, prisma } = closeSetup({
        rolls: [
          {
            id: 'dispatch-deferred',
            rollCode: 'ROLL-DEFERRED',
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: 'deferred',
            operatorLine: {
              id: 'line-deferred',
              step: 'deferred',
              deferredFromStep: 'assigned',
            },
          },
        ],
      });

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));

      expect(result.releasedRollIds).toEqual(['ROLL-DEFERRED']);
      expect(prisma.operatorRollLine.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['line-deferred'] },
          step: 'deferred',
          deferredFromStep: 'assigned',
        },
        data: { step: 'assigned', deferredFromStep: null },
      });
    });

    it.each(['spool_weight', 'roll_weight', 'qr_print', 'qr_check', 'handover'] as const)(
      'allows close with a roll deferred from %s and leaves it at the post',
      async (deferredFromStep) => {
        const { service, prisma, audit } = closeSetup({
          rolls: [
            {
              id: 'dispatch-paused',
              rollCode: 'ROLL-PAUSED',
              assignedOperatorId: OPERATOR.userId,
              plannedShiftId: 'shift-1',
              postId: 'post-1',
              status: 'deferred',
              operatorLine: {
                id: 'line-paused',
                step: 'deferred',
                deferredFromStep,
              },
            },
          ],
        });

        const result = await service.close(
          OPERATOR,
          closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]),
        );

        expect(result.releasedRollIds).toEqual([]);
        expect(prisma.operatorRollLine.updateMany).not.toHaveBeenCalled();
        expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
          where: {
            id: { in: ['dispatch-paused'] },
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: { in: ['assigned', 'deferred'] },
          },
          data: {
            assignedOperatorId: null,
            plannedShiftId: null,
            status: 'deferred',
          },
        });
        expect(prisma.operatorPostSession.updateMany).toHaveBeenCalledWith({
          where: { id: 'sess-1', status: 'active' },
          data: { status: 'closed', endedAt: expect.any(Date) },
        });
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'audit:roll_assignment_released',
            newValue: { operatorId: null, shiftId: null, postId: 'post-1' },
            detail: expect.objectContaining({
              rollIds: ['dispatch-paused'],
              rollCodes: ['ROLL-PAUSED'],
            }),
          }),
          prisma,
        );
      },
    );

    it('leaves untouched and started deferred rolls at the post', async () => {
      const { service, prisma, audit } = closeSetup({
        rolls: [
          {
            id: 'dispatch-unstarted',
            rollCode: 'ROLL-UNSTARTED',
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: 'assigned',
            operatorLine: {
              id: 'line-unstarted',
              step: 'assigned',
              deferredFromStep: null,
            },
          },
          {
            id: 'dispatch-paused',
            rollCode: 'ROLL-PAUSED',
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status: 'deferred',
            operatorLine: {
              id: 'line-paused',
              step: 'deferred',
              deferredFromStep: 'qr_check',
            },
          },
        ],
      });
      prisma.rollDispatchItem.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));

      expect(result.releasedRollIds).toEqual(['ROLL-UNSTARTED']);
      expect(prisma.operatorRollLine.updateMany).not.toHaveBeenCalled();
      expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['dispatch-paused'] },
          assignedOperatorId: OPERATOR.userId,
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          status: { in: ['assigned', 'deferred'] },
        },
        data: {
          assignedOperatorId: null,
          plannedShiftId: null,
          status: 'deferred',
        },
      });
      expect(prisma.rollDispatchItem.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['dispatch-unstarted'] },
          assignedOperatorId: OPERATOR.userId,
          plannedShiftId: 'shift-1',
          postId: 'post-1',
          status: { in: ['assigned', 'deferred'] },
        },
        data: {
          assignedOperatorId: null,
          plannedShiftId: null,
          status: 'assigned',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audit:roll_assignment_released',
          detail: expect.objectContaining({
            rollIds: ['dispatch-unstarted', 'dispatch-paused'],
            rollCodes: ['ROLL-UNSTARTED', 'ROLL-PAUSED'],
          }),
        }),
        prisma,
      );
    });

    it.each([null, 'warehouse', 'not-an-operator-step'])(
      'fails closed for deferred roll with malformed predecessor %p',
      async (deferredFromStep) => {
        const { service, prisma } = closeSetup({
          rolls: [
            {
              id: 'dispatch-malformed',
              rollCode: 'ROLL-MALFORMED',
              assignedOperatorId: OPERATOR.userId,
              plannedShiftId: 'shift-1',
              postId: 'post-1',
              status: 'deferred',
              operatorLine: {
                id: 'line-malformed',
                step: 'deferred',
                deferredFromStep,
              },
            },
          ],
        });

        await expect(
          service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
        ).rejects.toMatchObject({
          response: {
            code: 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE',
            rollCodes: ['ROLL-MALFORMED'],
          },
        });
        expect(prisma.shiftBagUsage.findMany).not.toHaveBeenCalled();
        expect(prisma.operatorRollLine.updateMany).not.toHaveBeenCalled();
        expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
        expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
        expect(prisma.operatorShiftCloseCommand.create).not.toHaveBeenCalled();
      },
    );

    it.each([
      { status: 'assigned', deferredFromStep: 'qr_check', caseName: 'dispatch status mismatch' },
      {
        status: 'deferred',
        deferredFromStep: 'roll_scale_activation',
        caseName: 'compatibility-only predecessor',
      },
    ])('fails closed for deferred line with $caseName', async ({ status, deferredFromStep }) => {
      const { service, prisma } = closeSetup({
        rolls: [
          {
            id: 'dispatch-inconsistent',
            rollCode: 'ROLL-INCONSISTENT',
            assignedOperatorId: OPERATOR.userId,
            plannedShiftId: 'shift-1',
            postId: 'post-1',
            status,
            operatorLine: {
              id: 'line-inconsistent',
              step: 'deferred',
              deferredFromStep,
            },
          },
        ],
      });

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }])),
      ).rejects.toMatchObject({
        response: {
          code: 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE',
          rollCodes: ['ROLL-INCONSISTENT'],
        },
      });
      expect(prisma.shiftBagUsage.findMany).not.toHaveBeenCalled();
      expect(prisma.rollDispatchItem.updateMany).not.toHaveBeenCalled();
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
      expect(prisma.operatorShiftCloseCommand.create).not.toHaveBeenCalled();
    });

    it('includes previously released bags in the final balance and weighs only open usages', async () => {
      const releasedBag = bag({
        id: 'bag-released',
        code: 'BB-RELEASED',
        status: 'available',
        currentKg: 450,
      });
      const activeBag = bag({
        id: 'bag-active',
        code: 'BB-ACTIVE',
        status: 'in_use',
        initialKg: 300,
        currentKg: 300,
      });
      const { service, prisma } = closeSetup({
        usages: [
          {
            id: 'usage-released',
            bigBagId: 'bag-released',
            startKg: 500,
            endKg: 450,
            closedAt: new Date('2026-07-13T09:00:00.000Z'),
            bigBag: releasedBag,
          },
          {
            id: 'usage-active',
            bigBagId: 'bag-active',
            startKg: 300,
            endKg: null,
            closedAt: null,
            bigBag: activeBag,
          },
        ],
        captures: [
          {
            id: 'capture-1',
            operatorRollLineId: 'line-1',
            netKg: 100,
          },
        ],
      });

      const result = await service.close(
        OPERATOR,
        closeDto([{ bigBagId: 'bag-active', endKg: 250 }]),
      );

      expect(result.balance.actualUsageKg).toBe(100);
      expect(result.balance.expectedUsageKg).toBe(100);
      expect(result.balance.status).toBe('ok');
      expect(prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { sessionId: 'sess-1' } }),
      );
      expect(prisma.shiftBagUsage.update).toHaveBeenCalledTimes(1);
      expect(prisma.shiftBagUsage.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'usage-active' } }),
      );
      expect(prisma.bigBagUnit.update).toHaveBeenCalledTimes(1);
      expect(prisma.bigBagUnit.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'bag-active' } }),
      );
    });

    it('sums every episode when the same returned Big-Bag is added back to the shift', async () => {
      const { service } = closeSetup({
        usages: [
          {
            id: 'usage-1',
            bigBagId: 'bag-1',
            startKg: 450,
            endKg: null,
            closedAt: null,
            releasedReason: null,
            episodes: [
              {
                sequence: 1,
                startKg: 500,
                endKg: 450,
                closedAt: new Date('2026-08-08T09:00:00.000Z'),
                closeKind: 'released',
              },
              {
                sequence: 2,
                startKg: 450,
                endKg: null,
                closedAt: null,
                closeKind: null,
              },
            ],
            bigBag: bag({ status: 'in_use', currentKg: 450 }),
          },
        ],
        captures: [{ id: 'capture-1', operatorRollLineId: 'line-1', netKg: 100 }],
      });

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 400 }]));

      expect(result.balance).toEqual(
        expect.objectContaining({
          actualUsageKg: 100,
          expectedUsageKg: 100,
          status: 'ok',
        }),
      );
    });

    it('attributes defect mass only through a stable capture linked to this exact session', async () => {
      const { service, prisma } = closeSetup({
        defects: [{ weightCapture: { netKg: 41.4 } }],
      });

      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 417.2 }]));

      expect(result.balance).toEqual(
        expect.objectContaining({
          producedKg: 82.8,
          defectKg: 41.4,
          expectedUsageKg: 82.8,
          actualUsageKg: 82.8,
          status: 'ok',
        }),
      );
      expect(prisma.defectRecord.findMany).toHaveBeenCalledWith({
        where: {
          weightCapture: {
            postSessionId: 'sess-1',
            kind: 'roll',
            stable: true,
            netKg: { not: null },
          },
        },
        select: { weightCapture: { select: { netKg: true } } },
      });
    });

    it('keeps the earliest stable legacy capture per line when no supersession exists', async () => {
      const captures = [
        { id: 'capture-a', operatorRollLineId: 'line-1', netKg: 40 },
        { id: 'capture-b', operatorRollLineId: 'line-1', netKg: 99 },
        { id: 'capture-c', operatorRollLineId: 'line-2', netKg: 42.8 },
      ];
      const { service, prisma } = closeSetup({ captures });

      const result = await service.computeBalance({
        id: 'sess-1',
        postId: 'post-1',
        startedAt: new Date('2026-07-13T06:00:00Z'),
      });

      expect(result.producedKg).toBe(82.8);
      expect(result.expectedUsageKg).toBe(82.8);
      expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(1, {
        where: {
          postSessionId: 'sess-1',
          kind: 'roll',
          stable: true,
          netKg: { not: null },
        },
        select: { operatorRollLineId: true },
        distinct: ['operatorRollLineId'],
      });
      expect(prisma.weightCapture.findMany).toHaveBeenNthCalledWith(2, {
        where: {
          kind: 'roll',
          stable: true,
          netKg: { not: null },
          operatorRollLineId: { in: ['line-1', 'line-2'] },
        },
        select: {
          id: true,
          operatorRollLineId: true,
          postSessionId: true,
          kind: true,
          stable: true,
          netKg: true,
          supersedesCaptureId: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('rejects a final weight above the episode start at the service boundary', async () => {
      const { service } = closeSetup({ captures: [] });

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 510 }])),
      ).rejects.toThrow(BadRequestException);
    });

    it('keeps the default two-percent mismatch tolerance inclusive', async () => {
      const { service } = closeSetup();
      const session = {
        id: 'sess-1',
        postId: 'post-1',
        startedAt: new Date('2026-07-13T06:00:00Z'),
      };
      const usages = [{ startKg: 500, bigBagId: 'bag-1' }];

      const atBoundary = await service.computeBalance(
        session,
        usages,
        new Map([['bag-1', 415.544]]),
      );
      const beyondBoundary = await service.computeBalance(
        session,
        usages,
        new Map([['bag-1', 415.5]]),
      );

      expect(atBoundary.deviationPercent).toBe(2);
      expect(atBoundary.status).toBe('ok');
      expect(beyondBoundary.status).toBe('mismatch');
    });

    it('does not read usages or mutate bags when the session closed before its lock', async () => {
      const { service, prisma } = closeSetup();
      const sessions = (service as any).sessions;
      sessions.lockActiveInTransaction.mockRejectedValueOnce(
        new ConflictException('No active session'),
      );

      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 412.8 }])),
      ).rejects.toThrow(ConflictException);

      expect(prisma.shiftBagUsage.findMany).not.toHaveBeenCalled();
      expect(prisma.bigBagUnit.update).not.toHaveBeenCalled();
      expect(prisma.operatorPostSession.updateMany).not.toHaveBeenCalled();
    });

    it('409s a concurrent double close (session already claimed)', async () => {
      const { service, prisma } = closeSetup();
      prisma.operatorPostSession.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 412.8 }])),
      ).rejects.toThrow(ConflictException);
    });

    it('completes the exact shift assignment but keeps the shared shift open while peers remain', async () => {
      const { service, prisma } = closeSetup();
      prisma.operatorShiftMachineAssignment.count.mockResolvedValue(1);

      await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 412.8 }]));

      expect(prisma.operatorShiftMachineAssignment.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'assignment-1',
          shiftId: 'shift-1',
          operatorId: OPERATOR.userId,
          postId: 'post-1',
          status: { in: ['locked', 'breakdown_reassigned'] },
        },
        data: { status: 'completed' },
      });
      expect(prisma.operatorShiftMachineAssignment.count).toHaveBeenCalledWith({
        where: { shiftId: 'shift-1', status: { not: 'completed' } },
      });
      expect(prisma.shift.updateMany).not.toHaveBeenCalled();
    });

    it('closes the shared shift with endedAt only after its final assignment completes', async () => {
      const { service, prisma } = closeSetup();
      prisma.operatorShiftMachineAssignment.count.mockResolvedValue(0);

      await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 412.8 }]));

      expect(prisma.shift.updateMany).toHaveBeenCalledWith({
        where: { id: 'shift-1', status: 'open' },
        data: { status: 'closed', endedAt: expect.any(Date) },
      });
    });

    it('locks post, shift and exact assignment before the active session', async () => {
      const { service, prisma, sessions } = closeSetup();

      await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 412.8 }]));

      const lockedTables = prisma.$queryRaw.mock.calls.map((call: any[]) =>
        call[0].strings.join(' '),
      );
      expect(lockedTables[0]).toContain('pg_advisory_xact_lock');
      expect(lockedTables[1]).toContain('posts');
      expect(lockedTables[2]).toContain('shifts');
      expect(lockedTables[3]).toContain('operator_shift_machine_assignments');
      expect(prisma.$queryRaw.mock.invocationCallOrder[3]).toBeLessThan(
        sessions.lockActiveInTransaction.mock.invocationCallOrder[0],
      );
    });

    it('flags a mismatch, creates the production problem and notification', async () => {
      const { service, prisma, audit } = closeSetup();
      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 390 }]));
      expect(result.balance.status).toBe('mismatch');
      expect(result.problemId).toBe('problem-1');
      expect(prisma.productionProblem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'shift_balance_mismatch', orderId: 'co1' }),
        }),
      );
      const eventTypes = audit.record.mock.calls.map((c: any[]) => c[0].type);
      expect(eventTypes).toContain('problem:shift_balance_mismatch');
      expect(eventTypes).toContain('notification:production_problem_received');
    });

    it('marks a nearly empty bag as consumed', async () => {
      const { service, prisma } = closeSetup({ captures: [{ netKg: 474 }] });
      await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 0.5 }]));
      expect(prisma.bigBagUnit.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'bag-1' },
          data: expect.objectContaining({ status: 'consumed' }),
        }),
      );
    });

    it('treats consumption without production as a mismatch', async () => {
      const { service } = closeSetup({ captures: [] });
      const result = await service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 480 }]));
      expect(result.balance.status).toBe('mismatch');
      expect(result.balance.expectedUsageKg).toBe(0);
    });

    it('rejects a close that misses a used bag', async () => {
      const { service } = closeSetup({
        usages: [
          { id: 'usage-1', bigBagId: 'bag-1', startKg: 500, endKg: null, bigBag: bag() },
          {
            id: 'usage-2',
            bigBagId: 'bag-2',
            startKg: 300,
            endKg: null,
            bigBag: bag({ id: 'bag-2', code: 'BB-15803-02' }),
          },
        ],
      });
      await expect(
        service.close(OPERATOR, closeDto([{ bigBagId: 'bag-1', endKg: 400 }])),
      ).rejects.toThrow(/BB-15803-02/);
    });
  });
});
