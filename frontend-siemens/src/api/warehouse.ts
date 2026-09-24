import {
  ApiError,
  ApiResponseParseError,
  apiGet,
  apiGetBlob,
  apiPost,
  apiPut,
  type ApiRequestOptions,
} from './client';
import { auditEntry, updateFactList } from '../domain/prototypeRuntime';
import {
  normalizeWarehouseCoverage,
  normalizeWarehouseCoverageDecisionTask,
  normalizeWarehouseCoverageRecheckItem,
  normalizeWarehouseCoverageWithCase,
  type CoveragePhysicalExceptionDto,
  type ResolveWarehouseCoverageRecheckDto,
  type WarehouseCoverageDecisionTaskView,
  type WarehouseCoverageRecheckItem,
  type WarehouseCoverageView,
  type WarehouseCoverageWithCaseView,
} from '../domain/warehouseCoverage';
import type {
  NotificationItem,
  PalletListDocument,
  PalletListTemplateVersion,
  RawMaterialStock,
  WarehouseCoverFreeRoll,
  WarehouseCoverStatus,
  WarehouseCoverTask,
  WarehouseWorkbench,
  WorkObject,
} from '../domain/types';
import { usesPalletBrowserSystemPrint } from '../domain/palletListPrint';
import type { DefectBagType } from '../domain/defectBagLabels';
import {
  parseSealPalletResult,
  type ServerSealPalletResult,
  type ServerWarehousePallet,
  type ServerWarehousePalletDocument,
} from './warehousePalletListContract';

export function warehouseScanErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400 && !error.code) {
    return 'Неверный формат QR. Считайте код с этикетки платформы.';
  }
  if (error instanceof TypeError) {
    return 'Не удалось связаться с сервером. Проверьте связь и повторите скан.';
  }
  return error instanceof Error ? error.message : 'Скан не обработан. Повторите попытку.';
}

export type {
  ServerSealPalletResult,
  ServerWarehousePallet,
  ServerWarehousePalletDocument,
} from './warehousePalletListContract';

export {
  createWarehouseBigBag,
  fetchWarehouseBigBags,
  moveWarehouseBigBag,
  printWarehouseBigBagLabel,
  type WarehouseBigBag,
  type WarehouseBigBagCompositionItem,
  type WarehouseBigBagCreateInput,
  type WarehouseBigBagLocation,
  type WarehouseBigBagMovementResult,
  type WarehouseBigBagPrintResult,
} from './warehouseBigBags';

type ServerRawMaterialStock = {
  id: string;
  materialId: string;
  rawMaterialDefinitionId?: string | null;
  label: string;
  actualQty: number;
  unit: string;
  package?: string | null;
  factStatus: 'warehouse_fact' | 'manual' | 'source';
  updatedAt: string;
  externalId?: string | null;
  sourceVersion?: string | null;
};

export type WarehouseFinishedStockBucket = 'available' | 'processed';

export type WarehouseInventoryOrigin = 'client' | 'reserve';
export type WarehouseInventoryLifecycleStatus =
  | 'awaiting_shipment'
  | 'available'
  | 'reserved'
  | 'defect'
  | 'in_transit'
  | 'delivered'
  | 'processed';
export type WarehouseInventorySortKey = 'receivedAt' | 'rollCode';
export type WarehouseInventorySortDirection = 'asc' | 'desc';
export type WarehouseInventoryPhysicalStatus = 'sent' | 'received' | 'defect' | 'delivered';
export type WarehouseInventoryNextRoute =
  | 'receiving'
  | 'delivery'
  | 'reserve'
  | 'defect_resolution'
  | 'completed';

export type WarehouseInventoryRollItem = {
  id: string;
  rollCode: string;
  origin: WarehouseInventoryOrigin;
  lifecycleStatus: WarehouseInventoryLifecycleStatus;
  lifecycleStatusLabel:
    | 'Ожидает отгрузки'
    | 'Доступен'
    | 'Зарезервирован'
    | 'Брак'
    | 'В пути'
    | 'Выдан'
    | 'Обработан';
  orderNumber: string | null;
  positionId: string | null;
  positionSequence: number | null;
  warehouseStatus: WarehouseInventoryPhysicalStatus;
  warehouseStatusLabel: 'В пути на склад' | 'Принят складом' | 'Подтверждён брак' | 'Выдан';
  nextRoute: WarehouseInventoryNextRoute;
  nextRouteLabel:
    | 'Приёмка'
    | 'Выдача'
    | 'Складской резерв'
    | 'Решение по браку'
    | 'Маршрут завершён';
  counterpartyName: string;
  batchCode: string | null;
  weightKg: number | null;
  specification: string;
  receivedAt: string | null;
  processedAt: string | null;
};

export type WarehouseInventorySpecificationDetails = {
  filmType: string | null;
  actualThicknessMicron: number | null;
  accountingThicknessMicron: number | null;
  widthMm: number | null;
  plannedLengthM: number | null;
  netKg: number | null;
  spoolType: string | null;
  birka: string | null;
  recipeName: string | null;
  ingredients: string[];
};

export type WarehouseInventoryProvenance = {
  kind: 'client_order' | 'stock_reserve' | 'manual';
  orderNumber: string | null;
  batchCode: string | null;
};

export type WarehouseInventoryRollDetail = WarehouseInventoryRollItem & {
  specificationDetails: WarehouseInventorySpecificationDetails;
  provenance: WarehouseInventoryProvenance;
};

export type WarehouseInventoryRollPage = {
  items: WarehouseInventoryRollItem[];
  nextCursor: string | null;
};

export type WarehouseInventoryQuery = {
  view?: 'current' | 'processed';
  q?: string;
  batch?: string;
  minAgeDays?: number;
  maxAgeDays?: number;
  status?: WarehouseInventoryLifecycleStatus;
  counterparty?: string;
  sort?: WarehouseInventorySortKey;
  direction?: WarehouseInventorySortDirection;
  cursor?: string;
  limit?: number;
};

export type WarehouseFinishedStockItem = {
  id: string;
  rollCode: string;
  batchCode: string;
  weightKg: number | null;
  recipe: string | null;
  specification: string | null;
  ageDays: number;
  processedAt: string | null;
};

export interface WarehouseFinishedStockSummary {
  totalCount: number;
  totalWeightKg: number;
  pageCount: number;
  pageWeightKg: number;
}

export type WarehouseFinishedStockPage = {
  items: WarehouseFinishedStockItem[];
  summary: WarehouseFinishedStockSummary;
  nextCursor: string | null;
};

export type WarehouseFinishedStockQuery = {
  bucket?: WarehouseFinishedStockBucket;
  q?: string;
  batch?: string;
  minAgeDays?: number;
  maxAgeDays?: number;
  cursor?: string;
  limit?: number;
};

const EMPTY_FINISHED_STOCK_SUMMARY: WarehouseFinishedStockSummary = {
  totalCount: 0,
  totalWeightKg: 0,
  pageCount: 0,
  pageWeightKg: 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableDate(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeWarehouseFinishedStockItem(value: unknown): WarehouseFinishedStockItem | null {
  const item = record(value);
  if (!item) return null;
  const requiredText = ['id', 'rollCode', 'batchCode'] as const;
  if (requiredText.some((field) => typeof item[field] !== 'string')) return null;
  return {
    id: item.id as string,
    rollCode: item.rollCode as string,
    batchCode: item.batchCode as string,
    weightKg:
      typeof item.weightKg === 'number' && Number.isFinite(item.weightKg) ? item.weightKg : null,
    recipe: nullableString(item.recipe),
    specification: nullableString(item.specification),
    ageDays: finiteNumber(item.ageDays),
    processedAt: nullableDate(item.processedAt),
  };
}

function normalizeWarehouseFinishedStock(value: unknown): WarehouseFinishedStockPage {
  const page = record(value);
  if (!page || !Array.isArray(page.items)) {
    return { items: [], summary: EMPTY_FINISHED_STOCK_SUMMARY, nextCursor: null };
  }
  const summary = record(page.summary);
  return {
    items: page.items.flatMap((item) => {
      const normalized = normalizeWarehouseFinishedStockItem(item);
      return normalized ? [normalized] : [];
    }),
    summary: {
      totalCount: finiteNumber(summary?.totalCount),
      totalWeightKg: finiteNumber(summary?.totalWeightKg),
      pageCount: finiteNumber(summary?.pageCount),
      pageWeightKg: finiteNumber(summary?.pageWeightKg),
    },
    nextCursor: typeof page.nextCursor === 'string' ? page.nextCursor : null,
  };
}

const INVENTORY_STATUS_LABELS = {
  awaiting_shipment: 'Ожидает отгрузки',
  available: 'Доступен',
  reserved: 'Зарезервирован',
  defect: 'Брак',
  in_transit: 'В пути',
  delivered: 'Выдан',
  processed: 'Обработан',
} as const satisfies Record<
  WarehouseInventoryLifecycleStatus,
  WarehouseInventoryRollItem['lifecycleStatusLabel']
>;

const INVENTORY_PHYSICAL_STATUS_LABELS = {
  sent: 'В пути на склад',
  received: 'Принят складом',
  defect: 'Подтверждён брак',
  delivered: 'Выдан',
} as const satisfies Record<
  WarehouseInventoryPhysicalStatus,
  WarehouseInventoryRollItem['warehouseStatusLabel']
>;

const INVENTORY_NEXT_ROUTE_LABELS = {
  receiving: 'Приёмка',
  delivery: 'Выдача',
  reserve: 'Складской резерв',
  defect_resolution: 'Решение по браку',
  completed: 'Маршрут завершён',
} as const satisfies Record<
  WarehouseInventoryNextRoute,
  WarehouseInventoryRollItem['nextRouteLabel']
>;

const INVENTORY_ITEM_KEYS = [
  'id',
  'rollCode',
  'origin',
  'lifecycleStatus',
  'lifecycleStatusLabel',
  'orderNumber',
  'positionId',
  'positionSequence',
  'warehouseStatus',
  'warehouseStatusLabel',
  'nextRoute',
  'nextRouteLabel',
  'counterpartyName',
  'batchCode',
  'weightKg',
  'specification',
  'receivedAt',
  'processedAt',
] as const;
const INVENTORY_DETAIL_KEYS = [
  ...INVENTORY_ITEM_KEYS,
  'specificationDetails',
  'provenance',
] as const;
const INVENTORY_SPECIFICATION_KEYS = [
  'filmType',
  'actualThicknessMicron',
  'accountingThicknessMicron',
  'widthMm',
  'plannedLengthM',
  'netKg',
  'spoolType',
  'birka',
  'recipeName',
  'ingredients',
] as const;
const INVENTORY_PROVENANCE_KEYS = ['kind', 'orderNumber', 'batchCode'] as const;
const WAREHOUSE_PALLET_PAYLOAD = /^plt_[0-9a-f]{64}$/u;
const WAREHOUSE_PALLET_HANDOFF_IDENTIFIER_MAX_LENGTH = 200;
const WAREHOUSE_PALLET_HANDOFF_ROLL_COUNT_MAX = 100;
const WAREHOUSE_PALLET_HANDOFF_RESULT_KEYS = [
  'operationKey',
  'documentId',
  'palletId',
  'palletCode',
  'orderId',
  'deliveryTaskId',
  'deliveryCreated',
  'rollCount',
  'replayed',
] as const;
const WAREHOUSE_PALLET_DELIVERY_RESULT_KEYS = [
  'operationKey',
  'documentId',
  'palletId',
  'palletCode',
  'orderId',
  'deliveryTaskId',
  'rollCount',
  'newlyDeliveredRollCount',
  'alreadyDeliveredRollCount',
  'remainingRollCount',
  'taskStatus',
  'deliveryClosed',
  'replayed',
] as const;
const WAREHOUSE_PALLET_SELECTION_SCAN_RESULT_KEYS = [
  'operationKey',
  'taskId',
  'scanRowId',
  'rollCode',
  'outcome',
  'activePallet',
] as const;
const WAREHOUSE_PALLET_SELECTION_PALLET_KEYS = [
  'id',
  'palletCode',
  'orderId',
  'orderNumber',
  'sequenceNo',
  'status',
  'totalCount',
  'hasMore',
  'openedAt',
  'rows',
] as const;
const WAREHOUSE_PALLET_SELECTION_ROW_KEYS = [
  'rollCode',
  'position',
  'acceptedAt',
  'scannedByName',
] as const;
const WAREHOUSE_PALLET_SELECTION_ROW_LIMIT = 100;

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
): Record<T[number], unknown> | null {
  const candidate = record(value);
  if (!candidate) return null;
  const actualKeys = Object.keys(candidate);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key as T[number]))
  ) {
    return null;
  }
  return candidate as Record<T[number], unknown>;
}

