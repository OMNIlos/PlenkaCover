import { apiGet, apiGetBlob, apiPost } from './client';
import type { ServerWarehousePrinter } from './warehouse';

export type WarehouseBigBagCreateInput = {
  baseRawMaterialDefinitionId: string;
  weightKg: number;
  priceKopecksPerKg: number;
  batchCode?: string;
  supplierName?: string;
};

export type WarehouseBigBagCompositionItem = {
  rawMaterialDefinitionId: string | null;
  materialId: string;
  name: string;
  shareBasisPoints: number;
  initialKg: number;
};

export type WarehouseBigBagStatus = 'available' | 'in_use' | 'consumed';
export type WarehouseBigBagRegistrationStatus = 'pending_scan' | 'registered';
export type WarehouseBigBagLocation = 'warehouse' | 'production';
export type WarehouseBigBagActorRole =
  | 'commercial'
  | 'production_lead'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';

export type WarehouseBigBag = {
  id: string;
  code: string;
  material: string;
  materialId: string | null;
  materialSelectionKind: 'legacy' | 'material' | 'recipe' | 'preset';
  materialPreset: 'secondary' | 'aika' | 'primary_tape' | 'pvd_tsp' | 'danaflex' | 'stretch' | null;
  baseRawMaterialDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeName: string | null;
  recipeVersionNumber: number | null;
  supplierName: string | null;
  receivedAt: string | null;
  composition: WarehouseBigBagCompositionItem[];
  status: WarehouseBigBagStatus;
  registrationStatus: WarehouseBigBagRegistrationStatus;
  location: WarehouseBigBagLocation;
  locationRevision: number;
  initialKg: number | null;
  currentKg: number | null;
  lastMeasuredKg: number | null;
  lastActorRole: WarehouseBigBagActorRole | null;
  lastMeasuredAt: string | null;
  machineId: string | null;
  lastWarehouseMeasuredKg: number | null;
  lastWarehouseMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceSource: string | null;
  priceEffectiveAt: string | null;
  createdByRole: WarehouseBigBagActorRole | null;
  createdAt: string;
  latestLabelPrint: WarehouseBigBagPrintResult | null;
};

export type WarehouseBigBagMoveInput = {
  operationKey: string;
  qrCode: string;
  destination: WarehouseBigBagLocation;
  warehouseWeightKg?: number;
};

export type WarehouseBigBagMovementResult = {
  bag: WarehouseBigBag;
  movement: {
    kind: 'registration' | 'to_production' | 'to_warehouse';
    fromLocation: WarehouseBigBagLocation | null;
    toLocation: WarehouseBigBagLocation;
    locationRevision: number;
    createdAt: string;
  };
  weightComparison: {
    operatorReportedKg: number;
    warehouseMeasuredKg: number;
    differenceKg: number;
    differencePercent: number | null;
  } | null;
};

export type WarehouseBigBagPrintInput = {
  requestId: string;
  printerId: string;
  reason?: string;
};

export type WarehouseBigBagSystemPrintInput = {
  requestId: string;
  reason?: string;
};

export type WarehouseBigBagPrintResult = {
  id: string;
  requestId: string;
  bigBagId: string;
  printerId: string | null;
  channel: 'gateway' | 'browser_system_print';
  status: 'queued' | 'submitted' | 'uncertain' | 'failed' | 'intent_recorded';
  reason: string | null;
  replacesPrintJobId: string | null;
  gatewayCommandId: string | null;
  createdAt: string;
  updatedAt: string;
};

type JsonRecord = Record<string, unknown>;

