import { describe, expect, it } from 'vitest';

import { visibleBusinessCodeLabel } from './displayContracts';

describe('role-safe business event presentation', () => {
  it.each([
    ['received', 'Принят складом'],
    ['receiving scan', 'Приёмка по QR'],
    ['production_handover', 'Передан из производства'],
    ['audit:warehouse_pallet_roll_selected', 'Рулон добавлен в палетный лист'],
    ['audit:warehouse pallet roll deselected', 'Рулон исключён из палетного листа'],
    ['manual_deselection', 'Исключён вручную'],
  ])('maps bounded backend code %s', (code, label) => {
    expect(visibleBusinessCodeLabel(code)).toBe(label);
  });

  it('fails closed for an unknown technical enum but preserves authored business copy', () => {
    expect(visibleBusinessCodeLabel('new_internal_backend_code')).toBe('Неизвестное событие');
    expect(visibleBusinessCodeLabel('Рулон принят после проверки')).toBe(
      'Рулон принят после проверки',
    );
  });
});
