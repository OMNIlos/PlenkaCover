import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OperatorService } from './operator.service';
import { OperatorSessionService } from './operator-session.service';
import { OperatorShiftService } from './operator-shift.service';
import { OperatorDeviceBindingService } from './operator-device-binding.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { SCALE_ADAPTER } from '../../integrations/scale/scale.adapter';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';

function lineWith(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    rollDispatchItemId: 'r1',
    planKg: 41.2,
    spoolKg: null,
    grossKg: null,
    netKg: null,
    toleranceOk: null,
    step: 'assigned',
    labelState: 'not_printed',
    warehouseState: 'not_ready',
    qrCode: null,
    rollDispatchItem: {
      id: 'd1',
      rollCode: 'A-1024-roll-1',
      replacesDispatchItemId: null,
      orderLineId: 'pos1',
      postId: 'post-1',
      assignedOperatorId: 'u1',
      status: 'assigned',
      productionOrderId: 'po1',
      productionOrder: {
        id: 'po1',
        commercialOrderId: 'co1',
        commercialOrder: {
          orderNumber: 'A-1024',
          counterparty: { displayName: 'УралПак', legalName: 'ООО УралПак' },
        },
      },
    },
    ...overrides,
  };
}

function setup(line = lineWith(), scaleReading?: Record<string, unknown>) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: line.rollDispatchItemId }]),
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue(line),
      findMany: jest.fn().mockResolvedValue([line]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    operatorShiftMachineAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    rawMaterialStock: {
      findMany: jest.fn().mockResolvedValue([
        {
          materialId: 'rm-recycled-pvd',
          label: 'ПВД вторичное',
          rawPayload: 'FORBIDDEN_MATERIAL_RAW_PAYLOAD',
        },
      ]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ materialId: 'rm-recycled-pvd', label: 'ПВД вторичное' }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Ахметов Булат' }) },
    post: { findUnique: jest.fn().mockResolvedValue({ code: 'POST-1' }) },
    penalty: { findMany: jest.fn().mockResolvedValue([]) },
    weightCapture: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: {
      create: jest.fn().mockResolvedValue({ id: 'd1' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    defectBag: { findMany: jest.fn().mockResolvedValue([]) },
    shiftBagUsage: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'usage-1',
          bigBagId: 'bag-1',
          startKg: 500,
          endKg: null,
          addedReason: null,
          sequence: 1,
          bigBag: {
            id: 'bag-1',
            code: 'BB-PVD-15803',
            material: 'ПВД 15803-020',
            materialId: 'rm-pvd-15803',
            initialKg: 500,
          },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    },
    labelPrintJob: { create: jest.fn() },
    bigBagUnit: { findUnique: jest.fn(), update: jest.fn() },
    rollDispatchItem: {
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    operatorPostSession: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' }),
    },
    productionProblem: {
      create: jest.fn().mockResolvedValue({ id: 'p1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    domainEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    warehouseAcceptanceTask: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'wh-task-1' }),
      count: jest.fn().mockResolvedValue(0),
    },
    scanRow: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'scan-1' }),
    },
    warehouseRoll: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ rollCode: 'A-1024-roll-1' }),
    },
    deviceRuntime: {
      // kind-aware default: scale → dev-scale-1, printer → dev-printer-1 (bound to the session post)
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve({ id: `dev-${where.kind}-1`, kind: where.kind, postId: where.postId }),
        ),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  const audit = { record: jest.fn() };
  const scale = {
    read: jest
      .fn()
      .mockResolvedValue(
        scaleReading ?? { deviceId: 's1', status: 'ready', stable: true, grossKg: 2.0 },
      ),
  };
  return { prisma, audit, scale };
}

async function build(
  prisma: any,
  audit: any,
  scale: any,
  sessions?: any,
): Promise<OperatorService> {
  const sessionMock = sessions ?? {
    requireActive: jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' }),
    getCurrent: jest.fn().mockResolvedValue({
      id: 'sess-1',
      shiftId: 'shift-1',
      status: 'active',
      post: { code: 'POST-1' },
      operator: { displayName: 'Ахметов Булат' },
    }),
  };
  const mod = await Test.createTestingModule({
    providers: [
      OperatorService,
      { provide: PrismaService, useValue: prisma },
      { provide: AuditService, useValue: audit },
      { provide: SCALE_ADAPTER, useValue: scale },
      {
        provide: OperatorDeviceBindingService,
        useValue: new OperatorDeviceBindingService({
          require: jest.fn().mockResolvedValue({
            ready: true,
            devices: [{ id: 'scale-1', kind: 'scale', status: 'ready' }],
          }),
        } as never),
      },
      { provide: OperatorSessionService, useValue: sessionMock },
      {
        provide: OperatorShiftService,
        useValue: new OperatorShiftService(prisma, audit, sessionMock, {
          getClosingPayroll: jest.fn(),
        } as never),
      },
    ],
  }).compile();
  return mod.get(OperatorService);
}

const actor = { userId: 'u1', role: 'operator' as const };
const PROBLEM_OPERATION_KEY = '9a88f1d4-c13a-4e85-88b1-a2f6cad67976';

type ReportProblemState = {
  problems: Array<Record<string, unknown>>;
  events: Array<{
    type: string;
    objectId: string | undefined;
    reason: string | undefined;
    detail: unknown;
  }>;
};