const BAG_FIELDS = [
  'id',
  'code',
  'material',
  'materialId',
  'materialSelectionKind',
  'materialPreset',
  'baseRawMaterialDefinitionId',
  'recipeDefinitionVersionId',
  'recipeName',
  'recipeVersionNumber',
  'supplierName',
  'receivedAt',
  'composition',
  'status',
  'registrationStatus',
  'location',
  'locationRevision',
  'initialKg',
  'currentKg',
  'lastMeasuredKg',
  'lastActorRole',
  'lastMeasuredAt',
  'machineId',
  'lastWarehouseMeasuredKg',
  'lastWarehouseMeasuredAt',
  'priceKopecksPerKg',
  'totalKopecks',
  'priceSource',
  'priceEffectiveAt',
  'createdByRole',
  'createdAt',
  'latestLabelPrint',
] as const;

const ROLES: readonly WarehouseBigBagActorRole[] = [
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
];

function exactRecord(value: unknown, fields: readonly string[], context: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || !keys.every((key) => fields.includes(key))) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return record;
}

function identity(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return value;
}

function nullableIdentity(value: unknown, context: string): string | null {
  return value === null ? null : identity(value, context);
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return value;
}

function nullableNumber(value: unknown, context: string): number | null {
  return value === null ? null : finiteNumber(value, context);
}

function nonNegativeInteger(value: unknown, context: string): number {
  const number = finiteNumber(value, context);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return number;
}

function nullableNonNegativeInteger(value: unknown, context: string): number | null {
  return value === null ? null : nonNegativeInteger(value, context);
}

function isoDate(value: unknown, context: string): string {
  const text = identity(value, context);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return text;
}

function nullableIsoDate(value: unknown, context: string): string | null {
  return value === null ? null : isoDate(value, context);
}

function oneOf<T extends string>(value: unknown, values: readonly T[], context: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return value as T;
}

function nullableOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string,
): T | null {
  return value === null ? null : oneOf(value, values, context);
}

function parseCompositionItem(value: unknown): WarehouseBigBagCompositionItem {
  const context = 'Big-Bag';
  const record = exactRecord(
    value,
    ['rawMaterialDefinitionId', 'materialId', 'name', 'shareBasisPoints', 'initialKg'],
    context,
  );
  const shareBasisPoints = nonNegativeInteger(record.shareBasisPoints, context);
  const initialKg = finiteNumber(record.initialKg, context);
  if (shareBasisPoints < 1 || shareBasisPoints > 10_000 || initialKg < 0) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return {
    rawMaterialDefinitionId: nullableIdentity(record.rawMaterialDefinitionId, context),
    materialId: identity(record.materialId, context),
    name: identity(record.name, context),
    shareBasisPoints,
    initialKg,
  };
}

