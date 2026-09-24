import type { PayrollTariffMatrixV1 } from '@plenka/contracts';
import {
  PayrollTariffMatrixValidationError,
  parsePayrollTariffMatrix,
} from './payroll-tariff-matrix.parser';

function validMatrix(): PayrollTariffMatrixV1 {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        {
          maxInclusiveGrams: 750_000,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
        },
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 550,
          secondaryRateKopecksPerKg: 650,
        },
      ],
      urp24h: [
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
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
          maxInclusiveGrams: null,
          standardRateKopecksPerKg: 450,
          blackWhiteRateKopecksPerKg: 500,
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
  };
}

type InvalidCase = {
  name: string;
  mutate: (matrix: PayrollTariffMatrixV1) => void;
  path: string;
  code: string;
};

const invalidCases: InvalidCase[] = [
  {
    name: 'an unknown root key',
    mutate: (matrix) => {
      (matrix as unknown as Record<string, unknown>).formula = 'rate * kg';
    },
    path: 'formula',
    code: 'unknown_key',
  },
  {
    name: 'an unknown band key',
    mutate: (matrix) => {
      (matrix.ladders.urp12h[0] as unknown as Record<string, unknown>).rubles = 4;
    },
    path: 'ladders.urp12h[0].rubles',
    code: 'unknown_key',
  },
  {
    name: 'another schema version',
    mutate: (matrix) => {
      (matrix as { schemaVersion: number }).schemaVersion = 2;
    },
    path: 'schemaVersion',
    code: 'invalid_literal',
  },
  {
    name: 'a floating rate',
    mutate: (matrix) => {
      matrix.ladders.urp12h[0].primaryRateKopecksPerKg = 400.5;
    },
    path: 'ladders.urp12h[0].primaryRateKopecksPerKg',
    code: 'invalid_kopecks',
  },
  {
    name: 'a negative rate',
    mutate: (matrix) => {
      matrix.ladders.urp12h[0].secondaryRateKopecksPerKg = -1;
    },
    path: 'ladders.urp12h[0].secondaryRateKopecksPerKg',
    code: 'invalid_kopecks',
  },
  {
    name: 'an unsafe rate',
    mutate: (matrix) => {
      matrix.ladders.abc12h[0].standardRateKopecksPerKg = Number.MAX_SAFE_INTEGER + 1;
    },
    path: 'ladders.abc12h[0].standardRateKopecksPerKg',
    code: 'invalid_kopecks',
  },
  {
    name: 'a floating threshold',
    mutate: (matrix) => {
      matrix.ladders.urp12h[0].maxInclusiveGrams = 750_000.5;
    },
    path: 'ladders.urp12h[0].maxInclusiveGrams',
    code: 'invalid_threshold',
  },
  {
    name: 'a zero threshold',
    mutate: (matrix) => {
      matrix.ladders.urp12h[0].maxInclusiveGrams = 0;
    },
    path: 'ladders.urp12h[0].maxInclusiveGrams',
    code: 'invalid_threshold',
  },
  {
    name: 'non-increasing thresholds',
    mutate: (matrix) => {
      matrix.ladders.urp12h.splice(1, 0, {
        maxInclusiveGrams: 750_000,
        primaryRateKopecksPerKg: 450,
        secondaryRateKopecksPerKg: 550,
      });
    },
    path: 'ladders.urp12h[1].maxInclusiveGrams',
    code: 'threshold_not_increasing',
  },
  {
    name: 'an open band before the last row',
    mutate: (matrix) => {
      matrix.ladders.urp12h[0].maxInclusiveGrams = null;
    },
    path: 'ladders.urp12h[0].maxInclusiveGrams',
    code: 'open_band_not_last',
  },
  {
    name: 'no open band',
    mutate: (matrix) => {
      matrix.ladders.urp12h[1].maxInclusiveGrams = 1_000_000;
    },
    path: 'ladders.urp12h',
    code: 'open_band_required',
  },
  {
    name: 'a missing required rate',
    mutate: (matrix) => {
      delete (matrix.ladders.abc12h[0] as unknown as Record<string, unknown>)
        .blackWhiteRateKopecksPerKg;
    },
    path: 'ladders.abc12h[0].blackWhiteRateKopecksPerKg',
    code: 'invalid_kopecks',
  },
  {
    name: 'a wrong special-rule machine family',
    mutate: (matrix) => {
      (matrix.specialRules.alabuga as { machineFamily: string }).machineFamily = 'abc_old';
    },
    path: 'specialRules.alabuga.machineFamily',
    code: 'invalid_literal',
  },
  {
    name: 'a non-positive special-rule threshold',
    mutate: (matrix) => {
      matrix.specialRules.thinRoll.maxExclusiveGrams = 0;
    },
    path: 'specialRules.thinRoll.maxExclusiveGrams',
    code: 'invalid_threshold',
  },
];

describe('payroll tariff matrix parser', () => {
  it.each(invalidCases)('rejects $name with a field-safe issue', ({ mutate, path, code }) => {
    const source = validMatrix();
    mutate(source);

    try {
      parsePayrollTariffMatrix(source);
      throw new Error('Expected matrix parsing to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(PayrollTariffMatrixValidationError);
      if (!(error instanceof PayrollTariffMatrixValidationError)) return;
      expect(error.fieldErrors).toContainEqual({
        path,
        code,
        message: expect.any(String),
      });
    }
  });

  it('accepts explicit zero rates and returns a detached deeply frozen value', () => {
    const source = validMatrix();
    source.ladders.urp12h[0].primaryRateKopecksPerKg = 0;

    const parsed = parsePayrollTariffMatrix(source);
    source.ladders.urp12h[0].primaryRateKopecksPerKg = 999;

    expect(parsed.ladders.urp12h[0].primaryRateKopecksPerKg).toBe(0);
    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.ladders)).toBe(true);
    expect(Object.isFrozen(parsed.ladders.urp12h)).toBe(true);
    expect(Object.isFrozen(parsed.ladders.urp12h[0])).toBe(true);
  });
});
