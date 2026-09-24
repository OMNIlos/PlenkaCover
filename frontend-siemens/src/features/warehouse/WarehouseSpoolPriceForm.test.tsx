import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type {
  RecordSpoolStockReceiptInput,
  SpoolStockReceiptView,
  SpoolStockSummaryItem,
} from '../../api/warehouseSpoolPrice';
import { parseRublesToKopecks, WarehouseSpoolPriceForm } from './WarehouseSpoolPriceForm';

const TYPES = [
  { key: '76 мм', label: '76 мм' },
  { key: 'толстая', label: 'Толстая' },
  { key: 'тонкая', label: 'Тонкая' },
  { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
] as const;

const SAVED: SpoolStockReceiptView = {
  id: 'spool-receipt-1',
  spoolTypeKey: 'тонкая',
  spoolTypeLabel: 'Тонкая',
  quantityMillimeters: 125_500,
  priceReferenceId: 'spool-price-1',
  priceKopecksPerMeter: 6_050,
  effectiveFrom: '2026-08-08T00:00:00.000Z',
  receivedAt: '2026-08-08T00:00:00.000Z',
  receivedById: 'warehouse-user-1',
  receivedByRole: 'warehouse',
  createdAt: '2026-08-08T02:00:00.000Z',
};

const STOCK: SpoolStockSummaryItem[] = [
  {
    spoolTypeKey: 'тонкая',
    spoolTypeLabel: 'Тонкая',
    totalReceivedMillimeters: 0,
    lastReceivedAt: null,
  },
];

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function field(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findByProps({ 'aria-label': label });
}

function button(renderer: ReactTestRenderer) {
  return renderer.root.findByType('button');
}

async function renderForm(
  saveReceipt: (input: RecordSpoolStockReceiptInput) => Promise<SpoolStockReceiptView>,
  createKey = vi.fn(() => '11111111-1111-4111-8111-111111111111'),
  loadStock = vi.fn().mockResolvedValue(STOCK),
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WarehouseSpoolPriceForm
        loadTypes={vi.fn().mockResolvedValue(TYPES)}
        saveReceipt={saveReceipt}
        loadStock={loadStock}
        createKey={createKey}
      />,
    );
  });
  return { renderer, createKey, loadStock };
}

function fillValidDraft(renderer: ReactTestRenderer) {
  act(() => {
    field(renderer, 'Цена, ₽/м').props.onChange({ currentTarget: { value: '60,50' } });
    field(renderer, 'Количество, пог. м').props.onChange({
      currentTarget: { value: '125,5' },
    });
    field(renderer, 'Дата действия').props.onChange({
      currentTarget: { value: '2026-08-08' },
    });
  });
}

