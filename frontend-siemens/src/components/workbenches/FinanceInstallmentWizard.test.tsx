import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewFinancePaymentPolicy, setFinancePaymentPolicy } from '../../api/finance';
import { financeWorkObjects } from '../../domain/fixtures/finance';
import { prepay50Template } from '../../domain/financePaymentPolicy';
import type { PaymentPolicyPreview, WorkObject } from '../../domain/types';
import { FinanceInstallmentReview, FinanceInstallmentWizard } from './FinanceInstallmentWizard';

vi.mock('../../api/finance', () => ({
  previewFinancePaymentPolicy: vi.fn(),
  setFinancePaymentPolicy: vi.fn(),
}));

const previewPaymentPolicyMock = vi.mocked(previewFinancePaymentPolicy);
const setPaymentPolicyMock = vi.mocked(setFinancePaymentPolicy);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function preview(finalDay: number): PaymentPolicyPreview {
  return {
    rows: [
      {
        sequence: 1,
        trigger: 'invoice_issued',
        percentageBasisPoints: 5000,
        offsetDays: 0,
        amount: 60000,
        date: '2026-07-20',
        dateKind: 'actual',
      },
      {
        sequence: 2,
        trigger: 'full_shipment',
        percentageBasisPoints: 5000,
        offsetDays: finalDay,
        amount: 60000,
        date: null,
        dateKind: 'condition',
      },
    ],
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.findAllByType('button').find((item) => nodeText(item) === label)!;
}

describe('FinanceInstallmentWizard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: (handler: TimerHandler, timeout?: number) =>
        globalThis.setTimeout(handler, timeout) as unknown as number,
      clearTimeout: (id: number) => globalThis.clearTimeout(id),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    previewPaymentPolicyMock.mockReset();
    setPaymentPolicyMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens an arbitrary-stage editor with quick templates', () => {
    const markup = renderToStaticMarkup(
      <FinanceInstallmentWizard
        object={{ ...financeWorkObjects[0], id: 'finance-1' }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Условия оплаты');
    expect(markup).toContain('Шаг 1 из 4');
    expect(markup).toContain('100% сразу');
    expect(markup).toContain('50/50');
    expect(markup).toContain('100% через 30 дней');
    expect(markup).toContain('Добавить этап');
    expect(markup).toContain('Срок рассрочки');
    expect(markup).toContain('finance-installment-section-heading');
    expect(markup).not.toMatch(
      /Бухгалтерия выбирает только условия|ручное редактирование дат и сумм недоступно|План формируется автоматически/,
    );
    expect(markup).not.toContain('Фактическая отгрузка');
    expect(markup).toContain('Количество этапов');
  });

  it('describes the payment timing in customer-facing language', () => {
    const source = financeWorkObjects[0];
    const markup = renderToStaticMarkup(
      <FinanceInstallmentWizard
        object={{
          ...source,
          financeAmountValue: 1000,
          facts: source.facts.map((fact) =>
            fact.label === 'Сумма' ? { ...fact, value: 'Демо-счёт' } : fact,
          ),
          paymentTermsType: 'prepay_50_postpay_50_30d',
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(markup).toContain('Условия оплаты');
    expect(markup).toContain('1 000 ₽');
    expect(markup).toContain('через 30 дней после полной отгрузки');
  });

  it('lays out the change reason and selected terms as a review', () => {
    const markup = renderToStaticMarkup(
      <FinanceInstallmentReview
        paymentPolicy={prepay50Template(30)}
        preview={null}
        changed
        reason=""
        onReasonChange={vi.fn()}
      />,
    );

    expect(markup).toContain('Проверьте условия перед сохранением');
    expect(markup).toContain('finance-installment-reason-card');
    expect(markup).toContain('Основание изменения');
    expect(markup).toContain('Срок рассрочки: 30 дней после полной отгрузки');
    expect(markup).not.toMatch(/Бухгалтерия|ручное редактирование|недоступно/);
  });

  it('requires a reason and saves the exact policy revision while submit is locked', async () => {
    const initialPreview = deferred<PaymentPolicyPreview>();
    const changedPreview = deferred<PaymentPolicyPreview>();
    const saveResult = deferred<WorkObject>();
    previewPaymentPolicyMock
      .mockReturnValueOnce(initialPreview.promise)
      .mockReturnValueOnce(changedPreview.promise);
    setPaymentPolicyMock.mockReturnValueOnce(saveResult.promise);
    const initialPolicy = prepay50Template(30);
    const source = financeWorkObjects[0];
    const object: WorkObject = {
      ...source,
      id: 'finance-existing-policy',
      financeAmountValue: 120000,
      paymentPolicy: {
        id: 'policy-1',
        revision: 2,
        capturedProductionLeadDays: 2,
        ...initialPolicy,
      },
    };
    const updated: WorkObject = {
      ...object,
      paymentPolicy: {
        ...object.paymentPolicy!,
        revision: 3,
        ...prepay50Template(45),
      },
    };
    const onSaved = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <FinanceInstallmentWizard object={object} onClose={vi.fn()} onSaved={onSaved} />,
      );
    });
    expect(previewPaymentPolicyMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(previewPaymentPolicyMock).toHaveBeenLastCalledWith(object.id, {
      paymentPolicy: initialPolicy,
    });
    await act(async () => {
      initialPreview.resolve(preview(30));
      await initialPreview.promise;
    });

    const termInput = renderer.root
      .findAllByType('input')
      .find((input) => input.props.max === '3650')!;
    act(() => termInput.props.onChange({ currentTarget: { value: '45' } }));
    expect(button(renderer.root, 'Далее').props.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(previewPaymentPolicyMock).toHaveBeenLastCalledWith(object.id, {
      paymentPolicy: prepay50Template(45),
    });
    await act(async () => {
      changedPreview.resolve(preview(45));
      await changedPreview.promise;
    });

    act(() => button(renderer.root, 'Далее').props.onClick());
    act(() => button(renderer.root, 'Далее').props.onClick());
    expect(button(renderer.root, 'Сохранить').props.disabled).toBe(true);
    act(() =>
      renderer.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: 'Согласовано с клиентом' } }),
    );
    expect(button(renderer.root, 'Сохранить').props.disabled).toBe(false);
    await act(async () => {
      button(renderer.root, 'Сохранить').props.onClick();
      await Promise.resolve();
    });
    expect(setPaymentPolicyMock).toHaveBeenCalledWith(object.id, {
      expectedRevision: 2,
      reason: 'Согласовано с клиентом',
      paymentPolicy: prepay50Template(45),
    });
    expect(button(renderer.root, 'Сохраняем…').props.disabled).toBe(true);
    await act(async () => {
      saveResult.resolve(updated);
      await saveResult.promise;
    });
    expect(onSaved).toHaveBeenCalledWith(updated);
    expect(nodeText(renderer.root.findByProps({ role: 'status' }))).toContain('Условия сохранены');
    renderer.unmount();
  });
});
