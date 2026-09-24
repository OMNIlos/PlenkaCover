import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WAREHOUSE_INVENTORY_LIFECYCLE_LABELS,
  WAREHOUSE_INVENTORY_NEXT_ROUTE_LABELS,
  WAREHOUSE_INVENTORY_PHYSICAL_STATUS_LABELS,
  type WarehouseInventoryLifecycleStatus,
  type WarehouseInventoryNextRoute,
  type WarehouseInventoryOrigin,
  type WarehouseInventoryPhysicalStatus,
  type WarehouseInventoryProvenance,
  type WarehouseInventoryRollDetail,
  type WarehouseInventoryRollItem,
  type WarehouseInventoryRollPage,
  type WarehouseInventorySortDirection,
  type WarehouseInventorySortKey,
  type WarehouseInventorySpecificationDetails,
  type WarehouseInventoryView,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  type CanonicalRollCoverageSpec,
} from '../warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseInventoryQueryDto } from './dto/warehouse-inventory-query.dto';

const DAY_MS = 86_400_000;
const PROCESSED_RETENTION_DAYS = 90;
const CURSOR_TTL_MS = 15 * 60_000;
const LEGACY_COUNTERPARTY_FILTER_LIMIT = 500;
const RESERVE_COUNTERPARTY_NAME = 'Резерв';
const MISSING_SPECIFICATION = 'Нет данных';
const COVERAGE_SPEC_VERSION = 'warehouse-roll-coverage/v1';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const SAFE_LIST_FACT_SELECT = {
  id: true,
  specVersion: true,
  specFingerprint: true,
  spec: true,
  sourceOrderId: true,
  sourcePositionId: true,
  sourceDispatchItem: { select: { orderLineId: true, positionSequence: true } },
} satisfies Prisma.WarehouseRollCoverageFactSelect;

