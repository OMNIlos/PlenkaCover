import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import { IdempotentOperationGate } from './idempotentOperation';
import {
  adjustWarehouseRawMaterial,
  createWarehouseBigBag,
  fetchWarehouseInventory,
  fetchWarehouseInventoryRoll,
  fetchWarehouseRawMaterialStocks,
  receiveWarehouseRawMaterial,
} from './warehouse';
import {
  WarehouseRawAdjustmentReplayGuard,
  warehouseRawAdjustmentIntent,
} from './warehouseRawAdjustmentReplay';

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function warehouseBigBagResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'big-bag-1',
    code: 'BB-VTORICHKA-01',
    material: 'Вторичка',
    materialId: null,
    materialSelectionKind: 'material',
    materialPreset: null,
    baseRawMaterialDefinitionId: 'material-secondary',
    recipeDefinitionVersionId: null,
    recipeName: null,
    recipeVersionNumber: null,
    supplierName: null,
    receivedAt: null,
    composition: [
      {
        rawMaterialDefinitionId: 'material-secondary',
        materialId: 'bigbag-material:material-secondary',
        name: 'Вторичка',
        shareBasisPoints: 10_000,
        initialKg: 125.5,
      },
    ],
    status: 'available',
    registrationStatus: 'pending_scan',
    location: 'warehouse',
    locationRevision: 0,
    initialKg: 125.5,
    currentKg: 125.5,
    lastMeasuredKg: 125.5,
    lastActorRole: 'warehouse',
    lastMeasuredAt: '2026-07-28T08:00:00.000Z',
    machineId: null,
    lastWarehouseMeasuredKg: null,
    lastWarehouseMeasuredAt: null,
    priceKopecksPerKg: 2_500,
    totalKopecks: 313_750,
    priceSource: 'manual_warehouse',
    priceEffectiveAt: '2026-07-28T08:00:00.000Z',
    createdByRole: 'warehouse',
    createdAt: '2026-07-28T08:00:00.000Z',
    latestLabelPrint: null,
    ...overrides,
  };
}

function warehouseInventoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'roll-id-1',
    rollCode: 'ROLL/001',
    origin: 'client',
    lifecycleStatus: 'awaiting_shipment',
    lifecycleStatusLabel: 'Ожидает отгрузки',
    orderNumber: 'A-5',
    positionId: 'position-1',
    positionSequence: 1,
    warehouseStatus: 'received',
    warehouseStatusLabel: 'Принят складом',
    nextRoute: 'delivery',
    nextRouteLabel: 'Выдача',
    counterpartyName: 'ООО Плёнка',
    batchCode: null,
    weightKg: 42.3,
    specification: 'Рукав · 80 мкм · 1700 мм · 275 м',
    receivedAt: '2026-08-07T05:00:00.000Z',
    processedAt: null,
    ...overrides,
  };
}

function warehouseInventoryDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...warehouseInventoryItem(),
    specificationDetails: {
      filmType: 'Рукав',
      actualThicknessMicron: 80,
      accountingThicknessMicron: 78,
      widthMm: 1700,
      plannedLengthM: 275,
      netKg: 42.3,
      spoolType: 'Бумажная',
      birka: 'ГОСТ',
      recipeName: 'ПВД прозрачный',
      ingredients: ['ПВД 15803 — 95%', 'Добавка — 5%'],
    },
    provenance: {
      kind: 'client_order',
      orderNumber: 'A-5',
      batchCode: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  clearSession();
  saveSession({
    version: 1,
    token: 'warehouse-session-token',
    role: 'warehouse',
    serverRole: 'warehouse',
    userId: 'warehouse-1',
    displayName: 'Склад',
    expiresAt: '2026-07-22T00:00:00.000Z',
    passwordChangeRequired: false,
  });
});

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