function reportConflict() {
  return new Prisma.PrismaClientKnownRequestError('Transaction write conflict', {
    code: 'P2034',
    clientVersion: '6.2.1',
  });
}

async function setupStatefulProblemReporting() {
  let committed: ReportProblemState = { problems: [], events: [] };
  let active: ReportProblemState | null = null;
  let failEventAt: number | null = null;
  let eventCall = 0;
  let failAtCommit = false;

  const clone = <T>(value: T): T => structuredClone(value);
  const line = lineWith();
  const readLine = jest.fn().mockResolvedValue(line);
  const readSession = jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' });
  const problemCreate = (state: () => ReportProblemState) =>
    jest.fn(async ({ data }: any) => {
      const problem = {
        ...data,
        id: data.id ?? `problem-${state().problems.length + 1}`,
        status: 'open',
        createdAt: new Date('2026-08-08T08:00:00.000Z'),
      };
      state().problems.push(problem);
      return problem;
    });
  const eventCreate = (state: () => ReportProblemState) =>
    jest.fn(async ({ data }: any) => {
      eventCall += 1;
      if (failEventAt === eventCall) throw new Error(`event ${eventCall} failed`);
      state().events.push({
        type: data.type,
        objectId: data.objectId,
        reason: data.reason,
        detail: clone(data.detail),
      });
      return { id: `event-${eventCall}`, ...data };
    });

  const tx: any = {
    operatorPostSession: { findFirst: readSession },
    operatorRollLine: { findFirst: readLine },
    productionProblem: {
      create: problemCreate(() => active!),
      findUnique: jest.fn(
        async ({ where }: any) => active!.problems.find(({ id }) => id === where.id) ?? null,
      ),
    },
    domainEvent: {
      create: eventCreate(() => active!),
      findFirst: jest.fn(
        async ({ where }: any) =>
          active!.events.find(
            ({ type, objectId }) => type === where.type && objectId === where.objectId,
          ) ?? null,
      ),
    },
  };
  const prisma: any = {
    operatorPostSession: { findFirst: readSession },
    operatorRollLine: { findFirst: readLine },
    productionProblem: {
      create: problemCreate(() => committed),
      findUnique: jest.fn(
        async ({ where }: any) => committed.problems.find(({ id }) => id === where.id) ?? null,
      ),
    },
    domainEvent: {
      create: eventCreate(() => committed),
      findFirst: jest.fn(
        async ({ where }: any) =>
          committed.events.find(
            ({ type, objectId }) => type === where.type && objectId === where.objectId,
          ) ?? null,
      ),
    },
  };
  prisma.$transaction = jest.fn(async (callback: (client: any) => unknown) => {
    active = clone(committed);
    eventCall = 0;
    try {
      const result = await callback(tx);
      if (failAtCommit) throw reportConflict();
      committed = clone(active);
      return result;
    } finally {
      active = null;
    }
  });

  const audit = new AuditService(prisma);
  jest.spyOn(audit, 'record');
  const sessions = {
    requireActive: jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' }),
    getCurrent: jest.fn(),
  };
  const service = await build(prisma, audit, {}, sessions);

  return {
    service,
    prisma,
    tx,
    audit,
    state: () => clone(committed),
    failEvent: (call: number) => {
      failEventAt = call;
    },
    conflictAtCommit: () => {
      failAtCommit = true;
    },
  };
}

function runtimeLine(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    createdAt: new Date('2026-07-10T07:00:00.000Z'),
    sequence: 1,
    step: 'spool_weight',
    planKg: 41.2,
    spoolKg: null,
    netKg: null,
    toleranceOk: null,
    labelState: 'not_printed',
    warehouseState: 'not_ready',
    qrCode: 'QR-A-1024-roll-1',
    rollDispatchItemId: 'd1',
    rollDispatchItem: {
      rollCode: 'A-1024-roll-1',
      orderLineId: 'line-1',
      filmType: 'Рукав',
      queueRank: 10,
      priority: 1,
      machineId: 'POST-1',
      post: { name: 'Станок 1' },
      plannedLengthM: 500,
      positionSequence: 3,
      rawMaterialId: 'rm-recycled-pvd',
      recipeVersion: 'v2',
      characteristicsSnapshot: {
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        widthMm: 1700,
        birka: 'ГОСТ',
        manualBirka: 'Маркировка А-17',
        comment: 'Комментарий для производства',
      },
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
      productionOrder: {
        id: 'po1',
        commercialOrder: {
          orderNumber: 'A-1024',
          comment: 'Позвонить перед запуском',
          counterparty: { displayName: 'УралПак', legalName: 'ООО «УралПак»' },
        },
      },
    },
    ...over,
  };
}

