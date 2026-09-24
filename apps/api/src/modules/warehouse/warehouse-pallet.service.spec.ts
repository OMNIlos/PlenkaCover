import { createHash } from 'node:crypto';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { ConfigurablePalletLabelRenderer } from '../../common/pallet-label-layout/configurable-pallet-label.renderer';
import { PalletLabelLayoutPublicationService } from '../../common/pallet-label-layout/pallet-label-layout-publication.service';
import { PalletExportService, type PalletExportDocument } from './pallet-export.service';
import { PalletLabelRenderer } from './pallet-label.renderer';
import * as palletListBuilder from './pallet-list.builder';
import {
  hasExactPalletDocumentComposition,
  hasRenderablePalletDocumentSnapshot,
} from './pallet-label-snapshot';
import { WarehousePalletService } from './warehouse-pallet.service';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from '../admin/pallet-label-layout-editor.validator';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';

const ACTOR: Actor = {
  userId: 'warehouse-user',
  role: 'warehouse',
  sessionId: 'session-1',
  sessionPurpose: 'full',
  capabilities: ['warehouse:scan'],
};

const OPEN_PALLET = {
  id: 'pallet-1',
  palletCode: 'PAL-A-100-01',
  orderId: 'order-a',
  sequenceNo: 1,
};

function setup() {
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    warehousePallet: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(OPEN_PALLET),
    },
    warehousePalletItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
      create: jest.fn().mockResolvedValue({ position: 1 }),
    },
  };
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  const prisma = {};
  const palletPrint = {};
  const fulfillment = {};
  const service = new WarehousePalletService(
    prisma as never,
    audit as never,
    palletPrint as never,
    { palletLabelProfile: 'pallet-100x150-v1' },
    fulfillment as never,
  );

  return { service, tx, audit, prisma, palletPrint };
}

const CLOSE_REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const ACCEPTED_AT = new Date('2026-07-31T12:00:00.000Z');
const OPENED_AT = new Date('2026-07-31T11:00:00.000Z');
const DOCUMENT_CREATED_AT = new Date('2026-07-31T12:01:00.000Z');

const CLOSE_ITEM = {
  id: 'item-1',
  palletId: 'pallet-1',
  orderId: 'order-a',
  rollCode: 'ROLL-1',
  position: 1,
  acceptedAt: ACCEPTED_AT,
  scanRow: {
    id: 'row-1',
    rollCode: 'ROLL-1',
    fromOrderId: 'A-100',
    scanStatus: 'accepted',
    lastScanAt: ACCEPTED_AT,
    scannedByName: 'Склад 1',
  },
};

function closeSetup(options: { items?: Array<typeof CLOSE_ITEM>; printError?: unknown } = {}) {
  const items = options.items ?? [CLOSE_ITEM];
  const pallet = {
    id: 'pallet-1',
    palletCode: 'PAL-A-100-01',
    taskId: 'task-1',
    orderId: 'order-a',
    sequenceNo: 1,
    status: 'open',
    openedAt: OPENED_AT,
    order: { id: 'order-a', orderNumber: 'A-100' },
    items,
  };
  const document = {
    id: 'document-1',
    palletId: 'PAL-A-100-01',
    warehousePalletId: 'pallet-1',
    acceptanceTaskId: 'task-1',
    origin: 'physical_pallet',
    rollIds: items.map((item) => item.rollCode),
    orderIds: ['order-a'],
    payload: {
      templateVersion: 'pallet-100x150-v1',
      printReady: true,
      label: { templateVersion: 'pallet-100x150-v1' },
      rows: items.map((item) => ({ rollCode: item.rollCode })),
    },
    createdAt: DOCUMENT_CREATED_AT,
    printJobs: [],
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'task-1' }]),
    warehouseAcceptanceTask: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'task-1',
        mode: 'receiving',
        status: 'open',
        operationCode: 'ПР-3107-01',
        createdAt: OPENED_AT,
        updatedAt: ACCEPTED_AT,
      }),
    },
    warehousePallet: {
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(pallet),
      findUnique: jest.fn().mockResolvedValue(pallet),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    warehousePalletItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    palletListDocument: {
      create: jest.fn().mockResolvedValue(document),
    },
    operatorRollLine: {
      findMany: jest.fn().mockResolvedValue(
        items.map((item, index) => ({
          sequence: index + 1,
          planKg: 40,
          netKg: 40,
          grossKg: 42,
          warehouseState: 'received',
          rollDispatchItem: {
            id: `dispatch-${index + 1}`,
            rollCode: item.rollCode,
            filmType: 'полотно',
            plannedLengthM: 275,
            characteristicsSnapshot: {},
            status: 'done',
            completedAt: ACCEPTED_AT,
            assignedOperator: { displayName: 'Оператор 1' },
            post: { id: 'post-1', name: 'Станок 1', code: 'POST-1' },
            productionOrder: {
              id: 'production-order-1',
              commercialOrder: {
                id: 'order-a',
                orderNumber: 'A-100',
                counterparty: null,
              },
            },
          },
        })),
      ),
    },
    warehouseRoll: {
      findMany: jest.fn().mockResolvedValue(
        items.map((item) => ({
          rollCode: item.rollCode,
          ownerCounterpartyId: null,
          reservedForOrderId: null,
          warehouseStatus: 'received',
          positionSnapshot: {},
        })),
      ),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ displayName: 'Склад 1' }),
    },
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = {
    record: jest.fn().mockResolvedValue({ id: 'event-1' }),
  };
  const printJob = {
    id: 'print-job-1',
    requestId: CLOSE_REQUEST_ID,
    printerId: 'printer-1',
    status: 'submitted',
    gatewayCommandId: 'gateway-command-1',
    message: 'Задание отправлено',
  };
  const palletPrint = {
    print: options.printError
      ? jest.fn().mockRejectedValue(options.printError)
      : jest.fn().mockResolvedValue(printJob),
  };
  const fulfillment = {
    reconcilePalletScan: jest.fn().mockResolvedValue({
      state: 'incomplete',
      deliveryTaskId: 'delivery-1',
      created: true,
      reason: null,
    }),
  };
  const service = new WarehousePalletService(
    prisma,
    audit as never,
    palletPrint as never,
    { palletLabelProfile: 'pallet-100x150-v1' },
    fulfillment as never,
  );

  return { service, prisma, tx, audit, fulfillment, palletPrint, pallet, document, printJob };
}

