import { createElement, forwardRef, type ReactNode } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BigBagRegisterPage } from './api/bigBagRegister';
import type { LiveRoleSnapshot } from './api/liveRoleSnapshot';
import App from './App';

const mocks = vi.hoisted(() => ({
  fetchBigBagRegisterPage: vi.fn(),
  fetchWarehouseInventory: vi.fn(),
  loadLiveRoleSnapshot: vi.fn(),
}));

vi.mock('./api/bigBagRegister', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/bigBagRegister')>();
  return { ...actual, fetchBigBagRegisterPage: mocks.fetchBigBagRegisterPage };
});

vi.mock('./api/liveRoleSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveRoleSnapshot')>();
  return { ...actual, loadLiveRoleSnapshot: mocks.loadLiveRoleSnapshot };
});

vi.mock('./api/warehouse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/warehouse')>();
  return { ...actual, fetchWarehouseInventory: mocks.fetchWarehouseInventory };
});

vi.mock('./api/liveContours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveContours')>();
  return {
    ...actual,
    isLiveContour: (role: string) => role === 'director',
  };
});

vi.mock('./features/director/useDirectorSupplementalObjects', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./features/director/useDirectorSupplementalObjects')>();
  const ready = { status: 'ready' as const, objects: [] };
  return {
    ...actual,
    useDirectorSupplementalObjects: () => ({
      byScope: { finance: ready, production: ready, warehouse: ready },
      retry: vi.fn(),
    }),
  };
});

vi.mock('./components/shell/actionToasts', () => ({
  actionToastTitle: (title: string) => title,
  operatorActionToast: vi.fn(),
  setupActionToastPosition: vi.fn(),
  showActionToast: vi.fn(),
}));

vi.mock('@siemens/ix-react', async () => {
  const host = forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children }, ref) =>
    createElement('div', { ref }, children),
  );
  return {
    IxApplication: host,
    IxEmptyState: host,
    IxMessageBar: host,
    IxPill: host,
  };
});

function directorSnapshot(): Extract<LiveRoleSnapshot, { role: 'director' }> {
  return {
    role: 'director',
    me: {
      userId: 'director-user',
      role: 'director',
      capabilities: ['director:read'],
      displayName: 'Директор',
      isActive: true,
      sessionPurpose: null,
      session: {
        id: 'director-session',
        purpose: 'office',
        state: 'active',
        createdAt: '2026-08-13T07:00:00.000Z',
        expiresAt: '2026-08-13T19:00:00.000Z',
        lastSeenAt: '2026-08-13T10:00:00.000Z',
      },
      workContext: { kind: 'office', assignment: null },
      passwordChangeRequired: false,
    },
    inbox: { items: [], nextCursor: null, unreadCount: 0 },
    control: {
      pendingDecisions: 0,
      penalties: 0,
      overdueOrders: 0,
      penaltiesAmount: 0,
      plannedInvoicedAmount: 0,
      paidAmount: 0,
      unbilledAmount: 0,
      overdueAmount: 0,
      producedKg: 0,
      defectKg: 0,
      warehouseAcceptedRolls: 0,
    },
    decisions: [],
    decisionObjects: [],
    penaltySnapshot: {
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    },
    penaltyFilters: {},
    penaltyTargets: [],
    problems: [],
  };
}