describe('warehouse spool-price input', () => {
  it.each([
    ['60', 6_000],
    ['60,5', 6_050],
    ['0.01', 1],
    ['9999999999999.99', 999_999_999_999_999],
  ])('converts exact decimal rubles %s into integer kopecks', (value, expected) => {
    expect(parseRublesToKopecks(value)).toBe(expected);
  });

  it.each(['', '0', '-1', '1.001', '1e3', '99999999999999.99'])(
    'rejects an invalid money draft %s',
    (value) => {
      expect(parseRublesToKopecks(value)).toBeNull();
    },
  );

  it('submits one atomic receipt, clears only quantity, and refreshes the summary', async () => {
    const saveReceipt = vi.fn().mockResolvedValue(SAVED);
    const { renderer, loadStock } = await renderForm(saveReceipt);
    fillValidDraft(renderer);

    expect(renderer.root.findAllByProps({ 'aria-label': 'Источник' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Причина' })).toHaveLength(0);

    expect(
      field(renderer, 'Вид шпули')
        .findAllByType('option')
        .map((option) => text(option)),
    ).toEqual(['Тонкая', 'Толстая']);

    await act(async () => button(renderer).props.onClick());

    expect(text(renderer.root)).toContain('Цена и приход шпуль');
    expect(text(button(renderer))).toBe('Сохранить цену и приход');

    expect(saveReceipt).toHaveBeenCalledWith({
      operationKey: '11111111-1111-4111-8111-111111111111',
      spoolTypeLabel: 'Тонкая',
      priceKopecksPerMeter: 6_050,
      quantityMillimeters: 125_500,
      source: 'Прайс склада',
      effectiveFrom: '2026-08-08T00:00:00.000Z',
      reason: 'Цена и приход шпули записаны складом',
    });
    expect(text(renderer.root)).toContain('Цена и приход сохранены');
    expect(text(renderer.root)).toContain('Тонкая · 125,5 пог. м · 60,50 ₽/м');
    expect(field(renderer, 'Количество, пог. м').props.value).toBe('');
    expect(field(renderer, 'Цена, ₽/м').props.value).toBe('60,50');
    expect(field(renderer, 'Дата действия').props.value).toBe('2026-08-08');
    expect(field(renderer, 'Вид шпули').props.value).toBe('Тонкая');
    expect(loadStock).toHaveBeenCalledTimes(2);
  });

  it('refuses a label that was not observed in the loaded catalog', async () => {
    const saveReceipt = vi.fn().mockResolvedValue(SAVED);
    const { renderer } = await renderForm(saveReceipt);
    fillValidDraft(renderer);

    act(() => {
      field(renderer, 'Вид шпули').props.onChange({
        currentTarget: { value: 'Придуманная шпуля' },
      });
    });

    expect(button(renderer).props.disabled).toBe(true);
    await act(async () => button(renderer).props.onClick());
    expect(saveReceipt).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.0001', '1e3'])(
    'keeps the action disabled for invalid meter input %s',
    async (quantity) => {
      const { renderer } = await renderForm(vi.fn().mockResolvedValue(SAVED));
      fillValidDraft(renderer);
      act(() => {
        field(renderer, 'Количество, пог. м').props.onChange({
          currentTarget: { value: quantity },
        });
      });

      expect(button(renderer).props.disabled).toBe(true);
    },
  );

  it('reserves one live feedback line and explains the disabled action', async () => {
    const { renderer } = await renderForm(vi.fn().mockResolvedValue(SAVED));

    const feedback = renderer.root.findByProps({
      className: 'warehouse-spool-price-feedback',
    });
    expect(feedback.props['aria-live']).toBe('polite');
    expect(text(feedback)).toBe('Заполните цену, количество и дату действия.');
    expect(button(renderer).props['aria-describedby']).toBe(feedback.props.id);
  });

  it('keeps one UUID for an unchanged retry and rotates it after a draft change', async () => {
    const saveReceipt = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(SAVED);
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const { renderer } = await renderForm(saveReceipt, createKey);
    fillValidDraft(renderer);

    await act(async () => button(renderer).props.onClick());
    await act(async () => button(renderer).props.onClick());

    expect(saveReceipt.mock.calls.slice(0, 2).map(([input]) => input.operationKey)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(createKey).toHaveBeenCalledTimes(1);

    act(() => {
      field(renderer, 'Цена, ₽/м').props.onChange({ currentTarget: { value: '61' } });
    });
    await act(async () => button(renderer).props.onClick());

    expect(saveReceipt.mock.calls[2]?.[0].operationKey).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it('rotates the UUID after a successful request even when the draft is unchanged', async () => {
    const saveReceipt = vi.fn().mockResolvedValue(SAVED);
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const { renderer } = await renderForm(saveReceipt, createKey);
    fillValidDraft(renderer);

    await act(async () => button(renderer).props.onClick());
    act(() => {
      field(renderer, 'Количество, пог. м').props.onChange({
        currentTarget: { value: '125,5' },
      });
    });
    await act(async () => button(renderer).props.onClick());

    expect(saveReceipt.mock.calls.map(([input]) => input.operationKey)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('keeps a server conflict visible in Russian without claiming success', async () => {
    const saveReceipt = vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          'Для этого вида шпули уже есть цена с такой датой действия.',
          'SPOOL_PRICE_EFFECTIVE_COLLISION',
        ),
      );
    const { renderer } = await renderForm(saveReceipt);
    fillValidDraft(renderer);

    await act(async () => button(renderer).props.onClick());

    expect(text(renderer.root)).toContain(
      'Для этого вида шпули уже есть цена с такой датой действия.',
    );
    expect(text(renderer.root)).not.toContain('Цена и приход сохранены');
  });
});
