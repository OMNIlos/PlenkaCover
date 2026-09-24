import type {
  DirectorPayrollFactsSnapshot,
  DirectorPayrollProductionFact,
  DirectorPayrollSessionFact,
} from './director-payroll-facts.service';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../../common/payroll-tariffs/payroll-tariff-engine';
import { PayrollTariffResolver } from '../../common/payroll-tariffs/payroll-tariff-resolver';
import { DirectorPayrollService } from './director-payroll.service';

const GENERATED_AT = new Date('2026-08-12T15:00:00.000Z');
const QUERY = { from: '2026-07-01', to: '2026-08-12' };

/** The three closed «Бегемот» sessions the pilot actually ran. */
function session(
  id: string,
  overrides: Partial<DirectorPayrollSessionFact> = {},
): DirectorPayrollSessionFact {
  return {
    sessionId: `session-${id}`,
    operatorId: 'operator-a',
    operatorName: 'Ахметов Булат',
    post: { id: 'post-1', code: 'POST-1', name: 'Бегемот' },
    shift: { id: `shift-${id}`, label: `Смена ${id}`, status: 'closed' },
    startedAt: new Date('2026-08-05T11:47:09.110Z'),
    endedAt: new Date('2026-08-05T12:41:24.300Z'),
    processedKg: 19,
    materialNames: ['ПВД Айка'],
    ...overrides,
  };
}

function roll(
  id: string,
  overrides: Partial<DirectorPayrollProductionFact> = {},
): DirectorPayrollProductionFact {
  return {
    lineId: `line-${id}`,
    rollId: `roll-${id}`,
    rollCode: `ROLL-${id}`,
    orderId: `order-${id}`,
    orderNumber: `ORDER-${id}`,
    actualKg: 10,
    producedAt: new Date('2026-08-05T12:00:00.000Z'),
    operatorId: 'operator-a',
    operatorName: 'Ахметов Булат',
    rootSessionId: 'session-a',
    shift: {
      id: 'shift-a',
      label: 'Смена a',
      status: 'closed',
      plannedStartAt: null,
      plannedEndAt: null,
    },
    post: { id: 'post-1', code: 'POST-1', name: 'Бегемот' },
    dispatchStatus: 'done',
    operatorStep: 'warehouse',
    hasDefect: false,
    filmType: 'Рукав',
    counterpartyLegalName: 'ООО Покупатель',
    materialKinds: [],
    ...overrides,
  };
}

function setup(snapshot: Partial<DirectorPayrollFactsSnapshot>) {
  const load = jest.fn().mockResolvedValue({
    periodFacts: [],
    thresholdFacts: [],
    sessionFacts: [],
    ...snapshot,
  });
  const loadPublishedSchedule = jest.fn().mockResolvedValue([
    {
      reference: {
        id: 'payroll-tariff-order-8-09-25-2025-09-29',
        name: 'Приказ № 8-09/25',
        effectiveFrom: '2025-09-29',
        currency: 'RUB',
      },
      effectiveFromMs: Date.parse('2025-09-28T21:00:00.000Z'),
      revision: 1,
      matrix: LEGACY_PAYROLL_TARIFF_MATRIX_V1,
      matrixHash: 'a'.repeat(64),
    },
  ]);
  return new DirectorPayrollService(
    { load } as never,
    { loadPublishedSchedule } as never,
    new PayrollTariffResolver(),
  );
}

