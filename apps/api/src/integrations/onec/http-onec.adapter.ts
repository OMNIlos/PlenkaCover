import { Injectable } from '@nestjs/common';
import type {
  OneCCounterpartySnapshot,
  OneCHealthResult,
  OneCInvoiceLineSource,
  OneCInvoiceSnapshot,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
  OneCShipmentLineSource,
  OneCShipmentSnapshot,
  OneCStockSnapshot,
  OneCWarehouseSnapshot,
} from '@plenka/contracts';
import type { OneCRuntimeOptions } from '../../common/onec-runtime-options';
import type {
  OneCAdapter,
  OneCListOptions,
  OneCStockItem,
  OneCStockPushAck,
  OneCStockPushConfiguration,
} from './onec.adapter';
import { mapBalanceRecord, mapCounterpartyRecord, mapList } from './onec.mapper';
import {
  mapProductionMaterialLineRecord,
  mapProductionOutputLineRecord,
  mapProductionReportRecord,
} from './onec-production.mapper';
import {
  mapBalanceRecordWithRefs,
  mapInvoiceLineRecord,
  mapInvoiceRecordWithLines,
  mapNomenclatureRecord,
  mapOrganizationRecord,
  mapPaymentRecordWithBasis,
  mapShipmentLineRecord,
  mapShipmentRecordWithLines,
  mapWarehouseRecord,
  type OneCNomenclatureDictionaries,
} from './onec-sync.mapper';
import { buildGoodsPostingBody, onecDateTime, type GoodsPostingRefs } from './onec.write';

type RequestIntent = 'read' | 'write';
type ODataRecord = Record<string, unknown>;

const DEFAULT_PAGE_SIZE = 250;
const DICTIONARY_TTL_MS = 5 * 60 * 1_000;
const INVOICE_LOOKUP_CACHE_TTL_MS = 60_000;
const MAX_INVOICE_LOOKUP_ROWS = 50_000;

interface InvoiceLookupIndex {
  byNumber: ReadonlyMap<string, readonly OneCInvoiceSnapshot[]>;
  byOrderReference: ReadonlyMap<string, readonly OneCInvoiceSnapshot[]>;
}

export class OneCRequestTimeoutError extends Error {
  readonly code = 'ONEC_TIMEOUT';

  constructor() {
    super('1С request timed out.');
    this.name = 'OneCRequestTimeoutError';
  }
}

export class OneCWriteOutcomeUnknownError extends Error {
  readonly code = 'ONEC_WRITE_OUTCOME_UNKNOWN';
  readonly retryable = false;

  constructor() {
    super('1С write delivery outcome is unknown; reconcile in 1С before retrying.');
    this.name = 'OneCWriteOutcomeUnknownError';
  }
}

class OneCRequestFailedError extends Error {
  constructor() {
    super('1С request failed.');
    this.name = 'OneCRequestFailedError';
  }
}

class OneCHttpResponseError extends Error {}

/**
 * Real 1С OData adapter, flag-gated (`ONEC_LIVE=true`, DI factory in integrations.module).
 * NEVER the default. Basic auth and bounded request policy arrive through one frozen startup
 * options provider; this class never reads mutable environment state.
 * Field mapping is delegated to the pure `onec.mapper` (fixture-tested). Tabular parts would use a
 * nested set, NOT `$expand` (HTTP 501 on this base). `pushStock` is the sole write and remains
 * separately gated; timed-out writes require reconciliation before any manual retry.
 */
@Injectable()
export class HttpOneCAdapter implements OneCAdapter {
  private readonly base: string;
  private readonly auth: string;
  private readonly invoiceOrderReferenceField: string | null;
  private readonly writeEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly writeRefs: Omit<GoodsPostingRefs, 'nomenclatureKey'>;
  private readonly stockNomenclatureName: string;
  private readonly fetchFn: typeof fetch;
  private nomenclatureDictionaries:
    | { expiresAt: number; value: Promise<OneCNomenclatureDictionaries> }
    | undefined;
  private nomenclatureUnitDictionary:
    | { expiresAt: number; value: Promise<ReadonlyMap<string, string>> }
    | undefined;
  private chartAccounts:
    | { expiresAt: number; value: Promise<ReadonlyMap<string, string>> }
    | undefined;
  private invoiceLookupIndex: { expiresAt: number; value: Promise<InvoiceLookupIndex> } | undefined;

