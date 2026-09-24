import { createElement, forwardRef, type ReactNode } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BigBagRegisterPage } from './api/bigBagRegister';
import App from './App';

const mocks = vi.hoisted(() => ({
  fetchBigBagRegisterPage: vi.fn(),
}));

vi.mock('./api/bigBagRegister', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/bigBagRegister')>();
  return { ...actual, fetchBigBagRegisterPage: mocks.fetchBigBagRegisterPage };
});

vi.mock('./api/liveContours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveContours')>();
  return { ...actual, isLiveContour: () => false };
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

const bigBagPage: BigBagRegisterPage = {
  items: [
    {
      id: 'bag-route-1',
      code: 'BB-ROUTE-01',
      material: 'ПВД 15803-020',
      batch: 'ROUTE-77',
      createdAt: '2026-08-13T10:00:00.000Z',
      status: 'available',
      location: { kind: 'warehouse', postCode: null, postName: null },
      operatorName: null,
      currentWeightKg: 450,
      totalKopecks: 1_125_000,
    },
  ],
  page: 1,
  pageSize: 25,
  total: 1,
};

const emptyBigBagPage: BigBagRegisterPage = {
  ...bigBagPage,
  items: [],
  total: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
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

describe('App production raw-material BigBag route', () => {
  beforeEach(() => {
    installBrowser(`http://localhost/?role=production&section=${encodeURIComponent('Сырье')}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows the shared register loading state on the real route', async () => {
    const pending = deferred<BigBagRegisterPage>();
    mocks.fetchBigBagRegisterPage.mockReturnValue(pending.promise);

    const renderer = await renderApp();

    expect(nodeText(renderer.root)).toContain('Загружаем Big-Bag…');
    expect(renderer.root.findAllByProps({ 'aria-label': 'Реестр Big-Bag' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Big-Bag в производстве' })).toHaveLength(
      0,
    );
    renderer.unmount();
  });

  it('shows the shared empty state on the real route', async () => {
    mocks.fetchBigBagRegisterPage.mockResolvedValue(emptyBigBagPage);

    const renderer = await renderApp();

    expect(nodeText(renderer.root)).toContain('Big-Bag не найдены.');
    renderer.unmount();
  });

  it('shows the shared error state on the real route', async () => {
    mocks.fetchBigBagRegisterPage.mockRejectedValue(new Error('Big-Bag unavailable'));

    const renderer = await renderApp();

    expect(nodeText(renderer.root)).toContain('Не удалось загрузить Big-Bag.');
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Повторить загрузку Big-Bag' }),
    ).toHaveLength(1);
    renderer.unmount();
  });

  it('renders only the requested Big-Bag facts from the shared endpoint', async () => {
    mocks.fetchBigBagRegisterPage.mockResolvedValue(bigBagPage);

    const renderer = await renderApp();

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
    expect(nodeText(register)).toContain('BB-ROUTE-01');
    expect(nodeText(register)).toContain('ПВД 15803-020');
    expect(nodeText(register)).toContain('На складе');
    expect(register.findAllByProps({ 'data-label': 'Оператор' }).map(nodeText)).toEqual(['—']);
    expect(nodeText(register)).toContain('450 кг');
    expect(nodeText(register)).toContain('11 250,00 ₽');
    expect(nodeText(register)).not.toMatch(/Партия|Где находится/u);
    expect(mocks.fetchBigBagRegisterPage).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
