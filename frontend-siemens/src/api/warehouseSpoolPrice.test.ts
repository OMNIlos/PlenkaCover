import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWarehouseSpoolStock,
  fetchWarehouseSpoolPriceTypes,
  parseMetersToMillimeters,
  parseSpoolPriceReference,
  parseSpoolStockReceipt,
  parseWarehouseSpoolStock,
  parseWarehouseSpoolPriceTypes,
  recordWarehouseSpoolPrice,
  recordWarehouseSpoolReceipt,
} from './warehouseSpoolPrice';

const PRICE_REFERENCE = {
  id: 'spool-price-1',
  spoolTypeKey: 'шпуля 76 мм',
  spoolTypeLabel: 'Шпуля 76 мм',
  priceKopecksPerMeter: 6_000,
  source: 'Прайс склада',
  effectiveFrom: '2026-08-08T00:00:00.000Z',
  reason: 'Новый прайс поставщика',
  createdById: 'warehouse-user-1',
  createdByRole: 'warehouse',
  createdAt: '2026-08-08T02:00:00.000Z',
} as const;

const SPOOL_RECEIPT = {
  id: 'spool-receipt-1',
  spoolTypeKey: 'шпуля 76 мм',
  spoolTypeLabel: 'Шпуля 76 мм',
  quantityMillimeters: 125_500,
  priceReferenceId: 'spool-price-1',
  priceKopecksPerMeter: 6_000,
  effectiveFrom: '2026-08-08T00:00:00.000Z',
  receivedAt: '2026-08-08T00:00:00.000Z',
  receivedById: 'warehouse-user-1',
  receivedByRole: 'warehouse',
  createdAt: '2026-08-08T02:00:00.000Z',
} as const;

