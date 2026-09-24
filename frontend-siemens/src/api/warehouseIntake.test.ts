import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import { ApiResponseParseError } from './client';
import {
  applyWarehousePalletSelectionScan,
  deliveryTaskToWorkObject,
  closeAndPrintCurrentWarehousePallet,
  fetchWarehouseDeliveryTasks,
  fetchWarehousePalletPreview,
  fetchWarehousePrinters,
  intakeTaskToWorkObject,
  liveRawMaterialsToWorkObject,
  mergeWarehouseNotifications,
  printWarehousePalletList,
  recordWarehousePalletSystemPrintIntent,
  isWarehousePalletPayload,
  setWarehousePalletSelection,
  scanWarehousePalletSelection,
  scanWarehousePallet,
  scanWarehousePalletDelivery,
  scanWarehousePayload,
  scanWarehouseTask,
  sealCurrentWarehousePallet,
  voidWarehousePallet,
  warehouseNotificationToItem,
  type ServerIntakeTask,
  type ServerCloseAndPrintPalletResult,
  type ServerPalletPrintResult,
  type ServerPalletSystemPrintIntentResult,
  type ServerSealPalletResult,
  type ServerWarehouseScanResult,
  type ServerWarehousePalletHandoffScanResult,
  type ServerWarehousePalletSelectionScanResult,
  type ServerWarehousePalletDeliveryScanResult,
  type ServerWarehouseTask,
  type ServerWarehouseNotification,
} from './warehouse';
import type { RawMaterialStock, WarehouseWorkbench } from '../domain/types';

const OPERATION_KEY = '11111111-1111-4111-8111-111111111111';
const PHYSICAL_QR = `prt_${'a'.repeat(64)}`;
const PALLET_QR = `plt_${'a'.repeat(64)}`;

const liveStock: RawMaterialStock = {
  id: 'server-stock-1',
  rawMaterialId: 'server-material-1',
  label: 'ПВД с сервера',
  materialKind: 'primary',
  qty: 125,
  actualQty: 125,
  unit: 'кг',
  source: 'warehouse_fact',
  sourceOfTruthStatus: 'актуально',
  updatedAt: '2026-07-17T08:00:00.000Z',
  referenceSnapshotId: 'external-stock-1',
};

describe('liveRawMaterialsToWorkObject', () => {
  it('строит live-инвентарь только из server rows без WH-INV-RAW и demo actions', () => {
    const object = liveRawMaterialsToWorkObject([liveStock]);

    expect(object.id).toBe('warehouse-live-inventory');
    expect(object.rawMaterialStocks).toEqual([liveStock]);
    expect(object.actions).toEqual([]);
    expect(JSON.stringify(object)).not.toMatch(/WH-INV-RAW|A-17|mock_1C|demo/u);
  });
});

describe('warehouse pallet print status contract', () => {
  it('сохраняет backend needs_admin projection для честного uncertain UI', () => {
    const projected = intakeTaskToWorkObject(
      task({
        palletList: {
          id: 'pallet-list-needs-admin',
          createdAt: '2026-07-17T08:00:00.000Z',
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          printStatus: 'needs_admin',
        },
      }),
    );
    const workbench = projected.workbench;
    if (!workbench || workbench.type !== 'warehouse') {
      throw new Error('Expected warehouse workbench projection');
    }

    expect(workbench.palletListDocument?.printStatus).toBe('needs_admin');
  });
});

