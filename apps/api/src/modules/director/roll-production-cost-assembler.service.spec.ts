import { calculateRollProductionCost } from '../../common/production-cost/production-cost-calculator';
import { buildProductionCostSourceSnapshot } from '../../common/production-cost/production-cost-source-snapshot';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
} from '../../common/payroll-tariffs/legacy-payroll-tariff-matrix';
import type { PublishedPayrollTariffOrder } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import type { DirectorPayrollProductionFact } from './director-payroll-facts.service';
import { RollProductionCostAssemblerService } from './roll-production-cost-assembler.service';

const GENERATED_AT = new Date('2026-08-04T00:00:00.000Z');
const PRODUCED_AT = new Date('2026-08-02T10:00:00.000Z');

function fact(
  rollId: string,
  actualKg: number,
  overrides: Partial<DirectorPayrollProductionFact> = {},
): DirectorPayrollProductionFact {
  return {
    lineId: `line-${rollId}`,
    rollId,
    rollCode: rollId.toUpperCase(),
    orderId: 'commercial-order-1',
    orderNumber: 'ORD-1',
    productionOrderId: 'production-order-1',
    actualKg,
    producedAt: PRODUCED_AT,
    canonicalCaptureId: `capture-${rollId}`,
    rootCaptureId: `root-${rollId}`,
    operatorId: 'operator-1',
    operatorName: 'Оператор 1',
    rootSessionId: 'session-1',
    rootSessionStatus: 'closed',
    rootSessionStartedAt: new Date('2026-08-02T06:05:00.000Z'),
    rootSessionEndedAt: new Date('2026-08-02T17:55:00.000Z'),
    shift: {
      id: 'shift-1',
      label: 'Смена 1',
      status: 'closed',
      plannedStartAt: new Date('2026-08-02T06:00:00.000Z'),
      plannedEndAt: new Date('2026-08-02T18:00:00.000Z'),
      endedAt: new Date('2026-08-02T18:00:00.000Z'),
    },
    post: { id: 'post-1', code: 'P1', name: 'УРП' },
    dispatchStatus: 'done',
    dispatchCompletedAt: new Date('2026-08-02T12:00:00.000Z'),
    operatorStep: 'warehouse',
    hasDefect: false,
    filmType: 'Рукав',
    counterpartyLegalName: 'ООО Клиент',
    materialKinds: ['primary'],
    materialComponents: [
      { rawMaterialDefinitionId: 'material-1', name: 'ПНД', shareBasisPoints: 10_000 },
    ],
    machineAssignment: { id: 'assignment-1', status: 'completed' },
    spoolType: 'Шпуля 76 мм',
    widthMicrometers: 1_500_000,
    plannedWeightGrams: rollId === 'roll-1' ? 8_000 : 20_000,
    ...overrides,
  };
}

type FixtureOptions = {
  requestedFacts?: DirectorPayrollProductionFact[];
  sessionFacts?: DirectorPayrollProductionFact[];
  orderFacts?: DirectorPayrollProductionFact[];
  rollRows?: Array<Record<string, unknown>>;
  orderRows?: Array<Record<string, unknown>>;
  positionSpoolType?: string | null;
  usages?: Array<Record<string, unknown>>;
  materialPrices?: Array<Record<string, unknown>>;
  observedMaterialSnapshots?: Array<Record<string, unknown>>;
  spoolPrices?: Array<Record<string, unknown>>;
  additionalCosts?: Array<Record<string, unknown>>;
  observedSpoolLabels?: string[];
  payrollSchedule?: PublishedPayrollTariffOrder[];
};

function payrollOrder(
  id: string,
  effectiveFrom: string,
  rateKopecksPerKg?: number,
): PublishedPayrollTariffOrder {
  const matrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
  if (rateKopecksPerKg !== undefined) {
    matrix.ladders.urp12h[0]!.primaryRateKopecksPerKg = rateKopecksPerKg;
  }
  return {
    reference: {
      ...(id === LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id
        ? LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE
        : { id, name: `Приказ ${id}`, effectiveFrom, currency: 'RUB' as const }),
    },
    effectiveFromMs: Date.parse(`${effectiveFrom}T00:00:00+03:00`),
    revision: 1,
    matrix,
    matrixHash: id.padEnd(64, '0').slice(0, 64),
  };
}

