import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from '../../api/penalties';
import {
  usePenaltySnapshotState,
  type PenaltySnapshotStateController,
} from './usePenaltySnapshotState';

const empty: PenaltySnapshotRuntime = {
  items: [],
  summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
};

function snapshot(id: string): PenaltySnapshotRuntime {
  return {
    items: [
      {
        penaltyId: id,
        employeeId: 'operator-1',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        targetRole: 'operator',
        scopeObjectId: 'Заказ A-101 целиком',
        reason: 'Брак',
        amountLabel: '10 ₽',
        author: 'Зав. производства',
        status: 'issued',
        createdAt: '2026-08-08T08:00:00.000Z',
        history: [],
      },
    ],
    summary: { totalCount: 1, totalAmountKopecks: 1000, topReason: 'брак' },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderState(
  fetchSnapshot: (
    filters: PenaltySnapshotFilters,
    options: { signal: AbortSignal },
  ) => Promise<PenaltySnapshotRuntime>,
  onError = vi.fn(),
) {
  let controller!: PenaltySnapshotStateController;
  function Harness() {
    controller = usePenaltySnapshotState({ fetchSnapshot, onError });
    return null;
  }
  const view = create(createElement(Harness));
  return { current: () => controller, onError, view };
}

describe('usePenaltySnapshotState', () => {
  it('keeps displayed filters atomically paired with the last successful snapshot while selection is pending', async () => {
    const filtered = deferred<PenaltySnapshotRuntime>();
    const state = renderState(() => filtered.promise);
    act(() => {
      state
        .current()
        .applyPeriodicSnapshot(
          'production',
          {},
          snapshot('stable'),
          state.current().getRequestVersion('production'),
        );
    });

    let request!: Promise<boolean>;
    act(() => {
      request = state.current().changeFilters('production', { status: 'cancelled' });
    });

    expect(state.current().byRole.production.snapshot.items[0]?.penaltyId).toBe('stable');
    expect(state.current().byRole.production.filters).toEqual({});
    expect(state.current().byRole.production.pending).toBe(true);

    await act(async () => {
      filtered.resolve(snapshot('filtered'));
      await expect(request).resolves.toBe(true);
    });
    expect(state.current().byRole.production).toMatchObject({
      snapshot: snapshot('filtered'),
      filters: { status: 'cancelled' },
      pending: false,
    });
    state.view.unmount();
  });

  it('lets only the newest filter response commit and aborts the superseded request', async () => {
    const first = deferred<PenaltySnapshotRuntime>();
    const second = deferred<PenaltySnapshotRuntime>();
    const signals: AbortSignal[] = [];
    const fetchSnapshot = vi
      .fn()
      .mockImplementation((_filters: PenaltySnapshotFilters, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return signals.length === 1 ? first.promise : second.promise;
      });
    const state = renderState(fetchSnapshot);

    let firstRequest!: Promise<boolean>;
    let secondRequest!: Promise<boolean>;
    act(() => {
      firstRequest = state.current().changeFilters('production', { targetRole: 'operator' });
    });
    act(() => {
      secondRequest = state.current().changeFilters('production', { status: 'cancelled' });
    });

    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      second.resolve(snapshot('newest'));
      await expect(secondRequest).resolves.toBe(true);
    });
    await act(async () => {
      first.resolve(snapshot('stale'));
      await expect(firstRequest).resolves.toBe(false);
    });

    expect(state.current().byRole.production.snapshot.items[0]?.penaltyId).toBe('newest');
    expect(state.current().byRole.production.filters).toEqual({ status: 'cancelled' });
    expect(state.current().getAppliedFilters('production')).toEqual({ status: 'cancelled' });
    state.view.unmount();
  });

  it('keeps the last successful snapshot/filter pair unchanged after selection failure', async () => {
    const failed = deferred<PenaltySnapshotRuntime>();
    const state = renderState(() => failed.promise);
    act(() => {
      state
        .current()
        .applyPeriodicSnapshot(
          'director',
          {},
          snapshot('stable'),
          state.current().getRequestVersion('director'),
        );
    });

    let request!: Promise<boolean>;
    act(() => {
      request = state.current().changeFilters('director', { employeeId: 'missing-employee' });
    });
    expect(state.current().byRole.director.snapshot.items[0]?.penaltyId).toBe('stable');
    expect(state.current().byRole.director.filters).toEqual({});
    expect(state.current().byRole.director.pending).toBe(true);

    await act(async () => {
      failed.reject(new Error('Сервер временно недоступен'));
      await expect(request).resolves.toBe(false);
    });

    expect(state.current().byRole.director.snapshot.items[0]?.penaltyId).toBe('stable');
    expect(state.current().byRole.director.filters).toEqual({});
    expect(state.onError).toHaveBeenCalledWith(
      'director',
      expect.objectContaining({ message: 'Сервер временно недоступен' }),
    );
    state.view.unmount();
  });

  it('queues post-create refresh behind a pending selection and refreshes its successful filter', async () => {
    const selection = deferred<PenaltySnapshotRuntime>();
    const postCreate = deferred<PenaltySnapshotRuntime>();
    const calls: Array<{ filters: PenaltySnapshotFilters; signal: AbortSignal }> = [];
    const fetchSnapshot = vi.fn(
      (filters: PenaltySnapshotFilters, options: { signal: AbortSignal }) => {
        calls.push({ filters, signal: options.signal });
        return calls.length === 1 ? selection.promise : postCreate.promise;
      },
    );
    const state = renderState(fetchSnapshot);

    let selectionRequest!: Promise<boolean>;
    let refreshRequest!: Promise<boolean>;
    act(() => {
      selectionRequest = state.current().changeFilters('production', { status: 'cancelled' });
    });
    act(() => {
      refreshRequest = state.current().refresh('production');
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal.aborted).toBe(false);
    expect(state.current().byRole.production.filters).toEqual({});

    await act(async () => {
      selection.resolve(snapshot('filtered'));
      await expect(selectionRequest).resolves.toBe(true);
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.filters).toEqual({ status: 'cancelled' });
    expect(state.current().byRole.production).toMatchObject({
      snapshot: snapshot('filtered'),
      filters: { status: 'cancelled' },
      pending: true,
    });

    await act(async () => {
      postCreate.resolve(snapshot('post-create'));
      await expect(refreshRequest).resolves.toBe(true);
    });
    expect(state.current().byRole.production).toMatchObject({
      snapshot: snapshot('post-create'),
      filters: { status: 'cancelled' },
      pending: false,
    });
    state.view.unmount();
  });

  it('keeps a queued refresh behind superseding selections and uses the prior pair after latest failure', async () => {
    const requests = [
      deferred<PenaltySnapshotRuntime>(),
      deferred<PenaltySnapshotRuntime>(),
      deferred<PenaltySnapshotRuntime>(),
      deferred<PenaltySnapshotRuntime>(),
    ];
    const calls: Array<{ filters: PenaltySnapshotFilters; signal: AbortSignal }> = [];
    const fetchSnapshot = vi.fn(
      (filters: PenaltySnapshotFilters, options: { signal: AbortSignal }) => {
        const request = requests[calls.length];
        calls.push({ filters, signal: options.signal });
        if (!request) throw new Error('Unexpected penalty request');
        return Promise.race([
          request.promise,
          new Promise<PenaltySnapshotRuntime>((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
        ]);
      },
    );
    const state = renderState(fetchSnapshot);
    act(() => {
      state
        .current()
        .applyPeriodicSnapshot(
          'director',
          {},
          snapshot('stable'),
          state.current().getRequestVersion('director'),
        );
    });

    let firstSelection!: Promise<boolean>;
    let secondSelection!: Promise<boolean>;
    let latestSelection!: Promise<boolean>;
    let refreshRequest!: Promise<boolean>;
    act(() => {
      firstSelection = state.current().changeFilters('director', { targetRole: 'operator' });
      refreshRequest = state.current().refresh('director');
    });
    expect(calls).toHaveLength(1);

    act(() => {
      secondSelection = state.current().changeFilters('director', { status: 'cancelled' });
      latestSelection = state.current().changeFilters('director', {
        employeeId: 'missing-employee',
      });
    });
    expect(calls.map(({ filters }) => filters)).toEqual([
      { targetRole: 'operator' },
      { status: 'cancelled' },
      { employeeId: 'missing-employee' },
    ]);

    await act(async () => {
      requests[2]?.reject(new Error('Фильтр недоступен'));
      await expect(firstSelection).resolves.toBe(false);
      await expect(secondSelection).resolves.toBe(false);
      await expect(latestSelection).resolves.toBe(false);
      await Promise.resolve();
    });
    expect(calls[3]?.filters).toEqual({});
    expect(state.current().byRole.director.snapshot.items[0]?.penaltyId).toBe('stable');
    expect(state.current().byRole.director.filters).toEqual({});
    expect(state.current().byRole.director.pending).toBe(true);

    await act(async () => {
      requests[3]?.resolve(snapshot('post-create-after-failure'));
      await expect(refreshRequest).resolves.toBe(true);
    });
    expect(state.current().byRole.director).toMatchObject({
      snapshot: snapshot('post-create-after-failure'),
      filters: {},
      pending: false,
    });
    expect(state.onError).toHaveBeenCalledTimes(1);
    state.view.unmount();
  });

  it('uses applied filters for periodic and post-create refresh without accepting stale sets', async () => {
    const fetchSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot('filtered'))
      .mockResolvedValueOnce(snapshot('post-create'));
    const state = renderState(fetchSnapshot);
    const stalePeriodicVersion = state.current().getRequestVersion('production');

    await act(async () => {
      await expect(
        state.current().changeFilters('production', {
          targetRole: 'operator',
          status: 'cancelled',
        }),
      ).resolves.toBe(true);
    });
    expect(state.current().getAppliedFilters('production')).toEqual({
      targetRole: 'operator',
      status: 'cancelled',
    });

    act(() => {
      state
        .current()
        .applyPeriodicSnapshot('production', {}, snapshot('stale-periodic'), stalePeriodicVersion);
    });
    expect(state.current().byRole.production.snapshot.items[0]?.penaltyId).toBe('filtered');

    await act(async () => {
      await expect(state.current().refresh('production')).resolves.toBe(true);
    });
    expect(fetchSnapshot.mock.calls[1]?.[0]).toEqual({
      targetRole: 'operator',
      status: 'cancelled',
    });
    expect(state.current().byRole.production.snapshot.items[0]?.penaltyId).toBe('post-create');

    act(() => {
      state
        .current()
        .applyPeriodicSnapshot(
          'production',
          { targetRole: 'operator', status: 'cancelled' },
          snapshot('same-filter-stale-periodic'),
          stalePeriodicVersion + 1,
        );
    });
    expect(state.current().byRole.production.snapshot.items[0]?.penaltyId).toBe('post-create');
    state.view.unmount();
  });
});
