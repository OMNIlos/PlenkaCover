import { afterEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { fetchCommercialCounterparties, searchCommercialCounterparties } from './api';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const canonical = {
  id: 'cp-server-1',
  displayName: 'Клиент 1',
  legalName: null,
  inn: null,
  billingSource: 'manual_platform',
  syncStatus: 'ready',
};

afterEach(() => vi.unstubAllGlobals());

it('strictly reads the exact counterparty projection with the caller signal', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(response([canonical]));
  vi.stubGlobal('fetch', fetchMock);

  await expect(fetchCommercialCounterparties({ signal: controller.signal })).resolves.toEqual([
    canonical,
  ]);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/commercial/counterparties',
    expect.objectContaining({ signal: controller.signal }),
  );
});

it.each([
  [
    'missing legalName',
    (() => {
      const { legalName: _removed, ...rest } = canonical;
      return [rest];
    })(),
  ],
  ['wrong billing source type', [{ ...canonical, billingSource: 1 }]],
  ['duplicate id', [canonical, { ...canonical }]],
  ['extra raw payload', [{ ...canonical, rawPayload: { source: 'internal' } }]],
  ['not an array', { items: [canonical] }],
])('rejects a malformed counterparty 2xx response: %s', async (_label, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
  await expect(fetchCommercialCounterparties()).rejects.toThrow(
    'Некорректный ответ справочника контрагентов',
  );
});

it('propagates the backend hard-cap 422 without fixtures or fallback rows', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        response(
          { message: 'Справочник превышает безопасный лимит.', code: 'LIMIT_EXCEEDED' },
          422,
        ),
      ),
  );

  await expect(fetchCommercialCounterparties()).rejects.toBeInstanceOf(ApiError);
});

it('searches a bounded server page with cursor and caller cancellation', async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(
    response({
      items: [canonical],
      nextCursor: 'next-page',
    }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    searchCommercialCounterparties(
      { q: '  Клиент 1  ', limit: 20, cursor: 'current-page' },
      { signal: controller.signal },
    ),
  ).resolves.toEqual({ items: [canonical], nextCursor: 'next-page' });
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/commercial/counterparties/search?q=%D0%9A%D0%BB%D0%B8%D0%B5%D0%BD%D1%82+1&limit=20&cursor=current-page',
    expect.objectContaining({ signal: controller.signal }),
  );
});

it('never asks the bounded search endpoint for more than 50 rows', async () => {
  const fetchMock = vi.fn().mockResolvedValue(response({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetchMock);

  await searchCommercialCounterparties({ limit: 500 });

  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/commercial/counterparties/search?limit=50');
});

it.each([
  ['raw array', [canonical]],
  ['missing cursor', { items: [canonical] }],
  ['malformed item', { items: [{ ...canonical, id: '' }], nextCursor: null }],
  ['raw item', { items: [{ ...canonical, rawPayload: 'private' }], nextCursor: null }],
])('rejects a malformed bounded-search response: %s', async (_label, body) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

  await expect(searchCommercialCounterparties()).rejects.toThrow(
    'Некорректный ответ поиска контрагентов',
  );
});
