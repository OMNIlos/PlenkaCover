import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { prepay50Template } from '../../domain/financePaymentPolicy';
import {
  FinancePaymentPolicyEditor,
  insertPaymentStage,
  updatePolicyInstallmentDays,
} from './FinancePaymentPolicyEditor';

describe('FinancePaymentPolicyEditor', () => {
  it('renders editable stages with actual dates and shipment conditions', () => {
    const markup = renderToStaticMarkup(
      <FinancePaymentPolicyEditor
        value={prepay50Template(30)}
        preview={{
          rows: [
            {
              sequence: 1,
              trigger: 'invoice_issued',
              percentageBasisPoints: 5000,
              offsetDays: 0,
              amount: 500,
              date: '2026-07-20',
              dateKind: 'actual',
            },
            {
              sequence: 2,
              trigger: 'full_shipment',
              percentageBasisPoints: 5000,
              offsetDays: 30,
              amount: 500,
              date: null,
              dateKind: 'condition',
            },
          ],
        }}
        error={null}
        onChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Срок рассрочки');
    expect(markup).toContain('Добавить этап');
    expect(markup).toContain('50,00%');
    expect(markup).toContain('через 30 дней после полной отгрузки');
    expect(markup).toContain('Сразу после выставления счёта');
    expect(markup).toContain('100% сразу');
    expect(markup).toContain('50/50');
    expect(markup).toContain('100% через 30 дней');
  });

  it('inserts a zero-share stage before the final row without mutating the draft', () => {
    const original = prepay50Template(30);
    const updated = insertPaymentStage(original);

    expect(original.stages).toHaveLength(2);
    expect(updated.stages).toHaveLength(3);
    expect(updated.stages.map((stage) => stage.sequence)).toEqual([1, 2, 3]);
    expect(updated.stages[1]).toMatchObject({
      trigger: 'full_shipment',
      percentageBasisPoints: 0,
      offsetDays: 15,
    });
    expect(updated.stages[2].offsetDays).toBe(30);
  });

  it('moves the final deferred stage when the installment term changes', () => {
    const updated = updatePolicyInstallmentDays(prepay50Template(30), 45);

    expect(updated.installmentDays).toBe(45);
    expect(updated.stages[1].offsetDays).toBe(45);
  });
});
