import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { OperatorShiftClosingPayrollView } from '../../api/operator';
import { ShiftClosingPayrollSummary } from './ShiftClosingPayrollSummary';

const payroll: OperatorShiftClosingPayrollView = {
  sessionId: 'session-1',
  shiftId: 'shift-1',
  status: 'partial',
  appliedTariffOrders: [
    {
      id: 'payroll-tariff-order-8-09-25-2025-09-29',
      name: 'Приказ № 8-09/25',
      effectiveFrom: '2025-09-29',
      currency: 'RUB',
    },
  ],
  summary: {
    payableAmountKopecks: 3_100,
    payableKg: 10,
    machineShiftCount: 1,
    unresolvedKg: 2,
    unresolvedFactCount: 1,
    excludedDefectKg: 1,
    excludedDefectRollCount: 1,
  },
  breakdown: [
    {
      id: 'row-primary',
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      shiftDate: '2026-08-08',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'УРП 1',
      machineFamily: 'urp',
      shiftDuration: '12h',
      shiftOutputKg: 12,
      payableKg: 4,
      rateKopecksPerKg: 400,
      amountKopecks: 1_600,
      tariffRule: 'primary',
      basisLabel: 'Основное сырьё',
      materialClass: 'primary',
      filmClass: null,
      specialCustomer: false,
    },
    {
      id: 'row-thin',
      tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      shiftDate: '2026-08-08',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'УРП 1',
      machineFamily: 'urp',
      shiftDuration: '12h',
      shiftOutputKg: 12,
      payableKg: 6,
      rateKopecksPerKg: 250,
      amountKopecks: 1_500,
      tariffRule: 'thin_roll',
      basisLabel: 'Тонкий рулон',
      materialClass: null,
      filmClass: null,
      specialCustomer: false,
    },
  ],
  unresolved: [
    {
      rollId: 'roll-2',
      rollCode: 'ROLL-2',
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      producedAt: '2026-08-08T10:00:00.000Z',
      netKg: 2,
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'УРП 1',
      reasons: ['material_class_unresolved'],
    },
  ],
};

describe('ShiftClosingPayrollSummary', () => {
  it('renders every authoritative rate and the concrete unresolved reason', () => {
    const renderer = create(<ShiftClosingPayrollSummary payroll={payroll} />);
    const markup = JSON.stringify(renderer.toJSON());

    expect(markup).toContain('Итог смены');
    expect(markup).toContain('Оплачиваемый вес');
    expect(markup).toContain('10 кг');
    expect(markup).toContain('Основное сырьё');
    expect(markup).toContain('4,00 ₽/кг');
    expect(markup).toContain('Тонкий рулон');
    expect(markup).toContain('2,50 ₽/кг');
    expect(markup).toContain('Не рассчитано');
    expect(markup).toContain('Не определён тип сырья');
    expect(markup).toContain('Брак исключён');
    expect(markup).not.toContain('штраф');
  });

  it('does not invent a zero amount for an empty result', () => {
    const renderer = create(
      <ShiftClosingPayrollSummary
        payroll={{
          ...payroll,
          status: 'empty',
          summary: {
            ...payroll.summary,
            payableAmountKopecks: 0,
            payableKg: 0,
            machineShiftCount: 0,
            unresolvedKg: 0,
            unresolvedFactCount: 0,
          },
          breakdown: [],
          unresolved: [],
        }}
      />,
    );
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('Не рассчитано');
    expect(markup).toContain('Нет начисляемых фактов для расчёта');
    expect(markup).not.toContain('0,00 ₽');
  });

  it('does not present an unresolved-only partial result as a calculated zero', () => {
    const renderer = create(
      <ShiftClosingPayrollSummary
        payroll={{
          ...payroll,
          summary: {
            ...payroll.summary,
            payableAmountKopecks: 0,
            payableKg: 0,
            machineShiftCount: 0,
          },
          breakdown: [],
        }}
      />,
    );
    const markup = JSON.stringify(renderer.toJSON());
    expect(markup).toContain('Не рассчитано');
    expect(markup).toContain('Не определён тип сырья');
    expect(markup).not.toContain('Рассчитано частично');
    expect(markup).not.toContain('Оплачиваемый вес');
    expect(markup).not.toContain('0,00 ₽');
  });

  it('dismisses only from the explicit button', () => {
    const onDismiss = vi.fn();
    const renderer = create(<ShiftClosingPayrollSummary payroll={payroll} onDismiss={onDismiss} />);
    const button = renderer.root.findByProps({ 'aria-label': 'Закрыть итог смены' });
    act(() => button.props.onClick());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