function strictText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

function strictNullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return strictText(value) ?? undefined;
}

function strictNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strictNullablePositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function strictNullableDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value ? value : undefined;
}

function parseWarehouseInventoryItem(
  value: unknown,
  keys: typeof INVENTORY_ITEM_KEYS | typeof INVENTORY_DETAIL_KEYS = INVENTORY_ITEM_KEYS,
): WarehouseInventoryRollItem {
  const item = exactRecord(value, keys);
  const id = strictText(item?.id);
  const rollCode = strictText(item?.rollCode);
  const counterpartyName = strictText(item?.counterpartyName);
  const specification = strictText(item?.specification);
  const origin = item?.origin;
  const lifecycleStatus = item?.lifecycleStatus;
  const orderNumber = strictNullableText(item?.orderNumber);
  const positionId = strictNullableText(item?.positionId);
  const positionSequence = strictNullablePositiveInteger(item?.positionSequence);
  const warehouseStatus = item?.warehouseStatus;
  const nextRoute = item?.nextRoute;
  const batchCode = strictNullableText(item?.batchCode);
  const weightKg = strictNullableNumber(item?.weightKg);
  const receivedAt = strictNullableDate(item?.receivedAt);
  const processedAt = strictNullableDate(item?.processedAt);
  if (
    !item ||
    !id ||
    !rollCode ||
    !counterpartyName ||
    !specification ||
    (origin !== 'client' && origin !== 'reserve') ||
    typeof lifecycleStatus !== 'string' ||
    !(lifecycleStatus in INVENTORY_STATUS_LABELS) ||
    item.lifecycleStatusLabel !==
      INVENTORY_STATUS_LABELS[lifecycleStatus as WarehouseInventoryLifecycleStatus] ||
    typeof warehouseStatus !== 'string' ||
    !(warehouseStatus in INVENTORY_PHYSICAL_STATUS_LABELS) ||
    item.warehouseStatusLabel !==
      INVENTORY_PHYSICAL_STATUS_LABELS[warehouseStatus as WarehouseInventoryPhysicalStatus] ||
    typeof nextRoute !== 'string' ||
    !(nextRoute in INVENTORY_NEXT_ROUTE_LABELS) ||
    item.nextRouteLabel !== INVENTORY_NEXT_ROUTE_LABELS[nextRoute as WarehouseInventoryNextRoute] ||
    orderNumber === undefined ||
    positionId === undefined ||
    positionSequence === undefined ||
    batchCode === undefined ||
    weightKg === undefined ||
    receivedAt === undefined ||
    processedAt === undefined
  ) {
    throw new Error('Некорректный ответ списка складских рулонов.');
  }
  return {
    id,
    rollCode,
    origin,
    lifecycleStatus: lifecycleStatus as WarehouseInventoryLifecycleStatus,
    lifecycleStatusLabel:
      INVENTORY_STATUS_LABELS[lifecycleStatus as WarehouseInventoryLifecycleStatus],
    orderNumber,
    positionId,
    positionSequence,
    warehouseStatus: warehouseStatus as WarehouseInventoryPhysicalStatus,
    warehouseStatusLabel:
      INVENTORY_PHYSICAL_STATUS_LABELS[warehouseStatus as WarehouseInventoryPhysicalStatus],
    nextRoute: nextRoute as WarehouseInventoryNextRoute,
    nextRouteLabel: INVENTORY_NEXT_ROUTE_LABELS[nextRoute as WarehouseInventoryNextRoute],
    counterpartyName,
    batchCode,
    weightKg,
    specification,
    receivedAt,
    processedAt,
  };
}

function parseWarehouseInventoryPage(value: unknown): WarehouseInventoryRollPage {
  const page = exactRecord(value, ['items', 'nextCursor'] as const);
  if (!page || !Array.isArray(page.items)) {
    throw new Error('Некорректный ответ списка складских рулонов.');
  }
  const nextCursor =
    page.nextCursor === null
      ? null
      : typeof page.nextCursor === 'string' && page.nextCursor.length > 0
        ? page.nextCursor
        : undefined;
  if (nextCursor === undefined) {
    throw new Error('Некорректный ответ списка складских рулонов.');
  }
  return {
    items: page.items.map((item) => parseWarehouseInventoryItem(item)),
    nextCursor,
  };
}

function parseWarehouseInventoryDetail(value: unknown): WarehouseInventoryRollDetail {
  try {
    const detail = exactRecord(value, INVENTORY_DETAIL_KEYS);
    if (!detail) throw new Error();
    const item = parseWarehouseInventoryItem(detail, INVENTORY_DETAIL_KEYS);
    const specification = exactRecord(detail.specificationDetails, INVENTORY_SPECIFICATION_KEYS);
    const provenance = exactRecord(detail.provenance, INVENTORY_PROVENANCE_KEYS);
    const filmType = strictNullableText(specification?.filmType);
    const actualThicknessMicron = strictNullableNumber(specification?.actualThicknessMicron);
    const accountingThicknessMicron = strictNullableNumber(
      specification?.accountingThicknessMicron,
    );
    const widthMm = strictNullableNumber(specification?.widthMm);
    const plannedLengthM = strictNullableNumber(specification?.plannedLengthM);
    const netKg = strictNullableNumber(specification?.netKg);
    const spoolType = strictNullableText(specification?.spoolType);
    const birka = strictNullableText(specification?.birka);
    const recipeName = strictNullableText(specification?.recipeName);
    const ingredients = specification?.ingredients;
    const orderNumber = strictNullableText(provenance?.orderNumber);
    const provenanceBatchCode = strictNullableText(provenance?.batchCode);
    if (
      !specification ||
      filmType === undefined ||
      actualThicknessMicron === undefined ||
      accountingThicknessMicron === undefined ||
      widthMm === undefined ||
      plannedLengthM === undefined ||
      netKg === undefined ||
      spoolType === undefined ||
      birka === undefined ||
      recipeName === undefined ||
      !Array.isArray(ingredients) ||
      ingredients.some((ingredient) => strictText(ingredient) === null) ||
      !provenance ||
      typeof provenance.kind !== 'string' ||
      !['client_order', 'stock_reserve', 'manual'].includes(provenance.kind) ||
      orderNumber === undefined ||
      provenanceBatchCode === undefined
    ) {
      throw new Error();
    }
    return {
      ...item,
      specificationDetails: {
        filmType,
        actualThicknessMicron,
        accountingThicknessMicron,
        widthMm,
        plannedLengthM,
        netKg,
        spoolType,
        birka,
        recipeName,
        ingredients: ingredients as string[],
      },
      provenance: {
        kind: provenance.kind as WarehouseInventoryProvenance['kind'],
        orderNumber,
        batchCode: provenanceBatchCode,
      },
    };
  } catch {
    throw new Error('Некорректный ответ складского рулона.');
  }
}

export async function fetchWarehouseInventory(
  query: WarehouseInventoryQuery = {},
  options?: ApiRequestOptions,
): Promise<WarehouseInventoryRollPage> {
  const search = new URLSearchParams();
  if (query.view) search.set('view', query.view);
  if (query.q?.trim()) search.set('q', query.q.trim());
  if (query.batch?.trim()) search.set('batch', query.batch.trim());
  if (query.minAgeDays !== undefined) search.set('minAgeDays', String(query.minAgeDays));
  if (query.maxAgeDays !== undefined) search.set('maxAgeDays', String(query.maxAgeDays));
  if (query.status) search.set('status', query.status);
  if (query.counterparty?.trim()) search.set('counterparty', query.counterparty.trim());
  search.set('sort', query.sort ?? 'receivedAt');
  search.set('direction', query.direction ?? 'desc');
  if (query.cursor) search.set('cursor', query.cursor);
  search.set('limit', String(query.limit ?? 25));
  const page = await apiGet<unknown>(
    `/api/warehouse/inventory/rolls?${search.toString()}`,
    options,
  );
  return parseWarehouseInventoryPage(page);
}

export async function fetchWarehouseInventoryRoll(
  rollId: string,
  options?: ApiRequestOptions,
): Promise<WarehouseInventoryRollDetail> {
  const detail = await apiGet<unknown>(
    `/api/warehouse/inventory/rolls/${encodeURIComponent(rollId)}`,
    options,
  );
  return parseWarehouseInventoryDetail(detail);
}

