import type { NotificationItem, Role } from '../domain/types';
import type { RoleInboxPage } from './roleInbox';

export type LiveRefreshTask<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  apply: (value: T) => void;
  onError?: (error: unknown) => void;
  automatic?: boolean;
};

export type InboxState = {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
  loadingMore: boolean;
};

export type PendingInboxRead = {
  eventId: string;
  optimisticReadAt: string;
  previousReadAt: string | undefined;
  countedUnread: boolean;
};

export type InboxLoadMoreRequest = {
  generation: number;
  requestId: number;
  signal: AbortSignal;
};

type InboxMergeOptions = {
  pendingReads?: readonly PendingInboxRead[];
};

type FirstPageMergeOptions = InboxMergeOptions & {
  preserveCursor?: boolean;
};

type OlderPageMergeOptions = InboxMergeOptions & {
  requestedCursor: string;
  requestedCursors: ReadonlySet<string>;
};

type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

export type LiveRefreshEnvironment = {
  isHidden: () => boolean;
  setInterval: (callback: () => void, delayMs: number) => IntervalHandle;
  clearInterval: (handle: IntervalHandle) => void;
  addFocusListener: (listener: () => void) => void;
  removeFocusListener: (listener: () => void) => void;
  addVisibilityListener: (listener: () => void) => void;
  removeVisibilityListener: (listener: () => void) => void;
};

type LiveRefreshOptions = {
  environment?: LiveRefreshEnvironment;
  intervalMs?: number;
};

export function reconcileLiveSelection(
  selectedId: string | null,
  availableIds: readonly string[],
  initialized = true,
  selectFirst = true,
) {
  if (selectedId === null) {
    return initialized || !selectFirst ? null : (availableIds[0] ?? null);
  }
  return availableIds.includes(selectedId)
    ? selectedId
    : selectFirst
      ? (availableIds[0] ?? null)
      : null;
}

export function reconcileEquivalentSnapshot<T>(current: T, incoming: T): T {
  if (Object.is(current, incoming)) return current;
  try {
    return JSON.stringify(current) === JSON.stringify(incoming) ? current : incoming;
  } catch {
    return incoming;
  }
}

export function liveRoleLoadStateAfterError(
  hasLoadedSnapshot: boolean,
): 'stale' | 'failed' {
  return hasLoadedSnapshot ? 'stale' : 'failed';
}

export function replaceLiveRoleNotifications(
  current: readonly NotificationItem[],
  role: Role,
  incoming: readonly NotificationItem[],
) {
  return [...current.filter((notification) => notification.recipientRole !== role), ...incoming];
}

