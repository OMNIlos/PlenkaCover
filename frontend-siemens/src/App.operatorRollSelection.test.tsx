import { createElement, forwardRef, type ReactNode } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveRoleSnapshot } from './api/liveRoleSnapshot';
import { ApiError, ApiResponseParseError } from './api/client';
import { saveSession } from './api/authStorage';
import { LiveRefreshController } from './api/liveRefresh';
import { OperatorRollsHubSurface } from './components/workbenches/OperatorRollsHubSurface';
import { OperatorShiftSurface } from './components/workbenches/operatorWorkbench';
import { RoleTopNavigation } from './components/shell/appShell';
import { DetailView } from './components/shell/workObjectSurfaces';
import { initialOperatorRuntime } from './domain/operatorRuntime';
import App from './App';

const mocks = vi.hoisted(() => ({
  closeOperatorShift: vi.fn(),
  fetchCounterpartyTemplates: vi.fn(),
  fetchOperatorOrderMass: vi.fn(),
  fetchRoleInbox: vi.fn(),
  handoverOperatorRoll: vi.fn(),
  loadLiveRoleSnapshot: vi.fn(),
  reweighOperatorRoll: vi.fn(),
  reportOperatorMachineBreakdown: vi.fn(),
  verifyAndHandoverOperatorQr: vi.fn(),
}));

vi.mock('./api/liveRoleSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveRoleSnapshot')>();
  return { ...actual, loadLiveRoleSnapshot: mocks.loadLiveRoleSnapshot };
});

vi.mock('./api/liveContours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveContours')>();
  return {
    ...actual,
    isLiveContour: (role: string) => role === 'operator',
  };
});

vi.mock('./api/commercial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/commercial')>();
  return { ...actual, fetchCounterpartyTemplates: mocks.fetchCounterpartyTemplates };
});

vi.mock('./api/roleInbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/roleInbox')>();
  return { ...actual, fetchRoleInbox: mocks.fetchRoleInbox };
});

vi.mock('./api/operator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/operator')>();
  return {
    ...actual,
    closeOperatorShift: mocks.closeOperatorShift,
    fetchOperatorOrderMass: mocks.fetchOperatorOrderMass,
    handoverOperatorRoll: mocks.handoverOperatorRoll,
    reweighOperatorRoll: mocks.reweighOperatorRoll,
    reportOperatorMachineBreakdown: mocks.reportOperatorMachineBreakdown,
    verifyAndHandoverOperatorQr: mocks.verifyAndHandoverOperatorQr,
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

const serverCurrentRollId = 'A-3-roll-2';
const selectedRollId = 'A-3-roll-3';

function shiftCloseResult(shiftId: string) {
  return {
    balance: {
      producedKg: 62.8,
      defectKg: 0,
      expectedUsageKg: 62.8,
      actualUsageKg: 62.8,
      deviationPercent: 0,
      status: 'ok',
    },
    problemId: null,
    releasedRollIds: [],
    closingPayroll: {
      sessionId: 'session-1',
      shiftId,
      status: 'complete',
      summary: {
        payableAmountKopecks: 0,
        payableKg: 0,
        machineShiftCount: 1,
        unresolvedKg: 0,
        unresolvedFactCount: 0,
        excludedDefectKg: 0,
        excludedDefectRollCount: 0,
      },
      breakdown: [],
      unresolved: [],
    },
  };
}

function operatorSnapshot({
  selectedRollStatus = 'assigned',
}: {
  selectedRollStatus?: 'assigned' | 'qr_check';
} = {}): Extract<LiveRoleSnapshot, { role: 'operator' }> {
  const sourceOrder = initialOperatorRuntime.orders[0];
  const sourceCurrentRoll = sourceOrder.rolls[0];
  const sourceSelectedRoll = sourceOrder.rolls[1];
  const serverCurrentRoll = {
    ...sourceCurrentRoll,
    id: serverCurrentRollId,
    dispatchItemId: 'dispatch-a-3-roll-2',
    sequenceNumber: 2,
    status: 'handover',
    labelState: 'verified' as const,
    warehouseState: 'not_ready' as const,
  };
  const selectedRoll = {
    ...sourceSelectedRoll,
    id: selectedRollId,
    dispatchItemId: 'dispatch-a-3-roll-3',
    sequenceNumber: 3,
    status: selectedRollStatus,
    labelState:
      selectedRollStatus === 'qr_check' ? ('submitted' as const) : ('not_printed' as const),
    warehouseState: 'not_ready' as const,
  };

  return {
    role: 'operator',
    me: {
      userId: 'operator-ruslan',
      role: 'operator',
      capabilities: ['operator:read'],
      displayName: 'Хабибулин Руслан',
      isActive: true,
      sessionPurpose: 'operator_post',
      session: {
        id: 'session-1',
        purpose: 'operator_post',
        state: 'active',
        createdAt: '2026-08-07T12:00:00.000Z',
        expiresAt: '2026-08-07T20:00:00.000Z',
        lastSeenAt: '2026-08-07T12:05:00.000Z',
      },
      workContext: {
        kind: 'operator_post',
        assignment: { workplace: 'POST-1', shift: 'shift-1' },
      },
      passwordChangeRequired: false,
    },
    inbox: { items: [], nextCursor: null, unreadCount: 0 },
    runtime: {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'active',
        operatorName: 'Хабибулин Руслан',
        workplace: 'POST-1',
      },
      orders: [
        {
          ...sourceOrder,
          id: 'A-3',
          orderId: 'A-3',
          title: 'Заказ A-3',
          status: 'handover',
          currentRoll: 2,
          currentDispatchItemId: serverCurrentRoll.dispatchItemId,
          rollProgress: { current: 2, completed: 1, total: 3 },
          rolls: [serverCurrentRoll, selectedRoll],
        },
      ],
    },
    penalties: [],
    bags: [],
    machineChange: null,
  };
}

