import { OperatorService } from './operator.service';
import { OperatorShiftService } from './operator-shift.service';
import { OperatorDeviceBindingService } from './operator-device-binding.service';

const OPERATOR = { userId: 'operator-1', role: 'operator' as const };

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    rollDispatchItemId: 'r1',
    sequence: 1,
    planKg: 41.2,
    spoolKg: null,
    netKg: null,
    toleranceOk: null,
    step: 'spool_weight',
    deferredFromStep: null,
    labelState: 'not_printed',
    warehouseState: 'not_ready',
    qrCode: null,
    createdAt: new Date('2026-07-13T07:00:00Z'),
    rollDispatchItem: {
      id: 'r1',
      rollCode: 'A-1024-roll-1',
      orderLineId: 'pos1',
      positionSequence: 1,
      rawMaterialId: 'rm-pvd-15803',
      recipeVersion: 'v1',
      filmType: 'ПВД',
      plannedLengthM: null,
      machineId: 'POST-1',
      queueRank: 1,
      priority: 5,
      status: 'assigned',
      characteristicsSnapshot: null,
      updatedAt: new Date('2026-07-13T07:00:00Z'),
      assignedOperatorId: 'operator-1',
      productionOrderId: 'po1',
      post: { name: 'Станок E-04' },
      productionOrder: {
        commercialOrderId: 'co1',
        commercialOrder: {
          id: 'co1',
          orderNumber: 'A-1024',
          counterpartyId: 'cp1',
          counterparty: { displayName: 'УралПак', legalName: 'ООО УралПак' },
        },
      },
    },
    ...overrides,
  };
}

function setup(lines = [line()]) {
  const prisma: any = {
    operatorRollLine: {
      findFirst: jest.fn().mockResolvedValue(lines[0]),
      findMany: jest.fn().mockResolvedValue(lines),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    rollDispatchItem: { update: jest.fn() },
    rawMaterialStock: { findMany: jest.fn().mockResolvedValue([]) },
    penalty: { findMany: jest.fn().mockResolvedValue([]) },
    defectRecord: {
      create: jest.fn().mockResolvedValue({ id: 'd1' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    defectBag: { findMany: jest.fn().mockResolvedValue([]) },
    productionProblem: { create: jest.fn().mockResolvedValue({ id: 'problem-1' }) },
    operatorShiftMachineAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
    shiftBagUsage: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'usage-1',
          bigBagId: 'bag-1',
          startKg: 500,
          endKg: null,
          addedReason: null,
          releasedReason: null,
          closedAt: null,
          sequence: 1,
          bigBag: {
            id: 'bag-1',
            code: 'BB-15803-01',
            material: 'ПВД 15803-020',
            materialId: 'rm-pvd-15803',
            initialKg: 500,
          },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
    },
    weightCapture: { findMany: jest.fn().mockResolvedValue([{ netKg: 41.4 }]) },
    labelPrintJob: { create: jest.fn() },
    user: {
      findUnique: jest.fn().mockResolvedValue({ displayName: 'Сергей Волков' }),
    },
    post: { findUnique: jest.fn().mockResolvedValue({ code: 'POST-1' }) },
    deviceRuntime: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve([
            { id: `dev-${where.kind}-1`, kind: where.kind, status: 'ready', isEnabled: true },
          ]),
        ),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve({ id: `dev-${where.kind}-1`, kind: where.kind }),
        ),
    },
  };
  prisma.rawMaterialStock.findUnique = jest
    .fn()
    .mockResolvedValue({ materialId: 'rm-pvd-15803', label: 'ПВД 15803-020' });
  prisma.$transaction = jest.fn(async (cb: (tx: any) => unknown) => cb(prisma));
  const audit = { record: jest.fn() };
  const sessions: any = {
    getCurrent: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      status: 'active',
      startedAt: new Date('2026-07-13T06:00:00Z'),
      post: { code: 'POST-1' },
      operator: { displayName: 'Сергей Волков' },
    }),
    requireActive: jest.fn().mockResolvedValue({
      id: 'sess-1',
      postId: 'post-1',
      startedAt: new Date('2026-07-13T06:00:00Z'),
    }),
  };
  const shift = new OperatorShiftService(prisma, audit as any, sessions, {
    getClosingPayroll: jest.fn(),
  } as never);
  const scale = { read: jest.fn() };
  const service = new OperatorService(
    prisma,
    audit as any,
    sessions,
    scale as any,
    shift,
    new OperatorDeviceBindingService({
      require: jest.fn().mockResolvedValue({
        ready: true,
        devices: [{ id: 'scale-1', kind: 'scale', status: 'ready' }],
      }),
    } as never),
  );
  return { service, prisma, audit, shift };
}

