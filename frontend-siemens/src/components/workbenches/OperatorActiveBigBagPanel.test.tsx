import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { OperatorActiveBigBagPanel } from './OperatorActiveBigBagPanel';

const bags = [
  {
    bagId: 'bag-active',
    code: 'BB-01',
    material: 'ПВД Первичное',
    materialId: 'material-primary',
    warehouseKg: 500,
    startKg: 500,
    endKg: null,
    addedReason: null,
    releasedReason: null,
    active: true,
    releasedAt: null,
    sequence: 1,
  },
  {
    bagId: 'bag-released',
    code: 'BB-00',
    material: 'ПВД Вторичное',
    materialId: 'material-secondary',
    warehouseKg: 450,
    startKg: 450,
    endKg: 120,
    addedReason: 'Продолжение заказа',
    releasedReason: 'Больше не требуется',
    active: false,
    releasedAt: '2026-08-03T12:00:00.000Z',
    sequence: 2,
  },
];

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe('OperatorActiveBigBagPanel', () => {
  it('shows active bags separately from immutable released history', () => {
    const markup = TestRenderer.create(<OperatorActiveBigBagPanel bags={bags} />);

    expect(nodeText(markup.root)).toContain('Текущие Big-Bag');
    expect(nodeText(markup.root)).toContain('BB-01');
    expect(nodeText(markup.root)).toContain('Уже сданы');
    expect(nodeText(markup.root)).not.toContain('Вернуть на склад');
    expect(nodeText(markup.root)).toContain('BB-00');
    expect(nodeText(markup.root)).toContain('Больше не требуется');
  });

  it('requires only a physical final weight before releasing one bag', async () => {
    const onRelease = vi.fn().mockResolvedValue(undefined);
    const renderer = TestRenderer.create(
      <OperatorActiveBigBagPanel bags={bags} onRelease={onRelease} />,
    );
    expect(button(renderer.root, 'Сдать Big-Bag').props.disabled).toBe(true);

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Финальный вес BB-01, кг' })
        .props.onChange({ currentTarget: { value: '121,4' } });
    });
    expect(button(renderer.root, 'Сдать Big-Bag').props.disabled).toBe(false);

    await act(async () => {
      button(renderer.root, 'Сдать Big-Bag').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onRelease).toHaveBeenCalledWith('bag-active', { endKg: 121.4 });
    expect(nodeText(renderer.root)).not.toContain('Причина сдачи');
  });

  it('rejects a final weight above the recorded start weight', () => {
    const renderer = TestRenderer.create(
      <OperatorActiveBigBagPanel bags={bags} onRelease={vi.fn()} />,
    );
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Финальный вес BB-01, кг' })
        .props.onChange({ currentTarget: { value: '501' } });
    });

    expect(button(renderer.root, 'Сдать Big-Bag').props.disabled).toBe(true);
    expect(nodeText(renderer.root)).toContain('Финальный вес не может быть больше стартового');
  });
});
