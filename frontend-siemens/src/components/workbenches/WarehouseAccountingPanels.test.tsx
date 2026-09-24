import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  WarehouseAccountingMovementPage,
  WarehouseAccountingStockPage,
} from '../../api/warehouseAccounting';
import {
  WarehouseAccountingMovementsPanel,
  WarehouseAccountingStockPanel,
} from './WarehouseAccountingPanels';

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function renderedText(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

describe('warehouse accounting panels', () => {
  it('uses concise warehouse labels without exposing the accounting-system name', async () => {
    const stockPage: WarehouseAccountingStockPage = {
      items: [],
      nextCursor: null,
      accountCode: '41.01',
      scope: 'consumables',
      generatedAt: '2026-07-29T08:06:00.000Z',
    };
    const movementPage: WarehouseAccountingMovementPage = {
      items: [],
      nextCursor: null,
      generatedAt: '2026-07-29T08:06:00.000Z',
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <>
          <WarehouseAccountingStockPanel
            scope="consumables"
            fetchPage={vi.fn(async () => stockPage)}
          />
          <WarehouseAccountingMovementsPanel fetchPage={vi.fn(async () => movementPage)} />
        </>,
      );
      await flushPromises();
    });

    const text = renderedText(renderer);
    expect(text).toContain('Расходники');
    expect(text).toContain('Движения');
    expect(text).not.toContain('1С');
  });

  it('renders account 41.01 balances as accounting evidence, not physical rolls', async () => {
    const page: WarehouseAccountingStockPage = {
      items: [
        {
          nomenclatureExternalId: 'material-1',
          name: 'Скотч',
          kind: 'Материалы',
          unit: 'шт',
          quantity: 12,
          balanceStatus: 'positive',
          capturedAt: '2026-07-29T08:00:00.000Z',
          importedAt: '2026-07-29T08:05:00.000Z',
          stale: false,
          physicalTraceability: 'unavailable',
        },
      ],
      nextCursor: null,
      accountCode: '41.01',
      scope: 'consumables',
      generatedAt: '2026-07-29T08:06:00.000Z',
    };
    const fetchPage = vi.fn(async () => page);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseAccountingStockPanel scope="consumables" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });

    expect(renderedText(renderer)).toContain('Расходники');
    expect(renderedText(renderer)).not.toContain('1С');
    expect(renderedText(renderer)).toContain('Скотч');
    expect(renderedText(renderer)).toContain('"12"');
    expect(renderedText(renderer)).toContain('"шт"');
    expect(renderedText(renderer)).toContain('Не является физическим рулоном');
  });

  it('renders posted 1C shipments as outbound accounting movements', async () => {
    const page: WarehouseAccountingMovementPage = {
      items: [
        {
          externalId: 'shipment-1',
          documentNumber: 'РТУ-42',
          documentDate: '2026-07-28T09:30:00.000Z',
          direction: 'outbound',
          sourceLabel: 'Отгрузка по 1С',
          capturedAt: '2026-07-29T08:00:00.000Z',
          importedAt: '2026-07-29T08:05:00.000Z',
          physicalTraceability: 'unavailable',
          lines: [{ lineNumber: 1, name: 'Рукав 500', quantity: 4, unit: 'кг' }],
        },
      ],
      nextCursor: null,
      generatedAt: '2026-07-29T08:06:00.000Z',
    };
    const fetchPage = vi.fn(async () => page);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<WarehouseAccountingMovementsPanel fetchPage={fetchPage} />);
      await flushPromises();
    });

    expect(renderedText(renderer)).toContain('Движения');
    expect(renderedText(renderer)).not.toContain('1С');
    expect(renderedText(renderer)).toContain('РТУ-42');
    expect(renderedText(renderer)).toContain('Рукав 500');
    expect(renderedText(renderer)).toContain('4 кг');
    expect(renderedText(renderer)).toContain('Проведенные складские документы');
  });
});
