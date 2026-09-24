import { apiPost } from './client';

export type WarehouseQrRollInspection = {
  kind: 'roll';
  inspectedAt: string;
  roll: {
    rollCode: string;
    orderId: string | null;
    orderNumber: string | null;
    customerAlias: string | null;
    requestCreatedAt: string | null;
    readyForShipmentAt: string | null;
    shipmentCompletedAt: string | null;
    sequence: number | null;
    plannedKg: number | null;
    spoolKg: number | null;
    grossKg: number | null;
    netKg: number | null;
    toleranceOk: boolean | null;
    filmType: string | null;
    actualThickness: string | null;
    accountingThickness: string | null;
    widthMm: number | null;
    plannedLengthM: number | null;
    spoolType: string | null;
    birka: string | null;
    productionStatus: string;
    warehouseStatus: string;
    producedAt: string | null;
    receivedAt: string | null;
  };
};

export type WarehouseQrBigBagInspection = {
  kind: 'big_bag';
  inspectedAt: string;
  bigBag: {
    id: string;
    code: string;
    material: string;
    status: string;
    registrationStatus: string;
    location: string;
    initialKg: number | null;
    currentKg: number | null;
    lastMeasuredKg: number | null;
    lastMeasuredAt: string | null;
    priceKopecksPerKg: number | null;
    totalKopecks: number | null;
    priceEffectiveAt: string | null;
    createdAt: string;
  };
};

export type WarehouseQrPalletInspection = {
  kind: 'pallet';
  inspectedAt: string;
  pallet: {
    palletCode: string;
    status: string | null;
    documentStatus: 'sealed' | 'voided' | null;
    materialMark: string;
    productNames: string[];
    article: string | null;
    rollCount: number;
    rollCodes: string[];
    packagingMaterial: string | null;
    packagingCount: number | null;
    shelfLifeMonths: number | null;
    storageConditions: string | null;
    netKg: number;
    grossKg: number | null;
    productionDate: string | null;
    deliveryDate: string | null;
    orderNumbers: string[];
    customerAliases: string[];
    createdAt: string;
    sealedAt: string | null;
  };
};

export type WarehouseQrInspection =
  | WarehouseQrRollInspection
  | WarehouseQrBigBagInspection
  | WarehouseQrPalletInspection;

type JsonRecord = Record<string, unknown>;

function exactRecord(value: unknown, fields: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Некорректные данные QR.');
  }
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) {
    throw new Error('Некорректные данные QR.');
  }
  return record;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error('Некорректные данные QR.');
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Некорректные данные QR.');
  return value.map(text);
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Некорректные данные QR.');
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : number(value);
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || typeof value === 'boolean') return value;
  throw new Error('Некорректные данные QR.');
}

function palletDocumentStatus(value: unknown): 'sealed' | 'voided' {
  if (value === 'sealed' || value === 'voided') return value;
  throw new Error('Некорректные данные QR.');
}

function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Некорректные данные QR.');
  return result;
}

function nullableDate(value: unknown): string | null {
  return value === null ? null : date(value);
}

const ROLL_FIELDS = [
  'rollCode',
  'orderId',
  'orderNumber',
  'customerAlias',
  'requestCreatedAt',
  'readyForShipmentAt',
  'shipmentCompletedAt',
  'sequence',
  'plannedKg',
  'spoolKg',
  'grossKg',
  'netKg',
  'toleranceOk',
  'filmType',
  'actualThickness',
  'accountingThickness',
  'widthMm',
  'plannedLengthM',
  'spoolType',
  'birka',
  'productionStatus',
  'warehouseStatus',
  'producedAt',
  'receivedAt',
] as const;

const BIG_BAG_FIELDS = [
  'id',
  'code',
  'material',
  'status',
  'registrationStatus',
  'location',
  'initialKg',
  'currentKg',
  'lastMeasuredKg',
  'lastMeasuredAt',
  'priceKopecksPerKg',
  'totalKopecks',
  'priceEffectiveAt',
  'createdAt',
] as const;

const LEGACY_PALLET_FIELDS = [
  'palletCode',
  'status',
  'materialMark',
  'productNames',
  'article',
  'rollCount',
  'packagingMaterial',
  'packagingCount',
  'shelfLifeMonths',
  'storageConditions',
  'netKg',
  'grossKg',
  'productionDate',
  'deliveryDate',
  'orderNumbers',
  'customerAliases',
  'createdAt',
  'sealedAt',
] as const;

const PALLET_ROLL_CODES_FIELDS = [...LEGACY_PALLET_FIELDS, 'rollCodes'] as const;
const PALLET_DOCUMENT_STATUS_FIELDS = [...LEGACY_PALLET_FIELDS, 'documentStatus'] as const;
const PALLET_FIELDS = [
  ...LEGACY_PALLET_FIELDS,
  'rollCodes',
  'documentStatus',
] as const;

