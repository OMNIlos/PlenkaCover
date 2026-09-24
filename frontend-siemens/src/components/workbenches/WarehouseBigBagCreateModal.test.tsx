import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { WarehouseBigBagCreateModal } from './WarehouseBigBagCreateModal';

const MATERIALS = [
  { id: 'material-secondary', name: 'Вторичка', kind: 'base' as const },
  { id: 'material-aika', name: 'Айка', kind: 'base' as const },
  { id: 'material-primary-tape', name: 'Первичка ленты', kind: 'base' as const },
  { id: 'material-pvd-tsp', name: 'ПВД ТСП', kind: 'base' as const },
  { id: 'material-danaflex', name: 'Данафлекс', kind: 'base' as const },
  { id: 'material-stretch', name: 'Стрейч', kind: 'base' as const },
  { id: 'material-admin', name: 'ПНД гранула', kind: 'custom' as const },
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

function weightInput(root: ReactTestInstance): ReactTestInstance {
  return root.findByProps({ 'aria-label': 'Масса Big-Bag, кг' });
}

function priceInput(root: ReactTestInstance): ReactTestInstance {
  return root.findByProps({ 'aria-label': 'Цена за 1 кг, ₽' });
}

function batchInput(root: ReactTestInstance): ReactTestInstance {
  return root.findByProps({ 'aria-label': 'Партия сырья' });
}

function supplierInput(root: ReactTestInstance): ReactTestInstance {
  return root.findByProps({ 'aria-label': 'Поставщик' });
}

function materialSelect(root: ReactTestInstance): ReactTestInstance {
  return root.findByProps({ 'aria-label': 'Вид сырья' });
}

function modalProps(onCreate = vi.fn().mockResolvedValue(true), onClose = vi.fn()) {
  return {
    onCreate,
    onClose,
    materials: MATERIALS,
    catalogStatus: 'ready' as const,
    catalogError: null,
    onReloadCatalog: vi.fn(),
  };
}

describe('WarehouseBigBagCreateModal', () => {
  it('shows a shared catalog dropdown, including an admin-created type, and no recipes', () => {
    const renderer = TestRenderer.create(<WarehouseBigBagCreateModal {...modalProps()} />);

    const options = materialSelect(renderer.root).findAllByType('option').map(nodeText);
    expect(options).toEqual([
      'Выберите вид сырья',
      'Вторичка',
      'Айка',
      'Первичка ленты',
      'ПВД ТСП',
      'Данафлекс',
      'Стрейч',
      'ПНД гранула',
    ]);
    expect(nodeText(renderer.root)).not.toContain('Рецептур');
    expect(renderer.root.findAllByProps({ role: 'radiogroup' })).toHaveLength(0);
    expect(weightInput(renderer.root).props.disabled).toBe(true);
  });

  it('searches a growing material catalog and retains the selected option', () => {
    const renderer = TestRenderer.create(<WarehouseBigBagCreateModal {...modalProps()} />);
    act(() =>
      materialSelect(renderer.root).props.onChange({
        currentTarget: { value: 'material-secondary' },
      }),
    );
    act(() =>
      renderer.root
        .findByProps({ 'aria-label': 'Поиск вида сырья' })
        .props.onChange({ currentTarget: { value: 'ПНД' } }),
    );

    expect(materialSelect(renderer.root).findAllByType('option').map(nodeText)).toEqual([
      'Выберите вид сырья',
      'Вторичка',
      'ПНД гранула',
    ]);
  });

  it.each(MATERIALS)('submits $name by shared material id', async (material) => {
    const onCreate = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    const renderer = TestRenderer.create(
      <WarehouseBigBagCreateModal {...modalProps(onCreate, onClose)} />,
    );

    act(() =>
      materialSelect(renderer.root).props.onChange({
        currentTarget: { value: material.id },
      }),
    );
    act(() => weightInput(renderer.root).props.onChange({ currentTarget: { value: '500,5' } }));
    act(() => priceInput(renderer.root).props.onChange({ currentTarget: { value: '100,25' } }));
    act(() =>
      batchInput(renderer.root).props.onChange({ currentTarget: { value: ' ПАРТИЯ-25 ' } }),
    );
    act(() =>
      supplierInput(renderer.root).props.onChange({
        currentTarget: { value: '  ООО Поставщик  ' },
      }),
    );
    await act(async () => {
      button(renderer.root, 'Создать Big-Bag').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledWith({
      baseRawMaterialDefinitionId: material.id,
      weightKg: 500.5,
      priceKopecksPerKg: 10_025,
      batchCode: 'ПАРТИЯ-25',
      supplierName: 'ООО Поставщик',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('blocks invalid weight or price and shows the exact calculated total', () => {
    const renderer = TestRenderer.create(<WarehouseBigBagCreateModal {...modalProps()} />);
    act(() =>
      materialSelect(renderer.root).props.onChange({
        currentTarget: { value: 'material-aika' },
      }),
    );

    const create = () => button(renderer.root, 'Создать Big-Bag');
    expect(create().props.disabled).toBe(true);
    act(() => priceInput(renderer.root).props.onChange({ currentTarget: { value: '25' } }));
    for (const value of ['0', '-1']) {
      act(() => weightInput(renderer.root).props.onChange({ currentTarget: { value } }));
      expect(create().props.disabled).toBe(true);
    }
    act(() => weightInput(renderer.root).props.onChange({ currentTarget: { value: '0.001' } }));
    expect(create().props.disabled).toBe(false);

    for (const value of ['', '-1', '10.001']) {
      act(() => priceInput(renderer.root).props.onChange({ currentTarget: { value } }));
      expect(create().props.disabled).toBe(true);
    }

    act(() => {
      weightInput(renderer.root).props.onChange({ currentTarget: { value: '500,5' } });
      priceInput(renderer.root).props.onChange({ currentTarget: { value: '100,25' } });
    });
    expect(create().props.disabled).toBe(false);
    expect(nodeText(renderer.root)).toContain('50 175,13 ₽');
  });

  it('keeps the draft open and displays a server error', async () => {
    const onClose = vi.fn();
    const renderer = TestRenderer.create(
      <WarehouseBigBagCreateModal
        {...modalProps(
          vi.fn().mockRejectedValue(new Error('Не удалось зарегистрировать Big-Bag')),
          onClose,
        )}
      />,
    );
    act(() =>
      materialSelect(renderer.root).props.onChange({
        currentTarget: { value: 'material-stretch' },
      }),
    );
    act(() => weightInput(renderer.root).props.onChange({ currentTarget: { value: '400' } }));
    act(() => priceInput(renderer.root).props.onChange({ currentTarget: { value: '90' } }));
    await act(async () => {
      button(renderer.root, 'Создать Big-Bag').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).toContain('Не удалось зарегистрировать Big-Bag');
  });
});
