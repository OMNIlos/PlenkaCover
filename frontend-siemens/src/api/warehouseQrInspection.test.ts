import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectWarehouseQr,
  parseWarehouseQrInspection,
  type WarehouseQrInspection,
} from './warehouseQrInspection';

const rollInspection: WarehouseQrInspection = {
  kind: 'roll',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  roll: {
    rollCode: 'ROLL-0001',
    orderId: 'order-1',
    orderNumber: 'ЗК-0001',
    customerAlias: 'УралПак',
    requestCreatedAt: '2026-08-05T09:00:00.000Z',
    readyForShipmentAt: '2026-08-06T05:00:00.000Z',
    shipmentCompletedAt: null,
    sequence: 1,
    plannedKg: 40,
    spoolKg: 0.7,
    grossKg: 40.8,
    netKg: 40.1,
    toleranceOk: true,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    widthMm: 400,
    plannedLengthM: 1_500,
    spoolType: 'Тонкая',
    birka: 'ГОСТ',
    productionStatus: 'completed',
    warehouseStatus: 'received',
    producedAt: '2026-08-06T04:30:00.000Z',
    receivedAt: '2026-08-06T05:10:00.000Z',
  },
};

const bigBagInspection: WarehouseQrInspection = {
  kind: 'big_bag',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  bigBag: {
    id: 'bag-1',
    code: 'BB-ПВД-01',
    material: 'ПВД первичный',
    status: 'available',
    registrationStatus: 'registered',
    location: 'warehouse',
    initialKg: 500,
    currentKg: 425.125,
    lastMeasuredKg: 430,
    lastMeasuredAt: '2026-08-06T03:00:00.000Z',
    priceKopecksPerKg: 2_500,
    totalKopecks: 1_062_813,
    priceEffectiveAt: '2026-08-05T07:00:00.000Z',
    createdAt: '2026-08-05T07:00:00.000Z',
  },
};

const palletInspection = {
  kind: 'pallet',
  inspectedAt: '2026-08-06T06:00:00.000Z',
  pallet: {
    palletCode: 'PAL-A-100-01',
    status: null,
    documentStatus: 'sealed',
    materialMark: 'ПВД 10803-020',
    productNames: ['Рукав 80 мкм'],
    article: 'A-100-80',
    rollCount: 12,
    rollCodes: Array.from({ length: 12 }, (_, index) => `A-100-roll-${index + 1}`),
    packagingMaterial: 'Стрейч-плёнка',
    packagingCount: 1,
    shelfLifeMonths: 12,
    storageConditions: 'Хранить в сухом помещении',
    netKg: 481.2,
    grossKg: 489.7,
    productionDate: '06.2026–07.2026',
    deliveryDate: 'август 2026',
    orderNumbers: ['A-100'],
    customerAliases: ['УралПак'],
    createdAt: '2026-08-06T05:30:00.000Z',
    sealedAt: '2026-08-06T05:30:00.000Z',
  },
} as const;

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warehouse universal QR inspection API', () => {
  it.each([rollInspection, bigBagInspection, palletInspection])(
    'accepts an exact safe $kind projection',
    (inspection) => {
      expect(parseWarehouseQrInspection(structuredClone(inspection))).toEqual(inspection);
    },
  );

  it('accepts nullable legacy shelf-life facts in a safe pallet projection', () => {
    const legacyInspection = {
      ...palletInspection,
      pallet: {
        ...palletInspection.pallet,
        shelfLifeMonths: null,
        storageConditions: null,
      },
    };

    expect(parseWarehouseQrInspection(structuredClone(legacyInspection))).toEqual(
      legacyInspection,
    );
  });

  it('normalizes a legacy pallet projection without roll codes to an empty list', () => {
    const { rollCodes: _rollCodes, ...legacyPallet } = palletInspection.pallet;
    const legacyInspection = {
      ...palletInspection,
      pallet: legacyPallet,
    };

    expect(parseWarehouseQrInspection(structuredClone(legacyInspection))).toEqual({
      ...legacyInspection,
      pallet: {
        ...legacyPallet,
        rollCodes: [],
      },
    });
  });

  it('normalizes a legacy pallet projection without document status to null', () => {
    const { documentStatus: _documentStatus, ...legacyPallet } = palletInspection.pallet;
    const legacyInspection = {
      ...palletInspection,
      pallet: legacyPallet,
    };

    expect(parseWarehouseQrInspection(structuredClone(legacyInspection))).toEqual({
      ...legacyInspection,
      pallet: {
        ...legacyPallet,
        documentStatus: null,
      },
    });
  });

  it.each([
    { ...rollInspection, payload: `prt_${'a'.repeat(64)}` },
    { ...rollInspection, roll: { ...rollInspection.roll, rawPayload: 'unsafe' } },
    { ...bigBagInspection, bigBag: { ...bigBagInspection.bigBag, token: 'unsafe' } },
    { ...bigBagInspection, inspectedAt: 'not-a-date' },
    {
      ...palletInspection,
      pallet: { ...palletInspection.pallet, rows: [{ rollCode: 'ROLL-0001' }] },
    },
    { ...palletInspection, pallet: { ...palletInspection.pallet, rollCodes: 'A-100-roll-1' } },
    { ...palletInspection, pallet: { ...palletInspection.pallet, documentStatus: 'deleted' } },
    { kind: 'pallet', inspectedAt: '2026-08-06T06:00:00.000Z', bigBag: bigBagInspection.bigBag },
  ])('rejects an expanded or malformed role projection', (value) => {
    expect(() => parseWarehouseQrInspection(value)).toThrow('Некорректные данные QR.');
  });

  it('posts only the scanned payload to the read-only endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(rollInspection));
    vi.stubGlobal('fetch', fetchMock);
    const payload = `prt_${'a'.repeat(64)}`;

    await expect(inspectWarehouseQr(payload)).resolves.toEqual(rollInspection);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/qr/inspect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ payload }),
      }),
    );
  });
});
