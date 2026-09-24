import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ApiRequestOptions } from '../../api/client';
import type { SpoolStockSummaryItem } from '../../api/warehouseSpoolPrice';
import { SpoolStockSummary } from './SpoolStockSummary';

const STOCK: SpoolStockSummaryItem[] = [
  {
    spoolTypeKey: 'тонкая',
    spoolTypeLabel: 'Тонкая',
    totalReceivedMillimeters: 125_500,
    lastReceivedAt: '2026-08-08T02:00:00.000Z',
  },
  {
    spoolTypeKey: 'толстая',
    spoolTypeLabel: 'Толстая',
    totalReceivedMillimeters: 0,
    lastReceivedAt: null,
  },
];

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

async function renderSummary(
  loadStock: (options?: ApiRequestOptions) => Promise<SpoolStockSummaryItem[]>,
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<SpoolStockSummary loadStock={loadStock} />);
    await Promise.resolve();
  });
  return renderer;
}

describe('SpoolStockSummary', () => {
  it('renders loading, empty, and exact received-meter states', async () => {
    let loading!: ReactTestRenderer;
    act(() => {
      loading = TestRenderer.create(
        <SpoolStockSummary
          loadStock={vi.fn(() => new Promise<SpoolStockSummaryItem[]>(() => undefined))}
        />,
      );
    });
    expect(text(loading.root)).toContain('Загрузка прихода шпуль…');
    act(() => loading.unmount());

    const empty = await renderSummary(vi.fn().mockResolvedValue([]));
    expect(text(empty.root)).toContain('Приход шпуль пока не зафиксирован.');

    const filled = await renderSummary(vi.fn().mockResolvedValue(STOCK));
    expect(filled.root.findByProps({ 'aria-label': 'Приход шпуль' })).toBeDefined();
    expect(text(filled.root)).toContain('Тонкая');
    expect(text(filled.root)).toContain('Принято на склад: 125,5 пог. м');
    expect(text(filled.root)).toContain('Принято на склад: 0 пог. м');
  });

  it('offers a retry after an error and loads a fresh snapshot', async () => {
    const loadStock = vi
      .fn<(options?: ApiRequestOptions) => Promise<SpoolStockSummaryItem[]>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(STOCK);
    const renderer = await renderSummary(loadStock);

    expect(renderer.root.findByProps({ role: 'alert' })).toBeDefined();
    await act(async () => {
      renderer.root.findByType('button').props.onClick();
      await Promise.resolve();
    });

    expect(loadStock).toHaveBeenCalledTimes(2);
    expect(text(renderer.root)).toContain('Принято на склад: 125,5 пог. м');
  });

  it('reloads once when refreshRevision changes', async () => {
    const loadStock = vi.fn().mockResolvedValue(STOCK);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SpoolStockSummary refreshRevision={0} loadStock={loadStock} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      renderer.update(<SpoolStockSummary refreshRevision={1} loadStock={loadStock} />);
      await Promise.resolve();
    });

    expect(loadStock).toHaveBeenCalledTimes(2);
  });

  it('aborts an unmounted request and ignores its late result', async () => {
    let resolve!: (value: SpoolStockSummaryItem[]) => void;
    let signal: AbortSignal | undefined;
    const loadStock = vi.fn((options?: ApiRequestOptions) => {
      signal = options?.signal;
      return new Promise<SpoolStockSummaryItem[]>((resolvePromise) => {
        resolve = resolvePromise;
      });
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<SpoolStockSummary loadStock={loadStock} />);
    });

    act(() => renderer.unmount());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve(STOCK);
      await Promise.resolve();
    });
    expect(loadStock).toHaveBeenCalledTimes(1);
  });
});
