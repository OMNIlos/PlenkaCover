import {
  classifyPaymentPlan,
  CommercialPerformanceService,
} from './commercial-performance.service';

const range = {
  from: '2026-07-01',
  to: '2026-07-31',
  bucket: 'day' as const,
};

const pageQuery = {
  from: '2026-07-01',
  to: '2026-07-31',
  limit: 20,
};

function pendingProductionCost() {
  return {
    kind: 'actual_pending' as const,
    status: 'pending' as const,
    calculationVersion: 'production-cost-v1' as const,
    basis: { kind: 'actual' as const, weightGrams: null },
    materialAmountKopecks: null,
    spoolAmountKopecks: null,
    payrollAmountKopecks: null,
    additionalAmountKopecks: 0,
    totalAmountKopecks: null,
    totalKopecksPerKg: null,
    unresolvedReasons: ['snapshot_pending' as const],
  };
}

function makeService() {
  const prisma = {
    financeOrder: { findMany: jest.fn() },
    productionOrder: { findMany: jest.fn() },
    rollDispatchItem: { findMany: jest.fn() },
    commercialOrder: { findMany: jest.fn() },
    warehouseRoll: { count: jest.fn(), findMany: jest.fn() },
  };
  const analytics = {
    getAnalytics: jest.fn(),
  };
  const snapshots = {
    getViewsForRollIds: jest.fn(
      async (ids: readonly string[]) => new Map(ids.map((id) => [id, pendingProductionCost()])),
    ),
  };
  const service = new CommercialPerformanceService(
    prisma as never,
    analytics as never,
    snapshots as never,
  );

  return {
    prisma,
    analytics,
    snapshots,
    service,
  };
}

