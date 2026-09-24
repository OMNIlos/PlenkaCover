import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { workObjects } from '../../domain/fixtures/workObjects';
import { FinanceInvoiceSyncAction } from './FinanceInvoiceSyncAction';

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('FinanceInvoiceSyncAction', () => {
  it('opens the manual invoice dialog without exposing 1C prices', () => {
    const object = {
      ...workObjects.finance[0],
      facts: [
        ...workObjects.finance[0].facts,
        { label: 'Маркер для 1С', value: 'PLENKA_ORDER=ЗК-0042' },
      ],
    };
    const renderer = TestRenderer.create(
      <FinanceInvoiceSyncAction
        action={{
          id: 'finance-create-invoice:finance-1',
          label: 'Открыть счет',
          level: 'recommended',
          enabled: true,
        }}
        object={object}
        onCreated={vi.fn()}
      />,
    );

    act(() => renderer.root.findByType('button').props.onClick());

    expect(nodeText(renderer.root)).toContain('Оформить счёт вручную');
    expect(nodeText(renderer.root)).toContain('Сумма счёта, ₽');
    expect(nodeText(renderer.root)).not.toContain('PLENKA_ORDER=ЗК-0042');
  });
});
