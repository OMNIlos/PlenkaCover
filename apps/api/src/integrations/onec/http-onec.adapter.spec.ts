import { HttpOneCAdapter } from './http-onec.adapter';
import type { OneCRuntimeOptions } from '../../common/onec-runtime-options';
import counterparties from './__fixtures__/counterparties.json';
import productionMaterialLines from './__fixtures__/production-material-lines.json';
import productionOutputLines from './__fixtures__/production-output-lines.json';
import productionReport from './__fixtures__/production-report.json';

describe('HttpOneCAdapter (real read, flag-gated) — offline via stubbed fetch', () => {
  const options: OneCRuntimeOptions = {
    baseUrl: 'https://demo.example/odata',
    goodsAccountKey: 'goods-key',
    orgKey: 'org-key',
    password: 'p',
    stockNomenclature: 'PLENKA-TEST-Сырьё',
    timeoutMs: 5_000,
    username: 'u',
    warehouseKey: 'warehouse-key',
    writeEnabled: false,
    invoiceOrderReferenceField: null,
  };

  function withFetch(body: unknown, ok = true) {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  function abortingFetch(secret = 'request-secret-sentinel') {
    return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error(`aborted ${secret}`);
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    });
  }

  function adapterWithFetch(
    request: jest.Mock,
    overrides: Partial<OneCRuntimeOptions> = {},
  ): HttpOneCAdapter {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('global-fetch-secret-must-not-be-used')) as typeof fetch;
    const Adapter = HttpOneCAdapter as unknown as new (
      value: Readonly<OneCRuntimeOptions>,
      fetchFn: typeof fetch,
    ) => HttpOneCAdapter;
    return new Adapter({ ...options, timeoutMs: 100, ...overrides }, request as typeof fetch);
  }

  function abortPromise(init: RequestInit | undefined, secret: string): Promise<never> {
    return new Promise((_resolve, reject) => {
      const abort = () => {
        const error = new Error(`aborted ${secret}`);
        error.name = 'AbortError';
        reject(error);
      };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  afterEach(() => {
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  it('pullCounterparties maps the OData body via the pure mapper', async () => {
    withFetch(counterparties);
    const adapter = new HttpOneCAdapter(options);
    const snaps = await adapter.pullCounterparties({ top: 3 });
    const rec = (counterparties as any).value[0];
    expect(snaps[0].externalId).toBe(rec.Ref_Key);
    expect(snaps[0].sourceKind).toBe('1C');
    expect((global as any).fetch).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded 250-row page with stable Ref_Key ordering', async () => {
    withFetch({ value: [] });
    const adapter = new HttpOneCAdapter(options);

    await adapter.pullCounterparties({ skip: 250 });

    const url = new URL((global as any).fetch.mock.calls[0][0]);
    expect(url.searchParams.get('$orderby')).toBe('Ref_Key asc');
    expect(url.searchParams.get('$top')).toBe('250');
    expect(url.searchParams.get('$skip')).toBe('250');
  });

  it('resolves nomenclature kind and unit names before mapping exact display names', async () => {
    const kindId = '11111111-1111-1111-1111-111111111111';
    const unitId = '22222222-2222-2222-2222-222222222222';
    const request = jest.fn().mockImplementation((urlValue: string) => {
      const url = new URL(urlValue);
      const pathname = decodeURIComponent(url.pathname);
      const value = pathname.includes('Catalog_ВидыНоменклатуры')
        ? [{ Ref_Key: kindId, Description: 'Сырье' }]
        : pathname.includes('Catalog_КлассификаторЕдиницИзмерения')
          ? [{ Ref_Key: unitId, Description: 'кг' }]
          : [
              {
                Ref_Key: '33333333-3333-3333-3333-333333333333',
                Code: '0001',
                Description: 'Короткое',
                НаименованиеПолное: 'ПВД 15803-020',
                ВидНоменклатуры_Key: kindId,
                ЕдиницаИзмерения_Key: unitId,
              },
            ];
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ value }) });
    });
    const adapter = adapterWithFetch(request);

    const result = await adapter.pullNomenclature();

    expect(result[0].parsed).toMatchObject({
      name: 'ПВД 15803-020',
      kindName: 'Сырье',
      unitName: 'кг',
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('resolves an allowed balance account by exact Code and filters by its GUID', async () => {
    const accountId = '44444444-4444-4444-4444-444444444444';
    const organizationId = '55555555-5555-5555-5555-555555555555';
    const nomenclatureId = '66666666-6666-6666-6666-666666666666';
    const request = jest.fn().mockImplementation((urlValue: string) => {
      const url = new URL(urlValue);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('ChartOfAccounts_Хозрасчетный')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            value: [{ Ref_Key: accountId, Code: '10.01', Description: 'Сырье и материалы' }],
          }),
        });
      }
      expect(url.searchParams.get('$filter')).toBe(`Account_Key eq guid'${accountId}'`);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          value: [
            {
              Account_Key: accountId,
              Организация_Key: organizationId,
              ExtDimension1: nomenclatureId,
              ExtDimension1_Type: 'StandardODATA.Catalog_Номенклатура',
              КоличествоBalance: 2,
              СуммаBalance: 20,
            },
          ],
        }),
      });
    });
    const adapter = adapterWithFetch(request);

    const result = await adapter.pullBalances('10.01');

    expect(result[0].parsed).toMatchObject({
      accountCode: '10.01',
      nomenclatureExternalId: nomenclatureId,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads invoice tabular parts as a separately paged stable line stream', async () => {
    const invoiceId = '77777777-7777-7777-7777-777777777777';
    const nomenclatureId = '88888888-8888-8888-8888-888888888888';
    withFetch({
      value: [
        {
          Ref_Key: invoiceId,
          LineNumber: 1,
          Номенклатура: nomenclatureId,
          Содержание: 'ПВД',
          Количество: 2,
          Цена: 3,
          Сумма: 6,
        },
      ],
    });
    const adapter = new HttpOneCAdapter(options);

    const result = await adapter.pullInvoiceLines({ skip: 250 });

    const url = new URL((global as any).fetch.mock.calls[0][0]);
    expect(url.searchParams.get('$orderby')).toBe('Ref_Key asc,LineNumber asc');
    expect(url.searchParams.get('$skip')).toBe('250');
    expect(result[0]).toMatchObject({
      invoiceExternalId: invoiceId,
      parsed: { nomenclatureExternalId: nomenclatureId, amount: 6 },
    });
  });

  it('requests only fields published for shipment goods lines', async () => {
    withFetch({ value: [] });
    const adapter = new HttpOneCAdapter(options);

    await adapter.pullShipmentLines();

    const url = new URL((global as any).fetch.mock.calls[0][0]);
    expect(url.searchParams.get('$select')).not.toContain('Содержание');
    expect(url.searchParams.get('$select')).toContain('Номенклатура_Key');
    expect(url.searchParams.get('$select')).toContain('ЕдиницаИзмерения_Key');
  });

  it('reads production headers and lines with stable pagination and safe selects', async () => {
    const fetchMock = jest.fn().mockImplementation((urlValue: string) => {
      const pathname = decodeURIComponent(new URL(urlValue).pathname);
      const body = pathname.endsWith('/Document_ОтчетПроизводстваЗаСмену')
        ? productionReport
        : pathname.endsWith('/Document_ОтчетПроизводстваЗаСмену_Продукция')
          ? productionOutputLines
          : pathname.endsWith('/Document_ОтчетПроизводстваЗаСмену_Материалы')
            ? productionMaterialLines
            : pathname.includes('Catalog_КлассификаторЕдиницИзмерения')
              ? {
                  value: [
                    { Ref_Key: '66666666-6666-6666-6666-666666666666', Description: 'кг' },
                    { Ref_Key: '88888888-8888-8888-8888-888888888888', Description: 'шт' },
                  ],
                }
              : { value: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    });
    const adapter = adapterWithFetch(fetchMock);

    const [reports, outputLines, materialLines] = await Promise.all([
      adapter.pullProductionReports({ top: 25, skip: 50 }),
      adapter.pullProductionOutputLines({ top: 25, skip: 50 }),
      adapter.pullProductionMaterialLines({ top: 25, skip: 50 }),
    ]);

    const requests = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    const productionRequests = requests.filter((request) =>
      decodeURIComponent(request.pathname).includes('Document_ОтчетПроизводстваЗаСмену'),
    );
    const reportRequest = productionRequests.find((request) =>
      decodeURIComponent(request.pathname).endsWith('/Document_ОтчетПроизводстваЗаСмену'),
    );
    const lineRequests = productionRequests.filter((request) =>
      request.searchParams.get('$select')?.includes('LineNumber'),
    );
    const selectedFields = productionRequests
      .map((request) => request.searchParams.get('$select') ?? '')
      .join(',');
    const nomenclatureKindRequests = requests.filter((request) =>
      decodeURIComponent(request.pathname).includes('Catalog_ВидыНоменклатуры'),
    );

    expect(reportRequest?.searchParams.get('$orderby')).toBe('Ref_Key asc');
    expect(lineRequests).toHaveLength(2);
    expect(
      lineRequests.every(
        (request) => request.searchParams.get('$orderby') === 'Ref_Key asc,LineNumber asc',
      ),
    ).toBe(true);
    expect(selectedFields).not.toContain('Ответственный');
    expect(selectedFields).not.toContain('ПлановаяСтоимость');
    expect(selectedFields).not.toContain('Себестоимость');
    expect(nomenclatureKindRequests).toHaveLength(0);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === undefined)).toBe(true);
    expect(reports).toHaveLength(1);
    expect(outputLines.map((line) => line.parsed.unitName)).toEqual(['кг', 'шт']);
    expect(materialLines[0].parsed.unitName).toBe('кг');
  });

  it('checks connection with a bounded minimal read and safe endpoint label', async () => {
    withFetch({ value: [] });
    const adapter = new HttpOneCAdapter(options);

    const result = await adapter.checkHealth();

    expect(result).toMatchObject({
      mode: 'http',
      status: 'ready',
      endpointLabel: 'https://demo.example',
    });
    expect((global as any).fetch.mock.calls[0][0]).toContain('Catalog_Контрагенты');
    expect((global as any).fetch.mock.calls[0][0]).toContain('%24top=1');
    expect(JSON.stringify(result)).not.toMatch(/Basic|password|authorization|\/odata/i);
  });

  it('maps an HTTP auth failure to a safe unavailable result', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    const adapter = new HttpOneCAdapter(options);

    const result = await adapter.checkHealth();

    expect(result).toMatchObject({
      mode: 'http',
      status: 'unavailable',
      errorCategory: 'auth',
    });
    expect(JSON.stringify(result)).not.toMatch(/Basic|u:p|c2VjcmV0/i);
  });

  it('maps a network error to a sanitized result', async () => {
    (global as any).fetch = jest
      .fn()
      .mockRejectedValue(new Error('request failed with Basic c2VjcmV0'));
    const adapter = new HttpOneCAdapter(options);

    const result = await adapter.checkHealth();

    expect(result).toMatchObject({
      mode: 'http',
      status: 'unavailable',
      errorCategory: 'network',
      message: '1С connection check failed.',
    });
    expect(JSON.stringify(result)).not.toContain('c2VjcmV0');
  });

  it('bounds health through the injected abort-aware fetch seam', async () => {
    jest.useFakeTimers();
    const request = abortingFetch('health-secret-sentinel');
    const adapter = adapterWithFetch(request);
    const resultPromise = adapter.checkHealth();

    await jest.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'unavailable', errorCategory: 'timeout' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain('health-secret-sentinel');
  });

  it('bounds operational GET including response JSON and sanitizes the timeout', async () => {
    jest.useFakeTimers();
    const request = jest.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => abortPromise(init, 'json-secret-sentinel'),
      }),
    );
    const adapter = adapterWithFetch(request);
    const failurePromise = adapter.pullCounterparties().then(
      () => null,
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(100);
    const failure = await failurePromise;

    expect(failure).toMatchObject({ name: 'OneCRequestTimeoutError', code: 'ONEC_TIMEOUT' });
    expect(String((failure as Error).message)).not.toContain('json-secret-sentinel');
    expect(JSON.stringify(failure)).not.toContain('json-secret-sentinel');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('does not retry a timed-out document POST and reports outcome unknown', async () => {
    jest.useFakeTimers();
    const request = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (request.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ value: [{ Ref_Key: 'NOM-1' }] }),
        });
      }
      expect(url).toContain('Document_ОприходованиеТоваров');
      expect(init?.method).toBe('POST');
      return abortPromise(init, 'post-secret-sentinel');
    });
    const adapter = adapterWithFetch(request, { writeEnabled: true });
    const failurePromise = adapter.pushStock([{ materialId: 'rm-1', qty: 1, unit: 'кг' }]).then(
      () => null,
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(100);
    const failure = await failurePromise;

    expect(failure).toMatchObject({
      name: 'OneCWriteOutcomeUnknownError',
      code: 'ONEC_WRITE_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(String((failure as Error).message)).toMatch(/outcome is unknown/i);
    expect(String((failure as Error).message)).not.toContain('post-secret-sentinel');
    expect(JSON.stringify(failure)).not.toContain('post-secret-sentinel');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry a timed-out action and reports outcome unknown', async () => {
    jest.useFakeTimers();
    const request = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (request.mock.calls.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ value: [{ Ref_Key: 'NOM-1' }] }),
        });
      }
      if (request.mock.calls.length === 2) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ Ref_Key: 'DOC-1', Number: 'DOC-1' }),
        });
      }
      expect(url).toContain('/Post');
      expect(init?.method).toBe('POST');
      return abortPromise(init, 'action-secret-sentinel');
    });
    const adapter = adapterWithFetch(request, { writeEnabled: true });
    const failurePromise = adapter.pushStock([{ materialId: 'rm-1', qty: 1, unit: 'кг' }]).then(
      () => null,
      (error: unknown) => error,
    );

    await jest.advanceTimersByTimeAsync(100);
    const failure = await failurePromise;

    expect(failure).toMatchObject({
      name: 'OneCWriteOutcomeUnknownError',
      code: 'ONEC_WRITE_OUTCOME_UNKNOWN',
      retryable: false,
    });
    expect(String((failure as Error).message)).not.toContain('action-secret-sentinel');
    expect(JSON.stringify(failure)).not.toContain('action-secret-sentinel');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('throws a clear error on a non-2xx OData response', async () => {
    withFetch({ error: 'boom' }, false);
    const adapter = new HttpOneCAdapter(options);
    await expect(adapter.pullCounterparties()).rejects.toThrow(/OData/);
  });

  it('rejects a non-GUID invoice identity before fetch instead of returning an arbitrary invoice', async () => {
    withFetch({ value: [] });
    const adapter = new HttpOneCAdapter(options);

    await expect(adapter.pullInvoice('internal-commercial-order-id')).rejects.toThrow(
      /ONEC_INVOICE_EXTERNAL_ID_REQUIRED/,
    );
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('scans bounded invoice pages once and matches the configured marker and number exactly', async () => {
    const invoiceId = '77777777-7777-4777-8777-777777777777';
    const firstPage = Array.from({ length: 250 }, (_, index) => ({
      Ref_Key: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      DataVersion: `noise-${index}`,
      Number: `СЧ-NOISE-${index}`,
      Posted: true,
      СуммаДокумента: 1,
      КомментарийПлатформы: `не связанный комментарий ${index}`,
    }));
    const request = jest.fn().mockImplementation((urlValue: string) => {
      const skip = new URL(urlValue).searchParams.get('$skip');
      const value =
        skip === '250'
          ? [
              {
                Ref_Key: invoiceId,
                DataVersion: 'v1',
                Number: 'СЧ-0042',
                Posted: true,
                СуммаДокумента: 1200,
                КомментарийПлатформы: "PLENKA_ORDER=ЗК-'0042",
              },
            ]
          : firstPage;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ value }),
      });
    });
    const adapter = adapterWithFetch(request, {
      invoiceOrderReferenceField: 'КомментарийПлатформы',
    });

    const result = await adapter.findInvoicesByOrderReference("PLENKA_ORDER=ЗК-'0042");
    const byNumber = await adapter.findInvoicesByExactNumber('СЧ-0042');

    expect(result).toMatchObject([
      {
        externalId: invoiceId,
        parsed: { orderReference: "PLENKA_ORDER=ЗК-'0042" },
      },
    ]);
    expect(byNumber).toMatchObject([{ externalId: invoiceId, parsed: { invoiceNo: 'СЧ-0042' } }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      request.mock.calls.map(([urlValue]) => new URL(urlValue).searchParams.get('$filter')),
    ).toEqual([null, null]);
    expect(
      request.mock.calls.map(([urlValue]) => new URL(urlValue).searchParams.get('$skip')),
    ).toEqual([null, '250']);
  });

  it('fails closed when the live invoice marker field is not configured', async () => {
    const request = jest.fn();
    const adapter = adapterWithFetch(request);

    await expect(adapter.findInvoicesByOrderReference('PLENKA_ORDER=ЗК-0042')).rejects.toThrow(
      /ONEC_INVOICE_ORDER_REFERENCE_FIELD_REQUIRED/,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('pulls one invoice by Ref_Key together with its exact lines', async () => {
    const invoiceId = '77777777-7777-4777-8777-777777777777';
    const request = jest.fn().mockImplementation((urlValue: string) => {
      const path = decodeURIComponent(new URL(urlValue).pathname);
      const body = path.endsWith('_Товары')
        ? {
            value: [
              {
                Ref_Key: invoiceId,
                LineNumber: 1,
                Количество: 20,
                Цена: 60,
                Сумма: 1200,
              },
            ],
          }
        : {
            Ref_Key: invoiceId,
            DataVersion: 'v2',
            Number: 'СЧ-0042',
            Posted: true,
            СуммаДокумента: 1200,
          };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => body,
      });
    });
    const adapter = adapterWithFetch(request);

    const result = await adapter.pullInvoiceByExternalId(invoiceId);

    expect(request).toHaveBeenCalledTimes(2);
    const lineUrl = new URL(request.mock.calls[1][0]);
    expect(lineUrl.searchParams.get('$filter')).toBe(`Ref_Key eq guid'${invoiceId}'`);
    expect(result.parsed.lines).toEqual([expect.objectContaining({ quantity: 20, amount: 1200 })]);
  });

  it('pushStock refuses to write unless ONEC_WRITE=true', async () => {
    const adapter = new HttpOneCAdapter(options);
    expect(adapter.stockPushConfiguration()).toEqual({ mode: 'http', enabled: false });
    await expect(adapter.pushStock([{ materialId: 'x', qty: 1, unit: 'кг' }])).rejects.toThrow(
      /ONEC_WRITE/,
    );
  });

  it('pushStock creates + posts a Document_ОприходованиеТоваров when enabled (stubbed fetch)', async () => {
    const calls: Array<{ url: string; method?: string; signal?: AbortSignal | null }> = [];
    (global as any).fetch = jest.fn().mockImplementation((url: string, init?: any) => {
      calls.push({ url, method: init?.method, signal: init?.signal });
      const ok = (status: number, body: unknown) =>
        Promise.resolve({ ok: true, status, json: async () => body, text: async () => '' });
      // nomenclature lookup (GET) → not found
      if (url.includes('Catalog_') && init?.method !== 'POST') return ok(200, { value: [] });
      // nomenclature create (POST)
      if (url.includes('Catalog_') && init?.method === 'POST') return ok(201, { Ref_Key: 'NOM-1' });
      // document create (POST) — not the /Post action
      if (url.includes('Document_') && !url.includes('/Post'))
        return ok(201, { Ref_Key: 'DOC-1', Number: 'КП00-000009' });
      // проведение (/Post action)
      if (url.includes('/Post')) return ok(200, {});
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    });
    const adapter = new HttpOneCAdapter({ ...options, writeEnabled: true });
    expect(adapter.stockPushConfiguration()).toEqual({ mode: 'http', enabled: true });
    const ack = await adapter.pushStock([
      { materialId: 'rm-1', qty: 100, unit: 'кг' },
      { materialId: 'rm-2', qty: 5, unit: 'кг' },
    ]);
    expect(ack).toMatchObject({
      accepted: true,
      mode: 'http',
      documentCreated: true,
      count: 2,
      ref: 'КП00-000009',
    });
    // the document was actually posted (проведён), not just created
    expect(calls.some((c) => c.url.includes('/Post') && c.method === 'POST')).toBe(true);
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it('never reports an empty live stock push as a created document', async () => {
    const adapter = new HttpOneCAdapter({ ...options, writeEnabled: true });
    await expect(adapter.pushStock([])).rejects.toThrow(/at least one/i);
  });
});
