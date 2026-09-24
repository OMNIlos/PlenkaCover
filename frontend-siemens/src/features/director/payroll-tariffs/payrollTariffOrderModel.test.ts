import { describe, expect, it } from 'vitest';

import type {
  ServerPayrollTariffMatrix,
  ServerPayrollTariffOrderReview,
  ServerPayrollTariffOrderView,
} from '../../../api/payrollTariffOrders';
import {
  acceptPayrollTariffOrderReview,
  addPayrollTariffClosedBand,
  createPayrollTariffOrderCopy,
  editPayrollTariffBand,
  editPayrollTariffOrderIdentity,
  setPayrollTariffOrderSpecialRule,
} from './payrollTariffOrderModel';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

function matrix(): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        { maxInclusiveGrams: 750_000, primaryRateKopecksPerKg: 400, secondaryRateKopecksPerKg: 500 },
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
      ],
      urp24h: [
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
      ],
      abc12h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
      ],
      abc24h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
      ],
    },
    specialRules: {
      thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function published(): ServerPayrollTariffOrderView {
  return {
    id: ORDER_ID,
    name: 'Приказ № 8-09/25',
    effectiveFrom: '2025-09-29',
    currency: 'RUB',
    status: 'published',
    revision: 1,
    createdAt: '2025-09-29T00:00:00.000Z',
    updatedAt: '2025-09-29T00:00:00.000Z',
    publishedAt: '2025-09-29T00:00:00.000Z',
    matrix: matrix(),
    createdById: null,
    updatedById: null,
    publishedById: null,
  };
}

describe('payroll tariff order editor model', () => {
  it('creates a deep local copy without mutating the active published order', () => {
    const source = published();
    const copy = createPayrollTariffOrderCopy(source, '2026-08-14');
    const edited = editPayrollTariffBand(copy, 'urp12h', 0, 'primaryRateKopecksPerKg', 777);

    expect(copy.orderId).toBeNull();
    expect(copy.status).toBe('local');
    expect(copy.effectiveFrom).toBe('2026-08-14');
    expect(edited.matrix.ladders.urp12h[0]?.primaryRateKopecksPerKg).toBe(777);
    expect(copy.matrix.ladders.urp12h[0]?.primaryRateKopecksPerKg).toBe(400);
    expect(source.matrix.ladders.urp12h[0]?.primaryRateKopecksPerKg).toBe(400);
  });

  it('invalidates an accepted review after any identity, band or special-rule edit', () => {
    const review: ServerPayrollTariffOrderReview = {
      orderId: ORDER_ID,
      revision: 2,
      matrixHash: 'a'.repeat(64),
      minimumPublishEffectiveFrom: '2026-08-14',
      publishable: true,
      fieldErrors: [],
    };
    const draft = {
      ...createPayrollTariffOrderCopy(published(), '2026-08-14'),
      orderId: ORDER_ID,
      status: 'draft' as const,
      revision: 2,
    };
    const reviewed = acceptPayrollTariffOrderReview(draft, review);

    expect(reviewed.review).toEqual(review);
    expect(editPayrollTariffOrderIdentity(reviewed, 'name', 'Новая редакция').review).toBeNull();
    expect(
      editPayrollTariffBand(reviewed, 'urp12h', 0, 'secondaryRateKopecksPerKg', 701).review,
    ).toBeNull();
    expect(setPayrollTariffOrderSpecialRule(reviewed, 'thinRoll', 'enabled', false).review).toBeNull();
    expect(reviewed.review).toEqual(review);
  });

  it('adds closed ranges without mixing URP and ABC tariff shapes', () => {
    const copy = createPayrollTariffOrderCopy(published(), '2026-08-14');
    const withUrpBand = addPayrollTariffClosedBand(copy, 'urp24h');
    const withAbcBand = addPayrollTariffClosedBand(withUrpBand, 'abc12h');

    expect(withAbcBand.matrix.ladders.urp24h).toEqual([
      {
        maxInclusiveGrams: 1_000,
        primaryRateKopecksPerKg: 550,
        secondaryRateKopecksPerKg: 650,
      },
      {
        maxInclusiveGrams: null,
        primaryRateKopecksPerKg: 550,
        secondaryRateKopecksPerKg: 650,
      },
    ]);
    expect(withAbcBand.matrix.ladders.abc12h).toEqual([
      {
        maxInclusiveGrams: 1_000,
        standardRateKopecksPerKg: 500,
        blackWhiteRateKopecksPerKg: 550,
      },
      {
        maxInclusiveGrams: null,
        standardRateKopecksPerKg: 500,
        blackWhiteRateKopecksPerKg: 550,
      },
    ]);
  });
});