describe('adjustWarehouseRawMaterial', () => {
  it('posts an absolute quantity to the encoded material endpoint and returns a safe stock row', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: 'server-stock-1',
        materialId: 'ПВД 15803',
        label: 'ПВД 15803-020',
        actualQty: 125.5,
        unit: 'кг',
        package: 'мешки 25 кг',
        factStatus: 'manual',
        updatedAt: '2026-07-21T08:00:00.000Z',
        externalId: null,
        sourceVersion: 'ignored-source-version',
        rawPayload: { secret: true },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await adjustWarehouseRawMaterial('ПВД 15803', {
      operationKey: '00000000-0000-4000-8000-000000000401',
      actualQty: 125.5,
      reason: 'Инвентаризация',
    });

    expect(result).toEqual(
      expect.objectContaining({
        id: 'server-stock-1',
        rawMaterialId: 'ПВД 15803',
        actualQty: 125.5,
        qty: 125.5,
        source: 'manual_platform',
        sourceOfTruthStatus: 'ручная корректировка',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/raw-materials/%D0%9F%D0%92%D0%94%2015803/adjustments',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-session-token' }),
        body: JSON.stringify({
          operationKey: '00000000-0000-4000-8000-000000000401',
          actualQty: 125.5,
          reason: 'Инвентаризация',
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/rawPayload|sourceVersion/u);
  });

  it('keeps zero as a valid absolute quantity in the request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: 'server-stock-1',
        materialId: 'rm-pvd',
        label: 'ПВД',
        actualQty: 0,
        unit: 'кг',
        factStatus: 'manual',
        updatedAt: '2026-07-21T08:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await adjustWarehouseRawMaterial('rm-pvd', {
      operationKey: '00000000-0000-4000-8000-000000000402',
      actualQty: 0,
      reason: 'Полный расход',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/raw-materials/rm-pvd/adjustments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operationKey: '00000000-0000-4000-8000-000000000402',
          actualQty: 0,
          reason: 'Полный расход',
        }),
      }),
    );
  });

  it('retains the exact operation key and payload after a malformed 2xx retry', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000403';
    const validStock = {
      id: 'server-stock-1',
      materialId: 'rm-pvd',
      rawMaterialDefinitionId: null,
      label: 'ПВД',
      actualQty: 90,
      unit: 'кг',
      package: null,
      factStatus: 'manual',
      updatedAt: '2026-07-21T08:00:00.000Z',
      externalId: null,
      sourceVersion: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ ...validStock, updatedAt: undefined }))
      .mockResolvedValueOnce(response(validStock));
    vi.stubGlobal('fetch', fetchMock);
    const gate = new IdempotentOperationGate(() => operationKey);
    const intent = 'warehouse:raw-adjust:rm-pvd:90:Инвентаризация';
    const execute = (key: string) =>
      adjustWarehouseRawMaterial('rm-pvd', {
        operationKey: key,
        actualQty: 90,
        reason: 'Инвентаризация',
      });

    await expect(gate.start(intent, execute)).rejects.toMatchObject({
      name: 'ApiResponseParseError',
      deliveryUncertain: true,
    });
    await expect(gate.start(intent, execute)).resolves.toMatchObject({ actualQty: 90 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(bodies).toEqual([
      { operationKey, actualQty: 90, reason: 'Инвентаризация' },
      { operationKey, actualQty: 90, reason: 'Инвентаризация' },
    ]);
  });

  it('blocks a changed payload after a 503 and retries the retained correction with the same key', async () => {
    const operationKey = '00000000-0000-4000-8000-000000000404';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Сервис временно недоступен.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'server-stock-1',
          materialId: 'rm-pvd',
          rawMaterialDefinitionId: null,
          label: 'ПВД',
          actualQty: 90,
          unit: 'кг',
          package: null,
          factStatus: 'manual',
          updatedAt: '2026-07-21T08:00:00.000Z',
          externalId: null,
          sourceVersion: null,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const gate = new IdempotentOperationGate(() => operationKey);
    const replay = new WarehouseRawAdjustmentReplayGuard();
    const attempt = async (draft: { actualQty: number; reason: string }) => {
      const payload = replay.prepare('rm-pvd', draft);
      const intent = warehouseRawAdjustmentIntent('rm-pvd', payload);
      const request = gate.start(intent, (key) =>
        adjustWarehouseRawMaterial('rm-pvd', { operationKey: key, ...payload }),
      );
      if (!request) throw new Error('Unexpected concurrent adjustment.');
      try {
        const result = await request;
        replay.resolve('rm-pvd');
        return result;
      } catch (error) {
        replay.reject('rm-pvd', payload, error);
        throw error;
      }
    };

    await expect(attempt({ actualQty: 90, reason: 'Инвентаризация' })).rejects.toMatchObject({
      status: 503,
    });
    await expect(attempt({ actualQty: 91, reason: 'Новый пересчёт' })).rejects.toThrow(
      'можно повторить только сохранённую корректировку: 90 кг, причина «Инвентаризация»',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(attempt({ actualQty: 90, reason: 'Инвентаризация' })).resolves.toMatchObject({
      actualQty: 90,
    });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(bodies).toEqual([
      { operationKey, actualQty: 90, reason: 'Инвентаризация' },
      { operationKey, actualQty: 90, reason: 'Инвентаризация' },
    ]);
  });
});

