import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWarehouseBigBag,
  fetchWarehouseBigBagLabelPreview,
  fetchWarehouseBigBagPrinters,
  fetchWarehouseBigBags,
  moveWarehouseBigBag,
  parseWarehouseBigBagList,
  printWarehouseBigBagLabel,
  recordWarehouseBigBagSystemPrintIntent,
  type WarehouseBigBag,
} from './warehouseBigBags';

const bag: WarehouseBigBag = {
  id: 'bag-1',
  code: 'BB-ПВД-01',
  material: 'ПВД Первичное',
  materialId: 'stock-1',
  materialSelectionKind: 'material',
  materialPreset: null,
  baseRawMaterialDefinitionId: 'material-primary',
  recipeDefinitionVersionId: null,
  recipeName: null,
  recipeVersionNumber: null,
  supplierName: 'ООО Поставщик',
  receivedAt: null,
  composition: [
    {
      rawMaterialDefinitionId: 'material-primary',
      materialId: 'stock-1',
      name: 'ПВД Первичное',
      shareBasisPoints: 10_000,
      initialKg: 500,
    },
  ],
  status: 'available',
  registrationStatus: 'pending_scan',
  location: 'warehouse',
  locationRevision: 0,
  initialKg: 500,
  currentKg: 500,
  lastMeasuredKg: 500,
  lastActorRole: 'warehouse',
  lastMeasuredAt: '2026-08-03T12:00:00.000Z',
  machineId: null,
  lastWarehouseMeasuredKg: null,
  lastWarehouseMeasuredAt: null,
  priceKopecksPerKg: 2_500,
  totalKopecks: 1_250_000,
  priceSource: 'manual_warehouse',
  priceEffectiveAt: '2026-08-03T12:00:00.000Z',
  createdByRole: 'warehouse',
  createdAt: '2026-08-03T12:00:00.000Z',
  latestLabelPrint: null,
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warehouse Big-Bag safe projection', () => {
  it('accepts the exact role-safe lifecycle projection and returns a detached value', () => {
    const serverBag = structuredClone(bag);
    const parsed = parseWarehouseBigBagList([serverBag]);

    expect(parsed).toEqual([bag]);
    expect(parsed[0]).not.toBe(serverBag);
    expect(parsed[0].composition).not.toBe(serverBag.composition);
  });

  it.each([
    [{ ...bag, rawPayload: { token: 'must-not-leak' } }],
    [{ ...bag, registrationStatus: 'unknown' }],
    [{ ...bag, locationRevision: -1 }],
    [{ ...bag, priceKopecksPerKg: -1 }],
    [{ ...bag, totalKopecks: 1_249_999 }],
    [{ ...bag, supplierName: '   ' }],
    [{ ...bag, receivedAt: '03.08.2026' }],
    [{ ...bag, composition: [{ ...bag.composition[0], devicePayload: 'unsafe' }] }],
  ])('rejects unsafe or malformed projections', (value) => {
    expect(() => parseWarehouseBigBagList(value)).toThrow(/Big-Bag/u);
  });

  it('rejects a browser print intent carrying a Gateway command identity', () => {
    const unsafe = {
      ...bag,
      latestLabelPrint: {
        id: 'print-unsafe',
        requestId: '11111111-1111-4111-8111-111111111111',
        bigBagId: bag.id,
        printerId: null,
        channel: 'browser_system_print',
        status: 'intent_recorded',
        reason: null,
        replacesPrintJobId: null,
        gatewayCommandId: 'gateway-command-must-not-exist',
        createdAt: '2026-08-03T12:02:00.000Z',
        updatedAt: '2026-08-03T12:02:00.000Z',
      },
    };

    expect(() => parseWarehouseBigBagList([unsafe])).toThrow(/Big-Bag/u);
  });
});