describe('OperatorService runtime', () => {
  afterEach(() => {
    delete process.env.OPERATOR_YIELD_RATIO;
    jest.useRealTimers();
  });

  it('getRuntime exposes an upcoming assignment as scheduled, not ready to open', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T18:45:00.000Z'));
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    const sessions = {
      requireActive: jest.fn(),
      getCurrent: jest.fn().mockResolvedValue(null),
    };
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
      shiftId: 'shift-1',
      status: 'planned',
      shift: {
        id: 'shift-1',
        status: 'planned',
        plannedStartAt: new Date('2026-07-23T15:22:32.000Z'),
        plannedEndAt: new Date('2026-07-23T23:22:32.000Z'),
      },
      post: { code: 'POST-2' },
      operator: { displayName: 'Илья Ковалёв' },
    });
    const service = await build(prisma, audit, scale, sessions);
    const runtime = await service.getRuntime(actor);
    expect(runtime.orders).toHaveLength(1);
    expect(runtime.shift).toEqual(
      expect.objectContaining({
        status: 'scheduled',
        workplace: 'POST-2',
        plannedStartAt: '2026-07-23T15:22:32.000Z',
        plannedEndAt: '2026-07-23T23:22:32.000Z',
      }),
    );
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operatorId: actor.userId,
          shift: expect.objectContaining({
            status: { in: ['planned', 'open'] },
            OR: [
              { plannedStartAt: null, plannedEndAt: null },
              { plannedEndAt: { gt: expect.any(Date) } },
            ],
          }),
        }),
        orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
      }),
    );
    expect(sessions.requireActive).not.toHaveBeenCalled();
  });

  it('getRuntime excludes expired legacy assignment windows', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue(null);
    const sessions = {
      requireActive: jest.fn(),
      getCurrent: jest.fn().mockResolvedValue(null),
    };
    const service = await build(prisma, audit, scale, sessions);

    await expect(service.getRuntime(actor)).resolves.toMatchObject({ shift: null });
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shift: expect.objectContaining({
            OR: [
              { plannedStartAt: null, plannedEndAt: null },
              { plannedEndAt: { gt: new Date('2026-07-27T12:00:00.000Z') } },
            ],
          }),
        }),
      }),
    );
  });

  it('getRuntime exposes an assigned individual shift without a planned window', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue({
      id: 'assignment-individual',
      shiftId: 'shift-individual',
      status: 'planned',
      createdAt: new Date('2026-07-27T08:00:00.000Z'),
      shift: {
        id: 'shift-individual',
        status: 'planned',
        plannedStartAt: null,
        plannedEndAt: null,
      },
      post: { code: 'POST-3' },
      operator: { displayName: 'Анна Соколова' },
    });
    const sessions = {
      requireActive: jest.fn(),
      getCurrent: jest.fn().mockResolvedValue(null),
    };
    const service = await build(prisma, audit, scale, sessions);

    const runtime = await service.getRuntime(actor);

    expect(runtime.shift).toEqual({
      id: 'shift-individual',
      status: 'start_missing',
      operatorName: 'Анна Соколова',
      workplace: 'POST-3',
    });
    expect(prisma.operatorShiftMachineAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          operatorId: actor.userId,
          status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
          shift: {
            status: { in: ['planned', 'open'] },
            OR: [
              { plannedStartAt: null, plannedEndAt: null },
              { plannedEndAt: { gt: expect.any(Date) } },
            ],
          },
        },
        orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
      }),
    );
  });

  it('getRuntime exposes a current planned assignment as ready for the Big-bag start gate', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T18:45:00.000Z'));
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    prisma.operatorShiftMachineAssignment.findFirst.mockResolvedValue({
      id: 'assignment-current',
      shiftId: 'shift-current',
      status: 'planned',
      shift: {
        id: 'shift-current',
        status: 'planned',
        plannedStartAt: new Date('2026-07-22T18:00:00.000Z'),
        plannedEndAt: new Date('2026-07-23T02:00:00.000Z'),
      },
      post: { code: 'POST-1' },
      operator: { displayName: 'Сергей Волков' },
    });
    const sessions = {
      requireActive: jest.fn(),
      getCurrent: jest.fn().mockResolvedValue(null),
    };
    const service = await build(prisma, audit, scale, sessions);

    const runtime = await service.getRuntime(actor);

    expect(runtime.shift).toEqual(
      expect.objectContaining({
        status: 'start_missing',
        workplace: 'POST-1',
        plannedStartAt: '2026-07-22T18:00:00.000Z',
      }),
    );
  });

  it('getRuntime never falls back to every operator when the actor has no user id', async () => {
    const { prisma, audit, scale } = setup();
    const service = await build(prisma, audit, scale);
    const runtime = await service.getRuntime({ userId: null, role: 'operator' });
    expect(runtime.orders).toEqual([]);
    expect(prisma.operatorRollLine.findMany).not.toHaveBeenCalled();
  });

  it('getRuntime fails closed when an active session has no shift binding', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([]);
    const sessions = {
      requireActive: jest.fn(),
      getCurrent: jest.fn().mockResolvedValue({
        id: 'legacy-session',
        shiftId: null,
        status: 'active',
        startedAt: new Date('2026-07-13T06:00:00Z'),
        post: { code: 'POST-1' },
        operator: { displayName: 'Оператор' },
      }),
    };
    const service = await build(prisma, audit, scale, sessions);

    await expect(service.getRuntime(actor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_SHIFT_REQUIRED' }),
    });
    expect(prisma.operatorRollLine.findMany).not.toHaveBeenCalled();
  });

  it('getRuntime groups rolls by order and hoists the current roll to the order', async () => {
    process.env.OPERATOR_YIELD_RATIO = '0.5';
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine(),
      runtimeLine({
        id: 'l2',
        sequence: 2,
        step: 'warehouse',
        spoolKg: 2,
        netKg: 41,
        toleranceOk: true,
        labelState: 'verified',
        warehouseState: 'sent',
        qrCode: 'QR-A-1024-roll-2',
        rollDispatchItemId: 'd2',
        rollDispatchItem: {
          rollCode: 'A-1024-roll-2',
          filmType: 'Рукав',
          queueRank: 20,
          priority: 1,
          machineId: 'POST-1',
          post: { name: 'Станок 1' },
          plannedLengthM: 500,
          characteristicsSnapshot: { actualThickness: '80 мкм' },
          updatedAt: new Date('2026-07-10T08:05:00.000Z'),
          productionOrder: {
            id: 'po1',
            commercialOrder: {
              orderNumber: 'A-1024',
              counterparty: { displayName: 'УралПак', legalName: 'ООО «УралПак»' },
            },
          },
        },
      }),
    ]);
    const service = await build(prisma, audit, scale);
    const rt = await service.getRuntime(actor);
    expect(rt.orders).toHaveLength(1);
    const order = rt.orders[0];
    expect(order.id).toBe('A-1024');
    expect(order.plannedRolls).toBe(2);
    expect(order.completedRolls).toBe(1); // roll-2 handed over to the warehouse bridge
    expect(order.currentRoll).toBe(1); // first not-completed roll
    expect(order.status).toBe('spool_weight');
    expect(order.rolls).toHaveLength(2);
    expect(rt.shift?.workplace).toBe('POST-1');
    expect(rt.shift?.yieldRatio).toBe(1);
    expect(rt.shift?.plannedConsumptionKg).toBe(41.2);
    expect(rt.shift?.plannedUsageKg).toBe(41.2);
    expect(rt.shift?.expectedEndKg).toBe(458.8);
  });

  it('projects the spool policy and keeps gross and net roll weight distinct', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        spoolKg: 0.7,
        grossKg: 41.9,
        netKg: 41.2,
        toleranceOk: true,
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          characteristicsSnapshot: {
            ...runtimeLine().rollDispatchItem.characteristicsSnapshot,
            spoolType: 'Тонкая',
          },
        },
      }),
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0].rolls[0]).toEqual(
      expect.objectContaining({
        spoolWeightPolicy: 'standard_700g',
        spoolKg: 0.7,
        grossKg: 41.9,
        netKg: 41.2,
        toleranceOk: true,
      }),
    );
  });

  it('projects the current defect bag without its QR or printer internals', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    prisma.defectBag.findMany.mockResolvedValue([{
      id: 'defect-bag-1',
      code: 'DEF-sess-1',
      status: 'ready_for_warehouse',
      defectType: 'primary',
      weightKg: 3.2,
      recordedDefectKg: 3,
      differenceKg: 0.2,
      weighedAt: new Date('2026-09-06T17:00:00.000Z'),
      scanToken: { token: 'FORBIDDEN_QR_TOKEN' },
      labelPrintJobs: [{ status: 'failed', failureReason: 'FORBIDDEN_PRINTER_ERROR' }],
    }]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.shift?.defectBag).toEqual({
      id: 'defect-bag-1',
      code: 'DEF-sess-1',
      status: 'ready_for_warehouse',
      defectType: 'primary',
      weightKg: 3.2,
      recordedDefectKg: 3,
      differenceKg: 0.2,
      labelState: 'failed',
      weighedAt: '2026-09-06T17:00:00.000Z',
    });
    expect(runtime.shift?.defectBags).toEqual([runtime.shift?.defectBag]);
    expect(prisma.defectBag.findMany).toHaveBeenCalledWith({
      where: { postSessionId: 'sess-1' },
      orderBy: [{ weighedAt: 'asc' }, { id: 'asc' }],
      include: {
        labelPrintJobs: {
          select: { status: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
    });
    expect(JSON.stringify(runtime)).not.toContain('FORBIDDEN');
  });

  it('keeps global queue rank while projecting bounded local roll progress', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        id: 'line-global-885',
        sequence: 885,
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          queueRank: 885,
        },
      }),
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0]).toEqual(
      expect.objectContaining({
        progress: { current: 1, completed: 0, total: 1 },
        currentRoll: 1,
        completedRolls: 0,
        plannedRolls: 1,
        rolls: [expect.objectContaining({ queueRank: 885, sequenceNumber: 1 })],
      }),
    );
  });

  it('keeps a defect attempt visible without inflating planned roll progress or blocking its replacement', async () => {
    const { prisma, audit, scale } = setup();
    const source = runtimeLine();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        id: 'line-defect',
        step: 'defect',
        netKg: 9.8,
        rollDispatchItemId: 'dispatch-defect',
        rollDispatchItem: {
          ...source.rollDispatchItem,
          id: 'dispatch-defect',
          rollCode: 'A-1024-roll-1',
          status: 'defect',
          replacesDispatchItemId: null,
          queueRank: 10,
        },
      }),
      runtimeLine({
        id: 'line-replacement',
        step: 'assigned',
        rollDispatchItemId: 'dispatch-replacement',
        rollDispatchItem: {
          ...source.rollDispatchItem,
          id: 'dispatch-replacement',
          rollCode: 'A-1024-roll-1-R1',
          status: 'assigned',
          replacesDispatchItemId: 'dispatch-defect',
          queueRank: 11,
        },
      }),
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0]).toEqual(
      expect.objectContaining({
        progress: { current: 1, completed: 0, total: 1 },
        currentRoll: 1,
        currentDispatchItemId: 'dispatch-replacement',
        plannedRolls: 1,
        completedRolls: 0,
        status: 'assigned',
        rolls: [
          expect.objectContaining({
            id: 'A-1024-roll-1',
            sequenceNumber: 1,
            attemptNumber: 1,
            status: 'defect',
            replacesDispatchItemId: null,
          }),
          expect.objectContaining({
            id: 'A-1024-roll-1-R1',
            sequenceNumber: 1,
            attemptNumber: 2,
            status: 'assigned',
            replacesDispatchItemId: 'dispatch-defect',
          }),
        ],
      }),
    );
    expect(runtime.shift?.plannedConsumptionKg).toBe(41.2);
  });

  it('sorts each order by queue rank, then createdAt and id before numbering rolls', async () => {
    const { prisma, audit, scale } = setup();
    const dispatch = runtimeLine().rollDispatchItem;
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        id: 'line-z',
        createdAt: new Date('2026-07-10T08:02:00.000Z'),
        rollDispatchItemId: 'dispatch-z',
        rollDispatchItem: { ...dispatch, rollCode: 'roll-z', queueRank: 9 },
      }),
      runtimeLine({
        id: 'line-rank-8',
        createdAt: new Date('2026-07-10T08:03:00.000Z'),
        rollDispatchItemId: 'dispatch-rank-8',
        rollDispatchItem: { ...dispatch, rollCode: 'roll-rank-8', queueRank: 8 },
      }),
      runtimeLine({
        id: 'line-b',
        createdAt: new Date('2026-07-10T08:01:00.000Z'),
        rollDispatchItemId: 'dispatch-b',
        rollDispatchItem: { ...dispatch, rollCode: 'roll-b', queueRank: 9 },
      }),
      runtimeLine({
        id: 'line-a',
        createdAt: new Date('2026-07-10T08:01:00.000Z'),
        rollDispatchItemId: 'dispatch-a',
        rollDispatchItem: { ...dispatch, rollCode: 'roll-a', queueRank: 9 },
      }),
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(
      runtime.orders[0].rolls.map(({ id, sequenceNumber }) => ({ id, sequenceNumber })),
    ).toEqual([
      { id: 'roll-rank-8', sequenceNumber: 1 },
      { id: 'roll-a', sequenceNumber: 2 },
      { id: 'roll-b', sequenceNumber: 3 },
      { id: 'roll-z', sequenceNumber: 4 },
    ]);
  });

  it('getRuntime scopes published rolls to the active post-session shift', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    const service = await build(prisma, audit, scale);

    await service.getRuntime(actor);

    expect(prisma.operatorRollLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rollDispatchItem: expect.objectContaining({
            assignedOperatorId: actor.userId,
            OR: expect.arrayContaining([{ plannedShiftId: 'shift-1' }]),
          }),
        }),
      }),
    );
  });

  it('getRuntime keeps completed rolls visible after the operator opens another shift', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    const service = await build(prisma, audit, scale);

    await service.getRuntime(actor);

    expect(prisma.operatorRollLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rollDispatchItem: expect.objectContaining({
            assignedOperatorId: actor.userId,
            OR: [
              { plannedShiftId: 'shift-1' },
              { status: { in: ['defect', 'ready_for_warehouse', 'done'] } },
            ],
          }),
        }),
      }),
    );
  });

  it('getRuntime never projects customer identity and keeps production parameters', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([runtimeLine()]);
    const service = await build(prisma, audit, scale);
    const rt = await service.getRuntime(actor);
    expect(prisma.operatorRollLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          rollDispatchItem: expect.objectContaining({
            include: expect.objectContaining({
              productionOrder: {
                select: {
                  id: true,
                  commercialOrder: { select: { orderNumber: true, comment: true } },
                },
              },
            }),
          }),
        }),
      }),
    );
    const json = JSON.stringify(rt);
    expect(json).not.toMatch(/counterparty|customer|client|alias/iu);
    expect(json).not.toContain('УралПак');
    expect(json).not.toContain('ООО «УралПак»');
    expect(rt.orders[0]).toMatchObject({ id: 'A-1024' });
    expect(rt.orders[0]).toMatchObject({
      commercialComment: 'Позвонить перед запуском',
    });
    expect(rt.orders[0].rolls[0]).toMatchObject({
      filmType: 'Рукав',
      orderLineId: 'line-1',
      positionSequence: 3,
      plannedLengthM: 500,
      characteristicsSnapshot: {
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        widthMm: 1700,
        birka: 'ГОСТ',
        manualBirka: 'Маркировка А-17',
        comment: 'Комментарий для производства',
      },
    });
  });

  it('getRuntime safely projects the immutable recipe name, version and composition', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          rawMaterialId: null,
          characteristicsSnapshot: {
            ...runtimeLine().rollDispatchItem.characteristicsSnapshot,
            recipe: {
              recipeDefinitionVersionId: 'recipe-version-3',
              name: 'Синяя смесь',
              version: 3,
              ingredients: [
                {
                  rawMaterialDefinitionId: 'material-primary',
                  name: 'Первичное',
                  shareBasisPoints: 8000,
                },
                {
                  rawMaterialDefinitionId: 'material-blue',
                  name: 'Синий краситель',
                  shareBasisPoints: 2000,
                },
              ],
              rawPayload: 'FORBIDDEN_RECIPE_RAW_PAYLOAD',
            },
            recipeParameters: [
              { label: 'Сырьё', value: 'Синяя смесь 80/20' },
              { label: 'План. вес, кг', value: '41,2' },
              { label: 'Вид оплаты', value: 'Безналичный расчёт' },
              { label: 'Рассрочка', value: '30 дней' },
            ],
          },
        },
      }),
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0].rolls[0].characteristicsSnapshot).toMatchObject({
      recipe: {
        name: 'Синяя смесь',
        version: 3,
        ingredients: [
          { name: 'Первичное', shareBasisPoints: 8000 },
          { name: 'Синий краситель', shareBasisPoints: 2000 },
        ],
      },
      legacyRecipeName: 'Синяя смесь 80/20',
    });
    const json = JSON.stringify(runtime);
    expect(json).not.toContain('recipeDefinitionVersionId');
    expect(json).not.toContain('rawMaterialDefinitionId');
    expect(json).not.toContain('FORBIDDEN_RECIPE_RAW_PAYLOAD');
    expect(json).not.toContain('План. вес');
    expect(json).not.toContain('Вид оплаты');
    expect(json).not.toContain('Рассрочка');
  });

  it('getRuntime safely projects the corrected material snapshot with one batch lookup', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          characteristicsSnapshot: {
            actualThickness: '80 мкм',
            rawPayload: 'FORBIDDEN_SNAPSHOT_RAW_PAYLOAD',
            deviceSecret: 'FORBIDDEN_DEVICE_SECRET',
          },
        },
      }),
      runtimeLine({
        id: 'l2',
        sequence: 2,
        rollDispatchItemId: 'd2',
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          rollCode: 'A-1024-roll-2',
          positionSequence: 4,
          rawMaterialId: 'rm-recycled-pvd',
          recipeVersion: 'v3',
        },
      }),
      runtimeLine({
        id: 'l3',
        sequence: 3,
        rollDispatchItemId: 'd3',
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          rollCode: 'A-1024-roll-3',
          positionSequence: 5,
          rawMaterialId: 'rm-virgin-pvd',
          recipeVersion: 'v1',
        },
      }),
    ]);
    prisma.rawMaterialStock.findMany.mockResolvedValue([
      {
        materialId: 'rm-recycled-pvd',
        label: 'ПВД вторичное',
        rawPayload: 'FORBIDDEN_MATERIAL_RAW_PAYLOAD',
      },
      {
        materialId: 'rm-virgin-pvd',
        label: 'ПВД первичное',
        rawPayload: 'FORBIDDEN_SECOND_MATERIAL_RAW_PAYLOAD',
      },
    ]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0].rolls).toEqual([
      expect.objectContaining({
        positionSequence: 3,
        rawMaterialId: 'rm-recycled-pvd',
        rawMaterialLabel: 'ПВД вторичное',
        recipeVersion: 'v2',
      }),
      expect.objectContaining({
        positionSequence: 4,
        rawMaterialId: 'rm-recycled-pvd',
        rawMaterialLabel: 'ПВД вторичное',
        recipeVersion: 'v3',
      }),
      expect.objectContaining({
        positionSequence: 5,
        rawMaterialId: 'rm-virgin-pvd',
        rawMaterialLabel: 'ПВД первичное',
        recipeVersion: 'v1',
      }),
    ]);
    expect(prisma.rawMaterialStock.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.rawMaterialStock.findMany).toHaveBeenCalledWith({
      where: { materialId: { in: ['rm-recycled-pvd', 'rm-virgin-pvd'] } },
      select: { materialId: true, label: true },
    });
    expect(JSON.stringify(runtime)).not.toContain('rawPayload');
    expect(JSON.stringify(runtime)).not.toContain('FORBIDDEN_MATERIAL_RAW_PAYLOAD');
    expect(JSON.stringify(runtime)).not.toContain('FORBIDDEN_SECOND_MATERIAL_RAW_PAYLOAD');
    expect(JSON.stringify(runtime)).not.toContain('FORBIDDEN_SNAPSHOT_RAW_PAYLOAD');
    expect(JSON.stringify(runtime)).not.toContain('FORBIDDEN_DEVICE_SECRET');
    expect(JSON.stringify(runtime)).not.toContain('ООО «УралПак»');
  });

  it('getRuntime uses a null label when the material id is unknown', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findMany.mockResolvedValue([
      runtimeLine({
        rollDispatchItem: {
          ...runtimeLine().rollDispatchItem,
          rawMaterialId: 'rm-unknown',
        },
      }),
    ]);
    prisma.rawMaterialStock.findMany.mockResolvedValue([]);
    const service = await build(prisma, audit, scale);

    const runtime = await service.getRuntime(actor);

    expect(runtime.orders[0].rolls[0]).toEqual(
      expect.objectContaining({ rawMaterialId: 'rm-unknown', rawMaterialLabel: null }),
    );
  });
});

