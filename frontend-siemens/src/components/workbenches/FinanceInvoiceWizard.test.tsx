import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFinanceInvoice, previewFinancePaymentPolicy } from '../../api/finance';
import { workObjects } from '../../domain/fixtures/workObjects';
import { prepay50Template } from '../../domain/financePaymentPolicy';
import { FinanceInvoiceWizard } from './FinanceInvoiceWizard';

vi.mock('../../api/finance', () => ({
  createFinanceInvoice: vi.fn(),
  previewFinancePaymentPolicy: vi.fn(),
}));

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('FinanceInvoiceWizard', () => {
  const action = {
    id: 'finance-create-invoice:finance-1',
    label: 'Открыть счет',
    level: 'recommended' as const,
    enabled: true,
  };

  beforeEach(() => {
    vi.mocked(createFinanceInvoice).mockReset();
    vi.mocked(previewFinancePaymentPolicy).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the arbitrary-stage calculator beside quick payment templates', () => {
    const markup = renderToStaticMarkup(
      <FinanceInvoiceWizard
        action={action}
        financeOrderId="finance-1"
        commercialFinanceNote="1200 за 20 рулонов"
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('Оформить счёт вручную');
    expect(markup).toContain('Сумма счёта, ₽');
    expect(markup).toContain('100% сразу');
    expect(markup).toContain('50/50');
    expect(markup).toContain('100% через 30 дней');
    expect(markup).toContain('Срок рассрочки');
    expect(markup).toContain('Этапы оплаты');
    expect(markup).toContain('Добавить этап');
    expect(markup).toContain('1200 за 20 рулонов');
    expect(markup).not.toContain('Обновить из 1С');
    expect(markup).not.toContain('Цена');
  });

  it('uses the invoice dialog layout that keeps submit actions visible', () => {
    const markup = renderToStaticMarkup(
      <FinanceInvoiceWizard
        action={action}
        financeOrderId="finance-1"
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'class="finance-installment-wizard finance-invoice-wizard"',
    );
  });

  it('previews and creates an invoice with a custom installment term', async () => {
    vi.useFakeTimers();
    vi.mocked(previewFinancePaymentPolicy).mockResolvedValue({
      rows: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 5000,
          offsetDays: 0,
          amount: 60000.25,
          date: null,
          dateKind: 'condition',
        },
        {
          sequence: 2,
          trigger: 'full_shipment',
          percentageBasisPoints: 5000,
          offsetDays: 45,
          amount: 60000.25,
          date: null,
          dateKind: 'condition',
        },
      ],
    });
    vi.mocked(createFinanceInvoice).mockResolvedValue(workObjects.finance[0]);
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const renderer = TestRenderer.create(
      <FinanceInvoiceWizard
        action={action}
        financeOrderId="finance-1"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({ placeholder: 'Например, 120000' })
        .props.onChange({ currentTarget: { value: '120000,50' } }),
    );
    act(() => {
      const split = renderer.root
        .findAllByType('button')
        .find((candidate) => nodeText(candidate) === '50/50');
      split?.props.onClick();
    });
    act(() => {
      renderer.root.findByProps({ max: '3650' }).props.onChange({ currentTarget: { value: '45' } });
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(previewFinancePaymentPolicy).toHaveBeenLastCalledWith('finance-1', {
      amount: 120000.5,
      paymentPolicy: prepay50Template(45),
    });
    await act(async () => {
      const submit = renderer.root
        .findAllByType('button')
        .find((candidate) => nodeText(candidate) === 'Оформить счёт');
      submit?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createFinanceInvoice).toHaveBeenCalledWith(
      'finance-1',
      expect.objectContaining({
        amount: 120000.5,
        paymentPolicy: prepay50Template(45),
      }),
    );
    expect(onCreated).toHaveBeenCalledWith(workObjects.finance[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
