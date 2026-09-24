import type { PayrollTariffMatrixV1, PayrollTariffOrderReference } from '@plenka/contracts';

function deepFreeze<T>(value: T): T {
  Object.freeze(value);

  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }

  return value;
}

/** Exact matrix published by order № 8-09/25, effective 2025-09-29 Moscow time. */
export const LEGACY_PAYROLL_TARIFF_MATRIX_V1 = deepFreeze<PayrollTariffMatrixV1>({
  schemaVersion: 1,
  ladders: {
    urp12h: [
      {
        maxInclusiveGrams: 750_000,
        primaryRateKopecksPerKg: 400,
        secondaryRateKopecksPerKg: 500,
      },
      {
        maxInclusiveGrams: 1_000_000,
        primaryRateKopecksPerKg: 450,
        secondaryRateKopecksPerKg: 550,
      },
      {
        maxInclusiveGrams: 1_250_000,
        primaryRateKopecksPerKg: 500,
        secondaryRateKopecksPerKg: 600,
      },
      {
        maxInclusiveGrams: null,
        primaryRateKopecksPerKg: 550,
        secondaryRateKopecksPerKg: 650,
      },
    ],
    urp24h: [
      {
        maxInclusiveGrams: 1_500_000,
        primaryRateKopecksPerKg: 400,
        secondaryRateKopecksPerKg: 500,
      },
      {
        maxInclusiveGrams: 2_000_000,
        primaryRateKopecksPerKg: 450,
        secondaryRateKopecksPerKg: 550,
      },
      {
        maxInclusiveGrams: 2_500_000,
        primaryRateKopecksPerKg: 500,
        secondaryRateKopecksPerKg: 600,
      },
      {
        maxInclusiveGrams: null,
        primaryRateKopecksPerKg: 550,
        secondaryRateKopecksPerKg: 650,
      },
    ],
    abc12h: [
      {
        maxInclusiveGrams: 1_300_000,
        standardRateKopecksPerKg: 450,
        blackWhiteRateKopecksPerKg: 500,
      },
      {
        maxInclusiveGrams: null,
        standardRateKopecksPerKg: 500,
        blackWhiteRateKopecksPerKg: 550,
      },
    ],
    abc24h: [
      {
        maxInclusiveGrams: 2_600_000,
        standardRateKopecksPerKg: 450,
        blackWhiteRateKopecksPerKg: 500,
      },
      {
        maxInclusiveGrams: null,
        standardRateKopecksPerKg: 500,
        blackWhiteRateKopecksPerKg: 550,
      },
    ],
  },
  specialRules: {
    thinRoll: {
      enabled: true,
      maxExclusiveGrams: 7_000,
      rateKopecksPerKg: 650,
    },
    alabuga: {
      enabled: true,
      machineFamily: 'abc_new',
      normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
      rateKopecksPerKg: 400,
    },
  },
});

export const LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE = Object.freeze<PayrollTariffOrderReference>({
  id: 'payroll-tariff-order-8-09-25-2025-09-29',
  name: 'Приказ № 8-09/25',
  effectiveFrom: '2025-09-29',
  currency: 'RUB',
});