describe('CommercialPerformanceService', () => {
  it.each([
    [null, 'not_set', 'Не задано'],
    [[10000], 'full', '100%'],
    [[5000, 5000], 'half_split', '50/50'],
    [[3000, 3000, 4000], 'custom', 'Индивидуально'],
    [[10000, 0], 'custom', 'Индивидуально'],
  ] as const)('classifies %j', (basisPoints, kind, label) => {
    const policy =
      basisPoints === null
        ? null
        : {
            stages: basisPoints.map((percentageBasisPoints) => ({
              percentageBasisPoints,
            })),
          };
    expect(classifyPaymentPlan(policy)).toEqual({
      paymentPlanKind: kind,
      paymentPlanLabel: label,
    });
  });

  it('projects control aggregates without director evidence or fabricated profit', async () => {
    const { service, prisma, analytics } = makeService();
    analytics.getAnalytics.mockResolvedValue({
      range: {
        timezone: 'Europe/Moscow',
        requested: { from: range.from, to: range.to },
        effective: {
          fromUtc: '2026-06-30T21:00:00.000Z',
          toExclusiveUtc: '2026-07-31T21:00:00.000Z',
        },
        bucket: 'day',
        generatedAt: '2026-07-28T12:00:00.000Z',
      },
      productionSeries: [{ bucketStartDate: '2026-07-01', rollCount: 2, producedKg: 75 }],
      productionQualitySeries: [
        {
          bucketStartDate: '2026-07-01',
          producedRollCount: 2,
          producedKg: 75,
          defectRecordCount: 1,
          defectiveRollCount: 1,
          verifiedDefectKg: 3,
          unverifiedDefectCount: 0,
          returnedSpoolCount: 1,
        },
      ],
      accountingProduction: {
        source: {
          sourceKind: '1C',
          label: '1С · Отчет производства за смену',
          latestImportedAt: '2026-07-28T11:00:00.000Z',
          latestDocumentDate: '2026-07-28T10:00:00.000Z',
          stale: false,
        },
        coverage: {
          documentCount: 1,
          excludedOutputLineCount: 0,
          excludedMaterialLineCount: 0,
        },
        productionSeries: [
          {
            bucketStartDate: '2026-07-01',
            documentCount: 1,
            producedKg: 74,
          },
        ],
        materialSeries: [],
      },
      commercialApplications: {
        definition: 'submitted',
        asOfDate: '2026-07-31',
        periods: [],
      },
      shiftBalances: [{ operatorName: 'SENSITIVE_OPERATOR' }],
      bigBags: [{ rawPayload: 'SENSITIVE_RAW' }],
      operatorOverPlan: { topOperators: [{ operatorName: 'SENSITIVE_OPERATOR' }] },
      materialSeries: [],
      materialSpendSeries: [],
      spoolEvidence: { availability: 'measured_evidence_only' },
    });
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        amountValue: 1_000,
        sourceStatus: 'ready',
        schedules: [
          { amount: 400, status: 'paid' },
          { amount: 600, status: 'overdue' },
        ],
        operations: [{ operationType: 'cash', rawPayload: 'SENSITIVE_CASH' }],
      },
    ]);
    prisma.warehouseRoll.count.mockResolvedValue(1);

    const result = await service.getControl(range);

    expect(result.summary).toEqual({
      invoicedAmount: 1_000,
      paidAmount: 400,
      receivableAmount: 600,
      overdueAmount: 600,
      producedKg: 75,
      producedRolls: 2,
      defectKg: 3,
      defectRollCount: 1,
      returnedSpoolCount: 1,
      warehouseAcceptedRolls: 1,
    });
    expect(result.productionSeries).toEqual([
      { bucketStartDate: '2026-07-01', rollCount: 2, producedKg: 75 },
    ]);
    expect(result.accountingProduction.productionSeries).toEqual([
      { bucketStartDate: '2026-07-01', documentCount: 1, producedKg: 74 },
    ]);
    expect(result.source).toMatchObject({
      kind: 'platform_runtime',
      status: 'ready',
      freshness: 'fresh',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SENSITIVE|profit|penalt|decision|operatorOverPlan|shiftBalances|bigBags/i,
    );
  });

  it('returns an allow-listed finance page without cash operations or source payloads', async () => {
    const { service, prisma } = makeService();
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        id: 'finance-1',
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        amountValue: 1_000,
        sourceStatus: 'ready',
        updatedAt: new Date('2026-07-20T10:00:00.000Z'),
        commercialOrder: {
          orderNumber: 'A-2',
          counterparty: { displayName: 'Контур', inn: 'SENSITIVE_INN' },
        },
        schedules: [
          {
            amount: 400,
            status: 'paid',
            dueDate: new Date('2026-07-10T00:00:00.000Z'),
          },
          {
            amount: 600,
            status: 'unpaid',
            dueDate: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
        policy: null,
        operations: [{ operationType: 'cash', rawPayload: 'SENSITIVE_CASH' }],
      },
    ]);

    const result = await service.listFinance(pageQuery);

    expect(result.items).toEqual([
      {
        id: 'finance-1',
        orderNumber: 'A-2',
        counterpartyName: 'Контур',
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        paymentPlanKind: 'not_set',
        paymentPlanLabel: 'Не задано',
        invoicedAmount: 1_000,
        paidAmount: 400,
        remainingAmount: 600,
        nextConfirmedDueAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-07-20T10:00:00.000Z',
      },
    ]);
    expect(result.nextCursor).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|operationType|rawPayload|inn/i);
  });

  it('derives payment plan labels from persisted policy stages, not payment schedules', async () => {
    const { service, prisma } = makeService();
    const updatedAt = new Date('2026-07-20T10:00:00.000Z');
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        id: 'finance-full',
        invoiceStatus: 'invoiced',
        paymentStatus: 'paid',
        amountValue: 1_000,
        sourceStatus: 'ready',
        updatedAt,
        commercialOrder: { orderNumber: 'A-1', counterparty: null },
        schedules: [
          { amount: 1_000, status: 'paid', dueDate: new Date('2026-07-10T00:00:00.000Z') },
        ],
        policy: { stages: [{ percentageBasisPoints: 10_000 }] },
      },
      {
        id: 'finance-half',
        invoiceStatus: 'invoiced',
        paymentStatus: 'unpaid',
        amountValue: 1_000,
        sourceStatus: 'ready',
        updatedAt,
        commercialOrder: { orderNumber: 'A-2', counterparty: null },
        schedules: [{ amount: 1_000, status: 'unpaid', dueDate: null }],
        policy: { stages: [{ percentageBasisPoints: 5_000 }, { percentageBasisPoints: 5_000 }] },
      },
      {
        id: 'finance-custom',
        invoiceStatus: 'invoiced',
        paymentStatus: 'partial',
        amountValue: 1_000,
        sourceStatus: 'ready',
        updatedAt,
        commercialOrder: { orderNumber: 'A-3', counterparty: null },
        schedules: [{ amount: 1_000, status: 'paid', dueDate: null }],
        policy: { stages: [{ percentageBasisPoints: 3_000 }, { percentageBasisPoints: 7_000 }] },
      },
      {
        id: 'finance-not-set',
        invoiceStatus: 'invoiced',
        paymentStatus: 'overdue',
        amountValue: 1_000,
        sourceStatus: 'ready',
        updatedAt,
        commercialOrder: { orderNumber: 'A-4', counterparty: null },
        schedules: [{ amount: 1_000, status: 'overdue', dueDate: null }],
        policy: null,
      },
    ]);

    const result = await service.listFinance(pageQuery);

    expect(
      result.items.map(({ id, paymentPlanKind, paymentPlanLabel }) => ({
        id,
        paymentPlanKind,
        paymentPlanLabel,
      })),
    ).toEqual([
      { id: 'finance-full', paymentPlanKind: 'full', paymentPlanLabel: '100%' },
      { id: 'finance-half', paymentPlanKind: 'half_split', paymentPlanLabel: '50/50' },
      { id: 'finance-custom', paymentPlanKind: 'custom', paymentPlanLabel: 'Индивидуально' },
      { id: 'finance-not-set', paymentPlanKind: 'not_set', paymentPlanLabel: 'Не задано' },
    ]);
    expect(prisma.financeOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          policy: {
            select: {
              stages: {
                select: { percentageBasisPoints: true },
                orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
              },
            },
          },
        }),
      }),
    );
  });

  it('aggregates production by order without operator, post, shift, or device identity', async () => {
    const { service, prisma } = makeService();
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        id: 'production-1',
        indicator: 'in_production',
        createdAt: new Date('2026-07-20T08:00:00.000Z'),
        updatedAt: new Date('2026-07-21T10:00:00.000Z'),
        commercialOrder: {
          orderNumber: 'A-2',
          counterparty: { displayName: 'Контур Пак' },
        },
        dispatchItems: [
          {
            status: 'done',
            completedAt: new Date('2026-07-21T09:00:00.000Z'),
            plannedWeightKg: 40,
            assignedOperatorId: 'SENSITIVE_OPERATOR',
            postId: 'SENSITIVE_POST',
            operatorLine: {
              netKg: 39,
              grossKg: 40.5,
              warehouseState: 'received',
              defects: [
                {
                  weightKg: 1.5,
                  spoolStockMovement: { quantity: 1 },
                  deviceId: 'SENSITIVE_DEVICE',
                },
              ],
            },
          },
          {
            status: 'in_progress',
            completedAt: null,
            plannedWeightKg: 50,
            operatorLine: null,
          },
        ],
      },
    ]);

    const result = await service.listProduction(pageQuery);

    expect(result.items).toEqual([
      {
        id: 'production-1',
        orderNumber: 'A-2',
        counterpartyName: 'Контур Пак',
        productionStatus: 'in_production',
        lifecycleStatus: 'in_production',
        createdAt: '2026-07-20T08:00:00.000Z',
        completedAt: null,
        plannedRollCount: 2,
        completedRollCount: 1,
        plannedKg: 90,
        actualKg: 39,
        defectKg: 1.5,
        defectRollCount: 1,
        returnedSpoolCount: 1,
        updatedAt: '2026-07-21T10:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|operator|postId|shift|device/i);
  });

  it('keeps warehouse acceptance terminal when delayed production state arrives', async () => {
    const { service, prisma } = makeService();
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        id: 'production-accepted',
        indicator: 'in_production',
        createdAt: new Date('2026-07-20T08:00:00.000Z'),
        updatedAt: new Date('2026-07-21T10:00:00.000Z'),
        commercialOrder: { orderNumber: 'A-11' },
        dispatchItems: [
          {
            status: 'in_progress',
            completedAt: new Date('2026-07-21T09:00:00.000Z'),
            plannedWeightKg: 40,
            operatorLine: {
              netKg: 39.125,
              grossKg: 40.625,
              warehouseState: 'received',
              defects: [],
            },
          },
        ],
      },
    ]);

    const result = await service.listProduction(pageQuery);

    expect(result.items[0]).toMatchObject({
      lifecycleStatus: 'warehouse_accepted',
      completedAt: '2026-07-21T09:00:00.000Z',
      completedRollCount: 1,
    });
  });

  it('projects delivered warehouse facts as the terminal delivered lifecycle', async () => {
    const { service, prisma } = makeService();
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        id: 'production-delivered',
        indicator: 'in_production',
        createdAt: new Date('2026-07-20T08:00:00.000Z'),
        updatedAt: new Date('2026-07-21T10:00:00.000Z'),
        commercialOrder: { orderNumber: 'A-12' },
        dispatchItems: [
          {
            status: 'done',
            completedAt: new Date('2026-07-21T09:00:00.000Z'),
            plannedWeightKg: 40,
            operatorLine: {
              netKg: 39.125,
              grossKg: 40.625,
              warehouseState: 'delivered',
              defects: [],
            },
          },
        ],
      },
    ]);

    const result = await service.listProduction(pageQuery);

    expect(result.items[0]).toMatchObject({
      lifecycleStatus: 'warehouse_delivered',
      completedAt: '2026-07-21T09:00:00.000Z',
      completedRollCount: 1,
    });
  });

  it('paginates production rolls in deterministic dispatch identity order', async () => {
    const { service, prisma } = makeService();
    const roll = (id: string) => ({
      id,
      rollCode: `ROLL-${id}`,
      priority: 0,
      status: 'new',
      characteristicsSnapshot: { filmType: 'Рукав', actualThickness: '60 мкм' },
      productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
      assignedOperator: null,
      post: null,
      operatorLine: null,
    });
    prisma.rollDispatchItem.findMany
      .mockResolvedValueOnce([roll('dispatch-1'), roll('dispatch-2'), roll('dispatch-3')])
      .mockResolvedValueOnce([roll('dispatch-3')]);

    const first = await service.listProductionRolls('production-1', { limit: 2 });

    expect(first.items.map(({ id }) => id)).toEqual(['dispatch-1', 'dispatch-2']);
    expect(first.nextCursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      id: 'dispatch-2',
    });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(1, {
      where: { productionOrderId: 'production-1' },
      select: {
        id: true,
        rollCode: true,
        createdAt: true,
        completedAt: true,
        priority: true,
        status: true,
        plannedWeightKg: true,
        widthMm: true,
        plannedLengthM: true,
        characteristicsSnapshot: true,
        productionOrder: {
          select: {
            commercialOrder: { select: { orderNumber: true } },
          },
        },
        assignedOperator: { select: { displayName: true } },
        post: { select: { name: true, code: true } },
        operatorLine: {
          select: {
            planKg: true,
            spoolKg: true,
            grossKg: true,
            netKg: true,
            warehouseState: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 3,
    });

    const second = await service.listProductionRolls('production-1', {
      cursor: first.nextCursor!,
      limit: 2,
    });

    expect(second.items.map(({ id }) => id)).toEqual(['dispatch-3']);
    expect(second.nextCursor).toBeNull();
    expect(prisma.rollDispatchItem.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          productionOrderId: 'production-1',
          id: { gt: 'dispatch-2' },
        },
        orderBy: { id: 'asc' },
        take: 3,
      }),
    );
  });

  it('keeps the delivered lifecycle on each production roll projection', async () => {
    const { service, prisma } = makeService();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-delivered',
        rollCode: 'ROLL-DELIVERED',
        priority: 0,
        status: 'done',
        characteristicsSnapshot: {},
        productionOrder: { commercialOrder: { orderNumber: 'A-12' } },
        assignedOperator: null,
        post: null,
        operatorLine: {
          planKg: 40,
          spoolKg: 1,
          grossKg: 40,
          netKg: 39,
          warehouseState: 'delivered',
        },
      },
    ]);

    const result = await service.listProductionRolls('production-delivered', { limit: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      status: 'warehouse_delivered',
      lifecycleStatus: 'warehouse_delivered',
    });
  });

  it('embeds required roll costs from one bounded batch lookup in the same page', async () => {
    const { service, prisma, snapshots } = makeService();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        createdAt: new Date('2026-08-07T00:00:00.000Z'),
        completedAt: new Date('2026-08-07T01:00:00.000Z'),
        priority: 0,
        status: 'done',
        plannedWeightKg: 10,
        widthMm: 1_500,
        plannedLengthM: null,
        characteristicsSnapshot: { filmType: 'Рукав' },
        productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
        assignedOperator: null,
        post: null,
        operatorLine: { netKg: 10 },
      },
    ]);
    snapshots.getViewsForRollIds.mockResolvedValueOnce(
      new Map([
        [
          'dispatch-1',
          {
            kind: 'actual_snapshot',
            status: 'complete',
            calculationVersion: 'historical-v0',
            snapshotId: 'snapshot-1',
            version: 1,
            producedAt: '2026-08-01T00:00:00.000Z',
            closedAt: '2026-08-01T08:00:00.000Z',
            createdAt: '2026-08-01T08:00:01.000Z',
            basis: { kind: 'actual', weightGrams: 10_000 },
            materialAmountKopecks: 20_000,
            spoolAmountKopecks: 9_000,
            payrollAmountKopecks: 4_000,
            additionalAmountKopecks: 0,
            totalAmountKopecks: 33_000,
            totalKopecksPerKg: 3_300,
            unresolvedReasons: [],
          },
        ],
      ]) as never,
    );

    const result = await service.listProductionRolls('production-1', { limit: 20 });

    expect(snapshots.getViewsForRollIds).toHaveBeenCalledWith(['dispatch-1']);
    expect(result.items[0]).toMatchObject({
      id: 'dispatch-1',
      productionCost: {
        kind: 'actual_snapshot',
        snapshotId: 'snapshot-1',
        totalAmountKopecks: 33_000,
      },
    });
  });

  it('normalizes roll snapshots and prefers completed operator-line net weight', async () => {
    const { service, prisma } = makeService();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        priority: 2,
        status: 'done',
        createdAt: new Date('2026-08-07T00:00:00.000Z'),
        completedAt: new Date('2026-08-07T01:00:00.000Z'),
        characteristicsSnapshot: {
          filmType: '  Рукав ',
          actualThickness: '60 мкм',
          accountingThickness: '58,5 мкм',
          widthMm: '1700 мм',
          plannedLengthM: '275 м',
          weightKg: '99,9 кг',
          rawPayload: 'SENSITIVE_RAW',
          gatewayPayload: 'SENSITIVE_GATEWAY',
        },
        productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
        assignedOperator: {
          displayName: 'Оператор 1',
          id: 'SENSITIVE_ACTOR',
          sessionId: 'SENSITIVE_SESSION',
        },
        post: {
          name: 'Экструдер 1',
          code: 'POST-1',
          id: 'SENSITIVE_POST',
          deviceId: 'SENSITIVE_DEVICE',
        },
        operatorLine: {
          planKg: 42,
          spoolKg: 1.5,
          grossKg: 43.8,
          netKg: 42.3,
          warehouseState: 'received',
          weightCaptures: [{ rawPayload: 'SENSITIVE_WEIGHT_PAYLOAD' }],
        },
      },
      {
        id: 'dispatch-2',
        rollCode: null,
        createdAt: new Date('2026-08-07T00:05:00.000Z'),
        completedAt: null,
        priority: 0,
        status: 'in_progress',
        characteristicsSnapshot: {
          filmType: '   ',
          actualThickness: 'invalid',
          accountingThickness: null,
          widthMm: Number.POSITIVE_INFINITY,
          plannedLengthM: -1,
          plannedWeightKg: 40,
        },
        productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
        assignedOperator: null,
        post: null,
        operatorLine: {
          planKg: 40,
          spoolKg: null,
          grossKg: null,
          netKg: 41,
          warehouseState: 'not_ready',
        },
      },
    ]);

    const result = await service.listProductionRolls('production-1', { limit: 20 });

    expect(result).toEqual({
      items: [
        {
          id: 'dispatch-1',
          rollName: 'Рукав 60 мкм',
          rollCode: 'ROLL-1',
          orderNumber: 'A-5',
          parameters: {
            filmType: 'Рукав',
            actualThicknessUm: 60,
            accountingThicknessUm: 58.5,
            widthMm: 1700,
            plannedLengthM: 275,
            weightKg: 42.3,
          },
          operatorName: 'Оператор 1',
          machineName: 'Экструдер 1',
          priority: 2,
          status: 'warehouse_accepted',
          lifecycleStatus: 'warehouse_accepted',
          createdAt: '2026-08-07T00:00:00.000Z',
          completedAt: '2026-08-07T01:00:00.000Z',
          weights: {
            plannedNetKg: 42,
            actualNetKg: 42.3,
            actualGrossKg: 43.8,
            deviationKg: 0.3,
          },
          productionCost: pendingProductionCost(),
        },
        {
          id: 'dispatch-2',
          rollName: 'Рулон',
          rollCode: null,
          orderNumber: 'A-5',
          parameters: {
            filmType: null,
            actualThicknessUm: null,
            accountingThicknessUm: null,
            widthMm: null,
            plannedLengthM: null,
            weightKg: 40,
          },
          operatorName: null,
          machineName: null,
          priority: 0,
          status: 'in_production',
          lifecycleStatus: 'in_production',
          createdAt: '2026-08-07T00:05:00.000Z',
          completedAt: null,
          weights: {
            plannedNetKg: 40,
            actualNetKg: 41,
            actualGrossKg: null,
            deviationKg: 1,
          },
          productionCost: pendingProductionCost(),
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /SENSITIVE|rawPayload|gatewayPayload|actorId|sessionId|postId|deviceId|weightCapture/i,
    );
  });

  it('uses safe dispatch dimensions when a legacy snapshot omitted them', async () => {
    const { service, prisma } = makeService();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-legacy',
        rollCode: 'ROLL-LEGACY',
        priority: 0,
        status: 'assigned',
        plannedWeightKg: 41.2,
        widthMm: 1700,
        plannedLengthM: 275,
        characteristicsSnapshot: {
          filmType: 'Рукав',
          actualThickness: '80 мкм',
          accountingThickness: '78 мкм',
        },
        productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
        assignedOperator: null,
        post: null,
        operatorLine: null,
      },
    ]);

    const result = await service.listProductionRolls('production-1', { limit: 20 });

    expect(result.items[0].parameters).toEqual({
      filmType: 'Рукав',
      actualThicknessUm: 80,
      accountingThicknessUm: 78,
      widthMm: 1700,
      plannedLengthM: 275,
      weightKg: 41.2,
    });
  });

  it.each([
    ['ready_for_warehouse', 42.3],
    ['done', 42.3],
    ['assigned', 50],
    ['in_progress', 50],
  ] as const)('projects the finalized weight boundary for %s', async (status, expectedWeightKg) => {
    const { service, prisma } = makeService();
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        priority: 1,
        status,
        characteristicsSnapshot: {
          filmType: 'Рукав',
          actualThickness: '60 мкм',
          weightKg: 50,
        },
        productionOrder: { commercialOrder: { orderNumber: 'A-5' } },
        assignedOperator: null,
        post: null,
        operatorLine: { netKg: 42.3 },
      },
    ]);

    const result = await service.listProductionRolls('production-1', { limit: 20 });

    expect(result.items[0].parameters.weightKg).toBe(expectedWeightKg);
  });

  it('rejects an invalid production-roll cursor before querying Prisma', async () => {
    const { service, prisma } = makeService();

    await expect(
      service.listProductionRolls('production-1', {
        cursor: 'not-a-cursor',
        limit: 20,
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.rollDispatchItem.findMany).not.toHaveBeenCalled();
  });

  it('aggregates warehouse progress without scan, QR, BigBag, or correction details', async () => {
    const { service, prisma } = makeService();
    prisma.commercialOrder.findMany.mockResolvedValue([
      {
        id: 'order-1',
        orderNumber: 'A-2',
        warehouseCoverStatus: 'full_confirmed',
        shipmentStatus: 'partial_shipped',
        updatedAt: new Date('2026-07-22T10:00:00.000Z'),
        rawPayload: 'SENSITIVE_QR',
      },
    ]);
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        producedForOrderId: 'order-1',
        reservedForOrderId: null,
        warehouseStatus: 'ready_for_handover',
        positionSnapshot: { rawPayload: 'SENSITIVE_SCAN' },
      },
      {
        producedForOrderId: 'order-1',
        reservedForOrderId: 'order-1',
        warehouseStatus: 'received',
      },
      {
        producedForOrderId: 'order-1',
        reservedForOrderId: null,
        warehouseStatus: 'delivered',
      },
    ]);

    const result = await service.listWarehouse(pageQuery);

    expect(result.items).toEqual([
      {
        id: 'order-1',
        orderNumber: 'A-2',
        warehouseCoverageStatus: 'full_confirmed',
        shipmentStatus: 'partial_shipped',
        readyRollCount: 1,
        reservedRollCount: 1,
        acceptedRollCount: 2,
        shippedRollCount: 1,
        updatedAt: '2026-07-22T10:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/SENSITIVE|scan|rawPayload|bigBag|correction/i);
  });
});
