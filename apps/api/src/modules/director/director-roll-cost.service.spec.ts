import type { RollProductionCostView } from '@plenka/contracts';
import type { DirectorPayrollProductionFact } from './director-payroll-facts.service';
import { DirectorRollCostService } from './director-roll-cost.service';

const GENERATED_AT = new Date('2026-08-04T00:00:00.000Z');

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
    producedAt: new Date('2026-08-02T10:00:00.000Z'),
    operatorId: 'operator-1',
    operatorName: 'Оператор 1',
    rootSessionId: 'session-1',
    shift: {
      id: 'shift-1',
      label: 'Смена 1',
      status: 'closed',
      plannedStartAt: new Date('2026-08-02T06:00:00.000Z'),
      plannedEndAt: new Date('2026-08-02T18:00:00.000Z'),
    },
    post: { id: 'post-1', code: 'P1', name: 'УРП' },
    dispatchStatus: 'done',
    operatorStep: 'warehouse',
    hasDefect: false,
    filmType: 'Рукав',
    counterpartyLegalName: 'ОО Клиент',
    materialKinds: ['primary'],
    ...overrides,
  };
}

function completeCost(overrides: Partial<RollProductionCostView> = {}): RollProductionCostView {
  return {
    kind: 'actual_snapshot',
    status: 'complete',
    calculationVersion: 'production-cost-v1',
    snapshotId: 'snapshot-1',
    version: 1,
    producedAt: '2026-08-02T10:00:00.000Z',
    closedAt: '2026-08-02T18:00:00.000Z',
    createdAt: '2026-08-02T18:00:01.000Z',
    basis: { kind: 'actual', weightGrams: 10_000 },
    materialAmountKopecks: 20_000,
    spoolAmountKopecks: 9_000,
    payrollAmountKopecks: 4_000,
    additionalAmountKopecks: 200,
    totalAmountKopecks: 33_200,
    totalKopecksPerKg: 3_320,
    unresolvedReasons: [],
    ...overrides,
  } as RollProductionCostView;
}

function fixture(
  periodFacts: DirectorPayrollProductionFact[],
  costs: ReadonlyMap<string, RollProductionCostView>,
) {
  const facts = {
    load: jest.fn().mockResolvedValue({ periodFacts, thresholdFacts: periodFacts }),
  };
  const snapshots = {
    getViewsForRollIds: jest.fn().mockResolvedValue(new Map(costs)),
  };
  return {
    facts,
    snapshots,
    service: new DirectorRollCostService(facts as never, snapshots as never),
  };
}

describe('DirectorRollCostService', () => {
  it('delegates compatibility rows to one bounded authoritative snapshot lookup', async () => {
    const payrollSource = {
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      tariffOrderName: 'Приказ № 8-09/25',
      effectiveFrom: '2025-09-29',
      rateKopecksPerKg: 400,
      basisLabel: 'УРП · 12 ч · первичка',
    };
    const cost = { ...completeCost(), payrollSource } as RollProductionCostView;
    const context = fixture([fact('roll-1', 10)], new Map([['roll-1', cost]]));

    const result = await context.service.getPreview(
      { from: '2026-08-01', to: '2026-08-03' },
      GENERATED_AT,
    );

    expect(context.snapshots.getViewsForRollIds).toHaveBeenCalledTimes(1);
    expect(context.snapshots.getViewsForRollIds).toHaveBeenCalledWith(['roll-1'], GENERATED_AT);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'complete',
        summary: {
          rollCount: 1,
          completeRollCount: 1,
          partialRollCount: 0,
          completeCostKopecks: 33_200,
        },
        rows: [
          expect.objectContaining({
            rollId: 'roll-1',
            materialAmountKopecks: 20_000,
            payrollAmountKopecks: 4_000,
            payrollSource,
            additionalAmountKopecks: 200,
            totalAmountKopecks: 33_200,
            unresolvedReasons: [],
          }),
        ],
      }),
    );
  });

  it('preserves authoritative partial reasons without presenting a credible total', async () => {
    const partial: RollProductionCostView = {
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: 'production-cost-v1',
      basis: { kind: 'actual', weightGrams: 10_000 },
      materialAmountKopecks: null,
      spoolAmountKopecks: 9_000,
      payrollAmountKopecks: null,
      payrollSource: null,
      additionalAmountKopecks: 200,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['material_price_unresolved', 'payroll_unresolved'],
    };
    const context = fixture([fact('roll-1', 10)], new Map([['roll-1', partial]]));

    const result = await context.service.getPreview(
      { from: '2026-08-01', to: '2026-08-03' },
      GENERATED_AT,
    );

    expect(result.status).toBe('partial');
    expect(result.summary.completeCostKopecks).toBe(0);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        status: 'partial',
        materialAmountKopecks: null,
        payrollAmountKopecks: null,
        additionalAmountKopecks: 200,
        totalAmountKopecks: null,
        unresolvedReasons: ['material_price_unresolved', 'payroll_unresolved'],
      }),
    );
  });

  it('keeps the compatibility population boundary while sharing the same cost read', async () => {
    const good = fact('roll-good', 10);
    const defect = fact('roll-defect', 90, { hasDefect: true });
    const unfinished = fact('roll-open', 90, { operatorStep: 'roll' });
    const context = fixture(
      [good, defect, unfinished],
      new Map([['roll-good', completeCost({ snapshotId: 'snapshot-good' })]]),
    );

    const result = await context.service.getPreview(
      { from: '2026-08-01', to: '2026-08-03' },
      GENERATED_AT,
    );

    expect(context.snapshots.getViewsForRollIds).toHaveBeenCalledWith(['roll-good'], GENERATED_AT);
    expect(result.rows.map(({ rollId }) => rollId)).toEqual(['roll-good']);
  });

  it('fails closed when a requested shared projection is missing', async () => {
    const context = fixture([fact('roll-1', 10)], new Map());

    await expect(
      context.service.getPreview({ from: '2026-08-01', to: '2026-08-03' }, GENERATED_AT),
    ).rejects.toThrow('missing production cost projection for roll roll-1');
  });
});
