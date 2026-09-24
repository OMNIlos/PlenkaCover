import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  SafeInventoryConflict,
  SafeInventoryItem,
  SafeInventoryPage,
  SafeInventorySourceStatus,
} from '@plenka/contracts';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DERIVED_FILTER_SCAN_BATCH_SIZE = MAX_LIMIT + 1;
const MAX_DERIVED_FILTER_SCAN_BATCHES = 10;
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const RAW_MATERIAL_ACCOUNT_CODE = '10.01';

export type InventoryProjectionQuery = {
  q?: string;
  category?: string;
  sourceStatus?: SafeInventorySourceStatus;
  availability?: 'available' | 'unavailable';
  cursor?: string;
  limit?: number;
};

type InventoryCursor = {
  normalizedName: string;
  definitionId: string;
};

type InventoryDefinitionRow = {
  id: string;
  name: string;
  kind: string;
  normalizedName: string;
  externalId: string | null;
  sourceUnit: string | null;
  stock: {
    materialId: string;
    actualQty: number;
    unit: string;
    updatedAt: Date;
    externalId: string | null;
  } | null;
};

type InventorySnapshotRow = {
  id: string;
  externalId: string | null;
  sourceKind: string;
  capturedAt: Date | null;
  importedAt: Date | null;
  checkedAt: Date | null;
  staleness: string | null;
  parsed: unknown;
};

type InventoryAccountingBalanceRow = {
  id: string;
  nomenclatureExternalId: string;
  quantity: unknown;
  capturedAt: Date;
  syncedAt: Date;
};

type InventoryAccountingBalance = {
  id: string;
  quantity: number;
  capturedAt: Date;
  syncedAt: Date;
};

type InventoryBigBagAggregateRow = {
  materialId: string | null;
  _sum: {
    currentKg: number | null;
  };
};

export function classifyInventorySourceStatus(input: {
  sourceUnavailable: boolean;
  hasMatchedSnapshot: boolean;
  parsedQuantityAvailable: boolean;
  stale: boolean;
  mismatch: boolean;
  deductionsComplete: boolean;
}): SafeInventorySourceStatus {
  if (input.sourceUnavailable) return 'unavailable';
  if (!input.hasMatchedSnapshot) return 'erp_only';
  if (input.mismatch) return 'conflict';
  if (input.stale) return 'stale';
  if (!input.parsedQuantityAvailable || !input.deductionsComplete) return 'partial';
  return 'fresh';
}

function encodeCursor(cursor: InventoryCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value?: string): InventoryCursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<InventoryCursor>;
    if (
      typeof cursor.normalizedName !== 'string' ||
      cursor.normalizedName.length === 0 ||
      typeof cursor.definitionId !== 'string' ||
      cursor.definitionId.length === 0
    ) {
      throw new Error('invalid');
    }
    return {
      normalizedName: cursor.normalizedName,
      definitionId: cursor.definitionId,
    };
  } catch {
    throw new BadRequestException('Invalid inventory cursor');
  }
}

function parseSnapshotQuantity(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const qty = (parsed as Record<string, unknown>).qty;
  return typeof qty === 'number' && Number.isFinite(qty) ? qty : null;
}

function materialCategory(kind: string, materialId: string): string {
  if (materialId.startsWith('rm-secondary-')) return 'secondary';
  return kind;
}

function roundQuantity(value: number) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isStale(
  snapshot: {
    staleness: string | null;
    checkedAt: Date | null;
    importedAt: Date | null;
    capturedAt: Date | null;
  },
  now: Date,
) {
  if (snapshot.staleness === 'stale') return true;
  const lastCheckedAt = snapshot.checkedAt ?? snapshot.importedAt ?? snapshot.capturedAt;
  if (!lastCheckedAt) return true;
  const configured = Number(process.env.RAW_MATERIAL_STALE_AFTER_MS);
  const staleAfterMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_AFTER_MS;
  return now.getTime() - lastCheckedAt.getTime() > staleAfterMs;
}