const directorBigBagPage: BigBagRegisterPage = {
  items: [
    {
      id: 'director-bag-1',
      code: 'BB-DIRECTOR-01',
      material: 'ПВД 10803-020',
      batch: null,
      createdAt: '2026-08-16T08:00:00.000Z',
      status: 'in_use',
      location: { kind: 'post', postCode: 'POST-2', postName: 'Экструдер 2' },
      operatorName: 'Анна Соколова',
      currentWeightKg: 320,
      totalKopecks: 800_000,
    },
  ],
  page: 1,
  pageSize: 25,
  total: 1,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installBrowser(href: string) {
  let currentUrl = new URL(href);
  const storage = new Map<string, string>();
  const history = {
    state: null,
    replaceState: vi.fn((state: unknown, _title: string, next?: string | URL | null) => {
      history.state = state as null;
      if (next !== undefined && next !== null) currentUrl = new URL(String(next), currentUrl);
    }),
  };
  const media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  vi.stubGlobal('document', {
    activeElement: null,
    hidden: false,
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  });
  vi.stubGlobal('window', {
    innerWidth: 1440,
    outerWidth: 1440,
    devicePixelRatio: 1,
    location: {
      get href() {
        return currentUrl.toString();
      },
      get search() {
        return currentUrl.search;
      },
      assign: vi.fn(),
    },
    history,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: vi.fn(() => media),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  });
}

async function renderApp(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('App director manual refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installBrowser(`http://localhost/?role=director&section=${encodeURIComponent('Аудит / QR')}`);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('loads once, stays idle in the background, and refreshes from the tab button', async () => {
    const pendingRefresh = deferred<Extract<LiveRoleSnapshot, { role: 'director' }>>();
    mocks.loadLiveRoleSnapshot
      .mockReset()
      .mockResolvedValueOnce(directorSnapshot())
      .mockReturnValueOnce(pendingRefresh.promise);

    const renderer = await renderApp();
    expect(mocks.loadLiveRoleSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.loadLiveRoleSnapshot).toHaveBeenCalledTimes(1);

    const refreshButton = renderer.root.findByProps({
      'aria-label': 'Обновить данные вкладки',
    });
    await act(async () => {
      refreshButton.props.onClick();
      await Promise.resolve();
    });

    expect(mocks.loadLiveRoleSnapshot).toHaveBeenCalledTimes(2);
    expect(
      renderer.root.findByProps({ 'aria-label': 'Обновить данные вкладки' }).props.disabled,
    ).toBe(true);

    await act(async () => {
      pendingRefresh.resolve(directorSnapshot());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root.findByProps({ 'aria-label': 'Обновить данные вкладки' }).props.disabled,
    ).toBe(false);

    renderer.unmount();
  });

  it('keeps the standalone raw-material tab to the shared search and register', async () => {
    installBrowser(`http://localhost/?role=director&section=${encodeURIComponent('Сырье')}`);
    mocks.loadLiveRoleSnapshot.mockReset().mockResolvedValue(directorSnapshot());
    mocks.fetchBigBagRegisterPage.mockReset().mockResolvedValue(directorBigBagPage);

    const renderer = await renderApp();

    expect(renderer.root.findAllByProps({ 'aria-label': 'Обновить данные вкладки' })).toHaveLength(
      0,
    );
    expect(renderer.root.findAllByProps({ 'aria-label': 'Реестр Big-Bag' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Поиск Big-Bag' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Сырье: складской учёт' })).toHaveLength(0);
    const register = renderer.root.findByProps({ 'aria-label': 'Реестр Big-Bag' });
    expect(register.findAllByType('th').map(nodeText)).toEqual([
      'Название Big-Bag',
      'Сырьё',
      'Дата создания',
      'Статус',
      'Оператор',
      'Текущий вес',
      'Денежный эквивалент',
    ]);
    expect(register.findAllByProps({ 'data-label': 'Оператор' }).map(nodeText)).toEqual([
      'Анна Соколова',
    ]);

    renderer.unmount();
  });

  it('routes the director all-rolls tab to the shared read-only warehouse registry', async () => {
    installBrowser(`http://localhost/?role=director&section=${encodeURIComponent('Все рулоны')}`);
    mocks.loadLiveRoleSnapshot.mockReset().mockResolvedValue(directorSnapshot());
    mocks.fetchWarehouseInventory.mockReset().mockResolvedValue({ items: [], nextCursor: null });

    const renderer = await renderApp();

    expect(renderer.root.findAllByProps({ className: 'warehouse-stock-workspace' })).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({
        className: 'list-panel warehouse-nav-only-panel warehouse-inventory-hub-page',
      }),
    ).toHaveLength(0);
    expect(renderer.root.findAllByType('th').map(nodeText)).toContain('Контрагент');
    expect(renderer.root.findAllByType('button').map(nodeText)).not.toContain('+ Добавить рулон');

    renderer.unmount();
  });
});
