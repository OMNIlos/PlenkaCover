import { describe, expect, it } from 'vitest';

import { financeDisplayContractFromObject } from './displayContracts';
import { workObjects } from './demoData';
import { financeWorkObjects } from './fixtures/finance';
import {
  getFinanceCalendarEvents,
  getFinanceCommandCounters,
  getFinanceCommandItems,
  getListItems,
} from './selectors';
import type { WorkObject } from './types';

const augustBusinessDay = new Date('2026-07-31T21:00:00.000Z');

function livePaymentObject(
  id: string,
  paymentLabel: string,
  paymentSchedules: NonNullable<WorkObject['paymentSchedules']>,
): WorkObject {
  return {
    ...financeWorkObjects[0],
    id,
    title: `Финансы ${id}`,
    statusLabel: paymentLabel,
    severity: 'info',
    filterTags: [],
    facts: [
      { label: 'Номер', value: id },
      { label: 'Заказчик', value: 'Тест' },
      { label: 'Статус счета', value: 'Счет отправлен' },
      { label: 'Статус оплаты', value: paymentLabel },
      { label: 'Источник данных', value: 'Данные актуальны' },
    ],
    sections: [],
    problems: [],
    paymentSchedule: undefined,
    paymentSchedules,
  };
}

function liveScheduledObject(id: string, dueDateIso: string): WorkObject {
  return livePaymentObject(id, 'Ожидает оплаты', [
    {
      id: `${id}-schedule`,
      dueDateIso,
      dueDateLabel: dueDateIso,
      amountLabel: '100 000 ₽',
      status: 'scheduled',
      source: 'manual_platform',
    },
  ]);
}

function openConditionSchedule(id: string, offsetDays = 30) {
  return {
    id,
    trigger: 'full_shipment' as const,
    offsetDays,
    dueDateLabel: `через ${offsetDays} дней после полной отгрузки`,
    amountLabel: '50 000 ₽',
    status: 'scheduled' as const,
    dateKind: 'condition' as const,
    source: 'manual_platform',
  };
}

describe('finance display business clock', () => {
  it('keeps an order nonterminal while a conditional payment remains open', () => {
    const object = livePaymentObject('finance-stale-paid-condition', 'Оплачено', [
      {
        id: 'paid-prepayment',
        dueDateIso: '2026-07-01',
        dueDateLabel: '2026-07-01',
        amountLabel: '50 000 ₽',
        status: 'paid',
        source: 'manual_platform',
      },
      openConditionSchedule('open-postpayment'),
    ]);

    expect(financeDisplayContractFromObject(object, augustBusinessDay)).toMatchObject({
      paymentStatus: 'installment_running',
      paymentLabel: 'Рассрочка',
      dueDateIso: undefined,
      dueDateLabel: 'через 30 дней после полной отгрузки',
    });
  });

  it.each(['Просрочка оплаты', 'День плановой оплаты'] as const)(
    'does not inherit stale date-relative status "%s" for a conditional payment',
    (stalePaymentLabel) => {
      const object = livePaymentObject(`finance-stale-${stalePaymentLabel}`, stalePaymentLabel, [
        openConditionSchedule('open-condition'),
      ]);

      expect(financeDisplayContractFromObject(object, augustBusinessDay)).toMatchObject({
        paymentStatus: 'installment_running',
        paymentLabel: 'Рассрочка',
        dueDateIso: undefined,
        dueDateLabel: 'через 30 дней после полной отгрузки',
      });
    },
  );

  it('keeps an undated open payment nonterminal instead of inheriting paid', () => {
    const object = livePaymentObject('finance-stale-paid-undated', 'Оплачено', [
      {
        id: 'open-undated',
        dueDateLabel: 'дата не задана',
        amountLabel: '100 000 ₽',
        status: 'scheduled',
        dateKind: 'unavailable',
        source: 'manual_platform',
      },
    ]);

    expect(financeDisplayContractFromObject(object, augustBusinessDay)).toMatchObject({
      paymentStatus: 'installment_running',
      paymentLabel: 'Рассрочка',
      dueDateIso: undefined,
      dueDateLabel: 'дата не задана',
    });
  });

  it('projects a due-today fallback onto the injected Moscow business day', () => {
    expect(
      financeDisplayContractFromObject(financeWorkObjects[0], augustBusinessDay),
    ).toMatchObject({
      dueDateIso: '2026-08-01',
      dueDateLabel: 'сегодня',
    });
  });

  it('places a due-today finance event on the same injected calendar day', () => {
    expect(getFinanceCalendarEvents([financeWorkObjects[0]], augustBusinessDay)[0]).toMatchObject({
      dateIso: '2026-08-01',
      monthKey: '2026-08',
      day: 1,
    });
  });

  it('uses the live schedule for due-today counters and due-date sorting', () => {
    const dueToday = liveScheduledObject('z-due-today', '2026-08-01');
    const future = liveScheduledObject('a-future', '2026-08-15');

    expect(financeDisplayContractFromObject(dueToday, augustBusinessDay)).toMatchObject({
      paymentStatus: 'payment_due_today',
      dueDateIso: '2026-08-01',
      dueDateLabel: 'сегодня',
    });
    expect(
      getFinanceCommandCounters([dueToday, future], augustBusinessDay).find(
        (counter) => counter.id === 'due-today',
      )?.value,
    ).toBe(1);
    expect(
      getFinanceCommandItems([future, dueToday], 'exceptionFirst', augustBusinessDay).map(
        (item) => item.id,
      ),
    ).toEqual(['z-due-today', 'a-future']);
  });

  it('uses the same injected clock while filtering finance sections', () => {
    const dueOnInjectedDay = liveScheduledObject('finance-injected-section-clock', '2026-01-01');

    expect(
      getListItems(
        'finance',
        'Все',
        'Рассрочка',
        { ...workObjects, finance: [dueOnInjectedDay] },
        new Date('2025-12-31T21:00:00.000Z'),
      ).map((item) => item.id),
    ).toEqual(['finance-injected-section-clock']);
  });
});
