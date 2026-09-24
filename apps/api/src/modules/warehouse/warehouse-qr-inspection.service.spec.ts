import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PlatformQrRecognitionService } from '../../common/platform-qr/platform-qr-recognition.service';
import { WarehouseQrInspectionService } from './warehouse-qr-inspection.service';

const ROLL_TOKEN = `prt_${'a'.repeat(64)}`;
const BIG_BAG_TOKEN = `bbt_${'b'.repeat(64)}`;
const PALLET_TOKEN = `plt_${'c'.repeat(64)}`;

function harness() {
  const prisma = {
    rollScanToken: { findUnique: jest.fn() },
    warehouseRoll: { findUnique: jest.fn() },
    operatorRollLine: { findFirst: jest.fn() },
    bigBagScanToken: { findUnique: jest.fn() },
    bigBagUnit: { findUnique: jest.fn() },
    palletScanToken: { findUnique: jest.fn() },
    palletListDocument: { findUnique: jest.fn() },
  };
  const qrRecognition = new PlatformQrRecognitionService(prisma as never);
  return {
    prisma,
    service: new WarehouseQrInspectionService(prisma as never, qrRecognition),
  };
}

type HarnessPrisma = ReturnType<typeof harness>['prisma'];

function mockRoll(prisma: HarnessPrisma, roll: Record<string, unknown> & { rollCode: string }) {
  prisma.rollScanToken.findUnique.mockResolvedValue({
    roll: { id: 'roll-1', rollCode: roll.rollCode },
  });
  prisma.warehouseRoll.findUnique.mockResolvedValue({ id: 'roll-1', ...roll });
}

function mockBigBag(
  prisma: HarnessPrisma,
  bigBag: Record<string, unknown> & { code: string; id: string; material: string },
) {
  prisma.bigBagScanToken.findUnique.mockResolvedValue({
    bigBag: { id: bigBag.id, code: bigBag.code, material: bigBag.material },
  });
  prisma.bigBagUnit.findUnique.mockResolvedValue(bigBag);
}

function mockPallet(
  prisma: HarnessPrisma,
  document: Record<string, unknown> & { palletId: string },
) {
  prisma.palletScanToken.findUnique.mockResolvedValue({
    document: { id: 'document-1', palletId: document.palletId },
  });
  prisma.palletListDocument.findUnique.mockResolvedValue({ id: 'document-1', ...document });
}