const SAFE_DETAIL_FACT_SELECT = {
  ...SAFE_LIST_FACT_SELECT,
  sourcePosition: {
    select: {
      baseRawMaterialDefinition: { select: { name: true } },
      recipe: { select: { recipeName: true } },
      recipeDefinitionVersion: {
        select: {
          recipeDefinition: { select: { name: true } },
          ingredients: {
            orderBy: { sequence: 'asc' as const },
            select: { rawMaterialDefinition: { select: { name: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.WarehouseRollCoverageFactSelect;

const INVENTORY_LIST_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  ownerCounterpartyId: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  producedForStockOrderId: true,
  producedForPositionId: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedByProposalId: true,
  reservedByCoverageDecisionId: true,
  reservedAt: true,
  receivedAt: true,
  createdAt: true,
  producedForOrder: {
    select: {
      orderNumber: true,
      counterparty: { select: { displayName: true } },
    },
  },
  producedForStockOrder: {
    select: {
      orderNumber: true,
      stockBatchCode: true,
      requestType: true,
    },
  },
  reserveCreationCommand: { select: { id: true } },
  currentCoverageFact: { select: SAFE_LIST_FACT_SELECT },
} satisfies Prisma.WarehouseRollSelect;

const INVENTORY_DETAIL_SELECT = {
  ...INVENTORY_LIST_SELECT,
  currentCoverageFact: { select: SAFE_DETAIL_FACT_SELECT },
} satisfies Prisma.WarehouseRollSelect;

type InventoryRow = Prisma.WarehouseRollGetPayload<{
  select: typeof INVENTORY_LIST_SELECT;
}>;

type InventoryDetailRow = Prisma.WarehouseRollGetPayload<{
  select: typeof INVENTORY_DETAIL_SELECT;
}>;

type InventoryCursor = {
  v: 1;
  fingerprint: string;
  asOf: string;
  sort: WarehouseInventorySortKey;
  direction: WarehouseInventorySortDirection;
  value: string | null;
  id: string;
};

type NormalizedQuery = {
  view: WarehouseInventoryView | null;
  q: string | null;
  batch: string | null;
  minAgeDays: number | null;
  maxAgeDays: number | null;
  status: WarehouseInventoryLifecycleStatus | null;
  counterparty: string | null;
  sort: WarehouseInventorySortKey;
  direction: WarehouseInventorySortDirection;
  limit: number;
};

function normalizeText(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized || null;
}

function normalizeQuery(query: WarehouseInventoryQueryDto): NormalizedQuery {
  return {
    view: query.view ?? null,
    q: normalizeText(query.q),
    batch: normalizeText(query.batch),
    minAgeDays: query.minAgeDays ?? null,
    maxAgeDays: query.maxAgeDays ?? null,
    status: query.status ?? null,
    counterparty: normalizeText(query.counterparty),
    sort: query.sort ?? 'receivedAt',
    direction: query.direction ?? 'desc',
    limit: Math.min(Math.max(query.limit ?? 25, 1), 100),
  };
}

function cursorFingerprint(query: NormalizedQuery): string {
  const normalized = {
    view: query.view,
    q: query.q,
    batch: query.batch,
    minAgeDays: query.minAgeDays,
    maxAgeDays: query.maxAgeDays,
    status: query.status,
    counterparty: query.counterparty,
    sort: query.sort,
    direction: query.direction,
  };
  return requestFingerprint(normalized);
}

function foldText(value: string | null): string | null {
  return value?.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е') ?? null;
}

function clientOriginWhere(): Prisma.WarehouseRollWhereInput {
  return {
    releasedFromOrderId: null,
    OR: [{ producedForOrderId: { not: null } }, { ownerCounterpartyId: { not: null } }],
  };
}

function reserveOriginWhere(): Prisma.WarehouseRollWhereInput {
  return {
    OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
    ownerCounterpartyId: null,
  };
}

function deliveredReservationWhere(): Prisma.WarehouseRollWhereInput {
  return {
    OR: [
      { reservedForOrderId: { not: null } },
      { reservedForPositionId: { not: null } },
      { reservedByProposalId: { not: null } },
      { reservedByCoverageDecisionId: { not: null } },
    ],
  };
}

function lifecycleWhere(
  status: WarehouseInventoryLifecycleStatus,
  cutoff: Date,
): Prisma.WarehouseRollWhereInput {
  if (status === 'defect') {
    return { warehouseStatus: 'defect' };
  }
  if (status === 'in_transit') {
    return {
      AND: [{ OR: [clientOriginWhere(), reserveOriginWhere()] }, { warehouseStatus: 'sent' }],
    };
  }
  if (status === 'awaiting_shipment') {
    return { AND: [clientOriginWhere(), { warehouseStatus: 'received' }] };
  }
  if (status === 'delivered') {
    return { AND: [clientOriginWhere(), { warehouseStatus: 'delivered' }] };
  }
  if (status === 'available') {
    return {
      AND: [
        reserveOriginWhere(),
        { warehouseStatus: 'received' },
        {
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedByCoverageDecisionId: null,
        },
      ],
    };
  }
  if (status === 'reserved') {
    return {
      AND: [reserveOriginWhere(), { warehouseStatus: 'received' }, deliveredReservationWhere()],
    };
  }
  return {
    AND: [
      reserveOriginWhere(),
      { warehouseStatus: 'delivered' },
      { reservedAt: { gte: cutoff } },
      deliveredReservationWhere(),
    ],
  };
}

function allLifecycleWhere(cutoff: Date): Prisma.WarehouseRollWhereInput {
  return {
    OR: (
      [
        'awaiting_shipment',
        'available',
        'reserved',
        'defect',
        'in_transit',
        'delivered',
        'processed',
      ] as const
    ).map((status) => lifecycleWhere(status, cutoff)),
  };
}

function inventoryViewWhere(
  view: WarehouseInventoryView,
  cutoff: Date,
): Prisma.WarehouseRollWhereInput {
  if (view === 'processed') return lifecycleWhere('processed', cutoff);
  return {
    OR: (
      ['awaiting_shipment', 'available', 'reserved', 'defect', 'delivered', 'processed'] as const
    ).map((status) => lifecycleWhere(status, cutoff)),
  };
}

function orderBy(
  sort: WarehouseInventorySortKey,
  direction: WarehouseInventorySortDirection,
): Prisma.WarehouseRollOrderByWithRelationInput[] {
  return sort === 'receivedAt'
    ? [{ receivedAt: { sort: direction, nulls: 'last' } }, { id: direction }]
    : [{ rollCode: direction }, { id: direction }];
}

function cursorWhere(cursor: InventoryCursor): Prisma.WarehouseRollWhereInput {
  const comparison = cursor.direction === 'asc' ? 'gt' : 'lt';
  if (cursor.sort === 'rollCode') {
    const value = cursor.value;
    if (value === null) throw new BadRequestException('Некорректный курсор склада.');
    return {
      OR: [
        { rollCode: { [comparison]: value } },
        { rollCode: value, id: { [comparison]: cursor.id } },
      ],
    };
  }
  if (cursor.value === null) {
    return { receivedAt: null, id: { [comparison]: cursor.id } };
  }
  const value = new Date(cursor.value);
  return {
    OR: [
      { receivedAt: { [comparison]: value } },
      { receivedAt: value, id: { [comparison]: cursor.id } },
      { receivedAt: null },
    ],
  };
}

function encodeCursor(
  row: InventoryRow,
  query: NormalizedQuery,
  fingerprint: string,
  asOf: Date,
): string {
  const cursor: InventoryCursor = {
    v: 1,
    fingerprint,
    asOf: asOf.toISOString(),
    sort: query.sort,
    direction: query.direction,
    value: query.sort === 'receivedAt' ? (row.receivedAt?.toISOString() ?? null) : row.rollCode,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(
  value: string,
  query: NormalizedQuery,
  fingerprint: string,
  now: Date,
): InventoryCursor {
  try {
    if (value.length === 0 || value.length > 1_000 || !BASE64URL_PATTERN.test(value)) {
      throw new Error('invalid cursor encoding');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) {
      throw new Error('non-canonical cursor encoding');
    }
    const source = decoded.toString('utf8');
    const parsed = JSON.parse(source) as Partial<InventoryCursor>;
    const exactKeys = Object.keys(parsed).sort().join(',');
    if (
      exactKeys !== 'asOf,direction,fingerprint,id,sort,v,value' ||
      parsed.v !== 1 ||
      parsed.fingerprint !== fingerprint ||
      parsed.sort !== query.sort ||
      parsed.direction !== query.direction ||
      typeof parsed.asOf !== 'string' ||
      Number.isNaN(Date.parse(parsed.asOf)) ||
      new Date(parsed.asOf).toISOString() !== parsed.asOf ||
      typeof parsed.id !== 'string' ||
      parsed.id.length < 1 ||
      !/^[a-f0-9]{64}$/u.test(parsed.fingerprint)
    ) {
      throw new Error('cursor does not match this query');
    }
    const asOf = new Date(parsed.asOf);
    if (asOf > now || now.getTime() - asOf.getTime() > CURSOR_TTL_MS) {
      throw new Error('cursor snapshot is outside its lifetime');
    }
    if (query.sort === 'rollCode') {
      if (typeof parsed.value !== 'string' || parsed.value.length < 1) {
        throw new Error('invalid roll code cursor');
      }
    } else if (parsed.value !== null) {
      if (
        typeof parsed.value !== 'string' ||
        Number.isNaN(Date.parse(parsed.value)) ||
        new Date(parsed.value).toISOString() !== parsed.value
      ) {
        throw new Error('invalid received timestamp cursor');
      }
    }
    return parsed as InventoryCursor;
  } catch {
    throw new BadRequestException('Некорректный курсор склада.');
  }
}

function rowOrigin(row: InventoryRow | InventoryDetailRow): WarehouseInventoryOrigin | null {
  if (row.releasedFromOrderId) return 'reserve';
  if (row.producedForOrderId || row.ownerCounterpartyId) return 'client';
  return 'reserve';
}

function hasReservation(row: InventoryRow | InventoryDetailRow): boolean {
  return Boolean(
    row.reservedForOrderId ||
    row.reservedForPositionId ||
    row.reservedByProposalId ||
    row.reservedByCoverageDecisionId,
  );
}

function rowLifecycle(
  row: InventoryRow | InventoryDetailRow,
): WarehouseInventoryLifecycleStatus | null {
  const origin = rowOrigin(row);
  if (!origin) return null;
  if (row.warehouseStatus === 'defect') {
    return 'defect';
  }
  if (row.warehouseStatus === 'sent') {
    return 'in_transit';
  }
  if (origin === 'client') {
    if (row.warehouseStatus === 'received') return 'awaiting_shipment';
    return row.warehouseStatus === 'delivered' ? 'delivered' : null;
  }
  if (row.reservedAt && hasReservation(row) && row.warehouseStatus === 'delivered') {
    return 'processed';
  }
  if (row.warehouseStatus !== 'received') return null;
  if (hasReservation(row)) return 'reserved';
  // Incomplete legacy reservation timestamps must not hide a physically received roll.
  return 'available';
}

function visibleAt(
  row: InventoryRow | InventoryDetailRow,
  now: Date,
): WarehouseInventoryLifecycleStatus | null {
  const lifecycle = rowLifecycle(row);
  if (lifecycle !== 'processed') return lifecycle;
  const cutoff = new Date(now.getTime() - PROCESSED_RETENTION_DAYS * DAY_MS);
  return row.reservedAt && row.reservedAt >= cutoff ? lifecycle : null;
}

function visibleInView(
  lifecycle: WarehouseInventoryLifecycleStatus,
  view: WarehouseInventoryView | null,
): boolean {
  if (view === 'processed') return lifecycle === 'processed';
  if (view === 'current') {
    return [
      'awaiting_shipment',
      'available',
      'reserved',
      'defect',
      'delivered',
      'processed',
    ].includes(lifecycle);
  }
  return true;
}

function physicalStatus(row: InventoryRow | InventoryDetailRow): WarehouseInventoryPhysicalStatus {
  if (
    row.warehouseStatus === 'sent' ||
    row.warehouseStatus === 'defect' ||
    row.warehouseStatus === 'delivered'
  ) {
    return row.warehouseStatus;
  }
  return 'received';
}

function nextRouteFor(
  row: InventoryRow | InventoryDetailRow,
  origin: WarehouseInventoryOrigin,
): WarehouseInventoryNextRoute {
  if (row.warehouseStatus === 'sent') return 'receiving';
  if (row.warehouseStatus === 'defect') return 'defect_resolution';
  if (row.warehouseStatus === 'delivered') return 'completed';
  if (origin === 'client' || hasReservation(row)) return 'delivery';
  return 'reserve';
}

function canonicalSpec(row: InventoryRow | InventoryDetailRow): CanonicalRollCoverageSpec | null {
  const fact = row.currentCoverageFact;
  if (!fact || fact.specVersion !== COVERAGE_SPEC_VERSION) return null;
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    const sourceOrderId = row.producedForOrderId ?? row.producedForStockOrderId;
    if (
      fingerprintRollFact(spec) !== fact.specFingerprint ||
      spec.rollCode !== row.rollCode ||
      spec.ownerCounterpartyId !== row.ownerCounterpartyId ||
      fact.sourceOrderId !== spec.sourceOrderId ||
      fact.sourcePositionId !== spec.sourcePositionId ||
      (sourceOrderId !== null && sourceOrderId !== spec.sourceOrderId)
    ) {
      return null;
    }
    return spec;
  } catch {
    return null;
  }
}

function stableLabels(values: readonly (string | null | undefined)[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const display = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    const key = foldText(display);
    if (!display || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }
  return result;
}

function recipeProjection(
  row: InventoryDetailRow,
  spec: CanonicalRollCoverageSpec | null,
): { recipeName: string | null; ingredients: string[] } {
  if (!spec) return { recipeName: null, ingredients: [] };
  const position = row.currentCoverageFact?.sourcePosition;
  const recipeName =
    normalizeText(position?.recipeDefinitionVersion?.recipeDefinition.name) ??
    normalizeText(position?.recipe?.recipeName ?? undefined) ??
    normalizeText(position?.baseRawMaterialDefinition?.name);
  const catalog =
    position?.recipeDefinitionVersion?.ingredients.map(
      ({ rawMaterialDefinition }) => rawMaterialDefinition.name,
    ) ?? [];
  return {
    recipeName,
    ingredients: stableLabels([...catalog, position?.baseRawMaterialDefinition?.name]),
  };
}

type SpecificationCore = Omit<WarehouseInventorySpecificationDetails, 'recipeName' | 'ingredients'>;

function specificationCore(spec: CanonicalRollCoverageSpec | null): SpecificationCore {
  if (!spec) {
    return {
      filmType: null,
      actualThicknessMicron: null,
      accountingThicknessMicron: null,
      widthMm: null,
      plannedLengthM: null,
      netKg: null,
      spoolType: null,
      birka: null,
    };
  }
  return {
    filmType: spec.filmType,
    actualThicknessMicron: spec.actualThicknessMilliMicron / 1_000,
    accountingThicknessMicron: spec.accountingThicknessMilliMicron / 1_000,
    widthMm: spec.widthMilliMm / 1_000,
    plannedLengthM: spec.plannedLengthMilliM / 1_000,
    netKg: spec.actualWeightMilliKg / 1_000,
    spoolType: spec.spoolType,
    birka: spec.birka,
  };
}

function detailsFor(row: InventoryDetailRow): WarehouseInventorySpecificationDetails {
  const spec = canonicalSpec(row);
  const recipe = recipeProjection(row, spec);
  return {
    ...specificationCore(spec),
    recipeName: recipe.recipeName,
    ingredients: recipe.ingredients,
  };
}

function specificationFor(details: SpecificationCore): string {
  if (details.filmType === null) return MISSING_SPECIFICATION;
  return stableLabels([
    details.filmType,
    details.actualThicknessMicron === null ? null : `факт ${details.actualThicknessMicron} мкм`,
    details.accountingThicknessMicron === null
      ? null
      : `учёт ${details.accountingThicknessMicron} мкм`,
    details.widthMm === null ? null : `ширина ${details.widthMm} мм`,
    details.plannedLengthM === null ? null : `метраж ${details.plannedLengthM} м`,
    details.netKg === null ? null : `вес ${details.netKg} кг`,
    details.spoolType === null ? null : `шпуля ${details.spoolType}`,
    details.birka === null ? null : `бирка ${details.birka}`,
  ]).join(' · ');
}

function provenanceFor(row: InventoryRow | InventoryDetailRow): WarehouseInventoryProvenance {
  if (rowOrigin(row) === 'client') {
    return {
      kind: 'client_order',
      orderNumber: row.producedForOrder?.orderNumber ?? null,
      batchCode: null,
    };
  }
  return {
    kind: row.reserveCreationCommand || !row.producedForStockOrderId ? 'manual' : 'stock_reserve',
    orderNumber: row.producedForStockOrder?.orderNumber ?? null,
    batchCode: row.producedForStockOrder?.stockBatchCode ?? null,
  };
}

@Injectable()
export class WarehouseInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: WarehouseInventoryQueryDto,
    now = new Date(),
  ): Promise<WarehouseInventoryRollPage> {
    const normalized = normalizeQuery(query);
    if (
      normalized.minAgeDays !== null &&
      normalized.maxAgeDays !== null &&
      normalized.minAgeDays > normalized.maxAgeDays
    ) {
      throw new BadRequestException('Минимальный возраст не может быть больше максимального.');
    }
    const fingerprint = cursorFingerprint(normalized);
    const cursor = query.cursor ? decodeCursor(query.cursor, normalized, fingerprint, now) : null;
    const asOf = cursor ? new Date(cursor.asOf) : now;
    const cutoff = new Date(now.getTime() - PROCESSED_RETENTION_DAYS * DAY_MS);
    const where = await this.buildWhere(normalized, cutoff, asOf);
    const rows = await this.prisma.warehouseRoll.findMany({
      where: cursor ? { AND: [where, cursorWhere(cursor)] } : where,
      select: INVENTORY_LIST_SELECT,
      orderBy: orderBy(normalized.sort, normalized.direction),
      take: normalized.limit + 1,
    });
    const visibleRows = rows.filter((row) => {
      const lifecycle = visibleAt(row, now);
      return (
        row.createdAt <= asOf && lifecycle !== null && visibleInView(lifecycle, normalized.view)
      );
    });
    const pageRows = visibleRows.slice(0, normalized.limit);
    const hydratedRows = visibleRows.slice(0, normalized.limit + 1);
    const [names, reservedOrders] = await Promise.all([
      this.legacyCounterpartyNames(hydratedRows),
      this.reservedOrderNumbers(hydratedRows),
    ]);
    const items = pageRows.map((row) => this.projectItem(row, names, reservedOrders, now));
    const hasNext = visibleRows.length > normalized.limit;
    const boundary = pageRows.at(-1);
    const nextCursor =
      hasNext && boundary ? encodeCursor(boundary, normalized, fingerprint, asOf) : null;
    if (
      cursor &&
      nextCursor &&
      cursor.id === boundary?.id &&
      cursor.value ===
        (normalized.sort === 'receivedAt'
          ? (boundary.receivedAt?.toISOString() ?? null)
          : boundary.rollCode)
    ) {
      throw new BadRequestException('Курсор склада образует повторяющуюся страницу.');
    }
    return { items, nextCursor };
  }

  async get(rollId: string): Promise<WarehouseInventoryRollDetail> {
    const row = await this.prisma.warehouseRoll.findUnique({
      where: { id: rollId },
      select: INVENTORY_DETAIL_SELECT,
    });
    const now = new Date();
    if (!row || visibleAt(row, now) === null) {
      throw new NotFoundException(`Warehouse inventory roll ${rollId} not found`);
    }
    const [names, reservedOrders] = await Promise.all([
      this.legacyCounterpartyNames([row]),
      this.reservedOrderNumbers([row]),
    ]);
    return {
      ...this.projectItem(row, names, reservedOrders, now),
      specificationDetails: detailsFor(row),
      provenance: provenanceFor(row),
    };
  }

  private async buildWhere(
    query: NormalizedQuery,
    cutoff: Date,
    asOf: Date,
  ): Promise<Prisma.WarehouseRollWhereInput> {
    const clauses: Prisma.WarehouseRollWhereInput[] = [
      query.view
        ? inventoryViewWhere(query.view, cutoff)
        : query.status
          ? lifecycleWhere(query.status, cutoff)
          : allLifecycleWhere(cutoff),
      { createdAt: { lte: asOf } },
    ];
    if (query.view && query.status) clauses.push(lifecycleWhere(query.status, cutoff));
    if (query.q) {
      const legacyCounterpartyIds = await this.boundedCounterpartyIds(query.q);
      const foldedQuery = foldText(query.q) ?? query.q;
      clauses.push({
        OR: [
          { rollCode: { contains: query.q, mode: 'insensitive' } },
          {
            producedForOrder: {
              is: {
                OR: [
                  { orderNumber: { contains: query.q, mode: 'insensitive' } },
                  {
                    counterparty: {
                      is: {
                        displayName: {
                          contains: query.q,
                          mode: 'insensitive',
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          { ownerCounterpartyId: { in: legacyCounterpartyIds } },
          {
            producedForStockOrder: {
              is: {
                OR: [
                  { orderNumber: { contains: query.q, mode: 'insensitive' } },
                  { stockBatchCode: { contains: query.q, mode: 'insensitive' } },
                ],
              },
            },
          },
          {
            currentCoverageFact: {
              is: { spec: { path: ['filmType'], string_contains: foldedQuery } },
            },
          },
          {
            currentCoverageFact: {
              is: {
                sourcePosition: {
                  is: {
                    recipe: {
                      is: { recipeName: { contains: query.q, mode: 'insensitive' } },
                    },
                  },
                },
              },
            },
          },
          {
            currentCoverageFact: {
              is: {
                sourcePosition: {
                  is: {
                    recipeDefinitionVersion: {
                      is: {
                        recipeDefinition: {
                          is: { name: { contains: query.q, mode: 'insensitive' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      });
    }
    if (query.batch) {
      clauses.push({
        producedForStockOrder: {
          is: { stockBatchCode: { contains: query.batch, mode: 'insensitive' } },
        },
      });
    }
    if (query.minAgeDays !== null || query.maxAgeDays !== null) {
      const receivedAt: Prisma.DateTimeNullableFilter = { not: null, lte: asOf };
      if (query.minAgeDays !== null) {
        receivedAt.lte = new Date(asOf.getTime() - query.minAgeDays * DAY_MS);
      }
      if (query.maxAgeDays !== null) {
        receivedAt.gt = new Date(asOf.getTime() - (query.maxAgeDays + 1) * DAY_MS);
      }
      clauses.push({ receivedAt });
    }
    if (query.counterparty) {
      const legacyCounterpartyIds = await this.boundedCounterpartyIds(query.counterparty);
      const matchesReserve = foldText(RESERVE_COUNTERPARTY_NAME)?.includes(
        foldText(query.counterparty) ?? '',
      );
      clauses.push({
        OR: [
          {
            producedForOrder: {
              is: {
                counterparty: {
                  is: {
                    displayName: {
                      contains: query.counterparty,
                      mode: 'insensitive',
                    },
                  },
                },
              },
            },
          },
          { ownerCounterpartyId: { in: legacyCounterpartyIds } },
          ...(matchesReserve ? [reserveOriginWhere()] : []),
        ],
      });
    }
    return { AND: clauses };
  }

  private async boundedCounterpartyIds(term: string): Promise<string[]> {
    const counterparties = await this.prisma.counterparty.findMany({
      where: { displayName: { contains: term, mode: 'insensitive' } },
      select: { id: true },
      take: LEGACY_COUNTERPARTY_FILTER_LIMIT + 1,
    });
    if (counterparties.length > LEGACY_COUNTERPARTY_FILTER_LIMIT) {
      throw new BadRequestException('Фильтр контрагента слишком широкий. Уточните название.');
    }
    return counterparties.map(({ id }) => id);
  }

  private async legacyCounterpartyNames(
    rows: readonly (InventoryRow | InventoryDetailRow)[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row.producedForOrder?.counterparty?.displayName || !row.ownerCounterpartyId
            ? []
            : [row.ownerCounterpartyId],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const counterparties = await this.prisma.counterparty.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
      take: ids.length,
    });
    return new Map(counterparties.map(({ id, displayName }) => [id, displayName]));
  }

  private async reservedOrderNumbers(
    rows: readonly (InventoryRow | InventoryDetailRow)[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          (!row.producedForOrderId || row.releasedFromOrderId) && row.reservedForOrderId
            ? [row.reservedForOrderId]
            : [],
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const orders = await this.prisma.commercialOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, orderNumber: true },
      take: ids.length,
    });
    return new Map(orders.map(({ id, orderNumber }) => [id, orderNumber]));
  }

  private projectItem(
    row: InventoryRow | InventoryDetailRow,
    names: ReadonlyMap<string, string>,
    reservedOrders: ReadonlyMap<string, string>,
    now: Date,
  ): WarehouseInventoryRollItem {
    const origin = rowOrigin(row);
    const lifecycleStatus = visibleAt(row, now);
    if (!origin || !lifecycleStatus) {
      throw new Error(`Warehouse roll ${row.id} does not belong to the inventory projection`);
    }
    const details = specificationCore(canonicalSpec(row));
    const status = physicalStatus(row);
    const nextRoute = nextRouteFor(row, origin);
    const dispatch = row.currentCoverageFact?.sourceDispatchItem ?? null;
    const positionId =
      row.producedForPositionId ??
      row.reservedForPositionId ??
      row.currentCoverageFact?.sourcePositionId ??
      null;
    const storedPositionSequence =
      positionId && dispatch?.orderLineId === positionId ? dispatch.positionSequence : null;
    const positionSequence =
      storedPositionSequence !== null && storedPositionSequence > 0 ? storedPositionSequence : null;
    const counterpartyName =
      origin === 'reserve'
        ? RESERVE_COUNTERPARTY_NAME
        : (normalizeText(
            row.producedForOrder?.counterparty?.displayName ??
              (row.ownerCounterpartyId ? names.get(row.ownerCounterpartyId) : undefined),
          ) ?? 'Нет данных');
    return {
      id: row.id,
      rollCode: row.rollCode,
      origin,
      lifecycleStatus,
      lifecycleStatusLabel: WAREHOUSE_INVENTORY_LIFECYCLE_LABELS[lifecycleStatus],
      orderNumber:
        (row.releasedFromOrderId ? null : row.producedForOrder?.orderNumber) ??
        (row.reservedForOrderId ? (reservedOrders.get(row.reservedForOrderId) ?? null) : null),
      positionId,
      positionSequence,
      warehouseStatus: status,
      warehouseStatusLabel: WAREHOUSE_INVENTORY_PHYSICAL_STATUS_LABELS[status],
      nextRoute,
      nextRouteLabel: WAREHOUSE_INVENTORY_NEXT_ROUTE_LABELS[nextRoute],
      counterpartyName,
      batchCode: row.producedForStockOrder?.stockBatchCode ?? null,
      weightKg: details.netKg,
      specification: specificationFor(details),
      receivedAt: row.receivedAt?.toISOString() ?? null,
      processedAt: lifecycleStatus === 'processed' ? (row.reservedAt?.toISOString() ?? null) : null,
    };
  }
}