function fixture(options: FixtureOptions = {}) {
  const roll1 = fact('roll-1', 10);
  const roll2 = fact('roll-2', 20, {
    canonicalCaptureId: 'capture-roll-2',
    rootCaptureId: 'root-roll-2',
  });
  const characteristicsSnapshot = {
    spoolType: 'Шпуля 76 мм',
    widthMm: 1_500,
    recipe: {
      ingredients: [{ rawMaterialDefinitionId: 'material-1', shareBasisPoints: 10_000 }],
    },
    plannedLengthM: 9_999_999,
  };
  const defaultRollRows = [
    {
      id: 'roll-1',
      productionOrderId: 'production-order-1',
      orderLineId: 'position-1',
      status: 'done',
      completedAt: new Date('2026-08-02T12:00:00.000Z'),
      plannedWeightKg: 8,
      widthMm: 1_500,
      characteristicsSnapshot,
    },
  ];
  const defaultOrderRows = [
    {
      id: 'roll-1',
      productionOrderId: 'production-order-1',
      status: 'done',
      replacementAttempt: null,
      operatorLine: { defects: [] },
    },
    {
      id: 'roll-2',
      productionOrderId: 'production-order-1',
      status: 'done',
      replacementAttempt: null,
      operatorLine: { defects: [] },
    },
  ];
  const rollRows = options.rollRows ?? defaultRollRows;
  const orderRows = options.orderRows ?? defaultOrderRows;
  const rollDispatchQueries: unknown[] = [];
  const prisma = {
    rollDispatchItem: {
      findMany: jest.fn(async (query: { where: Record<string, unknown> }) => {
        rollDispatchQueries.push(query);
        return 'id' in query.where ? rollRows : orderRows;
      }),
    },
    commercialOrderPosition: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'position-1',
          spoolType:
            options.positionSpoolType === undefined ? 'Шпуля 76 мм' : options.positionSpoolType,
        },
      ]),
    },
    operatorPostSession: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'session-1', shiftId: 'shift-1', postId: 'post-1' }]),
    },
    rawMaterialDefinition: {
      findMany: jest.fn().mockResolvedValue([{ id: 'material-1', name: 'ПНД' }]),
    },
    materialPriceReference: {
      findMany: jest.fn().mockResolvedValue(
        options.materialPrices ?? [
          {
            id: 'material-price-1',
            rawMaterialDefinitionId: 'material-1',
            priceKopecksPerKg: 2_000,
            source: 'Поставка 1',
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      ),
    },
    rollProductionCostSnapshot: {
      findMany: jest.fn().mockResolvedValue(options.observedMaterialSnapshots ?? []),
    },
    spoolPriceReference: {
      findMany: jest.fn().mockResolvedValue(
        options.spoolPrices ?? [
          {
            id: 'spool-price-1',
            spoolTypeKey: 'шпуля 76 мм',
            spoolTypeLabel: 'Шпуля 76 мм',
            priceKopecksPerMeter: 6_000n,
            source: 'Прайс шпуль',
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      ),
    },
    shiftBagUsage: {
      findMany: jest.fn().mockResolvedValue(options.usages ?? []),
    },
    additionalProductionCost: {
      findMany: jest.fn().mockResolvedValue(
        options.additionalCosts ?? [
          {
            id: 'direct-cost-1',
            rollDispatchItemId: 'roll-1',
            productionOrderId: null,
            allocationBasis: 'direct',
            amountKopecks: 100,
            source: 'Упаковка',
            effectiveAt: new Date('2026-08-02T09:00:00.000Z'),
            reason: 'Индивидуальная упаковка',
          },
        ],
      ),
    },
  };
  const queryRaw = jest.fn(async (query: { strings?: readonly string[] }) => {
    const statement = Array.isArray(query?.strings) ? query.strings.join('?') : String(query);
    return statement.includes('observed_spool_types')
      ? (options.observedSpoolLabels ?? ['76 мм', 'Шпуля 76 мм', 'втулка 76']).map((label) => ({
          label,
        }))
      : [];
  });
  const transaction = jest.fn(
    async (callback: (tx: typeof prisma) => Promise<unknown>, _options?: unknown) =>
      callback(prisma),
  );
  Object.assign(prisma, {
    $queryRaw: queryRaw,
    $transaction: transaction,
  });
  const facts = {
    loadForRollDispatchItems: jest.fn().mockResolvedValue(options.requestedFacts ?? [roll1]),
    loadForRootSessions: jest.fn().mockResolvedValue(options.sessionFacts ?? [roll1, roll2]),
    loadForProductionOrders: jest.fn().mockResolvedValue(options.orderFacts ?? [roll1, roll2]),
  };
  const tariffOrders = {
    loadPublishedSchedule: jest
      .fn()
      .mockResolvedValue(
        options.payrollSchedule ?? [
          payrollOrder(
            LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
            LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
          ),
        ],
      ),
  };
  const service = new RollProductionCostAssemblerService(
    prisma as never,
    facts as never,
    tariffOrders as never,
    new PayrollTariffResolver(),
  );
  return {
    facts,
    tariffOrders,
    prisma,
    queryRaw,
    transaction,
    rollDispatchQueries,
    service,
  };
}

describe('RollProductionCostAssemblerService', () => {
  it('uses the roll tag for wages in production cost even with a primary material recipe', async () => {
    const roll = fact('roll-1', 10, { birka: 'Тех' });
    const { service } = fixture({
      requestedFacts: [roll],
      sessionFacts: [roll],
      orderFacts: [roll],
    });
    const prepared = (await service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;
    expect(prepared.actualInput?.payroll).toMatchObject({ rateKopecksPerKg: 500 });
    expect(calculateRollProductionCost(prepared.actualInput!).payrollAmountKopecks).toBe(5_000);
  });
  it('prepares exact planned and actual amounts with canonical root provenance', async () => {
    const context = fixture();

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!)).toEqual(
      expect.objectContaining({
        status: 'complete',
        materialAmountKopecks: 20_000,
        spoolAmountKopecks: 9_000,
        payrollAmountKopecks: 4_000,
        additionalAmountKopecks: 100,
        totalAmountKopecks: 33_100,
      }),
    );
    expect(calculateRollProductionCost(prepared.plannedInput!)).toEqual(
      expect.objectContaining({
        status: 'complete',
        materialAmountKopecks: 16_000,
        spoolAmountKopecks: 9_000,
        payrollAmountKopecks: 3_200,
        additionalAmountKopecks: 100,
        totalAmountKopecks: 28_300,
      }),
    );
    expect(context.tariffOrders.loadPublishedSchedule).toHaveBeenCalledTimes(1);
    expect(context.tariffOrders.loadPublishedSchedule).toHaveBeenCalledWith(PRODUCED_AT);
    expect(prepared.actualInput?.payroll).toEqual({
      tariffOrderId: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
      tariffOrderName: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.name,
      effectiveFrom: new Date('2025-09-28T21:00:00.000Z'),
      rateKopecksPerKg: 400,
      basisLabel: expect.any(String),
    });
    expect(prepared.eligibility).toEqual(
      expect.objectContaining({
        canonicalCaptureId: 'capture-roll-1',
        rootPostSessionId: 'session-1',
        machineAssignmentId: 'assignment-1',
      }),
    );
    expect(buildProductionCostSourceSnapshot(prepared.sourceSnapshot!)).toEqual(
      expect.objectContaining({
        eligibility: expect.objectContaining({
          canonicalCaptureId: 'capture-roll-1',
          rootCaptureId: 'root-roll-1',
        }),
        payroll: expect.objectContaining({
          tariffOrderId: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
          tariffOrderName: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.name,
          effectiveFrom: '2025-09-28T21:00:00.000Z',
        }),
      }),
    );
    expect(JSON.stringify(context.rollDispatchQueries)).not.toMatch(
      /plannedLengthM|rawPayload|device|gateway|scan|print/iu,
    );
  });

  it('selects the roll tariff inclusively by producedAt and loads one bounded schedule', async () => {
    const next = payrollOrder('payroll-order-next', '2026-08-02', 777);
    const boundaryFact = fact('roll-1', 10, {
      producedAt: new Date('2026-08-01T21:00:00.000Z'),
    });
    const context = fixture({
      requestedFacts: [boundaryFact],
      sessionFacts: [boundaryFact],
      orderFacts: [boundaryFact],
      payrollSchedule: [
        payrollOrder(
          LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id,
          LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.effectiveFrom,
        ),
        next,
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(context.tariffOrders.loadPublishedSchedule).toHaveBeenCalledTimes(1);
    expect(context.tariffOrders.loadPublishedSchedule).toHaveBeenCalledWith(
      boundaryFact.producedAt,
    );
    expect(prepared.actualInput?.payroll).toEqual(
      expect.objectContaining({
        tariffOrderId: next.reference.id,
        tariffOrderName: next.reference.name,
        rateKopecksPerKg: 777,
      }),
    );
    expect(calculateRollProductionCost(prepared.actualInput!).payrollAmountKopecks).toBe(7_770);
  });

  it.each([
    {
      label: 'thin roll',
      actualKg: 6.999,
      overrides: {},
      expectedRate: 650,
      basisFragment: 'тонкий рулон',
    },
    {
      label: 'Falz ABC',
      actualKg: 10,
      overrides: {
        post: { id: 'post-abc-old', code: 'ABC-OLD', name: 'АВС старая' },
        filmType: 'Фальц',
      },
      expectedRate: 500,
      basisFragment: 'фальц',
    },
    {
      label: 'Alabuga',
      actualKg: 10,
      overrides: {
        post: { id: 'post-abc-new', code: 'ABC-NEW', name: 'АВС новая' },
        counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
      },
      expectedRate: 400,
      basisFragment: 'ОЭЗ ППТ АЛАБУГА АО',
    },
    {
      label: 'Begemot ABC without Alabuga override',
      actualKg: 10,
      overrides: {
        post: { id: 'post-begemot', code: 'BEGEMOT', name: 'Бегемот' },
        counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
      },
      expectedRate: 450,
      basisFragment: 'стандартная плёнка',
    },
    {
      label: 'secondary material',
      actualKg: 10,
      overrides: {
        materialComponents: [
          {
            rawMaterialDefinitionId: 'material-1',
            name: 'Вторичная гранула',
            shareBasisPoints: 10_000,
          },
        ],
      },
      expectedRate: 500,
      basisFragment: 'вторичка',
    },
    {
      label: 'unresolved PND new',
      actualKg: 10,
      overrides: { post: { id: 'post-pnd-new', code: 'PND-NEW', name: 'Пнд новая' } },
      expectedRate: null,
      basisFragment: null,
    },
  ])('keeps the established $label roll rule behind the shared resolver', async (testCase) => {
    const requested = fact('roll-1', testCase.actualKg, testCase.overrides);
    const context = fixture({
      requestedFacts: [requested],
      sessionFacts: [requested],
      orderFacts: [requested],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    if (testCase.expectedRate === null) {
      expect(prepared.actualInput?.payroll).toBeNull();
    } else {
      expect(prepared.actualInput?.payroll).toEqual(
        expect.objectContaining({
          rateKopecksPerKg: testCase.expectedRate,
          basisLabel: expect.stringContaining(testCase.basisFragment),
        }),
      );
    }
    expect(context.tariffOrders.loadPublishedSchedule).toHaveBeenCalledTimes(1);
  });

  it('fails canonical eligibility closed when the capture chain root is unavailable', async () => {
    const missingRoot = fact('roll-1', 10, { rootCaptureId: undefined });
    const context = fixture({
      requestedFacts: [missingRoot],
      sessionFacts: [missingRoot],
      orderFacts: [missingRoot],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(prepared.eligibility?.canonicalCaptureIsLeaf).toBe(false);
    expect(prepared.sourceSnapshot).toBeNull();
  });

  it('locks the bounded ProductionOrder population once before reading its seal proof', async () => {
    const context = fixture();

    await context.service.prepare(['roll-1'], GENERATED_AT);

    expect(context.transaction).toHaveBeenCalledTimes(1);
    expect(context.transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' });
    const statements = context.queryRaw.mock.calls.map(([query]) =>
      Array.isArray(query?.strings) ? query.strings.join('?') : String(query),
    );
    const locks = statements
      .map((statement, index) => ({ index, statement }))
      .filter(({ statement }) => statement.includes('FOR UPDATE'));
    expect(locks).toHaveLength(2);
    expect(locks[0].statement).toMatch(/FROM "production_orders".*FOR UPDATE/su);
    expect(locks[1].statement).toMatch(/FROM "roll_dispatch_items".*FOR UPDATE/su);
    const finalLockCallOrder = context.queryRaw.mock.invocationCallOrder[locks[1].index];
    expect(finalLockCallOrder).toBeLessThan(
      context.prisma.rollDispatchItem.findMany.mock.invocationCallOrder[1],
    );
    expect(finalLockCallOrder).toBeLessThan(
      context.prisma.additionalProductionCost.findMany.mock.invocationCallOrder[0],
    );
  });

  it('uses measured ShiftBagUsage before recipe references and freezes every session roll', async () => {
    const roll1 = fact('roll-1', 10);
    const handedOverPeer = fact('roll-2', 20, { dispatchStatus: 'ready_for_warehouse' });
    const context = fixture({
      requestedFacts: [roll1],
      sessionFacts: [roll1, handedOverPeer],
      usages: [
        {
          id: 'usage-1',
          sessionId: 'session-1',
          startKg: 30,
          endKg: 0,
          closedAt: new Date('2026-08-02T17:55:00.000Z'),
          releasedReason: null,
          episodes: [],
          bigBag: {
            id: 'bag-1',
            code: 'BB-1',
            material: 'ПНД measured',
            baseRawMaterialDefinitionId: 'material-1',
            priceKopecksPerKg: 10_000,
            priceSource: 'Поставка BigBag',
            priceEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
            createdAt: new Date('2026-07-31T00:00:00.000Z'),
          },
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;
    const calculation = calculateRollProductionCost(prepared.actualInput!);

    expect(prepared.actualInput?.materialBasis).toEqual(
      expect.objectContaining({ kind: 'shift_bigbag_allocation' }),
    );
    expect(calculation.materialAmountKopecks).toBe(100_000);
    expect(
      prepared.actualInput?.materialBasis.kind === 'shift_bigbag_allocation'
        ? prepared.actualInput.materialBasis.sources[0].denominator.rows
        : [],
    ).toEqual([
      expect.objectContaining({ rollDispatchItemId: 'roll-1', allocatedGrams: 10_000 }),
      expect.objectContaining({ rollDispatchItemId: 'roll-2', allocatedGrams: 20_000 }),
    ]);
    expect(() => buildProductionCostSourceSnapshot(prepared.sourceSnapshot!)).not.toThrow();
  });

  it('falls back to the material reference effective before the whole measured batch', async () => {
    const roll1 = fact('roll-1', 10);
    const roll2 = fact('roll-2', 20, {
      producedAt: new Date('2026-08-02T11:00:00.000Z'),
    });
    const context = fixture({
      requestedFacts: [roll1],
      sessionFacts: [roll1, roll2],
      materialPrices: [
        {
          id: 'material-price-between-rolls',
          rawMaterialDefinitionId: 'material-from-bigbag',
          priceKopecksPerKg: 3_000,
          source: 'Поставка между рулонами',
          effectiveFrom: new Date('2026-08-02T10:30:00.000Z'),
        },
        {
          id: 'material-price-before-batch',
          rawMaterialDefinitionId: 'material-from-bigbag',
          priceKopecksPerKg: 2_000,
          source: 'Поставка до смены',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
      usages: [
        {
          id: 'usage-with-reference-price',
          sessionId: 'session-1',
          startKg: 30,
          endKg: 0,
          closedAt: new Date('2026-08-02T17:55:00.000Z'),
          releasedReason: null,
          episodes: [],
          bigBag: {
            id: 'bag-without-price',
            code: 'BB-NO-PRICE',
            material: 'ПНД measured',
            baseRawMaterialDefinitionId: 'material-from-bigbag',
            priceKopecksPerKg: null,
            priceSource: null,
            priceEffectiveAt: null,
            createdAt: new Date('2026-07-31T00:00:00.000Z'),
          },
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;
    const calculation = calculateRollProductionCost(prepared.actualInput!);

    expect(calculation.materialAmountKopecks).toBe(20_000);
    expect(prepared.sourceSnapshot?.material).toEqual(
      expect.objectContaining({
        kind: 'shift_bigbag_allocation',
        sources: [
          expect.objectContaining({
            materialDefinitionId: 'material-from-bigbag',
            label: expect.stringContaining('Поставка до смены'),
            priceKopecksPerKg: 2_000,
            effectiveAt: new Date('2026-08-01T00:00:00.000Z'),
          }),
        ],
      }),
    );
    expect(context.prisma.materialPriceReference.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rawMaterialDefinitionId: { in: expect.arrayContaining(['material-from-bigbag']) },
        }),
      }),
    );
  });

  it('aggregates every immutable BigBag episode instead of the latest stable projection', async () => {
    const roll1 = fact('roll-1', 10);
    const handedOverPeer = fact('roll-2', 20, { dispatchStatus: 'ready_for_warehouse' });
    const context = fixture({
      requestedFacts: [roll1],
      sessionFacts: [roll1, handedOverPeer],
      usages: [
        {
          id: 'usage-readded',
          sessionId: 'session-1',
          startKg: 450,
          endKg: 400,
          closedAt: new Date('2026-08-02T17:55:00.000Z'),
          releasedReason: null,
          episodes: [
            {
              sequence: 1,
              startKg: 500,
              endKg: 450,
              closeKind: 'released',
              closedAt: new Date('2026-08-02T12:00:00.000Z'),
            },
            {
              sequence: 2,
              startKg: 450,
              endKg: 400,
              closeKind: 'shift_closed',
              closedAt: new Date('2026-08-02T17:55:00.000Z'),
            },
          ],
          bigBag: {
            id: 'bag-readded',
            code: 'BB-READDED',
            material: 'ПНД measured',
            baseRawMaterialDefinitionId: 'material-1',
            priceKopecksPerKg: 10_000,
            priceSource: 'Поставка BigBag',
            priceEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
            createdAt: new Date('2026-07-31T00:00:00.000Z'),
          },
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;
    const calculation = calculateRollProductionCost(prepared.actualInput!);

    expect(calculation.materialAmountKopecks).toBe(333_333);
    expect(prepared.sourceSnapshot?.material).toEqual(
      expect.objectContaining({
        kind: 'shift_bigbag_allocation',
        sources: [expect.objectContaining({ totalConsumedGrams: 100_000 })],
      }),
    );
    expect(context.prisma.shiftBagUsage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          episodes: {
            select: expect.objectContaining({
              sequence: true,
              startKg: true,
              endKg: true,
              closeKind: true,
              closedAt: true,
            }),
            orderBy: { sequence: 'asc' },
          },
        }),
      }),
    );
  });

  it('selects material references independently at actual production time and live plan time', async () => {
    const context = fixture({
      materialPrices: [
        {
          id: 'material-price-new',
          rawMaterialDefinitionId: 'material-1',
          priceKopecksPerKg: 3_000,
          source: 'Поставка после выпуска',
          effectiveFrom: new Date('2026-08-03T00:00:00.000Z'),
        },
        {
          id: 'material-price-old',
          rawMaterialDefinitionId: 'material-1',
          priceKopecksPerKg: 2_000,
          source: 'Поставка до выпуска',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!).materialAmountKopecks).toBe(20_000);
    expect(calculateRollProductionCost(prepared.plannedInput!).materialAmountKopecks).toBe(24_000);
  });

  it('distinguishes an observed spool without a price from an unknown spool identity', async () => {
    const known = fixture({ spoolPrices: [] });
    const knownPrepared = (await known.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(knownPrepared.actualInput!).unresolvedReasons).toEqual([
      'spool_price_unresolved',
    ]);

    const unknownFact = fact('roll-1', 10, { spoolType: null });
    const unknown = fixture({
      requestedFacts: [unknownFact],
      sessionFacts: [unknownFact],
      orderFacts: [unknownFact],
      positionSpoolType: null,
      rollRows: [
        {
          id: 'roll-1',
          productionOrderId: 'production-order-1',
          orderLineId: 'position-1',
          status: 'done',
          completedAt: new Date('2026-08-02T12:00:00.000Z'),
          plannedWeightKg: 8,
          widthMm: 1_500,
          characteristicsSnapshot: {
            widthMm: 1_500,
            recipe: {
              ingredients: [{ rawMaterialDefinitionId: 'material-1', shareBasisPoints: 10_000 }],
            },
          },
        },
      ],
      spoolPrices: [],
    });
    const unknownPrepared = (await unknown.service.prepare(['roll-1'], GENERATED_AT)).get(
      'roll-1',
    )!;

    expect(calculateRollProductionCost(unknownPrepared.actualInput!).unresolvedReasons).toEqual([
      'spool_type_unresolved',
    ]);
  });

  it('uses the global observed spool catalog and fails ambiguous canonical labels closed', async () => {
    const context = fixture({
      observedSpoolLabels: ['Шпуля 76 мм', 'ШПУЛЯ 76 ММ'],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!).unresolvedReasons).toEqual([
      'spool_type_unresolved',
    ]);
    const statements = context.queryRaw.mock.calls.map(([query]) =>
      Array.isArray(query?.strings) ? query.strings.join('?') : String(query),
    );
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /commercial_order_positions.*roll_dispatch_items.*observed_spool_types.*LIMIT/su,
        ),
      ]),
    );
  });

  it('keeps malformed measured usage unresolved without falling back to the recipe', async () => {
    const context = fixture({
      usages: [
        {
          id: 'usage-bad',
          sessionId: 'session-1',
          startKg: 30,
          endKg: null,
          closedAt: null,
          releasedReason: null,
          episodes: [],
          bigBag: {
            id: 'bag-bad',
            code: 'BB-BAD',
            material: 'ПНД',
            baseRawMaterialDefinitionId: null,
            priceKopecksPerKg: null,
            priceSource: null,
            priceEffectiveAt: null,
            createdAt: new Date('2026-07-31T00:00:00.000Z'),
          },
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(prepared.actualInput?.materialBasis).toEqual({
      kind: 'unresolved',
      reason: 'material_usage_unresolved',
    });
    expect(prepared.sourceSnapshot?.material).toEqual(
      expect.objectContaining({
        kind: 'unresolved',
        sources: [{ usageId: 'usage-bad', bigBagId: 'bag-bad', materialDefinitionId: null }],
        safeInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    );
  });

  it('prepares a complete provisional cost while the production session is open', async () => {
    const openFact = fact('roll-1', 10, {
      rootSessionStatus: 'active',
      rootSessionEndedAt: null,
      shift: {
        id: 'shift-1',
        label: 'Смена 1',
        status: 'open',
        plannedStartAt: null,
        plannedEndAt: null,
        endedAt: null,
      },
      machineAssignment: null,
      dispatchStatus: 'ready_for_warehouse',
      dispatchCompletedAt: null,
    });
    const context = fixture({
      requestedFacts: [openFact],
      sessionFacts: [openFact],
      orderFacts: [openFact],
      usages: [
        {
          id: 'usage-open',
          sessionId: 'session-1',
          startKg: 30,
          endKg: null,
          closedAt: null,
          releasedReason: null,
          episodes: [
            {
              sequence: 1,
              startKg: 30,
              endKg: null,
              closeKind: null,
              closedAt: null,
            },
          ],
          bigBag: {
            id: 'bag-open',
            code: 'BB-OPEN',
            material: 'ПНД',
            baseRawMaterialDefinitionId: 'material-1',
            priceKopecksPerKg: 2_000,
            priceSource: 'Поставка 1',
            priceEffectiveAt: new Date('2026-08-01T00:00:00.000Z'),
            createdAt: new Date('2026-07-31T00:00:00.000Z'),
          },
        },
      ],
    });

    const prepared = (
      await context.service.prepare(['roll-1'], new Date('2026-08-02T17:00:00.000Z'))
    ).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!)).toMatchObject({
      status: 'partial',
      materialAmountKopecks: null,
      payrollAmountKopecks: null,
      unresolvedReasons: ['material_usage_unresolved', 'payroll_unresolved'],
    });
    expect(calculateRollProductionCost(prepared.pendingInput!)).toMatchObject({
      status: 'complete',
      materialAmountKopecks: 20_000,
      spoolAmountKopecks: 9_000,
      payrollAmountKopecks: 4_000,
      additionalAmountKopecks: 100,
      totalAmountKopecks: 33_100,
    });
  });

  it('uses the immutable position material rate when historical usage and a recipe price are missing', async () => {
    const context = fixture({
      materialPrices: [],
      observedMaterialSnapshots: [
        {
          id: 'snapshot-peer-1',
          rollDispatchItemId: 'roll-peer-1',
          version: 1,
          basisWeightGrams: 20_000,
          materialAmountKopecks: 50_000n,
          createdAt: new Date('2026-08-03T00:00:00.000Z'),
          rollDispatchItem: { orderLineId: 'position-1' },
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!)).toMatchObject({
      materialAmountKopecks: null,
      unresolvedReasons: ['material_price_unresolved'],
    });
    expect(calculateRollProductionCost(prepared.pendingInput!)).toMatchObject({
      status: 'complete',
      materialAmountKopecks: 25_000,
      totalAmountKopecks: 38_100,
    });
  });

  it('freezes an unsealed ProductionOrder cost as explicit unresolved provenance', async () => {
    const context = fixture({
      orderRows: [
        {
          id: 'roll-1',
          productionOrderId: 'production-order-1',
          status: 'done',
          replacementAttempt: null,
          operatorLine: { defects: [] },
        },
        {
          id: 'roll-2',
          productionOrderId: 'production-order-1',
          status: 'in_progress',
          replacementAttempt: null,
          operatorLine: { defects: [] },
        },
      ],
      additionalCosts: [
        {
          id: 'order-cost-1',
          rollDispatchItemId: null,
          productionOrderId: 'production-order-1',
          allocationBasis: 'finished_net_kg',
          amountKopecks: 300,
          source: 'Наладка',
          effectiveAt: new Date('2026-08-02T09:00:00.000Z'),
          reason: 'Наладка заказа',
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;

    expect(calculateRollProductionCost(prepared.actualInput!).unresolvedReasons).toContain(
      'order_cost_allocation_unresolved',
    );
    expect(prepared.sourceSnapshot?.additional).toEqual([
      expect.objectContaining({
        kind: 'unresolved',
        sourceId: 'order-cost-1',
        productionOrderId: 'production-order-1',
        observedRollIds: ['roll-1', 'roll-2'],
        safeInputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    ]);
    expect(() => buildProductionCostSourceSnapshot(prepared.sourceSnapshot!)).not.toThrow();
  });

  it('allocates an order cost only across terminal non-defect replacement leaves', async () => {
    const roll1 = fact('roll-1', 10);
    const roll2 = fact('roll-2', 20);
    const context = fixture({
      requestedFacts: [roll1],
      sessionFacts: [roll1, roll2],
      orderFacts: [roll1, roll2],
      orderRows: [
        {
          id: 'roll-old',
          productionOrderId: 'production-order-1',
          status: 'cancelled',
          replacementAttempt: { id: 'roll-1' },
          operatorLine: { defects: [] },
        },
        {
          id: 'roll-1',
          productionOrderId: 'production-order-1',
          status: 'done',
          replacementAttempt: null,
          operatorLine: { defects: [] },
        },
        {
          id: 'roll-defect',
          productionOrderId: 'production-order-1',
          status: 'done',
          replacementAttempt: { id: 'roll-2' },
          operatorLine: { defects: [{ id: 'defect-1' }] },
        },
        {
          id: 'roll-2',
          productionOrderId: 'production-order-1',
          status: 'done',
          replacementAttempt: null,
          operatorLine: { defects: [] },
        },
      ],
      additionalCosts: [
        {
          id: 'order-cost-1',
          rollDispatchItemId: null,
          productionOrderId: 'production-order-1',
          allocationBasis: 'finished_net_kg',
          amountKopecks: 300,
          source: 'Наладка',
          effectiveAt: new Date('2026-08-02T09:00:00.000Z'),
          reason: 'Наладка заказа',
        },
      ],
    });

    const prepared = (await context.service.prepare(['roll-1'], GENERATED_AT)).get('roll-1')!;
    const calculation = calculateRollProductionCost(prepared.actualInput!);

    expect(calculation.additionalAmountKopecks).toBe(100);
    expect(prepared.sourceSnapshot?.additional).toEqual([
      expect.objectContaining({
        kind: 'order_allocation',
        totalAmountKopecks: 300,
        sealProof: expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({ rollDispatchItemId: 'roll-old', status: 'cancelled' }),
            expect.objectContaining({ rollDispatchItemId: 'roll-defect', status: 'defect' }),
          ]),
        }),
      }),
    ]);
    expect(() => buildProductionCostSourceSnapshot(prepared.sourceSnapshot!)).not.toThrow();
  });
});
