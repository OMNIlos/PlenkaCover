import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  adminIncidentSelectionFromSearch,
  appendInboxPage,
  beginInboxRead,
  businessProblemSelectionFromSearch,
  createInboxState,
  LiveRefreshController,
  liveNotificationDestination,
  liveNotificationUrl,
  liveRoleLoadStateAfterError,
  mergeInboxFirstPage,
  productionProblemSelectionFromSearch,
  reconcileEquivalentSnapshot,
  reconcileLiveSelection,
  replaceLiveRoleNotifications,
  rollbackInboxRead,
  type LiveRefreshEnvironment,
  type LiveRefreshTask,
} from './liveRefresh';
import type { NotificationItem } from '../domain/types';
import type { RoleInboxPage } from './roleInbox';
import {
  normalizeWarehouseNotificationUrl,
  WAREHOUSE_STOCK_SECTION,
} from '../domain/warehouseSections';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createEnvironment() {
  let hidden = false;
  const focusListeners = new Set<() => void>();
  const visibilityListeners = new Set<() => void>();

  const environment: LiveRefreshEnvironment = {
    isHidden: () => hidden,
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) => globalThis.clearInterval(handle),
    addFocusListener: (listener) => focusListeners.add(listener),
    removeFocusListener: (listener) => focusListeners.delete(listener),
    addVisibilityListener: (listener) => visibilityListeners.add(listener),
    removeVisibilityListener: (listener) => visibilityListeners.delete(listener),
  };

  return {
    environment,
    setHidden(nextHidden: boolean) {
      hidden = nextHidden;
      visibilityListeners.forEach((listener) => listener());
    },
    focus() {
      focusListeners.forEach((listener) => listener());
    },
  };
}

function task<T>(load: LiveRefreshTask<T>['load'], apply: LiveRefreshTask<T>['apply']) {
  return { load, apply } satisfies LiveRefreshTask<T>;
}