function operatorSnapshotAfterCurrentRollHandover() {
  const snapshot = operatorSnapshot();
  const order = snapshot.runtime.orders[0]!;
  const completedRoll = order.rolls[0]!;
  const nextRoll = order.rolls[1]!;

  completedRoll.status = 'передан на склад';
  completedRoll.warehouseState = 'sent';
  completedRoll.sentToWarehouseAt = '2026-08-27T07:45:00.000Z';
  order.status = 'spool_weight';
  order.currentRoll = nextRoll.sequenceNumber;
  order.currentDispatchItemId = nextRoll.dispatchItemId;
  order.rollProgress = { current: nextRoll.sequenceNumber, completed: 2, total: 3 };

  return snapshot;
}

function operatorClosePendingSnapshot() {
  const snapshot = operatorSnapshot();
  snapshot.runtime.orders = [];
  snapshot.runtime.shift = {
    ...snapshot.runtime.shift,
    id: 'shift-1',
    status: 'close_pending',
    bags: [
      {
        bagId: 'bag-1',
        code: 'BB-1',
        material: 'ПВД',
        materialId: 'material-1',
        warehouseKg: 500,
        startKg: 480,
        endKg: null,
        addedReason: null,
        releasedReason: null,
        active: true,
        releasedAt: null,
        sequence: 1,
      },
    ],
  };
  return snapshot;
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

type ScrollTarget = {
  scrollTop: number;
  scrollTo: ReturnType<typeof vi.fn>;
};

function scrollTarget(scrollTop: number): ScrollTarget {
  return {
    scrollTop,
    scrollTo: vi.fn(function scrollTo(this: ScrollTarget, options: { top: number }) {
      this.scrollTop = options.top;
    }),
  };
}

function installBrowser(
  viewport: { innerWidth?: number; outerWidth?: number; devicePixelRatio?: number } = {},
) {
  let currentUrl = new URL(
    `http://localhost/?role=operator&section=${encodeURIComponent('Рулоны и заказы')}` +
      `&object=${serverCurrentRollId}`,
  );
  const storage = new Map<string, string>();
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  const detailScroll = scrollTarget(180);
  const applicationScroll = scrollTarget(420);
  const windowScroll = vi.fn();
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
    querySelector: vi.fn((selector: string) => {
      if (selector === '.detail-panel') return detailScroll;
      if (selector === 'ix-application') {
        return {
          shadowRoot: {
            querySelector: vi.fn((shadowSelector: string) =>
              shadowSelector === 'main.content' ? applicationScroll : null,
            ),
          },
        };
      }
      return null;
    }),
  });
  vi.stubGlobal('window', {
    innerWidth: viewport.innerWidth ?? 1024,
    outerWidth: viewport.outerWidth ?? 1024,
    devicePixelRatio: viewport.devicePixelRatio ?? 1,
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
    localStorage: browserStorage,
    matchMedia: vi.fn(() => media),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
    cancelAnimationFrame: vi.fn(),
    scrollTo: windowScroll,
  });
  vi.stubGlobal('localStorage', browserStorage);

  return {
    applicationScroll,
    detailScroll,
    href: () => currentUrl.toString(),
    windowScroll,
  };
}

