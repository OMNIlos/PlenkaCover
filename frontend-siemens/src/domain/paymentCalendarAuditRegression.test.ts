import { describe, expect, it } from 'vitest';

import { financeWorkObjects } from './fixtures/finance';
import { getFinanceCalendarEvents, getFinancePaymentConditions } from './selectors';
import type { WorkObject } from './types';

describe('payment calendar production-audit regression', () => {
  it('keeps a pre-shipment condition outside every calendar day', () => {
    const conditionSchedule = {
      id: 'condition-stage',
      trigger: 'full_shipment',
      offsetDays: 30,
      dueDateLabel: 'через 30 дней после полной отгрузки',
      amountLabel: '600 ₽',
      status: 'scheduled',
      dateKind: 'condition',
      percentageBasisPoints: 5000,
    } as unknown as NonNullable<WorkObject['paymentSchedules']>[number];
    const order: WorkObject = {
      ...financeWorkObjects[0],
      id: 'finance-condition-audit',
      paymentSchedules: [conditionSchedule],
    };

    expect(getFinanceCalendarEvents([order])).toEqual([]);
    expect(getFinancePaymentConditions([order])).toContainEqual(
      expect.objectContaining({
        objectId: order.id,
        conditionLabel: 'через 30 дней после полной отгрузки',
        dateKind: 'condition',
        percentageLabel: '50,00%',
      }),
    );
  });
});
