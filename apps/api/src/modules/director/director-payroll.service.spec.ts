import type { DirectorPayrollPreview, PayrollTariffMatrixV1 } from '@plenka/contracts';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../../common/payroll-tariffs/payroll-tariff-engine';
import type { PublishedPayrollTariffOrder } from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import type {
  DirectorPayrollFactsSnapshot,
  DirectorPayrollProductionFact,
  DirectorPayrollSessionFact,
} from './director-payroll-facts.service';
import { DirectorPayrollService } from './director-payroll.service';

const GENERATED_AT = new Date('2026-07-31T15:00:00.000Z');
const QUERY = { from: '2026-07-10', to: '2026-07-20' };

function publishedOrder(
  id: string,
  name: string,
  effectiveFrom: string,
  matrix: PayrollTariffMatrixV1 = LEGACY_PAYROLL_TARIFF_MATRIX_V1,
): PublishedPayrollTariffOrder {
  return {
    reference: { id, name, effectiveFrom, currency: 'RUB' },
    effectiveFromMs: Date.parse(`${effectiveFrom}T21:00:00.000Z`) - 24 * 60 * 60 * 1_000,
    revision: 1,
    matrix,
    matrixHash: id.padEnd(64, '0').slice(0, 64),
  };
}

const LEGACY_ORDER = publishedOrder(
  'payroll-tariff-order-8-09-25-2025-09-29',
  'Приказ № 8-09/25',
  '2025-09-29',
);

function session(
  id: string,
  overrides: Partial<DirectorPayrollSessionFact> = {},
): DirectorPayrollSessionFact {
  return {
    sessionId: `session-${id}`,
    operatorId: 'operator-a',
    operatorName: 'Анна',
    post: { id: 'post-urp', code: 'URP', name: 'УРП' },
    shift: { id: 'shift-1', label: 'Смена 1', status: 'closed' },
    startedAt: new Date('2026-07-12T06:00:00.000Z'),
    endedAt: new Date('2026-07-12T16:00:00.000Z'),
    processedKg: 500,
    materialNames: ['ПВД Айка'],
    ...overrides,
  };
}

function fact(
  id: string,
  overrides: Partial<DirectorPayrollProductionFact> = {},
): DirectorPayrollProductionFact {
  return {
    lineId: `line-${id}`,
    rollId: `roll-${id}`,
    rollCode: `ROLL-${id}`,
    orderId: `order-${id}`,
    orderNumber: `ORDER-${id}`,
    actualKg: 100,
    producedAt: new Date('2026-07-12T09:00:00.000Z'),
    operatorId: 'operator-a',
    operatorName: 'Анна',
    rootSessionId: 'session-a',
    rootSessionStatus: 'closed',
    rootSessionStartedAt: new Date('2026-07-12T06:00:00.000Z'),
    rootSessionEndedAt: new Date('2026-07-12T16:00:00.000Z'),
    machineAssignment: { id: 'assignment-a', status: 'completed' },
    shift: {
      id: 'shift-1',
      label: 'Смена 1',
      status: 'closed',
      plannedStartAt: null,
      plannedEndAt: null,
    },
    post: { id: 'post-urp', code: 'URP', name: 'УРП' },
    dispatchStatus: 'done',
    operatorStep: 'warehouse',
    hasDefect: false,
    filmType: 'Рукав',
    counterpartyLegalName: 'ООО Покупатель',
    materialKinds: [],
    materialComponents: [
      { rawMaterialDefinitionId: 'rmd-base-aika', name: 'ПВД Айка', shareBasisPoints: 10_000 },
    ],
    ...overrides,
  };
}

function setup(
  snapshot: Partial<DirectorPayrollFactsSnapshot>,
  schedule: readonly PublishedPayrollTariffOrder[] = [LEGACY_ORDER],
) {
  const load = jest.fn().mockResolvedValue({
    periodFacts: [],
    thresholdFacts: [],
    sessionFacts: [],
    ...snapshot,
  });
  const loadPublishedSchedule = jest.fn().mockResolvedValue(schedule);
  return {
    load,
    loadPublishedSchedule,
    service: new DirectorPayrollService(
      { load } as never,
      { loadPublishedSchedule } as never,
      new PayrollTariffResolver(),
    ),
  };
}

