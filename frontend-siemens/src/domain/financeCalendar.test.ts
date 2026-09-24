import { describe, expect, it } from 'vitest';
import { financeWorkObjects } from './fixtures/finance';
import {
  countActionableFinanceOrders,
  getFinanceCalendarEvents,
  getFinancePaymentConditions,
  type FinanceCalendarEvent,
} from './selectors';
import type { WorkObject } from './types';

function scheduledObject(id: string, amountLabel: string): WorkObject {
  return {
    ...financeWorkObjects[0],
    id,
    title: `Финансы ${id}`,
    paymentSchedules: [
      {
        id: `${id}-schedule`,
        dueDateIso: '2026-08-15',
        dueDateLabel: '15.08.2026',
        amountLabel,
        status: 'scheduled',
        source: 'manual_platform',
      },
    ],
  };
}

describe('finance calendar projection', () => {
  it('emits every installment row instead of only the next order action', () => {
    const first = scheduledObject('finance-1', '600 ₽');
    first.paymentSchedules = [
      ...first.paymentSchedules!,
      {
        id: 'finance-1-schedule-2',
        dueDateIso: '2026-09-15',
        dueDateLabel: '15.09.2026',
        amountLabel: '600 ₽',
        status: 'scheduled',
      },
    ];

    const events = getFinanceCalendarEvents([first], new Date('2026-08-01T09:00:00.000Z'));

    expect(events.map((event) => event.dateIso)).toEqual(['2026-08-15', '2026-09-15']);
    expect(events.every((event) => event.kind === 'installment')).toBe(true);
  });

  it('counts unique orders when several orders pay on the same day', () => {
    const events = getFinanceCalendarEvents([
      scheduledObject('finance-1', '600 ₽'),
      scheduledObject('finance-2', '900 ₽'),
    ]);

    expect(countActionableFinanceOrders(events)).toBe(2);
    expect(
      countActionableFinanceOrders([
        ...events,
        { ...events[0], id: 'duplicate-event' } as FinanceCalendarEvent,
      ]),
    ).toBe(2);
  });

  it('does not count paid schedule rows in the day badge', () => {
    const paid = scheduledObject('finance-paid', '600 ₽');
    paid.paymentSchedules![0].status = 'paid';

    expect(countActionableFinanceOrders(getFinanceCalendarEvents([paid]))).toBe(0);
  });

  it('keeps a pre-shipment stage out of calendar days and exposes its condition separately', () => {
    const order = scheduledObject('finance-condition', '600 ₽');
    order.paymentSchedules = [
      {
        id: 'future',
        trigger: 'full_shipment',
        offsetDays: 30,
        dueDateLabel: 'через 30 дней после полной отгрузки',
        amountLabel: '600 ₽',
        status: 'scheduled',
        dateKind: 'condition',
        percentageBasisPoints: 5000,
      },
    ];

    expect(getFinanceCalendarEvents([order])).toEqual([]);
    expect(getFinancePaymentConditions([order])).toEqual([
      expect.objectContaining({
        objectId: 'finance-condition',
        conditionLabel: 'через 30 дней после полной отгрузки',
        dateKind: 'condition',
        amountLabel: '600 ₽',
        percentageLabel: '50,00%',
      }),
    ]);
  });

  it('uses only the persisted server due date for an actual calendar event', () => {
    const order = scheduledObject('finance-actual', '600 ₽');
    order.paymentSchedules = [
      {
        id: 'actual-after-shipment',
        dueDateIso: '2026-08-23',
        dueDateLabel: '23.08.2026',
        amountLabel: '600 ₽',
        status: 'scheduled',
        dateKind: 'actual',
        percentageBasisPoints: 5000,
      },
    ];

    expect(getFinanceCalendarEvents([order])[0]).toMatchObject({
      dateIso: '2026-08-23',
      monthKey: '2026-08',
      dateKind: 'actual',
      percentageLabel: '50,00%',
    });
  });

  it.each([
    ['2026-07-31', 'scheduled', 'overdue'],
    ['2026-08-01', 'scheduled', 'due_today'],
    ['2026-08-15', 'due_today', 'installment'],
  ] as const)(
    'classifies actual due date %s as %s-relative kind %s instead of trusting schedule status',
    (dueDateIso, status, expectedKind) => {
      const order = scheduledObject(`finance-clock-${expectedKind}`, '600 ₽');
      order.paymentSchedules = [
        {
          ...order.paymentSchedules![0],
          dueDateIso,
          dueDateLabel: dueDateIso,
          status,
        },
      ];

      expect(getFinanceCalendarEvents([order], new Date('2026-07-31T21:00:00.000Z'))[0].kind).toBe(
        expectedKind,
      );
    },
  );

  it('keeps every conditional row without assigning any of them to a day', () => {
    const first = scheduledObject('finance-condition-1', '600 ₽');
    const second = scheduledObject('finance-condition-2', '900 ₽');
    for (const order of [first, second]) {
      order.paymentSchedules![0] = {
        ...order.paymentSchedules![0],
        dueDateIso: undefined,
        trigger: 'full_shipment',
        offsetDays: 15,
        dueDateLabel: 'через 15 дней после полной отгрузки',
        dateKind: 'condition',
      };
    }

    const events = getFinanceCalendarEvents([first, second]);
    const conditions = getFinancePaymentConditions([first, second]);

    expect(events).toEqual([]);
    expect(conditions.map((condition) => condition.amountLabel)).toEqual(['600 ₽', '900 ₽']);
  });

  it('uses the canonical stage sequence after separating dated and conditional rows', () => {
    const order = scheduledObject('finance-sequence', '600 ₽');
    order.paymentSchedules = [
      {
        id: 'z-condition',
        sequence: 2,
        trigger: 'full_shipment',
        offsetDays: 30,
        dueDateLabel: 'через 30 дней после полной отгрузки',
        amountLabel: '200 ₽',
        status: 'scheduled',
        dateKind: 'condition',
      },
      {
        id: 'actual',
        sequence: 3,
        dueDateIso: '2026-09-15',
        dueDateLabel: '15.09.2026',
        amountLabel: '300 ₽',
        status: 'scheduled',
        dateKind: 'actual',
      },
      {
        id: 'a-condition',
        sequence: 1,
        trigger: 'full_shipment',
        offsetDays: 15,
        dueDateLabel: 'через 15 дней после полной отгрузки',
        amountLabel: '100 ₽',
        status: 'scheduled',
        dateKind: 'condition',
      },
    ];

    expect(getFinanceCalendarEvents([order])[0].title).toContain('Платеж 3');
    expect(getFinancePaymentConditions([order]).map((condition) => condition.title)).toEqual([
      expect.stringContaining('Платеж 1'),
      expect.stringContaining('Платеж 2'),
    ]);
  });

  it('does not turn an unavailable canonical stage into a calendar event', () => {
    const order = scheduledObject('finance-undated', '700 ₽');
    order.paymentSchedules = [
      {
        id: 'undated',
        dueDateLabel: 'дата не задана',
        amountLabel: '700 ₽',
        status: 'scheduled',
        dateKind: 'unavailable',
        percentageBasisPoints: 2500,
      },
    ];

    expect(getFinanceCalendarEvents([order])).toEqual([]);
    expect(getFinancePaymentConditions([order])).toEqual([]);
  });
});