describe('fetchWarehouseRawMaterialStocks', () => {
  it('keeps an unclassified source row neutral instead of inferring primary material from its id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response([
          {
            id: 'stock-secondary',
            materialId: 'rm-secondary',
            rawMaterialDefinitionId: null,
            label: 'Вторичка',
            actualQty: 75.25,
            unit: 'кг',
            package: null,
            factStatus: 'source',
            updatedAt: '2026-08-08T07:00:00.000Z',
            externalId: 'onec-secondary',
            sourceVersion: 'snapshot-42',
          },
        ]),
      ),
    );

    await expect(fetchWarehouseRawMaterialStocks()).resolves.toEqual([
      {
        id: 'stock-secondary',
        rawMaterialId: 'rm-secondary',
        rawMaterialDefinitionId: null,
        label: 'Вторичка',
        materialKind: 'unclassified',
        qty: 75.25,
        actualQty: 75.25,
        unit: 'кг',
        packageQty: undefined,
        source: 'unknown',
        sourceOfTruthStatus: 'требует пересчета',
        updatedAt: '2026-08-08T07:00:00.000Z',
      },
    ]);
  });

  it.each([
    ['missing timestamp', { updatedAt: undefined }],
    ['non-canonical timestamp', { updatedAt: '2026-08-08 07:00:00' }],
    ['non-finite quantity', { actualQty: Number.POSITIVE_INFINITY }],
    ['unknown fact status', { factStatus: 'imported' }],
    ['blank name', { label: '  ' }],
  ])('rejects the whole malformed 2xx response: %s', async (_case, override) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response([
          {
            id: 'stock-1',
            materialId: 'rm-1',
            label: 'ПВД',
            actualQty: 10,
            unit: 'кг',
            factStatus: 'warehouse_fact',
            updatedAt: '2026-08-08T07:00:00.000Z',
            ...override,
          },
        ]),
      ),
    );

    await expect(fetchWarehouseRawMaterialStocks()).rejects.toThrow(
      'Некорректный ответ остатков сырья.',
    );
  });
});

