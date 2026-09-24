import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  payrollBirkaFromSnapshot,
  resolvePayrollRollRate,
  resolvePayrollShiftRate,
  type PayrollRollRateInput,
  type PayrollShiftRateInput,
} from './payroll-tariff-engine';

const at = (value: string) => new Date(value);

function shift(overrides: Partial<PayrollShiftRateInput> = {}): PayrollShiftRateInput {
  return {
    postName: 'Бегемот',
    startedAt: at('2026-08-05T00:00:00.000Z'),
    endedAt: at('2026-08-05T06:00:00.000Z'),
    processedGrams: 19_000,
    materialNames: ['ПВД Айка'],
    ...overrides,
  };
}

function roll(overrides: Partial<PayrollRollRateInput> = {}): PayrollRollRateInput {
  return {
    producedAt: at('2026-08-05T05:00:00.000Z'),
    postName: 'УРП',
    shiftStartedAt: at('2026-08-05T00:00:00.000Z'),
    shiftEndedAt: at('2026-08-05T12:00:00.000Z'),
    shiftOutputGrams: 800_000,
    rollGrams: 40_000,
    materialNames: ['ПВД Айка'],
    filmType: 'Прозрачная',
    counterpartyLegalName: 'ООО ПОКУПАТЕЛЬ',
    ...overrides,
  };
}

describe('payroll tariff engine', () => {
  it('uses a manual-only tag and keeps a selected standard tag authoritative', () => {
    expect(payrollBirkaFromSnapshot({ birka: ' ', manualBirka: 'Айка' })).toBe('Айка');
    expect(payrollBirkaFromSnapshot({ birka: 'ГОСТ', manualBirka: 'Тех' })).toBe('ГОСТ');
    expect(payrollBirkaFromSnapshot({ birka: 123, manualBirka: null })).toBeNull();
    expect(payrollBirkaFromSnapshot(null)).toBeNull();
  });
  it.each(['УРП', 'Матиль', 'Китайка'])(
    'applies every order threshold by tag on %s for 12 and 24 hours',
    (postName) => {
      for (const hours of [12, 24]) {
        const multiplier = hours / 12;
        const bands = [
          [750_000, 400],
          [1_000_000, 450],
          [1_250_000, 500],
        ] as const;
        for (const [threshold, primaryRate] of bands) {
          for (const extraGram of [0, 1]) {
            for (const [birka, surcharge] of [
              ['ГОСТ259', 0],
              ['(i)', 100],
            ] as const) {
              expect(
                resolvePayrollRollRate(
                  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
                  roll({
                    postName,
                    birka,
                    shiftEndedAt: new Date(
                      at('2026-08-05T00:00:00.000Z').getTime() + hours * 3_600_000,
                    ),
                    shiftOutputGrams: threshold * multiplier + extraGram,
                  }),
                ),
              ).toMatchObject({
                kind: 'resolved',
                rateKopecksPerKg: primaryRate + surcharge + extraGram * 50,
              });
            }
          }
        }
      }
    },
  );
  it.each([
    ['ГОСТ', 'primary', 450],
    ['ГОСТ103', 'primary', 450],
    ['ГОСТ259', 'primary', 450],
    ['i', 'secondary', 550],
    [' (i) ', 'secondary', 550],
    ['Айка', 'secondary', 550],
    ['тех', 'secondary', 550],
    ['(i) / Маркировка клиента', 'secondary', 550],
    ['Айка / Заказ клиента', 'secondary', 550],
    ['Тех / ГОСТ по документам клиента', 'secondary', 550],
    ['ГОСТ259 / Айка на упаковке клиента', 'primary', 450],
  ])('prices the %s tag ahead of the Big-Bag material', (birka, materialClass, rate) => {
    expect(
      resolvePayrollRollRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        roll({
          birka,
          materialNames: [materialClass === 'primary' ? 'Вторичное' : 'Первичное'],
        }),
      ),
    ).toMatchObject({ kind: 'resolved', materialClass, rateKopecksPerKg: rate });
  });
  it('prices Begemot on the ABC ladder without the Alabuga override', () => {
    expect(resolvePayrollShiftRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, shift())).toMatchObject({
      kind: 'resolved',
      machineFamily: 'abc_old',
      shiftDuration: '12h',
      tariffRule: 'abc_standard',
      rateKopecksPerKg: 450,
      amountKopecks: 8_550,
    });
    expect(
      resolvePayrollRollRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        roll({
          postName: 'Бегемот',
          counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      machineFamily: 'abc_old',
      tariffRule: 'abc_standard',
      specialCustomer: false,
    });
  });

  it('uses 12h inclusively and switches to 24h only after the boundary', () => {
    const startedAt = at('2026-08-05T00:00:00.000Z');
    expect(
      resolvePayrollShiftRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        shift({ startedAt, endedAt: at('2026-08-05T12:00:00.000Z') }),
      ),
    ).toMatchObject({ kind: 'resolved', shiftDuration: '12h' });
    expect(
      resolvePayrollShiftRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        shift({ startedAt, endedAt: at('2026-08-05T12:00:00.001Z') }),
      ),
    ).toMatchObject({ kind: 'resolved', shiftDuration: '24h' });
  });

  it('uses actual Big-Bag material names and preserves zero consumption', () => {
    expect(
      resolvePayrollShiftRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        shift({
          postName: 'УРП',
          processedGrams: 750_000,
          materialNames: ['Гранула вторичная ПЭ'],
        }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      materialClass: 'secondary',
      rateKopecksPerKg: 500,
      amountKopecks: 375_000,
    });
    expect(
      resolvePayrollShiftRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, shift({ processedGrams: 0 })),
    ).toMatchObject({ kind: 'resolved', amountKopecks: 0 });
  });

  it('prices Falz with the dedicated ABC rate and names it in the basis', () => {
    expect(
      resolvePayrollRollRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, roll({ rollGrams: 6_999 })),
    ).toMatchObject({ kind: 'resolved', tariffRule: 'thin_roll', rateKopecksPerKg: 650 });
    expect(
      resolvePayrollRollRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        roll({ postName: 'АВС старая', filmType: 'Фальц' }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      tariffRule: 'abc_black_white',
      rateKopecksPerKg: 500,
      basisLabel: 'АВС старая · 12 ч · фальц · выработка 800.000 кг',
    });
  });

  it('keeps the legacy film-type spelling calculable but emits the Falz label', () => {
    expect(
      resolvePayrollRollRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        roll({ postName: 'АВС старая', filmType: 'Чёрно-белая' }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      tariffRule: 'abc_black_white',
      rateKopecksPerKg: 500,
      basisLabel: 'АВС старая · 12 ч · фальц · выработка 800.000 кг',
    });
  });

  it('preserves the Alabuga override', () => {
    expect(
      resolvePayrollRollRate(
        LEGACY_PAYROLL_TARIFF_MATRIX_V1,
        roll({
          postName: 'АВС новая',
          filmType: null,
          counterpartyLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        }),
      ),
    ).toMatchObject({
      kind: 'resolved',
      tariffRule: 'alabuga_override',
      rateKopecksPerKg: 400,
      specialCustomer: true,
    });
  });

  it('fails closed instead of inventing a rate for PND new', () => {
    expect(
      resolvePayrollShiftRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, shift({ postName: 'Пнд новая' })),
    ).toEqual({
      kind: 'unresolved',
      reasons: ['machine_family_unresolved'],
      machineFamily: null,
      shiftDuration: '12h',
    });
  });
});