describe('warehouse pallet selection contract', () => {
  it('sends the explicit server-owned selection command with its operation key', async () => {
    const response = {
      selectionChanged: true,
      activePallet: {
        id: 'pallet-1',
        palletCode: 'PAL-A-2001-01',
        orderId: 'order-a-2001',
        orderNumber: 'A-2001',
        sequenceNo: 1,
        status: 'open' as const,
        totalCount: 1,
        hasMore: false,
        openedAt: '2026-08-07T10:00:00.000Z',
        rows: [],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      setWarehousePalletSelection('task-1', 'scan-row-1', {
        operationKey: OPERATION_KEY,
        selected: true,
      }),
    ).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/task-1/pallet-selection/scan-row-1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ operationKey: OPERATION_KEY, selected: true }),
      }),
    );
  });

  function palletSelectionScanResponse() {
    return {
      operationKey: OPERATION_KEY,
      taskId: 'task-1',
      scanRowId: 'scan-row-1',
      rollCode: 'A-2001-roll-1',
      outcome: 'added',
      activePallet: {
        id: 'pallet-1',
        palletCode: 'PAL-A-2001-01',
        orderId: 'order-a-2001',
        orderNumber: 'A-2001',
        sequenceNo: 1,
        status: 'open',
        totalCount: 1,
        hasMore: false,
        openedAt: '2026-08-07T10:00:00.000Z',
        rows: [
          {
            rollCode: 'A-2001-roll-1',
            position: 1,
            acceptedAt: '2026-08-07T10:01:00.000Z',
            scannedByName: 'Склад',
          },
        ],
      },
    };
  }

  it('sends a roll QR to the selected intake task and accepts an exact outcome', async () => {
    const response = palletSelectionScanResponse();
    const fetchMock = vi.fn().mockResolvedValue(okResponse(response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      scanWarehousePalletSelection('task-1', PHYSICAL_QR, OPERATION_KEY),
    ).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/task-1/pallet-selection/scans',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey: OPERATION_KEY, payload: PHYSICAL_QR }),
      }),
    );
  });

  it('accepts a bounded 100-row pallet projection after scanning roll 101', async () => {
    const response = palletSelectionScanResponse();
    response.rollCode = 'A-2001-roll-101';
    response.activePallet.totalCount = 101;
    response.activePallet.hasMore = true;
    response.activePallet.rows = Array.from({ length: 100 }, (_, index) => ({
      ...response.activePallet.rows[0],
      rollCode: `A-2001-roll-${index + 1}`,
      position: index + 1,
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(response)));

    await expect(
      scanWarehousePalletSelection('task-1', PHYSICAL_QR, OPERATION_KEY),
    ).resolves.toEqual(response);
  });

  it('applies the confirmed pallet scan locally without waiting for a warehouse refetch', () => {
    const response = palletSelectionScanResponse();
    response.taskId = 't1';
    response.scanRowId = 'scan-row-accepted-1';
    const initial = intakeTaskToWorkObject(task({ activePallet: null }));

    const result = response as ServerWarehousePalletSelectionScanResult;
    const updated = applyWarehousePalletSelectionScan(initial, result);
    const repeated = applyWarehousePalletSelectionScan(updated, result);
    const workbench = repeated.workbench;
    if (!workbench || workbench.type !== 'warehouse') {
      throw new Error('Expected warehouse workbench');
    }

    expect(workbench.activePallet).toMatchObject({
      id: 'pallet-1',
      palletCode: 'PAL-A-2001-01',
      rollCount: 1,
    });
    expect(workbench.expectedRolls?.[0].palletSelection).toEqual({
      selected: true,
      locked: false,
      palletId: 'pallet-1',
      palletCode: 'PAL-A-2001-01',
    });
    expect(
      repeated.actions.filter((action) =>
        action.id.startsWith('warehouse-close-and-print-pallet:'),
      ),
    ).toHaveLength(1);
    expect(repeated.actions.find((action) => action.id === 'warehouse.close:t1')).toMatchObject({
      enabled: false,
      disabledReason: 'Сначала закройте и распечатайте текущий палет',
    });
  });

  const malformedPalletSelectionResponses: Array<
    [string, (value: ReturnType<typeof palletSelectionScanResponse>) => void]
  > = [
    ['wrong operation key', (value) => (value.operationKey = 'wrong')],
    ['wrong task', (value) => (value.taskId = 'task-other')],
    ['unsupported outcome', (value) => (value.outcome = 'removed')],
    ['missing pallet', (value) => void Reflect.deleteProperty(value, 'activePallet')],
    [
      'duplicate roll codes',
      (value) => {
        value.activePallet.totalCount = 2;
        value.activePallet.rows.push({ ...value.activePallet.rows[0], position: 2 });
      },
    ],
    [
      'inconsistent pagination',
      (value) => {
        value.activePallet.totalCount = 101;
        value.activePallet.hasMore = false;
      },
    ],
    ['extra top-level field', (value) => void Reflect.set(value, 'rawPayload', PHYSICAL_QR)],
  ];

  it.each(malformedPalletSelectionResponses)(
    'rejects a pallet-selection scan response with %s',
    async (_case, mutate) => {
      const response = palletSelectionScanResponse();
      mutate(response);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(response)));

      await expect(
        scanWarehousePalletSelection('task-1', PHYSICAL_QR, OPERATION_KEY),
      ).rejects.toBeInstanceOf(ApiResponseParseError);
    },
  );
});

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function task(overrides: Partial<ServerIntakeTask> = {}): ServerIntakeTask {
  return {
    taskId: 't1',
    operationCode: 'ПР-1307-01',
    orderNumbers: ['A-2001'],
    customerAliases: ['УралПак'],
    orderNumber: 'A-2001',
    customerAlias: 'УралПак',
    status: 'scanning',
    plannedRollCount: 2,
    expected: 1,
    accepted: 1,
    errors: 0,
    closable: false,
    lastScanResult: null,
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-07-13T08:30:00.000Z',
    palletList: null,
    activePallet: {
      id: 'pallet-1',
      palletCode: 'PAL-A-2001-01',
      orderId: 'order-a-2001',
      orderNumber: 'A-2001',
      sequenceNo: 1,
      status: 'open',
      rollCount: 1,
      openedAt: '2026-07-13T08:29:00.000Z',
      rows: [
        {
          rollCode: 'A-2001-roll-1',
          position: 1,
          acceptedAt: '2026-07-13T08:30:00.000Z',
          scannedByName: 'Склад (seed)',
        },
      ],
    },
    palletHistory: [],
    palletHistoryHasMore: false,
    rolls: [
      {
        rollCode: 'A-2001-roll-1',
        orderId: 'order-a-2001',
        orderNumber: 'A-2001',
        orderLineId: 'position-1',
        customerAlias: 'УралПак',
        sequence: 1,
        planKg: 41.2,
        netKg: 41.4,
        grossKg: 42.1,
        characteristics: {
          filmType: 'Рукав',
          materialMark: 'PE-LD',
          sizeMeters: '2000 мм',
          actualThickness: '80 мкм',
          lengthMeters: '275 м',
          spoolType: '76 мм',
          article: 'АРТ-77',
          packagingMaterial: 'Стрейч-плёнка',
          packagingCount: 1,
          deliveryDate: '2026-08-20',
        },
        source: 'production_handover',
        ownership: 'customer_owned',
        operatorLabel: 'Оператор 1',
        machineLabel: 'Станок 1',
        productionStatus: 'completed',
        producedAt: '2026-07-13T07:00:00.000Z',
        scanStatus: 'accepted',
        warehouseState: 'sent',
        scannedByName: 'Склад (seed)',
        scanRowId: 'scan-row-accepted-1',
        palletSelection: {
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        },
      },
      {
        rollCode: 'A-2001-roll-2',
        orderId: 'order-a-2001',
        orderNumber: 'A-2001',
        orderLineId: 'position-2',
        customerAlias: 'УралПак',
        sequence: 2,
        planKg: 41.2,
        netKg: null,
        grossKg: null,
        characteristics: null,
        source: 'production_pending',
        ownership: 'customer_owned',
        operatorLabel: null,
        machineLabel: null,
        productionStatus: 'queued',
        producedAt: null,
        scanStatus: 'expected',
        warehouseState: 'not_ready',
        scannedByName: null,
        scanRowId: 'scan-row-expected-2',
        palletSelection: {
          selected: false,
          locked: false,
          palletId: null,
          palletCode: null,
        },
      },
    ],
    ...overrides,
  };
}

function sealedPalletResult(): ServerSealPalletResult {
  return {
    pallet: { ...task().activePallet!, status: 'sealed' },
    document: {
      id: 'pl-v7-1',
      palletId: 'PAL-A-2001-01',
      warehousePalletId: 'pallet-1',
      origin: 'physical_pallet',
      documentStatus: 'sealed',
      createdAt: '2026-08-11T21:30:00.000Z',
      templateVersion: 'pallet-100x100-configurable-v7',
      printReady: true,
      printStatus: 'not_printed',
      rollCount: 1,
      rollCodes: ['A-2001-roll-1'],
      rollCodesHasMore: false,
      orderId: 'order-a-2001',
    },
  };
}

function deliveryTask(overrides: Partial<ServerWarehouseTask> = {}): ServerWarehouseTask {
  return {
    id: 'delivery-1',
    mode: 'delivery',
    status: 'open',
    operationCode: 'ВЫД-1507-01',
    orderId: 'order-a-2001',
    positionId: 'position-1',
    proposalId: null,
    createdAt: '2026-07-15T08:00:00.000Z',
    updatedAt: '2026-07-15T08:30:00.000Z',
    lastScanResult: null,
    rows: [
      {
        id: 'scan-row-1',
        taskId: 'delivery-1',
        rollCode: 'A-2001-roll-1',
        fromOrderId: 'A-2001',
        customerAlias: null,
        scanStatus: 'expected',
        lastScanAt: null,
        scannedByName: null,
      },
    ],
    ...overrides,
  };
}

