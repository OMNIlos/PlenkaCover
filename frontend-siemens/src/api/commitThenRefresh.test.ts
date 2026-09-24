import { describe, expect, it, vi } from 'vitest';

import { commitThenRefresh } from './commitThenRefresh';
import { LiveRefreshController, type LiveRefreshEnvironment } from './liveRefresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function inertRefreshEnvironment(): LiveRefreshEnvironment {
  return {
    isHidden: () => false,
    setInterval: () => undefined as unknown as ReturnType<typeof globalThis.setInterval>,
    clearInterval: () => undefined,
    addFocusListener: () => undefined,
    removeFocusListener: () => undefined,
    addVisibilityListener: () => undefined,
    removeVisibilityListener: () => undefined,
  };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('commit then refresh', () => {
  it('does not refresh after a rejected commit', async () => {
    const error = new Error('commit rejected');
    const refresh = vi.fn();

    const result = await commitThenRefresh(
      () => Promise.reject(error),
      refresh,
    );

    expect(result).toEqual({ committed: false, refreshed: false, error });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps a successful commit accepted when only refresh fails', async () => {
    const error = new Error('refresh unavailable');

    const result = await commitThenRefresh(
      () => Promise.resolve(),
      () => Promise.reject(error),
    );

    expect(result).toEqual({ committed: true, refreshed: false, error });
  });

  it('reports a committed and refreshed mutation when both steps succeed', async () => {
    const result = await commitThenRefresh(
      () => Promise.resolve(),
      () => Promise.resolve(),
    );

    expect(result).toEqual({ committed: true, refreshed: true });
  });

  it('invalidates a pre-commit polling snapshot immediately after a successful mutation', async () => {
    const stale = deferred<string>();
    const confirmed = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(confirmed.promise);
    const apply = vi.fn();
    const controller = new LiveRefreshController<string>({
      environment: inertRefreshEnvironment(),
    });
    controller.start({ load, apply });

    const result = await commitThenRefresh(
      () => Promise.resolve(),
      () => Promise.resolve(),
      () => controller.invalidateAndRefresh(),
    );
    expect(result).toEqual({ committed: true, refreshed: true });

    stale.resolve('pre-commit');
    await flushPromises();
    expect(apply).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);

    confirmed.resolve('post-commit');
    await flushPromises();
    expect(apply).toHaveBeenCalledWith('post-commit');

    controller.stop();
  });
});
