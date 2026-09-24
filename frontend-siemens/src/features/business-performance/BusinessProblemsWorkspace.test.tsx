import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlenkiModal } from '../../components/plenki-ui/PlenkiPrimitives';
import { BusinessProblemsWorkspace } from './BusinessProblemsWorkspace';

const openProblem = {
  id: 'problem-open',
  kind: 'defect',
  status: 'open',
  label: 'Брак рулона',
  createdAt: '2026-08-07T00:10:00.000Z',
  orderId: 'order-17',
  orderNumber: 'A-17',
  rollCode: 'ROLL-17',
  machineName: 'Экструдер 2',
  reason: 'Неровная кромка',
};

const resolvedProblem = {
  id: 'problem-resolved',
  kind: 'weight_deviation',
  status: 'resolved',
  label: 'Отклонение веса',
  createdAt: '2026-08-07T00:05:00.000Z',
  orderId: 'order-16',
  orderNumber: null,
  rollCode: 'ROLL-16',
  machineName: null,
  reason: null,
};

const breakdownProblem = {
  id: 'problem-breakdown',
  kind: 'machine_breakdown',
  status: 'open',
  label: 'Поломка станка',
  createdAt: '2026-08-07T00:20:00.000Z',
  orderId: null,
  orderNumber: null,
  rollCode: null,
  machineName: 'Экструдер 3',
  reason: 'Обрыв ремня',
};

const routedProblem = {
  id: 'problem-routed',
  kind: 'general',
  status: 'open',
  label: 'Общая проблема',
  createdAt: '2026-08-08T00:20:00.000Z',
  orderId: 'order-18',
  orderNumber: 'A-18',
  rollCode: 'ROLL-18',
  machineName: 'Экструдер 4',
  reason: 'Плёнка идёт со складками',
};