export function parseWarehouseBigBag(value: unknown): WarehouseBigBag {
  const context = 'Big-Bag';
  const record = exactRecord(value, BAG_FIELDS, context);
  if (!Array.isArray(record.composition)) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  const recipeVersionNumber =
    record.recipeVersionNumber === null
      ? null
      : nonNegativeInteger(record.recipeVersionNumber, context);
  if (recipeVersionNumber !== null && recipeVersionNumber < 1) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  const initialKg = nullableNumber(record.initialKg, context);
  const currentKg = nullableNumber(record.currentKg, context);
  const lastMeasuredKg = nullableNumber(record.lastMeasuredKg, context);
  const priceKopecksPerKg = nullableNonNegativeInteger(record.priceKopecksPerKg, context);
  const totalKopecks = nullableNonNegativeInteger(record.totalKopecks, context);
  const priceSource = nullableIdentity(record.priceSource, context);
  const priceEffectiveAt = nullableIsoDate(record.priceEffectiveAt, context);
  const hasNoValuation =
    priceKopecksPerKg === null &&
    totalKopecks === null &&
    priceSource === null &&
    priceEffectiveAt === null;
  const valuationWeightKg = currentKg ?? lastMeasuredKg ?? initialKg ?? 0;
  const valuationNumerator =
    priceKopecksPerKg === null ? 0 : Math.round(valuationWeightKg * 1_000) * priceKopecksPerKg;
  const expectedTotal =
    priceKopecksPerKg === null || !Number.isSafeInteger(valuationNumerator)
      ? null
      : Math.floor((valuationNumerator + 500) / 1_000);
  const hasCompleteValuation =
    priceKopecksPerKg !== null &&
    totalKopecks === expectedTotal &&
    priceSource !== null &&
    priceEffectiveAt !== null;
  if (!hasNoValuation && !hasCompleteValuation) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return {
    id: identity(record.id, context),
    code: identity(record.code, context),
    material: identity(record.material, context),
    materialId: nullableIdentity(record.materialId, context),
    materialSelectionKind: oneOf(
      record.materialSelectionKind,
      ['legacy', 'material', 'recipe', 'preset'],
      context,
    ),
    materialPreset: nullableOneOf(
      record.materialPreset,
      ['secondary', 'aika', 'primary_tape', 'pvd_tsp', 'danaflex', 'stretch'],
      context,
    ),
    baseRawMaterialDefinitionId: nullableIdentity(record.baseRawMaterialDefinitionId, context),
    recipeDefinitionVersionId: nullableIdentity(record.recipeDefinitionVersionId, context),
    recipeName: nullableIdentity(record.recipeName, context),
    recipeVersionNumber,
    supplierName: nullableIdentity(record.supplierName, context),
    receivedAt: nullableIsoDate(record.receivedAt, context),
    composition: record.composition.map(parseCompositionItem),
    status: oneOf(record.status, ['available', 'in_use', 'consumed'], context),
    registrationStatus: oneOf(record.registrationStatus, ['pending_scan', 'registered'], context),
    location: oneOf(record.location, ['warehouse', 'production'], context),
    locationRevision: nonNegativeInteger(record.locationRevision, context),
    initialKg,
    currentKg,
    lastMeasuredKg,
    lastActorRole: nullableOneOf(record.lastActorRole, ROLES, context),
    lastMeasuredAt: nullableIsoDate(record.lastMeasuredAt, context),
    machineId: nullableIdentity(record.machineId, context),
    lastWarehouseMeasuredKg: nullableNumber(record.lastWarehouseMeasuredKg, context),
    lastWarehouseMeasuredAt: nullableIsoDate(record.lastWarehouseMeasuredAt, context),
    priceKopecksPerKg,
    totalKopecks,
    priceSource,
    priceEffectiveAt,
    createdByRole: nullableOneOf(record.createdByRole, ROLES, context),
    createdAt: isoDate(record.createdAt, context),
    latestLabelPrint:
      record.latestLabelPrint === null ? null : parsePrintResult(record.latestLabelPrint),
  };
}

export function parseWarehouseBigBagList(value: unknown): WarehouseBigBag[] {
  if (!Array.isArray(value)) {
    throw new Error('Некорректные данные Big-Bag.');
  }
  const bags = value.map(parseWarehouseBigBag);
  if (new Set(bags.map((bag) => bag.id)).size !== bags.length) {
    throw new Error('Некорректные данные Big-Bag.');
  }
  return bags;
}

function parseMovementResult(value: unknown): WarehouseBigBagMovementResult {
  const context = 'перемещения Big-Bag';
  const record = exactRecord(value, ['bag', 'movement', 'weightComparison'], context);
  const movement = exactRecord(
    record.movement,
    ['kind', 'fromLocation', 'toLocation', 'locationRevision', 'createdAt'],
    context,
  );
  let weightComparison: WarehouseBigBagMovementResult['weightComparison'] = null;
  if (record.weightComparison !== null) {
    const comparison = exactRecord(
      record.weightComparison,
      ['operatorReportedKg', 'warehouseMeasuredKg', 'differenceKg', 'differencePercent'],
      context,
    );
    weightComparison = {
      operatorReportedKg: finiteNumber(comparison.operatorReportedKg, context),
      warehouseMeasuredKg: finiteNumber(comparison.warehouseMeasuredKg, context),
      differenceKg: finiteNumber(comparison.differenceKg, context),
      differencePercent: nullableNumber(comparison.differencePercent, context),
    };
  }
  return {
    bag: parseWarehouseBigBag(record.bag),
    movement: {
      kind: oneOf(movement.kind, ['registration', 'to_production', 'to_warehouse'], context),
      fromLocation: nullableOneOf(movement.fromLocation, ['warehouse', 'production'], context),
      toLocation: oneOf(movement.toLocation, ['warehouse', 'production'], context),
      locationRevision: nonNegativeInteger(movement.locationRevision, context),
      createdAt: isoDate(movement.createdAt, context),
    },
    weightComparison,
  };
}