describe('operator runtime with shift bags', () => {
  it('projects bags, planned consumption, estimate and pending balance', async () => {
    const { service } = setup();
    const runtime = await service.getRuntime(OPERATOR);
    expect(runtime.shift?.status).toBe('active');
    expect(runtime.shift?.bags).toEqual([
      expect.objectContaining({
        bagId: 'bag-1',
        code: 'BB-15803-01',
        material: 'ПВД 15803-020',
        warehouseKg: 500,
        startKg: 500,
        active: true,
        releasedAt: null,
      }),
    ]);
    expect(runtime.shift?.bigBagId).toBe('BB-15803-01');
    expect(runtime.shift?.startKg).toBe(500);
    // 1 remaining roll × 41.2 planKg, accounted one-to-one.
    expect(runtime.shift?.plannedConsumptionKg).toBeCloseTo(41.2, 3);
    expect(runtime.shift?.yieldRatio).toBe(1);
    expect(runtime.shift?.estimatedMinutes).toBe(25);
    expect(runtime.shift?.balance?.status).toBe('pending');
  });

  it('reports a Big-Bag shortage separately instead of projecting a negative physical weight', async () => {
    const { service, prisma } = setup([line({ planKg: 100 })]);
    prisma.weightCapture.findMany.mockResolvedValue([]);
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        startKg: 50,
        endKg: null,
        addedReason: null,
        releasedReason: null,
        closedAt: null,
        sequence: 1,
        episodes: [],
        bigBag: {
          id: 'bag-1',
          code: 'BB-LOW',
          material: 'ПВД',
          materialId: 'rm-pvd-15803',
          initialKg: 50,
        },
      },
    ]);

    const runtime = await service.getRuntime(OPERATOR);

    expect(runtime.shift?.expectedEndKg).toBe(0);
    expect(runtime.shift?.plannedShortageKg).toBe(50);
  });

  it('reports start_missing while the session has no bags', async () => {
    const { service, prisma } = setup();
    prisma.shiftBagUsage.findMany.mockResolvedValue([]);
    const runtime = await service.getRuntime(OPERATOR);
    expect(runtime.shift?.status).toBe('start_missing');
  });

  it('keeps released bag history and reports bag_missing until another bag is connected', async () => {
    const { service, prisma } = setup();
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        startKg: 500,
        endKg: 417.2,
        addedReason: null,
        releasedReason: 'Передача остатка',
        sequence: 1,
        closedAt: new Date('2026-07-13T10:00:00.000Z'),
        bigBag: {
          id: 'bag-1',
          code: 'BB-15803-01',
          material: 'ПВД 15803-020',
          materialId: 'rm-pvd-15803',
          initialKg: 500,
        },
      },
    ]);

    const runtime = await service.getRuntime(OPERATOR);

    expect(runtime.shift?.status).toBe('bag_missing');
    expect(runtime.shift?.bags).toEqual([
      expect.objectContaining({
        bagId: 'bag-1',
        endKg: 417.2,
        releasedReason: 'Передача остатка',
        active: false,
        releasedAt: '2026-07-13T10:00:00.000Z',
      }),
    ]);
  });

  it('computes expected residue from every confirmed episode and returned remainder', async () => {
    const { service, prisma, shift } = setup([line({ planKg: 50 })]);
    jest.spyOn(shift, 'computeBalance').mockResolvedValue({
      producedKg: 50,
      defectKg: 0,
      expectedUsageKg: 50,
      actualUsageKg: null,
      deviationPercent: null,
      status: 'pending',
    });
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        startKg: 450,
        endKg: null,
        addedReason: null,
        releasedReason: null,
        sequence: 1,
        closedAt: null,
        episodes: [
          {
            sequence: 1,
            startKg: 500,
            endKg: 450,
            closeKind: 'released',
            closedAt: new Date('2026-08-08T09:00:00.000Z'),
          },
          {
            sequence: 2,
            startKg: 450,
            endKg: null,
            closeKind: null,
            closedAt: null,
          },
        ],
        bigBag: {
          id: 'bag-1',
          code: 'BB-15803-01',
          material: 'ПВД 15803-020',
          materialId: 'rm-pvd-15803',
          initialKg: 500,
        },
      },
    ]);

    const runtime = await service.getRuntime(OPERATOR);

    expect(runtime.shift?.plannedConsumptionKg).toBe(50);
    expect(runtime.shift?.expectedEndKg).toBe(400);
  });

  it('projects the active BigBag episode without carrying material from earlier episodes', async () => {
    const baseDispatch = line().rollDispatchItem;
    const { service, prisma, shift } = setup([
      line({
        id: 'line-defect',
        planKg: 40,
        step: 'defect',
        rollDispatchItemId: 'dispatch-defect',
        rollDispatchItem: {
          ...baseDispatch,
          id: 'dispatch-defect',
          rollCode: 'A-3-roll-1',
          status: 'assigned',
        },
      }),
      line({
        id: 'line-captured-1',
        planKg: 40,
        netKg: 18,
        step: 'qr_print',
        rollDispatchItemId: 'dispatch-captured-1',
        rollDispatchItem: {
          ...baseDispatch,
          id: 'dispatch-captured-1',
          rollCode: 'A-3-roll-4',
        },
      }),
      line({
        id: 'line-current',
        planKg: 40,
        step: 'assigned',
        rollDispatchItemId: 'dispatch-current',
        rollDispatchItem: {
          ...baseDispatch,
          id: 'dispatch-current',
          rollCode: 'A-3-roll-5',
        },
      }),
      line({
        id: 'line-captured-2',
        planKg: 40,
        netKg: 18,
        step: 'qr_print',
        rollDispatchItemId: 'dispatch-captured-2',
        rollDispatchItem: {
          ...baseDispatch,
          id: 'dispatch-captured-2',
          rollCode: 'A-3-roll-1-R1',
        },
      }),
    ]);
    jest.spyOn(shift, 'computeBalance').mockResolvedValue({
      producedKg: 169.35,
      defectKg: 0,
      expectedUsageKg: 169.35,
      actualUsageKg: null,
      deviationPercent: null,
      status: 'pending',
    });
    prisma.shiftBagUsage.findMany.mockResolvedValue([
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        startKg: 4_000,
        endKg: null,
        addedReason: null,
        releasedReason: null,
        sequence: 1,
        createdAt: new Date('2026-08-11T07:00:00.000Z'),
        closedAt: null,
        episodes: [
          {
            id: 'episode-1',
            sequence: 1,
            startKg: 5_000,
            endKg: 4_000,
            openedAt: new Date('2026-08-11T07:00:00.000Z'),
            closeKind: 'released',
            closedAt: new Date('2026-08-11T07:55:00.000Z'),
          },
          {
            id: 'episode-2',
            sequence: 2,
            startKg: 4_000,
            endKg: null,
            openedAt: new Date('2026-08-11T07:58:03.205Z'),
            closeKind: null,
            closedAt: null,
          },
        ],
        bigBag: {
          id: 'bag-1',
          code: 'BB-15803-01',
          material: 'ПВД 15803-020',
          materialId: 'rm-pvd-15803',
          initialKg: 5_000,
        },
      },
    ]);
    prisma.weightCapture.findMany.mockResolvedValue([
      {
        id: 'capture-1',
        operatorRollLineId: 'line-captured-1',
        postSessionId: 'sess-1',
        kind: 'roll',
        stable: true,
        netKg: 18,
        supersedesCaptureId: null,
        createdAt: new Date('2026-08-11T07:50:00.000Z'),
      },
      {
        id: 'capture-2',
        operatorRollLineId: 'line-captured-2',
        postSessionId: 'sess-1',
        kind: 'roll',
        stable: true,
        netKg: 18,
        supersedesCaptureId: null,
        createdAt: new Date('2026-08-11T07:52:00.000Z'),
      },
    ]);

    const runtime = await service.getRuntime(OPERATOR);

    expect(runtime.shift?.balance?.expectedUsageKg).toBe(169.35);
    expect(runtime.shift?.plannedConsumptionKg).toBe(40);
    expect(runtime.shift?.startKg).toBe(4_000);
    expect(runtime.shift?.expectedEndKg).toBe(3_960);
  });

  it('hides written-off defect rolls (dispatch done + deferred step)', async () => {
    const { service } = setup([
      line(),
      line({
        id: 'l2',
        step: 'deferred',
        rollDispatchItem: {
          ...line().rollDispatchItem,
          id: 'r2',
          rollCode: 'A-1024-roll-2',
          status: 'done',
        },
      }),
    ]);
    const runtime = await service.getRuntime(OPERATOR);
    const rollCodes = runtime.orders.flatMap((o) => o.rolls.map((r) => r.id));
    expect(rollCodes).toEqual(['A-1024-roll-1']);
  });
});

describe('live scale reading (интерактивные весы)', () => {
  it('reads the post scale without committing anything', async () => {
    const { service, prisma } = setup();
    const scale = (service as any).scale;
    scale.read = jest
      .fn()
      .mockResolvedValue({ deviceId: 'dev-scale-1', status: 'ready', stable: true, grossKg: 43.4 });
    const reading = await service.readScale(OPERATOR, 'roll');
    expect(reading).toEqual(
      expect.objectContaining({ status: 'ready', stable: true, grossKg: 43.4, kind: 'roll' }),
    );
    expect(prisma.weightCapture.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.anything() }),
    );
    expect(prisma.operatorRollLine.update).not.toHaveBeenCalled();
  });
});
