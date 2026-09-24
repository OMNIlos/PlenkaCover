import { createElement, StrictMode } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDirectorOperatorRollVariances,
  type ServerDirectorOperatorRollVariancePage,
} from '../../../api/director';
import {
  useDirectorOperatorRollVariances,
  type DirectorOperatorRollVariancesResult,
} from './useDirectorOperatorRollVariances';

vi.mock('../../../api/director', () => ({
  fetchDirectorOperatorRollVariances: vi.fn(),
}));

const fetchVariances = vi.mocked(fetchDirectorOperatorRollVariances);

const FIRST_PAGE = {
  items: [
    {
      operatorId: 'operator-1',
      operatorName: 'Анна Соколова',
      orderId: 'order-1',
      orderNumber: 'A-9',
      rollId: 'roll-1',
      rollCode: 'A-9-1',
      producedAt: '2026-07-22T07:00:00.000Z',
      actualCapturedAt: '2026-07-22T07:05:00.000Z',
      plannedKg: 40,
      actualKg: 45,
      varianceKg: 5,
      overPlanKg: 5,
      provenance: 'post_session' as const,
    },
  ],
  nextCursor: 'opaque+page/2',
} satisfies ServerDirectorOperatorRollVariancePage;

const SECOND_PAGE = {
  items: [
    {
      ...FIRST_PAGE.items[0],
      orderId: 'order-2',
      orderNumber: 'A-10',
      rollId: 'roll-2',
      rollCode: 'A-10-1',
    },
  ],
  nextCursor: null,
} satisfies ServerDirectorOperatorRollVariancePage;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderHook({
  enabled = false,
  from = '2026-07-18',
  to = '2026-07-24',
}: {
  enabled?: boolean;
  from?: string;
  to?: string;
} = {}) {
  let latest!: DirectorOperatorRollVariancesResult;

  function Harness(props: { enabled: boolean; from: string; to: string }) {
    latest = useDirectorOperatorRollVariances({
      enabled: props.enabled,
      range: { from: props.from, to: props.to },
    });
    return createElement('span', { 'data-status': latest.status }, latest.pageNumber);
  }

  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      createElement(StrictMode, null, createElement(Harness, { enabled, from, to })),
    );
  });

  return {
    get current() {
      return latest;
    },
    update(next: { enabled: boolean; from: string; to: string }) {
      act(() => {
        renderer.update(createElement(StrictMode, null, createElement(Harness, next)));
      });
    },
    unmount() {
      act(() => renderer.unmount());
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDirectorOperatorRollVariances', () => {
  it('loads only on the first exact-data switch and avoids duplicate requests', async () => {
    fetchVariances.mockResolvedValue(FIRST_PAGE);
    const hook = renderHook();

    expect(hook.current.status).toBe('idle');
    expect(fetchVariances).not.toHaveBeenCalled();

    hook.update({ enabled: true, from: '2026-07-18', to: '2026-07-24' });
    await flushEffects();
    expect(fetchVariances).toHaveBeenCalledTimes(1);
    expect(fetchVariances).toHaveBeenCalledWith({
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: undefined,
      limit: 25,
    });
    expect(hook.current.status).toBe('ready');

    hook.update({ enabled: false, from: '2026-07-18', to: '2026-07-24' });
    hook.update({ enabled: true, from: '2026-07-18', to: '2026-07-24' });
    await flushEffects();
    expect(fetchVariances).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('uses the opaque cursor stack for deterministic Next and Back pages', async () => {
    fetchVariances
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockResolvedValueOnce(SECOND_PAGE)
      .mockResolvedValueOnce(FIRST_PAGE);
    const hook = renderHook({ enabled: true });
    await flushEffects();

    expect(hook.current.pageNumber).toBe(1);
    expect(hook.current.canBack).toBe(false);
    expect(hook.current.canNext).toBe(true);

    act(() => hook.current.next());
    await flushEffects();
    expect(fetchVariances).toHaveBeenNthCalledWith(2, {
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: 'opaque+page/2',
      limit: 25,
    });
    expect(hook.current.page?.items[0]?.rollCode).toBe('A-10-1');
    expect(hook.current.pageNumber).toBe(2);
    expect(hook.current.canBack).toBe(true);

    act(() => hook.current.back());
    await flushEffects();
    expect(fetchVariances).toHaveBeenNthCalledWith(3, {
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: undefined,
      limit: 25,
    });
    expect(hook.current.page?.items[0]?.rollCode).toBe('A-9-1');
    expect(hook.current.pageNumber).toBe(1);
    hook.unmount();
  });

  it('invalidates a stale response and resets cursor history when the range changes', async () => {
    const staleSecondPage = deferred<ServerDirectorOperatorRollVariancePage>();
    const changedRange = deferred<ServerDirectorOperatorRollVariancePage>();
    fetchVariances
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockReturnValueOnce(staleSecondPage.promise)
      .mockReturnValueOnce(changedRange.promise);
    const hook = renderHook({ enabled: true });
    await flushEffects();

    act(() => hook.current.next());
    expect(hook.current.pageNumber).toBe(2);
    expect(fetchVariances).toHaveBeenCalledTimes(2);

    hook.update({ enabled: true, from: '2026-07-01', to: '2026-07-07' });
    expect(hook.current.pageNumber).toBe(1);
    expect(hook.current.canBack).toBe(false);
    expect(fetchVariances).toHaveBeenCalledTimes(3);
    expect(fetchVariances).toHaveBeenNthCalledWith(3, {
      from: '2026-07-01',
      to: '2026-07-07',
      cursor: undefined,
      limit: 25,
    });

    staleSecondPage.resolve(SECOND_PAGE);
    await flushEffects();
    expect(hook.current.status).toBe('loading');
    expect(hook.current.page).toBeNull();

    changedRange.resolve(SECOND_PAGE);
    await flushEffects();
    expect(hook.current.status).toBe('ready');
    expect(hook.current.page?.items[0]?.rollCode).toBe('A-10-1');
    expect(hook.current.pageNumber).toBe(1);
    expect(hook.current.canBack).toBe(false);
    hook.unmount();
  });

  it('retries the current cursor after an error', async () => {
    fetchVariances
      .mockResolvedValueOnce(FIRST_PAGE)
      .mockRejectedValueOnce(new Error('Сервис временно недоступен'))
      .mockResolvedValueOnce(FIRST_PAGE);
    const hook = renderHook({ enabled: true });
    await flushEffects();

    act(() => hook.current.next());
    await flushEffects();
    expect(hook.current.status).toBe('error');
    expect(hook.current.error).toBe('Сервис временно недоступен');

    act(() => hook.current.retry());
    await flushEffects();
    expect(fetchVariances).toHaveBeenCalledTimes(3);
    expect(fetchVariances).toHaveBeenNthCalledWith(2, {
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: 'opaque+page/2',
      limit: 25,
    });
    expect(fetchVariances).toHaveBeenNthCalledWith(3, {
      from: '2026-07-18',
      to: '2026-07-24',
      cursor: 'opaque+page/2',
      limit: 25,
    });
    expect(hook.current.status).toBe('ready');
    expect(hook.current.page).toEqual(FIRST_PAGE);
    hook.unmount();
  });
});
