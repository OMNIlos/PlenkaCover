import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  WarehouseQrBigBagView,
  WarehouseQrInspection,
  WarehouseQrPalletView,
  WarehouseQrRollView,
} from '@plenka/contracts';
import { valueBigBag } from '../../common/money/big-bag-valuation';
import { PlatformQrRecognitionService } from '../../common/platform-qr/platform-qr-recognition.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  hasExactPalletDocumentComposition,
  isBrowserOnlyPalletLabelProfile,
  isPalletLabelProfile,
} from './pallet-label-snapshot';

const toIso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function textFrom(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === 'string' && item.trim().length > 0 ? [item.trim()] : [],
  );
}

function exactRowRollCodes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const rollCodes: string[] = [];
  for (const item of value) {
    const rollCode = textFrom(record(item).rollCode);
    if (!rollCode) return null;
    rollCodes.push(rollCode);
  }
  return rollCodes;
}

const orderSelect = {
  id: true,
  orderNumber: true,
  createdAt: true,
  readyForShipmentAt: true,
  shipmentCompletedAt: true,
  counterparty: { select: { displayName: true } },
} as const;

@Injectable()
export class WarehouseQrInspectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qrRecognition: PlatformQrRecognitionService,
  ) {}

  async inspect(payload: string): Promise<WarehouseQrInspection> {
    const resolution = await this.qrRecognition.resolve(payload);
    if (resolution.outcome === 'invalid') {
      throw new BadRequestException({
        code: 'WAREHOUSE_QR_FORMAT_INVALID',
        message: 'Отсканируйте QR-код рулона, Big-Bag или палеты.',
      });
    }
    if (resolution.outcome === 'not_found') throw this.notFound();

    const object = resolution.object;
    if (object.kind === 'roll') return this.inspectRoll(object.objectId);
    if (object.kind === 'big_bag') return this.inspectBigBag(object.objectId);
    return this.inspectPallet(object.objectId);
  }

  private async inspectRoll(objectId: string): Promise<WarehouseQrInspection> {
    const roll = await this.prisma.warehouseRoll.findUnique({
      where: { id: objectId },
      select: {
        rollCode: true,
        positionSnapshot: true,
        warehouseStatus: true,
        receivedAt: true,
        producedForOrder: { select: orderSelect },
        producedForStockOrder: { select: orderSelect },
        producedForPosition: {
          select: {
            filmType: true,
            actualThickness: true,
            accountingThickness: true,
            widthMm: true,
            plannedLengthM: true,
            spoolType: true,
            birka: true,
          },
        },
      },
    });
    if (!roll) throw this.notFound();

    const line = await this.prisma.operatorRollLine.findFirst({
      where: { rollDispatchItem: { rollCode: roll.rollCode } },
      select: {
        sequence: true,
        planKg: true,
        spoolKg: true,
        grossKg: true,
        netKg: true,
        toleranceOk: true,
        rollDispatchItem: {
          select: {
            positionSequence: true,
            filmType: true,
            widthMm: true,
            plannedLengthM: true,
            characteristicsSnapshot: true,
            status: true,
            completedAt: true,
            productionOrder: {
              select: {
                commercialOrder: { select: orderSelect },
              },
            },
          },
        },
      },
    });

    const position = roll.producedForPosition;
    const lineSnapshot = record(line?.rollDispatchItem.characteristicsSnapshot);
    const rollSnapshot = record(roll.positionSnapshot);
    const order =
      line?.rollDispatchItem.productionOrder.commercialOrder ??
      roll.producedForOrder ??
      roll.producedForStockOrder;
    const view: WarehouseQrRollView = {
      rollCode: roll.rollCode,
      orderId: order?.id ?? null,
      orderNumber: order?.orderNumber ?? null,
      customerAlias: order?.counterparty?.displayName ?? null,
      requestCreatedAt: toIso(order?.createdAt),
      readyForShipmentAt: toIso(order?.readyForShipmentAt),
      shipmentCompletedAt: toIso(order?.shipmentCompletedAt),
      sequence: line?.sequence ?? line?.rollDispatchItem.positionSequence ?? null,
      plannedKg: line?.planKg ?? null,
      spoolKg: line?.spoolKg ?? null,
      grossKg: line?.grossKg ?? null,
      netKg: line?.netKg ?? null,
      toleranceOk: line?.toleranceOk ?? null,
      filmType:
        textFrom(
          line?.rollDispatchItem.filmType,
          position?.filmType,
          lineSnapshot.filmType,
          rollSnapshot.filmType,
        ) ?? null,
      actualThickness: textFrom(
        position?.actualThickness,
        lineSnapshot.actualThickness,
        rollSnapshot.actualThickness,
      ),
      accountingThickness: textFrom(
        position?.accountingThickness,
        lineSnapshot.accountingThickness,
        rollSnapshot.accountingThickness,
      ),
      widthMm: numberFrom(
        line?.rollDispatchItem.widthMm,
        position?.widthMm,
        lineSnapshot.widthMm,
        rollSnapshot.widthMm,
      ),
      plannedLengthM: numberFrom(
        line?.rollDispatchItem.plannedLengthM,
        position?.plannedLengthM,
        lineSnapshot.plannedLengthM,
        rollSnapshot.plannedLengthM,
      ),
      spoolType: textFrom(position?.spoolType, lineSnapshot.spoolType, rollSnapshot.spoolType),
      birka: textFrom(position?.birka, lineSnapshot.birka, rollSnapshot.birka),
      productionStatus: line?.rollDispatchItem.status ?? 'not_linked',
      warehouseStatus: roll.warehouseStatus,
      producedAt: toIso(line?.rollDispatchItem.completedAt),
      receivedAt: toIso(roll.receivedAt),
    };

    return { kind: 'roll', roll: view, inspectedAt: new Date().toISOString() };
  }

  private async inspectBigBag(objectId: string): Promise<WarehouseQrInspection> {
    const bag = await this.prisma.bigBagUnit.findUnique({
      where: { id: objectId },
      select: {
        id: true,
        code: true,
        material: true,
        status: true,
        registrationStatus: true,
        location: true,
        initialKg: true,
        currentKg: true,
        lastMeasuredKg: true,
        lastMeasuredAt: true,
        priceKopecksPerKg: true,
        priceEffectiveAt: true,
        createdAt: true,
      },
    });
    if (!bag) throw this.notFound();

    const valuation = valueBigBag({
      kg: bag.currentKg ?? bag.lastMeasuredKg ?? bag.initialKg ?? 0,
      priceKopecksPerKg: bag.priceKopecksPerKg,
    });
    const view: WarehouseQrBigBagView = {
      id: bag.id,
      code: bag.code,
      material: bag.material,
      status: bag.status,
      registrationStatus: bag.registrationStatus,
      location: bag.location,
      initialKg: bag.initialKg,
      currentKg: bag.currentKg,
      lastMeasuredKg: bag.lastMeasuredKg,
      lastMeasuredAt: toIso(bag.lastMeasuredAt),
      ...valuation,
      priceEffectiveAt: toIso(bag.priceEffectiveAt),
      createdAt: bag.createdAt.toISOString(),
    };

    return { kind: 'big_bag', bigBag: view, inspectedAt: new Date().toISOString() };
  }

  private async inspectPallet(objectId: string): Promise<WarehouseQrInspection> {
    const document = await this.prisma.palletListDocument.findUnique({
      where: { id: objectId },
      select: {
        palletId: true,
        rollIds: true,
        payload: true,
        createdAt: true,
        voidedAt: true,
        warehousePallet: {
          select: {
            palletCode: true,
            status: true,
            sealedAt: true,
          },
        },
      },
    });
    if (!document) throw this.notFound();

    const documentPayload = record(document.payload);
    const label = record(documentPayload.label);
    const materialMark = textFrom(label.materialMark);
    const productNames = stringsFrom(label.productNames);
    const rollCount = numberFrom(label.rollCount);
    const netKg = numberFrom(label.netKg);
    if (!materialMark || productNames.length === 0 || rollCount === null || netKg === null) {
      throw this.notFound();
    }
    const rowRollCodes = exactRowRollCodes(documentPayload.rows);
    const documentRollIds = Array.isArray(document.rollIds) ? document.rollIds : [];
    const payloadProfile = documentPayload.templateVersion;
    const labelProfile = label.templateVersion;
    const isSquare =
      (isPalletLabelProfile(payloadProfile) && isBrowserOnlyPalletLabelProfile(payloadProfile)) ||
      (isPalletLabelProfile(labelProfile) && isBrowserOnlyPalletLabelProfile(labelProfile));
    if (
      isSquare &&
      (!rowRollCodes ||
        rowRollCodes.length !== rollCount ||
        !hasExactPalletDocumentComposition(document.payload, documentRollIds))
    ) {
      throw this.notFound();
    }
    const rollCodes = isSquare ? stringsFrom(label.rollCodes) : (rowRollCodes ?? []);

    const physical = document.warehousePallet;
    const status =
      physical?.status === 'open' || physical?.status === 'sealed' || physical?.status === 'voided'
        ? physical.status
        : null;
    const view: WarehouseQrPalletView = {
      palletCode:
        textFrom(physical?.palletCode, label.palletId, document.palletId) ?? document.palletId,
      status,
      documentStatus: document.voidedAt ? 'voided' : 'sealed',
      materialMark,
      productNames,
      article: textFrom(label.article),
      rollCount,
      packagingMaterial: textFrom(label.packagingMaterial),
      packagingCount: numberFrom(label.packagingCount),
      netKg,
      grossKg: numberFrom(label.grossKg),
      productionDate: textFrom(label.productionDate),
      shelfLifeMonths: numberFrom(label.shelfLifeMonths),
      deliveryDate: textFrom(label.deliveryDate),
      storageConditions: textFrom(label.storageConditions),
      orderNumbers: stringsFrom(label.orderNumbers),
      customerAliases: stringsFrom(label.customerAliases),
      rollCodes,
      createdAt: document.createdAt.toISOString(),
      sealedAt: toIso(physical?.sealedAt),
    };

    return { kind: 'pallet', pallet: view, inspectedAt: new Date().toISOString() };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'WAREHOUSE_QR_NOT_FOUND',
      message: 'QR-код не найден.',
    });
  }
}
