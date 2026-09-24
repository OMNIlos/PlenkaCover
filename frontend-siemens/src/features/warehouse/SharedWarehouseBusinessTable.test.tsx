import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedWarehouseBusinessTable } from './SharedWarehouseBusinessTable';

const template = {
  fingerprint: 'a'.repeat(64),
  filmType: 'термоусадочная пленка',
  actualThicknessMicron: 35,
  accountingThicknessMicron: 40,
  widthMm: 500,
  plannedLengthM: 1200,
  birka: 'белая',
  spoolType: '76 мм',
  plannedWeightKg: 19,
  recipeVersion: 'v3',
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function page(items: unknown[], currentPage = 1, pageSize = 50, total = items.length) {
  return { items, page: currentPage, pageSize, total };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function render(role: 'commercial' | 'director', body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<SharedWarehouseBusinessTable role={role} />);
  });
  return renderer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SharedWarehouseBusinessTable', () => {
  it('renders exactly four office headers, safe templates, Russian statuses, and reserve dashes', async () => {
    const renderer = await render(
      'commercial',
      page([
        {
          kind: 'client_order',
          id: 'order-1',
          templates: [template, { ...template, fingerprint: 'b'.repeat(64), widthMm: 600 }],
          status: 'awaiting_shipment',
          orderNumber: 'ЗК-101',
          counterpartyName: 'Контур Пак',
        },
        {
          kind: 'reserve',
          id: 'reserve-1',
          templates: [template],
          status: 'reserve',
          orderNumber: null,
          counterpartyName: null,
        },
        {
          kind: 'client_order',
          id: 'order-2',
          templates: [template],
          status: 'processing',
          orderNumber: 'ЗК-102',
          counterpartyName: 'Плёнка Юг',
        },
      ]),
    );

    expect(renderer.root.findAllByType('th').map(textContent)).toEqual([
      'Параметры рулонов',
      'Статус',
      'Заказ',
      'Контрагент',
    ]);
    const content = textContent(renderer.root);
    expect(content).toContain('Ожидает отгрузки');
    expect(content).toContain('В резерве');
    expect(content).toContain('В обработке');
    expect(
      renderer.root
        .findByType('tbody')
        .findAllByType('tr')
        .map((row) => row.props['data-order-status']),
    ).toEqual(['awaiting_shipment', 'reserve', 'processing']);
    expect(renderer.root.findAllByType('li')).toHaveLength(4);
    expect(
      renderer.root
        .findAllByType('td')
        .map(textContent)
        .filter((value) => value === '—'),
    ).toHaveLength(2);
    expect(renderer.root.findAllByType('td').map((cell) => cell.props['data-label'])).toEqual([
      'Параметры рулонов',
      'Статус',
      'Заказ',
      'Контрагент',
      'Параметры рулонов',
      'Статус',
      'Заказ',
      'Контрагент',
      'Параметры рулонов',
      'Статус',
      'Заказ',
      'Контрагент',
    ]);
    expect(content).not.toMatch(/Код рулона|Рулон|Физический вес|rawPayload|positionSnapshot/u);
  });

  it('renders one canonical template only once', async () => {
    const renderer = await render(
      'commercial',
      page([
        {
          kind: 'client_order',
          id: 'order-1',
          templates: [template],
          status: 'awaiting_shipment',
          orderNumber: 'ЗК-101',
          counterpartyName: 'Контур Пак',
        },
      ]),
    );

    expect(renderer.root.findAllByType('li')).toHaveLength(1);
    expect(textContent(renderer.root)).toContain('35/40 мкм · 500 мм · 1200 м · 19 кг');
  });

  it('renders a concise clarification message when accepted facts have no safe template', async () => {
    const renderer = await render(
      'commercial',
      page([
        {
          kind: 'client_order',
          id: 'order-1',
          templates: [],
          status: 'awaiting_shipment',
          orderNumber: 'ЗК-101',
          counterpartyName: 'Контур Пак',
        },
      ]),
    );

    expect(textContent(renderer.root)).toContain('Параметры уточняются');
    expect(renderer.root.findAllByType('li')).toHaveLength(0);
  });

  it('loads the next server page without demo fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          page(
            [
              {
                kind: 'client_order',
                id: 'order-1',
                templates: [template],
                status: 'awaiting_shipment',
                orderNumber: 'ЗК-101',
                counterpartyName: 'Контур Пак',
              },
            ],
            1,
            1,
            2,
          ),
        ),
      )
      .mockResolvedValueOnce(
        response(
          page(
            [
              {
                kind: 'client_order',
                id: 'order-2',
                templates: [template],
                status: 'processing',
                orderNumber: 'ЗК-102',
                counterpartyName: 'Плёнка Юг',
              },
            ],
            2,
            1,
            2,
          ),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedWarehouseBusinessTable role="commercial" pageSize={1} />,
      );
    });

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'Следующая страница' }).props.onClick();
    });

    expect(textContent(renderer.root)).toContain('ЗК-102');
    expect(textContent(renderer.root)).not.toContain('ЗК-101');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('page=2&pageSize=1');
  });

  it('renders identical rows for Commerce and Director while using their explicit read routes', async () => {
    const body = page([
      {
        kind: 'client_order',
        id: 'order-1',
        templates: [template],
        status: 'awaiting_shipment',
        orderNumber: 'ЗК-101',
        counterpartyName: 'Контур Пак',
      },
    ]);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(body)));
    vi.stubGlobal('fetch', fetchMock);
    let commerce!: ReactTestRenderer;
    let director!: ReactTestRenderer;
    await act(async () => {
      commerce = TestRenderer.create(<SharedWarehouseBusinessTable role="commercial" />);
    });
    await act(async () => {
      director = TestRenderer.create(<SharedWarehouseBusinessTable role="director" />);
    });

    expect(commerce.toJSON()).toEqual(director.toJSON());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/commercial/performance/warehouse');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/director/performance/warehouse');
  });

  it('aborts an obsolete director request and never renders its late result', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedWarehouseBusinessTable role="director" refreshGeneration={0} />,
      );
    });
    const firstSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;

    await act(async () => {
      renderer.update(<SharedWarehouseBusinessTable role="director" refreshGeneration={1} />);
    });
    expect(firstSignal?.aborted).toBe(true);

    second.resolve(
      response(
        page([
          {
            kind: 'client_order',
            id: 'new-order',
            templates: [template],
            status: 'processing',
            orderNumber: 'ЗК-НОВЫЙ',
            counterpartyName: 'Новый снимок',
          },
        ]),
      ),
    );
    await act(async () => {
      await second.promise;
      await Promise.resolve();
    });

    first.resolve(
      response(
        page([
          {
            kind: 'client_order',
            id: 'old-order',
            templates: [template],
            status: 'awaiting_shipment',
            orderNumber: 'ЗК-СТАРЫЙ',
            counterpartyName: 'Старый снимок',
          },
        ]),
      ),
    );
    await act(async () => {
      await first.promise;
      await Promise.resolve();
    });

    expect(textContent(renderer.root)).toContain('ЗК-НОВЫЙ');
    expect(textContent(renderer.root)).not.toContain('ЗК-СТАРЫЙ');
  });

  it.each(['commercial', 'director'] as const)(
    'keeps the current %s warehouse rows visible while a live refresh is pending',
    async (role) => {
      const refresh = deferred<Response>();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          response(
            page([
              {
                kind: 'client_order',
                id: 'visible-order',
                templates: [template],
                status: 'awaiting_shipment',
                orderNumber: 'ЗК-ВИДИМЫЙ',
                counterpartyName: 'Текущий снимок',
              },
            ]),
          ),
        )
        .mockReturnValueOnce(refresh.promise);
      vi.stubGlobal('fetch', fetchMock);
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <SharedWarehouseBusinessTable role={role} refreshGeneration={0} />,
        );
      });
      expect(textContent(renderer.root)).toContain('ЗК-ВИДИМЫЙ');

      await act(async () => {
        renderer.update(<SharedWarehouseBusinessTable role={role} refreshGeneration={1} />);
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(textContent(renderer.root)).toContain('ЗК-ВИДИМЫЙ');
      expect(textContent(renderer.root)).not.toContain('Загрузка склада…');

      refresh.resolve(
        response(
          page([
            {
              kind: 'client_order',
              id: 'refreshed-order',
              templates: [template],
              status: 'processing',
              orderNumber: 'ЗК-ОБНОВЛЁННЫЙ',
              counterpartyName: 'Новый снимок',
            },
          ]),
        ),
      );
      await act(async () => {
        await refresh.promise;
        await Promise.resolve();
      });

      expect(textContent(renderer.root)).toContain('ЗК-ОБНОВЛЁННЫЙ');
      expect(textContent(renderer.root)).not.toContain('ЗК-ВИДИМЫЙ');
    },
  );

  it('fails closed after a malformed director refresh instead of retaining the old snapshot', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          page([
            {
              kind: 'client_order',
              id: 'old-order',
              templates: [template],
              status: 'awaiting_shipment',
              orderNumber: 'ЗК-СТАРЫЙ',
              counterpartyName: 'Старый снимок',
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(response({ ...page([]), items: 'invalid' }));
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SharedWarehouseBusinessTable role="director" refreshGeneration={0} />,
      );
    });
    expect(textContent(renderer.root)).toContain('ЗК-СТАРЫЙ');

    await act(async () => {
      renderer.update(<SharedWarehouseBusinessTable role="director" refreshGeneration={1} />);
      await Promise.resolve();
    });

    expect(textContent(renderer.root)).toContain('Некорректные данные склада');
    expect(textContent(renderer.root)).not.toContain('ЗК-СТАРЫЙ');
  });
});
