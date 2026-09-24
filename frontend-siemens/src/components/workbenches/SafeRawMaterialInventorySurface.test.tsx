import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  SafeInventoryPage,
  SafeInventoryQuery,
  SafeInventoryRole,
} from '../../api/rawMaterialInventory';
import { SafeRawMaterialInventorySurface } from './SafeRawMaterialInventorySurface';

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderedText(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

function inventoryPage(
  status: SafeInventoryPage['items'][number]['sourceStatus'] = 'partial',
  sourceUnavailable = false,
): SafeInventoryPage {
  return {
    items: [
      {
        materialId: 'rm-1',
        materialName: 'ПВД 15803-020',
        category: 'primary',
        unit: 'кг',
        erpActualQty: 840,
        oneCQty: 800,
        reservedQty: null,
        availableQty: null,
        expectedUsageQty: null,
        openBigBagQty: 170,
        recycledQty: null,
        sourceStatus: status,
        source: {
          snapshotId: 'snapshot-1',
          sourceKind: '1C',
          capturedAt: '2026-07-27T07:55:00.000Z',
          importedAt: '2026-07-27T08:00:00.000Z',
        },
        conflicts: [
          {
            code: 'INCOMPLETE_DEDUCTIONS',
            message: 'Резерв и ожидаемый расход не подтверждены.',
          },
        ],
        updatedAt: '2026-07-27T08:00:00.000Z',
      },
    ],
    nextCursor: null,
    sourceUnavailable,
    generatedAt: '2026-07-27T09:00:00.000Z',
  };
}

function namedPage(
  materialId: string,
  materialName: string,
  nextCursor: string | null = null,
): SafeInventoryPage {
  const page = inventoryPage();
  return {
    ...page,
    items: [{ ...page.items[0], materialId, materialName }],
    nextCursor,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SafeRawMaterialInventorySurface', () => {
  it('refreshes from the shared generation without hiding the current table', async () => {
    const nextPage = deferred<SafeInventoryPage>();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(namedPage('rm-current', 'Текущие остатки'))
      .mockReturnValueOnce(nextPage.promise);
    const headerAction = (
      <button type="button" aria-label="Обновить данные вкладки">
        Обновить
      </button>
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface
          role="director"
          fetchPage={fetchPage}
          refreshGeneration={1}
          headerAction={headerAction}
        />,
      );
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('Текущие остатки');
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Обновить данные вкладки' }),
    ).toHaveLength(1);

    act(() => {
      renderer.update(
        <SafeRawMaterialInventorySurface
          role="director"
          fetchPage={fetchPage}
          refreshGeneration={2}
          headerAction={headerAction}
        />,
      );
    });
    await flushPromises();

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Текущие остатки');
    expect(renderedText(renderer)).not.toContain('Загружаем данные о сырье');

    nextPage.resolve(namedPage('rm-next', 'Обновлённые остатки'));
    await act(async () => {
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('Обновлённые остатки');
    renderer.unmount();
  });

  it('does not keep rows from the previous filter scope while the next scope loads or fails', async () => {
    const nextPage = deferred<SafeInventoryPage>();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(namedPage('rm-current', 'Старый фильтр'))
      .mockReturnValueOnce(nextPage.promise);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="director" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('Старый фильтр');

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Категория сырья' }).props.onChange({
        target: { value: 'secondary' },
      });
      await flushPromises();
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      'director',
      { category: 'secondary', limit: 25 },
      expect.any(Object),
    );
    expect(renderedText(renderer)).not.toContain('Старый фильтр');
    expect(renderedText(renderer)).toContain('Загружаем данные о сырье');

    nextPage.reject(new Error('next scope failed'));
    await act(async () => {
      await flushPromises();
    });

    expect(renderedText(renderer)).not.toContain('Старый фильтр');
    expect(renderedText(renderer)).toContain('Не удалось загрузить данные о сырье');
    renderer.unmount();
  });

  it('does not expose accounting-system labels in the shared warehouse view', async () => {
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface
          role="warehouse"
          fetchPage={vi.fn(async () => inventoryPage('unavailable', true))}
        />,
      );
      await flushPromises();
    });

    const text = renderedText(renderer);
    expect(text).not.toContain('1С');
    expect(text).not.toContain('Состояние источника');
    expect(text).not.toContain('Источник');
    expect(text).toContain('ПВД 15803-020');
  });

  it('renders only useful inventory facts without page or row diagnostics', async () => {
    let resolvePage!: (page: SafeInventoryPage) => void;
    const fetchPage = vi.fn(
      () =>
        new Promise<SafeInventoryPage>((resolve) => {
          resolvePage = resolve;
        }),
    );
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="production" fetchPage={fetchPage} />,
      );
    });

    expect(renderedText(renderer)).toContain('Загружаем данные о сырье');

    await act(async () => {
      resolvePage(inventoryPage());
      await flushPromises();
    });

    const text = renderedText(renderer);
    expect(text).toContain('ПВД 15803-020');
    expect(text).toContain('840 кг');
    expect(text).not.toContain('800 кг');
    expect(text).toContain('170 кг');
    expect(text).toContain('Не подтверждено');
    expect(text).not.toContain('Данные частичные');
    expect(
      renderer.root.findAllByProps({
        className: 'safe-inventory-source-state state-partial',
      }),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('footer')).toHaveLength(0);
    expect(text).not.toContain('27.07.2026');
    expect(text).not.toContain('Резерв и ожидаемый расход не подтверждены.');
    expect(text).not.toMatch(/rawPayload|snapshot-1|demo/iu);
  });

  it('hides generated, ERP update, snapshot capture, and import timestamps', async () => {
    const page = inventoryPage('stale');
    page.items[0] = {
      ...page.items[0],
      source: {
        ...page.items[0].source!,
        capturedAt: '2026-07-25T07:55:00.000Z',
        importedAt: '2026-07-26T08:00:00.000Z',
      },
      updatedAt: '2026-07-27T09:00:00.000Z',
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="director" fetchPage={vi.fn(async () => page)} />,
      );
      await flushPromises();
    });

    const text = renderedText(renderer);
    expect(text).not.toContain('ERP обновлено');
    expect(text).not.toContain('Снимок');
    expect(text).not.toContain('Импортирован');
    expect(text).not.toContain('25.07.2026');
    expect(text).not.toContain('26.07.2026');
    expect(text).not.toContain('27.07.2026');
  });

  it('does not add a page-level source warning when rows have mixed states', async () => {
    const stalePage = namedPage('rm-stale', 'Устаревший материал');
    stalePage.items[0] = { ...stalePage.items[0], sourceStatus: 'stale' };
    const conflictItem = {
      ...stalePage.items[0],
      materialId: 'rm-conflict',
      materialName: 'Материал с расхождением',
      sourceStatus: 'conflict' as const,
    };
    stalePage.items.push(conflictItem);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface
          role="production"
          fetchPage={vi.fn(async () => stalePage)}
        />,
      );
      await flushPromises();
    });

    expect(renderedText(renderer)).not.toContain('Есть расхождения');
    expect(renderedText(renderer)).not.toContain('Учетный снимок устарел');
    expect(renderer.root.findAllByProps({ className: 'safe-inventory-source-state' })).toHaveLength(
      0,
    );
  });

  it.each([
    ['stale', false],
    ['unavailable', true],
  ] as const)(
    'keeps ERP facts visible for the %s source state without a page banner',
    async (status, sourceUnavailable) => {
      const fetchPage = vi.fn(async () => inventoryPage(status, sourceUnavailable));
      let renderer!: ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          <SafeRawMaterialInventorySurface role="director" fetchPage={fetchPage} />,
        );
        await flushPromises();
      });

      const text = renderedText(renderer);
      expect(text).toContain('ПВД 15803-020');
      expect(text).toContain('840 кг');
      expect(renderer.root.findAllByProps({ className: 'safe-inventory-source-state' })).toHaveLength(
        0,
      );
      expect(text).not.toContain('Учетный снимок устарел');
    },
  );

  it('sends search and the concise inventory filters to the role endpoint', async () => {
    const calls: Array<{ role: SafeInventoryRole; query: SafeInventoryQuery }> = [];
    const fetchPage = vi.fn(async (role: SafeInventoryRole, query: SafeInventoryQuery) => {
      calls.push({ role, query });
      return inventoryPage();
    });
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="production" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Поиск по сырью' }).props.onChange({
        target: { value: 'ПВД 70/30' },
      });
      renderer.root.findByProps({ 'aria-label': 'Категория сырья' }).props.onChange({
        target: { value: 'primary' },
      });
      renderer.root.findByProps({ 'aria-label': 'Доступность сырья' }).props.onChange({
        target: { value: 'unavailable' },
      });
      await flushPromises();
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск сырья' })
        .props.onSubmit({ preventDefault: vi.fn() });
      await flushPromises();
    });

    expect(calls.at(-1)).toEqual({
      role: 'production',
      query: {
        q: 'ПВД 70/30',
        category: 'primary',
        availability: 'unavailable',
        limit: 25,
      },
    });
  });

  it('appends cursor pages and deduplicates a material by its stable id', async () => {
    const firstPage = namedPage('rm-1', 'ПВД до обновления', 'cursor-1');
    const secondPage = namedPage('rm-1', 'ПВД после обновления');
    secondPage.items[0] = { ...secondPage.items[0], erpActualQty: 900 };
    secondPage.items.push({
      ...secondPage.items[0],
      materialId: 'rm-2',
      materialName: 'Добавка А',
      erpActualQty: 25,
    });
    const fetchPage = vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="production" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });
    await act(async () => {
      renderer.root
        .findByProps({ className: 'safe-inventory-pagination' })
        .findByType('button')
        .props.onClick();
      await flushPromises();
    });

    const text = renderedText(renderer);
    expect(renderer.root.findAllByProps({ 'data-material-id': 'rm-1' })).toHaveLength(1);
    expect(text).toContain('ПВД после обновления');
    expect(text).not.toContain('ПВД до обновления');
    expect(text).toContain('900 кг');
    expect(text).toContain('Добавка А');
  });

  it('keeps cursor pagination available for an empty page and can reveal later rows', async () => {
    const firstPage: SafeInventoryPage = {
      items: [],
      nextCursor: 'cursor-after-empty',
      sourceUnavailable: false,
      generatedAt: '2026-07-27T09:00:00.000Z',
    };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(namedPage('rm-later', 'Материал на следующей странице'));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="director" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });

    const pagination = renderer.root.findByProps({ className: 'safe-inventory-pagination' });
    expect(renderedText(renderer)).toContain('Искать дальше');
    await act(async () => {
      pagination.findByType('button').props.onClick();
      await flushPromises();
    });

    expect(renderedText(renderer)).toContain('Материал на следующей странице');
    expect(renderedText(renderer)).not.toContain('Материалы не найдены');
    expect(fetchPage.mock.calls[1][1]).toEqual(
      expect.objectContaining({ cursor: 'cursor-after-empty' }),
    );
  });

  it('aborts an in-flight cursor request on filter change and ignores its late result', async () => {
    const cursorRequest = deferred<SafeInventoryPage>();
    let cursorSignal: AbortSignal | undefined;
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(namedPage('rm-initial', 'Начальная страница', 'cursor-1'))
      .mockImplementationOnce(
        (
          _role: SafeInventoryRole,
          _query: SafeInventoryQuery,
          options?: { signal?: AbortSignal },
        ) => {
          cursorSignal = options?.signal;
          return cursorRequest.promise;
        },
      )
      .mockResolvedValueOnce(namedPage('rm-filtered', 'После фильтра'));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="production" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });
    await act(async () => {
      renderer.root
        .findByProps({ className: 'safe-inventory-pagination' })
        .findByType('button')
        .props.onClick();
      await flushPromises();
    });
    expect(cursorSignal?.aborted).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Категория сырья' }).props.onChange({
        target: { value: 'primary' },
      });
      await flushPromises();
    });
    expect(cursorSignal?.aborted).toBe(true);

    await act(async () => {
      cursorRequest.resolve(namedPage('rm-late', 'Опоздавшая страница'));
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('После фильтра');
    expect(renderedText(renderer)).not.toContain('Опоздавшая страница');
  });

  it('aborts an in-flight cursor request when the surface unmounts', async () => {
    const cursorRequest = deferred<SafeInventoryPage>();
    let cursorSignal: AbortSignal | undefined;
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(namedPage('rm-initial', 'Начальная страница', 'cursor-1'))
      .mockImplementationOnce(
        (
          _role: SafeInventoryRole,
          _query: SafeInventoryQuery,
          options?: { signal?: AbortSignal },
        ) => {
          cursorSignal = options?.signal;
          return cursorRequest.promise;
        },
      );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="director" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });
    await act(async () => {
      renderer.root
        .findByProps({ className: 'safe-inventory-pagination' })
        .findByType('button')
        .props.onClick();
      await flushPromises();
    });
    expect(cursorSignal?.aborted).toBe(false);

    act(() => renderer.unmount());

    expect(cursorSignal?.aborted).toBe(true);
  });

  it('shows compact empty and recoverable error states without local fallback rows', async () => {
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('network detail'))
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        sourceUnavailable: false,
        generatedAt: '2026-07-27T09:00:00.000Z',
      } satisfies SafeInventoryPage);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <SafeRawMaterialInventorySurface role="director" fetchPage={fetchPage} />,
      );
      await flushPromises();
    });
    expect(renderedText(renderer)).toContain('Не удалось загрузить данные о сырье');
    expect(renderedText(renderer)).not.toContain('ПВД 15803-020');

    await act(async () => {
      renderer.root.findByProps({ 'data-safe-inventory-retry': true }).props.onClick();
      await flushPromises();
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(renderedText(renderer)).toContain('Материалы не найдены');
    expect(renderedText(renderer)).not.toContain('Стр. 1/1');
  });
});