describe('LiveRefreshController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads a manual task once and only refreshes it explicitly', async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    const setInterval = vi.spyOn(environment, 'setInterval');
    const addFocusListener = vi.spyOn(environment, 'addFocusListener');
    const addVisibilityListener = vi.spyOn(environment, 'addVisibilityListener');
    const load = vi.fn().mockResolvedValue({ version: 1 });
    const apply = vi.fn();
    const controller = new LiveRefreshController<{ version: number }>({
      environment,
      intervalMs: 5_000,
    });

    controller.start({ load, apply, automatic: false });
    await flushPromises();

    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ version: 1 });
    expect(setInterval).not.toHaveBeenCalled();
    expect(addFocusListener).not.toHaveBeenCalled();
    expect(addVisibilityListener).not.toHaveBeenCalled();

    controller.invalidateAndRefresh();
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('loads immediately and repeats every five seconds while visible', async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    const load = vi.fn().mockResolvedValue('fresh');
    const apply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(task(load, apply));
    expect(load).toHaveBeenCalledTimes(1);
    await flushPromises();
    expect(apply).toHaveBeenCalledWith('fresh');

    // Polls every fifteen seconds: a five-second cycle churned the workspace
    // often enough to read as flicker.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);

    controller.stop();
  });

  it('does not poll while hidden and refreshes immediately on focus or visibility restore', async () => {
    vi.useFakeTimers();
    const browser = createEnvironment();
    const load = vi.fn().mockResolvedValue('fresh');
    const controller = new LiveRefreshController<string>({ environment: browser.environment });

    controller.start(task(load, vi.fn()));
    await flushPromises();
    browser.setHidden(true);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(load).toHaveBeenCalledTimes(1);

    browser.focus();
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);

    browser.setHidden(false);
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);

    browser.focus();
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(3);

    controller.stop();
  });

  it('allows one in-flight load and collapses extra triggers into one trailing refresh', async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    const first = deferred<string>();
    const second = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const apply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(task(load, apply));
    controller.refresh();
    controller.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);

    first.resolve('first');
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith('first');

    second.resolve('second');
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith('second');

    controller.stop();
  });

  it('suppresses a result that resolves after stop', async () => {
    const { environment } = createEnvironment();
    const pending = deferred<string>();
    const apply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(task(() => pending.promise, apply));
    controller.stop();
    pending.resolve('stale');
    await flushPromises();

    expect(apply).not.toHaveBeenCalled();
  });

  it('contains a rejected load and keeps the next polling cycle alive', async () => {
    vi.useFakeTimers();
    const { environment } = createEnvironment();
    const failure = new Error('offline');
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('recovered');
    const apply = vi.fn();
    const onError = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start({ load, apply, onError });
    await flushPromises();
    expect(onError).toHaveBeenCalledWith(failure);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith('recovered');

    controller.stop();
  });

  it('switches generation without applying the previous role response', async () => {
    const { environment } = createEnvironment();
    const previousRole = deferred<string>();
    const nextRole = deferred<string>();
    const previousApply = vi.fn();
    const nextApply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(task(() => previousRole.promise, previousApply));
    controller.start(task(() => nextRole.promise, nextApply));

    previousRole.resolve('previous');
    await flushPromises();
    expect(previousApply).not.toHaveBeenCalled();

    nextRole.resolve('next');
    await flushPromises();
    expect(nextApply).toHaveBeenCalledWith('next');

    controller.stop();
  });

  it('invalidates an older in-flight snapshot before refreshing after a mutation', async () => {
    const { environment } = createEnvironment();
    const stale = deferred<string>();
    const confirmed = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(confirmed.promise);
    const apply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(task(load, apply));
    controller.invalidateAndRefresh();
    stale.resolve('stale-before-mutation');
    await flushPromises();

    expect(apply).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);

    confirmed.resolve('confirmed-after-mutation');
    await flushPromises();
    expect(apply).toHaveBeenCalledWith('confirmed-after-mutation');

    controller.stop();
  });

  it('aborts a stale role request and starts the replacement generation', async () => {
    const { environment } = createEnvironment();
    const observedSignals: AbortSignal[] = [];
    const previousApply = vi.fn();
    const nextApply = vi.fn();
    const controller = new LiveRefreshController<string>({ environment });

    controller.start(
      task(
        (signal) =>
          new Promise<string>((_resolve, reject) => {
            observedSignals.push(signal);
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
        previousApply,
      ),
    );
    controller.start(
      task((signal) => {
        observedSignals.push(signal);
        return Promise.resolve('next-role');
      }, nextApply),
    );
    await flushPromises();
    await flushPromises();

    expect(observedSignals[0]?.aborted).toBe(true);
    expect(previousApply).not.toHaveBeenCalled();
    expect(nextApply).toHaveBeenCalledWith('next-role');

    controller.stop();
  });
});

describe('reconcileEquivalentSnapshot', () => {
  it('preserves the current reference for equivalent server data and replaces changed data', () => {
    const current = [{ id: 'delivery-1', updatedAt: '2026-08-07T10:00:00.000Z' }];
    const equivalent = [{ id: 'delivery-1', updatedAt: '2026-08-07T10:00:00.000Z' }];
    const changed = [{ id: 'delivery-1', updatedAt: '2026-08-07T10:00:01.000Z' }];

    expect(reconcileEquivalentSnapshot(current, equivalent)).toBe(current);
    expect(reconcileEquivalentSnapshot(current, changed)).toBe(changed);
  });
});

describe('liveRoleLoadStateAfterError', () => {
  it('fails only before the first snapshot and keeps loaded data stale across repeated errors', () => {
    expect(liveRoleLoadStateAfterError(false)).toBe('failed');
    expect(liveRoleLoadStateAfterError(true)).toBe('stale');
    expect(liveRoleLoadStateAfterError(true)).toBe('stale');
  });
});

function notification(id: string, recipientRole: NotificationItem['recipientRole']) {
  return {
    id,
    recipientRole,
    severity: 'info',
    title: id,
    body: id,
    createdAt: '2026-07-15T10:00:00.000Z',
    requiresAck: false,
    sound: false,
  } satisfies NotificationItem;
}