export type WarehouseReserveRollCreateInput = {
  operationKey: string;
  rollCode: string;
  batchCode: string;
  filmType: string;
  actualThicknessMicron: number;
  accountingThicknessMicron: number;
  widthMm: number;
  plannedLengthM: number;
  grossKg: number;
  spoolKg: number;
  plannedNetKg?: number;
  spoolType: string;
  birka: string;
  baseRawMaterialDefinitionId?: string;
  recipeDefinitionVersionId?: string;
};

export type WarehouseReserveRoll = {
  id: string;
  rollCode: string;
  batchCode: string;
  sourceOrderId: string;
  sourceOrderNumber: string;
  filmType: string;
  actualThicknessMicron: number;
  accountingThicknessMicron: number;
  widthMm: number;
  plannedLengthM: number;
  grossKg: number;
  spoolKg: number;
  netKg: number;
  plannedNetKg: number;
  spoolType: string;
  birka: string;
  materialLabel: string;
  source: 'platform';
  availability: 'available';
  receivedAt: string;
  qrReady: true;
};

export async function fetchWarehouseFinishedStock(
  query: WarehouseFinishedStockQuery = {},
  options?: ApiRequestOptions,
): Promise<WarehouseFinishedStockPage> {
  const search = new URLSearchParams();
  if (query.bucket) search.set('bucket', query.bucket);
  if (query.q?.trim()) search.set('q', query.q.trim());
  if (query.batch?.trim()) search.set('batch', query.batch.trim());
  if (query.minAgeDays !== undefined) search.set('minAgeDays', String(query.minAgeDays));
  if (query.maxAgeDays !== undefined) search.set('maxAgeDays', String(query.maxAgeDays));
  if (query.cursor) search.set('cursor', query.cursor);
  search.set('limit', String(query.limit ?? 25));
  const page = await apiGet<unknown>(`/api/warehouse/finished-stock?${search.toString()}`, options);
  return normalizeWarehouseFinishedStock(page);
}

export async function createWarehouseReserveRoll(
  input: WarehouseReserveRollCreateInput,
): Promise<WarehouseReserveRoll> {
  const value = await apiPost<unknown>('/api/warehouse/finished-stock', input);
  return parseWarehouseReserveRoll(value);
}

function parseWarehouseReserveRoll(value: unknown): WarehouseReserveRoll {
  const fields = [
    'id',
    'rollCode',
    'batchCode',
    'sourceOrderId',
    'sourceOrderNumber',
    'filmType',
    'actualThicknessMicron',
    'accountingThicknessMicron',
    'widthMm',
    'plannedLengthM',
    'grossKg',
    'spoolKg',
    'netKg',
    'plannedNetKg',
    'spoolType',
    'birka',
    'materialLabel',
    'source',
    'availability',
    'receivedAt',
    'qrReady',
  ] as const;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректный ответ регистрации рулона.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    !Object.keys(record).every((field) => fields.includes(field as (typeof fields)[number]))
  ) {
    throw new Error('Некорректный ответ регистрации рулона.');
  }
  const textFields = [
    'id',
    'rollCode',
    'batchCode',
    'sourceOrderId',
    'sourceOrderNumber',
    'filmType',
    'spoolType',
    'birka',
    'materialLabel',
    'receivedAt',
  ] as const;
  if (
    textFields.some(
      (field) =>
        typeof record[field] !== 'string' ||
        !(record[field] as string).trim() ||
        record[field] !== (record[field] as string).trim(),
    )
  ) {
    throw new Error('Некорректный ответ регистрации рулона.');
  }
  const numberFields = [
    'actualThicknessMicron',
    'accountingThicknessMicron',
    'widthMm',
    'plannedLengthM',
    'grossKg',
    'spoolKg',
    'netKg',
    'plannedNetKg',
  ] as const;
  if (
    numberFields.some(
      (field) => typeof record[field] !== 'number' || !Number.isFinite(record[field]),
    ) ||
    record.source !== 'platform' ||
    record.availability !== 'available' ||
    record.qrReady !== true ||
    Number.isNaN(Date.parse(record.receivedAt as string))
  ) {
    throw new Error('Некорректный ответ регистрации рулона.');
  }
  return record as WarehouseReserveRoll;
}

export async function fetchWarehouseRawMaterialStocks(
  options?: ApiRequestOptions,
): Promise<RawMaterialStock[]> {
  const rows = await apiGet<unknown>('/api/warehouse/raw-materials', options);
  if (!Array.isArray(rows)) {
    throw new Error('Некорректный ответ остатков сырья.');
  }
  return rows.map(serverRawMaterialToStock);
}

export async function adjustWarehouseRawMaterial(
  materialId: string,
  input: { operationKey: string; actualQty: number; reason: string },
): Promise<RawMaterialStock> {
  const stock = await apiPost<unknown>(
    `/api/warehouse/raw-materials/${encodeURIComponent(materialId)}/adjustments`,
    input,
  );
  try {
    return serverRawMaterialToStock(stock);
  } catch (error) {
    throw new ApiResponseParseError(200, error);
  }
}

export async function receiveWarehouseRawMaterial(
  materialId: string,
  input: { operationKey: string; receivedQty: number; reason: string },
): Promise<RawMaterialStock> {
  const stock = await apiPost<unknown>(
    `/api/warehouse/raw-materials/${encodeURIComponent(materialId)}/receipts`,
    input,
  );
  return serverRawMaterialToStock(stock);
}

export type WarehouseDefectBagMode = 'receiving' | 'shipping';

export type WarehouseDefectBag = {
  id: string;
  code: string;
  status: 'weighed' | 'ready_for_warehouse' | 'received' | 'shipped';
  defectType: DefectBagType | null;
  weightKg: number;
  operatorName: string;
  postCode: string;
  postName: string;
  shiftLabel: string | null;
  weighedAt: string;
};

export function fetchWarehouseDefectBags(
  mode: WarehouseDefectBagMode,
): Promise<WarehouseDefectBag[]> {
  return apiGet(`/api/warehouse/defect-bags?mode=${mode}`);
}

export function receiveWarehouseDefectBag(payload: string, operationKey: string) {
  return apiPost<WarehouseDefectBag>('/api/warehouse/defect-bags/receipts', {
    operationKey,
    payload,
  });
}

export function shipWarehouseDefectBag(payload: string, operationKey: string) {
  return apiPost<WarehouseDefectBag>('/api/warehouse/defect-bags/shipments', {
    operationKey,
    payload,
  });
}
export type WarehouseOneCStockItem = { materialId: string; qty: number; unit: string };

export type WarehouseOneCStockPushPreview = {
  snapshotHash: string;
  count: number;
  totalQty: number;
  writeReady: boolean;
  readinessCode: 'ready' | 'mock_adapter' | 'write_disabled' | 'onec_unavailable';
  readinessMessage: string;
  items: WarehouseOneCStockItem[];
};

export type WarehouseOneCStockPushResult = {
  operationKey: string;
  pushed: number;
  count: number;
  totalQty: number;
  items: WarehouseOneCStockItem[];
  snapshotHash: string;
  replayed: boolean;
  ack: {
    accepted: boolean;
    count: number;
    ref: string;
    mode: 'http';
    documentCreated: true;
  };
};

export function fetchWarehouseRawMaterialsOneCPreview(): Promise<WarehouseOneCStockPushPreview> {
  return apiGet('/api/warehouse/raw-materials/onec-push-preview');
}

export function pushWarehouseRawMaterialsToOneC(input: {
  operationKey: string;
  snapshotHash: string;
}): Promise<WarehouseOneCStockPushResult> {
  return apiPost('/api/warehouse/raw-materials/push-to-1c', input);
}

export type ServerWarehouseCoverCheckPosition = {
  id: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialId: string | null;
  spoolType: string | null;
  birka: string | null;
  plannedWeightKg: number | null;
  warehouseCoverStatus: WarehouseCoverStatus;
};

export type ServerWarehouseCoverCheckItem = {
  caseId: string;
  orderId: string;
  orderNumber: string;
  customerAlias: string;
  state: 'open';
  requestedAt: string;
  updatedAt: string;
  positions: ServerWarehouseCoverCheckPosition[];
};

export type WarehouseCoverCheckPage = {
  items: WorkObject[];
  nextCursor: string | null;
};

export async function fetchWarehouseCoverChecks(
  query: { cursor?: string; limit?: number } = {},
  options?: ApiRequestOptions,
): Promise<WarehouseCoverCheckPage> {
  const search = new URLSearchParams();
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.cursor) search.set('cursor', query.cursor);
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  const page = await apiGet<{
    items: ServerWarehouseCoverCheckItem[];
    nextCursor: string | null;
  }>(`/api/warehouse/cover-checks${suffix}`, options);
  return {
    items: page.items.map(serverCoverCheckToWorkObject),
    nextCursor: page.nextCursor,
  };
}

export async function fetchWarehouseCoverCheckQueue(options?: ApiRequestOptions): Promise<WorkObject[]> {
  const items = new Map<string, WorkObject>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  // ponytail: the existing snapshot owns up to 10,000 checks; use UI pagination beyond this ceiling.
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await fetchWarehouseCoverChecks({ limit: 100, cursor }, options);
    page.items.forEach((item) => items.set(item.id, item));
    if (page.nextCursor === null) return [...items.values()];
    if (seenCursors.has(page.nextCursor)) throw new Error('Зацикленная пагинация проверок покрытия.');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('Превышен лимит страниц проверок покрытия.');
}

type ServerWarehouseFreeRoll = {
  id: string;
  rollCode: string;
  warehouseStatus: string;
  facts: WarehouseCoverFreeRoll['facts'];
};

export async function fetchWarehouseFreeRolls(
  options?: ApiRequestOptions,
): Promise<WarehouseCoverFreeRoll[]> {
  const rows = await apiGet<ServerWarehouseFreeRoll[]>(
    '/api/warehouse/rolls?ownership=free',
    options,
  );
  return rows.map(serverFreeRollToSafeRoll);
}

export function proposeWarehouseCover(
  orderId: string,
  input: { positionId: string; rollIds: string[]; comment?: string },
): Promise<unknown> {
  return apiPost(`/api/warehouse/orders/${encodeURIComponent(orderId)}/cover-proposals`, input);
}