describe('unified warehouse inventory client', () => {
  it('accepts a delivered client roll in the all-rolls projection', async () => {
    const delivered = warehouseInventoryItem({
      id: 'delivered-roll',
      lifecycleStatus: 'delivered',
      lifecycleStatusLabel: 'Выдан',
      warehouseStatus: 'delivered',
      warehouseStatusLabel: 'Выдан',
      nextRoute: 'completed',
      nextRouteLabel: 'Маршрут завершён',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response({ items: [delivered], nextCursor: null })),
    );

    await expect(fetchWarehouseInventory({ view: 'current' })).resolves.toEqual({
      items: [delivered],
      nextCursor: null,
    });
  });

  it('accepts a physically received defect roll as an exact read-only route', async () => {
    const defect = warehouseInventoryItem({
      id: 'defect-roll',
      lifecycleStatus: 'defect',
      lifecycleStatusLabel: 'Брак',
      warehouseStatus: 'defect',
      warehouseStatusLabel: 'Подтверждён брак',
      nextRoute: 'defect_resolution',
      nextRouteLabel: 'Решение по браку',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [defect], nextCursor: null })));

    await expect(fetchWarehouseInventory()).resolves.toEqual({
      items: [defect],
      nextCursor: null,
    });
  });

  it('encodes every list filter, opaque cursor, sort and forwards the exact AbortSignal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        items: [warehouseInventoryItem()],
        nextCursor: 'next/opaque+=',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      fetchWarehouseInventory(
        {
          view: 'current',
          q: '  ROLL / 001  ',
          batch: '  STOCK / август  ',
          minAgeDays: 0,
          maxAgeDays: 90,
          status: 'available',
          counterparty: '  ООО Плёнка  ',
          sort: 'rollCode',
          direction: 'asc',
          cursor: 'opaque/+=',
          limit: 100,
        },
        { signal: controller.signal },
      ),
    ).resolves.toEqual({
      items: [warehouseInventoryItem()],
      nextCursor: 'next/opaque+=',
    });

    const [path, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(path, 'https://frontend.test');
    expect(url.pathname).toBe('/api/warehouse/inventory/rolls');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: 'current',
      q: 'ROLL / 001',
      batch: 'STOCK / август',
      minAgeDays: '0',
      maxAgeDays: '90',
      status: 'available',
      counterparty: 'ООО Плёнка',
      sort: 'rollCode',
      direction: 'asc',
      cursor: 'opaque/+=',
      limit: '100',
    });
    expect(options.signal).toBe(controller.signal);
  });

  it('uses defaults without inventing optional filters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWarehouseInventory();

    const [path] = fetchMock.mock.calls[0] as [string];
    const url = new URL(path, 'https://frontend.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sort: 'receivedAt',
      direction: 'desc',
      limit: '25',
    });
  });

  it('encodes the roll id, forwards signal and parses nested detail safely', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(warehouseInventoryDetail()));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      fetchWarehouseInventoryRoll('roll/№ 1', { signal: controller.signal }),
    ).resolves.toEqual(warehouseInventoryDetail());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/inventory/rolls/roll%2F%E2%84%96%201',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each([
    ['unknown status', { lifecycleStatus: 'lost' }],
    ['mismatched status label', { lifecycleStatusLabel: 'Доступен' }],
    ['invalid date', { receivedAt: '07.08.2026' }],
    ['malformed number', { weightKg: '42.3' }],
    ['wrong nullable value', { batchCode: 42 }],
    ['unexpected private field', { legalName: 'Секретное юрлицо' }],
  ])('rejects a malformed list row: %s', async (_case, override) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [warehouseInventoryItem(override)],
          nextCursor: null,
        }),
      ),
    );

    await expect(fetchWarehouseInventory()).rejects.toThrow(
      'Некорректный ответ списка складских рулонов.',
    );
  });

  it('rejects the entire page instead of silently dropping one malformed row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          items: [
            warehouseInventoryItem(),
            warehouseInventoryItem({ id: null, rollCode: 'ROLL-002' }),
          ],
          nextCursor: null,
        }),
      ),
    );

    await expect(fetchWarehouseInventory()).rejects.toThrow(
      'Некорректный ответ списка складских рулонов.',
    );
  });

  it.each([
    [
      'provenance kind',
      warehouseInventoryDetail({
        provenance: { kind: 'debug_source', orderNumber: 'A-5', batchCode: null },
      }),
    ],
    [
      'non-string provenance kind',
      warehouseInventoryDetail({
        provenance: { kind: ['manual'], orderNumber: null, batchCode: null },
      }),
    ],
    [
      'provenance nullability',
      warehouseInventoryDetail({
        provenance: { kind: 'client_order', orderNumber: 5, batchCode: null },
      }),
    ],
    [
      'ingredients element',
      warehouseInventoryDetail({
        specificationDetails: {
          ...warehouseInventoryDetail().specificationDetails,
          ingredients: ['ПВД', { rawPayload: true }],
        },
      }),
    ],
    [
      'nested private key',
      warehouseInventoryDetail({
        specificationDetails: {
          ...warehouseInventoryDetail().specificationDetails,
          ingredients: [],
          recipeVersion: 'internal',
        },
      }),
    ],
  ])('rejects malformed nested detail recursively: %s', async (_case, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));

    await expect(fetchWarehouseInventoryRoll('roll-id-1')).rejects.toThrow(
      'Некорректный ответ складского рулона.',
    );
  });
});

