import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { WarehouseReserveRoll, WarehouseReserveRollCreateInput } from '../../api/warehouse';
import { WarehouseReserveRollCreateModal, warehouseReserveRollNetKg } from './WarehouseReserveRollCreateModal';

const materials = [{ id: 'material-primary', name: 'ПВД первичный', kind: 'base' as const }];

const recipes = [
  {
    id: 'recipe-primary',
    name: 'ПВД 70/30',
    version: {
      id: 'recipe-version-primary',
      version: 3,
      ingredients: [
        {
          rawMaterialDefinitionId: 'material-primary',
          name: 'ПВД первичный',
          shareBasisPoints: 10_000,
        },
      ],
    },
  },
];

const createdRoll: WarehouseReserveRoll = {
  id: 'roll-1',
  rollCode: 'RES-001',
  batchCode: 'ПАРТИЯ-1',
  sourceOrderId: 'order-1',
  sourceOrderNumber: 'WR-001',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  netKg: 41.2,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  materialLabel: 'ПВД первичный',
  source: 'platform',
  availability: 'available',
  receivedAt: '2026-08-06T01:00:00.000Z',
  qrReady: true,
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function input(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findByProps({ 'aria-label': label });
}

function submitButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType('button')
    .find((button) => nodeText(button).includes('Добавить в резерв'));
}

async function fillValidDraft(renderer: TestRenderer.ReactTestRenderer) {
  const fields: Array<[string, string]> = [
    ['Код рулона', '  RES-001  '],
    ['Партия рулона', ' ПАРТИЯ-1 '],
    ['Тип плёнки', ' Рукав '],
    ['Тип шпули', ' Тонкая '],
    ['Фактическая толщина, мкм', '80'],
    ['Бухгалтерская толщина, мкм', '78'],
    ['Ширина, мм', '1200'],
    ['Метраж, м', '800'],
    ['Брутто, кг', '41,9'],
    ['Вес шпули, кг', '0,7'],
    ['План нетто, кг', '41'],
    ['Бирка рулона', ' ГОСТ '],
    ['Сырьё или рецептура рулона', 'material:material-primary'],
  ];
  for (const [label, value] of fields) {
    await act(async () => {
      input(renderer, label).props.onChange({ currentTarget: { value } });
    });
  }
}

describe('WarehouseReserveRollCreateModal', () => {
  it('calculates physical net from gross and spool in exact thousandths', () => {
    expect(warehouseReserveRollNetKg('41,900', '0,700')).toBe(41.2);
    expect(warehouseReserveRollNetKg('0.700', '0.700')).toBeNull();
    expect(warehouseReserveRollNetKg('41.1234', '0.7')).toBeNull();
  });

  it('keeps submit unavailable until the complete platform record is valid', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseReserveRollCreateModal
          materials={materials}
          recipes={recipes}
          catalogStatus="ready"
          catalogError={null}
          onReloadCatalog={() => undefined}
          onCreated={() => undefined}
          onClose={() => undefined}
        />,
      );
    });

    expect(submitButton(renderer)?.props.disabled).toBe(true);
    expect(nodeText(renderer.root)).not.toContain('Заполните обязательное поле');

    await fillValidDraft(renderer);

    expect(submitButton(renderer)?.props.disabled).toBe(false);
    expect(nodeText(renderer.root)).toContain('Нетто 41,2 кг');
  });

  it('normalizes the record and reuses the operation key after a retry', async () => {
    const onCreate = vi
      .fn<(input: WarehouseReserveRollCreateInput) => Promise<WarehouseReserveRoll>>()
      .mockRejectedValueOnce(new Error('Связь со складом прервана'))
      .mockResolvedValueOnce(createdRoll);
    const onCreated = vi.fn();
    const onClose = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseReserveRollCreateModal
          materials={materials}
          recipes={recipes}
          catalogStatus="ready"
          catalogError={null}
          onReloadCatalog={() => undefined}
          onCreate={onCreate}
          onCreated={onCreated}
          onClose={onClose}
        />,
      );
    });
    await fillValidDraft(renderer);

    await act(async () => {
      submitButton(renderer)?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('Связь со складом прервана');

    await act(async () => {
      submitButton(renderer)?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCreate).toHaveBeenCalledTimes(2);
    const first = onCreate.mock.calls[0]?.[0];
    const second = onCreate.mock.calls[1]?.[0];
    expect(first?.operationKey).toBe(second?.operationKey);
    expect(first).toMatchObject({
      rollCode: 'RES-001',
      batchCode: 'ПАРТИЯ-1',
      filmType: 'Рукав',
      grossKg: 41.9,
      spoolKg: 0.7,
      baseRawMaterialDefinitionId: 'material-primary',
    });
    expect(first).not.toHaveProperty('recipeDefinitionVersionId');
    expect(onCreated).toHaveBeenCalledWith(createdRoll);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