export const warehouseCoverageApi: {
  listRechecks(): Promise<WarehouseCoverageRecheckItem[]>;
  readDecisionTask(taskId: string): Promise<WarehouseCoverageDecisionTaskView>;
  resolve(
    caseId: string,
    input: ResolveWarehouseCoverageRecheckDto,
  ): Promise<WarehouseCoverageView>;
  reportPhysicalException(
    taskId: string,
    input: CoveragePhysicalExceptionDto,
  ): Promise<WarehouseCoverageWithCaseView>;
} = {
  async listRechecks() {
    const response = await apiGet<unknown>('/api/warehouse/warehouse-coverage/rechecks');
    if (!Array.isArray(response)) {
      throw new Error('warehouse coverage rechecks must be an array');
    }
    return response.map(normalizeWarehouseCoverageRecheckItem);
  },
  async readDecisionTask(taskId) {
    const response = await apiGet<unknown>(`/api/warehouse/tasks/${encodeURIComponent(taskId)}`);
    return normalizeWarehouseCoverageDecisionTask(response);
  },
  async resolve(caseId, input) {
    const response = await apiPost<unknown>(
      `/api/warehouse/warehouse-coverage/rechecks/${encodeURIComponent(caseId)}/resolve`,
      input,
    );
    return normalizeWarehouseCoverage(response);
  },
  async reportPhysicalException(taskId, input) {
    const response = await apiPost<unknown>(
      `/api/warehouse/tasks/${encodeURIComponent(taskId)}/coverage-physical-exception`,
      input,
    );
    return normalizeWarehouseCoverageWithCase(response);
  },
};

export function applyLiveRawMaterials(object: WorkObject, stocks: RawMaterialStock[]): WorkObject {
  const total = stocks.reduce((sum, stock) => sum + stock.actualQty, 0);
  return {
    ...object,
    statusLabel: 'Актуальные данные',
    severity: stocks.some((stock) => stock.actualQty <= 0) ? 'critical' : 'info',
    rawMaterialStocks: stocks,
    facts: updateFactList(
      object.facts,
      {
        'На складе': `${stocks.length} позиции сырья · ${total} кг`,
        'По учету': 'Факт склада из backend, 1С-снимок mock/externalId',
        Действие: 'Сверять расхождения через складские корректировки',
        Статус: 'Актуальные данные',
      },
      'warehouse',
    ),
    sections: [
      {
        id: 'raw-material-primary',
        title: 'Первичное сырье',
        facts: stocks.flatMap((stock) => [
          {
            label: `${stock.label} · на складе`,
            value: `${stock.actualQty} ${stock.unit} · ${stock.source}`,
            scope: 'warehouse' as const,
          },
          {
            label: `${stock.label} · источник`,
            value: stock.referenceSnapshotId ?? 'без externalId',
            scope: 'warehouse' as const,
          },
          {
            label: `${stock.label} · статус`,
            value: stock.sourceOfTruthStatus,
            scope: 'warehouse' as const,
          },
        ]),
      },
      {
        id: 'raw-material-reconciliation',
        title: 'Сверка факта и учета',
        facts: stocks.map((stock) => ({
          label: stock.rawMaterialId,
          value: `${stock.actualQty} ${stock.unit}; обновлено ${stock.updatedAt}`,
          scope: 'warehouse' as const,
        })),
      },
    ],
    audit: [
      auditEntry(
        'WH-INV-RAW',
        'Система',
        'integration:warehouse_raw_materials_loaded',
        `Обновлено ${stocks.length} складских остатков.`,
      ),
      ...object.audit,
    ],
  };
}

export function liveRawMaterialsToWorkObject(stocks: RawMaterialStock[]): WorkObject {
  const total = stocks.reduce((sum, stock) => sum + stock.actualQty, 0);
  return {
    id: 'warehouse-live-inventory',
    kind: 'warehouseJob',
    title: 'Сырье и резерв',
    statusLabel: 'Актуальные данные',
    nextOwner: 'Склад',
    severity: stocks.some((stock) => stock.actualQty <= 0) ? 'critical' : 'info',
    filterTags: ['Сырье', 'Склад рулонов', 'Запасы / резерв', 'Расходники', 'Движения'],
    facts: [
      {
        label: 'На складе',
        value: `${stocks.length} позиции сырья · ${total} кг`,
        scope: 'warehouse',
      },
      { label: 'Источник', value: 'Факт склада', scope: 'warehouse' },
    ],
    sections: [],
    actions: [],
    problems: [],
    audit: [
      auditEntry(
        'warehouse-live-inventory',
        'Система',
        'integration:warehouse_raw_materials_loaded',
        `Обновлено ${stocks.length} складских остатков.`,
      ),
    ],
    rawMaterialStocks: stocks,
  };
}

function serverCoverCheckToWorkObject(item: ServerWarehouseCoverCheckItem): WorkObject {
  const task: WarehouseCoverTask = {
    caseId: item.caseId,
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    customerAlias: item.customerAlias,
    state: item.state,
    requestedAt: item.requestedAt,
    updatedAt: item.updatedAt,
    positions: item.positions.map((position) => ({
      id: position.id,
      rollCount: position.rollCount,
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      rawMaterialId: position.rawMaterialId,
      spoolType: position.spoolType,
      birka: position.birka,
      plannedWeightKg: position.plannedWeightKg,
      warehouseCoverStatus: position.warehouseCoverStatus,
    })),
  };
  const totalRolls = task.positions.reduce((sum, position) => sum + position.rollCount, 0);
  const positionFacts = task.positions.flatMap((position, index) => [
    {
      label: `Позиция ${index + 1}`,
      value: `${position.rollCount} рул. · ${position.filmType} · ${position.actualThickness}`,
      scope: 'warehouse' as const,
    },
    {
      label: `Сырье ${index + 1}`,
      value: rawMaterialLabel(position.rawMaterialId),
      scope: 'warehouse' as const,
    },
  ]);

  return {
    id: `WH-COVER-${task.orderId}`,
    kind: 'warehouseJob',
    title: `Проверка покрытия ${task.orderNumber}`,
    statusLabel: 'Проверить покрытие',
    nextOwner: 'Склад',
    severity: 'warning',
    filterTags: ['Запасы / резерв', 'Требуют действия', 'Проверить покрытие'],
    facts: [
      { label: 'Заказ', value: task.orderNumber, scope: 'warehouse' },
      { label: 'Клиент', value: task.customerAlias, scope: 'warehouse' },
      {
        label: 'Позиции',
        value: `${task.positions.length} поз., ${totalRolls} рул.`,
        scope: 'warehouse',
      },
      { label: 'Запрошено', value: task.requestedAt, scope: 'warehouse' },
    ],
    sections: [
      {
        id: 'warehouse-cover-check',
        title: 'Проверка покрытия заказа',
        facts: [
          {
            label: 'Маршрут',
            value: 'Склад проверяет резерв и факт сырья до передачи в производство.',
            scope: 'warehouse',
          },
          { label: 'Рулоны', value: `${totalRolls} рул.`, scope: 'warehouse' },
          ...positionFacts,
        ],
      },
      {
        id: 'warehouse-cover-timing',
        title: 'Сроки проверки',
        facts: [
          { label: 'Запрошено', value: task.requestedAt, scope: 'warehouse' },
          { label: 'Обновлено', value: task.updatedAt, scope: 'warehouse' },
        ],
      },
    ],
    actions: [
      {
        id: `warehouse-cover-propose:${task.orderId}`,
        label: 'Подготовить предложение',
        level: 'recommended',
        enabled: true,
      },
    ],
    problems: [],
    audit: [
      auditEntry(
        task.orderId,
        'Система',
        'integration:warehouse_cover_checks_loaded',
        `Заявка ${task.orderNumber} загружена в складскую очередь.`,
      ),
    ],
    warehouseCoverTask: task,
  };
}

function serverFreeRollToSafeRoll(row: ServerWarehouseFreeRoll): WarehouseCoverFreeRoll {
  return {
    id: row.id,
    rollCode: row.rollCode,
    warehouseStatus: row.warehouseStatus,
    facts: {
      filmType: row.facts.filmType,
      actualThickness: row.facts.actualThickness,
      birka: row.facts.birka,
      spoolType: row.facts.spoolType,
      plannedWeightKg: row.facts.plannedWeightKg,
    },
  };
}

function parseServerRawMaterialStock(value: unknown): ServerRawMaterialStock {
  const row = record(value);
  const id = strictText(row?.id);
  const materialId = strictText(row?.materialId);
  const label = strictText(row?.label);
  const unit = strictText(row?.unit);
  const updatedAt = strictNullableDate(row?.updatedAt);
  const rawMaterialDefinitionId = strictNullableText(row?.rawMaterialDefinitionId);
  const packageQty = strictNullableText(row?.package);
  const externalId = strictNullableText(row?.externalId);
  const sourceVersion = strictNullableText(row?.sourceVersion);
  const factStatus = row?.factStatus;
  if (
    !row ||
    !id ||
    !materialId ||
    !label ||
    !unit ||
    typeof row.actualQty !== 'number' ||
    !Number.isFinite(row.actualQty) ||
    !['warehouse_fact', 'manual', 'source'].includes(factStatus as string) ||
    typeof updatedAt !== 'string' ||
    (Object.hasOwn(row, 'rawMaterialDefinitionId') && rawMaterialDefinitionId === undefined) ||
    (Object.hasOwn(row, 'package') && packageQty === undefined) ||
    (Object.hasOwn(row, 'externalId') && externalId === undefined) ||
    (Object.hasOwn(row, 'sourceVersion') && sourceVersion === undefined)
  ) {
    throw new Error('Некорректный ответ остатков сырья.');
  }
  return {
    id,
    materialId,
    label,
    actualQty: row.actualQty,
    unit,
    factStatus: factStatus as ServerRawMaterialStock['factStatus'],
    updatedAt,
    rawMaterialDefinitionId,
    package: packageQty,
    externalId,
    sourceVersion,
  };
}

function serverRawMaterialToStock(value: unknown): RawMaterialStock {
  const row = parseServerRawMaterialStock(value);
  const source =
    row.factStatus === 'manual'
      ? 'manual_platform'
      : row.factStatus === 'warehouse_fact'
        ? 'warehouse_fact'
        : 'unknown';
  return {
    id: row.id,
    rawMaterialId: row.materialId,
    rawMaterialDefinitionId: row.rawMaterialDefinitionId ?? null,
    label: row.label,
    materialKind: 'unclassified',
    qty: row.actualQty,
    actualQty: row.actualQty,
    unit: row.unit,
    packageQty: row.package ?? undefined,
    source,
    sourceOfTruthStatus:
      row.factStatus === 'manual'
        ? 'ручная корректировка'
        : row.factStatus === 'warehouse_fact'
          ? 'актуально'
          : 'требует пересчета',
    updatedAt: row.updatedAt,
  };
}

function rawMaterialLabel(rawMaterialId: string | null | undefined) {
  if (rawMaterialId === 'rm-pvd-15803') return 'ПВД 15803-020';
  if (rawMaterialId === 'rm-pvd-10803') return 'ПВД 10803-020';
  return rawMaterialId ?? 'не указано';
}