export function parseWarehouseQrInspection(value: unknown): WarehouseQrInspection {
  const kind = (value as JsonRecord | null)?.kind;
  const envelope = exactRecord(
    value,
    kind === 'roll'
      ? ['kind', 'roll', 'inspectedAt']
      : kind === 'big_bag'
        ? ['kind', 'bigBag', 'inspectedAt']
        : kind === 'pallet'
          ? ['kind', 'pallet', 'inspectedAt']
          : ['kind', 'inspectedAt'],
  );
  const inspectedAt = date(envelope.inspectedAt);

  if (envelope.kind === 'roll') {
    const roll = exactRecord(envelope.roll, ROLL_FIELDS);
    return {
      kind: 'roll',
      inspectedAt,
      roll: {
        rollCode: text(roll.rollCode),
        orderId: nullableText(roll.orderId),
        orderNumber: nullableText(roll.orderNumber),
        customerAlias: nullableText(roll.customerAlias),
        requestCreatedAt: nullableDate(roll.requestCreatedAt),
        readyForShipmentAt: nullableDate(roll.readyForShipmentAt),
        shipmentCompletedAt: nullableDate(roll.shipmentCompletedAt),
        sequence: nullableNumber(roll.sequence),
        plannedKg: nullableNumber(roll.plannedKg),
        spoolKg: nullableNumber(roll.spoolKg),
        grossKg: nullableNumber(roll.grossKg),
        netKg: nullableNumber(roll.netKg),
        toleranceOk: nullableBoolean(roll.toleranceOk),
        filmType: nullableText(roll.filmType),
        actualThickness: nullableText(roll.actualThickness),
        accountingThickness: nullableText(roll.accountingThickness),
        widthMm: nullableNumber(roll.widthMm),
        plannedLengthM: nullableNumber(roll.plannedLengthM),
        spoolType: nullableText(roll.spoolType),
        birka: nullableText(roll.birka),
        productionStatus: text(roll.productionStatus),
        warehouseStatus: text(roll.warehouseStatus),
        producedAt: nullableDate(roll.producedAt),
        receivedAt: nullableDate(roll.receivedAt),
      },
    };
  }

  if (envelope.kind === 'big_bag') {
    const bigBag = exactRecord(envelope.bigBag, BIG_BAG_FIELDS);
    return {
      kind: 'big_bag',
      inspectedAt,
      bigBag: {
        id: text(bigBag.id),
        code: text(bigBag.code),
        material: text(bigBag.material),
        status: text(bigBag.status),
        registrationStatus: text(bigBag.registrationStatus),
        location: text(bigBag.location),
        initialKg: nullableNumber(bigBag.initialKg),
        currentKg: nullableNumber(bigBag.currentKg),
        lastMeasuredKg: nullableNumber(bigBag.lastMeasuredKg),
        lastMeasuredAt: nullableDate(bigBag.lastMeasuredAt),
        priceKopecksPerKg: nullableNumber(bigBag.priceKopecksPerKg),
        totalKopecks: nullableNumber(bigBag.totalKopecks),
        priceEffectiveAt: nullableDate(bigBag.priceEffectiveAt),
        createdAt: date(bigBag.createdAt),
      },
    };
  }

  if (envelope.kind === 'pallet') {
    const palletValue = envelope.pallet;
    const isPalletRecord =
      typeof palletValue === 'object' && palletValue !== null && !Array.isArray(palletValue);
    const hasRollCodes =
      isPalletRecord &&
      Object.prototype.hasOwnProperty.call(palletValue, 'rollCodes');
    const hasDocumentStatus =
      isPalletRecord &&
      Object.prototype.hasOwnProperty.call(palletValue, 'documentStatus');
    const palletFields = hasRollCodes
      ? hasDocumentStatus
        ? PALLET_FIELDS
        : PALLET_ROLL_CODES_FIELDS
      : hasDocumentStatus
        ? PALLET_DOCUMENT_STATUS_FIELDS
        : LEGACY_PALLET_FIELDS;
    const pallet = exactRecord(palletValue, palletFields);
    return {
      kind: 'pallet',
      inspectedAt,
      pallet: {
        palletCode: text(pallet.palletCode),
        status: nullableText(pallet.status),
        documentStatus: hasDocumentStatus
          ? palletDocumentStatus(pallet.documentStatus)
          : null,
        materialMark: text(pallet.materialMark),
        productNames: textArray(pallet.productNames),
        article: nullableText(pallet.article),
        rollCount: number(pallet.rollCount),
        rollCodes: hasRollCodes ? textArray(pallet.rollCodes) : [],
        packagingMaterial: nullableText(pallet.packagingMaterial),
        packagingCount: nullableNumber(pallet.packagingCount),
        shelfLifeMonths: nullableNumber(pallet.shelfLifeMonths),
        storageConditions: nullableText(pallet.storageConditions),
        netKg: number(pallet.netKg),
        grossKg: nullableNumber(pallet.grossKg),
        productionDate: nullableText(pallet.productionDate),
        deliveryDate: nullableText(pallet.deliveryDate),
        orderNumbers: textArray(pallet.orderNumbers),
        customerAliases: textArray(pallet.customerAliases),
        createdAt: date(pallet.createdAt),
        sealedAt: nullableDate(pallet.sealedAt),
      },
    };
  }

  throw new Error('Некорректные данные QR.');
}

export async function inspectWarehouseQr(payload: string): Promise<WarehouseQrInspection> {
  return parseWarehouseQrInspection(
    await apiPost<unknown>('/api/warehouse/qr/inspect', { payload }),
  );
}
