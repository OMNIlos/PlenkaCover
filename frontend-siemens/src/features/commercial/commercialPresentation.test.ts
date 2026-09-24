import { describe, expect, it } from 'vitest';
import {
  commercialActionPresentation,
  commercialIndicatorPresentation,
  formatCommercialDateTime,
  formatCommercialQueueTime,
  formatCommercialQuantity,
} from './commercialPresentation';

describe('commercial presentation vocabulary', () => {
  it('keeps independent indicator meaning and semantic tone', () => {
    expect(commercialIndicatorPresentation('production', 'defect')).toEqual({
      label: 'Проблема',
      tone: 'critical',
    });
    expect(commercialIndicatorPresentation('warehouseCover', 'full_confirmed')).toEqual({
      label: 'Полное покрытие',
      tone: 'success',
    });
    expect(commercialIndicatorPresentation('payment', 'partial')).toEqual({
      label: 'Частично оплачено',
      tone: 'warning',
    });
  });

  it('distinguishes an owned action from an external wait', () => {
    expect(
      commercialActionPresentation({
        code: 'request_cover',
        ownerRole: 'commercial',
        label: 'Запросить проверку склада',
        allowed: true,
      }),
    ).toEqual({ mode: 'action', owner: 'Коммерция', label: 'Запросить проверку склада' });
    expect(
      commercialActionPresentation({
        code: 'wait_invoice',
        ownerRole: 'finance',
        label: 'Ожидать бухгалтерию',
        allowed: false,
      }),
    ).toEqual({ mode: 'waiting', owner: 'Бухгалтерия', label: 'Ожидать бухгалтерию' });
    expect(
      commercialActionPresentation({
        code: 'request_cover',
        ownerRole: 'commercial',
        label: 'Запросить проверку склада',
        allowed: false,
      }),
    ).toEqual({ mode: 'disabled', owner: 'Коммерция', label: 'Запросить проверку склада' });
  });

  it('presents production handoff as a manual commercial action after the backend gate', () => {
    expect(
      commercialActionPresentation({
        code: 'send_to_production',
        ownerRole: 'commercial',
        label: 'Передать остаток в производство',
        allowed: true,
      }),
    ).toEqual({
      mode: 'action',
      owner: 'Коммерция',
      label: 'Передать остаток в производство',
    });
    expect(
      commercialActionPresentation({
        code: 'wait_payment_terms',
        ownerRole: 'finance',
        label: 'Ожидать решение бухгалтерии',
        allowed: false,
      }),
    ).toEqual({
      mode: 'waiting',
      owner: 'Бухгалтерия',
      label: 'Ожидать решение бухгалтерии',
    });
  });

  it.each(['wait_send_to_production', 'wait_correct_order_spec'] as const)(
    'presents %s as waiting even when commercial remains the workflow owner',
    (code) => {
      expect(
        commercialActionPresentation({
          code,
          ownerRole: 'commercial',
          label: 'Ожидать следующий этап',
          allowed: false,
        }),
      ).toEqual({
        mode: 'waiting',
        owner: 'Коммерция',
        label: 'Ожидать следующий этап',
      });
    },
  );

  it('formats safe dates and quantities without turning missing facts into zero', () => {
    expect(formatCommercialDateTime('2026-07-14T10:00:00.000Z', 'ru-RU', 'UTC')).toBe(
      '14.07.2026, 10:00',
    );
    expect(
      formatCommercialQueueTime('2026-07-14T10:00:00.000Z', '2026-07-14T12:00:00.000Z'),
    ).toBe('2 ч назад');
    expect(formatCommercialQuantity(null, 'кг', 'Нет подтверждённого факта')).toBe(
      'Нет подтверждённого факта',
    );
    expect(formatCommercialQuantity(25, null, 'Недоступно')).toBe('Недоступно');
  });
});