function warehouseCoverStatusLabel(status: string) {
  if (status === 'needs_production') return 'В производство';
  if (status === 'partial_proposed') return 'Частично закрывается складом';
  if (status === 'full_proposed') return 'Склад закрывает';
  if (status === 'partial_confirmed' || status === 'full_confirmed') return 'Резерв подтвержден';
  if (status === 'recheck_requested') return 'Перепроверка склада';
  return 'Проверить покрытие';
}

// --- Приёмка (live, design 2026-07-13 §9) -------------------------------------

import { qrDisplayLabel } from '../domain/qrDisplay';

export type ServerIntakeRoll = {
  scanRowId: string;
  rollCode: string;
  orderId: string | null;
  orderNumber: string | null;
  orderLineId: string | null;
  customerAlias: string | null;
  sequence: number;
  planKg: number | null;
  netKg: number | null;
  grossKg: number | null;
  characteristics: {
    filmType?: string | null;
    materialMark?: string | null;
    sizeMeters?: string | null;
    actualThickness?: string | null;
    lengthMeters?: string | null;
    spoolType?: string | null;
    article?: string | null;
    packagingMaterial?: string | null;
    packagingCount?: number | null;
    deliveryDate?: string | null;
  } | null;
  source: 'warehouse_reserve' | 'production_handover' | 'production_pending';
  ownership: 'customer_owned' | 'free_reserve' | 'reserved_for_order' | 'shipped';
  operatorLabel: string | null;
  machineLabel: string | null;
  productionStatus: string;
  producedAt: string | null;
  scanStatus: string;
  warehouseState: string;
  scannedByName: string | null;
  palletSelection: {
    selected: boolean;
    locked: boolean;
    palletId: string | null;
    palletCode: string | null;
  };
};

export type WarehousePalletVoidReasonCode = 'wrong_composition' | 'print_problem' | 'other';

export type ServerVoidWarehousePalletResult = ServerWarehousePalletDocument & {
  documentStatus: 'sealed' | 'voided';
};

