import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBigBagRegisterPage, parseBigBagRegisterPage } from '../../api/bigBagRegister';
import { SharedBigBagRegister } from './SharedBigBagRegister';

const row = {
  id: 'bag-1',
  code: 'BB-001',
  material: 'ПВД 10803-020',
  batch: 'ПАРТИЯ-77',
  createdAt: '2026-08-08T06:30:00.000Z',
  status: 'in_use' as const,
  location: { kind: 'post' as const, postCode: 'POST-2', postName: 'Экструдер 2' },
  operatorName: 'Анна Соколова',
  currentWeightKg: 249.5,
  totalKopecks: 623_750,
};

function page(items: unknown[] = [row]) {
  return { items, page: 1, pageSize: 25, total: items.length };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

async function render(fetchPage = vi.fn().mockResolvedValue(page())) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SharedBigBagRegister fetchPage={fetchPage} refreshIntervalMs={0} />,
    );
  });
  return { fetchPage, renderer };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SharedBigBagRegister', () => {
  it('loads the one shared role-neutral endpoint with server query state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(page()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBigBagRegisterPage({ q: 'айка', page: 2, pageSize: 10 })).resolves.toEqual(
      page(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/raw-materials/big-bags?q=%D0%B0%D0%B9%D0%BA%D0%B0&page=2&pageSize=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('requests the current view for the warehouse list', async () => {
    const fetchPage = vi.fn().mockResolvedValue(page());
    await act(async () => {
      TestRenderer.create(
        <SharedBigBagRegister fetchPage={fetchPage} view="current" refreshIntervalMs={0} />,
      );
    });

    expect(fetchPage).toHaveBeenCalledWith(
      { view: 'current', page: 1, pageSize: 25 },
      expect.anything(),
    );
  });

  it('rejects post details on a non-post location', () => {
    expect(() =>
      parseBigBagRegisterPage(
        page([
          {
            ...row,
            location: { kind: 'warehouse', postCode: 'POST-2', postName: null },
          },
        ]),
      ),
    ).toThrow('Сервер вернул некорректный реестр Big-Bag.');
  });

  it('shows the requested business columns with a dedicated operator cell', async () => {
    const { renderer } = await render();

    expect(renderer.root.findAllByType('th').map(text)).toEqual([
      'Название Big-Bag',
      'Сырьё',
      'Дата создания',
      'Статус',
      'Оператор',
      'Текущий вес',
      'Денежный эквивалент',
    ]);
    const content = text(renderer.root);
    expect(content).toContain('BB-001');
    expect(content).toContain('ПВД 10803-020');
    expect(content).toContain('08.08.2026');
    expect(content).toContain('Используется');
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual([
      'Анна Соколова',
    ]);
    expect(text(renderer.root.findByProps({ 'data-bigbag-status': 'busy' }))).toBe(
      'ИспользуетсяНа производстве',
    );
    expect(content).toContain('249,5 кг');
    expect(content).toContain('6 237,50 ₽');
    expect(content).not.toContain('Партия ПАРТИЯ-77');
    expect(content).not.toContain('Экструдер 2 · POST-2');
    expect(content).not.toMatch(/QR|Принтер|Сканирование|Создать Big-Bag|rawPayload/u);
  });

  it('shows free green and occupied red with explicit text and operator', async () => {
    const free = {
      ...row,
      id: 'bag-free',
      code: 'BB-FREE',
      status: 'available' as const,
      location: { kind: 'production' as const, postCode: null, postName: null },
      operatorName: null,
    };
    const warehouse = {
      ...free,
      id: 'bag-warehouse',
      code: 'BB-WAREHOUSE',
      location: { kind: 'warehouse' as const, postCode: null, postName: null },
    };
    const consumed = {
      ...free,
      id: 'bag-consumed',
      code: 'BB-CONSUMED',
      status: 'consumed' as const,
      location: { kind: 'consumed' as const, postCode: null, postName: null },
    };
    const unknown = {
      ...free,
      id: 'bag-unknown',
      code: 'BB-UNKNOWN',
      status: 'in_use' as const,
      location: { kind: 'unknown' as const, postCode: null, postName: null },
    };
    const { renderer } = await render(
      vi.fn().mockResolvedValue(page([warehouse, free, row, consumed, unknown])),
    );

    const freeStatus = renderer.root.findByProps({ 'data-bigbag-status': 'free' });
    const busyStatus = renderer.root.findByProps({ 'data-bigbag-status': 'busy' });
    expect(text(freeStatus)).toContain('Свободен');
    expect(text(freeStatus)).toContain('На производстве');
    expect(text(busyStatus)).toContain('Используется');
    expect(text(busyStatus)).toBe('ИспользуетсяНа производстве');
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual([
      '—',
      '—',
      'Анна Соколова',
      '—',
      '—',
    ]);
    expect(freeStatus.props.className).toContain('shared-bigbag-status--free');
    expect(busyStatus.props.className).toContain('shared-bigbag-status--busy');
    expect(text(renderer.root.findByProps({ 'data-bigbag-status': 'warehouse' }))).toContain(
      'На складе',
    );
    expect(text(renderer.root.findByProps({ 'data-bigbag-status': 'consumed' }))).toContain(
      'Израсходован',
    );
    expect(text(renderer.root.findByProps({ 'data-bigbag-status': 'unknown' }))).toContain(
      'Статус уточняется',
    );
  });

  it('shows an explicit dash when current weight and valuation are unknown', async () => {
    const { renderer } = await render(
      vi.fn().mockResolvedValue(page([{ ...row, currentWeightKg: null, totalKopecks: null }])),
    );

    expect(renderer.root.findAllByProps({ 'data-label': 'Текущий вес' }).map(text)).toEqual(['—']);
    expect(renderer.root.findAllByProps({ 'data-label': 'Денежный эквивалент' }).map(text)).toEqual(
      ['—'],
    );
  });

  it('restores URL state and searches server-side after every typed character', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        pathname: '/commercial',
        search: '?role=commercial&bigBagQuery=%D0%B0%D0%B9%D0%BA%D0%B0',
        hash: '',
      },
      history: { state: { test: true }, replaceState },
    });
    const { fetchPage, renderer } = await render();

    expect(fetchPage).toHaveBeenCalledWith({ q: 'айка', page: 1, pageSize: 25 }, expect.anything());
    const input = renderer.root.findByProps({ 'aria-label': 'Поиск Big-Bag' });
    expect(input.props.value).toBe('айка');
    await act(async () => {
      input.props.onChange({ currentTarget: { value: 'П' } });
    });
    expect(fetchPage).toHaveBeenLastCalledWith(
      { q: 'П', page: 1, pageSize: 25 },
      expect.anything(),
    );
    await act(async () => {
      input.props.onChange({ currentTarget: { value: 'ПН' } });
    });

    expect(fetchPage).toHaveBeenLastCalledWith(
      { q: 'ПН', page: 1, pageSize: 25 },
      expect.anything(),
    );
    expect(replaceState).toHaveBeenCalledWith(
      { test: true },
      '',
      '/commercial?role=commercial&bigBagQuery=%D0%9F%D0%9D',
    );
  });

  it('renders the same read-only result wherever the shared component is mounted', async () => {
    const first = await render();
    const second = await render();

    expect(text(first.renderer.root)).toEqual(text(second.renderer.root));
    expect(first.renderer.root.findAllByType('th').map(text)).toEqual(
      second.renderer.root.findAllByType('th').map(text),
    );
    expect(text(first.renderer.root)).not.toMatch(/Переместить|Печать|Создать/u);
  });

  it('keeps the register on screen without a loading banner while a refresh runs', async () => {
    let resolveRefresh!: (value: ReturnType<typeof page>) => void;
    const refreshing = new Promise<ReturnType<typeof page>>((done) => {
      resolveRefresh = done;
    });
    const fetchPage = vi.fn().mockResolvedValueOnce(page()).mockReturnValueOnce(refreshing);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedBigBagRegister fetchPage={fetchPage} refreshGeneration={0} refreshIntervalMs={0} />,
      );
    });
    expect(text(renderer.root)).toContain('BB-001');

    await act(async () => {
      renderer.update(
        <SharedBigBagRegister fetchPage={fetchPage} refreshGeneration={1} refreshIntervalMs={0} />,
      );
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(text(renderer.root)).not.toContain('Загружаем Big-Bag…');
    expect(text(renderer.root)).toContain('BB-001');

    await act(async () => resolveRefresh(page()));
    expect(text(renderer.root)).toContain('BB-001');
  });

  it('refreshes operator ownership from free through handoff without a page reload', async () => {
    vi.useFakeTimers();
    const operatorA = row;
    const free = {
      ...row,
      status: 'available' as const,
      location: { kind: 'production' as const, postCode: null, postName: null },
      operatorName: null,
    };
    const operatorB = { ...row, operatorName: 'Борис Орлов' };
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(page([free]))
      .mockResolvedValueOnce(page([operatorA]))
      .mockResolvedValueOnce(page([free]))
      .mockResolvedValueOnce(page([operatorB]));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedBigBagRegister fetchPage={fetchPage} refreshIntervalMs={5_000} />,
      );
    });
    expect(text(renderer.root)).toContain('Свободен');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual([
      'Анна Соколова',
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual(['—']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual([
      'Борис Орлов',
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(4);
    renderer.unmount();
  });

  it('keeps the last table visible when an automatic refresh fails', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('net'));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedBigBagRegister fetchPage={fetchPage} refreshIntervalMs={5_000} />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(text(renderer.root)).toContain('BB-001');
    expect(text(renderer.root)).toContain('Не удалось обновить Big-Bag');
    expect(text(renderer.root)).not.toContain('Загружаем Big-Bag…');
    expect(renderer.root.findAllByProps({ 'data-label': 'Оператор' }).map(text)).toEqual([
      'Анна Соколова',
    ]);
    renderer.unmount();
  });

  it('has humane loading, empty, and error states with retry', async () => {
    let resolve!: (value: ReturnType<typeof page>) => void;
    const pending = new Promise<ReturnType<typeof page>>((done) => {
      resolve = done;
    });
    const loadingFetch = vi.fn().mockReturnValue(pending);
    let loading!: ReactTestRenderer;
    act(() => {
      loading = TestRenderer.create(
        <SharedBigBagRegister fetchPage={loadingFetch} refreshIntervalMs={0} />,
      );
    });
    expect(text(loading.root)).toContain('Загружаем Big-Bag…');
    await act(async () => resolve(page([])));
    expect(text(loading.root)).toContain('Big-Bag не найдены');

    const errorFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(page());
    const failed = await render(errorFetch);
    expect(text(failed.renderer.root)).toContain('Не удалось загрузить Big-Bag');
    await act(async () => {
      failed.renderer.root
        .findByProps({ 'aria-label': 'Повторить загрузку Big-Bag' })
        .props.onClick();
    });
    expect(text(failed.renderer.root)).toContain('BB-001');
  });
});
