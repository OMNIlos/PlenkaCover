import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { FinancePaymentCorrectionDialog } from './FinancePaymentCorrectionDialog';

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

describe('FinancePaymentCorrectionDialog', () => {
  it('requires a reason and explicit confirmation before compensating a payment fact', async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <FinancePaymentCorrectionDialog
          target={{
            target: { kind: 'schedule_confirmation', id: 'schedule-1' },
            label: 'Подтверждение этапа оплаты',
            amount: '500.00',
            source: 'manual_platform',
            canCorrect: true,
            blockedReason: null,
          }}
          busy={false}
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Укажите причину отмены');

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина отмены подтверждения' }).props.onChange({
        currentTarget: { value: 'Оплата отмечена не по тому заказу' },
      });
      renderer.root
        .findByProps({ 'aria-label': 'Подтвердить корректировку оплаты' })
        .props.onChange({
          currentTarget: { checked: true },
        });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onConfirm).toHaveBeenCalledWith('Оплата отмечена не по тому заказу');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open when the server rejects a stale correction', async () => {
    const onConfirm = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <FinancePaymentCorrectionDialog
          target={{
            target: { kind: 'payment_update', id: 'payment-update-1' },
            label: 'Ручное подтверждение статуса «paid»',
            amount: '1200.00',
            source: 'manual_platform',
            canCorrect: true,
            blockedReason: null,
          }}
          busy={false}
          onClose={onClose}
          onConfirm={onConfirm}
        />,
      );
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Причина отмены подтверждения' }).props.onChange({
        currentTarget: { value: 'Ошибочный заказ' },
      });
      renderer.root
        .findByProps({ 'aria-label': 'Подтвердить корректировку оплаты' })
        .props.onChange({
          currentTarget: { checked: true },
        });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('states that invoice and prior production clearance are preserved', () => {
    const markup = JSON.stringify(
      TestRenderer.create(
        <FinancePaymentCorrectionDialog
          target={{
            target: { kind: 'payment_operation', id: 'operation-1' },
            label: 'Платёжная операция',
            amount: '300.00',
            source: 'manual_platform',
            canCorrect: true,
            blockedReason: null,
          }}
          busy={false}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
        />,
      ).toJSON(),
    );

    expect(markup).toContain('Счёт не удаляется');
    expect(markup).toContain('повторного ожидания оплаты');
  });
});