export type ServerIntakeTask = {
  taskId: string;
  operationCode: string | null;
  orderNumbers: string[];
  customerAliases: string[];
  orderNumber: string | null;
  customerAlias: string | null;
  status: 'accepted' | 'has_defect' | 'has_reserve' | 'awaiting_rolls' | 'pallet_open' | 'scanning';
  plannedRollCount: number;
  expected: number;
  accepted: number;
  errors: number;
  closable: boolean;
  lastScanResult: {
    rollCode: string | null;
    scanStatus: string;
    scannedAt: string;
  } | null;
  rolls: ServerIntakeRoll[];
  activePallet?: ServerWarehousePallet | null;
  palletHistory?: ServerWarehousePalletDocument[];
  palletHistoryHasMore?: boolean;
  palletList: {
    id: string;
    createdAt: string;
    templateVersion: PalletListTemplateVersion;
    printReady: boolean;
    printStatus: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ServerCloseAndPrintPalletResult = {
  pallet: ServerWarehousePallet;
  document: ServerWarehousePalletDocument;
  printJob: ServerPalletPrintResult;
};

export type ServerSetPalletSelectionResult = {
  selectionChanged: boolean;
  activePallet:
    | (Omit<ServerWarehousePallet, 'rollCount'> & {
        totalCount: number;
        hasMore: boolean;
      })
    | null;
};

export type ServerWarehousePalletSelectionScanResult = {
  operationKey: string;
  taskId: string;
  scanRowId: string;
  rollCode: string;
  outcome: 'added' | 'already_selected';
  activePallet: NonNullable<ServerSetPalletSelectionResult['activePallet']>;
};

export type ServerWarehouseIntake = {
  stats: { todayOps: number; remainingQr: number; errors: number };
  tasks: ServerIntakeTask[];
  generatedAt: string;
};

export type ServerWarehouseTaskRow = {
  id: string;
  taskId: string;
  rollCode: string | null;
  fromOrderId: string | null;
  customerAlias: string | null;
  scanStatus: string;
  lastScanAt: string | null;
  scannedByName: string | null;
};

export type ServerWarehouseTask = {
  id: string;
  mode: 'receiving' | 'delivery' | string;
  status: 'open' | 'partial' | 'closed' | string;
  operationCode: string | null;
  orderId: string | null;
  positionId: string | null;
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
  lastScanResult: {
    rollCode: string | null;
    scanStatus: string;
    scannedAt: string;
  } | null;
  rows: ServerWarehouseTaskRow[];
};

export type ServerWarehouseScanResult = {
  operationId: string;
  taskId: string;
  rollCode: string;
  mode: 'receiving' | 'delivery' | string;
  scanStatus: string;
  replayed: boolean;
  task: ServerIntakeTask;
};

export type ServerWarehousePalletHandoffScanResult = {
  operationKey: string;
  documentId: string;
  palletId: string;
  palletCode: string;
  orderId: string;
  deliveryTaskId: string;
  deliveryCreated: boolean;
  rollCount: number;
  replayed: boolean;
};

export type ServerWarehousePalletDeliveryScanResult = {
  operationKey: string;
  documentId: string;
  palletId: string;
  palletCode: string;
  orderId: string;
  deliveryTaskId: string;
  rollCount: number;
  newlyDeliveredRollCount: number;
  alreadyDeliveredRollCount: number;
  remainingRollCount: number;
  taskStatus: 'open' | 'partial' | 'closed';
  deliveryClosed: boolean;
  replayed: boolean;
};

export type ServerWarehousePrinter = {
  id: string;
  code: string | null;
  label: string;
  post: { id: string; code: string; name: string };
  status: string;
  ready: boolean;
  unavailableReason: string | null;
};

export type ServerPalletPrintResult = {
  id: string;
  requestId: string;
  printerId: string;
  status: 'queued' | 'submitted';
  gatewayCommandId: string | null;
  message: string;
};

export type PalletSystemPrintIntentKind = 'initial' | 'reprint';

export type PalletSystemPrintIntentInput =
  | { requestId: string; kind: 'initial'; reason?: never }
  | { requestId: string; kind: 'reprint'; reason: string };

export type ServerPalletSystemPrintIntentResult = {
  eventId: string;
  requestId: string;
  palletListDocumentId: string;
  kind: PalletSystemPrintIntentKind;
  status: 'intent_recorded';
  replayed: boolean;
  requestedAt: string;
};

export type ServerWarehouseNotification = {
  id: string;
  type: string;
  label: string | null;
  objectId: string | null;
  reason: string | null;
  createdAt: string;
};

export function fetchWarehouseIntake(options?: ApiRequestOptions): Promise<ServerWarehouseIntake> {
  return apiGet<ServerWarehouseIntake>('/api/warehouse/intake', options);
}

export async function fetchWarehouseDeliveryTasks(
  options?: ApiRequestOptions,
): Promise<ServerWarehouseTask[]> {
  const taskGroups = await Promise.all(
    ['delivery', 'reserve'].map((mode) =>
      apiGet<ServerWarehouseTask[]>(`/api/warehouse/tasks?mode=${mode}`, options),
    ),
  );
  return Array.from(new Map(taskGroups.flat().map((task) => [task.id, task])).values());
}

export function fetchWarehousePrinters(): Promise<ServerWarehousePrinter[]> {
  return apiGet<ServerWarehousePrinter[]>('/api/warehouse/printers');
}

export function fetchWarehousePalletPreview(documentId: string): Promise<Blob> {
  return apiGetBlob(`/api/warehouse/pallet-lists/${documentId}/preview`);
}

export function fetchWarehouseNotifications(): Promise<ServerWarehouseNotification[]> {
  return apiGet<ServerWarehouseNotification[]>('/api/warehouse/notifications');
}

const WAREHOUSE_NOTIFICATION_TITLES: Record<string, string> = {
  'problem:raw_material_shortage': 'Не хватает сырья',
  'problem:shift_balance_mismatch': 'Расхождение по смене',
  'problem:operator_defect_reported': 'Брак рулона',
  'notification:production_problem_received': 'Проблема производства',
  'audit:warehouse_roll_defect_recycled': 'Брак передан в переработку',
  'audit:warehouse_roll_reserved_overweight': 'Рулон передан в резерв',
};

export function warehouseNotificationToItem(row: ServerWarehouseNotification): NotificationItem {
  const isProblem = row.type.startsWith('problem:');
  const title = row.label?.trim() || WAREHOUSE_NOTIFICATION_TITLES[row.type] || 'Складское событие';
  const body = row.reason?.trim()
    ? `Причина: ${row.reason.trim()}`
    : row.objectId
      ? `Объект: ${row.objectId}`
      : 'Откройте контроль склада для проверки.';
  return {
    id: row.id,
    eventType: row.type,
    recipientRole: 'warehouse',
    severity: isProblem ? 'warning' : 'info',
    title,
    body,
    objectId: row.objectId ?? undefined,
    createdAt: row.createdAt,
    requiresAck: isProblem,
    sound: isProblem,
  };
}

export function mergeWarehouseNotifications(
  current: NotificationItem[],
  rows: ServerWarehouseNotification[],
): NotificationItem[] {
  const incoming = rows.map(warehouseNotificationToItem);
  const incomingIds = new Set(incoming.map((notification) => notification.id));
  return [...incoming, ...current.filter((notification) => !incomingIds.has(notification.id))];
}

export function scanWarehousePayload(
  payload: string,
  operationKey: string,
): Promise<ServerWarehouseScanResult> {
  return apiPost('/api/warehouse/intake/scans', { operationKey, payload });
}

function parseWarehousePalletSelectionScanResult(
  value: unknown,
  taskId: string,
  operationKey: string,
): ServerWarehousePalletSelectionScanResult {
  const result = exactRecord(value, WAREHOUSE_PALLET_SELECTION_SCAN_RESULT_KEYS);
  const pallet = exactRecord(result?.activePallet, WAREHOUSE_PALLET_SELECTION_PALLET_KEYS);
  const echoedOperationKey = strictText(result?.operationKey);
  const echoedTaskId = strictText(result?.taskId);
  const scanRowId = strictText(result?.scanRowId);
  const rollCode = strictText(result?.rollCode);
  const outcome = result?.outcome;
  const palletId = strictText(pallet?.id);
  const palletCode = strictText(pallet?.palletCode);
  const orderId = strictText(pallet?.orderId);
  const orderNumber = strictText(pallet?.orderNumber);
  const sequenceNo = strictNullablePositiveInteger(pallet?.sequenceNo);
  const totalCount = strictNullablePositiveInteger(pallet?.totalCount);
  const hasMore = pallet?.hasMore;
  const openedAt = strictNullableDate(pallet?.openedAt);
  if (
    !result ||
    !pallet ||
    echoedOperationKey !== operationKey ||
    echoedTaskId !== taskId ||
    !scanRowId ||
    !rollCode ||
    !palletId ||
    !palletCode ||
    !orderId ||
    !orderNumber ||
    [scanRowId, rollCode, palletId, palletCode, orderId, orderNumber].some(
      (identifier) => identifier.length > WAREHOUSE_PALLET_HANDOFF_IDENTIFIER_MAX_LENGTH,
    ) ||
    (outcome !== 'added' && outcome !== 'already_selected') ||
    typeof sequenceNo !== 'number' ||
    pallet.status !== 'open' ||
    typeof totalCount !== 'number' ||
    typeof hasMore !== 'boolean' ||
    typeof openedAt !== 'string' ||
    !Array.isArray(pallet.rows) ||
    pallet.rows.length !== Math.min(totalCount, WAREHOUSE_PALLET_SELECTION_ROW_LIMIT) ||
    hasMore !== totalCount > WAREHOUSE_PALLET_SELECTION_ROW_LIMIT
  ) {
    throw new ApiResponseParseError(
      200,
      new Error('Ответ скана рулона не подтверждает точную палетную операцию.'),
    );
  }

  const rows = pallet.rows.map((value) => {
    const row = exactRecord(value, WAREHOUSE_PALLET_SELECTION_ROW_KEYS);
    const rollCode = strictText(row?.rollCode);
    const position = strictNullablePositiveInteger(row?.position);
    const acceptedAt = strictNullableDate(row?.acceptedAt);
    const scannedByName = strictNullableText(row?.scannedByName);
    if (
      !row ||
      !rollCode ||
      rollCode.length > WAREHOUSE_PALLET_HANDOFF_IDENTIFIER_MAX_LENGTH ||
      typeof position !== 'number' ||
      typeof acceptedAt !== 'string' ||
      scannedByName === undefined
    ) {
      throw new ApiResponseParseError(
        200,
        new Error('Ответ скана рулона содержит некорректную строку палеты.'),
      );
    }
    return { rollCode, position, acceptedAt, scannedByName };
  });
  if (new Set(rows.map((row) => row.rollCode)).size !== rows.length) {
    throw new ApiResponseParseError(
      200,
      new Error('Ответ скана рулона содержит повторы в палете.'),
    );
  }

  return {
    operationKey: echoedOperationKey,
    taskId: echoedTaskId,
    scanRowId,
    rollCode,
    outcome,
    activePallet: {
      id: palletId,
      palletCode,
      orderId,
      orderNumber,
      sequenceNo,
      status: 'open',
      totalCount,
      hasMore,
      openedAt,
      rows,
    },
  };
}

export async function scanWarehousePalletSelection(
  taskId: string,
  payload: string,
  operationKey: string,
): Promise<ServerWarehousePalletSelectionScanResult> {
  const result = await apiPost<unknown>(
    `/api/warehouse/intake/${encodeURIComponent(taskId)}/pallet-selection/scans`,
    { operationKey, payload },
  );
  return parseWarehousePalletSelectionScanResult(result, taskId, operationKey);
}

export function isWarehousePalletPayload(payload: string): boolean {
  return WAREHOUSE_PALLET_PAYLOAD.test(payload);
}

function parseWarehousePalletHandoffScanResult(
  value: unknown,
  operationKey: string,
): ServerWarehousePalletHandoffScanResult {
  const result = exactRecord(value, WAREHOUSE_PALLET_HANDOFF_RESULT_KEYS);
  const identifiers = result
    ? [
        result.operationKey,
        result.documentId,
        result.palletId,
        result.palletCode,
        result.orderId,
        result.deliveryTaskId,
      ]
    : [];
  if (
    !result ||
    result.operationKey !== operationKey ||
    identifiers.some((identifier) => {
      const text = strictText(identifier);
      return text === null || text.length > WAREHOUSE_PALLET_HANDOFF_IDENTIFIER_MAX_LENGTH;
    }) ||
    typeof result.deliveryCreated !== 'boolean' ||
    typeof result.rollCount !== 'number' ||
    !Number.isSafeInteger(result.rollCount) ||
    result.rollCount <= 0 ||
    result.rollCount > WAREHOUSE_PALLET_HANDOFF_ROLL_COUNT_MAX ||
    typeof result.replayed !== 'boolean'
  ) {
    throw new ApiResponseParseError(
      200,
      new Error('Ответ скана палетного листа не подтверждает точную операцию.'),
    );
  }
  return result as ServerWarehousePalletHandoffScanResult;
}

export async function scanWarehousePallet(
  payload: string,
  operationKey: string,
): Promise<ServerWarehousePalletHandoffScanResult> {
  const result = await apiPost<unknown>('/api/warehouse/pallets/scans', {
    operationKey,
    payload,
  });
  return parseWarehousePalletHandoffScanResult(result, operationKey);
}

function parseWarehousePalletDeliveryScanResult(
  value: unknown,
  operationKey: string,
): ServerWarehousePalletDeliveryScanResult {
  const result = exactRecord(value, WAREHOUSE_PALLET_DELIVERY_RESULT_KEYS);
  const identifiers = result
    ? [
        result.operationKey,
        result.documentId,
        result.palletId,
        result.palletCode,
        result.orderId,
        result.deliveryTaskId,
      ]
    : [];
  const counts = result
    ? [
        result.rollCount,
        result.newlyDeliveredRollCount,
        result.alreadyDeliveredRollCount,
        result.remainingRollCount,
      ]
    : [];
  const taskStatus = result?.taskStatus;
  if (
    !result ||
    result.operationKey !== operationKey ||
    identifiers.some((identifier) => {
      const text = strictText(identifier);
      return text === null || text.length > WAREHOUSE_PALLET_HANDOFF_IDENTIFIER_MAX_LENGTH;
    }) ||
    counts.some(
      (count) =>
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > WAREHOUSE_PALLET_HANDOFF_ROLL_COUNT_MAX,
    ) ||
    result.rollCount === 0 ||
    (result.newlyDeliveredRollCount as number) + (result.alreadyDeliveredRollCount as number) !==
      result.rollCount ||
    !['open', 'partial', 'closed'].includes(taskStatus as string) ||
    typeof result.deliveryClosed !== 'boolean' ||
    result.deliveryClosed !== (taskStatus === 'closed') ||
    (result.remainingRollCount === 0 && taskStatus === 'open') ||
    typeof result.replayed !== 'boolean'
  ) {
    throw new ApiResponseParseError(
      200,
      new Error('Ответ палетной выдачи не подтверждает точную операцию.'),
    );
  }
  return result as ServerWarehousePalletDeliveryScanResult;
}

export async function scanWarehousePalletDelivery(
  payload: string,
  operationKey: string,
): Promise<ServerWarehousePalletDeliveryScanResult> {
  const result = await apiPost<unknown>('/api/warehouse/pallets/delivery-scans', {
    operationKey,
    payload,
  });
  return parseWarehousePalletDeliveryScanResult(result, operationKey);
}

export function scanWarehouseTask(
  taskId: string,
  payload: string,
  operationKey: string,
): Promise<ServerWarehouseScanResult> {
  return apiPost<ServerWarehouseScanResult>(`/api/warehouse/tasks/${taskId}/scans`, {
    operationKey,
    payload,
  });
}

export function setWarehousePalletSelection(
  taskId: string,
  scanRowId: string,
  input: { operationKey: string; selected: boolean },
): Promise<ServerSetPalletSelectionResult> {
  return apiPut<ServerSetPalletSelectionResult>(
    `/api/warehouse/intake/${taskId}/pallet-selection/${scanRowId}`,
    input,
  );
}

export function closeWarehouseIntakeTask(taskId: string, mode: 'full' | 'partial'): Promise<void> {
  return apiPost(`/api/warehouse/tasks/${taskId}/close`, { mode }).then(() => undefined);
}

export function closeAndPrintCurrentWarehousePallet(
  taskId: string,
  input: { printerId: string; requestId: string },
): Promise<ServerCloseAndPrintPalletResult> {
  return apiPost<ServerCloseAndPrintPalletResult>(
    `/api/warehouse/intake/${taskId}/pallets/current/close-and-print`,
    input,
  );
}

export async function sealCurrentWarehousePallet(
  taskId: string,
  input: { requestId: string },
): Promise<ServerSealPalletResult> {
  const result = await apiPost<unknown>(
    `/api/warehouse/intake/${taskId}/pallets/current/seal`,
    input,
  );
  try {
    return parseSealPalletResult(result);
  } catch (error: unknown) {
    throw new ApiResponseParseError(200, error);
  }
}

function parseVoidWarehousePalletResult(value: unknown): ServerVoidWarehousePalletResult {
  const result = record(value);
  if (
    !result ||
    typeof result.id !== 'string' ||
    typeof result.warehousePalletId !== 'string' ||
    (result.documentStatus !== 'sealed' && result.documentStatus !== 'voided') ||
    !['not_printed', 'submitted', 'failed', 'needs_admin'].includes(String(result.printStatus))
  ) {
    throw new Error('Некорректный ответ аннулирования палетного листа.');
  }
  // Additive parser: new server fields are allowed, lifecycle is validated fail-closed.
  return result as unknown as ServerVoidWarehousePalletResult;
}

export async function voidWarehousePallet(
  taskId: string,
  palletId: string,
  input: {
    operationKey: string;
    reasonCode: WarehousePalletVoidReasonCode;
    note?: string;
  },
): Promise<ServerVoidWarehousePalletResult> {
  const result = await apiPost<unknown>(
    `/api/warehouse/intake/${taskId}/pallets/${palletId}/void`,
    input,
  );
  return parseVoidWarehousePalletResult(result);
}

export function printWarehousePalletList(
  palletListId: string,
  input: { printerId: string; requestId: string; reason?: string },
): Promise<ServerPalletPrintResult> {
  return apiPost<ServerPalletPrintResult>(
    `/api/warehouse/pallet-lists/${palletListId}/print`,
    input,
  );
}

export function recordWarehousePalletSystemPrintIntent(
  palletListId: string,
  input: PalletSystemPrintIntentInput,
): Promise<ServerPalletSystemPrintIntentResult> {
  return apiPost<unknown>(
    `/api/warehouse/pallet-lists/${palletListId}/system-print-intents`,
    input,
  ).then((value) => parseWarehousePalletSystemPrintIntentResult(value, palletListId, input));
}

function parseWarehousePalletSystemPrintIntentResult(
  value: unknown,
  palletListId: string,
  input: PalletSystemPrintIntentInput,
): ServerPalletSystemPrintIntentResult {
  const result = record(value);
  if (
    !result ||
    strictText(result.eventId) === null ||
    result.requestId !== input.requestId ||
    result.palletListDocumentId !== palletListId ||
    result.kind !== input.kind ||
    result.status !== 'intent_recorded' ||
    typeof result.replayed !== 'boolean' ||
    typeof strictNullableDate(result.requestedAt) !== 'string'
  ) {
    throw new ApiResponseParseError(
      200,
      new Error('System-print intent response does not confirm the exact request.'),
    );
  }
  return result as ServerPalletSystemPrintIntentResult;
}

const EXPORT_FORMAT_MAP: Record<'word' | 'excel' | 'pdf', string> = {
  word: 'docx',
  excel: 'xlsx',
  pdf: 'pdf',
};

/** Скачивает файл палетного листа с Bearer-токеном (blob → сохранение). */
export async function downloadWarehousePalletList(
  palletListId: string,
  format: 'word' | 'excel' | 'pdf',
): Promise<void> {
  const serverFormat = EXPORT_FORMAT_MAP[format];
  const blob = await apiGetBlob(
    `/api/warehouse/pallet-lists/${palletListId}/export?format=${serverFormat}`,
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pallet-list.${serverFormat}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const INTAKE_ROLL_STATUS_LABELS: Record<string, string> = {
  expected: 'Ждет скан',
  accepted: 'Принят',
  duplicate: 'Дубликат',
  wrong: 'Не найден',
  excess: 'Чужой QR',
  damaged: 'Брак',
  reserved: 'В резерв + производство',
  missing: 'Потерян',
};

const INTAKE_TASK_STATUS_LABELS: Record<ServerIntakeTask['status'], string> = {
  accepted: 'Принято',
  has_defect: 'Брак',
  has_reserve: 'Резерв + производство',
  awaiting_rolls: 'Рулоны не переданы на склад',
  pallet_open: 'Палета не закрыта',
  scanning: 'Идет приемка',
};

function intakeRollStatusLabel(roll: ServerIntakeRoll): string {
  if (
    roll.scanStatus === 'expected' &&
    (roll.source === 'production_pending' || !['sent', 'received'].includes(roll.warehouseState))
  ) {
    return 'Ждет производства';
  }
  return INTAKE_ROLL_STATUS_LABELS[roll.scanStatus] ?? roll.scanStatus;
}

function intakePalletListDocument(summary: ServerWarehousePalletDocument): PalletListDocument {
  const usesBrowserSystemPrint = usesPalletBrowserSystemPrint(summary.templateVersion);

  return {
    id: summary.id,
    palletId: summary.palletId,
    status: 'ready',
    formatLabel: usesBrowserSystemPrint ? 'системная печать' : 'PDF',
    fields: [
      { label: 'Палетный лист', value: summary.palletId, scope: 'warehouse' },
      { label: 'Заказ', value: summary.orderId ?? '—', scope: 'warehouse' },
      { label: 'Рулонов', value: String(summary.rollCount), scope: 'warehouse' },
      { label: 'Дата', value: summary.createdAt.slice(0, 10), scope: 'warehouse' },
    ],
    rollIds: summary.rollCodes,
    orderIds: summary.orderId ? [summary.orderId] : [],
    warehousePalletId: summary.warehousePalletId,
    origin: summary.origin,
    ...(summary.origin === 'physical_pallet'
      ? {
          documentStatus:
            summary.documentStatus === 'sealed' || summary.documentStatus === 'voided'
              ? summary.documentStatus
              : 'unknown',
        }
      : summary.documentStatus === 'voided'
        ? { documentStatus: 'voided' }
        : {}),
    rollCount: summary.rollCount,
    orderId: summary.orderId,
    generatedAt: summary.createdAt,
    templateVersion: summary.templateVersion,
    printReady: summary.printReady,
    printStatus: summary.printStatus,
    fieldSetStatus: 'contract_ready',
    availableFormats: usesBrowserSystemPrint ? [] : ['word', 'excel', 'pdf'],
    sourceLabel: 'Данные склада',
    auditEvent: 'audit:pallet_list_print_requested',
  };
}

function intakePalletListDocuments(
  task: ServerIntakeTask,
  legacyPalletId: string,
): PalletListDocument[] {
  const summaries = (task.palletHistory ?? []).slice();
  if (task.palletList && !summaries.some((summary) => summary.id === task.palletList?.id)) {
    summaries.unshift({
      id: task.palletList.id,
      palletId: legacyPalletId,
      warehousePalletId: null,
      origin: 'legacy',
      createdAt: task.palletList.createdAt,
      templateVersion: task.palletList.templateVersion,
      printReady: task.palletList.printReady,
      printStatus: task.palletList.printStatus,
      rollCount: task.accepted,
      rollCodes: [],
      rollCodesHasMore: false,
      orderId: null,
    });
  }
  return summaries.map(intakePalletListDocument);
}

/** Живая карточка Приёмки: обязательны тег «Приемка» и workbench.type='warehouse'. */
export function intakeTaskToWorkObject(task: ServerIntakeTask): WorkObject {
  const orderNumbers =
    task.orderNumbers.length > 0 ? task.orderNumbers : task.orderNumber ? [task.orderNumber] : [];
  const customerAliases =
    task.customerAliases.length > 0
      ? task.customerAliases
      : task.customerAlias
        ? [task.customerAlias]
        : [];
  const titleSuffix = task.orderNumber ?? (orderNumbers.join(' + ') || task.taskId);
  const title = `Приемка ${titleSuffix}`;
  const statusLabel = INTAKE_TASK_STATUS_LABELS[task.status];
  const accepted = task.rolls
    .filter((roll) => roll.scanStatus === 'accepted')
    .map((roll) => roll.rollCode);
  const excess = task.rolls
    .filter((roll) => ['excess', 'wrong', 'duplicate'].includes(roll.scanStatus))
    .map((roll) => roll.rollCode);
  const missing = task.rolls
    .filter((roll) => roll.scanStatus === 'expected')
    .map((roll) => roll.rollCode);
  const collectedBy = Array.from(
    new Set(task.rolls.map((roll) => roll.scannedByName).filter(Boolean)),
  ).join(', ');
  const palletId = task.operationCode ?? task.taskId;
  const activePallet = task.activePallet ?? null;
  const palletListDocuments = intakePalletListDocuments(task, palletId);
  const palletListDocument = palletListDocuments[0];
  const canCloseTask = task.closable && activePallet === null;
  const currentTaskRollCount = task.expected + task.accepted;
  const plannedRollCount =
    Number.isInteger(task.plannedRollCount) && task.plannedRollCount >= 0
      ? Math.max(task.plannedRollCount, currentTaskRollCount)
      : currentTaskRollCount;
  const workbench: WarehouseWorkbench = {
    type: 'warehouse',
    mode: 'receiving',
    taskId: task.taskId,
    taskClosed: task.status === 'accepted',
    prompt: activePallet
      ? `${activePallet.palletCode}: палет можно закрыть и распечатать в любой момент.`
      : task.closable
        ? 'Все QR приняты и палеты закрыты — завершите приемку.'
        : 'Сканируйте QR и явно выберите принятые рулоны для палетного листа.',
    expected: task.expected + task.accepted,
    scanned: task.accepted,
    plannedRollCount,
    missing,
    excess,
    accepted,
    lastScan: intakeLastScanLabel(task.lastScanResult),
    lastScanResult: task.lastScanResult
      ? {
          rollCode: task.lastScanResult.rollCode,
          scanStatus: task.lastScanResult.scanStatus,
          scannedAt: task.lastScanResult.scannedAt,
        }
      : null,
    scanSeverity: task.errors > 0 ? 'warning' : 'info',
    scanResult: task.errors > 0 ? `Ошибок скана: ${task.errors}` : undefined,
    expectedRolls: task.rolls.map((roll) => ({
      id: roll.rollCode,
      status: intakeRollStatusLabel(roll),
      source: roll.source,
      ownership: roll.ownership,
      sequenceNumber: roll.sequence,
      orderId: roll.orderNumber ?? undefined,
      orderEntityId: roll.orderId ?? undefined,
      orderLineId: roll.orderLineId ?? undefined,
      customerAlias: roll.customerAlias ?? undefined,
      scanRowId: roll.scanRowId,
      palletSelection: roll.palletSelection,
      palletId: roll.palletSelection.palletCode ?? undefined,
      operatorLabel: roll.operatorLabel ?? undefined,
      machineLabel: roll.machineLabel ?? undefined,
      productionStatus: roll.productionStatus,
      expectedAt: roll.producedAt ?? undefined,
      filmType: roll.characteristics?.filmType ?? 'Не указан',
      micron: roll.characteristics?.actualThickness ?? '—',
      sizeMeters: roll.characteristics?.sizeMeters ?? roll.characteristics?.spoolType ?? '—',
      lengthMeters: roll.characteristics?.lengthMeters ?? undefined,
      materialMark: roll.characteristics?.materialMark ?? undefined,
      spoolType: roll.characteristics?.spoolType ?? undefined,
      article: roll.characteristics?.article ?? undefined,
      packagingMaterial: roll.characteristics?.packagingMaterial ?? undefined,
      packagingCount: roll.characteristics?.packagingCount ?? undefined,
      deliveryDate: roll.characteristics?.deliveryDate ?? undefined,
      plannedNetKg: roll.netKg ?? roll.planKg ?? 0,
      planNetKg: roll.planKg ?? undefined,
      actualNetKg: roll.netKg ?? undefined,
      grossKg: roll.grossKg ?? undefined,
      producedAt: roll.producedAt ?? undefined,
      tolerancePercent: 5,
    })),
    deviceStatus: [{ label: 'Сканер', value: 'Готов (HID)', severity: 'info' }],
    evidence: [
      { label: 'Операция', value: palletId, scope: 'warehouse' },
      { label: 'Собрал', value: collectedBy || 'ещё не сканировали', scope: 'warehouse' },
    ],
    activePallet,
    palletListDocuments,
    palletHistoryHasMore: task.palletHistoryHasMore ?? false,
    palletListDocument,
  };
  return {
    id: `intake-${task.taskId}`,
    kind: 'warehouseJob',
    title,
    statusLabel,
    workbench,
    nextOwner: 'Склад',
    severity: task.status === 'has_defect' ? 'critical' : task.errors > 0 ? 'warning' : 'info',
    filterTags: [
      'Приемка',
      task.status === 'accepted' ? 'Завершены' : 'Требуют действия',
      statusLabel,
    ],
    facts: [
      { label: 'Заказ', value: orderNumbers.join(', ') || '—', scope: 'warehouse' },
      { label: 'Операция', value: palletId, scope: 'warehouse' },
      {
        label: 'Счетчик',
        value: `${task.accepted} / ${task.accepted + task.expected}`,
        scope: 'warehouse',
      },
      { label: 'Статус', value: statusLabel, scope: 'warehouse' },
      { label: 'Клиент', value: customerAliases.join(', ') || '—', scope: 'warehouse' },
    ],
    sections: [],
    actions: [
      {
        id: `warehouse.scan:${task.taskId}`,
        label: 'Сканировать QR',
        level: 'recommended',
        enabled: true,
      },
      ...(activePallet && activePallet.rollCount > 0
        ? [
            {
              id: `warehouse-close-and-print-pallet:${task.taskId}`,
              label: 'Закрыть и распечатать палет',
              level: 'secondary' as const,
              enabled: true,
            },
          ]
        : []),
      task.status === 'accepted'
        ? {
            id: `warehouse-intake-closed:${task.taskId}`,
            label: 'Приемка закрыта',
            level: 'disabled',
            enabled: false,
            disabledReason: 'Заказ уже принят складом',
          }
        : {
            id: `warehouse.close:${task.taskId}`,
            label: 'Закрыть приемку',
            level: canCloseTask ? 'recommended' : 'disabled',
            enabled: canCloseTask,
            ...(canCloseTask
              ? {}
              : {
                  disabledReason: activePallet
                    ? 'Сначала закройте и распечатайте текущий палет'
                    : 'Не все рулоны отсканированы',
                  recoveryOwner: 'Склад',
                  recoveryAction: activePallet
                    ? 'Закрыть текущий палет'
                    : 'Досканировать QR или оформить брак/резерв',
                }),
          },
    ],
    problems: [],
    audit: [
      auditEntry(
        task.taskId,
        'Система',
        'integration:warehouse_intake_loaded',
        `Задача приёмки ${palletId} обновлена.`,
      ),
    ],
  };
}

export function applyWarehousePalletSelectionScan(
  object: WorkObject,
  result: ServerWarehousePalletSelectionScanResult,
): WorkObject {
  const workbench = object.workbench;
  if (
    object.id !== `intake-${result.taskId}` ||
    workbench?.type !== 'warehouse' ||
    workbench.mode !== 'receiving' ||
    workbench.taskId !== result.taskId
  ) {
    return object;
  }

  const activePallet: ServerWarehousePallet = {
    id: result.activePallet.id,
    palletCode: result.activePallet.palletCode,
    orderId: result.activePallet.orderId,
    orderNumber: result.activePallet.orderNumber,
    sequenceNo: result.activePallet.sequenceNo,
    status: result.activePallet.status,
    rollCount: result.activePallet.totalCount,
    openedAt: result.activePallet.openedAt,
    rows: result.activePallet.rows,
  };
  const closeActionId = `warehouse-close-and-print-pallet:${result.taskId}`;
  const intakeCloseActionId = `warehouse.close:${result.taskId}`;
  const updatedActions = object.actions.map((action) =>
    action.id === intakeCloseActionId
      ? {
          ...action,
          level: 'disabled' as const,
          enabled: false,
          disabledReason: 'Сначала закройте и распечатайте текущий палет',
          recoveryOwner: 'Склад',
          recoveryAction: 'Закрыть текущий палет',
        }
      : action,
  );
  const intakeCloseIndex = updatedActions.findIndex((action) => action.id === intakeCloseActionId);
  const actions = updatedActions.some((action) => action.id === closeActionId)
    ? updatedActions
    : [
        ...updatedActions.slice(0, intakeCloseIndex < 0 ? updatedActions.length : intakeCloseIndex),
        {
          id: closeActionId,
          label: 'Закрыть и распечатать палет',
          level: 'secondary' as const,
          enabled: true,
        },
        ...updatedActions.slice(intakeCloseIndex < 0 ? updatedActions.length : intakeCloseIndex),
      ];

  return {
    ...object,
    workbench: {
      ...workbench,
      prompt: `${activePallet.palletCode}: палет можно закрыть и распечатать в любой момент.`,
      activePallet,
      expectedRolls: workbench.expectedRolls?.map((roll) =>
        roll.scanRowId === result.scanRowId
          ? {
              ...roll,
              palletId: activePallet.palletCode,
              palletSelection: {
                selected: true,
                locked: false,
                palletId: activePallet.id,
                palletCode: activePallet.palletCode,
              },
            }
          : roll,
      ),
    },
    actions,
  };
}

function intakeLastScanLabel(result: ServerIntakeTask['lastScanResult']): string {
  if (!result) return '—';
  if (result.rollCode) return qrDisplayLabel(result.rollCode) ?? result.rollCode;
  return INTAKE_ROLL_STATUS_LABELS[result.scanStatus] ?? 'Скан не распознан';
}

const DELIVERY_TASK_STATUS_LABELS: Record<string, string> = {
  open: 'Ожидает сканирования',
  partial: 'Частичная выдача',
  closed: 'Выдача закрыта',
};

function deliveryRollStatusLabel(scanStatus: string): string {
  if (scanStatus === 'expected') return 'Ждет скан';
  return INTAKE_ROLL_STATUS_LABELS[scanStatus] ?? scanStatus;
}

/** Живая карточка Выдачи из task projection; raw scanner payload в неё не переносится. */
export function deliveryTaskToWorkObject(task: ServerWarehouseTask): WorkObject {
  const coverageDecisionTask = task.mode === 'reserve';
  const errorRows = task.rows.filter((row) =>
    ['excess', 'wrong', 'duplicate'].includes(row.scanStatus),
  );
  const plannedRows = task.rows.filter(
    (row): row is ServerWarehouseTaskRow & { rollCode: string } =>
      Boolean(row.rollCode) && !errorRows.includes(row),
  );
  const accepted = plannedRows
    .filter((row) => row.scanStatus === 'accepted')
    .map((row) => row.rollCode);
  const missing = plannedRows
    .filter((row) => row.scanStatus === 'expected')
    .map((row) => row.rollCode);
  const excess = errorRows.map((row, index) => row.rollCode ?? `Ошибка скана ${index + 1}`);
  const processed = plannedRows.filter((row) => row.scanStatus !== 'expected').length;
  const orderNumbers = Array.from(
    new Set(
      plannedRows.map((row) => row.fromOrderId).filter((value): value is string => Boolean(value)),
    ),
  );
  const orderLabel = orderNumbers.join(', ') || task.orderId || task.id;
  const statusLabel = DELIVERY_TASK_STATUS_LABELS[task.status] ?? task.status;
  const closed = task.status === 'closed';
  const closable = !closed && plannedRows.length > 0 && missing.length === 0;
  const lastScan = intakeLastScanLabel(task.lastScanResult);
  const operationCode = task.operationCode ?? task.id;
  const workbench: WarehouseWorkbench = {
    type: 'warehouse',
    mode: 'delivery',
    ...(coverageDecisionTask ? { coverageDecisionTaskId: task.id } : {}),
    prompt: coverageDecisionTask
      ? 'Проверьте физическое наличие зарезервированных рулонов.'
      : closed
        ? 'Выдача закрыта; статус оплаты обновлён.'
        : closable
          ? 'Все палеты подтверждены — закройте выдачу.'
          : 'Сканируйте QR каждого палетного листа один раз.',
    expected: plannedRows.length,
    scanned: processed,
    missing,
    excess,
    accepted,
    lastScan,
    lastScanResult: task.lastScanResult,
    scanSeverity: excess.length > 0 ? 'warning' : 'info',
    scanResult: excess.length > 0 ? `Ошибок скана: ${excess.length}` : undefined,
    expectedRolls: plannedRows.map((row, index) => ({
      id: row.rollCode,
      status: deliveryRollStatusLabel(row.scanStatus),
      source: 'warehouse_reserve',
      ownership: closed && row.scanStatus === 'accepted' ? 'shipped' : 'reserved_for_order',
      sequenceNumber: index + 1,
      orderId: row.fromOrderId ?? undefined,
      orderEntityId: task.orderId ?? undefined,
      customerAlias: row.customerAlias?.trim() || undefined,
      palletId: operationCode,
      productionStatus:
        closed && row.scanStatus === 'accepted'
          ? 'delivered'
          : closed
            ? 'not_delivered'
            : 'ready_for_delivery',
      filmType: 'Готовый рулон',
      micron: '—',
      sizeMeters: '—',
      plannedNetKg: 0,
      tolerancePercent: 5,
    })),
    deviceStatus: [{ label: 'Сканер', value: 'Готов (HID)', severity: 'info' }],
    evidence: [
      { label: 'Операция', value: operationCode, scope: 'warehouse' },
      { label: 'Источник', value: 'Задача выдачи', scope: 'warehouse' },
    ],
  };

  return {
    id: `delivery-${task.id}`,
    kind: 'warehouseJob',
    title: coverageDecisionTask ? `Проверка резерва ${orderLabel}` : `Выдача ${orderLabel}`,
    statusLabel,
    workbench,
    nextOwner: closed ? 'Финансы' : 'Склад',
    severity: excess.length > 0 ? 'warning' : 'info',
    filterTags: ['Выдача', closed ? 'Завершены' : 'Требуют действия', statusLabel],
    facts: [
      { label: 'Заказ', value: orderLabel, scope: 'warehouse' },
      { label: 'Операция', value: operationCode, scope: 'warehouse' },
      { label: 'Счетчик', value: `${processed} / ${plannedRows.length}`, scope: 'warehouse' },
      { label: 'Статус', value: statusLabel, scope: 'warehouse' },
    ],
    sections: [],
    actions: coverageDecisionTask
      ? []
      : [
          closed
            ? {
                id: `warehouse-delivery-closed:${task.id}`,
                label: 'Выдача закрыта',
                level: 'disabled',
                enabled: false,
                disabledReason: 'Задача выдачи уже закрыта',
              }
            : {
                id: `warehouse.delivery.close:${task.id}`,
                label: 'Закрыть выдачу',
                level: closable ? 'recommended' : 'disabled',
                enabled: closable,
                ...(closable
                  ? {}
                  : {
                      disabledReason: 'Не все палеты подтверждены',
                      recoveryOwner: 'Склад',
                      recoveryAction: 'Сканировать QR палетных листов',
                    }),
              },
        ],
    problems: [],
    audit: [
      auditEntry(
        task.id,
        'Система',
        'integration:warehouse_delivery_loaded',
        `Задача выдачи ${operationCode} обновлена.`,
      ),
    ],
  };
}