describe('intakeTaskToWorkObject (селекторные контракты Приёмки)', () => {
  it('keeps two order positions inside one canonical intake row with stable identities', () => {
    const object = intakeTaskToWorkObject(task());
    const projected = object.workbench;
    if (!projected || projected.type !== 'warehouse') {
      throw new Error('Expected warehouse workbench');
    }

    expect(object.id).toBe('intake-t1');
    expect(projected.expectedRolls).toEqual([
      expect.objectContaining({
        id: 'A-2001-roll-1',
        orderEntityId: 'order-a-2001',
        orderLineId: 'position-1',
        sequenceNumber: 1,
      }),
      expect.objectContaining({
        id: 'A-2001-roll-2',
        orderEntityId: 'order-a-2001',
        orderLineId: 'position-2',
        sequenceNumber: 2,
      }),
    ]);
  });

  it('переносит server-owned pallet selection и scan row id без вывода по active pallet', () => {
    const intake = task({ activePallet: null });
    intake.rolls[0] = {
      ...intake.rolls[0],
      scanRowId: 'scan-row-accepted-1',
      palletSelection: {
        selected: true,
        locked: false,
        palletId: 'pallet-1',
        palletCode: 'PAL-A-2001-01',
      },
    } as (typeof intake.rolls)[number];

    const projected = intakeTaskToWorkObject(intake).workbench;
    if (!projected || projected.type !== 'warehouse')
      throw new Error('Expected warehouse workbench');

    expect(projected.expectedRolls?.[0]).toMatchObject({
      scanRowId: 'scan-row-accepted-1',
      palletSelection: {
        selected: true,
        locked: false,
        palletId: 'pallet-1',
        palletCode: 'PAL-A-2001-01',
      },
    });
  });

  it('переносит bounded printed composition into the pallet history lock projection', () => {
    const projected = intakeTaskToWorkObject(
      task({
        palletHistory: [
          {
            id: 'document-locked-1',
            palletId: 'PAL-A-2001-01',
            warehousePalletId: 'pallet-1',
            origin: 'physical_pallet',
            createdAt: '2026-08-07T10:00:00.000Z',
            templateVersion: 'pallet-100x150-v1',
            printReady: true,
            printStatus: 'submitted',
            rollCount: 1,
            rollCodes: ['A-2001-roll-1'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
        ],
      }),
    ).workbench;
    if (!projected || projected.type !== 'warehouse')
      throw new Error('Expected warehouse workbench');

    expect(projected.palletListDocuments?.[0].rollIds).toEqual(['A-2001-roll-1']);
  });

  it('проецирует квадратный Windows-документ без ложных PDF/Word/Excel форматов', () => {
    const projected = intakeTaskToWorkObject(
      task({
        palletHistory: [
          {
            id: 'document-square-1',
            palletId: 'PAL-A-2001-01',
            warehousePalletId: 'pallet-1',
            origin: 'physical_pallet',
            documentStatus: 'sealed',
            createdAt: '2026-08-09T08:00:00.000Z',
            templateVersion: 'pallet-100x100-square-v4',
            printReady: true,
            printStatus: 'not_printed',
            rollCount: 1,
            rollCodes: ['A-2001-roll-1'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
        ],
      }),
    ).workbench;
    if (!projected || projected.type !== 'warehouse')
      throw new Error('Expected warehouse workbench');

    expect(projected.palletListDocuments?.[0]).toMatchObject({
      formatLabel: 'системная печать',
      availableFormats: [],
      templateVersion: 'pallet-100x100-square-v4',
    });
  });

  it('проецирует safe-v5 как системную печать без ложных форматов выгрузки', () => {
    const projected = intakeTaskToWorkObject(
      task({
        palletHistory: [
          {
            id: 'document-safe-v5-1',
            palletId: 'PAL-A-2001-02',
            warehousePalletId: 'pallet-2',
            origin: 'physical_pallet',
            documentStatus: 'sealed',
            createdAt: '2026-08-09T12:00:00.000Z',
            templateVersion: 'pallet-100x100-safe-v5',
            printReady: true,
            printStatus: 'not_printed',
            rollCount: 1,
            rollCodes: ['A-2001-roll-1'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
        ],
      }),
    ).workbench;
    if (!projected || projected.type !== 'warehouse')
      throw new Error('Expected warehouse workbench');

    expect(projected.palletListDocuments?.[0]).toMatchObject({
      formatLabel: 'системная печать',
      availableFormats: [],
      templateVersion: 'pallet-100x100-safe-v5',
    });
  });

  it('проецирует extended-v6 как системную печать без gateway/export форматов', () => {
    const projected = intakeTaskToWorkObject(
      task({
        palletHistory: [
          {
            id: 'document-extended-v6-1',
            palletId: 'PAL-A-2001-03',
            warehousePalletId: 'pallet-3',
            origin: 'physical_pallet',
            documentStatus: 'sealed',
            createdAt: '2026-08-09T14:00:00.000Z',
            templateVersion: 'pallet-100x100-extended-v6',
            printReady: true,
            printStatus: 'not_printed',
            rollCount: 2,
            rollCodes: ['A-2001-roll-1', 'A-2001-roll-2'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
        ],
      }),
    ).workbench;
    if (!projected || projected.type !== 'warehouse')
      throw new Error('Expected warehouse workbench');

    expect(projected.palletListDocuments?.[0]).toMatchObject({
      formatLabel: 'системная печать',
      availableFormats: [],
      templateVersion: 'pallet-100x100-extended-v6',
      rollIds: ['A-2001-roll-1', 'A-2001-roll-2'],
    });
  });

  it.each([
    ['отсутствует', undefined],
    ['неизвестен', 'unexpected'],
  ] as const)(
    'помечает physical-документ как unknown, когда documentStatus %s',
    (_label, documentStatus) => {
      const history = {
        id: 'document-status-unknown',
        palletId: 'PAL-A-2001-02',
        warehousePalletId: 'pallet-2',
        origin: 'physical_pallet' as const,
        createdAt: '2026-08-07T10:00:00.000Z',
        templateVersion: 'pallet-100x150-v1' as const,
        printReady: true,
        printStatus: 'submitted' as const,
        rollCount: 1,
        rollCodes: ['A-2001-roll-1'],
        rollCodesHasMore: false,
        orderId: 'order-a-2001',
        ...(documentStatus ? { documentStatus } : {}),
      };
      const projected = intakeTaskToWorkObject(
        task({
          palletHistory: [history as NonNullable<ServerIntakeTask['palletHistory']>[number]],
        }),
      ).workbench;
      if (!projected || projected.type !== 'warehouse')
        throw new Error('Expected warehouse workbench');

      expect(projected.palletListDocuments?.[0].documentStatus).toBe('unknown');
    },
  );

  it('ставит тег «Приемка» и workbench.type=warehouse — иначе карточка не попадет в очередь', () => {
    const object = intakeTaskToWorkObject(task());
    expect(object.id).toBe('intake-t1');
    expect(object.filterTags).toContain('Приемка');
    expect(object.filterTags).toContain('Требуют действия');
    expect(object.workbench?.type).toBe('warehouse');
  });

  it('передает плановое число рулонов заказа отдельно от текущих строк сканирования', () => {
    const object = intakeTaskToWorkObject(
      task({
        expected: 1,
        accepted: 0,
        plannedRollCount: 60,
      }),
    );
    const workbench = object.workbench as WarehouseWorkbench & { plannedRollCount?: number };

    expect(workbench.expected).toBe(1);
    expect(workbench.plannedRollCount).toBe(60);
  });

  it('переносит реальные рулоны с именами производства и статусами', () => {
    const object = intakeTaskToWorkObject(task());
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;
    expect(workbench.expectedRolls?.[0]).toEqual(
      expect.objectContaining({
        id: 'A-2001-roll-1',
        status: 'Принят',
        plannedNetKg: 41.4,
        orderId: 'A-2001',
        orderEntityId: 'order-a-2001',
        customerAlias: 'УралПак',
        operatorLabel: 'Оператор 1',
        machineLabel: 'Станок 1',
        sizeMeters: '2000 мм',
        lengthMeters: '275 м',
        materialMark: 'PE-LD',
        spoolType: '76 мм',
        article: 'АРТ-77',
        packagingMaterial: 'Стрейч-плёнка',
        packagingCount: 1,
        deliveryDate: '2026-08-20',
        planNetKg: 41.2,
        actualNetKg: 41.4,
        grossKg: 42.1,
        producedAt: '2026-07-13T07:00:00.000Z',
      }),
    );
    expect(workbench.expectedRolls?.[1].status).toBe('Ждет производства');
    expect(workbench.scanned).toBe(1);
    expect(workbench.expected).toBe(2);
    expect(JSON.stringify(workbench)).not.toContain('qrCode');
  });

  it('показывает только безопасный lastScanResult и не переносит legacy raw payload', () => {
    const unsafeTask = {
      ...task({
        lastScanResult: {
          rollCode: 'A-2001-roll-1',
          scanStatus: 'accepted',
          scannedAt: '2026-07-13T08:29:00.000Z',
        },
      }),
      lastScan: '{"device":"scanner-7","raw":"must-not-leak"}',
    } as ServerIntakeTask & { lastScan: string };

    const object = intakeTaskToWorkObject(unsafeTask);
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(workbench.lastScan).toBe('A-2001-roll-1');
    expect(workbench.lastScanResult).toEqual({
      rollCode: 'A-2001-roll-1',
      scanStatus: 'accepted',
      scannedAt: '2026-07-13T08:29:00.000Z',
    });
    expect(JSON.stringify(object)).not.toMatch(/scanner-7|must-not-leak|"device"|"raw"/);
  });

  it('проецирует текущий палет и разрешает закрыть его до обработки всего заказа', () => {
    const object = intakeTaskToWorkObject(task());
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(workbench.activePallet).toEqual(
      expect.objectContaining({
        id: 'pallet-1',
        palletCode: 'PAL-A-2001-01',
        orderId: 'order-a-2001',
        sequenceNo: 1,
        rollCount: 1,
        rows: [
          expect.objectContaining({
            rollCode: 'A-2001-roll-1',
            position: 1,
          }),
        ],
      }),
    );
    expect(workbench.palletListDocument).toBeUndefined();
    expect(object.actions).toContainEqual(
      expect.objectContaining({
        id: 'warehouse-close-and-print-pallet:t1',
        label: 'Закрыть и распечатать палет',
        enabled: true,
      }),
    );
    expect(
      object.actions.some((action) => action.id.startsWith('warehouse-create-pallet-list:')),
    ).toBe(false);
    expect(JSON.stringify(object)).not.toContain('draft-t1');
  });

  it('не предлагает закрытие и печать, пока нет активного палета', () => {
    const object = intakeTaskToWorkObject(task({ activePallet: null }));

    expect(
      object.actions.some((action) => action.id.startsWith('warehouse-close-and-print-pallet:')),
    ).toBe(false);
  });

  it('сохраняет историю физических палетов отдельными immutable-документами', () => {
    const object = intakeTaskToWorkObject(
      task({
        palletList: {
          id: 'pl-2',
          createdAt: '2026-07-13T09:31:00.000Z',
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          printStatus: 'submitted',
        },
        palletHistory: [
          {
            id: 'pl-2',
            palletId: 'PAL-A-2001-02',
            warehousePalletId: 'pallet-2',
            origin: 'physical_pallet',
            createdAt: '2026-07-13T09:31:00.000Z',
            templateVersion: 'pallet-100x150-v1',
            printReady: true,
            printStatus: 'submitted',
            rollCount: 2,
            rollCodes: ['A-2001-roll-1', 'A-2001-roll-2'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
          {
            id: 'pl-1',
            palletId: 'PAL-A-2001-01',
            warehousePalletId: 'pallet-1',
            origin: 'physical_pallet',
            createdAt: '2026-07-13T08:31:00.000Z',
            templateVersion: 'pallet-100x150-v1',
            printReady: true,
            printStatus: 'failed',
            rollCount: 1,
            rollCodes: ['A-2001-roll-3'],
            rollCodesHasMore: false,
            orderId: 'order-a-2001',
          },
        ],
      }),
    );
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;
    expect(workbench.palletListDocuments?.map((document) => document.id)).toEqual(['pl-2', 'pl-1']);
    expect(workbench.palletListDocument).toEqual(
      expect.objectContaining({
        id: 'pl-2',
        palletId: 'PAL-A-2001-02',
        templateVersion: 'pallet-100x150-v1',
        printReady: true,
        printStatus: 'submitted',
      }),
    );
  });

  it('сохраняет palletList-only ответ как один legacy-документ для совместимости', () => {
    const object = intakeTaskToWorkObject(
      task({
        activePallet: null,
        palletList: {
          id: 'legacy-pl-1',
          createdAt: '2026-07-13T08:31:00.000Z',
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          printStatus: 'needs_admin',
        },
      }),
    );
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(workbench.palletListDocuments).toEqual([
      expect.objectContaining({
        id: 'legacy-pl-1',
        palletId: 'ПР-1307-01',
        printStatus: 'needs_admin',
      }),
    ]);
  });

  it('оставляет смешанные task rows видимыми, но текущий палет содержит один заказ', () => {
    const base = task();
    const rolls = [
      {
        ...base.rolls[0],
        rollCode: 'roll-a',
        orderId: 'order-a',
        orderNumber: 'A-100',
        customerAlias: 'Альфа',
      },
      {
        ...base.rolls[0],
        rollCode: 'roll-b',
        orderId: 'order-b',
        orderNumber: 'B-200',
        customerAlias: 'Бета',
        source: 'warehouse_reserve' as const,
        ownership: 'reserved_for_order' as const,
        operatorLabel: 'Оператор 2',
        machineLabel: 'Станок 2',
      },
      {
        ...base.rolls[1],
        rollCode: 'roll-c',
        orderId: 'order-c',
        orderNumber: 'C-300',
        customerAlias: 'Гамма',
      },
    ];
    const object = intakeTaskToWorkObject(
      task({
        orderNumbers: ['A-100', 'B-200', 'C-300'],
        customerAliases: ['Альфа', 'Бета', 'Гамма'],
        orderNumber: null,
        customerAlias: null,
        rolls,
        activePallet: {
          ...base.activePallet!,
          orderId: 'order-a',
          orderNumber: 'A-100',
          rows: [
            {
              rollCode: 'roll-a',
              position: 1,
              acceptedAt: '2026-07-13T08:30:00.000Z',
              scannedByName: 'Склад',
            },
          ],
        },
      }),
    );
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;
    expect(workbench.expectedRolls?.map((roll) => roll.orderId)).toEqual([
      'A-100',
      'B-200',
      'C-300',
    ]);
    expect(workbench.expectedRolls?.map((roll) => roll.customerAlias)).toEqual([
      'Альфа',
      'Бета',
      'Гамма',
    ]);
    expect(workbench.expectedRolls?.[1]).toEqual(
      expect.objectContaining({
        source: 'warehouse_reserve',
        ownership: 'reserved_for_order',
        operatorLabel: 'Оператор 2',
        machineLabel: 'Станок 2',
      }),
    );
    expect(workbench.activePallet).toMatchObject({
      orderId: 'order-a',
      orderNumber: 'A-100',
      rows: [{ rollCode: 'roll-a' }],
    });
  });

  it('закрывает всю приемку только после QR и после закрытия последнего палета', () => {
    const open = intakeTaskToWorkObject(task());
    const closeOpen = open.actions.find((action) => action.id.startsWith('warehouse.close:'));
    expect(closeOpen?.enabled).toBe(false);
    const palletStillOpen = intakeTaskToWorkObject(
      task({ closable: true, expected: 0, status: 'pallet_open' }),
    );
    const blockedClose = palletStillOpen.actions.find((action) =>
      action.id.startsWith('warehouse.close:'),
    );
    expect(blockedClose).toMatchObject({
      enabled: false,
      disabledReason: 'Сначала закройте и распечатайте текущий палет',
    });

    const ready = intakeTaskToWorkObject(
      task({ closable: true, expected: 0, status: 'pallet_open', activePallet: null }),
    );
    const closeReady = ready.actions.find((action) => action.id.startsWith('warehouse.close:'));
    expect(closeReady?.enabled).toBe(true);

    const closedWorkbench = intakeTaskToWorkObject(task({ status: 'accepted' })).workbench;
    expect(closedWorkbench?.type === 'warehouse' && closedWorkbench.taskClosed).toBe(true);
  });

  it('не возвращает старую create/update mutation даже для legacy snapshot', () => {
    const object = intakeTaskToWorkObject(
      task({
        closable: true,
        expected: 0,
        status: 'pallet_open',
        palletList: {
          id: 'pl-early',
          createdAt: '2026-07-13T08:10:00.000Z',
          templateVersion: 'pallet-100x150-v1',
          printReady: false,
          printStatus: 'not_printed',
        },
      }),
    );
    expect(
      object.actions.some((action) => action.id.startsWith('warehouse-create-pallet-list:')),
    ).toBe(false);
    expect(object.actions).toContainEqual(
      expect.objectContaining({ id: 'warehouse-close-and-print-pallet:t1' }),
    );
  });

  it('брак делает карточку критичной со статусом «Брак»', () => {
    const object = intakeTaskToWorkObject(task({ status: 'has_defect' }));
    expect(object.statusLabel).toBe('Брак');
    expect(object.severity).toBe('critical');
  });
});

describe('deliveryTaskToWorkObject (живая Выдача)', () => {
  it('переносит контрагента заказа в ожидаемый рулон', () => {
    const taskWithCustomer = deliveryTask();
    taskWithCustomer.rows[0] = {
      ...taskWithCustomer.rows[0],
      customerAlias: 'САФАТ ООО',
    };

    const object = deliveryTaskToWorkObject(taskWithCustomer);
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(workbench.expectedRolls?.[0]?.customerAlias).toBe('САФАТ ООО');
  });

  it('проецирует backend delivery task без demo-данных и с task-scoped действиями', () => {
    const object = deliveryTaskToWorkObject(deliveryTask());
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(object).toMatchObject({
      id: 'delivery-delivery-1',
      title: 'Выдача A-2001',
      statusLabel: 'Ожидает сканирования',
    });
    expect(object.filterTags).toContain('Выдача');
    expect(workbench).toMatchObject({
      mode: 'delivery',
      prompt: 'Сканируйте QR каждого палетного листа один раз.',
      expected: 1,
      scanned: 0,
      missing: ['A-2001-roll-1'],
    });
    expect(object.actions).toContainEqual(
      expect.objectContaining({
        id: 'warehouse.delivery.close:delivery-1',
        enabled: false,
        disabledReason: 'Не все палеты подтверждены',
        recoveryAction: 'Сканировать QR палетных листов',
      }),
    );
    expect(JSON.stringify(object)).not.toMatch(/rawPayload|devicePayload|scannerPayload/);
  });

  it('проецирует decision-linked reserve task как физическую проверку без legacy close', () => {
    const object = deliveryTaskToWorkObject(
      deliveryTask({
        id: 'reserve-task-real-id',
        mode: 'reserve',
        operationCode: null,
        orderId: 'commercial-order-real-id',
      }),
    );
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(object).toMatchObject({
      id: 'delivery-reserve-task-real-id',
      title: 'Проверка резерва A-2001',
    });
    expect(workbench.coverageDecisionTaskId).toBe('reserve-task-real-id');
    expect(object.actions).toEqual([]);
  });

  it('разрешает закрытие только после всех QR и показывает закрытую выдачу как immutable', () => {
    const acceptedRow = {
      ...deliveryTask().rows[0],
      scanStatus: 'accepted',
      lastScanAt: '2026-07-15T08:31:00.000Z',
      scannedByName: 'Склад',
    };
    const ready = deliveryTaskToWorkObject(
      deliveryTask({
        rows: [acceptedRow],
        lastScanResult: {
          rollCode: 'A-2001-roll-1',
          scanStatus: 'accepted',
          scannedAt: '2026-07-15T08:31:00.000Z',
        },
      }),
    );
    expect(
      ready.actions.find((action) => action.id === 'warehouse.delivery.close:delivery-1'),
    ).toMatchObject({ enabled: true, label: 'Закрыть выдачу' });

    const closed = deliveryTaskToWorkObject(
      deliveryTask({ status: 'closed', rows: [acceptedRow] }),
    );
    expect(closed.statusLabel).toBe('Выдача закрыта');
    expect(closed.actions).toContainEqual(
      expect.objectContaining({ enabled: false, label: 'Выдача закрыта' }),
    );
  });

  it('не считает чужой или raw-invalid QR ожидаемым и не помечает его отгруженным', () => {
    const base = deliveryTask();
    const object = deliveryTaskToWorkObject(
      deliveryTask({
        status: 'closed',
        rows: [
          { ...base.rows[0], scanStatus: 'accepted' },
          {
            ...base.rows[0],
            id: 'error-row-1',
            rollCode: 'FOREIGN-ROLL',
            scanStatus: 'excess',
          },
          {
            ...base.rows[0],
            id: 'error-row-2',
            rollCode: null,
            scanStatus: 'wrong',
          },
        ],
      }),
    );
    const workbench = object.workbench as Extract<
      NonNullable<typeof object.workbench>,
      { type: 'warehouse' }
    >;

    expect(workbench.expected).toBe(1);
    expect(workbench.scanned).toBe(1);
    expect(workbench.expectedRolls).toHaveLength(1);
    expect(workbench.expectedRolls?.[0]).toMatchObject({
      id: 'A-2001-roll-1',
      ownership: 'shipped',
      productionStatus: 'delivered',
    });
    expect(workbench.excess).toEqual(['FOREIGN-ROLL', 'Ошибка скана 2']);
    expect(JSON.stringify(object)).not.toContain('scannerPayload');
  });
});

describe('warehouse pallet/printer API', () => {
  beforeEach(() => {
    clearSession();
    saveSession({
      version: 1,
      token: 'warehouse-token',
      role: 'warehouse',
      serverRole: 'warehouse',
      userId: 'warehouse-user',
      displayName: 'Склад',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('отправляет void с ограниченным комментарием и принимает только известный documentStatus', async () => {
    const result = {
      id: 'pallet-document-1',
      palletId: 'PAL-A-2001-01',
      warehousePalletId: 'pallet-1',
      origin: 'physical_pallet',
      documentStatus: 'voided',
      createdAt: '2026-08-07T10:00:00.000Z',
      templateVersion: 'pallet-100x150-v1',
      printReady: true,
      printStatus: 'needs_admin',
      rollCount: 2,
      rollCodes: ['A-2001-roll-1', 'A-2001-roll-2'],
      rollCodesHasMore: false,
      orderId: 'order-a-2001',
      futureServerField: 'allowed-by-additive-parser',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(result))
      .mockResolvedValueOnce(okResponse({ ...result, documentStatus: 'unknown' }));
    vi.stubGlobal('fetch', fetchMock);
    const note = 'а'.repeat(500);

    await expect(
      voidWarehousePallet('task-1', 'pallet-1', {
        operationKey: OPERATION_KEY,
        reasonCode: 'wrong_composition',
        note,
      }),
    ).resolves.toMatchObject({ documentStatus: 'voided' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/task-1/pallets/pallet-1/void',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operationKey: OPERATION_KEY,
          reasonCode: 'wrong_composition',
          note,
        }),
      }),
    );

    await expect(
      voidWarehousePallet('task-1', 'pallet-1', {
        operationKey: OPERATION_KEY,
        reasonCode: 'other',
      }),
    ).rejects.toThrow('Некорректный ответ аннулирования палетного листа.');
  });

  it('отправляет явные printerId и requestId в идемпотентный print endpoint', async () => {
    const result: ServerPalletPrintResult = {
      id: 'job-1',
      requestId: '11111111-1111-4111-8111-111111111111',
      printerId: 'printer-1',
      status: 'submitted',
      gatewayCommandId: 'gateway-1',
      message: 'Задание отправлено',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      printWarehousePalletList('pl-1', {
        printerId: 'printer-1',
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/pallet-lists/pl-1/print',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          printerId: 'printer-1',
          requestId: '11111111-1111-4111-8111-111111111111',
        }),
      }),
    );
  });

  it('фиксирует точное browser-print intent без printerId и без ложного print result', async () => {
    const result: ServerPalletSystemPrintIntentResult = {
      eventId: 'event-1',
      requestId: OPERATION_KEY,
      palletListDocumentId: 'pl-1',
      kind: 'reprint',
      status: 'intent_recorded',
      replayed: false,
      requestedAt: '2026-08-09T07:00:00.000Z',
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      recordWarehousePalletSystemPrintIntent('pl-1', {
        requestId: OPERATION_KEY,
        kind: 'reprint',
        reason: 'Этикетка повреждена',
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/pallet-lists/pl-1/system-print-intents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          requestId: OPERATION_KEY,
          kind: 'reprint',
          reason: 'Этикетка повреждена',
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain('printerId');
    expect(result).not.toHaveProperty('printJob');
    expect(result).not.toHaveProperty('copies');
  });

  it.each([
    ['requestId', { requestId: '22222222-2222-4222-8222-222222222222' }],
    ['documentId', { palletListDocumentId: 'pl-other' }],
    ['kind', { kind: 'initial' }],
    ['status', { status: 'queued' }],
    ['timestamp', { requestedAt: '2026-08-09 07:00:00' }],
  ])('не подтверждает системную печать при неверном echo %s', async (_case, override) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          eventId: 'event-1',
          requestId: OPERATION_KEY,
          palletListDocumentId: 'pl-1',
          kind: 'reprint',
          status: 'intent_recorded',
          replayed: false,
          requestedAt: '2026-08-09T07:00:00.000Z',
          ...override,
        }),
      ),
    );

    const promise = recordWarehousePalletSystemPrintIntent('pl-1', {
      requestId: OPERATION_KEY,
      kind: 'reprint',
      reason: 'Этикетка повреждена',
    });

    await expect(promise).rejects.toBeInstanceOf(ApiResponseParseError);
    await expect(promise).rejects.toMatchObject({ deliveryUncertain: true });
  });

  it('закрывает и печатает текущий палет одним идемпотентным запросом', async () => {
    const result: ServerCloseAndPrintPalletResult = {
      pallet: {
        ...task().activePallet!,
        status: 'sealed',
      },
      document: {
        id: 'pl-1',
        palletId: 'PAL-A-2001-01',
        warehousePalletId: 'pallet-1',
        origin: 'physical_pallet',
        createdAt: '2026-07-17T08:00:00.000Z',
        templateVersion: 'pallet-100x150-v1',
        printReady: true,
        printStatus: 'submitted',
        rollCount: 1,
        rollCodes: ['A-2001-roll-1'],
        rollCodesHasMore: false,
        orderId: 'order-a-2001',
      },
      printJob: {
        id: 'job-1',
        requestId: OPERATION_KEY,
        printerId: 'printer-1',
        status: 'submitted',
        gatewayCommandId: 'gateway-1',
        message: 'Задание отправлено',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      closeAndPrintCurrentWarehousePallet('task-1', {
        printerId: 'printer-1',
        requestId: OPERATION_KEY,
      }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/task-1/pallets/current/close-and-print',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          printerId: 'printer-1',
          requestId: OPERATION_KEY,
        }),
      }),
    );
  });

  it('закрывает текущий палет для системной печати без printerId', async () => {
    const result: ServerSealPalletResult = {
      pallet: {
        ...task().activePallet!,
        status: 'sealed',
      },
      document: {
        id: 'pl-compact-1',
        palletId: 'PAL-A-2001-01',
        warehousePalletId: 'pallet-1',
        origin: 'physical_pallet',
        documentStatus: 'sealed',
        createdAt: '2026-08-08T08:00:00.000Z',
        templateVersion: 'pallet-100x100-extended-v6',
        printReady: true,
        printStatus: 'not_printed',
        rollCount: 1,
        rollCodes: ['A-2001-roll-1'],
        rollCodesHasMore: false,
        orderId: 'order-a-2001',
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sealCurrentWarehousePallet('task-1', { requestId: OPERATION_KEY }),
    ).resolves.toEqual(result);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/task-1/pallets/current/seal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ requestId: OPERATION_KEY }),
      }),
    );
  });

  it('принимает configurable-v7 sealed document и отклоняет неизвестный print profile', async () => {
    const result = sealedPalletResult();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(result))
      .mockResolvedValueOnce(
        okResponse({
          ...result,
          document: { ...result.document, templateVersion: 'pallet-unknown-v99' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sealCurrentWarehousePallet('task-1', { requestId: OPERATION_KEY }),
    ).resolves.toEqual(result);
    await expect(
      sealCurrentWarehousePallet('task-1', { requestId: OPERATION_KEY }),
    ).rejects.toBeInstanceOf(ApiResponseParseError);
  });

  it('constructs an exact safe seal result without retaining additive payload fields', async () => {
    const expected = sealedPalletResult();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          ...expected,
          rawPayload: 'must-not-cross-boundary',
          pallet: { ...expected.pallet, devicePayload: 'must-not-cross-boundary' },
          document: { ...expected.document, sourceSnapshot: 'must-not-cross-boundary' },
        }),
      ),
    );

    await expect(
      sealCurrentWarehousePallet('task-1', { requestId: OPERATION_KEY }),
    ).resolves.toEqual(expected);
  });

  it.each([
    [
      'document is not print-ready',
      (result: ServerSealPalletResult) => Reflect.set(result.document, 'printReady', false),
    ],
    [
      'document lifecycle is not sealed',
      (result: ServerSealPalletResult) => Reflect.set(result.document, 'documentStatus', 'voided'),
    ],
    [
      'seal print lifecycle already advanced',
      (result: ServerSealPalletResult) => Reflect.set(result.document, 'printStatus', 'submitted'),
    ],
    [
      'pallet lifecycle is still open',
      (result: ServerSealPalletResult) => Reflect.set(result.pallet, 'status', 'open'),
    ],
    [
      'pallet id is not canonical',
      (result: ServerSealPalletResult) => (result.pallet.id = ' pallet-1'),
    ],
    ['document id is empty', (result: ServerSealPalletResult) => (result.document.id = '')],
    ['pallet code is empty', (result: ServerSealPalletResult) => (result.pallet.palletCode = '')],
    [
      'pallet order number is missing',
      (result: ServerSealPalletResult) => Reflect.deleteProperty(result.pallet, 'orderNumber'),
    ],
    [
      'pallet sequence is invalid',
      (result: ServerSealPalletResult) => (result.pallet.sequenceNo = 0),
    ],
    [
      'pallet row timestamp is malformed',
      (result: ServerSealPalletResult) => (result.pallet.rows[0]!.acceptedAt = '2026-08-11 21:30'),
    ],
    [
      'pallet row actor is malformed',
      (result: ServerSealPalletResult) => Reflect.set(result.pallet.rows[0]!, 'scannedByName', 17),
    ],
    [
      'document lifecycle is missing',
      (result: ServerSealPalletResult) => Reflect.deleteProperty(result.document, 'documentStatus'),
    ],
    [
      'document origin is legacy',
      (result: ServerSealPalletResult) => Reflect.set(result.document, 'origin', 'legacy'),
    ],
    [
      'document profile uses the gateway transport',
      (result: ServerSealPalletResult) =>
        Reflect.set(result.document, 'templateVersion', 'pallet-100x150-compact-v2'),
    ],
    [
      'document points to another pallet code',
      (result: ServerSealPalletResult) => (result.document.palletId = 'PAL-OTHER'),
    ],
    [
      'document points to another pallet row',
      (result: ServerSealPalletResult) => (result.document.warehousePalletId = 'pallet-other'),
    ],
    [
      'document points to another order',
      (result: ServerSealPalletResult) => (result.document.orderId = 'order-other'),
    ],
    [
      'document roll count differs',
      (result: ServerSealPalletResult) => (result.document.rollCount = 2),
    ],
    [
      'document composition differs',
      (result: ServerSealPalletResult) => (result.document.rollCodes = ['ROLL-OTHER']),
    ],
  ])('fail-closes seal response when %s', async (_case, mutate) => {
    const result = sealedPalletResult();
    mutate(result);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(result)));

    await expect(
      sealCurrentWarehousePallet('task-1', { requestId: OPERATION_KEY }),
    ).rejects.toBeInstanceOf(ApiResponseParseError);
  });

  it('отправляет точный HID payload без prompt-преобразования', async () => {
    const response: ServerWarehouseScanResult = {
      operationId: 'operation-1',
      taskId: 't1',
      rollCode: 'A-2001-roll-1',
      mode: 'receiving',
      scanStatus: 'accepted',
      replayed: false,
      task: task({
        lastScanResult: {
          rollCode: 'A-2001-roll-1',
          scanStatus: 'accepted',
          scannedAt: '2026-07-15T08:31:00.000Z',
        },
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = PHYSICAL_QR;

    const result: ServerWarehouseScanResult = await scanWarehousePayload(payload, OPERATION_KEY);
    expect(result).toEqual(response);
    expect(result.scanStatus).toBe('accepted');
    expect(result.task.taskId).toBe('t1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/intake/scans',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey: OPERATION_KEY, payload }),
      }),
    );
  });

  it('распознаёт физический QR палетного листа строго по формату', () => {
    expect(isWarehousePalletPayload(PALLET_QR)).toBe(true);
    expect(isWarehousePalletPayload(`PLT_${'a'.repeat(64)}`)).toBe(false);
    expect(isWarehousePalletPayload(`plt_${'a'.repeat(63)}`)).toBe(false);
    expect(isWarehousePalletPayload(`${PALLET_QR}\n`)).toBe(false);
    expect(isWarehousePalletPayload(PHYSICAL_QR)).toBe(false);
  });

  it('создаёт выдачу сканом палетного листа и подтверждает точный ответ', async () => {
    const response: ServerWarehousePalletHandoffScanResult = {
      operationKey: OPERATION_KEY,
      documentId: 'pallet-document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      deliveryCreated: true,
      rollCount: 2,
      replayed: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(scanWarehousePallet(PALLET_QR, OPERATION_KEY)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/pallets/scans',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey: OPERATION_KEY, payload: PALLET_QR }),
      }),
    );
  });

  it('закрывает выдачу одним сканом палетного листа и подтверждает bounded-ответ', async () => {
    const response: ServerWarehousePalletDeliveryScanResult = {
      operationKey: OPERATION_KEY,
      documentId: 'pallet-document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      rollCount: 2,
      newlyDeliveredRollCount: 2,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'closed',
      deliveryClosed: true,
      replayed: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(scanWarehousePalletDelivery(PALLET_QR, OPERATION_KEY)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/pallets/delivery-scans',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey: OPERATION_KEY, payload: PALLET_QR }),
      }),
    );
  });

  it('принимает частичную выдачу палеты, пока остальные рулоны заказа ещё не готовы', async () => {
    const response: ServerWarehousePalletDeliveryScanResult = {
      operationKey: OPERATION_KEY,
      documentId: 'pallet-document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      rollCount: 2,
      newlyDeliveredRollCount: 2,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'partial',
      deliveryClosed: false,
      replayed: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
    );

    await expect(scanWarehousePalletDelivery(PALLET_QR, OPERATION_KEY)).resolves.toEqual(response);
  });

  it('отклоняет противоречивый ответ палетной выдачи', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            operationKey: OPERATION_KEY,
            documentId: 'pallet-document-1',
            palletId: 'pallet-1',
            palletCode: 'PAL-A-100-01',
            orderId: 'order-1',
            deliveryTaskId: 'delivery-1',
            rollCount: 2,
            newlyDeliveredRollCount: 2,
            alreadyDeliveredRollCount: 1,
            remainingRollCount: 0,
            taskStatus: 'closed',
            deliveryClosed: true,
            replayed: false,
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(scanWarehousePalletDelivery(PALLET_QR, OPERATION_KEY)).rejects.toBeInstanceOf(
      ApiResponseParseError,
    );
  });

  it.each([
    ['идентификатор длиннее 200 символов', { documentId: 'd'.repeat(201) }],
    ['небезопасное целое число рулонов', { rollCount: Number.MAX_SAFE_INTEGER + 1 }],
    ['число рулонов больше лимита палеты', { rollCount: 101 }],
  ])('отклоняет ответ скана палеты: %s', async (_case, override) => {
    const response = {
      operationKey: OPERATION_KEY,
      documentId: 'pallet-document-1',
      palletId: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-1',
      deliveryTaskId: 'delivery-1',
      deliveryCreated: true,
      rollCount: 2,
      replayed: false,
      ...override,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })),
    );

    await expect(scanWarehousePallet(PALLET_QR, OPERATION_KEY)).rejects.toBeInstanceOf(
      ApiResponseParseError,
    );
  });

  it('не считает мутацию палеты подтверждённой при неполном ответе', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            operationKey: OPERATION_KEY,
            palletId: 'pallet-1',
            palletCode: 'PAL-A-100-01',
            orderId: 'order-1',
            deliveryTaskId: 'delivery-1',
            deliveryCreated: true,
            rollCount: 2,
            replayed: false,
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(scanWarehousePallet(PALLET_QR, OPERATION_KEY)).rejects.toBeInstanceOf(
      ApiResponseParseError,
    );
  });

  it('грузит и сканирует выдачу через task-scoped backend endpoints', async () => {
    const row = deliveryTask();
    const reserve = deliveryTask({ id: 'reserve-1', mode: 'reserve' });
    const scanned: ServerWarehouseScanResult = {
      operationId: 'operation-2',
      taskId: 'delivery-1',
      rollCode: 'A-2001-roll-1',
      mode: 'delivery',
      scanStatus: 'accepted',
      replayed: false,
      task: task({
        taskId: 'delivery-1',
        lastScanResult: {
          rollCode: 'A-2001-roll-1',
          scanStatus: 'accepted',
          scannedAt: '2026-07-15T08:31:00.000Z',
        },
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([row]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([reserve]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(scanned), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = PHYSICAL_QR;

    await expect(fetchWarehouseDeliveryTasks()).resolves.toEqual([row, reserve]);
    const result: ServerWarehouseScanResult = await scanWarehouseTask(
      'delivery-1',
      payload,
      OPERATION_KEY,
    );
    expect(result).toEqual(scanned);
    expect(result.task.taskId).toBe('delivery-1');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/warehouse/tasks?mode=delivery',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/warehouse/tasks?mode=reserve',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-token' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/warehouse/tasks/delivery-1/scans',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationKey: OPERATION_KEY, payload }),
      }),
    );
  });

  it('возвращает PNG preview как Blob и передаёт Bearer', async () => {
    const expected = new Blob(['png-bytes'], { type: 'image/png' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(expected, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const actual = await fetchWarehousePalletPreview('pl-1');

    expect(actual).toBeInstanceOf(Blob);
    expect(actual.type).toBe('image/png');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/pallet-lists/pl-1/preview',
      expect.any(Object),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer warehouse-token');
  });

  it('получает только явный список доступных складских принтеров', async () => {
    const printers = [
      {
        id: 'printer-1',
        code: 'TLP4',
        label: 'MERTECH TLP4',
        post: { id: 'post-1', code: 'WH-1', name: 'Склад' },
        status: 'online',
        ready: true,
        unavailableReason: null,
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(printers), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWarehousePrinters()).resolves.toEqual(printers);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/printers',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('warehouse notification projection', () => {
  it('проецирует безопасное backend-событие и не переносит raw/legal поля', () => {
    const row = {
      id: 'event-1',
      type: 'problem:operator_defect_reported',
      label: 'Брак рулона',
      objectId: 'ROLL-1',
      reason: 'Разрыв полотна',
      createdAt: '2026-07-13T09:00:00.000Z',
      rawPayload: { secret: true },
      parsedPayload: { secret: true },
      legalName: 'Секретное ООО',
    } as ServerWarehouseNotification & Record<string, unknown>;

    const notification = warehouseNotificationToItem(row);
    expect(notification).toEqual(
      expect.objectContaining({
        id: 'event-1',
        eventType: 'problem:operator_defect_reported',
        recipientRole: 'warehouse',
        title: 'Брак рулона',
        objectId: 'ROLL-1',
      }),
    );
    const serialized = JSON.stringify(notification);
    expect(serialized).not.toMatch(/rawPayload|parsedPayload|legalName|Секретное ООО/);
  });

  it('заменяет событие с тем же backend id без дубля и сохраняет другие роли', () => {
    const current = [
      {
        id: 'event-1',
        eventType: 'problem:operator_defect_reported',
        recipientRole: 'warehouse' as const,
        severity: 'warning' as const,
        title: 'Старое',
        body: 'Старое',
        createdAt: 'раньше',
        requiresAck: true,
        sound: true,
      },
      {
        id: 'finance-1',
        recipientRole: 'finance' as const,
        severity: 'info' as const,
        title: 'Финансы',
        body: 'Не менять',
        createdAt: 'сейчас',
        requiresAck: false,
        sound: false,
      },
    ];
    const incoming: ServerWarehouseNotification[] = [
      {
        id: 'event-1',
        type: 'problem:operator_defect_reported',
        label: 'Новое',
        objectId: 'ROLL-1',
        reason: 'Обновлено',
        createdAt: '2026-07-13T09:00:00.000Z',
      },
    ];

    const merged = mergeWarehouseNotifications(current, incoming);
    expect(merged.filter((item) => item.id === 'event-1')).toHaveLength(1);
    expect(merged.find((item) => item.id === 'event-1')?.title).toBe('Новое');
    expect(merged.find((item) => item.id === 'finance-1')?.body).toBe('Не менять');
  });
});
