import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { defaultIntakeDraft } from '../../domain/prototypeRuntime';
import { IntakeCreateSurface } from '../../components/shell/intakeCreateSurface';
import { CounterpartySearchPicker } from '../../components/shell/CounterpartySearchPicker';
import {
  buildCommercialCreateOrderCommand,
  createCommercialOrderFromIntake,
  fetchCommercialCounterparties,
  fetchCommercialTemplates,
  handoffCommercialOrderToFinance,
} from './api';
import {
  commercialIntakeReducer,
  CommercialIntakeForm,
  createCommercialIntakeState,
} from './CommercialIntakeForm';

function okResponse(json: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  };
}

function renderedText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : renderedText(child)))
    .join('');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live commercial intake', () => {
  it('validates dimensions before persisting a new counterparty on draft retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'new-client' }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      form: {
        ...defaultIntakeDraft,
        counterparty: '__new__',
        templateId: undefined,
        newCounterpartyName: 'Проверочный клиент',
        positions: [{ ...defaultIntakeDraft.positions[0], widthMm: '' }],
      },
      counterparties: [],
      templates: [],
      creatorRole: 'commercial' as const,
      mode: 'draft' as const,
      clientRequestId: '00000000-0000-4000-8000-000000000001',
    };
    await expect(createCommercialOrderFromIntake(request)).rejects.toThrow('Ширина');
    await expect(createCommercialOrderFromIntake(request)).rejects.toThrow('Ширина');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps one request locked through edits and releases after success=%s',
    async (success) => {
      let settle!: (value: ReturnType<typeof okResponse>) => void;
      const pending = new Promise<ReturnType<typeof okResponse>>((resolve) => {
        settle = resolve;
      });
      let posts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((path: string, init?: RequestInit) => {
          if (path === '/api/commercial/orders' && init?.method === 'POST') {
            posts++;
            return pending;
          }
          if (path.includes('/search?'))
            return Promise.resolve(
              okResponse({
                items: [
                  {
                    id: 'cp-live',
                    displayName: 'Клиент',
                    legalName: 'Клиент',
                    inn: null,
                    billingSource: 'manual',
                    syncStatus: 'synced',
                  },
                ],
                nextCursor: null,
              }),
            );
          return Promise.resolve(okResponse([]));
        }),
      );
      const form = {
        ...defaultIntakeDraft,
        counterparty: 'Клиент',
        counterpartyId: 'cp-live',
        templateId: undefined,
      };
      const onCreated = vi.fn();
      const render = (value = form) =>
        createElement(CommercialIntakeForm, {
          value,
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreated,
        });
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(render());
      });
      const submit = renderer.root.findByType(IntakeCreateSurface).props.onSubmit;
      let request!: Promise<void>;
      act(() => {
        request = submit('draft');
        void submit('draft');
      });
      await act(async () => {
        renderer.root
          .findByType(IntakeCreateSurface)
          .props.onChange({ ...form, comment: 'Изменение' });
        renderer.update(render({ ...form, comment: 'Внешнее изменение' }));
      });
      expect(renderer.root.findByType(IntakeCreateSurface).props.submitting).toBe(true);
      act(() => {
        void renderer.root.findByType(IntakeCreateSurface).props.onSubmit('draft');
      });
      expect(posts).toBe(1);
      await act(async () => {
        settle(
          success
            ? okResponse({ id: 'created-order' })
            : { ok: false, status: 400, json: async () => ({ message: 'Проверьте параметры' }) },
        );
        await request;
      });
      expect(renderer.root.findByType(IntakeCreateSurface).props.submitting).toBe(false);
      expect(onCreated).toHaveBeenCalledTimes(success ? 1 : 0);
      act(() => renderer.unmount());
    },
  );

  it('keeps loading inside the commercial intake frame', () => {
    const markup = renderToStaticMarkup(
      createElement(CommercialIntakeForm, {
        value: defaultIntakeDraft,
        onChange: vi.fn(),
        onClose: vi.fn(),
        onCreated: vi.fn(),
      }),
    );

    expect(markup).toContain('class="commercial-live-intake"');
    expect(markup).toContain('data-intake-sequence="counterparty-positions-review"');
    expect(markup).toContain('Загрузка справочника контрагентов');
    expect(markup).not.toContain('Дневная смена');
  });

  it('loads counterparties and immutable template versions from backend endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse([
          {
            id: 'cp-live',
            displayName: 'Backend Клиент',
            legalName: 'ООО Backend Клиент',
            inn: '7700000000',
            billingSource: 'manual',
            syncStatus: 'synced',
          },
        ]),
      )
      .mockResolvedValueOnce(
        okResponse([
          {
            id: 'tpl-live',
            counterpartyId: 'cp-live',
            name: 'Backend шаблон',
            description: null,
            status: 'active',
            ownerRole: 'production_lead',
            version: 3,
            positions: [
              {
                rollCount: 1,
                filmType: 'Рукав',
                actualThickness: '80 мкм',
                accountingThickness: '80 мкм',
                recipeParameters: [],
              },
            ],
            versions: [
              {
                id: 'tplv-live-3',
                templateId: 'tpl-live',
                version: 3,
                positions: [
                  {
                    rollCount: 1,
                    filmType: 'Рукав',
                    actualThickness: '80 мкм',
                    accountingThickness: '80 мкм',
                    recipeParameters: [],
                  },
                ],
                createdById: null,
                createdAt: '2026-07-14T08:00:00.000Z',
              },
            ],
            usageCount: 0,
            lastUsedAt: null,
            createdById: null,
            createdAt: '2026-07-14T08:00:00.000Z',
            updatedAt: '2026-07-14T08:00:00.000Z',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const counterparties = await fetchCommercialCounterparties();
    const templates = await fetchCommercialTemplates(counterparties[0].id);

    expect(counterparties).toEqual([
      expect.objectContaining({ id: 'cp-live', displayName: 'Backend Клиент' }),
    ]);
    expect(templates[0]).toEqual(
      expect.objectContaining({ id: 'tpl-live', activeVersionId: 'tplv-live-3' }),
    );
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/counterparties',
      '/api/commercial/counterparties/cp-live/templates',
    ]);
  });

  it('ignores an aborted stale search response and pins the selected counterparty', async () => {
    vi.useFakeTimers();
    let resolveFirstSearch!: (response: ReturnType<typeof okResponse>) => void;
    let resolveSecondSearch!: (response: ReturnType<typeof okResponse>) => void;
    const firstSearch = new Promise<ReturnType<typeof okResponse>>((resolve) => {
      resolveFirstSearch = resolve;
    });
    const secondSearch = new Promise<ReturnType<typeof okResponse>>((resolve) => {
      resolveSecondSearch = resolve;
    });
    const pinned = {
      id: 'cp-pinned',
      displayName: 'Выбранный клиент',
      legalName: 'ООО Выбранный клиент',
      inn: '7700000000',
      billingSource: 'manual_platform',
      syncStatus: 'ready',
    };
    const fetchMock = vi.fn((path: string, _init?: RequestInit) => {
      if (path === '/api/commercial/counterparties/search?limit=20') {
        return Promise.resolve(okResponse({ items: [pinned], nextCursor: null }));
      }
      if (path.includes('q=%D0%BF%D0%B5%D1%80%D0%B2%D1%8B%D0%B9')) return firstSearch;
      if (path.includes('q=%D0%B2%D1%82%D0%BE%D1%80%D0%BE%D0%B9')) return secondSearch;
      if (path === '/api/commercial/counterparties/cp-pinned/templates') {
        return Promise.resolve(okResponse([]));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommercialIntakeForm, {
          value: {
            ...defaultIntakeDraft,
            counterparty: 'Выбранный клиент',
            counterpartyId: 'cp-pinned',
            templateId: undefined,
          },
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const searchInput = renderer.root
      .findByType(CounterpartySearchPicker)
      .findByProps({ 'aria-label': 'Поиск контрагента' });
    await act(async () => {
      searchInput.props.onChange({ currentTarget: { value: 'первый' } });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    const firstRequest = fetchMock.mock.calls.find(([path]) =>
      String(path).includes('q=%D0%BF%D0%B5%D1%80%D0%B2%D1%8B%D0%B9'),
    );
    await act(async () => {
      searchInput.props.onChange({ currentTarget: { value: 'второй' } });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect((firstRequest?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);

    await act(async () => {
      resolveSecondSearch(
        okResponse({
          items: [
            {
              ...pinned,
              id: 'cp-second',
              displayName: 'Второй результат',
              legalName: 'ООО Второй результат',
            },
          ],
          nextCursor: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      resolveFirstSearch(
        okResponse({
          items: [
            {
              ...pinned,
              id: 'cp-stale',
              displayName: 'Устаревший результат',
              legalName: 'ООО Устаревший результат',
            },
          ],
          nextCursor: null,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const ids = renderer.root
      .findByType(IntakeCreateSurface)
      .props.counterpartyCatalog.map((item: { id: string }) => item.id);
    expect(ids).toEqual(['cp-pinned', 'cp-second']);
    expect(ids).not.toContain('cp-stale');
    act(() => renderer.unmount());
  });

  it('debounces typed counterparty search and sends only the latest query', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/commercial/counterparties/search?')) {
        return okResponse({ items: [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommercialIntakeForm, {
          value: {
            ...defaultIntakeDraft,
            counterparty: '',
            counterpartyId: undefined,
            templateId: undefined,
          },
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const searchInput = renderer.root
      .findByType(CounterpartySearchPicker)
      .findByProps({ 'aria-label': 'Поиск контрагента' });
    await act(async () => {
      searchInput.props.onChange({ currentTarget: { value: 'пе' } });
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    await act(async () => {
      renderer.root
        .findByType(CounterpartySearchPicker)
        .findByProps({ 'aria-label': 'Поиск контрагента' })
        .props.onChange({ currentTarget: { value: 'первый' } });
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(
      fetchMock.mock.calls.filter(([path]) => String(path).includes('q=')),
    ).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/counterparties/search?limit=20',
      '/api/commercial/counterparties/search?q=%D0%BF%D0%B5%D1%80%D0%B2%D1%8B%D0%B9&limit=20',
    ]);
    act(() => renderer.unmount());
  });

  it('submits the canonical counterparty id when names are duplicated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'order-canonical' }));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromIntake({
      form: {
        ...defaultIntakeDraft,
        counterparty: 'Одинаковое имя',
        counterpartyId: 'cp-second',
        templateId: undefined,
      },
      counterparties: [
        { id: 'cp-first', displayName: 'Одинаковое имя', legalName: null },
        { id: 'cp-second', displayName: 'Одинаковое имя', legalName: null },
      ],
      templates: [],
      creatorRole: 'commercial',
      mode: 'submit',
      clientRequestId: '00000000-0000-4000-8000-000000000301',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.counterpartyId).toBe('cp-second');
  });

  it('sends the checked counterparty-template flag through the live intake request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'order-with-template' }));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromIntake({
      form: {
        ...defaultIntakeDraft,
        counterparty: 'Backend Клиент',
        counterpartyId: 'cp-live',
        templateId: undefined,
        saveAsTemplate: true,
      },
      counterparties: [{ id: 'cp-live', displayName: 'Backend Клиент', legalName: null }],
      templates: [],
      creatorRole: 'commercial',
      mode: 'submit',
      clientRequestId: '00000000-0000-4000-8000-000000000303',
    });

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders');
    expect(JSON.parse(String(init.body))).toMatchObject({
      counterpartyId: 'cp-live',
      saveAsTemplate: true,
    });
  });

  it('keeps quick-create as a separate POST before order creation', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          id: 'cp-created',
          displayName: 'Новый клиент',
          legalName: 'Новый клиент',
          inn: '7700000000',
          billingSource: 'manual_platform',
          syncStatus: 'ready',
        }),
      )
      .mockResolvedValueOnce(okResponse({ id: 'order-created' }));
    vi.stubGlobal('fetch', fetchMock);

    await createCommercialOrderFromIntake({
      form: {
        ...defaultIntakeDraft,
        counterparty: '__new__',
        counterpartyId: undefined,
        counterpartyQuickCreateSaved: true,
        newCounterpartyName: 'Новый клиент',
        newCounterpartyInn: '7700000000',
        templateId: undefined,
      },
      counterparties: [],
      templates: [],
      creatorRole: 'commercial',
      mode: 'submit',
      clientRequestId: '00000000-0000-4000-8000-000000000302',
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/counterparties',
      '/api/commercial/orders',
    ]);
    expect(
      JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)).counterpartyId,
    ).toBe('cp-created');
  });

  it('keeps all multi-position rows for application without showing the first as the whole template', async () => {
    const positions = [
      {
        rollCount: 2,
        filmType: 'FIRST-ONLY',
        actualThickness: '40 мкм',
        accountingThickness: '40 мкм',
        recipeParameters: [],
      },
      {
        rollCount: 7,
        filmType: 'SECOND-ONLY',
        actualThickness: '90 мкм',
        accountingThickness: '90 мкм',
        recipeParameters: [],
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          items: [
            {
              id: 'cp-live',
              displayName: 'Backend Клиент',
              legalName: 'ООО Backend Клиент',
              inn: null,
              billingSource: 'manual',
              syncStatus: 'synced',
            },
          ],
          nextCursor: null,
        }),
      )
      .mockResolvedValueOnce(
        okResponse([
          {
            id: 'tpl-multi',
            counterpartyId: 'cp-live',
            name: 'Две позиции',
            description: null,
            status: 'active',
            ownerRole: 'production_lead',
            version: 4,
            positions,
            versions: [
              {
                id: 'tpl-multi-v4',
                templateId: 'tpl-multi',
                version: 4,
                positions,
                createdById: null,
                createdAt: '2026-07-14T08:00:00.000Z',
              },
            ],
            usageCount: 0,
            lastUsedAt: null,
            createdById: null,
            createdAt: '2026-07-14T08:00:00.000Z',
            updatedAt: '2026-07-14T08:00:00.000Z',
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommercialIntakeForm, {
          value: { ...defaultIntakeDraft, counterparty: 'Backend Клиент' },
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const surface = renderer.root.findByType(IntakeCreateSurface);
    expect(surface.props.templateVersions[0].fields).toEqual([
      expect.objectContaining({ label: 'Количество позиций', value: '2' }),
    ]);
    expect(JSON.stringify(surface.props.templateVersions[0].fields)).not.toContain('FIRST-ONLY');
    expect(surface.props.templateDraftPositions['tpl-multi']).toHaveLength(2);
    act(() => renderer.unmount());
  });

  it('keeps manual intake available when the optional template catalog fails and retries it', async () => {
    let templateAttempt = 0;
    const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === '/api/commercial/counterparties/search?limit=20') {
        return okResponse({
          items: [
            {
              id: 'cp-live',
              displayName: 'Backend Клиент',
              legalName: 'ООО Backend Клиент',
              inn: null,
              billingSource: 'manual',
              syncStatus: 'synced',
            },
          ],
          nextCursor: null,
        });
      }
      if (path === '/api/commercial/counterparties/cp-live/templates') {
        templateAttempt += 1;
        return templateAttempt === 1
          ? {
              ok: false,
              status: 503,
              json: async () => ({ message: 'Каталог временно недоступен' }),
            }
          : okResponse([]);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CommercialIntakeForm, {
          value: {
            ...defaultIntakeDraft,
            counterparty: 'Backend Клиент',
            templateId: undefined,
          },
          onChange: vi.fn(),
          onClose: vi.fn(),
          onCreated: vi.fn(),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(IntakeCreateSurface).props.templateCatalog).toEqual([]);
    const alert = renderer.root.findByProps({ 'aria-label': 'Шаблоны контрагента недоступны' });
    expect(renderedText(alert)).toContain('Заявку можно заполнить вручную без шаблона');
    expect(renderedText(alert)).toContain('Каталог временно недоступен');
    const retry = alert.findByType('button');

    await act(async () => {
      retry.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByType(IntakeCreateSurface).props.counterpartyCatalog).toEqual([
      expect.objectContaining({ id: 'cp-live' }),
    ]);
    const requestSignals = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).signal);
    expect(requestSignals).toEqual([
      expect.any(AbortSignal),
      expect.any(AbortSignal),
      expect.any(AbortSignal),
    ]);
    act(() => renderer.unmount());
  });

  it('sends user-edited values together with the selected immutable template version', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        counterparty: 'Backend Клиент',
        templateId: 'tpl-live',
        templateVersionId: 'tplv-live-3',
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            filmType: 'Полотно',
            actualThickness: '42 мкм',
            plannedWeightKg: '33.5',
          },
        ],
      },
      counterpartyId: 'cp-live',
      clientRequestId: '00000000-0000-4000-8000-000000000101',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command).toMatchObject({
      counterpartyId: 'cp-live',
      templateId: 'tpl-live',
      templateVersionId: 'tplv-live-3',
      clientRequestId: '00000000-0000-4000-8000-000000000101',
      positions: [
        {
          filmType: 'Полотно',
          actualThickness: '42 мкм',
          plannedWeightKg: 33.5,
        },
      ],
    });
  });

  it('serializes required roll dimensions as numbers in the live create payload', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            widthMm: '40',
            plannedLengthM: '30',
          },
        ],
      },
      counterpartyId: 'cp-live',
      clientRequestId: '00000000-0000-4000-8000-000000000102',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command.positions[0]).toMatchObject({
      widthMm: 40,
      plannedLengthM: 30,
    });
  });

  it('includes the trimmed general comment in the create payload', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        comment: '  Позвонить перед запуском  ',
      },
      counterpartyId: 'cp-live',
      clientRequestId: '00000000-0000-4000-8000-000000000103',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command.comment).toBe('Позвонить перед запуском');
  });

  it('reuses one client request id after a failed submission retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ message: ['Позиция некорректна'] }),
      })
      .mockResolvedValueOnce(okResponse({ id: 'order-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      form: { ...defaultIntakeDraft, counterparty: 'Backend Клиент', templateId: undefined },
      counterparties: [
        { id: 'cp-live', displayName: 'Backend Клиент', legalName: 'ООО Backend Клиент' },
      ],
      templates: [],
      creatorRole: 'commercial' as const,
      mode: 'submit' as const,
      clientRequestId: '00000000-0000-4000-8000-000000000102',
    };

    await expect(createCommercialOrderFromIntake(request)).rejects.toThrow('Позиция некорректна');
    await expect(createCommercialOrderFromIntake(request)).resolves.toEqual({ id: 'order-1' });

    const requestIds = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.clientRequestId;
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/orders',
      '/api/commercial/orders',
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string)),
    ).toEqual([
      expect.objectContaining({ counterpartyId: 'cp-live' }),
      expect.objectContaining({ counterpartyId: 'cp-live' }),
    ]);
    expect(requestIds).toEqual([
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000102',
    ]);
  });

  it('preserves the actual RECIPE_VERSION_STALE code for local catalog recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: 'RECIPE_VERSION_STALE',
          message: 'Версия рецептуры устарела',
        }),
      }),
    );
    const request = {
      form: {
        ...defaultIntakeDraft,
        counterparty: 'Backend Клиент',
        templateId: undefined,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            baseRawMaterialDefinitionId: '',
            recipeDefinitionVersionId: 'recipe-green-v3',
          },
        ],
      },
      counterparties: [
        { id: 'cp-live', displayName: 'Backend Клиент', legalName: 'ООО Backend Клиент' },
      ],
      templates: [],
      creatorRole: 'commercial' as const,
      mode: 'submit' as const,
      clientRequestId: '00000000-0000-4000-8000-000000000104',
    };

    const error = await createCommercialOrderFromIntake(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'RECIPE_VERSION_STALE',
      message: 'Версия рецептуры устарела',
    });
    expect(request.form.comment).toBe(defaultIntakeDraft.comment);
    expect(request.clientRequestId).toBe('00000000-0000-4000-8000-000000000104');
  });

  it('reloads stale catalogs, preserves draft and UUID, gates retry, then rotates only after success', async () => {
    const postedBodies: Array<Record<string, unknown>> = [];
    let orderAttempt = 0;
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/commercial/counterparties/search?limit=20') {
        return okResponse({
          items: [
            {
              id: 'cp-live',
              displayName: 'Backend Клиент',
              legalName: 'ООО Backend Клиент',
              inn: null,
              billingSource: 'manual',
              syncStatus: 'synced',
            },
          ],
          nextCursor: null,
        });
      }
      if (path === '/api/commercial/counterparties/cp-live/templates') {
        return okResponse([]);
      }
      if (path === '/api/commercial/orders' && init?.method === 'POST') {
        postedBodies.push(JSON.parse(init.body as string));
        orderAttempt += 1;
        if (orderAttempt === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              code: 'RECIPE_VERSION_STALE',
              message: 'Версия рецептуры устарела',
            }),
          };
        }
        return okResponse({ id: `order-${orderAttempt}` });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const reload = vi.fn(async () => undefined);
    const form = {
      ...defaultIntakeDraft,
      counterparty: 'Backend Клиент',
      templateId: undefined,
      comment: 'Черновик должен сохраниться',
      positions: [
        {
          ...defaultIntakeDraft.positions[0],
          id: 'stale-recipe-position',
          baseRawMaterialDefinitionId: '',
          recipeDefinitionVersionId: 'recipe-green-v3',
        },
      ],
    };
    const onChange = vi.fn();
    const onCreated = vi.fn();
    const oldRecipe = {
      id: 'recipe-green',
      name: 'Зелёная 30/70',
      version: {
        id: 'recipe-green-v3',
        version: 3,
        ingredients: [
          {
            rawMaterialDefinitionId: 'rmd-base-primary',
            name: 'Первичное',
            shareBasisPoints: 10_000,
          },
        ],
      },
    };
    const renderForm = (nextForm: typeof form, recipes = [oldRecipe]) =>
      createElement(CommercialIntakeForm, {
        value: nextForm,
        onChange,
        onClose: vi.fn(),
        onCreated,
        recipes,
        materialCatalogStatus: 'ready' as const,
        onReloadMaterialCatalog: reload,
      });
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(renderForm(form));
      await Promise.resolve();
      await Promise.resolve();
    });

    let surface = renderer.root.findByType(IntakeCreateSurface);
    await act(async () => {
      await surface.props.onSubmit('order');
    });
    surface = renderer.root.findByType(IntakeCreateSurface);

    expect(reload).toHaveBeenCalledOnce();
    expect(surface.props.value.comment).toBe('Черновик должен сохраниться');
    expect(surface.props.value.positions[0].recipeDefinitionVersionId).toBe('recipe-green-v3');
    expect(surface.props.materialSelectionInvalidPositionIds.has('stale-recipe-position')).toBe(
      true,
    );
    const firstRequestId = postedBodies[0].clientRequestId;

    const replacementRecipe = {
      ...oldRecipe,
      id: 'recipe-replacement',
      name: 'Новая рецептура',
      version: { ...oldRecipe.version, id: 'recipe-replacement-v1', version: 1 },
    };
    const externallyUpdatedForm = {
      ...form,
      positions: [
        {
          ...form.positions[0],
          recipeDefinitionVersionId: replacementRecipe.version.id,
          rawMaterial: replacementRecipe.name,
        },
      ],
    };
    await act(async () => {
      renderer.update(renderForm(externallyUpdatedForm, [oldRecipe, replacementRecipe]));
      await Promise.resolve();
    });
    surface = renderer.root.findByType(IntakeCreateSurface);
    expect(surface.props.materialSelectionInvalidPositionIds.size).toBe(0);

    await act(async () => {
      await surface.props.onSubmit('order');
    });
    surface = renderer.root.findByType(IntakeCreateSurface);
    await act(async () => {
      await surface.props.onSubmit('order');
    });

    expect(postedBodies[1].clientRequestId).toBe(firstRequestId);
    expect(postedBodies[2].clientRequestId).not.toBe(firstRequestId);
  });

  it('omits an unknown finance amount instead of serializing zero', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'order-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await handoffCommercialOrderToFinance('order-1');

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/commercial/orders/order-1/invoice-handoff');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('keeps form values and request id after server validation fails', () => {
    const edited = {
      ...defaultIntakeDraft,
      comment: 'Не терять этот текст',
    };
    const initial = createCommercialIntakeState(edited, '00000000-0000-4000-8000-000000000103');
    const submitting = commercialIntakeReducer(initial, { type: 'submission_started' });
    const failed = commercialIntakeReducer(submitting, {
      type: 'submission_failed',
      message: 'Позиция некорректна',
    });

    expect(failed.form).toEqual(edited);
    expect(failed.clientRequestId).toBe('00000000-0000-4000-8000-000000000103');
    expect(failed).toMatchObject({ status: 'error', error: 'Позиция некорректна' });
  });
});