describe('OperatorService penalties', () => {
  it('returns only penalties addressed to the authenticated operator', async () => {
    const { prisma, audit, scale } = setup();
    prisma.penalty.findMany.mockResolvedValue([{ id: 'pen-1', employeeId: 'u1' }]);
    const service = await build(prisma, audit, scale);
    const penalties = await service.listPenalties(actor);
    expect(prisma.penalty.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { employeeId: 'u1', targetRole: 'operator' } }),
    );
    expect(penalties).toEqual([{ id: 'pen-1', employeeId: 'u1' }]);
  });

  it('returns no penalties without a real operator identity', async () => {
    const { prisma, audit, scale } = setup();
    const service = await build(prisma, audit, scale);
    await expect(service.listPenalties({ userId: null, role: 'operator' })).resolves.toEqual([]);
    expect(prisma.penalty.findMany).not.toHaveBeenCalled();
  });
});

describe('OperatorService problems', () => {
  it('rejects generic defect reporting before opening a transaction', async () => {
    const { prisma, audit, scale } = setup();
    const service = await build(prisma, audit, scale);

    await expect(
      service.reportProblem(
        { userId: 'operator-1', role: 'operator' },
        {
          operationKey: PROBLEM_OPERATION_KEY,
          type: 'defect' as never,
          rollId: 'A-1024-roll-1',
          reason: 'Повреждение полотна',
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_DEFECT_PHYSICAL_CAPTURE_REQUIRED' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([1])(
    'rolls back the problem and every event when required event %i fails',
    async (eventNumber) => {
      const { service, failEvent, state } = await setupStatefulProblemReporting();
      failEvent(eventNumber);

      await expect(
        service.reportProblem(
          { userId: 'operator-1', role: 'operator' },
          {
            operationKey: PROBLEM_OPERATION_KEY,
            type: 'raw_material_shortage',
            rollId: 'A-1024-roll-1',
            reason: 'ПВД закончился',
          },
        ),
      ).rejects.toThrow(`event ${eventNumber} failed`);

      expect(state()).toEqual({ problems: [], events: [] });
    },
  );

  it('creates a generic problem and exactly one required event atomically', async () => {
    const { service, prisma, tx, audit, state } = await setupStatefulProblemReporting();
    const expectedFingerprint = requestFingerprint({
      action: 'operator_problem_report',
      operatorId: 'operator-1',
      type: 'general',
      rollId: 'A-1024-roll-1',
      reason: 'Остановка линии',
      recovery: null,
    });

    await service.reportProblem(
      { userId: 'operator-1', role: 'operator' },
      {
        operationKey: PROBLEM_OPERATION_KEY,
        rollId: 'A-1024-roll-1',
        reason: 'Остановка линии',
      },
    );

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'problem:operator_reported',
        objectId: PROBLEM_OPERATION_KEY,
      }),
      tx,
    );
    expect(state().problems).toEqual([
      expect.objectContaining({ id: PROBLEM_OPERATION_KEY, type: 'general' }),
    ]);
    expect(state().events).toEqual([
      {
        type: 'problem:operator_reported',
        objectId: PROBLEM_OPERATION_KEY,
        reason: 'Остановка линии',
        detail: {
          problemId: PROBLEM_OPERATION_KEY,
          problemType: 'general',
          orderId: 'co1',
          positionId: 'pos1',
          rollId: 'A-1024-roll-1',
          operatorId: 'operator-1',
          postId: 'post-1',
          reason: 'Остановка линии',
          recovery: null,
          requestFingerprint: expectedFingerprint,
        },
      },
    ]);
  });

  it('persists a shortage as the same single routed event vocabulary', async () => {
    const { service, state } = await setupStatefulProblemReporting();

    await service.reportProblem(
      { userId: 'operator-1', role: 'operator' },
      {
        operationKey: PROBLEM_OPERATION_KEY,
        type: 'raw_material_shortage',
        rollId: 'A-1024-roll-1',
        reason: 'ПВД закончился',
        recovery: 'Нужна согласованная замена',
      },
    );

    expect(state().events).toEqual([
      {
        type: 'problem:operator_reported',
        objectId: PROBLEM_OPERATION_KEY,
        reason: 'ПВД закончился',
        detail: expect.objectContaining({
          problemType: 'raw_material_shortage',
          reason: 'ПВД закончился',
          recovery: 'Нужна согласованная замена',
        }),
      },
    ]);
  });

  it('maps a retryable serializable reporting conflict to 409 without committed writes', async () => {
    const { service, conflictAtCommit, state } = await setupStatefulProblemReporting();
    conflictAtCommit();

    await expect(
      service.reportProblem(
        { userId: 'operator-1', role: 'operator' },
        {
          operationKey: PROBLEM_OPERATION_KEY,
          type: 'raw_material_shortage',
          rollId: 'A-1024-roll-1',
          reason: 'ПВД закончился',
        },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(state()).toEqual({ problems: [], events: [] });
  });

  it('routes a typed material shortage from the actor roll and active post', async () => {
    const { prisma, audit, scale } = setup();
    prisma.productionProblem.create.mockResolvedValue({
      id: 'p-shortage-1',
      type: 'raw_material_shortage',
      status: 'open',
    });
    const sessions = {
      requireActive: jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' }),
      getCurrent: jest.fn(),
    };
    const service = await build(prisma, audit, scale, sessions);

    await service.reportProblem(
      { userId: 'operator-1', role: 'operator' },
      {
        operationKey: PROBLEM_OPERATION_KEY,
        type: 'raw_material_shortage',
        rollId: 'A-1024-roll-1',
        reason: 'ПВД закончился',
        recovery: 'Нужна замена сырья',
      },
    );

    expect(prisma.operatorRollLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rollDispatchItem: expect.objectContaining({
            rollCode: 'A-1024-roll-1',
            assignedOperatorId: 'operator-1',
            postId: 'post-1',
          }),
        }),
      }),
    );
    expect(prisma.productionProblem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: PROBLEM_OPERATION_KEY,
        type: 'raw_material_shortage',
        orderId: 'co1',
        positionId: 'pos1',
        rollId: 'A-1024-roll-1',
        actorRole: 'operator',
      }),
      select: expect.any(Object),
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:operator_reported' }),
      prisma,
    );
  });

  it('rejects a shortage for a roll outside the actor post', async () => {
    const { prisma, audit, scale } = setup();
    prisma.operatorRollLine.findFirst.mockResolvedValue(null);
    const service = await build(prisma, audit, scale);

    await expect(
      service.reportProblem(
        { userId: 'operator-1', role: 'operator' },
        {
          operationKey: PROBLEM_OPERATION_KEY,
          type: 'raw_material_shortage',
          rollId: 'foreign-roll',
          reason: 'Нет сырья',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.operatorRollLine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rollDispatchItem: expect.objectContaining({
            assignedOperatorId: 'operator-1',
            postId: 'post-1',
          }),
        }),
      }),
    );
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
  });

  it('rejects a problem without an authenticated operator before any side effect', async () => {
    const { prisma, audit, scale } = setup();
    const sessions = {
      requireActive: jest.fn().mockResolvedValue({ id: 'sess-1', postId: 'post-1' }),
      getCurrent: jest.fn(),
    };
    const service = await build(prisma, audit, scale, sessions);

    await expect(
      service.reportProblem(
        { userId: null, role: 'operator' },
        {
          operationKey: PROBLEM_OPERATION_KEY,
          rollId: 'A-1024-roll-1',
          reason: 'Нет сырья',
        },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.requireActive).not.toHaveBeenCalled();
    expect(prisma.operatorRollLine.findFirst).not.toHaveBeenCalled();
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps a generic operator problem compatible when type is omitted', async () => {
    const { prisma, audit, scale } = setup();
    prisma.productionProblem.create.mockResolvedValue({
      id: 'p-general-1',
      type: 'general',
      status: 'open',
    });
    const service = await build(prisma, audit, scale);

    await service.reportProblem(
      { userId: 'operator-1', role: 'operator' },
      {
        operationKey: PROBLEM_OPERATION_KEY,
        rollId: 'A-1024-roll-1',
        reason: 'Остановка линии',
      },
    );

    expect(prisma.productionProblem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'general' }),
      select: expect.any(Object),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'problem:operator_reported' }),
      prisma,
    );
  });

  it('returns the immutable problem on retry and rejects changed key reuse', async () => {
    const { service, state } = await setupStatefulProblemReporting();
    const input = {
      operationKey: PROBLEM_OPERATION_KEY,
      type: 'raw_material_shortage' as const,
      rollId: 'A-1024-roll-1',
      reason: 'ПВД закончился',
      recovery: 'Подать новую партию',
    };

    const first = await service.reportProblem({ userId: 'operator-1', role: 'operator' }, input);
    const replay = await service.reportProblem({ userId: 'operator-1', role: 'operator' }, input);

    expect(replay).toEqual(first);
    expect(state().problems).toHaveLength(1);
    expect(state().events).toHaveLength(1);

    await expect(
      service.reportProblem(
        { userId: 'operator-1', role: 'operator' },
        { ...input, reason: 'Изменённое сообщение' },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_PROBLEM_OPERATION_KEY_REUSED' }),
    });
    expect(state().problems).toHaveLength(1);
    expect(state().events).toHaveLength(1);
  });

  it('returns the concurrent winner after a unique-key race without another write', async () => {
    const { prisma, audit, scale } = setup();
    const input = {
      operationKey: PROBLEM_OPERATION_KEY,
      type: 'general' as const,
      rollId: 'A-1024-roll-1',
      reason: 'Остановка линии',
    };
    const winner = {
      id: PROBLEM_OPERATION_KEY,
      type: 'general',
      status: 'open',
      orderId: 'co1',
      positionId: 'pos1',
      rollId: input.rollId,
      actorRole: 'operator',
      reason: input.reason,
      recovery: null,
      createdAt: new Date('2026-08-08T08:00:00.000Z'),
    };
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique key race', {
        code: 'P2002',
        clientVersion: '6.19.3',
      }),
    );
    prisma.productionProblem.findUnique.mockResolvedValue(winner);
    prisma.domainEvent.findFirst.mockResolvedValue({
      detail: {
        requestFingerprint: requestFingerprint({
          action: 'operator_problem_report',
          operatorId: 'operator-1',
          type: input.type,
          rollId: input.rollId,
          reason: input.reason,
          recovery: null,
        }),
      },
    });
    const service = await build(prisma, audit, scale);

    await expect(
      service.reportProblem({ userId: 'operator-1', role: 'operator' }, input),
    ).resolves.toEqual(winner);
    expect(prisma.productionProblem.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('OperatorService manual big-bag exception', () => {
  it('records an explicitly manual big-bag weight as an audited fact', async () => {
    const { prisma, audit, scale } = setup();
    prisma.bigBagUnit.findUnique.mockResolvedValue({ code: 'BB-1', currentKg: 500 });
    prisma.bigBagUnit.update.mockResolvedValue({ code: 'BB-1', currentKg: 480 });
    const service = await build(prisma, audit, scale);

    await service.bigBagWeight(actor, 'BB-1', { kg: 480 });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:bigbag_weight_recorded' }),
    );
  });
});