describe('receiveWarehouseRawMaterial', () => {
  it('posts an idempotent additive receipt to the encoded material endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: 'server-stock-1',
        materialId: 'ПВД 15803',
        label: 'ПВД 15803-020',
        actualQty: 150.5,
        unit: 'кг',
        factStatus: 'warehouse_fact',
        updatedAt: '2026-07-21T08:00:00.000Z',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await receiveWarehouseRawMaterial('ПВД 15803', {
      operationKey: '11111111-1111-4111-8111-111111111111',
      receivedQty: 25,
      reason: 'Накладная № 42',
    });

    expect(result.actualQty).toBe(150.5);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/raw-materials/%D0%9F%D0%92%D0%94%2015803/receipts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-session-token' }),
        body: JSON.stringify({
          operationKey: '11111111-1111-4111-8111-111111111111',
          receivedQty: 25,
          reason: 'Накладная № 42',
        }),
      }),
    );
  });
});

describe('createWarehouseBigBag', () => {
  it('posts the selected shared material type and weight to the Big-Bag endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(warehouseBigBagResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWarehouseBigBag({
      baseRawMaterialDefinitionId: 'material-secondary',
      weightKg: 125.5,
      priceKopecksPerKg: 2_500,
    });

    expect(result).toEqual(
      expect.objectContaining({
        code: 'BB-VTORICHKA-01',
        baseRawMaterialDefinitionId: 'material-secondary',
        currentKg: 125.5,
        status: 'available',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/big-bags',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-session-token' }),
        body: JSON.stringify({
          baseRawMaterialDefinitionId: 'material-secondary',
          weightKg: 125.5,
          priceKopecksPerKg: 2_500,
        }),
      }),
    );
  });

  it('does not send recipes or fixed presets for an admin-managed material type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        warehouseBigBagResponse({
          id: 'big-bag-aika',
          code: 'BB-AIKA-01',
          material: 'Айка',
          baseRawMaterialDefinitionId: 'material-aika',
          composition: [
            {
              rawMaterialDefinitionId: 'material-aika',
              materialId: 'bigbag-material:material-aika',
              name: 'Айка',
              shareBasisPoints: 10_000,
              initialKg: 100,
            },
          ],
          initialKg: 100,
          currentKg: 100,
          lastMeasuredKg: 100,
          totalKopecks: 250_000,
          lastMeasuredAt: '2026-08-03T08:00:00.000Z',
          createdAt: '2026-08-03T08:00:00.000Z',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createWarehouseBigBag({
      baseRawMaterialDefinitionId: 'material-aika',
      weightKg: 100,
      priceKopecksPerKg: 2_500,
    });

    expect(result).toEqual(
      expect.objectContaining({
        material: 'Айка',
        baseRawMaterialDefinitionId: 'material-aika',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/big-bags',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          baseRawMaterialDefinitionId: 'material-aika',
          weightKg: 100,
          priceKopecksPerKg: 2_500,
        }),
      }),
    );
  });
});