describe('WarehousePalletService', () => {
  describe('square-v4 document composition', () => {
    const payload = {
      templateVersion: 'pallet-100x100-square-v4',
      rows: [
        { seq: 1, rollCode: 'ROLL-1' },
        { seq: 2, rollCode: 'ROLL-2' },
      ],
      label: {
        templateVersion: 'pallet-100x100-square-v4',
        palletId: 'PAL-A-100-01',
        materialMark: 'PE-LD',
        productNames: ['Пленка полиэтиленовая рукав 29мкм'],
        article: null,
        rollCount: 2,
        rollCodes: ['ROLL-1', 'ROLL-2'],
        packagingMaterial: null,
        packagingCount: null,
        netKg: 15.9,
        grossKg: 17.2,
        productionDate: '08.2026',
        shelfLifeMonths: 12,
        deliveryDate: null,
        storageConditions: 'Хранение в закрытом сухом помещении при температуре 5–35 °C.',
        orderNumbers: ['A-100'],
        customerAliases: ['Заказчик'],
        createdAt: '2026-08-08T15:03:33.642Z',
      },
    };
    const withCodes = (rollCodes: string[]) => ({
      ...payload,
      rows: rollCodes.map((rollCode, index) => ({ seq: index + 1, rollCode })),
      label: { ...payload.label, rollCount: rollCodes.length, rollCodes },
    });

    it('accepts only one exact, ordered, unique composition across label, rows and document', () => {
      expect(hasExactPalletDocumentComposition(payload, ['ROLL-1', 'ROLL-2'])).toBe(true);
      expect(hasExactPalletDocumentComposition(payload, ['ROLL-2', 'ROLL-1'])).toBe(false);
      expect(
        hasExactPalletDocumentComposition(
          {
            ...payload,
            label: { ...payload.label, rollCodes: ['ROLL-1', 'ROLL-3'] },
          },
          ['ROLL-1', 'ROLL-2'],
        ),
      ).toBe(false);
      expect(
        hasExactPalletDocumentComposition(
          {
            ...payload,
            rows: [
              { seq: 2, rollCode: 'ROLL-1' },
              { seq: 1, rollCode: 'ROLL-2' },
            ],
          },
          ['ROLL-1', 'ROLL-2'],
        ),
      ).toBe(false);
      expect(
        hasExactPalletDocumentComposition(
          {
            ...payload,
            rows: [
              { seq: 1, rollCode: 'ROLL-1' },
              { seq: 2, rollCode: 'ROLL-1' },
            ],
            label: { ...payload.label, rollCodes: ['ROLL-1', 'ROLL-1'] },
          },
          ['ROLL-1', 'ROLL-1'],
        ),
      ).toBe(false);
    });

    it('uses the exact renderer for the 24-code boundary and first invalid compositions', () => {
      const boundaryCodes = Array.from({ length: 24 }, (_, index) => `A-2-roll-${index + 1}`);
      const overflowingCodes = [...boundaryCodes, 'A-2-roll-25'];
      const longCodes = ['A'.repeat(80), 'B'.repeat(80)];

      expect(hasExactPalletDocumentComposition(withCodes(boundaryCodes), boundaryCodes)).toBe(true);
      expect(hasExactPalletDocumentComposition(withCodes(overflowingCodes), overflowingCodes)).toBe(
        true,
      );
      expect(hasExactPalletDocumentComposition(withCodes(longCodes), longCodes)).toBe(true);
      expect(hasRenderablePalletDocumentSnapshot(withCodes(boundaryCodes))).toBe(true);
      expect(hasRenderablePalletDocumentSnapshot(withCodes(overflowingCodes))).toBe(false);
      expect(hasRenderablePalletDocumentSnapshot(withCodes(longCodes))).toBe(false);
    });

    it('applies the same ordered, pre-persist composition gate to safe-v5', () => {
      const safePayload = {
        ...payload,
        templateVersion: 'pallet-100x100-safe-v5',
        label: { ...payload.label, templateVersion: 'pallet-100x100-safe-v5' },
      };

      expect(hasExactPalletDocumentComposition(safePayload, ['ROLL-1', 'ROLL-2'])).toBe(true);
      expect(hasExactPalletDocumentComposition(safePayload, ['ROLL-2', 'ROLL-1'])).toBe(false);
      expect(
        hasExactPalletDocumentComposition(
          {
            ...safePayload,
            label: { ...safePayload.label, templateVersion: 'pallet-100x100-square-v4' },
          },
          ['ROLL-1', 'ROLL-2'],
        ),
      ).toBe(false);
    });

    it('rejects a corrupted square-v4 snapshot before persisting or sealing the pallet', async () => {
      const sealed = closeSetup();
      const original = palletListBuilder.buildPalletListPayload;
      const buildSpy = jest
        .spyOn(palletListBuilder, 'buildPalletListPayload')
        .mockImplementation((...args) => {
          const built = original(...args);
          return {
            ...built,
            label: {
              ...built.label,
              templateVersion: 'pallet-100x100-square-v4',
              rollCodes: ['OTHER-ROLL'],
            },
            templateVersion: 'pallet-100x100-square-v4',
          } as ReturnType<typeof original>;
        });
      (sealed.service as unknown as { config: { palletLabelProfile: string } }).config = {
        palletLabelProfile: 'pallet-100x100-square-v4',
      };

      try {
        await expect(
          sealed.service.sealCurrentPallet(ACTOR, 'task-1', { requestId: CLOSE_REQUEST_ID }),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'PALLET_LABEL_COMPOSITION_INVALID' }),
        });
      } finally {
        buildSpy.mockRestore();
      }

      expect(sealed.tx.palletListDocument.create).not.toHaveBeenCalled();
      expect(sealed.tx.warehousePallet.updateMany).not.toHaveBeenCalled();
      expect(sealed.audit.record).not.toHaveBeenCalled();
    });

    it('seals and persists the real non-mocked 24-code square boundary truthfully', async () => {
      const rollCodes = Array.from({ length: 24 }, (_, index) => `A-2-roll-${index + 1}`);
      const items = rollCodes.map((rollCode, index) => ({
        ...CLOSE_ITEM,
        id: `item-${index + 1}`,
        rollCode,
        position: index + 1,
        scanRow: {
          ...CLOSE_ITEM.scanRow,
          id: `row-${index + 1}`,
          rollCode,
        },
      }));
      const sealed = closeSetup({ items });
      (sealed.service as unknown as { config: { palletLabelProfile: string } }).config = {
        palletLabelProfile: 'pallet-100x100-square-v4',
      };

      await expect(
        sealed.service.sealCurrentPallet(ACTOR, 'task-1', { requestId: CLOSE_REQUEST_ID }),
      ).resolves.toBeDefined();

      expect(sealed.tx.palletListDocument.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rollIds: rollCodes,
          format: 'label_100x100',
          fieldSetStatus: 'template_square_v4',
          payload: expect.objectContaining({
            templateVersion: 'pallet-100x100-square-v4',
            label: expect.objectContaining({
              templateVersion: 'pallet-100x100-square-v4',
              rollCodes,
            }),
          }),
        }),
      });
      expect(sealed.tx.warehousePallet.updateMany).toHaveBeenCalledTimes(1);
      expect(sealed.audit.record).toHaveBeenCalled();
    });

    it.each([
      ['25 ordinary roll codes', Array.from({ length: 25 }, (_, index) => `A-2-roll-${index + 1}`)],
      ['two 80-character roll codes', ['A'.repeat(80), 'B'.repeat(80)]],
    ])('rejects unrenderable %s before persist, seal and audit', async (_case, rollCodes) => {
      const items = rollCodes.map((rollCode, index) => ({
        ...CLOSE_ITEM,
        id: `item-${index + 1}`,
        rollCode,
        position: index + 1,
        scanRow: {
          ...CLOSE_ITEM.scanRow,
          id: `row-${index + 1}`,
          rollCode,
        },
      }));
      const sealed = closeSetup({ items });
      (sealed.service as unknown as { config: { palletLabelProfile: string } }).config = {
        palletLabelProfile: 'pallet-100x100-square-v4',
      };

      await expect(
        sealed.service.sealCurrentPallet(ACTOR, 'task-1', { requestId: CLOSE_REQUEST_ID }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: 'PALLET_LABEL_NOT_RENDERABLE' }),
      });

      expect(sealed.tx.palletListDocument.create).not.toHaveBeenCalled();
      expect(sealed.tx.warehousePallet.updateMany).not.toHaveBeenCalled();
      expect(sealed.audit.record).not.toHaveBeenCalled();
    });
  });

  it('opens pallet 01 for the first accepted order', async () => {
    const { service, tx, audit } = setup();

    const result = await service.prepareOpenPallet(tx, {
      taskId: 'task-1',
      orderId: 'order-a',
      orderNumber: 'A-100',
      actor: ACTOR,
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.warehousePallet.create).toHaveBeenCalledWith({
      data: {
        palletCode: 'PAL-A-100-01',
        taskId: 'task-1',
        orderId: 'order-a',
        sequenceNo: 1,
        openedById: 'warehouse-user',
      },
      select: {
        id: true,
        palletCode: true,
        orderId: true,
        sequenceNo: true,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_pallet_opened',
        actorRole: 'warehouse',
        actorId: 'warehouse-user',
        objectId: 'pallet-1',
        detail: expect.objectContaining({
          palletCode: 'PAL-A-100-01',
          taskId: 'task-1',
          orderId: 'order-a',
          sequenceNo: 1,
        }),
      }),
      tx,
    );
    expect(result).toEqual({
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-a',
      sequenceNo: 1,
    });
  });

  it('reuses the open pallet for the same order', async () => {
    const { service, tx, audit } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue(OPEN_PALLET);

    await expect(
      service.prepareOpenPallet(tx, {
        taskId: 'task-1',
        orderId: 'order-a',
        orderNumber: 'A-100',
        actor: ACTOR,
      }),
    ).resolves.toEqual({
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      orderId: 'order-a',
      sequenceNo: 1,
    });

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a different order with WAREHOUSE_PALLET_ORDER_MISMATCH', async () => {
    const { service, tx } = setup();
    tx.warehousePallet.findFirst.mockResolvedValue(OPEN_PALLET);

    await expect(
      service.prepareOpenPallet(tx, {
        taskId: 'task-1',
        orderId: 'order-b',
        orderNumber: 'B-200',
        actor: ACTOR,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WAREHOUSE_PALLET_ORDER_MISMATCH',
        activePalletCode: 'PAL-A-100-01',
        activeOrderId: 'order-a',
        attemptedOrderId: 'order-b',
      },
    });

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
  });

  it('creates one ordered item and replays without a duplicate', async () => {
    const { service, tx } = setup();
    tx.warehousePalletItem.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      palletId: 'pallet-1',
      orderId: 'order-a',
      rollCode: 'ROLL-1',
      position: 1,
    });

    const input = {
      pallet: OPEN_PALLET,
      scanRowId: 'row-1',
      rollCode: 'ROLL-1',
      acceptedAt: new Date('2026-07-31T12:00:00.000Z'),
      actorId: 'warehouse-user',
    };

    await expect(service.attachAcceptedRoll(tx, input)).resolves.toEqual({ position: 1 });
    await expect(service.attachAcceptedRoll(tx, input)).resolves.toEqual({ position: 1 });

    expect(tx.warehousePalletItem.findFirst).toHaveBeenCalledWith({
      where: { scanRowId: 'row-1', releasedAt: null },
      select: {
        palletId: true,
        orderId: true,
        rollCode: true,
        position: true,
      },
    });
    expect(tx.warehousePalletItem.create).toHaveBeenCalledTimes(1);
    expect(tx.warehousePalletItem.create).toHaveBeenCalledWith({
      data: {
        palletId: 'pallet-1',
        scanRowId: 'row-1',
        orderId: 'order-a',
        rollCode: 'ROLL-1',
        position: 1,
        acceptedAt: input.acceptedAt,
        assignedById: 'warehouse-user',
      },
      select: { position: true },
    });
  });

  it('rejects legacy close-and-print for square-v4 before seal, persist, audit or print', async () => {
    const { service, prisma, tx, audit, palletPrint } = closeSetup();
    (service as unknown as { config: { palletLabelProfile: string } }).config = {
      palletLabelProfile: 'pallet-100x100-square-v4',
    };

    await expect(
      service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' },
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.palletListDocument.create).not.toHaveBeenCalled();
    expect(tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(palletPrint.print).not.toHaveBeenCalled();
  });

  it('rejects legacy close-and-print when an active v7 publication wins inside the seal tx', async () => {
    const sealed = closeSetup();
    const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    const activeForNewDocument = jest.fn().mockResolvedValue({
      id: 'publication-1',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    });
    (
      sealed.service as unknown as {
        layoutPublications: { activeForNewDocument: typeof activeForNewDocument };
      }
    ).layoutPublications = { activeForNewDocument };

    await expect(
      sealed.service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' },
    });

    expect(activeForNewDocument).toHaveBeenCalledWith(sealed.tx);
    expect(sealed.tx.palletListDocument.create).not.toHaveBeenCalled();
    expect(sealed.tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(sealed.audit.record).not.toHaveBeenCalled();
    expect(sealed.palletPrint.print).not.toHaveBeenCalled();
  });

  it('seals a non-empty pallet and creates one immutable document before printing', async () => {
    const { service, tx, audit, palletPrint } = closeSetup();

    const result = await service.closeAndPrint(ACTOR, 'task-1', {
      printerId: 'printer-1',
      requestId: CLOSE_REQUEST_ID,
    });

    expect(tx.palletListDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'pallet-1',
        acceptanceTaskId: 'task-1',
        origin: 'physical_pallet',
        rollIds: ['ROLL-1'],
        orderIds: ['order-a'],
        generatedByRole: 'warehouse',
        format: 'label_100x150',
        fieldSetStatus: 'template_v1',
        payload: expect.objectContaining({
          palletId: 'PAL-A-100-01',
          printReady: true,
          rows: [expect.objectContaining({ rollCode: 'ROLL-1' })],
        }),
      }),
    });
    expect(tx.warehousePallet.findFirst).toHaveBeenLastCalledWith({
      where: { taskId: 'task-1', status: 'open' },
      include: expect.objectContaining({
        items: expect.objectContaining({ where: { releasedAt: null } }),
      }),
    });
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'pallet-1', status: 'open' },
      data: {
        status: 'sealed',
        closeRequestId: CLOSE_REQUEST_ID,
        sealedAt: expect.any(Date),
        sealedById: 'warehouse-user',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_pallet_sealed' }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:pallet_list_created' }),
      tx,
    );
    expect(tx.palletListDocument.create.mock.invocationCallOrder[0]).toBeLessThan(
      palletPrint.print.mock.invocationCallOrder[0],
    );
    expect(tx.warehousePallet.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      palletPrint.print.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      pallet: {
        id: 'pallet-1',
        palletCode: 'PAL-A-100-01',
        status: 'sealed',
        rollCount: 1,
      },
      document: {
        id: 'document-1',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'pallet-1',
        origin: 'physical_pallet',
        printStatus: 'submitted',
        rollCount: 1,
        orderId: 'order-a',
      },
      printJob: { id: 'print-job-1', status: 'submitted' },
    });
  });

  it('seals for browser-owned printing without discovering or calling a gateway printer', async () => {
    const { service, tx, audit, fulfillment, palletPrint } = closeSetup();

    const result = await service.sealCurrentPallet(ACTOR, 'task-1', {
      requestId: CLOSE_REQUEST_ID,
    });

    expect(tx.palletListDocument.create).toHaveBeenCalledTimes(1);
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledWith({
      where: { id: 'pallet-1', status: 'open' },
      data: {
        status: 'sealed',
        closeRequestId: CLOSE_REQUEST_ID,
        sealedAt: expect.any(Date),
        sealedById: 'warehouse-user',
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_pallet_sealed' }),
      tx,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:pallet_list_created' }),
      tx,
    );
    expect(palletPrint.print).not.toHaveBeenCalled();
    expect(fulfillment.reconcilePalletScan).toHaveBeenCalledWith(
      { userId: ACTOR.userId, role: ACTOR.role },
      'order-a',
      ['ROLL-1'],
      tx,
    );
    expect(result).toMatchObject({
      pallet: {
        id: 'pallet-1',
        palletCode: 'PAL-A-100-01',
        status: 'sealed',
        rollCount: 1,
      },
      document: {
        id: 'document-1',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'pallet-1',
        origin: 'physical_pallet',
        printStatus: 'not_printed',
        rollCount: 1,
        orderId: 'order-a',
      },
    });
  });

  it('pins the active configurable-v7 publication into the new immutable document', async () => {
    const sealed = closeSetup();
    const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    const publication = {
      id: 'publication-1',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    };
    const activeForNewDocument = jest.fn().mockResolvedValue(publication);
    (
      sealed.service as unknown as {
        layoutPublications: { activeForNewDocument: typeof activeForNewDocument };
      }
    ).layoutPublications = {
      activeForNewDocument,
    };

    await sealed.service.sealCurrentPallet(ACTOR, 'task-1', { requestId: CLOSE_REQUEST_ID });

    expect(activeForNewDocument).toHaveBeenCalledWith(sealed.tx);
    expect(sealed.tx.palletListDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        layoutPublicationId: 'publication-1',
        format: 'label_100x100',
        fieldSetStatus: 'template_square_v4',
        payload: expect.objectContaining({
          templateVersion: 'pallet-100x100-configurable-v7',
          layoutPublication: publication,
          label: expect.objectContaining({
            templateVersion: 'pallet-100x100-configurable-v7',
            rollCodes: ['ROLL-1'],
          }),
        }),
      }),
    });
  });

  it('preserves seal atomicity when the publication boundary rejects an active layout', async () => {
    const sealed = closeSetup();
    const activeForNewDocument = jest.fn().mockRejectedValue(
      new ConflictException({
        code: 'PALLET_LABEL_LAYOUT_ACTIVE_CAPACITY_REDUCED',
        message: 'Опубликуйте новый макет палетного листа с актуальной ёмкостью.',
      }),
    );
    (
      sealed.service as unknown as {
        layoutPublications: { activeForNewDocument: typeof activeForNewDocument };
      }
    ).layoutPublications = { activeForNewDocument };

    await expect(
      sealed.service.sealCurrentPallet(ACTOR, 'task-1', { requestId: CLOSE_REQUEST_ID }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PALLET_LABEL_LAYOUT_ACTIVE_CAPACITY_REDUCED' },
    });

    expect(activeForNewDocument).toHaveBeenCalledWith(sealed.tx);
    expect(sealed.tx.palletListDocument.create).not.toHaveBeenCalled();
    expect(sealed.tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(sealed.audit.record).not.toHaveBeenCalled();
    expect(sealed.palletPrint.print).not.toHaveBeenCalled();
  });

  it('keeps a V1 document stable, pins V2 for the next document and ignores later publications', async () => {
    type VersionRow = {
      id: string;
      profile: string;
      version: number;
      contentHash: string;
      definition: unknown;
      activatedAt: Date;
    };
    type VersionCreate = {
      data: Omit<VersionRow, 'id' | 'activatedAt'> & {
        sourceDocumentId: string;
        publishedById: string;
        reason: string;
      };
    };
    type CommandCreate = {
      data: {
        operationKey: string;
        requestFingerprint: string;
        profile: string;
        resultPublicationId: string;
        resultSnapshot: unknown;
      };
    };

    const versions: VersionRow[] = [];
    const commands = new Map<string, CommandCreate['data'] & { resultPublication: VersionRow }>();
    const sourceLabel = {
      templateVersion: 'pallet-100x100-extended-v6',
      palletId: 'SOURCE-PALLET-V6',
      materialMark: 'PE-LD',
      productNames: ['Пленка полиэтиленовая рукав 29мкм'],
      article: null,
      rollCount: 1,
      rollCodes: ['ROLL-1'],
      packagingMaterial: null,
      packagingCount: null,
      netKg: 40,
      grossKg: 42,
      productionDate: '08.2026',
      shelfLifeMonths: 12,
      deliveryDate: null,
      storageConditions: 'Хранить в закрытом сухом помещении.',
      orderNumbers: ['A-100'],
      customerAliases: ['Заказчик'],
      createdAt: '2026-08-11T18:00:00.000Z',
    };
    const versionStore = {
      findFirst: jest.fn(async () => versions.at(-1) ?? null),
      create: jest.fn(async ({ data }: VersionCreate) => {
        const row: VersionRow = {
          id: `publication-${versions.length + 1}`,
          profile: data.profile,
          version: data.version,
          contentHash: data.contentHash,
          definition: structuredClone(data.definition),
          activatedAt: new Date(`2026-08-11T18:3${versions.length}:00.000Z`),
        };
        versions.push(row);
        return row;
      }),
    };
    const publicationTx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      palletLabelLayoutVersion: versionStore,
      palletLabelLayoutPublishCommand: {
        findUnique: jest.fn(
          async ({ where }: { where: { operationKey: string } }) =>
            commands.get(where.operationKey) ?? null,
        ),
        create: jest.fn(async ({ data }: CommandCreate) => {
          const resultPublication = versions.find((row) => row.id === data.resultPublicationId)!;
          const stored = { ...data, resultPublication };
          commands.set(data.operationKey, stored);
          return stored;
        }),
      },
      palletListDocument: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'source-v6',
          palletId: sourceLabel.palletId,
          voidedAt: null,
          payload: { templateVersion: sourceLabel.templateVersion, label: sourceLabel },
        }),
      },
    };
    const publicationPrisma = {
      palletLabelLayoutVersion: versionStore,
      palletLabelLayoutPublishCommand: publicationTx.palletLabelLayoutPublishCommand,
      $transaction: jest.fn((work: (client: typeof publicationTx) => unknown) =>
        work(publicationTx),
      ),
    };
    const publicationService = new PalletLabelLayoutPublicationService(
      publicationPrisma as never,
      { record: jest.fn().mockResolvedValue({ id: 'publication-audit' }) } as never,
      new ConfigurablePalletLabelRenderer(),
    );
    const admin: Actor = {
      userId: 'admin-user',
      role: 'admin',
      capabilities: ['pallet_label_layout:manage'],
    };
    const layoutA = rightShiftedCompactPalletLabelLayout();
    const publicationA = {
      id: 'publication-legacy',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layoutA), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:29:00.000Z',
      layout: layoutA,
    };
    versions.push({
      id: publicationA.id,
      profile: 'pallet-100x100-configurable-v7',
      version: publicationA.version,
      contentHash: publicationA.contentHash,
      definition: layoutA,
      activatedAt: new Date(publicationA.activatedAt),
    });

    const sealWithCurrentPublication = async (
      documentId: string,
      requestId: string,
    ): Promise<PalletExportDocument> => {
      const context = closeSetup();
      context.tx.palletLabelLayoutVersion = versionStore;
      (
        context.service as unknown as {
          layoutPublications: PalletLabelLayoutPublicationService;
        }
      ).layoutPublications = publicationService;
      let captured: PalletExportDocument | null = null;
      context.tx.palletListDocument.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          captured = {
            id: documentId,
            palletId: data.palletId as string,
            payload: data.payload as PalletExportDocument['payload'],
            layoutPublicationId: (data.layoutPublicationId as string | undefined) ?? null,
          };
          return {
            ...data,
            id: documentId,
            createdAt: DOCUMENT_CREATED_AT,
            voidedAt: null,
            printJobs: [],
            warehousePallet: { orderId: 'order-a' },
          };
        },
      );

      await context.service.sealCurrentPallet(ACTOR, 'task-1', { requestId });
      if (!captured) throw new Error('seal did not persist a pallet-list document');
      return captured;
    };

    const documentA = await sealWithCurrentPublication(
      'document-a',
      '123e4567-e89b-42d3-a456-426614174020',
    );
    const token = `plt_${'a'.repeat(64)}`;
    const labelRenderer = new PalletLabelRenderer();
    const exporter = new PalletExportService(labelRenderer, {
      requireForDocument: jest.fn(async (documentId: string) => ({ documentId, token })),
    } as never);
    const svgOf = (document: PalletExportDocument): string =>
      labelRenderer.renderPalletLabelSvg(
        document.payload!.label,
        token,
        document.payload!.templateVersion,
        document.payload!.layoutPublication,
      );
    const pngABefore = (await exporter.preview(documentA)).buffer;
    const svgABefore = svgOf(documentA);

    const layoutB = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    layoutB.elements.find((element) => element.id === 'order')!.xDots = 44;
    const publishedB = await publicationService.publish(admin, {
      operationKey: '123e4567-e89b-42d3-a456-426614174011',
      expectedActivePublicationId: publicationA.id,
      sourceDocumentId: 'source-v6',
      reason: 'Публикация B для регрессии закрепления',
      layout: layoutB,
    });

    const pngAAfter = (await exporter.preview(documentA)).buffer;
    const svgAAfter = svgOf(documentA);
    const documentB = await sealWithCurrentPublication(
      'document-b',
      '123e4567-e89b-42d3-a456-426614174021',
    );
    const pngB = (await exporter.preview(documentB)).buffer;
    const svgB = svgOf(documentB);

    const layoutC = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    layoutC.elements.find((element) => element.id === 'order')!.xDots = 48;
    const publishedC = await publicationService.publish(admin, {
      operationKey: '123e4567-e89b-42d3-a456-426614174012',
      expectedActivePublicationId: publishedB.publication.id,
      sourceDocumentId: 'source-v6',
      reason: 'Публикация C для проверки закрепления B',
      layout: layoutC,
    });
    const pngBAfterC = (await exporter.preview(documentB)).buffer;
    const svgBAfterC = svgOf(documentB);

    expect(documentA.layoutPublicationId).toBe(publicationA.id);
    expect(documentA.payload?.layoutPublication).toEqual(publicationA);
    expect(pngAAfter).toEqual(pngABefore);
    expect(svgAAfter).toBe(svgABefore);
    expect(documentB.layoutPublicationId).toBe(publishedB.publication.id);
    expect(documentB.payload?.layoutPublication).toEqual(publishedB.publication);
    expect(pngB).not.toEqual(pngABefore);
    expect(svgB).not.toBe(svgABefore);
    expect(pngBAfterC).toEqual(pngB);
    expect(svgBAfterC).toBe(svgB);
    expect(documentB.payload?.layoutPublication).not.toEqual(publishedC.publication);
    expect(svgB).toContain('Рулонов на палете: 1');
    expect(svgB).not.toContain('ROLL-1');
  });

  it('replays the same browser-print document for the same seal request id', async () => {
    const { service, tx, document, palletPrint } = closeSetup();
    const sealed = {
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      taskId: 'task-1',
      orderId: 'order-a',
      sequenceNo: 1,
      status: 'sealed',
      openedAt: OPENED_AT,
      sealedAt: DOCUMENT_CREATED_AT,
      order: { id: 'order-a', orderNumber: 'A-100' },
      items: [
        {
          rollCode: 'ROLL-1',
          position: 1,
          acceptedAt: ACCEPTED_AT,
          scanRow: CLOSE_ITEM.scanRow,
        },
      ],
      document,
    };
    tx.warehousePallet.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...sealed,
        status: 'open',
        sealedAt: null,
        document: null,
      })
      .mockResolvedValueOnce(sealed);

    const dto = { requestId: CLOSE_REQUEST_ID };
    const first = await service.sealCurrentPallet(ACTOR, 'task-1', dto);
    const replay = await service.sealCurrentPallet(ACTOR, 'task-1', dto);

    expect(replay).toEqual(first);
    expect(tx.palletListDocument.create).toHaveBeenCalledTimes(1);
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledTimes(1);
    expect(palletPrint.print).not.toHaveBeenCalled();
  });

  it('returns and prints the same immutable document for the same close request id', async () => {
    const { service, tx, document, palletPrint } = closeSetup();
    const sealed = {
      id: 'pallet-1',
      palletCode: 'PAL-A-100-01',
      taskId: 'task-1',
      orderId: 'order-a',
      sequenceNo: 1,
      status: 'sealed',
      openedAt: OPENED_AT,
      sealedAt: DOCUMENT_CREATED_AT,
      order: { id: 'order-a', orderNumber: 'A-100' },
      items: [
        {
          rollCode: 'ROLL-1',
          position: 1,
          acceptedAt: ACCEPTED_AT,
          scanRow: CLOSE_ITEM.scanRow,
        },
      ],
      document,
    };
    tx.warehousePallet.findFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        ...sealed,
        status: 'open',
        sealedAt: null,
        document: null,
      })
      .mockResolvedValueOnce(sealed);

    const dto = { printerId: 'printer-1', requestId: CLOSE_REQUEST_ID };
    const first = await service.closeAndPrint(ACTOR, 'task-1', dto);
    const replay = await service.closeAndPrint(ACTOR, 'task-1', dto);

    expect(replay.document.id).toBe(first.document.id);
    expect(tx.palletListDocument.create).toHaveBeenCalledTimes(1);
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledTimes(1);
    expect(palletPrint.print).toHaveBeenCalledTimes(2);
    expect(palletPrint.print).toHaveBeenLastCalledWith(ACTOR, 'document-1', dto);
  });

  it('rejects an empty or already sealed current pallet', async () => {
    const empty = closeSetup({ items: [] });
    await expect(
      empty.service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_PALLET_EMPTY' }),
    });
    expect(empty.tx.palletListDocument.create).not.toHaveBeenCalled();

    const sealed = closeSetup();
    sealed.tx.warehousePallet.findFirst.mockReset().mockResolvedValue(null);
    await expect(
      sealed.service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_OPEN_PALLET_NOT_FOUND' }),
    });
    expect(sealed.tx.palletListDocument.create).not.toHaveBeenCalled();
  });

  it('rejects a stale active composition when a selected row is no longer accepted', async () => {
    const stale = closeSetup({
      items: [
        {
          ...CLOSE_ITEM,
          scanRow: { ...CLOSE_ITEM.scanRow, scanStatus: 'damaged' },
        },
      ],
    });

    await expect(
      stale.service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_PALLET_COMPOSITION_INVALID',
        palletId: 'pallet-1',
      }),
    });

    expect(stale.tx.palletListDocument.create).not.toHaveBeenCalled();
    expect(stale.tx.warehousePallet.updateMany).not.toHaveBeenCalled();
    expect(stale.palletPrint.print).not.toHaveBeenCalled();
    const compositionLock = stale.tx.$queryRaw.mock.calls.find(([query]: [string[]]) =>
      query.join('').includes('warehouse_pallet_items'),
    );
    expect(compositionLock?.[0].join('')).toContain('FOR UPDATE OF item, scan');
    expect(stale.tx.$queryRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      stale.tx.warehousePallet.findUnique.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [
      'failed',
      new ServiceUnavailableException({
        code: 'PALLET_PRINT_FAILED',
        message: 'printer rejected',
        printJobId: 'print-job-1',
      }),
    ],
    [
      'delivery unknown',
      new ConflictException({
        code: 'PALLET_PRINT_DELIVERY_UNKNOWN',
        message: 'check printer',
        printJobId: 'print-job-1',
      }),
    ],
  ])('keeps the pallet sealed when printing is %s', async (_label, printError) => {
    const { service, tx } = closeSetup({ printError });

    await expect(
      service.closeAndPrint(ACTOR, 'task-1', {
        printerId: 'printer-1',
        requestId: CLOSE_REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: expect.stringMatching(/^PALLET_PRINT_/),
        documentId: 'document-1',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'pallet-1',
      }),
    });

    expect(tx.warehousePallet.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.warehousePallet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sealed' }),
      }),
    );
    expect(tx.warehousePallet.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'open' }),
      }),
    );
  });

  it('projects the current pallet and bounded newest-first document history', async () => {
    const { service, prisma, pallet } = closeSetup();
    prisma.warehousePallet.findMany = jest.fn().mockResolvedValue([
      {
        ...pallet,
        items: [
          ...pallet.items,
          {
            ...pallet.items[0],
            id: 'item-2',
            rollCode: 'ROLL-2',
            position: 2,
            scanRow: { ...pallet.items[0].scanRow, id: 'row-2', rollCode: 'ROLL-2' },
          },
        ],
      },
    ]);
    prisma.palletListDocument.findMany = jest.fn().mockResolvedValue([
      {
        id: 'document-1',
        palletId: 'PAL-A-100-00',
        warehousePalletId: 'sealed-pallet-1',
        origin: 'physical_pallet',
        rollIds: ['ROLL-OLD-1'],
        orderIds: ['order-a'],
        createdAt: DOCUMENT_CREATED_AT,
        voidedAt: new Date('2026-08-07T06:03:00.000Z'),
        payload: {
          templateVersion: 'pallet-100x150-compact-v2',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-compact-v2' },
        },
        warehousePallet: { orderId: 'order-a' },
        printJobs: [{ status: 'submitted' }],
      },
    ]);

    const projection = await service.projectForTasks(['task-1']);

    expect(projection.get('task-1')).toMatchObject({
      activePallet: {
        palletCode: 'PAL-A-100-01',
        rollCount: 2,
        rows: [
          { rollCode: 'ROLL-1', position: 1 },
          { rollCode: 'ROLL-2', position: 2 },
        ],
      },
      history: [
        {
          id: 'document-1',
          palletId: 'PAL-A-100-00',
          rollCount: 1,
          orderId: 'order-a',
          templateVersion: 'pallet-100x150-compact-v2',
          printStatus: 'submitted',
        },
      ],
      hasMore: false,
    });
    expect(prisma.palletListDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { acceptanceTaskId: 'task-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
  });

  it('projects bounded immutable roll codes for physical and legacy pallet documents', async () => {
    const { service, prisma } = closeSetup();
    const rawSentinel = 'DOCUMENT-PAYLOAD-MUST-NOT-LEAK';
    const rollIds = Array.from({ length: 101 }, (_, index) => `ROLL-${index + 1}`);
    prisma.warehousePallet.findMany = jest.fn().mockResolvedValue([]);
    prisma.palletListDocument.findMany = jest.fn().mockResolvedValue([
      {
        id: 'physical-document',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'pallet-1',
        origin: 'physical_pallet',
        rollIds,
        orderIds: ['order-a'],
        createdAt: DOCUMENT_CREATED_AT,
        voidedAt: new Date('2026-08-07T06:03:00.000Z'),
        payload: {
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-v1' },
          rawPayload: rawSentinel,
          qrToken: 'secret-token',
        },
        warehousePallet: { orderId: 'order-a' },
        printJobs: [],
      },
      {
        id: 'legacy-document',
        palletId: 'PAL-LEGACY-01',
        warehousePalletId: null,
        origin: 'legacy',
        rollIds: ['LEGACY-ROLL'],
        orderIds: ['order-a'],
        createdAt: new Date('2026-07-30T12:01:00.000Z'),
        payload: {
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-v1' },
          rawPayload: rawSentinel,
          qrToken: 'secret-token',
        },
        warehousePallet: null,
        printJobs: [],
      },
    ]);

    const projection = await service.projectForTasks(['task-1']);
    const history = projection.get('task-1')?.history ?? [];

    expect(history).toEqual([
      expect.objectContaining({
        id: 'physical-document',
        documentStatus: 'voided',
        rollCount: 101,
        rollCodes: rollIds.slice(0, 100),
        rollCodesHasMore: true,
      }),
      expect.objectContaining({
        id: 'legacy-document',
        origin: 'legacy',
        documentStatus: 'sealed',
        rollCodes: ['LEGACY-ROLL'],
        rollCodesHasMore: false,
      }),
    ]);
    expect(JSON.stringify(history)).not.toContain(rawSentinel);
    expect(JSON.stringify(history)).not.toContain('secret-token');
  });

  it('derives current selection only from unreleased open or sealed memberships', async () => {
    const { service, prisma } = closeSetup();
    prisma.warehousePallet.findMany = jest.fn().mockResolvedValue([]);
    prisma.palletListDocument.findMany = jest.fn().mockResolvedValue([]);
    prisma.warehousePalletItem.findMany.mockResolvedValue([
      {
        scanRowId: 'open-row',
        releasedAt: null,
        pallet: { id: 'open-pallet', taskId: 'task-1', palletCode: 'PAL-OPEN', status: 'open' },
      },
      {
        scanRowId: 'sealed-row',
        releasedAt: null,
        pallet: {
          id: 'sealed-pallet',
          taskId: 'task-1',
          palletCode: 'PAL-SEALED',
          status: 'sealed',
        },
      },
      {
        scanRowId: 'released-row',
        releasedAt: new Date('2026-08-07T12:00:00.000Z'),
        pallet: {
          id: 'released-pallet',
          taskId: 'task-1',
          palletCode: 'PAL-RELEASED',
          status: 'voided',
        },
      },
      {
        scanRowId: 'voided-row',
        releasedAt: null,
        pallet: {
          id: 'voided-pallet',
          taskId: 'task-1',
          palletCode: 'PAL-VOIDED',
          status: 'voided',
        },
      },
    ]);

    const selection = (await service.projectForTasks(['task-1'])).get(
      'task-1',
    )?.selectionsByScanRowId;

    expect(selection?.get('open-row')).toEqual({
      selected: true,
      locked: false,
      palletId: 'open-pallet',
      palletCode: 'PAL-OPEN',
    });
    expect(selection?.get('sealed-row')).toEqual({
      selected: true,
      locked: true,
      palletId: 'sealed-pallet',
      palletCode: 'PAL-SEALED',
    });
    expect(selection?.get('released-row')).toBeUndefined();
    expect(selection?.get('voided-row')).toBeUndefined();
    expect(prisma.warehousePalletItem.findMany).toHaveBeenCalledWith({
      where: {
        releasedAt: null,
        pallet: { taskId: { in: ['task-1'] }, status: { in: ['open', 'sealed'] } },
      },
      select: expect.objectContaining({ releasedAt: true, pallet: expect.any(Object) }),
    });
  });

  it('fails closed when history contains mismatched immutable profile versions', async () => {
    const { service, prisma } = closeSetup();
    prisma.warehousePallet.findMany = jest.fn().mockResolvedValue([]);
    prisma.palletListDocument.findMany = jest.fn().mockResolvedValue([
      {
        id: 'document-corrupt',
        palletId: 'PAL-A-100-00',
        warehousePalletId: 'sealed-pallet-1',
        origin: 'physical_pallet',
        rollIds: ['ROLL-OLD-1'],
        orderIds: ['order-a'],
        createdAt: DOCUMENT_CREATED_AT,
        payload: {
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-compact-v2' },
        },
        warehousePallet: { orderId: 'order-a' },
        printJobs: [],
      },
    ]);

    await expect(service.projectForTasks(['task-1'])).rejects.toBeInstanceOf(ConflictException);
  });

  it('paginates immutable pallet history with an opaque cursor', async () => {
    const { service, prisma, pallet } = closeSetup();
    prisma.warehouseAcceptanceTask.findUnique.mockResolvedValue({ id: 'task-1' });
    prisma.warehousePallet.findFirst.mockReset().mockResolvedValue({ ...pallet, document: null });
    prisma.palletListDocument.findMany = jest.fn().mockResolvedValue([
      {
        id: 'document-2',
        palletId: 'PAL-A-100-02',
        warehousePalletId: 'sealed-pallet-2',
        origin: 'physical_pallet',
        rollIds: ['ROLL-2'],
        orderIds: ['order-a'],
        createdAt: new Date('2026-07-31T12:02:00.000Z'),
        payload: {
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-v1' },
        },
        warehousePallet: { orderId: 'order-a' },
        printJobs: [{ status: 'submitted' }],
      },
      {
        id: 'document-1',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'sealed-pallet-1',
        origin: 'physical_pallet',
        rollIds: ['ROLL-1'],
        orderIds: ['order-a'],
        createdAt: DOCUMENT_CREATED_AT,
        payload: {
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
          label: { templateVersion: 'pallet-100x150-v1' },
        },
        warehousePallet: { orderId: 'order-a' },
        printJobs: [{ status: 'submitted' }],
      },
    ]);

    const page = await service.listTaskPallets('task-1', { limit: 1 });

    expect(page).toMatchObject({
      activePallet: { palletCode: 'PAL-A-100-01' },
      items: [{ id: 'document-2', palletId: 'PAL-A-100-02' }],
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(prisma.palletListDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { acceptanceTaskId: 'task-1' },
        take: 2,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
});
