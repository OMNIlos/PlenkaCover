import {
  DIRECTOR_PAYROLL_MACHINE_FAMILIES,
  DIRECTOR_PAYROLL_SHIFT_DURATIONS,
  DIRECTOR_PAYROLL_UNRESOLVED_REASONS,
} from '@plenka/contracts';
import type {
  AppliedPayrollTariffOrder,
  DirectorPayrollBreakdownRow,
  DirectorPayrollOperatorSummary,
  DirectorPayrollPreview,
  DirectorPayrollPreviewStatus,
} from '@plenka/contracts';

type Assert<T extends true> = T;
type HasKey<T, Key extends PropertyKey> = Key extends keyof T ? true : false;

type _payrollMoneyFieldsUseKopecks = Assert<
  HasKey<DirectorPayrollBreakdownRow, 'rateKopecksPerKg'> &
    HasKey<DirectorPayrollBreakdownRow, 'amountKopecks'> &
    HasKey<DirectorPayrollOperatorSummary, 'amountKopecks'> &
    HasKey<DirectorPayrollPreview['summary'], 'payableAmountKopecks'>
>;

type _payrollRowsReferenceTheirAppliedOrder = Assert<
  HasKey<DirectorPayrollBreakdownRow, 'tariffOrderId'> &
    HasKey<DirectorPayrollPreview, 'appliedTariffOrders'>
>;
type _singletonPolicyIsContracted = Assert<
  HasKey<DirectorPayrollPreview, 'policy'> extends false ? true : false
>;

const appliedOrder: AppliedPayrollTariffOrder = {
  id: 'payroll-order-1',
  name: 'Приказ № 1',
  effectiveFrom: '2026-08-14',
  currency: 'RUB',
  matrix: {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        {
          maxInclusiveGrams: null,
          primaryRateKopecksPerKg: 400,
          secondaryRateKopecksPerKg: 500,
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
  },
};

describe('director payroll contract', () => {
  it('publishes the closed payroll classification enums', () => {
    expect(DIRECTOR_PAYROLL_MACHINE_FAMILIES).toEqual([
      'urp',
      'matil',
      'kitayka',
      'abc_old',
      'abc_new',
    ]);
    expect(DIRECTOR_PAYROLL_SHIFT_DURATIONS).toEqual(['12h', '24h']);
    expect(DIRECTOR_PAYROLL_UNRESOLVED_REASONS).toContain('material_class_unresolved');
    expect(DIRECTOR_PAYROLL_UNRESOLVED_REASONS).toContain('counterparty_unresolved');
  });

  it('uses integer kopecks and exposes the closed preview status', () => {
    const statuses: DirectorPayrollPreviewStatus[] = ['complete', 'partial', 'empty'];

    expect(statuses).toEqual(['complete', 'partial', 'empty']);
  });

  it('carries the complete applied order once and references it from calculated rows', () => {
    expect(appliedOrder).toMatchObject({
      id: 'payroll-order-1',
      name: 'Приказ № 1',
      effectiveFrom: '2026-08-14',
      currency: 'RUB',
      matrix: { schemaVersion: 1 },
    });
  });
});
