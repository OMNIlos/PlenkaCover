import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { WorkObject } from '../../domain/types';
import {
  useDirectorSupplementalObjects,
  type DirectorSupplementalScope,
} from './useDirectorSupplementalObjects';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workObject(id: string): WorkObject {
  return {
    id,
    kind: 'financeOrder',
    title: id,
    statusLabel: 'Ожидает решения',
    nextOwner: 'Директор',
    severity: 'warning',
    facts: [],
    sections: [],
    actions: [],
    problems: [],
    audit: [],
  };
}

function renderState(
  loaders: Record<
    DirectorSupplementalScope,
    (options: { signal: AbortSignal }) => Promise<WorkObject[]>
  >,
) {
  let enabled = true;
  let refreshGeneration = 0;
  let result!: ReturnType<typeof useDirectorSupplementalObjects>;

  function Harness() {
    result = useDirectorSupplementalObjects({ enabled, refreshGeneration, loaders });
    return null;
  }

  const view = create(createElement(Harness));
  return {
    current: () => result,
    disable: () => {
      enabled = false;
      view.update(createElement(Harness));
    },
    refresh: () => {
      refreshGeneration += 1;
      view.update(createElement(Harness));
    },
    view,
  };
}

describe('useDirectorSupplementalObjects', () => {
  it('clears a successful source before retry and keeps it empty after failure', async () => {
    const initial = deferred<WorkObject[]>();
    const failedRetry = deferred<WorkObject[]>();
    const finance = vi
      .fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => failedRetry.promise);
    const state = renderState({
      finance,
      production: vi.fn().mockResolvedValue([]),
      warehouse: vi.fn().mockResolvedValue([]),
    });

    await act(async () => {
      initial.resolve([workObject('finance-old')]);
      await initial.promise;
      await Promise.resolve();
    });
    expect(state.current().byScope.finance).toMatchObject({
      status: 'ready',
      objects: [expect.objectContaining({ id: 'finance-old' })],
    });

    act(() => {
      void state.current().retry('finance');
    });
    expect(state.current().byScope.finance).toEqual({ status: 'loading', objects: [] });

    await act(async () => {
      failedRetry.reject(new Error('temporary failure'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.current().byScope.finance).toEqual({ status: 'error', objects: [] });
    state.view.unmount();
  });

  it('keeps a loaded source on screen while a periodic refresh is in flight', async () => {
    const initial = deferred<WorkObject[]>();
    const refreshed = deferred<WorkObject[]>();
    const finance = vi
      .fn()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => refreshed.promise);
    const state = renderState({
      finance,
      production: vi.fn().mockResolvedValue([]),
      warehouse: vi.fn().mockResolvedValue([]),
    });

    await act(async () => {
      initial.resolve([workObject('finance-old')]);
      await initial.promise;
      await Promise.resolve();
    });
    expect(state.current().byScope.finance).toMatchObject({ status: 'ready' });

    act(() => state.refresh());

    expect(state.current().byScope.finance).toMatchObject({
      status: 'ready',
      objects: [expect.objectContaining({ id: 'finance-old' })],
    });

    await act(async () => {
      refreshed.resolve([workObject('finance-new')]);
      await refreshed.promise;
      await Promise.resolve();
    });
    expect(state.current().byScope.finance).toMatchObject({
      status: 'ready',
      objects: [expect.objectContaining({ id: 'finance-new' })],
    });
    state.view.unmount();
  });

  it('shows the loading state on the very first load of a source', async () => {
    const initial = deferred<WorkObject[]>();
    const state = renderState({
      finance: vi.fn().mockImplementationOnce(() => initial.promise),
      production: vi.fn().mockResolvedValue([]),
      warehouse: vi.fn().mockResolvedValue([]),
    });

    await act(async () => {});
    expect(state.current().byScope.finance).toEqual({ status: 'loading', objects: [] });

    await act(async () => {
      initial.resolve([]);
      await initial.promise;
      await Promise.resolve();
    });
    state.view.unmount();
  });

  it('aborts a superseded request and accepts only the newest response', async () => {
    const first = deferred<WorkObject[]>();
    const second = deferred<WorkObject[]>();
    const signals: AbortSignal[] = [];
    const finance = vi.fn((options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const state = renderState({
      finance,
      production: vi.fn().mockResolvedValue([]),
      warehouse: vi.fn().mockResolvedValue([]),
    });

    act(() => {
      void state.current().retry('finance');
    });
    expect(finance).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);

    second.resolve([workObject('finance-new')]);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    first.resolve([workObject('finance-stale')]);
    await first.promise;
    await Promise.resolve();

    expect(state.current().byScope.finance).toMatchObject({
      status: 'ready',
      objects: [expect.objectContaining({ id: 'finance-new' })],
    });
    state.view.unmount();
  });

  it('aborts all sources and clears their objects when the director view is disabled', async () => {
    const requests = {
      finance: deferred<WorkObject[]>(),
      production: deferred<WorkObject[]>(),
      warehouse: deferred<WorkObject[]>(),
    };
    const signals: AbortSignal[] = [];
    const loaders = Object.fromEntries(
      (Object.keys(requests) as DirectorSupplementalScope[]).map((scope) => [
        scope,
        ({ signal }: { signal: AbortSignal }) => {
          signals.push(signal);
          return requests[scope].promise;
        },
      ]),
    ) as Record<
      DirectorSupplementalScope,
      (options: { signal: AbortSignal }) => Promise<WorkObject[]>
    >;
    const state = renderState(loaders);

    act(() => state.disable());

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(state.current().byScope).toEqual({
      finance: { status: 'idle', objects: [] },
      production: { status: 'idle', objects: [] },
      warehouse: { status: 'idle', objects: [] },
    });
    state.view.unmount();
  });
});