const SPOOL_STOCK = [
  {
    spoolTypeKey: 'тонкая',
    spoolTypeLabel: 'Тонкая',
    totalReceivedMillimeters: 125_500,
    lastReceivedAt: '2026-08-08T02:00:00.000Z',
  },
  {
    spoolTypeKey: 'толстая',
    spoolTypeLabel: 'Толстая',
    totalReceivedMillimeters: 0,
    lastReceivedAt: null,
  },
] as const;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warehouse spool-price API', () => {
  it('parses positive meters to exact integer millimeters without exponent notation', () => {
    expect(parseMetersToMillimeters('1')).toBe(1_000);
    expect(parseMetersToMillimeters('1,5')).toBe(1_500);
    expect(parseMetersToMillimeters('0.001')).toBe(1);
    for (const value of ['', '0', '-1', '1.0001', '1e3']) {
      expect(parseMetersToMillimeters(value)).toBeNull();
    }
  });

  it('loads the bounded canonical spool catalog from its nonphysical route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response([
        { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
        { key: 'шпуля 152 мм', label: 'Шпуля 152 мм' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWarehouseSpoolPriceTypes()).resolves.toEqual([
      { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
      { key: 'шпуля 152 мм', label: 'Шпуля 152 мм' },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/warehouse/spool-price-types');
  });

  it.each([
    ['non-array', { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' }],
    ['extra field', [{ key: 'шпуля 76 мм', label: 'Шпуля 76 мм', raw: true }]],
    ['blank label', [{ key: 'шпуля 76 мм', label: '' }]],
    ['invented key', [{ key: 'spool:76-mm', label: 'Шпуля 76 мм' }]],
    ['noncanonical key', [{ key: 'Шпуля 76 мм', label: 'Шпуля 76 мм' }]],
    [
      'duplicate key',
      [
        { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
        { key: 'шпуля 76 мм', label: 'Шпуля другая' },
      ],
    ],
    [
      'duplicate label',
      [
        { key: 'шпуля 76 мм', label: 'Шпуля 76 мм' },
        { key: 'шпуля 152 мм', label: 'Шпуля 76 мм' },
      ],
    ],
    [
      'unbounded response',
      Array.from({ length: 201 }, (_, index) => ({
        key: `шпуля ${index}`,
        label: `Шпуля ${index}`,
      })),
    ],
  ])('rejects an unsafe spool catalog: %s', (_label, value) => {
    expect(() => parseWarehouseSpoolPriceTypes(value)).toThrow('Некорректный справочник шпуль');
  });

  it('posts only the append-only price command and parses a create or replay identically', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(PRICE_REFERENCE));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      recordWarehouseSpoolPrice({
        operationKey: '11111111-1111-4111-8111-111111111111',
        spoolTypeLabel: 'Шпуля 76 мм',
        priceKopecksPerMeter: 6_000,
        source: 'Прайс склада',
        effectiveFrom: '2026-08-08T00:00:00.000Z',
        reason: 'Новый прайс поставщика',
      }),
    ).resolves.toEqual(PRICE_REFERENCE);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/warehouse/spool-price-references');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: '11111111-1111-4111-8111-111111111111',
      spoolTypeLabel: 'Шпуля 76 мм',
      priceKopecksPerMeter: 6_000,
      source: 'Прайс склада',
      effectiveFrom: '2026-08-08T00:00:00.000Z',
      reason: 'Новый прайс поставщика',
    });
  });

  it.each([
    ['unsafe price', { ...PRICE_REFERENCE, priceKopecksPerMeter: Number.MAX_SAFE_INTEGER + 1 }],
    ['invented response key', { ...PRICE_REFERENCE, spoolTypeKey: 'spool:76-mm' }],
    ['legacy role alias', { ...PRICE_REFERENCE, createdByRole: 'production' }],
    ['noncanonical effective date', { ...PRICE_REFERENCE, effectiveFrom: '2026-08-08' }],
    ['non-finite effective date', { ...PRICE_REFERENCE, effectiveFrom: 'not-a-date' }],
    ['noncanonical created date', { ...PRICE_REFERENCE, createdAt: '2026-08-08' }],
    ['non-finite created date', { ...PRICE_REFERENCE, createdAt: 'not-a-date' }],
    ['extra raw field', { ...PRICE_REFERENCE, rawPayload: { supplier: 'secret' } }],
  ])('rejects an unsafe price response: %s', (_label, value) => {
    expect(() => parseSpoolPriceReference(value)).toThrow('Некорректная цена шпули');
  });

  it('accepts the exact backend production-lead role name', () => {
    expect(
      parseSpoolPriceReference({
        ...PRICE_REFERENCE,
        createdByRole: 'production_lead',
      }).createdByRole,
    ).toBe('production_lead');
  });

  it('posts the atomic receipt command and parses its exact response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(SPOOL_RECEIPT));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      recordWarehouseSpoolReceipt({
        operationKey: '11111111-1111-4111-8111-111111111111',
        spoolTypeLabel: 'Шпуля 76 мм',
        priceKopecksPerMeter: 6_000,
        quantityMillimeters: 125_500,
        source: 'Прайс склада',
        effectiveFrom: '2026-08-08T00:00:00.000Z',
        reason: 'Цена и приход шпули записаны складом',
      }),
    ).resolves.toEqual(SPOOL_RECEIPT);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/warehouse/spool-stock-receipts');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      operationKey: '11111111-1111-4111-8111-111111111111',
      spoolTypeLabel: 'Шпуля 76 мм',
      priceKopecksPerMeter: 6_000,
      quantityMillimeters: 125_500,
      source: 'Прайс склада',
      effectiveFrom: '2026-08-08T00:00:00.000Z',
      reason: 'Цена и приход шпули записаны складом',
    });
  });

  it('loads and strictly parses the spool receipt summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(SPOOL_STOCK));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(fetchWarehouseSpoolStock({ signal: controller.signal })).resolves.toEqual(
      SPOOL_STOCK,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/warehouse/spool-stock');
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it.each([
    ['extra field', { ...SPOOL_RECEIPT, rawPayload: true }],
    ['unsafe quantity', { ...SPOOL_RECEIPT, quantityMillimeters: Number.MAX_SAFE_INTEGER + 1 }],
    ['unsafe price', { ...SPOOL_RECEIPT, priceKopecksPerMeter: Number.MAX_SAFE_INTEGER + 1 }],
    ['legacy role alias', { ...SPOOL_RECEIPT, receivedByRole: 'production' }],
    ['invalid received date', { ...SPOOL_RECEIPT, receivedAt: '2026-08-08' }],
    ['different receipt date', { ...SPOOL_RECEIPT, receivedAt: '2026-08-09T00:00:00.000Z' }],
  ])('rejects an unsafe receipt response: %s', (_label, value) => {
    expect(() => parseSpoolStockReceipt(value)).toThrow('Некорректный приход шпуль');
  });

  it.each([
    ['non-array', SPOOL_STOCK[0]],
    ['extra field', [{ ...SPOOL_STOCK[0], rawPayload: true }]],
    [
      'unsafe total',
      [{ ...SPOOL_STOCK[0], totalReceivedMillimeters: Number.MAX_SAFE_INTEGER + 1 }],
    ],
    ['invalid role data', [{ ...SPOOL_STOCK[0], lastReceivedAt: 'yesterday' }]],
  ])('rejects an unsafe receipt summary: %s', (_label, value) => {
    expect(() => parseWarehouseSpoolStock(value)).toThrow('Некорректный приход шпуль');
  });
});