async function renderApp() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('App operator roll selection', () => {
  it.each(['direct link', 'refresh'])(
    'clears a cancelled roll after %s without opening another',
    async (scenario) => {
      const snapshot = operatorSnapshot();
      const afterCancellation = operatorSnapshot();
      afterCancellation.runtime.orders[0].rolls = afterCancellation.runtime.orders[0].rolls.filter(
        (roll) => roll.id !== serverCurrentRollId,
      );
      mocks.loadLiveRoleSnapshot.mockResolvedValue(
        scenario === 'direct link' ? afterCancellation : snapshot,
      );
      const browser = installBrowser();
      const renderer = await renderApp();
      if (scenario === 'refresh') {
        mocks.loadLiveRoleSnapshot.mockResolvedValue(afterCancellation);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
      }
      expect(renderer.root.findAllByType(DetailView)).toHaveLength(0);
      expect(new URL(browser.href()).searchParams.get('object')).toBeNull();
      renderer.unmount();
    },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetchCounterpartyTemplates.mockResolvedValue({
      templates: [],
      versions: [],
      draftPositions: {},
    });
    mocks.closeOperatorShift.mockResolvedValue(shiftCloseResult('shift-1'));
    mocks.fetchRoleInbox.mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
    mocks.fetchOperatorOrderMass.mockResolvedValue({
      orderPlannedNetKg: 30,
      weighedPlannedNetKg: 10,
      actualNetKg: 10.5,
      deviationKg: 0.5,
      weighedRollCount: 1,
      totalRollCount: 3,
    });
    mocks.handoverOperatorRoll.mockResolvedValue(undefined);
    mocks.loadLiveRoleSnapshot.mockResolvedValue(operatorSnapshot());
    mocks.reweighOperatorRoll.mockResolvedValue({
      rollCode: serverCurrentRollId,
      step: 'handover',
      previousWeight: { grossKg: 3.1, netKg: -0.55, toleranceOk: false },
      currentWeight: { grossKg: 6.65, netKg: 3, toleranceOk: false },
    });
    mocks.reportOperatorMachineBreakdown.mockResolvedValue({ id: 'problem-1', status: 'open' });
    mocks.verifyAndHandoverOperatorQr.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('keeps the selected row and detail pane on the same roll', async () => {
    const browser = installBrowser();
    const renderer = await renderApp();
    const initialHub = renderer.root.findByType(OperatorRollsHubSurface);
    expect(initialHub.props.runtime.orders).toHaveLength(1);

    act(() => initialHub.props.onSelectRoll(selectedRollId));

    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    const detail = renderer.root.findByType(DetailView);
    expect(hub.props.selectedRollId).toBe(selectedRollId);
    expect(detail.props.object.workbench.currentRoll.id).toBe(selectedRollId);
    expect(detail.props.object.workbench.step).toBe('Примите заказ');
    expect(new URL(browser.href()).searchParams.get('object')).toBe(selectedRollId);
  });

  it('keeps the full-size operator workstation on the roll the operator just picked', async () => {
    const browser = installBrowser({ innerWidth: 1024, outerWidth: 1024, devicePixelRatio: 1 });
    const renderer = await renderApp();
    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    expect(hub.props.runtime.orders).toHaveLength(1);
    browser.detailScroll.scrollTop = 180;
    browser.applicationScroll.scrollTop = 420;
    browser.detailScroll.scrollTo.mockClear();
    browser.applicationScroll.scrollTo.mockClear();
    browser.windowScroll.mockClear();

    act(() => hub.props.onSelectRoll(selectedRollId));

    expect(browser.detailScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.applicationScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.windowScroll).not.toHaveBeenCalled();
    expect(browser.detailScroll.scrollTop).toBe(180);
    expect(browser.applicationScroll.scrollTop).toBe(420);
  });

  it('returns the compact operator viewport to the selected roll details', async () => {
    const browser = installBrowser({ innerWidth: 900, outerWidth: 900, devicePixelRatio: 1 });
    const renderer = await renderApp();
    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    expect(hub.props.runtime.orders).toHaveLength(1);
    browser.detailScroll.scrollTop = 180;
    browser.applicationScroll.scrollTop = 420;
    browser.detailScroll.scrollTo.mockClear();
    browser.applicationScroll.scrollTo.mockClear();
    browser.windowScroll.mockClear();

    act(() => hub.props.onSelectRoll(selectedRollId));

    expect(browser.detailScroll.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(browser.applicationScroll.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(browser.windowScroll).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(browser.detailScroll.scrollTop).toBe(0);
    expect(browser.applicationScroll.scrollTop).toBe(0);
  });

  it('keeps the selected roll and both scroll roots across a live mass refresh', async () => {
    const initial = operatorSnapshot();
    const refreshed = operatorSnapshot();
    refreshed.runtime.orders[0]!.rolls = refreshed.runtime.orders[0]!.rolls.map((roll) => ({
      ...roll,
      updatedAt: '2026-08-08T06:00:05.000Z',
    }));
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot.mockResolvedValueOnce(initial).mockResolvedValue(refreshed);
    const browser = installBrowser();
    const renderer = await renderApp();
    act(() => renderer.root.findByType(OperatorRollsHubSurface).props.onSelectRoll(selectedRollId));
    browser.detailScroll.scrollTop = 180;
    browser.applicationScroll.scrollTop = 420;
    browser.detailScroll.scrollTo.mockClear();
    browser.applicationScroll.scrollTo.mockClear();
    browser.windowScroll.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    const detail = renderer.root.findByType(DetailView);
    expect(hub.props.selectedRollId).toBe(selectedRollId);
    expect(detail.props.object.workbench.currentRoll.id).toBe(selectedRollId);
    expect(browser.detailScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.applicationScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.windowScroll).not.toHaveBeenCalled();
    expect(browser.detailScroll.scrollTop).toBe(180);
    expect(browser.applicationScroll.scrollTop).toBe(420);
    expect(mocks.fetchOperatorOrderMass.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the completed roll selected and both scroll roots after handover', async () => {
    const initial = operatorSnapshot();
    const completed = operatorSnapshotAfterCurrentRollHandover();
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot.mockResolvedValueOnce(initial).mockResolvedValue(completed);
    const browser = installBrowser({ innerWidth: 900, outerWidth: 900, devicePixelRatio: 1 });
    const renderer = await renderApp();
    browser.detailScroll.scrollTop = 180;
    browser.applicationScroll.scrollTop = 420;
    browser.detailScroll.scrollTo.mockClear();
    browser.applicationScroll.scrollTo.mockClear();
    browser.windowScroll.mockClear();

    await act(async () => {
      renderer.root.findByType(DetailView).props.onAction('operator-handover');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.handoverOperatorRoll).toHaveBeenCalledWith(
      serverCurrentRollId,
      expect.any(String),
    );
    expect(renderer.root.findByType(OperatorRollsHubSurface).props.selectedRollId).toBe(
      serverCurrentRollId,
    );
    expect(renderer.root.findByType(DetailView).props.object.workbench.currentRoll.id).toBe(
      serverCurrentRollId,
    );
    expect(browser.detailScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.applicationScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.windowScroll).not.toHaveBeenCalled();
    expect(browser.detailScroll.scrollTop).toBe(180);
    expect(browser.applicationScroll.scrollTop).toBe(420);
  });

  it('reuses the physical operation key when the app reloads after a lost response', async () => {
    installBrowser();
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-ruslan',
      displayName: 'Хабибулин Руслан',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    mocks.handoverOperatorRoll
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockResolvedValueOnce(undefined);

    let renderer = await renderApp();
    await act(async () => {
      renderer.root.findByType(DetailView).props.onAction('operator-handover');
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstOperationKey = mocks.handoverOperatorRoll.mock.calls[0]?.[1];
    act(() => renderer.unmount());

    renderer = await renderApp();
    await act(async () => {
      renderer.root.findByType(DetailView).props.onAction('operator-handover');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.handoverOperatorRoll).toHaveBeenCalledTimes(2);
    expect(mocks.handoverOperatorRoll.mock.calls[1]?.[1]).toBe(firstOperationKey);
  });

  it('recovers invalid handover weight without resetting selection or scroll', async () => {
    const snapshot = operatorSnapshot();
    snapshot.runtime.orders[0]!.rolls = snapshot.runtime.orders[0]!.rolls.map((roll) =>
      roll.id === serverCurrentRollId
        ? {
            ...roll,
            spoolKg: 3.65,
            grossKg: 3.1,
            netKg: -0.55,
            actualNetKg: -0.55,
            toleranceState: 'blocked',
            updatedAt: '2026-08-13T11:00:00.000Z',
          }
        : roll,
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(snapshot);
    const invalidateAndRefresh = vi.spyOn(
      LiveRefreshController.prototype,
      'invalidateAndRefresh',
    );
    const browser = installBrowser();
    const renderer = await renderApp();
    invalidateAndRefresh.mockClear();
    const massCallsBefore = mocks.fetchOperatorOrderMass.mock.calls.length;
    browser.detailScroll.scrollTop = 180;
    browser.applicationScroll.scrollTop = 420;
    browser.detailScroll.scrollTo.mockClear();
    browser.applicationScroll.scrollTo.mockClear();
    browser.windowScroll.mockClear();

    await act(async () => {
      renderer.root.findByType(DetailView).props.onAction('operator-reweigh-roll');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.reweighOperatorRoll).toHaveBeenCalledWith(
      serverCurrentRollId,
      expect.any(String),
    );
    expect(invalidateAndRefresh).not.toHaveBeenCalled();
    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    const detail = renderer.root.findByType(DetailView);
    const recoveredRoll = hub.props.runtime.orders[0].rolls.find(
      (roll: { id: string }) => roll.id === serverCurrentRollId,
    );
    expect(hub.props.selectedRollId).toBe(serverCurrentRollId);
    expect(detail.props.object.workbench.currentRoll.id).toBe(serverCurrentRollId);
    expect(recoveredRoll).toEqual(
      expect.objectContaining({
        grossKg: 6.65,
        netKg: 3,
        actualNetKg: 3,
        labelState: 'verified',
        warehouseState: 'not_ready',
      }),
    );
    expect(recoveredRoll.updatedAt).not.toBe('2026-08-13T11:00:00.000Z');
    expect(mocks.fetchOperatorOrderMass.mock.calls.length).toBeGreaterThan(massCallsBefore);
    expect(browser.detailScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.applicationScroll.scrollTo).not.toHaveBeenCalled();
    expect(browser.windowScroll).not.toHaveBeenCalled();
    expect(browser.detailScroll.scrollTop).toBe(180);
    expect(browser.applicationScroll.scrollTop).toBe(420);
  });

  it('verifies the selected roll QR when another roll puts the order in handover', async () => {
    installBrowser();
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      operatorSnapshot({ selectedRollStatus: 'qr_check' }),
    );
    const renderer = await renderApp();
    const hub = renderer.root.findByType(OperatorRollsHubSurface);
    act(() => hub.props.onSelectRoll(selectedRollId));

    const detail = renderer.root.findByType(DetailView);
    const scannedPayload = 'plenka://roll/A-3-roll-3?token=physical-label';
    await act(async () => {
      detail.props.onAction(`operator-verify-qr:${encodeURIComponent(scannedPayload)}`);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.verifyAndHandoverOperatorQr).toHaveBeenCalledTimes(1);
    expect(mocks.verifyAndHandoverOperatorQr).toHaveBeenCalledWith(
      selectedRollId,
      expect.any(String),
      expect.any(String),
      scannedPayload,
    );
    expect(mocks.handoverOperatorRoll).not.toHaveBeenCalled();
  });

  it('threads structured breakdown pending and confirmed-success state only into the shift form', async () => {
    installBrowser();
    let resolveReport!: (value: { id: string; status: string }) => void;
    mocks.reportOperatorMachineBreakdown.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReport = resolve;
      }),
    );
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

    const actionId = `operator-machine-breakdown:${encodeURIComponent(
      JSON.stringify({ type: 'drive_stopped', details: 'Привод не запускается' }),
    )}`;
    act(() => renderer.root.findByType(OperatorShiftSurface).props.onAction(actionId));

    expect(mocks.reportOperatorMachineBreakdown).toHaveBeenCalledWith({
      type: 'drive_stopped',
      details: 'Привод не запускается',
    });
    expect(renderer.root.findByType(OperatorShiftSurface).props).toMatchObject({
      breakdownPending: true,
      breakdownError: null,
      breakdownSuccessVersion: 0,
    });

    await act(async () => {
      resolveReport({ id: 'problem-1', status: 'open' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByType(OperatorShiftSurface).props).toMatchObject({
      breakdownPending: false,
      breakdownError: null,
      breakdownSuccessVersion: 1,
    });
  });

  it('keeps a rejected breakdown visible inline without clearing the form', async () => {
    installBrowser();
    mocks.reportOperatorMachineBreakdown.mockRejectedValueOnce(new Error('Нет связи с сервером'));
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

    await act(async () => {
      renderer.root
        .findByType(OperatorShiftSurface)
        .props.onAction(
          `operator-machine-breakdown:${encodeURIComponent(JSON.stringify({ type: 'other' }))}`,
        );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(OperatorShiftSurface).props).toMatchObject({
      breakdownPending: false,
      breakdownError: 'Нет связи с сервером',
      breakdownSuccessVersion: 0,
    });
  });

  it('cancels live final weighing with no orders and without an API request', async () => {
    installBrowser();
    const snapshot = operatorClosePendingSnapshot();
    snapshot.runtime.shift.status = 'active';
    mocks.loadLiveRoleSnapshot.mockResolvedValue(snapshot);
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift-request'),
    );
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'close_pending',
    );
    expect(fetchMock).not.toHaveBeenCalled();

    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '417.2',
        selectedBagId: 'bag-1',
        bagEndKg: { 'bag-1': '417.2' },
        addBagId: 'bag-2',
        addKg: '300',
      }),
    );
    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift-cancel'),
    );

    const shiftProps = renderer.root.findByType(OperatorShiftSurface).props;
    expect(shiftProps.runtime.orders).toEqual([]);
    expect(shiftProps.runtime.shift.status).toBe('active');
    expect(shiftProps.draft).toEqual({
      startKg: '480',
      endKg: '',
      selectedBagId: 'bag-1',
      bagEndKg: {},
      addBagId: 'bag-2',
      addKg: '300',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.closeOperatorShift).not.toHaveBeenCalled();
  });

  it('projects a successful close, invalidates stale refreshes, and ignores cancel', async () => {
    installBrowser();
    const invalidateAndRefresh = vi.spyOn(LiveRefreshController.prototype, 'invalidateAndRefresh');
    const snapshot = operatorClosePendingSnapshot();
    mocks.closeOperatorShift.mockResolvedValueOnce(shiftCloseResult(snapshot.runtime.shift.id));
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValue(new Promise(() => undefined));
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));
    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      }),
    );
    const auditBeforeClose = renderer.root.findByType(OperatorShiftSurface).props.runtime.audit;

    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
    });

    const closedSurface = renderer.root.findByType(OperatorShiftSurface);
    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(1);
    expect(invalidateAndRefresh).toHaveBeenCalledTimes(1);
    expect(closedSurface.props.runtime.shift.status).toBe('closed');
    expect(closedSurface.props.runtime.audit).toBe(auditBeforeClose);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Отменить сдачу');
    act(() => closedSurface.props.onAction('operator-close-shift-cancel'));
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'closed',
    );
  });

  it('reuses the shift-close operation key when the app reloads after a lost response', async () => {
    installBrowser();
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-ruslan',
      displayName: 'Хабибулин Руслан',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const snapshot = operatorClosePendingSnapshot();
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(snapshot);
    mocks.closeOperatorShift.mockReset();
    mocks.closeOperatorShift
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockResolvedValueOnce(shiftCloseResult(snapshot.runtime.shift.id));

    let renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));
    act(() => {
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      });
    });
    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstRequest = mocks.closeOperatorShift.mock.calls[0]?.[0];
    expect(firstRequest).toMatchObject({ bags: [{ bigBagId: 'bag-1', endKg: 417.2 }] });
    act(() => renderer.unmount());

    renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));
    act(() => {
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      });
    });
    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(2);
    expect(mocks.closeOperatorShift.mock.calls[1]?.[0]).toEqual(firstRequest);
  });

  it('retries an uncertain close with the exact request after an early active snapshot', async () => {
    installBrowser();
    const snapshot = operatorClosePendingSnapshot();
    const earlySnapshot = operatorClosePendingSnapshot();
    earlySnapshot.runtime.shift.status = 'active';
    const closedSnapshot = operatorClosePendingSnapshot();
    closedSnapshot.runtime.shift.status = 'closed';
    const retry = deferred<ReturnType<typeof shiftCloseResult>>();
    mocks.closeOperatorShift
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockReturnValueOnce(retry.promise);
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(earlySnapshot)
      .mockResolvedValue(closedSnapshot);
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      });
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(2);
    expect(mocks.closeOperatorShift.mock.calls[1]?.[0]).toEqual(
      mocks.closeOperatorShift.mock.calls[0]?.[0],
    );
    const retryingSurface = renderer.root.findByType(OperatorShiftSurface);
    expect(retryingSurface.props.runtime.shift.status).toBe('close_pending');
    expect(retryingSurface.props.pendingActionId).toBe('operator-close-shift');
    const blockedCancel = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
    expect(blockedCancel?.props.disabled).toBe(true);
    act(() => retryingSurface.props.onAction('operator-close-shift-cancel'));
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'close_pending',
    );

    await act(async () => {
      retry.resolve(shiftCloseResult(snapshot.runtime.shift.id));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'closed',
    );
    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(2);
  });

  it('unblocks cancel only after the exact replay is deterministically rejected', async () => {
    installBrowser();
    const snapshot = operatorClosePendingSnapshot();
    const earlySnapshot = operatorClosePendingSnapshot();
    earlySnapshot.runtime.shift.status = 'active';
    mocks.closeOperatorShift
      .mockRejectedValueOnce(new TypeError('Network connection lost'))
      .mockRejectedValueOnce(
        new ApiError(409, 'Завершите начатый рулон.', 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE'),
      );
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot.mockResolvedValueOnce(snapshot).mockResolvedValue(earlySnapshot);
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      });
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(2);
    expect(mocks.closeOperatorShift.mock.calls[1]?.[0]).toEqual(
      mocks.closeOperatorShift.mock.calls[0]?.[0],
    );
    const rejectedSurface = renderer.root.findByType(OperatorShiftSurface);
    expect(rejectedSurface.props.runtime.shift.status).toBe('close_pending');
    expect(rejectedSurface.props.pendingActionId).toBeNull();
    const cancel = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
    expect(cancel?.props.disabled).toBe(false);
    act(() => rejectedSurface.props.onAction('operator-close-shift-cancel'));
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'active',
    );
  });

  it.each([
    {
      scenario: 'the same shift is authoritatively closed',
      closeError: new TypeError('Network connection lost'),
      acceptedShiftId: 'shift-1',
      acceptedStatus: 'closed' as const,
    },
    {
      scenario: 'malformed committed 2xx response followed by no assigned shift',
      closeError: new ApiResponseParseError(200, new Error('Invalid strict close projection')),
      acceptedShiftId: 'shift-not-assigned',
      acceptedStatus: 'start_missing' as const,
    },
  ])(
    'resolves uncertain close when a fresh snapshot confirms $scenario',
    async ({ closeError, acceptedShiftId, acceptedStatus }) => {
      installBrowser();
      const snapshot = operatorClosePendingSnapshot();
      const accepted = operatorClosePendingSnapshot();
      accepted.runtime.shift = {
        ...accepted.runtime.shift,
        id: acceptedShiftId,
        status: acceptedStatus,
      };
      delete accepted.runtime.shift.bags;
      mocks.closeOperatorShift.mockRejectedValueOnce(closeError);
      mocks.loadLiveRoleSnapshot.mockReset();
      mocks.loadLiveRoleSnapshot
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValueOnce(new TypeError('Refresh still offline'))
        .mockResolvedValue(accepted);
      const renderer = await renderApp();
      act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

      await act(async () => {
        renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      let shiftSurface = renderer.root.findByType(OperatorShiftSurface);
      expect(shiftSurface.props.pendingActionId).toBe('operator-close-shift-uncertain');
      expect(JSON.stringify(renderer.toJSON())).toContain('Статус сдачи проверяется');
      const blockedCancel = renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
      expect(blockedCancel?.props.disabled).toBe(true);
      act(() => shiftSurface.props.onAction('operator-close-shift-cancel'));
      expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
        'close_pending',
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      shiftSurface = renderer.root.findByType(OperatorShiftSurface);
      expect(shiftSurface.props.runtime.shift.status).toBe(acceptedStatus);
      expect(shiftSurface.props.pendingActionId).toBeNull();
      expect(JSON.stringify(renderer.toJSON())).not.toContain('Статус сдачи проверяется');
      const availableCancel = renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
      expect(availableCancel).toBeUndefined();
      expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(1);
    },
  );

  it('does not clear a normal close pending state when a periodic snapshot arrives', async () => {
    installBrowser();
    const snapshot = operatorClosePendingSnapshot();
    const periodic = operatorClosePendingSnapshot();
    periodic.runtime.shift.status = 'active';
    const confirmed = operatorClosePendingSnapshot();
    confirmed.runtime.shift.status = 'closed';
    const close = deferred<ReturnType<typeof shiftCloseResult>>();
    mocks.closeOperatorShift.mockReturnValueOnce(close.promise);
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(periodic)
      .mockResolvedValue(confirmed);
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));

    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift'),
    );
    expect(renderer.root.findByType(OperatorShiftSurface).props.pendingActionId).toBe(
      'operator-close-shift',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const pendingSurface = renderer.root.findByType(OperatorShiftSurface);
    expect(pendingSurface.props.runtime.shift.status).toBe('close_pending');
    expect(pendingSurface.props.pendingActionId).toBe('operator-close-shift');
    const cancel = renderer.root
      .findAllByType('button')
      .find((button) => button.props['aria-label']?.startsWith('Отменить сдачу'));
    expect(cancel?.props.disabled).toBe(true);

    await act(async () => {
      close.resolve(shiftCloseResult(snapshot.runtime.shift.id));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'closed',
    );
  });

  it('keeps cancel available when a deterministic durable close fails', async () => {
    installBrowser();
    const snapshot = operatorClosePendingSnapshot();
    mocks.closeOperatorShift.mockRejectedValueOnce(
      new ApiError(409, 'Завершите начатый рулон.', 'OPERATOR_SHIFT_STARTED_ROLLS_INCOMPLETE'),
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(snapshot);
    const renderer = await renderApp();
    act(() => renderer.root.findByType(RoleTopNavigation).props.onChangeSection('Смена'));
    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onDraftChange({
        startKg: '480',
        endKg: '',
        bagEndKg: { 'bag-1': '417.2' },
      }),
    );

    await act(async () => {
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'close_pending',
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('Отменить сдачу');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Статус сдачи проверяется');
    act(() =>
      renderer.root.findByType(OperatorShiftSurface).props.onAction('operator-close-shift-cancel'),
    );
    expect(renderer.root.findByType(OperatorShiftSurface).props.runtime.shift.status).toBe(
      'active',
    );
    expect(mocks.closeOperatorShift).toHaveBeenCalledTimes(1);
  });
});
