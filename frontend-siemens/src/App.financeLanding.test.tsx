import { createElement, forwardRef, type ReactNode } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveRoleSnapshot } from './api/liveRoleSnapshot';
import { FinanceWorkbench } from './components/workbenches/FinanceWorkbench';
import { financeWorkObjects } from './domain/fixtures/finance';
import App from './App';

const mocks = vi.hoisted(() => ({
  loadLiveRoleSnapshot: vi.fn(),
}));

vi.mock('./api/liveRoleSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveRoleSnapshot')>();
  return { ...actual, loadLiveRoleSnapshot: mocks.loadLiveRoleSnapshot };
});

vi.mock('./api/liveContours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveContours')>();
  return {
    ...actual,
    isLiveContour: (role: string) => role === 'finance',
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

function financeSnapshot(): Extract<LiveRoleSnapshot, { role: 'finance' }> {
  return {
    role: 'finance',
    me: {
      userId: 'finance-user',
      role: 'finance',
      capabilities: ['finance:read'],
      displayName: 'Бухгалтер',
      isActive: true,
      sessionPurpose: null,
      session: {
        id: 'finance-session',
        purpose: 'office',
        state: 'active',
        createdAt: '2026-08-11T07:00:00.000Z',
        expiresAt: '2026-08-11T19:00:00.000Z',
        lastSeenAt: '2026-08-11T10:00:00.000Z',
      },
      workContext: { kind: 'office', assignment: null },
      passwordChangeRequired: false,
    },
    inbox: { items: [], nextCursor: null, unreadCount: 0 },
    orders: financeWorkObjects.slice(0, 2).map((object) => ({
      ...object,
      warehouseCoverageWorkflowVersion: 1,
    })),
  };
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
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
  });
  vi.stubGlobal('window', {
    innerWidth: 1440,
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

  return { href: () => currentUrl.toString() };
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

describe('App finance landing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.loadLiveRoleSnapshot.mockReset().mockResolvedValue(financeSnapshot());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each(['direct link', 'refresh'])(
    'clears a deleted invoice after %s without opening another',
    async (scenario) => {
      const snapshot = financeSnapshot();
      const deletedId = snapshot.orders[0].id;
      const afterDeletion = { ...snapshot, orders: snapshot.orders.slice(1) };
      mocks.loadLiveRoleSnapshot.mockResolvedValue(
        scenario === 'direct link' ? afterDeletion : snapshot,
      );
      const browser = installBrowser(
        'http://localhost/?role=finance&section=' +
          encodeURIComponent('Счета') +
          '&object=' +
          deletedId,
      );
      const renderer = await renderApp();
      if (scenario === 'refresh') {
        mocks.loadLiveRoleSnapshot.mockResolvedValue(afterDeletion);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
      }
      expect(renderer.root.findByType(FinanceWorkbench).props.isRegistryPage).toBe(true);
      expect(renderer.root.findAllByProps({ className: 'detail-header' })).toHaveLength(0);
      expect(new URL(browser.href()).searchParams.get('object')).toBeNull();
      renderer.unmount();
    },
  );

  it('keeps the live invoice landing unselected when orders first arrive', async () => {
    installBrowser(`http://localhost/?role=finance&section=${encodeURIComponent('Счета')}`);

    const renderer = await renderApp();
    const workbench = renderer.root.findByType(FinanceWorkbench);

    expect(workbench.props.isRegistryPage).toBe(true);
    expect(renderer.root.findAllByProps({ 'aria-label': 'Финансовые дела заказов' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ className: 'detail-header' })).toHaveLength(0);
    renderer.unmount();
  });

  it('opens one invoice without a duplicate queue and returns explicitly to the registry', async () => {
    const objectId = financeSnapshot().orders[0].id;
    const browser = installBrowser(
      `http://localhost/?role=finance&section=${encodeURIComponent('Счета')}&object=${encodeURIComponent(objectId)}`,
    );

    const renderer = await renderApp();
    expect(renderer.root.findByType(FinanceWorkbench).props.isRegistryPage).toBe(false);
    expect(
      renderer.root.findAll(
        (node) => node.type === 'section' && String(node.props.className).includes('list-panel'),
      ),
    ).toHaveLength(0);

    const backButton = renderer.root
      .findAllByType('button')
      .find((item) => nodeText(item) === 'К списку счетов');
    expect(backButton).toBeDefined();
    await act(async () => {
      backButton?.props.onClick();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(FinanceWorkbench).props.isRegistryPage).toBe(true);
    expect(new URL(browser.href()).searchParams.get('object')).toBeNull();
    renderer.unmount();
  });

  it('opens a paid invoice selected from the full registry outside the active queue', async () => {
    const snapshot = financeSnapshot();
    const paidOrder = {
      ...snapshot.orders[1],
      id: 'finance-paid-outside-queue',
      statusLabel: 'Оплачено',
      facts: snapshot.orders[1].facts.map((fact) =>
        fact.label === 'Статус оплаты' ? { ...fact, value: 'Оплачено' } : fact,
      ),
    };
    mocks.loadLiveRoleSnapshot.mockResolvedValue({
      ...snapshot,
      orders: [snapshot.orders[0], paidOrder],
    });
    const browser = installBrowser(
      `http://localhost/?role=finance&section=${encodeURIComponent('Счета')}`,
    );

    const renderer = await renderApp();
    await act(async () => {
      renderer.root.findByProps({ 'data-object-id': paidOrder.id }).props.onClick();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(FinanceWorkbench).props.object.id).toBe(paidOrder.id);
    expect(new URL(browser.href()).searchParams.get('object')).toBe(paidOrder.id);
    renderer.unmount();
  });

  it('switches into finance on the unselected invoice registry', async () => {
    installBrowser('http://localhost/?role=commercial');
    const renderer = await renderApp();
    const financeRoleButton = renderer.root
      .findAllByType('button')
      .find(
        (item) =>
          String(item.props.className).includes('demo-role-button') &&
          nodeText(item).startsWith('Бухгалтерия'),
      );
    expect(financeRoleButton).toBeDefined();

    await act(async () => {
      financeRoleButton?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(FinanceWorkbench).props.isRegistryPage).toBe(true);
    expect(renderer.root.findAllByProps({ className: 'detail-header' })).toHaveLength(0);
    renderer.unmount();
  });
});