  constructor(options: Readonly<OneCRuntimeOptions>, fetchFn: typeof fetch = globalThis.fetch) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;
    this.invoiceOrderReferenceField = normalizeODataField(
      options.invoiceOrderReferenceField,
      'ONEC_INVOICE_ORDER_REFERENCE_FIELD',
    );
    this.writeEnabled = options.writeEnabled;
    this.timeoutMs = options.timeoutMs;
    this.writeRefs = {
      orgKey: options.orgKey,
      warehouseKey: options.warehouseKey,
      accountKey: options.goodsAccountKey,
    };
    this.stockNomenclatureName = options.stockNomenclature;
    this.fetchFn = fetchFn;
  }

  stockPushConfiguration(): OneCStockPushConfiguration {
    return { mode: 'http', enabled: this.writeEnabled };
  }

  private async boundedRequest<T>(
    intent: RequestIntent,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await request(controller.signal);
    } catch (error) {
      if (error instanceof OneCHttpResponseError) throw error;
      if (intent === 'write') throw new OneCWriteOutcomeUnknownError();
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new OneCRequestTimeoutError();
      }
      throw new OneCRequestFailedError();
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth(): Promise<OneCHealthResult> {
    const startedAt = Date.now();
    const baseResult = {
      mode: 'http' as const,
      endpointLabel: safeEndpointLabel(this.base),
    };
    if (!this.base) {
      return {
        ...baseResult,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        errorCategory: 'config',
        message: '1С endpoint is not configured.',
      };
    }

    try {
      const params = new URLSearchParams({
        $format: 'json',
        $top: '1',
        $select: 'Ref_Key',
      });
      const response = await this.boundedRequest('read', (signal) =>
        this.fetchFn(`${this.base}/Catalog_Контрагенты?${params.toString()}`, {
          headers: { Authorization: this.auth },
          signal,
        }),
      );
      if (!response.ok) {
        return {
          ...baseResult,
          status: 'unavailable',
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          errorCategory: response.status === 401 || response.status === 403 ? 'auth' : 'http',
          message:
            response.status === 401 || response.status === 403
              ? '1С authentication failed.'
              : `1С returned HTTP ${response.status}.`,
        };
      }
      return {
        ...baseResult,
        status: 'ready',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ...baseResult,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        errorCategory: error instanceof OneCRequestTimeoutError ? 'timeout' : 'network',
        message:
          error instanceof OneCRequestTimeoutError
            ? '1С connection check timed out.'
            : '1С connection check failed.',
      };
    }
  }

  /** OData create (POST) → returns the created entity (incl. Ref_Key). */
  private async post(entitySet: string, body: unknown): Promise<any> {
    const url = `${this.base}/${entitySet}?$format=json`;
    return this.boundedRequest('write', async (signal) => {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        throw new OneCHttpResponseError(`OData POST ${entitySet} failed: HTTP ${res.status}`);
      }
      return res.json();
    });
  }

  /** OData bound action (POST, no body) — e.g. document `/Post` (проведение). */
  private async callAction(path: string): Promise<void> {
    return this.boundedRequest('write', async (signal) => {
      const res = await this.fetchFn(`${this.base}/${path}`, {
        method: 'POST',
        headers: { Authorization: this.auth },
        signal,
      });
      if (!res.ok) {
        throw new OneCHttpResponseError(`OData action ${path} failed: HTTP ${res.status}`);
      }
    });
  }

  /** Resolve the stock nomenclature by Description; create it (idempotent) if missing. */
  private async ensureStockNomenclature(): Promise<string> {
    const found = await this.get('Catalog_Номенклатура', {
      $top: 1,
      $filter: `Description eq '${this.stockNomenclatureName}'`,
      $select: 'Ref_Key',
    });
    if (found.value?.[0]?.Ref_Key) return found.value[0].Ref_Key;
    const created = await this.post('Catalog_Номенклатура', {
      Description: this.stockNomenclatureName,
    });
    return created.Ref_Key;
  }

  private async get(entitySet: string, params: Record<string, string | number>): Promise<any> {
    // 1С OData wants %20 for spaces in $filter — URLSearchParams emits '+', which 500s. Fix it.
    const qs = new URLSearchParams({ $format: 'json', ...mapToStrings(params) })
      .toString()
      .replace(/\+/g, '%20');
    const url = `${this.base}/${entitySet}?${qs}`;
    return this.boundedRequest('read', async (signal) => {
      const res = await this.fetchFn(url, { headers: { Authorization: this.auth }, signal });
      if (!res.ok) {
        throw new OneCHttpResponseError(`OData GET ${entitySet} failed: HTTP ${res.status}`);
      }
      return res.json();
    });
  }

  private page(opts?: OneCListOptions): Record<string, string | number> {
    const p: Record<string, string | number> = {
      $orderby: 'Ref_Key asc',
      $top: opts?.top ?? DEFAULT_PAGE_SIZE,
    };
    if (opts?.skip) p.$skip = opts.skip;
    return p;
  }

  private balancePage(
    opts: OneCListOptions | undefined,
    accountExternalId: string,
  ): Record<string, string | number> {
    const page: Record<string, string | number> = {
      $top: opts?.top ?? DEFAULT_PAGE_SIZE,
      $filter: `Account_Key eq guid'${accountExternalId}'`,
    };
    if (opts?.skip) page.$skip = opts.skip;
    return page;
  }

  private linePage(opts?: OneCListOptions): Record<string, string | number> {
    const page: Record<string, string | number> = {
      $orderby: 'Ref_Key asc,LineNumber asc',
      $top: opts?.top ?? DEFAULT_PAGE_SIZE,
    };
    if (opts?.skip) page.$skip = opts.skip;
    return page;
  }

  private async loadIdentityDictionary(entitySet: string): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (let skip = 0; ; skip += DEFAULT_PAGE_SIZE) {
      const body = await this.get(entitySet, {
        ...this.page({ top: DEFAULT_PAGE_SIZE, skip }),
        $select: 'Ref_Key,Description',
      });
      const rows = Array.isArray(body.value) ? (body.value as ODataRecord[]) : [];
      for (const row of rows) {
        const key = typeof row.Ref_Key === 'string' ? row.Ref_Key : null;
        const name = typeof row.Description === 'string' ? row.Description.trim() : '';
        if (key && name) result.set(key, name);
      }
      if (rows.length < DEFAULT_PAGE_SIZE) return result;
    }
  }

  private resolveNomenclatureDictionaries(): Promise<OneCNomenclatureDictionaries> {
    const now = Date.now();
    if (this.nomenclatureDictionaries && this.nomenclatureDictionaries.expiresAt > now) {
      return this.nomenclatureDictionaries.value;
    }
    const value = Promise.all([
      this.loadIdentityDictionary('Catalog_ВидыНоменклатуры'),
      this.resolveNomenclatureUnitDictionary(),
    ]).then(([kinds, units]) => ({ kinds, units }));
    this.nomenclatureDictionaries = {
      expiresAt: now + DICTIONARY_TTL_MS,
      value,
    };
    return value;
  }

  private resolveNomenclatureUnitDictionary(): Promise<ReadonlyMap<string, string>> {
    const now = Date.now();
    if (this.nomenclatureUnitDictionary && this.nomenclatureUnitDictionary.expiresAt > now) {
      return this.nomenclatureUnitDictionary.value;
    }
    const value = this.loadIdentityDictionary('Catalog_КлассификаторЕдиницИзмерения');
    this.nomenclatureUnitDictionary = {
      expiresAt: now + DICTIONARY_TTL_MS,
      value,
    };
    return value;
  }

  private resolveChartAccounts(): Promise<ReadonlyMap<string, string>> {
    const now = Date.now();
    if (this.chartAccounts && this.chartAccounts.expiresAt > now) {
      return this.chartAccounts.value;
    }
    const value = this.loadChartAccounts();
    this.chartAccounts = { expiresAt: now + DICTIONARY_TTL_MS, value };
    return value;
  }

  private async loadChartAccounts(): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    for (let skip = 0; ; skip += DEFAULT_PAGE_SIZE) {
      const body = await this.get('ChartOfAccounts_Хозрасчетный', {
        ...this.page({ top: DEFAULT_PAGE_SIZE, skip }),
        $select: 'Ref_Key,Code',
      });
      const rows = Array.isArray(body.value) ? (body.value as ODataRecord[]) : [];
      for (const row of rows) {
        const externalId = typeof row.Ref_Key === 'string' ? row.Ref_Key : null;
        const code = typeof row.Code === 'string' ? row.Code.trim() : '';
        if (externalId && code) result.set(code, externalId);
      }
      if (rows.length < DEFAULT_PAGE_SIZE) return result;
    }
  }

  async pullCounterparties(opts?: OneCListOptions): Promise<OneCCounterpartySnapshot[]> {
    const body = await this.get('Catalog_Контрагенты', {
      ...this.page(opts),
      $filter: 'IsFolder eq false',
      $select: 'Ref_Key,DataVersion,Description,НаименованиеПолное,ИНН,КПП,Code,DeletionMark',
    });
    return mapList(body.value, mapCounterpartyRecord, new Date().toISOString());
  }

  async pullCounterparty(externalId: string): Promise<OneCCounterpartySnapshot> {
    if (!isGuid(externalId)) throw new Error('1С counterparty identity must be a 1С GUID.');
    const body = await this.get(`Catalog_Контрагенты(guid'${externalId}')`, {});
    return mapCounterpartyRecord(body, new Date().toISOString());
  }

  async pullNomenclature(opts?: OneCListOptions): Promise<OneCNomenclatureSnapshot[]> {
    const dictionaries = await this.resolveNomenclatureDictionaries();
    const body = await this.get('Catalog_Номенклатура', {
      ...this.page(opts),
      $filter: 'IsFolder eq false',
      $select:
        'Ref_Key,DataVersion,Code,Description,НаименованиеПолное,Артикул,' +
        'ВидНоменклатуры_Key,ЕдиницаИзмерения_Key,DeletionMark,ВАрхиве',
    });
    const capturedAt = new Date().toISOString();
    return (body.value ?? []).map((record: ODataRecord) =>
      mapNomenclatureRecord(record, dictionaries, capturedAt),
    );
  }

  async pullOrganizations(opts?: OneCListOptions): Promise<OneCOrganizationSnapshot[]> {
    const body = await this.get('Catalog_Организации', {
      ...this.page(opts),
      $select: 'Ref_Key,DataVersion,Code,Description,НаименованиеПолное,ИНН,КПП,DeletionMark',
    });
    return mapList(body.value, mapOrganizationRecord, new Date().toISOString());
  }

  async pullWarehouses(opts?: OneCListOptions): Promise<OneCWarehouseSnapshot[]> {
    const body = await this.get('Catalog_Склады', {
      ...this.page(opts),
      $filter: 'IsFolder eq false',
      $select: 'Ref_Key,DataVersion,Code,Description,ТипСклада,DeletionMark',
    });
    return mapList(body.value, mapWarehouseRecord, new Date().toISOString());
  }

  async pullInvoice(orderRefOrExternalId: string): Promise<OneCInvoiceSnapshot> {
    return this.pullInvoiceByExternalId(orderRefOrExternalId);
  }

  async findInvoicesByOrderReference(orderReference: string): Promise<OneCInvoiceSnapshot[]> {
    const field = this.invoiceOrderReferenceField;
    if (!field) {
      throw new Error(
        'ONEC_INVOICE_ORDER_REFERENCE_FIELD_REQUIRED: exact invoice lookup is not configured.',
      );
    }
    const index = await this.resolveInvoiceLookupIndex();
    return [...(index.byOrderReference.get(orderReference) ?? [])];
  }

  async findInvoicesByExactNumber(invoiceNumber: string): Promise<OneCInvoiceSnapshot[]> {
    const index = await this.resolveInvoiceLookupIndex();
    return [...(index.byNumber.get(invoiceNumber) ?? [])];
  }

  async pullInvoiceByExternalId(externalId: string): Promise<OneCInvoiceSnapshot> {
    if (!isGuid(externalId)) {
      throw new Error('ONEC_INVOICE_EXTERNAL_ID_REQUIRED: invoice identity must be a 1С GUID.');
    }
    const [body, lines] = await Promise.all([
      this.get(`Document_СчетНаОплатуПокупателю(guid'${externalId}')`, {}),
      this.get('Document_СчетНаОплатуПокупателю_Товары', {
        ...this.linePage(),
        $filter: `Ref_Key eq guid'${externalId}'`,
        $select: 'Ref_Key,LineNumber,Номенклатура,Содержание,Количество,Цена,Сумма',
      }),
    ]);
    return mapInvoiceRecordWithLines(
      { ...body, Товары: lines.value ?? [] },
      new Date().toISOString(),
      this.invoiceOrderReferenceField,
    );
  }

  async pullInvoices(opts?: OneCListOptions): Promise<OneCInvoiceSnapshot[]> {
    const body = await this.get('Document_СчетНаОплатуПокупателю', {
      ...this.page(opts),
      $select: this.invoiceHeaderSelect(),
    });
    const capturedAt = new Date().toISOString();
    return (body.value ?? []).map((record: ODataRecord) =>
      mapInvoiceRecordWithLines(record, capturedAt, this.invoiceOrderReferenceField),
    );
  }

  async pullInvoiceLines(opts?: OneCListOptions): Promise<OneCInvoiceLineSource[]> {
    const body = await this.get('Document_СчетНаОплатуПокупателю_Товары', {
      ...this.linePage(opts),
      $select: 'Ref_Key,LineNumber,Номенклатура,Содержание,Количество,Цена,Сумма',
    });
    return (body.value ?? []).map((record: ODataRecord) => mapInvoiceLineRecord(record));
  }

  async pullPayments(opts?: OneCListOptions): Promise<OneCPaymentSnapshot[]> {
    const body = await this.get('Document_ПоступлениеНаРасчетныйСчет', {
      ...this.page(opts),
      // NB: composite `Контрагент` (value), NOT `Контрагент_Key` — the latter 400s on this doc.
      $select:
        'Ref_Key,DataVersion,Number,Date,Posted,DeletionMark,Контрагент,Организация_Key,' +
        'СуммаДокумента,ДокументОснование,ДокументОснование_Type',
    });
    return mapList(body.value, mapPaymentRecordWithBasis, new Date().toISOString());
  }

  private resolveInvoiceLookupIndex(): Promise<InvoiceLookupIndex> {
    const now = Date.now();
    if (this.invoiceLookupIndex && this.invoiceLookupIndex.expiresAt > now) {
      return this.invoiceLookupIndex.value;
    }
    const value = this.loadInvoiceLookupIndex();
    this.invoiceLookupIndex = {
      expiresAt: now + INVOICE_LOOKUP_CACHE_TTL_MS,
      value,
    };
    return value;
  }

  private async loadInvoiceLookupIndex(): Promise<InvoiceLookupIndex> {
    // This published 1C Fresh base rejects WHERE for document strings (including Number and
    // Комментарий). Read stable bounded pages and still require a local exact match; never choose
    // the newest/first invoice as a fallback. The short shared cache coalesces parallel order jobs.
    const byNumber = new Map<string, OneCInvoiceSnapshot[]>();
    const byOrderReference = new Map<string, OneCInvoiceSnapshot[]>();
    const capturedAt = new Date().toISOString();
    for (let skip = 0; skip < MAX_INVOICE_LOOKUP_ROWS; skip += DEFAULT_PAGE_SIZE) {
      const body = await this.get('Document_СчетНаОплатуПокупателю', {
        ...this.page({ top: DEFAULT_PAGE_SIZE, skip }),
        $select: this.invoiceHeaderSelect(),
      });
      const rows = Array.isArray(body.value) ? (body.value as ODataRecord[]) : [];
      for (const row of rows) {
        const snapshot = mapInvoiceRecordWithLines(
          row,
          capturedAt,
          this.invoiceOrderReferenceField,
        );
        const numberMatches = byNumber.get(snapshot.parsed.invoiceNo) ?? [];
        numberMatches.push(snapshot);
        byNumber.set(snapshot.parsed.invoiceNo, numberMatches);
        const orderReference = snapshot.parsed.orderReference;
        if (orderReference) {
          const referenceMatches = byOrderReference.get(orderReference) ?? [];
          referenceMatches.push(snapshot);
          byOrderReference.set(orderReference, referenceMatches);
        }
      }
      if (rows.length < DEFAULT_PAGE_SIZE) return { byNumber, byOrderReference };
    }
    throw new Error(
      `ONEC_INVOICE_LOOKUP_SCAN_LIMIT: more than ${MAX_INVOICE_LOOKUP_ROWS} invoices.`,
    );
  }

  async pullPaymentByExternalId(externalId: string): Promise<OneCPaymentSnapshot> {
    if (!isGuid(externalId)) {
      throw new Error('ONEC_PAYMENT_EXTERNAL_ID_REQUIRED: payment identity must be a 1С GUID.');
    }
    const body = await this.get(`Document_ПоступлениеНаРасчетныйСчет(guid'${externalId}')`, {});
    return mapPaymentRecordWithBasis(body, new Date().toISOString());
  }

  async pullShipments(opts?: OneCListOptions): Promise<OneCShipmentSnapshot[]> {
    const body = await this.get('Document_РеализацияТоваровУслуг', {
      ...this.page(opts),
      $select:
        'Ref_Key,DataVersion,Number,Date,Posted,DeletionMark,Контрагент_Key,' +
        'Организация_Key,СуммаДокумента,СчетНаОплатуПокупателю_Key',
    });
    return mapList(body.value, mapShipmentRecordWithLines, new Date().toISOString());
  }

  async pullShipmentLines(opts?: OneCListOptions): Promise<OneCShipmentLineSource[]> {
    const body = await this.get('Document_РеализацияТоваровУслуг_Товары', {
      ...this.linePage(opts),
      $select: 'Ref_Key,LineNumber,Номенклатура_Key,ЕдиницаИзмерения_Key,Количество,Цена,Сумма',
    });
    return (body.value ?? []).map((record: ODataRecord) => mapShipmentLineRecord(record));
  }

  async pullProductionReports(opts?: OneCListOptions): Promise<OneCProductionReportSnapshot[]> {
    const body = await this.get('Document_ОтчетПроизводстваЗаСмену', {
      ...this.page(opts),
      $select:
        'Ref_Key,DataVersion,Number,Date,Posted,DeletionMark,Организация_Key,' +
        'Склад_Key,ПодразделениеОрганизации_Key',
    });
    const capturedAt = new Date().toISOString();
    return (body.value ?? []).map((record: ODataRecord) =>
      mapProductionReportRecord(record, capturedAt),
    );
  }

  async pullProductionOutputLines(
    opts?: OneCListOptions,
  ): Promise<OneCProductionOutputLineSource[]> {
    const units = await this.resolveNomenclatureUnitDictionary();
    const dictionaries = { kinds: new Map<string, string>(), units };
    const body = await this.get('Document_ОтчетПроизводстваЗаСмену_Продукция', {
      ...this.linePage(opts),
      $select: 'Ref_Key,LineNumber,Номенклатура_Key,ЕдиницаИзмерения_Key,Количество',
    });
    return (body.value ?? []).map((record: ODataRecord) =>
      mapProductionOutputLineRecord(record, dictionaries),
    );
  }

  async pullProductionMaterialLines(
    opts?: OneCListOptions,
  ): Promise<OneCProductionMaterialLineSource[]> {
    const units = await this.resolveNomenclatureUnitDictionary();
    const dictionaries = { kinds: new Map<string, string>(), units };
    const body = await this.get('Document_ОтчетПроизводстваЗаСмену_Материалы', {
      ...this.linePage(opts),
      $select: 'Ref_Key,LineNumber,Номенклатура_Key,Продукция_Key,ЕдиницаИзмерения_Key,Количество',
    });
    return (body.value ?? []).map((record: ODataRecord) =>
      mapProductionMaterialLineRecord(record, dictionaries),
    );
  }

  async pullBalances(
    accountCode: '10.01' | '41.01',
    opts?: OneCListOptions,
  ): Promise<OneCStockSnapshot[]> {
    const accounts = await this.resolveChartAccounts();
    const accountExternalId = accounts.get(accountCode);
    if (!accountExternalId) {
      throw new Error(`1С chart account ${accountCode} is not published.`);
    }
    const body = await this.get('AccountingRegister_Хозрасчетный/Balance', {
      ...this.balancePage(opts, accountExternalId),
      $select:
        'Account_Key,Организация_Key,ExtDimension1,ExtDimension1_Type,' +
        'ExtDimension2,ExtDimension2_Type,ExtDimension3,ExtDimension3_Type,' +
        'КоличествоBalance,СуммаBalance',
    });
    const capturedAt = new Date().toISOString();
    return (body.value ?? []).map((record: ODataRecord) =>
      mapBalanceRecordWithRefs(record, accountCode, capturedAt),
    );
  }

  async pullStock(opts?: OneCListOptions): Promise<OneCStockSnapshot[]> {
    const params: Record<string, string | number> = {
      $top: opts?.top ?? DEFAULT_PAGE_SIZE,
    };
    if (opts?.skip) params.$skip = opts.skip;
    const body = await this.get('AccountingRegister_Хозрасчетный/Balance', params);
    return mapList(body.value, mapBalanceRecord, new Date().toISOString());
  }

  /**
   * The ONE platform → 1С write: post raw-material/roll stock balances as a
   * `Document_ОприходованиеТоваров` (create + `/Post`). Double-gated: needs `ONEC_LIVE=true` (this
   * adapter is bound) AND `ONEC_WRITE=true`. Throws when the write flag is off so nothing writes to
   * 1С by accident (ТЗ §8 / mock-first). Verified live on the demo base.
   */
  async pushStock(items: OneCStockItem[]): Promise<OneCStockPushAck> {
    if (!this.writeEnabled) {
      throw new Error('1С write disabled: set ONEC_WRITE=true to enable stock posting.');
    }
    if (items.length === 0) throw new Error('1С stock push requires at least one item.');
    const nomenclatureKey = await this.ensureStockNomenclature();
    const body = buildGoodsPostingBody(
      items,
      { ...this.writeRefs, nomenclatureKey },
      onecDateTime(new Date()),
    );
    const created = await this.post('Document_ОприходованиеТоваров', body);
    const ref: string = created.Ref_Key;
    const number: string = created.Number;
    await this.callAction(
      `Document_ОприходованиеТоваров(guid'${ref}')/Post?PostingModeOperational=false`,
    );
    return {
      accepted: true,
      mode: 'http',
      documentCreated: true,
      count: items.length,
      ref: number || ref,
    };
  }

  private invoiceHeaderSelect(): string {
    return [
      'Ref_Key',
      'DataVersion',
      'Number',
      'Date',
      'Posted',
      'DeletionMark',
      'Контрагент_Key',
      'Организация_Key',
      'СуммаДокумента',
      'ВалютаДокумента_Key',
      ...(this.invoiceOrderReferenceField ? [this.invoiceOrderReferenceField] : []),
    ].join(',');
  }
}

function mapToStrings(params: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeODataField(value: string | null | undefined, optionName: string): string | null {
  const field = value?.trim() || null;
  if (!field) return null;
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(field)) {
    throw new Error(`${optionName}_INVALID: expected a published OData field name.`);
  }
  return field;
}

function safeEndpointLabel(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}