@Injectable()
export class InventoryProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: InventoryProjectionQuery, now = new Date()): Promise<SafeInventoryPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const initialCursor = decodeCursor(query.cursor);
    const search = query.q?.trim();
    const basePredicates: Array<Record<string, unknown>> = [];
    if (search) {
      basePredicates.push({
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          {
            stock: {
              is: { materialId: { contains: search, mode: 'insensitive' } },
            },
          },
        ],
      });
    }
    const [latestStockSnapshot, latestStockImport] = await Promise.all([
      this.prisma.sourceSnapshot.findFirst({
        where: { subjectType: 'stock' },
        select: {
          id: true,
          capturedAt: true,
          importedAt: true,
          checkedAt: true,
          staleness: true,
        },
        orderBy: [{ importedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.domainEvent.findFirst({
        where: {
          type: { in: ['integration.onec_imported', 'integration.onec_import_failed'] },
          label: 'onec_import_stock',
        },
        select: { type: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const lastSuccessfulSourceAt =
      latestStockSnapshot?.importedAt ?? latestStockSnapshot?.capturedAt ?? null;
    const sourceUnavailable =
      !latestStockSnapshot ||
      Boolean(
        latestStockImport?.type === 'integration.onec_import_failed' &&
        (!lastSuccessfulSourceAt ||
          latestStockImport.createdAt.getTime() >= lastSuccessfulSourceAt.getTime()),
      );
    const hasDerivedFilter = Boolean(query.sourceStatus || query.availability);
    const scanBatchSize = hasDerivedFilter ? DERIVED_FILTER_SCAN_BATCH_SIZE : limit;
    const maxScanBatches = hasDerivedFilter ? MAX_DERIVED_FILTER_SCAN_BATCHES : 1;
    const items: SafeInventoryItem[] = [];
    let scanCursor = initialCursor;
    let lastScannedCursor: InventoryCursor | null = null;
    let exhausted = false;

    for (let batchIndex = 0; batchIndex < maxScanBatches; batchIndex += 1) {
      const cursorPredicate = scanCursor
        ? {
            OR: [
              { normalizedName: { gt: scanCursor.normalizedName } },
              {
                normalizedName: scanCursor.normalizedName,
                id: { gt: scanCursor.definitionId },
              },
            ],
          }
        : null;
      const inventoryScopePredicate = {
        OR: [
          { stock: { isNot: null } },
          {
            oneCNomenclatureItem: {
              is: {
                stockBalances: {
                  some: { accountCode: RAW_MATERIAL_ACCOUNT_CODE },
                },
              },
            },
          },
        ],
      };
      const predicates = [
        inventoryScopePredicate,
        ...basePredicates,
        ...(cursorPredicate ? [cursorPredicate] : []),
      ];
      const fetchedDefinitions = (await this.prisma.rawMaterialDefinition.findMany({
        where: {
          status: 'active',
          ...(query.category && query.category !== 'secondary'
            ? { kind: query.category }
            : query.category === 'secondary'
              ? {
                  OR: [
                    { kind: 'secondary' },
                    { stock: { is: { materialId: { startsWith: 'rm-secondary-' } } } },
                  ],
                }
              : {}),
          AND: predicates,
        },
        select: {
          id: true,
          name: true,
          kind: true,
          normalizedName: true,
          externalId: true,
          sourceUnit: true,
          stock: {
            select: {
              materialId: true,
              actualQty: true,
              unit: true,
              updatedAt: true,
              externalId: true,
            },
          },
        },
        orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
        take: scanBatchSize + 1,
      })) as InventoryDefinitionRow[];
      if (fetchedDefinitions.length === 0) {
        exhausted = true;
        break;
      }
      const definitions = fetchedDefinitions.slice(0, scanBatchSize);
      const hasLookahead = fetchedDefinitions.length > scanBatchSize;

      const projectedItems = await this.projectDefinitions(definitions, sourceUnavailable, now);
      for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
        const definition = definitions[definitionIndex];
        const item = projectedItems[definitionIndex];
        lastScannedCursor = {
          normalizedName: definition.normalizedName,
          definitionId: definition.id,
        };
        if (!item || !this.matchesDerivedFilters(item, query)) continue;

        items.push(item);
        if (items.length === limit) {
          const hasUnprocessedDefinition = definitionIndex < definitions.length - 1;
          return {
            items,
            nextCursor:
              hasUnprocessedDefinition || hasLookahead ? encodeCursor(lastScannedCursor) : null,
            sourceUnavailable,
            generatedAt: now.toISOString(),
          };
        }
      }

      const lastDefinition = definitions.at(-1);
      if (!lastDefinition) {
        exhausted = true;
        break;
      }
      scanCursor = {
        normalizedName: lastDefinition.normalizedName,
        definitionId: lastDefinition.id,
      };
      lastScannedCursor = scanCursor;
      if (!hasLookahead) {
        exhausted = true;
        break;
      }
    }

    return {
      items,
      nextCursor: !exhausted && lastScannedCursor ? encodeCursor(lastScannedCursor) : null,
      sourceUnavailable,
      generatedAt: now.toISOString(),
    };
  }

  private async projectDefinitions(
    definitions: InventoryDefinitionRow[],
    sourceUnavailable: boolean,
    now: Date,
  ): Promise<Array<SafeInventoryItem | null>> {
    const materialIds = [
      ...new Set(definitions.flatMap(({ stock }) => (stock ? [stock.materialId] : []))),
    ];
    const externalIds = [
      ...new Set(definitions.flatMap(({ stock }) => (stock?.externalId ? [stock.externalId] : []))),
    ];
    const nomenclatureExternalIds = [
      ...new Set(definitions.flatMap(({ externalId }) => (externalId ? [externalId] : []))),
    ];
    const [accountingBalancesResult, snapshotsResult, bagAggregatesResult] = await Promise.all([
      nomenclatureExternalIds.length === 0
        ? Promise.resolve([] as InventoryAccountingBalanceRow[])
        : this.prisma.oneCStockBalance.findMany({
            where: {
              accountCode: RAW_MATERIAL_ACCOUNT_CODE,
              nomenclatureExternalId: { in: nomenclatureExternalIds },
            },
            select: {
              id: true,
              nomenclatureExternalId: true,
              quantity: true,
              capturedAt: true,
              syncedAt: true,
            },
          }),
      externalIds.length === 0
        ? Promise.resolve([] as InventorySnapshotRow[])
        : this.prisma.$queryRaw<InventorySnapshotRow[]>(Prisma.sql`
            WITH requested ("externalId") AS (
              VALUES ${Prisma.join(
                externalIds.map((externalId) => Prisma.sql`(CAST(${externalId} AS TEXT))`),
              )}
            )
            SELECT latest."id",
                   latest."externalId",
                   latest."sourceKind",
                   latest."capturedAt",
                   latest."importedAt",
                   latest."checkedAt",
                   latest."staleness",
                   latest."parsed"
            FROM requested
            CROSS JOIN LATERAL (
              SELECT snapshot."id",
                     snapshot."externalId",
                     snapshot."sourceKind",
                     snapshot."capturedAt",
                     snapshot."importedAt",
                     snapshot."checkedAt",
                     snapshot."staleness",
                     snapshot."parsed"
              FROM "source_snapshots" AS snapshot
              WHERE snapshot."subjectType" = 'stock'
                AND snapshot."externalId" = requested."externalId"
              ORDER BY snapshot."importedAt" DESC NULLS LAST,
                       snapshot."createdAt" DESC,
                       snapshot."id" DESC
              LIMIT 1
            ) AS latest
            ORDER BY requested."externalId" ASC
          `),
      materialIds.length === 0
        ? Promise.resolve([] as InventoryBigBagAggregateRow[])
        : this.prisma.bigBagUnit.groupBy({
            by: ['materialId'],
            where: {
              materialId: { in: materialIds },
              status: { in: ['available', 'in_use'] },
            },
            _sum: { currentKg: true },
          }),
    ]);
    const accountingBalances = accountingBalancesResult as InventoryAccountingBalanceRow[];
    const snapshots = snapshotsResult as InventorySnapshotRow[];
    const bagAggregates = bagAggregatesResult as InventoryBigBagAggregateRow[];
    const accountingByNomenclatureId = new Map<string, InventoryAccountingBalance>();
    for (const balance of accountingBalances) {
      const quantity = Number(balance.quantity);
      if (!Number.isFinite(quantity)) continue;
      const current = accountingByNomenclatureId.get(balance.nomenclatureExternalId);
      if (!current) {
        accountingByNomenclatureId.set(balance.nomenclatureExternalId, {
          id: balance.id,
          quantity,
          capturedAt: balance.capturedAt,
          syncedAt: balance.syncedAt,
        });
        continue;
      }
      const latest = balance.syncedAt.getTime() > current.syncedAt.getTime() ? balance : current;
      accountingByNomenclatureId.set(balance.nomenclatureExternalId, {
        id: latest.id,
        quantity: current.quantity + quantity,
        capturedAt:
          balance.capturedAt.getTime() > current.capturedAt.getTime()
            ? balance.capturedAt
            : current.capturedAt,
        syncedAt:
          balance.syncedAt.getTime() > current.syncedAt.getTime()
            ? balance.syncedAt
            : current.syncedAt,
      });
    }
    const snapshotByExternalId = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (snapshot.externalId && !snapshotByExternalId.has(snapshot.externalId)) {
        snapshotByExternalId.set(snapshot.externalId, snapshot);
      }
    }
    const openBagByMaterialId = new Map<string, number>();
    for (const aggregate of bagAggregates) {
      if (!aggregate.materialId || aggregate._sum.currentKg == null) continue;
      openBagByMaterialId.set(aggregate.materialId, roundQuantity(aggregate._sum.currentKg));
    }

    return definitions.map((definition): SafeInventoryItem | null => {
      const stock = definition.stock;
      const accounting = definition.externalId
        ? (accountingByNomenclatureId.get(definition.externalId) ?? null)
        : null;
      if (!stock && !accounting) return null;
      const legacySnapshot = stock?.externalId
        ? (snapshotByExternalId.get(stock.externalId) ?? null)
        : null;
      const source = accounting
        ? {
            id: accounting.id,
            sourceKind: '1C',
            capturedAt: accounting.capturedAt,
            importedAt: accounting.syncedAt,
            checkedAt: accounting.syncedAt,
            staleness: null,
          }
        : legacySnapshot;
      const oneCQty =
        accounting?.quantity ??
        (legacySnapshot ? parseSnapshotQuantity(legacySnapshot.parsed) : null);
      const conflicts: SafeInventoryConflict[] = [];
      if (stock && oneCQty !== null && roundQuantity(oneCQty) !== roundQuantity(stock.actualQty)) {
        conflicts.push({
          code: 'ERP_ONEC_QTY_MISMATCH',
          message: 'Факт платформы отличается от учетного снимка 1С.',
        });
      }
      conflicts.push({
        code: 'INCOMPLETE_DEDUCTIONS',
        message: 'Резерв и ожидаемый расход не подтверждены durable-фактами.',
      });
      const stale = source ? isStale(source, now) : false;
      const mismatch = conflicts.some(({ code }) => code === 'ERP_ONEC_QTY_MISMATCH');
      const sourceStatus = classifyInventorySourceStatus({
        sourceUnavailable,
        hasMatchedSnapshot: source !== null,
        parsedQuantityAvailable: oneCQty !== null,
        stale,
        mismatch,
        deductionsComplete: false,
      });
      const materialId = stock?.materialId ?? definition.id;
      const category = materialCategory(definition.kind, materialId);
      return {
        materialId,
        materialName: definition.name,
        category,
        unit: stock?.unit ?? definition.sourceUnit ?? null,
        erpActualQty: stock ? roundQuantity(stock.actualQty) : null,
        oneCQty: oneCQty === null ? null : roundQuantity(oneCQty),
        reservedQty: null,
        availableQty: null,
        expectedUsageQty: null,
        openBigBagQty: stock ? (openBagByMaterialId.get(stock.materialId) ?? 0) : 0,
        recycledQty: category === 'secondary' && stock ? roundQuantity(stock.actualQty) : null,
        sourceStatus,
        source: source
          ? {
              snapshotId: source.id,
              sourceKind: source.sourceKind,
              capturedAt: source.capturedAt?.toISOString() ?? null,
              importedAt: source.importedAt?.toISOString() ?? null,
            }
          : null,
        conflicts: [
          ...(stale
            ? [
                {
                  code: 'ONEC_SOURCE_STALE',
                  message: 'Учетный снимок 1С устарел.',
                },
              ]
            : []),
          ...conflicts,
        ],
        updatedAt: stock?.updatedAt.toISOString() ?? null,
      };
    });
  }

  private matchesDerivedFilters(item: SafeInventoryItem, query: InventoryProjectionQuery) {
    if (query.sourceStatus && item.sourceStatus !== query.sourceStatus) return false;
    if (query.availability === 'available') {
      return item.availableQty !== null && item.availableQty > 0;
    }
    if (query.availability === 'unavailable') {
      return item.availableQty === null || item.availableQty <= 0;
    }
    return true;
  }
}