describe('payroll is paid on the raw material a shift processed', () => {
  it('pays each closed session its consumption at the price.md rate', async () => {
    // 19 кг × 4,50 ₽ + 1000 кг × 4,50 ₽; the middle session consumed nothing.
    const service = setup({
      sessionFacts: [
        session('a'),
        session('b', {
          startedAt: new Date('2026-08-06T13:38:01.609Z'),
          endedAt: new Date('2026-08-06T19:39:24.826Z'),
          processedKg: 0,
        }),
        session('c', {
          startedAt: new Date('2026-08-07T15:38:54.808Z'),
          endedAt: new Date('2026-08-11T18:57:59.950Z'),
          processedKg: 1_000,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.summary.payableAmountKopecks).toBe(458_550);
    expect(preview.summary.payableKg).toBe(1_019);
    // The middle stint remains an explicit resolved zero rather than disappearing.
    expect(preview.summary.machineShiftCount).toBe(3);
    expect(preview.operators).toEqual([
      expect.objectContaining({
        operatorId: 'operator-a',
        amountKopecks: 458_550,
        payableKg: 1_019,
        machineShiftCount: 3,
      }),
    ]);
  });

  it('keeps a long stint on its own ladder when it shares a shift with a short one', async () => {
    // Both «Бегемот» stints price at 450 к/кг, so a row keyed only by rate would
    // merge them and report the 99-hour stint as a 12-hour shift.
    const shared = { id: 'shift-1', label: 'Смена 1', status: 'closed' };
    const service = setup({
      sessionFacts: [
        session('short', {
          shift: shared,
          startedAt: new Date('2026-08-06T13:38:01.609Z'),
          endedAt: new Date('2026-08-06T19:39:24.826Z'),
          processedKg: 10,
        }),
        session('long', {
          shift: shared,
          startedAt: new Date('2026-08-07T15:38:54.808Z'),
          endedAt: new Date('2026-08-11T18:57:59.950Z'),
          processedKg: 1_000,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(
      preview.breakdown.map(({ shiftDuration, payableKg, basisLabel }) => ({
        shiftDuration,
        payableKg,
        basisLabel,
      })),
    ).toEqual([
      {
        shiftDuration: '24h',
        payableKg: 1_000,
        basisLabel: expect.stringContaining('1000.000 кг'),
      },
      { shiftDuration: '12h', payableKg: 10, basisLabel: expect.stringContaining('10.000 кг') },
    ]);
  });

  it('states the aggregate on a row that merges repeat stints', async () => {
    const service = setup({
      sessionFacts: [
        session('first', { processedKg: 19 }),
        session('second', {
          sessionId: 'session-second',
          shift: { id: 'shift-first', label: 'Смена first', status: 'closed' },
          processedKg: 31,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.breakdown).toEqual([
      expect.objectContaining({
        payableKg: 50,
        shiftOutputKg: 50,
        amountKopecks: 22_500,
        basisLabel: expect.stringContaining('50.000 кг'),
      }),
    ]);
  });

  it('retains a resolved zero-consumption stint as 0 kg / 0 kopecks', async () => {
    const service = setup({
      sessionFacts: [
        session('paid', { processedKg: 19 }),
        session('idle', {
          sessionId: 'session-idle',
          shift: { id: 'shift-idle', label: 'Смена idle', status: 'closed' },
          processedKg: 0,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payableKg: 19 }),
        expect.objectContaining({
          shiftId: 'shift-idle',
          payableKg: 0,
          amountKopecks: 0,
          tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
        }),
      ]),
    );
    expect(preview.summary.payableAmountKopecks).toBe(8_550);
  });

  it('rounds a merged row once, from the row total', async () => {
    // Rounding each stint and adding drifts a kopeck away from the row total,
    // and the client checks the row against its own total.
    const service = setup({
      sessionFacts: [
        // 0,001 кг × 4,50 ₽ rounds to nothing on its own but to a kopeck together.
        session('a', { processedKg: 0.001 }),
        session('b', {
          sessionId: 'session-b',
          shift: { id: 'shift-a', label: 'Смена a', status: 'closed' },
          processedKg: 0.001,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    const row = preview.breakdown[0]!;
    expect(Math.round((Math.round(row.payableKg * 1_000) * row.rateKopecksPerKg) / 1_000)).toBe(
      row.amountKopecks,
    );
  });

  it('satisfies the invariants the «Зарплаты» client re-checks before rendering', async () => {
    // The deployed client validates the payload and shows «Не удалось загрузить
    // расчёт зарплаты» for the whole response if any of these fail.
    const service = setup({
      sessionFacts: [
        session('a', { processedKg: 19 }),
        session('b', {
          sessionId: 'session-b',
          operatorId: 'operator-b',
          operatorName: 'Хабибулин Руслан',
          shift: { id: 'shift-b', label: 'Смена b', status: 'closed' },
          processedKg: 0,
        }),
        session('c', {
          sessionId: 'session-c',
          operatorId: 'operator-b',
          operatorName: 'Хабибулин Руслан',
          shift: { id: 'shift-c', label: 'Смена c', status: 'closed' },
          startedAt: new Date('2026-08-07T15:38:54.808Z'),
          endedAt: new Date('2026-08-11T18:57:59.950Z'),
          processedKg: 1_000,
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);
    const grams = (kg: number) => Math.round(kg * 1_000);

    expect(preview.breakdown.length).toBeGreaterThan(0);
    for (const row of preview.breakdown) {
      expect(row.payableKg).toBeGreaterThanOrEqual(0);
      expect(row.shiftOutputKg).toBeGreaterThanOrEqual(0);
      expect(Math.round((grams(row.payableKg) * row.rateKopecksPerKg) / 1_000)).toBe(
        row.amountKopecks,
      );
    }
    expect(new Set(preview.breakdown.map(({ id }) => id)).size).toBe(preview.breakdown.length);
    expect(preview.summary.operatorCount).toBe(preview.operators.length);
    expect(new Set(preview.breakdown.map((row) => `${row.shiftId} ${row.postId}`)).size).toBe(
      preview.summary.machineShiftCount,
    );

    for (const operator of preview.operators) {
      const rows = preview.breakdown.filter((row) => row.operatorId === operator.operatorId);
      expect(grams(operator.payableKg)).toBe(
        rows.reduce((sum, row) => sum + grams(row.payableKg), 0),
      );
      expect(operator.amountKopecks).toBe(rows.reduce((sum, row) => sum + row.amountKopecks, 0));
      expect(operator.machineShiftCount).toBe(
        new Set(rows.map((row) => `${row.shiftId} ${row.postId}`)).size,
      );
    }
  });

  it('does not pay rolls that were never covered by a measured shift', async () => {
    // Roll weight is not the pay basis; only Big-Bag consumption is.
    const service = setup({ periodFacts: [roll('1', { actualKg: 46.25 })] });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.summary.payableAmountKopecks).toBe(0);
  });

  it('leaves an open session unpaid and names the reason', async () => {
    const service = setup({
      sessionFacts: [session('open', { endedAt: null, processedKg: null })],
      periodFacts: [roll('1', { rootSessionId: 'session-open' })],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.summary.payableAmountKopecks).toBe(0);
    expect(preview.status).toBe('partial');
    expect(preview.unresolved[0]).toMatchObject({
      rollCode: 'ROLL-1',
      reasons: ['shift_duration_unresolved'],
    });
  });

  it('flags «Пнд новая» instead of inventing a rate for it', async () => {
    const service = setup({
      sessionFacts: [session('pnd', { post: { id: 'post-6', code: 'POST-6', name: 'Пнд новая' } })],
      periodFacts: [
        roll('1', {
          rootSessionId: 'session-pnd',
          post: { id: 'post-6', code: 'POST-6', name: 'Пнд новая' },
        }),
      ],
    });

    const preview = await service.getPreview(QUERY, GENERATED_AT);

    expect(preview.summary.payableAmountKopecks).toBe(0);
    expect(preview.unresolved[0]!.reasons).toContain('machine_family_unresolved');
  });
});