function response(items: unknown[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({ items, nextCursor }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function text(renderer: ReactTestRenderer) {
  return textContent(renderer.root);
}

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAllByType('button')
    .find((candidate) => textContent(candidate) === label);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BusinessProblemsWorkspace', () => {
  it('mounts its root directly as the shared problems scroll owner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });

    const scrollOwner = renderer.root.findByProps({ className: 'commercial-problems' });
    expect(scrollOwner.type).toBe('section');
    expect(renderer.root.findAllByProps({ className: 'commercial-problems-shell' })).toHaveLength(0);
  });

  it('replaces the first page when the App refresh generation advances', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem], 'cursor-old'))
      .mockResolvedValueOnce(response([resolvedProblem]));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    expect(text(renderer)).toContain('A-17');

    await act(async () => {
      renderer.update(<BusinessProblemsWorkspace refreshGeneration={2} />);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/commercial/performance/problems?filter=open&limit=20',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text(renderer)).toContain('ROLL-16');
    expect(text(renderer)).not.toContain('A-17');
    expect(button(renderer, 'Показать ещё')).toBeUndefined();
  });

  it(
    'keeps the last successful list after a transient refresh failure and offers one inline retry',
    async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response([openProblem]))
        .mockRejectedValueOnce(new Error('temporary outage'))
        .mockResolvedValueOnce(response([resolvedProblem]));
      vi.stubGlobal('fetch', fetchMock);
      let renderer!: ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
      });
      await act(async () => {
        renderer.update(<BusinessProblemsWorkspace refreshGeneration={2} />);
      });

      expect(text(renderer)).toContain('A-17');
      expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
      expect(
        renderer.root
          .findAllByType('button')
          .filter((candidate) => textContent(candidate) === 'Повторить'),
      ).toHaveLength(1);

      await act(async () => {
        button(renderer, 'Повторить')?.props.onClick();
      });
      expect(text(renderer)).toContain('ROLL-16');
      expect(text(renderer)).not.toContain('A-17');
    },
  );

  it('retries a failed next page once and stops a repeated cursor cycle', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem], 'cursor-1'))
      .mockRejectedValueOnce(new Error('temporary page failure'))
      .mockResolvedValueOnce(response([openProblem, resolvedProblem], 'cursor-1'));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    await act(async () => {
      button(renderer, 'Показать ещё')?.props.onClick();
    });

    expect(text(renderer)).toContain('A-17');
    expect(
      renderer.root
        .findAllByType('button')
        .filter((candidate) => textContent(candidate) === 'Повторить'),
    ).toHaveLength(1);

    await act(async () => {
      button(renderer, 'Повторить')?.props.onClick();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/commercial/performance/problems?filter=open&limit=20&cursor=cursor-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-open' })).toHaveLength(1);
    expect(text(renderer)).toContain('ROLL-16');
    expect(button(renderer, 'Показать ещё')).toBeUndefined();
  });

  it('keeps load-more single-flight when the action is triggered twice before a render', async () => {
    const nextPage = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem], 'cursor-1'))
      .mockReturnValue(nextPage.promise);
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    const loadMore = button(renderer, 'Показать ещё')?.props.onClick;
    if (!loadMore) throw new Error('Load-more action is missing.');

    act(() => {
      loadMore();
      loadMore();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      nextPage.resolve(response([resolvedProblem]));
      await nextPage.promise;
    });
  });

  it('aborts an obsolete request and ignores its late response', async () => {
    const stale = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response([resolvedProblem]));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    const staleSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;

    await act(async () => {
      renderer.update(<BusinessProblemsWorkspace refreshGeneration={2} />);
    });
    expect(staleSignal.aborted).toBe(true);

    await act(async () => {
      stale.resolve(response([openProblem]));
      await stale.promise;
    });

    expect(text(renderer)).toContain('ROLL-16');
    expect(text(renderer)).not.toContain('A-17');
  });

  it('does not create a polling interval of its own', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([])));

    await act(async () => {
      TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });

    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it('opens compact problem details with a clear owner but no mutation controls for commercial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([openProblem])));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    await act(async () => {
      button(renderer, 'Подробнее')?.props.onClick();
    });

    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
    expect(text(renderer)).toContain('Ответственный за решение');
    expect(text(renderer)).toContain('Зав. производства');
    expect(text(renderer)).toContain('Неровная кромка');
    expect(button(renderer, 'Переделать')).toBeUndefined();
    expect(button(renderer, 'Списать')).toBeUndefined();
  });

  it('fetches, merges, selects, and focuses an exact routed problem absent from the first page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(routedProblem), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/performance/problems/problem-routed',
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
    );
    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(1);
    expect(
      renderer.root.findByProps({ 'data-problem-id': 'problem-routed' }).props[
        'data-problem-selected'
      ],
    ).toBe('true');
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
    expect(text(renderer)).toContain('Плёнка идёт со складками');
    expect(button(renderer, 'Переделать')).toBeUndefined();
    expect(button(renderer, 'Списать')).toBeUndefined();
  });

  it('does not move keyboard focus from an exact modal back to its background row', async () => {
    const rowFocus = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(response([]))
        .mockResolvedValueOnce(
          new Response(JSON.stringify(routedProblem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    );
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
        {
          createNodeMock: (element) =>
            element.type === 'article'
              ? { focus: rowFocus, scrollIntoView: vi.fn() }
              : null,
        },
      );
    });

    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
    expect(rowFocus).not.toHaveBeenCalled();
  });

  it('removes routed problem A atomically while routed problem B is pending or fails', async () => {
    const nextProblem = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/problem-routed')) {
        return Promise.resolve(
          new Response(JSON.stringify(routedProblem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path.endsWith('/problem-next')) return nextProblem.promise;
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
      );
    });
    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(1);

    act(() => {
      renderer.update(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-next" />,
      );
    });

    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(0);
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(0);

    await act(async () => {
      nextProblem.resolve(
        new Response(JSON.stringify({ message: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await nextProblem.promise;
    });

    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(0);
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(0);
    expect(text(renderer)).toContain('Не удалось открыть выбранную проблему');

    act(() => {
      renderer.update(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    expect(text(renderer)).not.toContain(
      'Не удалось открыть выбранную проблему',
    );
  });

  it('hides a local details selection synchronously when an exact routed target starts', async () => {
    const exactProblem = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem]))
      .mockReturnValueOnce(exactProblem.promise);
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(<BusinessProblemsWorkspace refreshGeneration={1} />);
    });
    await act(async () => {
      button(renderer, 'Подробнее')?.props.onClick();
    });
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);

    act(() => {
      renderer.update(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-next" />,
      );
    });

    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ 'data-problem-id': 'problem-open' }).props[
        'data-problem-selected'
      ],
    ).toBe('false');
  });

  it('accepts a resolved shortage row while refetching the same exact route without flicker', async () => {
    const refreshedExact = deferred<Response>();
    const shortageProblem = {
      ...routedProblem,
      kind: 'raw_material_shortage',
      label: 'Нехватка сырья',
    };
    const refreshedProblem = { ...shortageProblem, status: 'resolved' };
    let listCalls = 0;
    let exactCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/problems?')) {
        listCalls += 1;
        return Promise.resolve(response(listCalls === 1 ? [] : [refreshedProblem]));
      }
      exactCalls += 1;
      if (exactCalls === 1) {
        return Promise.resolve(
          new Response(JSON.stringify(shortageProblem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return refreshedExact.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace
          refreshGeneration={1}
          selectedProblemId="problem-routed"
          onOpenMaterialShortageCorrection={vi.fn()}
        />,
      );
    });
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-problem-status': 'open' })).toHaveLength(1);
    expect(button(renderer, 'Перейти к корректировке сырья')).toBeDefined();

    await act(async () => {
      renderer.update(
        <BusinessProblemsWorkspace
          refreshGeneration={2}
          selectedProblemId="problem-routed"
          onOpenMaterialShortageCorrection={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(exactCalls).toBe(2);
    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-problem-status': 'resolved' })).toHaveLength(1);
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
    expect(text(renderer)).toContain('Решена');
    expect(button(renderer, 'Перейти к корректировке сырья')).toBeUndefined();

    await act(async () => {
      refreshedExact.resolve(
        new Response(JSON.stringify(refreshedProblem), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await refreshedExact.promise;
    });
  });

  it('retries the same failed exact route and merges its success without duplicates', async () => {
    let exactCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/problems?')) return Promise.resolve(response([]));
      exactCalls += 1;
      return Promise.resolve(
        exactCalls === 1
          ? new Response(JSON.stringify({ message: 'not found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response(JSON.stringify(routedProblem), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
      );
    });
    expect(text(renderer)).toContain('Не удалось открыть выбранную проблему');

    await act(async () => {
      button(renderer, 'Повторить')?.props.onClick();
    });

    expect(exactCalls).toBe(2);
    expect(text(renderer)).not.toContain('Не удалось открыть выбранную проблему');
    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-routed' })).toHaveLength(1);
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
  });

  it('never displays another problem returned for an exact routed id', async () => {
    const mismatchedProblem = { ...routedProblem, id: 'problem-b', reason: 'Чужая проблема' };
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/problems?')
        ? Promise.resolve(response([]))
        : Promise.resolve(
            new Response(JSON.stringify(mismatchedProblem), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-a" />,
      );
    });

    expect(renderer.root.findAllByProps({ 'data-problem-id': 'problem-b' })).toHaveLength(0);
    expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(0);
    expect(text(renderer)).toContain('Не удалось открыть выбранную проблему');
  });

  it('offers only Commerce the exact dedicated correction CTA for an open shortage', async () => {
    const shortage = {
      ...routedProblem,
      id: 'problem-shortage',
      kind: 'raw_material_shortage',
      label: 'Нехватка сырья',
      reason: 'ПВД закончился',
    };
    const onOpenMaterialShortageCorrection = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/problems?')
        ? Promise.resolve(response([]))
        : Promise.resolve(
            new Response(JSON.stringify(shortage), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    let commercial!: ReactTestRenderer;
    let director!: ReactTestRenderer;

    await act(async () => {
      commercial = TestRenderer.create(
        <BusinessProblemsWorkspace
          refreshGeneration={1}
          selectedProblemId="problem-shortage"
          onOpenMaterialShortageCorrection={onOpenMaterialShortageCorrection}
        />,
      );
      director = TestRenderer.create(
        <BusinessProblemsWorkspace
          refreshGeneration={1}
          selectedProblemId="problem-shortage"
          allowProductionOverride
        />,
      );
    });

    expect(text(commercial)).toContain('Коммерция');
    expect(button(commercial, 'Перейти к корректировке сырья')).toBeDefined();
    expect(button(director, 'Перейти к корректировке сырья')).toBeUndefined();
    expect(button(director, 'Переделать')).toBeUndefined();
    expect(button(director, 'Списать')).toBeUndefined();

    await act(async () => {
      button(commercial, 'Перейти к корректировке сырья')?.props.onClick();
    });
    expect(onOpenMaterialShortageCorrection).toHaveBeenCalledWith({
      orderId: 'order-18',
      problemId: 'problem-shortage',
    });
  });

  it('announces an exact routed request as busy until it settles', async () => {
    const exactProblem = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/problems?') ? Promise.resolve(response([])) : exactProblem.promise,
    );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
      );
    });

    expect(renderer.root.findByProps({ className: 'commercial-problems' }).props['aria-busy']).toBe(
      true,
    );

    await act(async () => {
      exactProblem.resolve(
        new Response(JSON.stringify(routedProblem), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await exactProblem.promise;
    });
    expect(renderer.root.findByProps({ className: 'commercial-problems' }).props['aria-busy']).toBe(
      false,
    );
  });

  it.each([
    ['the same row', 'problem-routed', 'Плёнка идёт со складками'],
    ['a different row', 'problem-open', 'Неровная кромка'],
  ] as const)(
    'lets local details supersede a closed office CTA route for %s',
    async (_scenario, problemId, expectedReason) => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const path = String(input);
        if (path.includes('/problems?')) {
          return Promise.resolve(response([routedProblem, openProblem]));
        }
        return Promise.resolve(
          new Response(JSON.stringify(routedProblem), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      });
      vi.stubGlobal('fetch', fetchMock);
      let renderer!: ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          <BusinessProblemsWorkspace refreshGeneration={1} selectedProblemId="problem-routed" />,
        );
      });
      expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);

      await act(async () => {
        renderer.root.findByProps({ 'aria-label': 'Закрыть' }).props.onClick();
      });
      expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(0);

      const row = renderer.root.findByProps({ 'data-problem-id': problemId });
      await act(async () => {
        row
          .findAllByType('button')
          .find((candidate) => textContent(candidate) === 'Подробнее')
          ?.props.onClick();
      });

      expect(renderer.root.findAllByType(PlenkiModal)).toHaveLength(1);
      expect(text(renderer)).toContain(expectedReason);
    },
  );

  it('clears a stale routed snapshot and refetches its resolved authoritative state', async () => {
    const exactDefect = {
      ...openProblem,
      id: 'problem-routed-defect',
    };
    let resolved = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/problem-routed-defect/resolve') && init?.method === 'POST') {
        resolved = true;
        return Promise.resolve(
          new Response(JSON.stringify({ id: exactDefect.id, status: 'resolved' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (path.endsWith('/problem-routed-defect')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...exactDefect,
              status: resolved ? 'resolved' : 'open',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.resolve(response([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace
          refreshGeneration={1}
          allowProductionOverride
          selectedProblemId="problem-routed-defect"
        />,
      );
    });
    await act(async () => {
      button(renderer, 'Списать')?.props.onClick();
    });
    await act(async () => {
      renderer.root.findByType('textarea').props.onChange({
        target: { value: 'Списание согласовано после проверки' },
      });
    });
    await act(async () => {
      button(renderer, 'Подтвердить списание')?.props.onClick();
    });

    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/problem-routed-defect'),
      ),
    ).toHaveLength(2);
    expect(renderer.root.findAllByProps({ 'data-problem-status': 'resolved' })).toHaveLength(1);
    expect(text(renderer)).toContain('Решена');
    expect(button(renderer, 'Списать')).toBeUndefined();
  });

  it('lets a director resolve a defect with a required note and refreshes the open list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([openProblem]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: openProblem.id, status: 'resolved' }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} allowProductionOverride />,
      );
    });
    await act(async () => {
      button(renderer, 'Подробнее')?.props.onClick();
    });
    await act(async () => {
      button(renderer, 'Списать')?.props.onClick();
    });

    const textarea = renderer.root.findByType('textarea');
    const submit = button(renderer, 'Подтвердить списание');
    expect(submit?.props.disabled).toBe(true);

    await act(async () => {
      textarea.props.onChange({ target: { value: 'Списание согласовано после проверки веса' } });
    });
    expect(button(renderer, 'Подтвердить списание')?.props.disabled).toBe(false);

    await act(async () => {
      button(renderer, 'Подтвердить списание')?.props.onClick();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/commercial/performance/problems/problem-open/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          resolution: 'writeoff',
          note: 'Списание согласовано после проверки веса',
        }),
      }),
    );
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    expect(text(renderer)).toContain('Открытых проблем нет');
  });

  it('offers only the applicable confirmation actions for a machine breakdown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([breakdownProblem])));
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <BusinessProblemsWorkspace refreshGeneration={1} allowProductionOverride />,
      );
    });
    await act(async () => {
      button(renderer, 'Подробнее')?.props.onClick();
    });

    expect(button(renderer, 'Подтвердить поломку')).toBeDefined();
    expect(button(renderer, 'Отклонить поломку')).toBeDefined();
    expect(button(renderer, 'Переделать')).toBeUndefined();
    expect(button(renderer, 'Списать')).toBeUndefined();
  });
});
