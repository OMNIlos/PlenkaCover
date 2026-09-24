import { describe, expect, it } from 'vitest';
import { actionDisplayLabel, actionIcon, actionIntent } from './actionPresentation';

describe('finance schedule confirmation presentation', () => {
  const action = {
    id: 'finance-confirm-schedule:schedule-1',
    label: 'Проверить поступление',
    level: 'recommended' as const,
    enabled: true,
  };

  it('presents the targeted schedule action as a payment check', () => {
    expect(actionDisplayLabel(action)).toBe('Проверить оплату');
    expect(actionIcon(action)).toBe('check');
  });
});

describe('finance warehouse coverage presentation', () => {
  const actions = [
    {
      id: 'finance-warehouse-coverage:use_warehouse',
      label: 'Использовать рулоны со склада',
      level: 'recommended' as const,
      enabled: true,
    },
    {
      id: 'finance-warehouse-coverage:produce_all',
      label: 'Произвести весь заказ',
      level: 'recommended' as const,
      enabled: true,
    },
    {
      id: 'finance-warehouse-coverage:request_recheck',
      label: 'Отправить на перепроверку склада',
      level: 'recommended' as const,
      enabled: true,
    },
  ];

  it('keeps the three server decisions explicit and non-navigational', () => {
    expect(actions.map(actionDisplayLabel)).toEqual([
      'Использовать рулоны со склада',
      'Произвести весь заказ',
      'Отправить на перепроверку склада',
    ]);
    expect(actions.map(actionIntent)).toEqual(['advance', 'advance', 'advance']);
  });
});