describe('warehouse Big-Bag API', () => {
  it('loads only printers proven ready for the exact Big-Bag operation', async () => {
    const printers = [
      {
        id: 'printer-1',
        code: 'PR-1',
        label: 'Принтер склада',
        post: { id: 'post-1', code: 'WH-1', name: 'Склад' },
        status: 'ready',
        ready: true,
        unavailableReason: null,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(response(printers));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWarehouseBigBagPrinters()).resolves.toEqual(printers);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/big-bags/printers',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses canonical create, list, movement, and Gateway print endpoints', async () => {
    const movement = {
      bag: { ...bag, registrationStatus: 'registered', locationRevision: 1 },
      movement: {
        kind: 'registration',
        fromLocation: null,
        toLocation: 'warehouse',
        locationRevision: 1,
        createdAt: '2026-08-03T12:01:00.000Z',
      },
      weightComparison: null,
    };
    const print = {
      id: 'print-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      bigBagId: bag.id,
      printerId: 'printer-1',
      channel: 'gateway',
      status: 'submitted',
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: 'gateway-command-1',
      createdAt: '2026-08-03T12:02:00.000Z',
      updatedAt: '2026-08-03T12:02:00.000Z',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(bag, 201))
      .mockResolvedValueOnce(response([bag]))
      .mockResolvedValueOnce(response(movement))
      .mockResolvedValueOnce(response(print));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createWarehouseBigBag({
        baseRawMaterialDefinitionId: 'material-primary',
        weightKg: 500,
        priceKopecksPerKg: 2_500,
        batchCode: 'ПАРТИЯ-500',
        supplierName: 'ООО Поставщик',
      }),
    ).resolves.toEqual(bag);
    await expect(fetchWarehouseBigBags()).resolves.toEqual([bag]);
    await expect(
      moveWarehouseBigBag({
        operationKey: '22222222-2222-4222-8222-222222222222',
        qrCode: `bbt_${'a'.repeat(64)}`,
        destination: 'warehouse',
      }),
    ).resolves.toEqual(movement);
    await expect(
      printWarehouseBigBagLabel(bag.id, {
        requestId: print.requestId,
        printerId: print.printerId,
      }),
    ).resolves.toEqual(print);

    expect(fetchMock.mock.calls).toEqual([
      [
        '/api/warehouse/big-bags',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            baseRawMaterialDefinitionId: 'material-primary',
            weightKg: 500,
            priceKopecksPerKg: 2_500,
            batchCode: 'ПАРТИЯ-500',
            supplierName: 'ООО Поставщик',
          }),
        }),
      ],
      ['/api/warehouse/big-bags', expect.objectContaining({ method: 'GET' })],
      [
        '/api/warehouse/big-bags/scans',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            operationKey: '22222222-2222-4222-8222-222222222222',
            qrCode: `bbt_${'a'.repeat(64)}`,
            destination: 'warehouse',
          }),
        }),
      ],
      [
        '/api/warehouse/big-bags/bag-1/label-prints',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            requestId: print.requestId,
            printerId: print.printerId,
          }),
        }),
      ],
    ]);
  });

  it('uses the immutable preview and audited browser-system-print intent endpoints', async () => {
    const preview = new Blob(['png'], { type: 'image/png' });
    const intent = {
      id: 'print-2',
      requestId: '22222222-2222-4222-8222-222222222222',
      bigBagId: bag.id,
      printerId: null,
      channel: 'browser_system_print',
      status: 'intent_recorded',
      reason: null,
      replacesPrintJobId: null,
      gatewayCommandId: null,
      createdAt: '2026-08-03T12:03:00.000Z',
      updatedAt: '2026-08-03T12:03:00.000Z',
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(preview, { status: 200 }))
      .mockResolvedValueOnce(response(intent, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWarehouseBigBagLabelPreview(bag.id)).resolves.toEqual(preview);
    await expect(
      recordWarehouseBigBagSystemPrintIntent(bag.id, { requestId: intent.requestId }),
    ).resolves.toEqual(intent);

    expect(fetchMock.mock.calls).toEqual([
      ['/api/warehouse/big-bags/bag-1/label-preview', expect.objectContaining({ method: 'GET' })],
      [
        '/api/warehouse/big-bags/bag-1/system-print-intents',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ requestId: intent.requestId }),
        }),
      ],
    ]);
  });
});