function parsePrintResult(value: unknown): WarehouseBigBagPrintResult {
  const context = 'печати Big-Bag';
  const record = exactRecord(
    value,
    [
      'id',
      'requestId',
      'bigBagId',
      'printerId',
      'channel',
      'status',
      'reason',
      'replacesPrintJobId',
      'gatewayCommandId',
      'createdAt',
      'updatedAt',
    ],
    context,
  );
  const printerId = nullableIdentity(record.printerId, context);
  const channel = oneOf(record.channel, ['gateway', 'browser_system_print'], context);
  const status = oneOf(
    record.status,
    ['queued', 'submitted', 'uncertain', 'failed', 'intent_recorded'],
    context,
  );
  const gatewayCommandId = nullableIdentity(record.gatewayCommandId, context);
  if (
    (channel === 'gateway' && (printerId === null || status === 'intent_recorded')) ||
    (channel === 'browser_system_print' &&
      (printerId !== null || status !== 'intent_recorded' || gatewayCommandId !== null))
  ) {
    throw new Error(`Некорректные данные ${context}.`);
  }
  return {
    id: identity(record.id, context),
    requestId: identity(record.requestId, context),
    bigBagId: identity(record.bigBagId, context),
    printerId,
    channel,
    status,
    reason: nullableIdentity(record.reason, context),
    replacesPrintJobId: nullableIdentity(record.replacesPrintJobId, context),
    gatewayCommandId,
    createdAt: isoDate(record.createdAt, context),
    updatedAt: isoDate(record.updatedAt, context),
  };
}

export async function createWarehouseBigBag(
  input: WarehouseBigBagCreateInput,
): Promise<WarehouseBigBag> {
  return parseWarehouseBigBag(await apiPost<unknown>('/api/warehouse/big-bags', input));
}

export async function fetchWarehouseBigBags(): Promise<WarehouseBigBag[]> {
  return parseWarehouseBigBagList(await apiGet<unknown>('/api/warehouse/big-bags'));
}

export function fetchWarehouseBigBagPrinters(): Promise<ServerWarehousePrinter[]> {
  return apiGet<ServerWarehousePrinter[]>('/api/warehouse/big-bags/printers');
}

export async function moveWarehouseBigBag(
  input: WarehouseBigBagMoveInput,
): Promise<WarehouseBigBagMovementResult> {
  return parseMovementResult(await apiPost<unknown>('/api/warehouse/big-bags/scans', input));
}

export async function printWarehouseBigBagLabel(
  bigBagId: string,
  input: WarehouseBigBagPrintInput,
): Promise<WarehouseBigBagPrintResult> {
  return parsePrintResult(
    await apiPost<unknown>(
      `/api/warehouse/big-bags/${encodeURIComponent(bigBagId)}/label-prints`,
      input,
    ),
  );
}

export function fetchWarehouseBigBagLabelPreview(bigBagId: string): Promise<Blob> {
  return apiGetBlob(`/api/warehouse/big-bags/${encodeURIComponent(bigBagId)}/label-preview`);
}

export async function recordWarehouseBigBagSystemPrintIntent(
  bigBagId: string,
  input: WarehouseBigBagSystemPrintInput,
): Promise<WarehouseBigBagPrintResult> {
  return parsePrintResult(
    await apiPost<unknown>(
      `/api/warehouse/big-bags/${encodeURIComponent(bigBagId)}/system-print-intents`,
      input,
    ),
  );
}