function mergeNotificationItems(
  primary: readonly NotificationItem[],
  secondary: readonly NotificationItem[],
) {
  const seen = new Set<string>();
  const merged: NotificationItem[] = [];
  for (const item of [...primary, ...secondary]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function applyPendingReads(
  items: readonly NotificationItem[],
  unreadCount: number,
  pendingReads: readonly PendingInboxRead[],
) {
  if (pendingReads.length === 0) {
    return { items: [...items], unreadCount };
  }
  const pendingById = new Map(pendingReads.map((pending) => [pending.eventId, pending]));
  let optimisticUnread = 0;
  const projected = items.map((item) => {
    const pending = pendingById.get(item.id);
    if (!pending || !pending.countedUnread) return item;
    if (item.readAt && item.readAt !== pending.optimisticReadAt) return item;
    optimisticUnread += 1;
    return item.readAt === pending.optimisticReadAt
      ? item
      : { ...item, readAt: pending.optimisticReadAt };
  });
  return {
    items: projected,
    unreadCount: Math.max(0, unreadCount - optimisticUnread),
  };
}

export function createInboxState(page?: RoleInboxPage): InboxState {
  return {
    items: page ? [...page.items] : [],
    nextCursor: page?.nextCursor ?? null,
    unreadCount: page?.unreadCount ?? 0,
    loadingMore: false,
  };
}

export class InboxRequestFrontier {
  private generation = 0;
  private requestId = 0;
  private loadMoreController: AbortController | null = null;

  advanceFirstPage() {
    this.generation += 1;
    this.requestId += 1;
    this.loadMoreController?.abort();
    this.loadMoreController = null;
  }

  beginLoadMore(): InboxLoadMoreRequest {
    this.loadMoreController?.abort();
    const controller = new AbortController();
    this.loadMoreController = controller;
    this.requestId += 1;
    return {
      generation: this.generation,
      requestId: this.requestId,
      signal: controller.signal,
    };
  }

  isCurrent(request: InboxLoadMoreRequest) {
    return (
      request.generation === this.generation &&
      request.requestId === this.requestId &&
      !request.signal.aborted
    );
  }

  finishLoadMore(request: InboxLoadMoreRequest) {
    if (!this.isCurrent(request)) return false;
    this.loadMoreController = null;
    return true;
  }

  invalidate() {
    this.advanceFirstPage();
  }
}

export function mergeInboxFirstPage(
  current: InboxState,
  page: RoleInboxPage,
  { preserveCursor = false, pendingReads = [] }: FirstPageMergeOptions = {},
): InboxState {
  const merged = mergeNotificationItems(page.items, current.items);
  const projected = applyPendingReads(merged, page.unreadCount, pendingReads);
  return {
    ...projected,
    nextCursor: preserveCursor ? current.nextCursor : page.nextCursor,
    loadingMore: false,
  };
}

export function appendInboxPage(
  current: InboxState,
  page: RoleInboxPage,
  { requestedCursor, requestedCursors, pendingReads = [] }: OlderPageMergeOptions,
): InboxState {
  const merged = mergeNotificationItems(current.items, page.items);
  const projected = applyPendingReads(merged, page.unreadCount, pendingReads);
  const nextCursor =
    page.nextCursor && page.nextCursor !== requestedCursor && !requestedCursors.has(page.nextCursor)
      ? page.nextCursor
      : null;
  return {
    ...projected,
    nextCursor,
    loadingMore: false,
  };
}

export function beginInboxRead(
  current: InboxState,
  eventId: string,
  optimisticReadAt: string,
): { state: InboxState; pending: PendingInboxRead | null } {
  const target = current.items.find((item) => item.id === eventId);
  if (!target || target.readAt) return { state: current, pending: null };
  const pending: PendingInboxRead = {
    eventId,
    optimisticReadAt,
    previousReadAt: target.readAt,
    countedUnread: true,
  };
  return {
    state: {
      ...current,
      items: current.items.map((item) =>
        item.id === eventId ? { ...item, readAt: optimisticReadAt } : item,
      ),
      unreadCount: Math.max(0, current.unreadCount - 1),
    },
    pending,
  };
}

export function rollbackInboxRead(current: InboxState, pending: PendingInboxRead): InboxState {
  const target = current.items.find((item) => item.id === pending.eventId);
  if (!target || target.readAt !== pending.optimisticReadAt) return current;
  return {
    ...current,
    items: current.items.map((item) =>
      item.id === pending.eventId ? { ...item, readAt: pending.previousReadAt } : item,
    ),
    unreadCount: pending.countedUnread ? current.unreadCount + 1 : current.unreadCount,
  };
}

export function liveNotificationUrl(
  currentHref: string,
  role: Role,
  navigation: NonNullable<NotificationItem['navigation']>,
) {
  const url = new URL(currentHref);
  url.searchParams.delete('object');
  url.searchParams.delete('problem');
  url.searchParams.delete('roll');
  url.searchParams.delete('incident');
  url.searchParams.set('role', role);
  url.searchParams.set('section', navigation.section);
  if (navigation.kind === 'production_problem') {
    url.searchParams.set('problem', navigation.problemId);
    if (role === 'production') url.searchParams.set('roll', navigation.rollId);
  } else if (navigation.kind === 'admin_incident') {
    url.searchParams.set('incident', navigation.incidentId);
  } else if (navigation.kind !== 'operator_queue') {
    url.searchParams.set('object', navigation.objectId);
  }
  return url;
}

export function liveNotificationDestination(
  role: Role,
  navigation: NonNullable<NotificationItem['navigation']>,
) {
  if (navigation.kind === 'production_problem') {
    return {
      role,
      section: navigation.section,
      problemId: navigation.problemId,
      rollId: navigation.rollId,
      ...(navigation.orderId ? { orderId: navigation.orderId } : {}),
      filter: 'Все' as const,
      queueDateScope: 'all' as const,
    };
  }
  if (navigation.kind === 'operator_queue') {
    return {
      role,
      section: navigation.section,
      clearSelection: true,
      filter: 'Все' as const,
      queueDateScope: 'all' as const,
    };
  }
  if (navigation.kind === 'admin_incident') {
    return {
      role,
      section: navigation.section,
      incidentId: navigation.incidentId,
      filter: 'Все' as const,
      queueDateScope: 'all' as const,
    };
  }
  return {
    role,
    section: navigation.section,
    objectId: navigation.objectId,
    filter: 'Все' as const,
    queueDateScope: 'all' as const,
  };
}

export function adminIncidentSelectionFromSearch(search: string) {
  return new URLSearchParams(search).get('incident');
}

export function productionProblemSelectionFromSearch(search: string) {
  const query = new URLSearchParams(search);
  const problemId = query.get('problem');
  const rollId = query.get('roll');
  return problemId && rollId ? { problemId, rollId } : null;
}

export function businessProblemSelectionFromSearch(
  search: string,
  role: 'commercial' | 'director',
) {
  const query = new URLSearchParams(search);
  if (query.get('role') !== role || query.get('section') !== 'Проблемы') return null;
  const problemId = query.get('problem')?.trim();
  return problemId || null;
}

function browserEnvironment(): LiveRefreshEnvironment {
  return {
    isHidden: () => (typeof document === 'undefined' ? false : document.hidden),
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) => globalThis.clearInterval(handle),
    addFocusListener: (listener) => globalThis.window?.addEventListener('focus', listener),
    removeFocusListener: (listener) => globalThis.window?.removeEventListener('focus', listener),
    addVisibilityListener: (listener) =>
      globalThis.document?.addEventListener('visibilitychange', listener),
    removeVisibilityListener: (listener) =>
      globalThis.document?.removeEventListener('visibilitychange', listener),
  };
}

export class LiveRefreshController<T> {
  private readonly environment: LiveRefreshEnvironment;
  private readonly intervalMs: number;
  private task: LiveRefreshTask<T> | null = null;
  private intervalHandle: IntervalHandle | null = null;
  private active = false;
  private inFlight = false;
  private trailing = false;
  private generation = 0;
  private inFlightController: AbortController | null = null;
  private automaticScheduling = false;

  constructor({
    environment = browserEnvironment(),
    // Fifteen seconds: a five-second cycle re-applied the whole role snapshot
    // often enough that the workspace visibly churned.
    intervalMs = 15_000,
  }: LiveRefreshOptions = {}) {
    this.environment = environment;
    this.intervalMs = intervalMs;
  }

  start(task: LiveRefreshTask<T>) {
    this.generation += 1;
    this.task = task;
    this.trailing = false;

    if (!this.active) {
      this.active = true;
    }
    this.configureAutomaticScheduling(task.automatic !== false);

    if (this.inFlight) {
      this.trailing = true;
      this.inFlightController?.abort();
      return;
    }
    this.refresh();
  }

  refresh() {
    if (!this.active || !this.task) return;
    if (this.inFlight) {
      this.trailing = true;
      return;
    }

    void this.run(this.task, this.generation);
  }

  invalidateAndRefresh() {
    if (!this.active || !this.task) return;
    this.generation += 1;
    if (this.inFlight) {
      this.trailing = true;
      this.inFlightController?.abort();
      return;
    }
    this.refresh();
  }

  stop() {
    this.active = false;
    this.generation += 1;
    this.task = null;
    this.trailing = false;
    this.inFlightController?.abort();
    this.configureAutomaticScheduling(false);
  }

  private configureAutomaticScheduling(enabled: boolean) {
    if (enabled === this.automaticScheduling) return;
    this.automaticScheduling = enabled;

    if (enabled) {
      this.intervalHandle = this.environment.setInterval(this.onInterval, this.intervalMs);
      this.environment.addFocusListener(this.onFocus);
      this.environment.addVisibilityListener(this.onVisibilityChange);
      return;
    }
    if (this.intervalHandle !== null) {
      this.environment.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.environment.removeFocusListener(this.onFocus);
    this.environment.removeVisibilityListener(this.onVisibilityChange);
  }

  private readonly onInterval = () => {
    if (!this.environment.isHidden()) this.refresh();
  };

  private readonly onFocus = () => {
    if (!this.environment.isHidden()) this.refresh();
  };

  private readonly onVisibilityChange = () => {
    if (!this.environment.isHidden()) this.refresh();
  };

  private async run(task: LiveRefreshTask<T>, generation: number) {
    this.inFlight = true;
    const controller = new AbortController();
    this.inFlightController = controller;
    try {
      const value = await task.load(controller.signal);
      if (this.active && generation === this.generation) task.apply(value);
    } catch (error) {
      if (!controller.signal.aborted && this.active && generation === this.generation) {
        task.onError?.(error);
      }
    } finally {
      if (this.inFlightController === controller) this.inFlightController = null;
      this.inFlight = false;
      if (!this.active || !this.trailing) return;
      this.trailing = false;
      this.refresh();
    }
  }
}
