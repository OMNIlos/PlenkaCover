import {
  CAPABILITIES,
  DOMAIN_EVENTS,
  PAYROLL_TARIFF_LADDER_KEYS,
  PAYROLL_TARIFF_ORDER_COMMAND_ACTIONS,
  PAYROLL_TARIFF_ORDER_ERROR_CODES,
  PAYROLL_TARIFF_ORDER_STATUSES,
  ROLE_CAPABILITIES,
  ROLES,
  type DirectorAnalyticsShiftBalance,
  type DirectorRollCostPayrollSource,
  type OperatorPayrollPreview,
  type PayrollTariffMatrixV1,
  type PayrollTariffOrderReview,
} from '@plenka/contracts';

type Assert<T extends true> = T;
type HasKey<T, Key extends PropertyKey> = Key extends keyof T ? true : false;

type _operatorUsesSafeOrderReferences = Assert<
  HasKey<OperatorPayrollPreview, 'appliedTariffOrders'>
>;
type _controlReceivesBackendPayroll = Assert<HasKey<DirectorAnalyticsShiftBalance, 'payroll'>>;
type _productionCostReferencesOrder = Assert<
  HasKey<DirectorRollCostPayrollSource, 'tariffOrderId'> &
    HasKey<DirectorRollCostPayrollSource, 'tariffOrderName'>
>;
type _reviewCarriesPublishGate = Assert<
  HasKey<PayrollTariffOrderReview, 'matrixHash'> &
    HasKey<PayrollTariffOrderReview, 'minimumPublishEffectiveFrom'> &
    HasKey<PayrollTariffOrderReview, 'publishable'>
>;

const matrix = {
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
        maxInclusiveGrams: null,
        standardRateKopecksPerKg: 450,
        blackWhiteRateKopecksPerKg: 500,
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
} satisfies PayrollTariffMatrixV1;

describe('payroll tariff order shared contract', () => {
  it('publishes a closed version-one matrix shape in integer grams and kopecks', () => {
    expect(PAYROLL_TARIFF_LADDER_KEYS).toEqual([
      'urp12h',
      'urp24h',
      'abc12h',
      'abc24h',
    ]);
    expect(Object.keys(matrix).sort()).toEqual(['ladders', 'schemaVersion', 'specialRules']);
    expect(Object.keys(matrix.ladders)).toEqual(PAYROLL_TARIFF_LADDER_KEYS);
    expect(Object.keys(matrix.specialRules).sort()).toEqual(['alabuga', 'thinRoll']);
    expect(matrix.ladders.urp12h[0]).toEqual({
      maxInclusiveGrams: 750_000,
      primaryRateKopecksPerKg: 400,
      secondaryRateKopecksPerKg: 500,
    });
  });

  it('locks lifecycle, command and safe error vocabularies', () => {
    expect(PAYROLL_TARIFF_ORDER_STATUSES).toEqual(['draft', 'published']);
    expect(PAYROLL_TARIFF_ORDER_COMMAND_ACTIONS).toEqual(['create', 'update', 'publish']);
    expect(PAYROLL_TARIFF_ORDER_ERROR_CODES).toEqual([
      'PAYROLL_TARIFF_ORDER_NOT_FOUND',
      'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
      'PAYROLL_TARIFF_ORDER_PUBLISHED_IMMUTABLE',
      'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_PAST_OR_TODAY',
      'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_NOT_AFTER_LATEST',
      'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_DUPLICATE',
      'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
      'PAYROLL_TARIFF_ORDER_ALREADY_PUBLISHED',
      'PAYROLL_TARIFF_ORDER_CORRUPT',
    ]);
  });

  it('assigns tariff management only to the director base role', () => {
    expect(CAPABILITIES).toContain('payroll_tariff:manage');
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role].includes('payroll_tariff:manage')).toBe(role === 'director');
    }
  });

  it('publishes one append-only audit fact for every tariff mutation kind', () => {
    expect(
      DOMAIN_EVENTS.filter((event) => event.startsWith('audit:payroll_tariff_order_')),
    ).toEqual([
      'audit:payroll_tariff_order_created',
      'audit:payroll_tariff_order_draft_updated',
      'audit:payroll_tariff_order_published',
    ]);
  });
});