function unresolvedReasons(
  preview: DirectorPayrollPreview,
): DirectorPayrollPreview['unresolved'][number]['reasons'] {
  expect(preview.unresolved).toHaveLength(1);
  return preview.unresolved[0]!.reasons;
}

describe('DirectorPayrollService', () => {
  it('splits a mixed session by tag using the total output band, even outside the report roll window', async () => {
    const { service } = setup({
      periodFacts: [],
      sessionFacts: [
        session('mixed', {
          processedKg: 800,
          materialNames: ['Первичное'],
          rolls: [
            { grams: 400_000, birka: 'ГОСТ103' },
            { grams: 400_000, birka: 'Тех' },
          ],
        }),
      ],
    });
    const preview = await service.getPreview(QUERY, GENERATED_AT);
    expect(preview.summary).toMatchObject({
      payableKg: 800,
      payableAmountKopecks: 400_000,
      machineShiftCount: 1,
    });
    expect(preview.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          materialClass: 'primary',
          payableKg: 400,
          shiftOutputKg: 800,
          rateKopecksPerKg: 450,
          amountKopecks: 180_000,
        }),
        expect.objectContaining({
          materialClass: 'secondary',
          payableKg: 400,
          shiftOutputKg: 800,
          rateKopecksPerKg: 550,
          amountKopecks: 220_000,
        }),
      ]),
    );
    expect(preview.breakdown).toHaveLength(2);
  });

  it('prices thin rolls individually before grouping their weight and keeps 7 kg on the regular rate', async () => {
    const { service } = setup({
      sessionFacts: [
        session('thin', {
          processedKg: 19,
          rolls: [
            { grams: 6_000, birka: 'ГОСТ' },
            { grams: 6_000, birka: 'Тех' },
            { grams: 7_000, birka: 'i' },
          ],
        }),
      ],
    });
    const preview = await service.getPreview(QUERY, GENERATED_AT);
    expect(preview.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tariffRule: 'thin_roll',
          payableKg: 12,
          rateKopecksPerKg: 650,
          amountKopecks: 7_800,
        }),
        expect.objectContaining({
          tariffRule: 'secondary',
          payableKg: 7,
          rateKopecksPerKg: 500,
          amountKopecks: 3_500,
        }),
      ]),
    );
    expect(preview.summary.payableAmountKopecks).toBe(11_300);
  });
  it('pays each operator for the material their own sessions processed', async () => {
    const { load, service } = setup({
      sessionFacts: [
        session('a'),
        session('b', {
          sessionId: 'session-b',
          operatorId: 'operator-b',
          operatorName: 'Борис',
          shift: { id: 'shift-2', label: 'Смена 2', status: 'closed' },
          processedKg: 800,
          materialNames: ['ПВД Вторичное'],
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        from: QUERY.from,
        to: QUERY.to,
        fromUtc: new Date('2026-07-09T21:00:00.000Z'),
        toExclusiveUtc: new Date('2026-07-20T21:00:00.000Z'),
      }),
      GENERATED_AT,
    );
    expect(preview.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operatorId: 'operator-a',
          payableKg: 500,
          tariffRule: 'primary',
          rateKopecksPerKg: 400,
          amountKopecks: 200_000,
        }),
        expect.objectContaining({
          operatorId: 'operator-b',
          payableKg: 800,
          tariffRule: 'secondary',
          rateKopecksPerKg: 550,
          amountKopecks: 440_000,
        }),
      ]),
    );
    expect(preview.summary).toMatchObject({
      payableAmountKopecks: 640_000,
      payableKg: 1_300,
      machineShiftCount: 2,
      operatorCount: 2,
    });
    expect(preview.status).toBe('complete');
  });

  it('shows an operator only their own sessions', async () => {
    const { service } = setup({
      sessionFacts: [
        session('a'),
        session('b', {
          sessionId: 'session-b',
          operatorId: 'operator-b',
          operatorName: 'Борис',
        }),
      ],
    });

    const preview = await service.getOperatorPreview(QUERY, 'operator-a', GENERATED_AT);

    expect(preview.operators).toEqual([
      expect.objectContaining({ operatorId: 'operator-a', payableKg: 500 }),
    ]);
    expect(JSON.stringify(preview)).not.toContain('operator-b');
  });

  it('sums repeat stints on the same post and shift into one row', async () => {
    const { service } = setup({
      sessionFacts: [
        session('a', { processedKg: 100 }),
        session('b', { sessionId: 'session-b', processedKg: 200 }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.breakdown).toEqual([
      expect.objectContaining({ payableKg: 300, amountKopecks: 120_000 }),
    ]);
    expect(preview.summary.machineShiftCount).toBe(1);
  });

  it('selects orders by session endedAt, ignores a future order and loads one schedule', async () => {
    const boundary = new Date('2026-08-01T21:00:00.000Z');
    const nextMatrix = structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    nextMatrix.ladders.urp12h[0]!.primaryRateKopecksPerKg = 777;
    const futureMatrix = structuredClone(nextMatrix);
    futureMatrix.ladders.urp12h[0]!.primaryRateKopecksPerKg = 999;
    const next = publishedOrder('order-next', 'Приказ следующий', '2026-08-02', nextMatrix);
    const future = publishedOrder('order-future', 'Приказ будущий', '2026-08-03', futureMatrix);
    const { service, loadPublishedSchedule } = setup(
      {
        sessionFacts: [
          session('before', {
            sessionId: 'session-before',
            shift: { id: 'shift-before', label: 'До границы', status: 'closed' },
            startedAt: new Date('2026-08-01T08:59:59.999Z'),
            endedAt: new Date(boundary.getTime() - 1),
            processedKg: 100,
          }),
          session('at', {
            sessionId: 'session-at',
            shift: { id: 'shift-at', label: 'На границе', status: 'closed' },
            startedAt: new Date('2026-08-01T09:00:00.000Z'),
            endedAt: boundary,
            processedKg: 100,
          }),
        ],
      },
      [LEGACY_ORDER, next, future],
    );

    const preview = await service.getPreview(
      { from: '2026-08-01', to: '2026-08-02' },
      new Date('2026-08-04T00:00:00.000Z'),
    );

    expect(loadPublishedSchedule).toHaveBeenCalledTimes(1);
    expect(loadPublishedSchedule).toHaveBeenCalledWith(boundary, undefined);
    expect(preview.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shiftId: 'shift-before',
          tariffOrderId: LEGACY_ORDER.reference.id,
          rateKopecksPerKg: 400,
          amountKopecks: 40_000,
        }),
        expect.objectContaining({
          shiftId: 'shift-at',
          tariffOrderId: next.reference.id,
          rateKopecksPerKg: 777,
          amountKopecks: 77_700,
        }),
      ]),
    );
    expect(preview.summary.payableAmountKopecks).toBe(117_700);
    expect(preview.appliedTariffOrders).toEqual([
      expect.objectContaining({ id: LEGACY_ORDER.reference.id, matrix: LEGACY_ORDER.matrix }),
      expect.objectContaining({ id: next.reference.id, matrix: next.matrix }),
    ]);
    expect(preview.appliedTariffOrders).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: future.reference.id })]),
    );
  });

  it('uses endedAt rather than a roll producedAt when deciding salary applicability', async () => {
    const effectiveAt = new Date('2025-09-28T21:00:00.000Z');
    const { service } = setup({
      sessionFacts: [
        session('boundary', {
          sessionId: 'session-boundary',
          shift: { id: 'shift-boundary', label: 'Граница', status: 'closed' },
          startedAt: new Date('2025-09-28T09:00:00.000Z'),
          endedAt: effectiveAt,
          processedKg: 100,
        }),
      ],
      periodFacts: [
        fact('before-boundary', {
          producedAt: new Date(effectiveAt.getTime() - 1),
          rootSessionId: 'session-boundary',
          rootSessionStartedAt: new Date('2025-09-28T09:00:00.000Z'),
          rootSessionEndedAt: effectiveAt,
          shift: {
            id: 'shift-boundary',
            label: 'Граница',
            status: 'closed',
            plannedStartAt: null,
            plannedEndAt: null,
          },
        }),
      ],
    });

    const preview = await service.getPreview(
      { from: '2025-09-28', to: '2025-09-29' },
      new Date('2025-09-30T00:00:00.000Z'),
    );

    expect(preview.status).toBe('complete');
    expect(preview.unresolved).toEqual([]);
    expect(preview.breakdown[0]).toMatchObject({
      tariffOrderId: LEGACY_ORDER.reference.id,
      amountKopecks: 40_000,
    });
  });

  it('counts defective rolls as exclusions without touching pay', async () => {
    const { service } = setup({
      sessionFacts: [session('a')],
      periodFacts: [
        fact('defective', {
          actualKg: 10,
          dispatchStatus: 'defect',
          operatorStep: 'defect',
          hasDefect: true,
        }),
        fact('ok'),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.summary).toMatchObject({
      payableAmountKopecks: 200_000,
      excludedDefectKg: 10,
      excludedDefectRollCount: 1,
      unresolvedFactCount: 0,
    });
  });

  it.each([
    [
      'missing production operator and post session',
      { operatorId: null, operatorName: null, rootSessionId: null },
      ['shift_not_closed', 'production_operator_unresolved', 'post_session_unresolved'],
    ],
    [
      'missing production shift and post',
      { shift: null, post: null },
      ['shift_unresolved', 'machine_family_unresolved'],
    ],
  ])('flags a roll with %s', async (_name, overrides, reasons) => {
    const { service } = setup({
      sessionFacts: [session('a')],
      periodFacts: [fact('candidate', overrides)],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(unresolvedReasons(preview)).toEqual(reasons);
    expect(preview.status).toBe('partial');
    expect(preview.summary).toMatchObject({ unresolvedKg: 100, unresolvedFactCount: 1 });
  });

  it('marks a salary fact before the first order from its session endedAt', async () => {
    const endedAt = new Date('2025-09-28T20:59:59.999Z');
    const { service } = setup({
      sessionFacts: [
        session('before-policy', {
          sessionId: 'session-before-policy',
          startedAt: new Date('2025-09-28T08:00:00.000Z'),
          endedAt,
        }),
      ],
      periodFacts: [
        fact('before-policy', {
          producedAt: endedAt,
          rootSessionId: 'session-before-policy',
          rootSessionStartedAt: new Date('2025-09-28T08:00:00.000Z'),
          rootSessionEndedAt: endedAt,
        }),
      ],
    });

    const preview = await service.getPreview(
      { from: '2025-09-28', to: '2025-09-28' },
      new Date('2025-09-30T00:00:00.000Z'),
    );

    expect(unresolvedReasons(preview)).toEqual(['before_policy_effective_date']);
    expect(preview.breakdown).toEqual([]);
  });

  it('orders merged structural and shift reasons according to the public contract', async () => {
    const { service } = setup({
      sessionFacts: [session('a', { post: { id: 'p', code: 'X', name: 'Пнд новая' } })],
      periodFacts: [
        fact('candidate', {
          producedAt: new Date('2025-09-28T20:59:59.999Z'),
          operatorId: null,
          operatorName: null,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(unresolvedReasons(preview)).toEqual([
      'production_operator_unresolved',
      'machine_family_unresolved',
    ]);
    expect(preview.breakdown).toEqual([]);
  });

  it('reports an empty period rather than a zero payroll', async () => {
    const { service } = setup({});

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.status).toBe('empty');
    expect(preview.summary).toMatchObject({
      payableAmountKopecks: 0,
      payableKg: 0,
      operatorCount: 0,
      unresolvedFactCount: 0,
    });
  });

  it('returns identical output regardless of the order facts arrive in', async () => {
    const sessions = [
      session('a'),
      session('b', { sessionId: 'session-b', operatorId: 'operator-b', operatorName: 'Борис' }),
      session('c', {
        sessionId: 'session-c',
        shift: { id: 'shift-3', label: 'Смена 3', status: 'closed' },
        processedKg: 1_400,
      }),
    ];
    const rolls = [fact('1'), fact('2', { rootSessionId: 'session-x' })];
    const forward = setup({ sessionFacts: sessions, periodFacts: rolls });
    const reversed = setup({
      sessionFacts: [...sessions].reverse(),
      periodFacts: [...rolls].reverse(),
    });

    const [first, second] = await Promise.all([
      forward.service.getPreview(QUERY, GENERATED_AT),
      reversed.service.getPreview(QUERY, GENERATED_AT),
    ]);

    expect(first).toEqual(second);
    expect(new Set(first.breakdown.map(({ id }) => id)).size).toBe(first.breakdown.length);
  });

  it('leaves a session without a resolvable operator out of the payroll', async () => {
    const { service } = setup({
      sessionFacts: [session('a', { operatorId: null, operatorName: null })],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.breakdown).toEqual([]);
    expect(preview.summary.payableAmountKopecks).toBe(0);
  });
});