describe('live role state reconciliation', () => {
  it('preserves an initial operator null when live rows arrive', () => {
    expect(reconcileLiveSelection(null, ['R-A17-01'], false, false)).toBeNull();
  });

  it('clears a disappeared selection when automatic selection is disabled', () => {
    expect(reconcileLiveSelection('gone', ['another-order'], true, false)).toBeNull();
    expect(reconcileLiveSelection('gone', ['another-order'], false, false)).toBeNull();
    expect(reconcileLiveSelection('present', ['present'], true, false)).toBe('present');
  });

  it('retains a present selection, preserves explicit null, and reconciles a disappeared id', () => {
    expect(reconcileLiveSelection('order-2', ['order-1', 'order-2'])).toBe('order-2');
    expect(reconcileLiveSelection(null, ['order-1'], false)).toBe('order-1');
    expect(reconcileLiveSelection(null, ['order-1'], true)).toBeNull();
    expect(reconcileLiveSelection('gone', ['order-1', 'order-2'])).toBe('order-1');
    expect(reconcileLiveSelection('gone', [])).toBeNull();
  });

  it('replaces only the refreshed live role page without accumulating duplicates', () => {
    const current = [
      notification('commercial-old', 'commercial'),
      notification('finance-kept', 'finance'),
    ];
    const incoming = [notification('commercial-new', 'commercial')];

    expect(replaceLiveRoleNotifications(current, 'commercial', incoming)).toEqual([
      current[1],
      incoming[0],
    ]);
    expect(replaceLiveRoleNotifications(current, 'commercial', incoming)).toHaveLength(2);
  });

  it('builds an in-place notification URL without dropping unrelated query state', () => {
    const url = liveNotificationUrl(
      'http://localhost:5173/workbench?role=finance&section=Обзор&debug=1',
      'production',
      { section: 'Заказ-наряды', objectId: 'order-1' },
    );

    expect(url.pathname).toBe('/workbench');
    expect(url.searchParams.get('role')).toBe('production');
    expect(url.searchParams.get('section')).toBe('Заказ-наряды');
    expect(url.searchParams.get('object')).toBe('order-1');
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('normalizes a warehouse stock CTA to rolls without stale filters or a blank route', () => {
    const navigation = {
      section: 'Запасы / резерв',
      objectId: 'WH-COVER-order-1',
    } as const;
    const legacyUrl = liveNotificationUrl(
      'http://localhost:5173/workbench?role=warehouse&section=Сырье&stockBucket=processed&view=processed&q=film&cursor=next&f.status=reserved&debug=1',
      'warehouse',
      navigation,
    );
    const url = normalizeWarehouseNotificationUrl(legacyUrl);

    expect(liveNotificationDestination('warehouse', navigation).section).toBe('Запасы / резерв');
    expect(url.searchParams.get('section')).toBe(WAREHOUSE_STOCK_SECTION);
    expect(url.searchParams.get('object')).toBe('WH-COVER-order-1');
    expect(url.searchParams.get('debug')).toBe('1');
    expect(url.searchParams.has('stockBucket')).toBe(false);
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(url.searchParams.has('f.status')).toBe(false);
  });

  it('builds the exact production-problem URL and destination', () => {
    const navigation = {
      kind: 'production_problem',
      section: 'Проблемы',
      problemId: 'problem-1',
      rollId: 'ROLL-1',
      orderId: 'order-1',
    } as const;
    const url = liveNotificationUrl(
      'http://localhost:5173/workbench?object=stale-order',
      'production',
      navigation,
    );

    expect(decodeURIComponent(url.search)).toBe(
      '?role=production&section=Проблемы&problem=problem-1&roll=ROLL-1',
    );
    expect(liveNotificationDestination('production', navigation)).toEqual({
      role: 'production',
      section: 'Проблемы',
      problemId: 'problem-1',
      rollId: 'ROLL-1',
      orderId: 'order-1',
      filter: 'Все',
      queueDateScope: 'all',
    });
  });

  it('restores a production-problem selection only from a complete problem/roll pair', () => {
    expect(
      productionProblemSelectionFromSearch(
        '?role=production&section=Проблемы&problem=problem-1&roll=ROLL-1',
      ),
    ).toEqual({ problemId: 'problem-1', rollId: 'ROLL-1' });
    expect(productionProblemSelectionFromSearch('?problem=problem-1')).toBeNull();
    expect(productionProblemSelectionFromSearch('?roll=ROLL-1')).toBeNull();
  });

  it.each(['commercial', 'director'] as const)(
    'builds and restores an office-only exact problem URL for %s without production roll state',
    (role) => {
      const url = liveNotificationUrl(
        'http://localhost:5173/workbench?role=production&problem=old&roll=ROLL-OLD',
        role,
        {
          kind: 'production_problem',
          section: 'Проблемы',
          problemId: 'problem-office',
          rollId: 'ROLL-18',
        },
      );

      expect(decodeURIComponent(url.search)).toBe(
        `?role=${role}&section=Проблемы&problem=problem-office`,
      );
      expect(url.searchParams.has('roll')).toBe(false);
      expect(businessProblemSelectionFromSearch(url.search, role)).toBe('problem-office');
      expect(
        businessProblemSelectionFromSearch(
          url.search,
          role === 'commercial' ? 'director' : 'commercial',
        ),
      ).toBeNull();
      expect(productionProblemSelectionFromSearch(url.search)).toBeNull();
    },
  );

  it('opens a Control CTA in a visible unfiltered queue state', () => {
    expect(
      liveNotificationDestination('production', {
        section: 'Заказ-наряды',
        objectId: 'order-1',
      }),
    ).toEqual({
      role: 'production',
      section: 'Заказ-наряды',
      objectId: 'order-1',
      filter: 'Все',
      queueDateScope: 'all',
    });
  });

  it('clears object selection for an informational operator queue CTA', () => {
    const navigation = {
      kind: 'operator_queue',
      section: 'Рулоны и заказы',
    } as const;
    const url = liveNotificationUrl(
      'http://localhost:5173/?role=operator&section=Переданы+на+склад&object=ROLL-FOREIGN',
      'operator',
      navigation,
    );

    expect(url.searchParams.get('section')).toBe('Рулоны и заказы');
    expect(url.searchParams.has('object')).toBe(false);
    expect(liveNotificationDestination('operator', navigation)).toEqual({
      role: 'operator',
      section: 'Рулоны и заказы',
      clearSelection: true,
      filter: 'Все',
      queueDateScope: 'all',
    });
  });

  it('writes and restores the exact administrator incident URL', () => {
    const navigation = {
      kind: 'admin_incident',
      section: 'Инциденты',
      incidentId: 'incident-17',
    } as const;
    const url = liveNotificationUrl(
      'http://localhost:5173/?role=admin&section=Устройства&object=device-old',
      'admin',
      navigation,
    );

    expect(decodeURIComponent(url.search)).toBe(
      '?role=admin&section=Инциденты&incident=incident-17',
    );
    expect(liveNotificationDestination('admin', navigation)).toEqual({
      role: 'admin',
      section: 'Инциденты',
      incidentId: 'incident-17',
      filter: 'Все',
      queueDateScope: 'all',
    });
    expect(adminIncidentSelectionFromSearch(url.search)).toBe('incident-17');
    expect(adminIncidentSelectionFromSearch('?role=admin&section=Инциденты')).toBeNull();
  });
});

function inboxPage(
  ids: string[],
  {
    nextCursor = null,
    unreadCount = ids.length,
    readIds = [],
  }: {
    nextCursor?: string | null;
    unreadCount?: number;
    readIds?: string[];
  } = {},
): RoleInboxPage {
  const read = new Set(readIds);
  return {
    items: ids.map((id) => ({
      ...notification(id, 'operator'),
      ...(read.has(id) ? { readAt: `read:${id}` } : {}),
    })),
    nextCursor,
    unreadCount,
  };
}

describe('paginated inbox state', () => {
  it('keeps the complete server unread total when only the first 20 cards are loaded', () => {
    const state = createInboxState(
      inboxPage(
        Array.from({ length: 20 }, (_, index) => `event-${index + 1}`),
        { nextCursor: 'cursor-A', unreadCount: 37 },
      ),
    );

    expect(state.items).toHaveLength(20);
    expect(state.unreadCount).toBe(37);
    expect(state.nextCursor).toBe('cursor-A');
    expect(state.loadingMore).toBe(false);
  });

  it('merges a periodic first page by id, updates read state, and preserves older history/frontier', () => {
    const current = createInboxState(
      inboxPage(['newest', 'boundary', 'older'], {
        nextCursor: 'cursor-B',
        unreadCount: 3,
      }),
    );
    const refreshed = mergeInboxFirstPage(
      current,
      inboxPage(['brand-new', 'newest', 'boundary'], {
        nextCursor: 'cursor-A-new',
        unreadCount: 2,
        readIds: ['boundary'],
      }),
      { preserveCursor: true },
    );

    expect(refreshed.items.map((item) => item.id)).toEqual([
      'brand-new',
      'newest',
      'boundary',
      'older',
    ]);
    expect(refreshed.items.find((item) => item.id === 'boundary')?.readAt).toBe('read:boundary');
    expect(refreshed.nextCursor).toBe('cursor-B');
    expect(refreshed.unreadCount).toBe(2);
  });

  it('appends older cards once and rejects direct and indirect cursor cycles', () => {
    const first = createInboxState(
      inboxPage(['newest', 'boundary'], {
        nextCursor: 'cursor-A',
        unreadCount: 4,
      }),
    );
    const second = appendInboxPage(
      first,
      inboxPage(['boundary', 'older-1'], {
        nextCursor: 'cursor-B',
        unreadCount: 4,
      }),
      {
        requestedCursor: 'cursor-A',
        requestedCursors: new Set(['cursor-A']),
      },
    );

    expect(second.items.map((item) => item.id)).toEqual(['newest', 'boundary', 'older-1']);
    expect(second.nextCursor).toBe('cursor-B');

    const indirectCycle = appendInboxPage(
      second,
      inboxPage(['older-2'], {
        nextCursor: 'cursor-A',
        unreadCount: 4,
      }),
      {
        requestedCursor: 'cursor-B',
        requestedCursors: new Set(['cursor-A', 'cursor-B']),
      },
    );
    expect(indirectCycle.items.map((item) => item.id)).toEqual([
      'newest',
      'boundary',
      'older-1',
      'older-2',
    ]);
    expect(indirectCycle.nextCursor).toBeNull();

    const directCycle = appendInboxPage(
      first,
      inboxPage(['older-1'], {
        nextCursor: 'cursor-A',
        unreadCount: 4,
      }),
      {
        requestedCursor: 'cursor-A',
        requestedCursors: new Set(['cursor-A']),
      },
    );
    expect(directCycle.nextCursor).toBeNull();
  });

  it('decrements optimistically once and rolls back only its own stale marker', () => {
    const initial = createInboxState(
      inboxPage(['event-1'], {
        unreadCount: 37,
      }),
    );
    const first = beginInboxRead(initial, 'event-1', 'optimistic:event-1');
    const duplicate = beginInboxRead(first.state, 'event-1', 'optimistic:duplicate');

    expect(first.pending).toBeTruthy();
    expect(first.state.unreadCount).toBe(36);
    expect(duplicate.pending).toBeNull();
    expect(duplicate.state.unreadCount).toBe(36);

    const serverConfirmed = mergeInboxFirstPage(
      first.state,
      inboxPage(['event-1'], { unreadCount: 36, readIds: ['event-1'] }),
      { pendingReads: first.pending ? [first.pending] : [] },
    );
    expect(rollbackInboxRead(serverConfirmed, first.pending!)).toEqual(serverConfirmed);

    const stalePoll = mergeInboxFirstPage(
      first.state,
      inboxPage(['event-1'], { unreadCount: 37 }),
      { pendingReads: first.pending ? [first.pending] : [] },
    );
    expect(stalePoll.unreadCount).toBe(36);
    expect(rollbackInboxRead(stalePoll, first.pending!)).toMatchObject({
      unreadCount: 37,
      items: [expect.objectContaining({ id: 'event-1', readAt: undefined })],
    });
  });
});