describe('WarehouseQrInspectionService', () => {
  it('resolves a roll into current safe business facts without returning the opaque token', async () => {
    const { prisma, service } = harness();
    mockRoll(prisma, {
      rollCode: 'ROLL-0001',
      positionSnapshot: {
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        widthMm: 400,
        plannedLengthM: 1_500,
        spoolType: 'Тонкая',
        birka: 'ГОСТ',
        forbiddenRawPayload: 'must-not-leak',
      },
      warehouseStatus: 'received',
      receivedAt: new Date('2026-08-06T05:00:00.000Z'),
      producedForOrder: null,
      producedForStockOrder: null,
      producedForPosition: null,
    });
    prisma.operatorRollLine.findFirst.mockResolvedValue({
      sequence: 1,
      planKg: 40,
      spoolKg: 0.7,
      grossKg: 40.8,
      netKg: 40.1,
      toleranceOk: true,
      rollDispatchItem: {
        positionSequence: 1,
        filmType: 'Рукав',
        widthMm: 400,
        plannedLengthM: 1_500,
        characteristicsSnapshot: { privateRecipe: 'must-not-leak' },
        status: 'completed',
        completedAt: new Date('2026-08-06T04:30:00.000Z'),
        productionOrder: {
          commercialOrder: {
            id: 'order-1',
            orderNumber: 'ЗК-0001',
            createdAt: new Date('2026-08-05T09:00:00.000Z'),
            readyForShipmentAt: new Date('2026-08-06T04:45:00.000Z'),
            shipmentCompletedAt: null,
            counterparty: { displayName: 'УралПак' },
          },
        },
      },
    });

    const result = await service.inspect(ROLL_TOKEN);

    expect(result).toEqual({
      kind: 'roll',
      inspectedAt: expect.any(String),
      roll: {
        rollCode: 'ROLL-0001',
        orderId: 'order-1',
        orderNumber: 'ЗК-0001',
        customerAlias: 'УралПак',
        requestCreatedAt: '2026-08-05T09:00:00.000Z',
        readyForShipmentAt: '2026-08-06T04:45:00.000Z',
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
        receivedAt: '2026-08-06T05:00:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toContain(ROLL_TOKEN);
    expect(JSON.stringify(result)).not.toContain('privateRecipe');
    expect(JSON.stringify(result)).not.toContain('forbiddenRawPayload');
  });

  it('resolves a Big-Bag and recalculates its current value from the shared current weight', async () => {
    const { prisma, service } = harness();
    mockBigBag(prisma, {
      id: 'bag-1',
      code: 'BB-ПВД-01',
      material: 'ПВД первичный',
      status: 'available',
      registrationStatus: 'registered',
      location: 'warehouse',
      initialKg: 500,
      currentKg: 425.125,
      lastMeasuredKg: 430,
      lastMeasuredAt: new Date('2026-08-06T03:00:00.000Z'),
      priceKopecksPerKg: 2_500,
      priceEffectiveAt: new Date('2026-08-05T07:00:00.000Z'),
      createdAt: new Date('2026-08-05T07:00:00.000Z'),
    });

    const result = await service.inspect(BIG_BAG_TOKEN);

    expect(result).toEqual({
      kind: 'big_bag',
      inspectedAt: expect.any(String),
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
    });
    expect(JSON.stringify(result)).not.toContain(BIG_BAG_TOKEN);
  });

  it('resolves a pallet into whitelisted immutable label facts and optional physical state', async () => {
    const { prisma, service } = harness();
    mockPallet(prisma, {
      palletId: 'legacy-document-code',
      payload: {
        label: {
          palletId: 'PAL-0007',
          materialMark: 'ПВД',
          productNames: ['Плёнка ПВД 80 мкм', 'Плёнка ПВД 120 мкм'],
          article: 'ПВД-80/120',
          rollCount: 12,
          packagingMaterial: 'Стрейч-плёнка',
          packagingCount: 1,
          netKg: 486.3,
          grossKg: 501.2,
          productionDate: '06.2026–07.2026',
          shelfLifeMonths: 12,
          deliveryDate: '30.07.2026',
          storageConditions: 'Хранить в сухом помещении.',
          orderNumbers: ['A-100', 'B-200'],
          customerAliases: ['Альфа', 'Бета'],
          rawPayload: 'must-not-leak',
          adminSecret: 'must-not-leak',
        },
        rows: [{ rollCode: 'ROLL-SECRET', privateRecipe: 'must-not-leak' }],
        rawPayload: { serial: 'must-not-leak' },
      },
      createdAt: new Date('2026-08-06T05:00:00.000Z'),
      warehousePallet: {
        palletCode: 'PAL-0007',
        status: 'sealed',
        sealedAt: new Date('2026-08-06T04:55:00.000Z'),
        adminSecret: 'must-not-leak',
      },
    });

    const result = await service.inspect(PALLET_TOKEN);

    expect(result).toEqual({
      kind: 'pallet',
      inspectedAt: expect.any(String),
      pallet: {
        palletCode: 'PAL-0007',
        status: 'sealed',
        documentStatus: 'sealed',
        materialMark: 'ПВД',
        productNames: ['Плёнка ПВД 80 мкм', 'Плёнка ПВД 120 мкм'],
        article: 'ПВД-80/120',
        rollCount: 12,
        packagingMaterial: 'Стрейч-плёнка',
        packagingCount: 1,
        netKg: 486.3,
        grossKg: 501.2,
        productionDate: '06.2026–07.2026',
        shelfLifeMonths: 12,
        deliveryDate: '30.07.2026',
        storageConditions: 'Хранить в сухом помещении.',
        orderNumbers: ['A-100', 'B-200'],
        customerAliases: ['Альфа', 'Бета'],
        rollCodes: ['ROLL-SECRET'],
        createdAt: '2026-08-06T05:00:00.000Z',
        sealedAt: '2026-08-06T04:55:00.000Z',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/plt_|rawPayload|adminSecret|"rows"|privateRecipe/);
    const query = prisma.palletScanToken.findUnique.mock.calls[0][0];
    expect(query.where).toEqual({ token: PALLET_TOKEN });
    expect(JSON.stringify(query.select)).not.toMatch(/token|orderIds|generatedByRole|rawPayload/);
  });

  it('returns immutable document facts for a legacy pallet without a physical relation', async () => {
    const { prisma, service } = harness();
    mockPallet(prisma, {
      palletId: 'LEGACY-01',
      payload: {
        label: {
          palletId: 'LEGACY-01',
          materialMark: 'ПВД',
          productNames: ['Плёнка ПВД'],
          article: null,
          rollCount: 1,
          packagingMaterial: null,
          packagingCount: null,
          netKg: 40.1,
          grossKg: null,
          productionDate: '08.2026',
          shelfLifeMonths: 12,
          deliveryDate: null,
          storageConditions: 'Хранить в сухом помещении.',
          orderNumbers: ['ЗК-1'],
          customerAliases: ['Клиент'],
        },
      },
      createdAt: new Date('2026-08-06T06:00:00.000Z'),
      warehousePallet: null,
    });

    await expect(service.inspect(PALLET_TOKEN)).resolves.toEqual({
      kind: 'pallet',
      inspectedAt: expect.any(String),
      pallet: {
        palletCode: 'LEGACY-01',
        status: null,
        documentStatus: 'sealed',
        materialMark: 'ПВД',
        productNames: ['Плёнка ПВД'],
        article: null,
        rollCount: 1,
        packagingMaterial: null,
        packagingCount: null,
        netKg: 40.1,
        grossKg: null,
        productionDate: '08.2026',
        shelfLifeMonths: 12,
        deliveryDate: null,
        storageConditions: 'Хранить в сухом помещении.',
        orderNumbers: ['ЗК-1'],
        customerAliases: ['Клиент'],
        rollCodes: [],
        createdAt: '2026-08-06T06:00:00.000Z',
        sealedAt: null,
      },
    });
  });

  it('keeps an annulled pallet QR traceable while exposing its voided document status', async () => {
    const { prisma, service } = harness();
    mockPallet(prisma, {
      palletId: 'PAL-VOID-01',
      payload: {
        label: {
          palletId: 'PAL-VOID-01',
          materialMark: 'ПВД',
          productNames: ['Плёнка ПВД'],
          rollCount: 1,
          netKg: 40.1,
        },
      },
      createdAt: new Date('2026-08-07T06:02:00.000Z'),
      voidedAt: new Date('2026-08-07T06:03:00.000Z'),
      warehousePallet: {
        palletCode: 'PAL-VOID-01',
        status: 'voided',
        sealedAt: new Date('2026-08-07T06:01:00.000Z'),
      },
    });

    await expect(service.inspect(PALLET_TOKEN)).resolves.toEqual({
      kind: 'pallet',
      inspectedAt: expect.any(String),
      pallet: expect.objectContaining({
        palletCode: 'PAL-VOID-01',
        status: 'voided',
        documentStatus: 'voided',
        materialMark: 'ПВД',
        productNames: ['Плёнка ПВД'],
        rollCount: 1,
        rollCodes: [],
        netKg: 40.1,
      }),
    });
    const query = prisma.palletScanToken.findUnique.mock.calls[0][0];
    expect(JSON.stringify(query.select)).not.toMatch(/voidedById|voidReasonCode|voidNote|token/u);
  });

  it.each([
    'pallet-100x100-square-v4',
    'pallet-100x100-safe-v5',
    'pallet-100x100-extended-v6',
  ] as const)(
    'returns the exact ordered %s roll composition without exposing row internals',
    async (profile) => {
      const { prisma, service } = harness();
      mockPallet(prisma, {
        palletId: 'PAL-V3-01',
        rollIds: ['ROLL-2', 'ROLL-1'],
        payload: {
          templateVersion: profile,
          label: {
            templateVersion: profile,
            palletId: 'PAL-V3-01',
            materialMark: 'ПВД',
            productNames: ['Плёнка ПВД'],
            article: null,
            rollCount: 2,
            netKg: 80.2,
            grossKg: 84.2,
            rollCodes: ['ROLL-2', 'ROLL-1'],
            packagingMaterial: null,
            packagingCount: null,
            productionDate: '08.2026',
            shelfLifeMonths: 12,
            deliveryDate: null,
            storageConditions: 'Хранение в закрытом сухом помещении при температуре 5–35 °C.',
            orderNumbers: ['A-2'],
            customerAliases: ['Заказчик'],
            createdAt: '2026-08-08T06:00:00.000Z',
          },
          rows: [
            { seq: 1, rollCode: 'ROLL-2', privateRecipe: 'must-not-leak' },
            { seq: 2, rollCode: 'ROLL-1', rawPayload: 'must-not-leak' },
          ],
        },
        createdAt: new Date('2026-08-08T06:00:00.000Z'),
        voidedAt: null,
        warehousePallet: null,
      });

      const result = await service.inspect(PALLET_TOKEN);

      expect(result).toEqual(
        expect.objectContaining({
          kind: 'pallet',
          pallet: expect.objectContaining({ rollCodes: ['ROLL-2', 'ROLL-1'] }),
        }),
      );
      expect(JSON.stringify(result)).not.toMatch(/privateRecipe|rawPayload|"rows"/u);
    },
  );

  it('rejects a square-v4 QR snapshot whose label and ordered rows disagree', async () => {
    const { prisma, service } = harness();
    mockPallet(prisma, {
      palletId: 'PAL-V3-BROKEN',
      rollIds: ['ROLL-2', 'ROLL-1'],
      payload: {
        templateVersion: 'pallet-100x100-square-v4',
        label: {
          templateVersion: 'pallet-100x100-square-v4',
          palletId: 'PAL-V3-BROKEN',
          materialMark: 'ПВД',
          productNames: ['Плёнка ПВД'],
          article: null,
          rollCount: 2,
          netKg: 80.2,
          grossKg: 84.2,
          rollCodes: ['ROLL-1', 'ROLL-2'],
          packagingMaterial: null,
          packagingCount: null,
          productionDate: '08.2026',
          shelfLifeMonths: 12,
          deliveryDate: null,
          storageConditions: 'Хранение в закрытом сухом помещении при температуре 5–35 °C.',
          orderNumbers: ['A-2'],
          customerAliases: ['Заказчик'],
          createdAt: '2026-08-08T06:00:00.000Z',
        },
        rows: [
          { seq: 1, rollCode: 'ROLL-2' },
          { seq: 2, rollCode: 'ROLL-1' },
        ],
      },
      createdAt: new Date('2026-08-08T06:00:00.000Z'),
      voidedAt: null,
      warehousePallet: null,
    });

    await expect(service.inspect(PALLET_TOKEN)).rejects.toMatchObject(
      new NotFoundException({
        code: 'WAREHOUSE_QR_NOT_FOUND',
        message: 'QR-код не найден.',
      }),
    );
  });

  it('returns one stable not-found error for an unknown valid token', async () => {
    const { prisma, service } = harness();
    prisma.rollScanToken.findUnique.mockResolvedValue(null);

    await expect(service.inspect(ROLL_TOKEN)).rejects.toMatchObject(
      new NotFoundException({
        code: 'WAREHOUSE_QR_NOT_FOUND',
        message: 'QR-код не найден.',
      }),
    );
  });

  it('rejects values outside the three physical QR formats before querying storage', async () => {
    const { prisma, service } = harness();

    await expect(service.inspect('ROLL-0001')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.rollScanToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.bigBagScanToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.palletScanToken.findUnique).not.toHaveBeenCalled();
  });
});
