import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  FinishedStockBucket,
  FinishedStockItemResponseDto,
  FinishedStockPageResponseDto,
  FinishedStockQueryDto,
} from './dto/finished-stock.dto';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../warehouse-coverage/warehouse-coverage-canonical';

const DAY_MS = 86_400_000;
const PROCESSED_RETENTION_DAYS = 90;
const SUMMARY_SCAN_SIZE = 250;

type SummaryAccumulator = {
  totalCount: number;
  totalWeightMilliKg: number;
};

const FINISHED_STOCK_SELECT = {
  releasedFromOrderId: true,
  releasedFromOrder: {
    select: { orderNumber: true, cancellationStatus: true, positions: { select: { id: true } } },
  },
  id: true,
  rollCode: true,
  warehouseStatus: true,
  ownerCounterpartyId: true,
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedByProposalId: true,
  reservedByCoverageDecisionId: true,
  reservedAt: true,
  producedForStockOrderId: true,
  createdAt: true,
  updatedAt: true,
  receivedAt: true,
  producedForStockOrder: {
    select: {
      id: true,
      orderNumber: true,
      stockBatchCode: true,
      requestType: true,
      positions: {
        select: { id: true },
        orderBy: { id: 'asc' },
      },
    },
  },
  currentCoverageFact: {
    select: {
      id: true,
      version: true,
      source: true,
      specVersion: true,
      specFingerprint: true,
      spec: true,
      sourceOrderId: true,
      sourcePositionId: true,
      createdAt: true,
      sourcePosition: {
        select: {
          baseRawMaterialDefinition: { select: { name: true } },
          recipe: { select: { recipeName: true, ingredients: true } },
          recipeDefinitionVersion: {
            select: {
              recipeDefinition: { select: { name: true } },
              ingredients: {
                orderBy: { sequence: 'asc' },
                select: { rawMaterialDefinition: { select: { name: true } } },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.WarehouseRollSelect;

type FinishedStockRow = Prisma.WarehouseRollGetPayload<{
  select: typeof FINISHED_STOCK_SELECT;
}>;

const FINISHED_STOCK_PROVENANCE_SELECT = {
  releasedFromOrderId: true,
  releasedFromOrder: { select: { cancellationStatus: true, positions: { select: { id: true } } } },
  id: true,
  rollCode: true,
  ownerCounterpartyId: true,
  producedForStockOrderId: true,
  producedForStockOrder: {
    select: {
      requestType: true,
      positions: {
        select: { id: true },
        orderBy: { id: 'asc' },
      },
    },
  },
  currentCoverageFact: {
    select: {
      specVersion: true,
      specFingerprint: true,
      spec: true,
      sourceOrderId: true,
      sourcePositionId: true,
    },
  },
} satisfies Prisma.WarehouseRollSelect;

type FinishedStockProvenance = Prisma.WarehouseRollGetPayload<{
  select: typeof FINISHED_STOCK_PROVENANCE_SELECT;
}>;

type FinishedStockCursor = {
  bucket: FinishedStockBucket;
  sortAt: string;
  id: string;
};

function record(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  return value as Record<string, Prisma.JsonValue>;
}

function finiteNumber(value: Prisma.JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: Prisma.JsonValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function ingredientNames(value: Prisma.JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ingredient) => {
    const name = nonEmptyString(record(ingredient).name);
    return name ? [name] : [];
  });
}

function stableLabels(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (!value) return [];
    const display = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!display) return [];
    const key = display.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е');
    if (seen.has(key)) return [];
    seen.add(key);
    return [display];
  });
}

function selectWeightMilliKg(spec: Record<string, Prisma.JsonValue>): number | null {
  return finiteNumber(spec.actualWeightMilliKg) ?? finiteNumber(spec.plannedWeightMilliKg);
}

function scaledLabel(
  label: string,
  value: number | null,
  divisor: number,
  unit: string,
): string | null {
  return value === null ? null : `${label} ${value / divisor} ${unit}`;
}

function hasCanonicalCompanyStockProvenance(row: FinishedStockProvenance): boolean {
  const stockOrder = row.releasedFromOrder ?? row.producedForStockOrder;
  const fact = row.currentCoverageFact;
  if (
    row.ownerCounterpartyId !== null ||
    !(row.releasedFromOrderId
      ? row.releasedFromOrder?.cancellationStatus === 'cancelled'
      : row.producedForStockOrderId &&
        row.producedForStockOrder?.requestType === 'stock_reserve') ||
    !fact ||
    fact.specVersion !== 'warehouse-roll-coverage/v1'
  ) {
    return false;
  }
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    return (
      fingerprintRollFact(spec) === fact.specFingerprint &&
      spec.rollCode === row.rollCode &&
      spec.ownerCounterpartyId === null &&
      fact.sourceOrderId === spec.sourceOrderId &&
      fact.sourcePositionId === spec.sourcePositionId &&
      spec.sourceOrderId === (row.releasedFromOrderId ?? row.producedForStockOrderId) &&
      spec.sourcePositionId !== null &&
      stockOrder?.positions.some(({ id }) => id === spec.sourcePositionId) === true
    );
  } catch {
    return false;
  }
}

function encodeCursor(row: FinishedStockRow, bucket: FinishedStockBucket): string {
  return Buffer.from(JSON.stringify(cursorForRow(row, bucket))).toString('base64url');
}

function cursorForRow(row: FinishedStockRow, bucket: FinishedStockBucket): FinishedStockCursor {
  const sortAt = bucket === 'processed' ? row.reservedAt : row.createdAt;
  if (!sortAt) {
    throw new Error('Cannot encode a finished-stock cursor without its lifecycle timestamp');
  }
  return {
    bucket,
    sortAt: sortAt.toISOString(),
    id: row.id,
  };
}

function decodeCursor(value: string, bucket: FinishedStockBucket): FinishedStockCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as FinishedStockCursor;
    if (
      !parsed ||
      (parsed.bucket !== 'available' && parsed.bucket !== 'processed') ||
      parsed.bucket !== bucket ||
      typeof parsed.sortAt !== 'string' ||
      Number.isNaN(new Date(parsed.sortAt).getTime()) ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      throw new Error('invalid cursor');
    }
    return parsed;
  } catch {
    throw new BadRequestException('Invalid finished-stock cursor');
  }
}

function cursorWhere(
  cursor: FinishedStockCursor,
  bucket: FinishedStockBucket,
): Prisma.WarehouseRollWhereInput {
  return bucket === 'processed'
    ? {
        OR: [
          { reservedAt: { lt: new Date(cursor.sortAt) } },
          { reservedAt: new Date(cursor.sortAt), id: { lt: cursor.id } },
        ],
      }
    : {
        OR: [
          { createdAt: { lt: new Date(cursor.sortAt) } },
          { createdAt: new Date(cursor.sortAt), id: { lt: cursor.id } },
        ],
      };
}

@Injectable()
export class WarehouseFinishedStockService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: FinishedStockQueryDto,
    now = new Date(),
  ): Promise<FinishedStockPageResponseDto> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const q = query.q?.trim();
    const batch = query.batch?.trim();
    const bucket: FinishedStockBucket = query.bucket ?? 'available';
    const processedCutoff = new Date(now.getTime() - PROCESSED_RETENTION_DAYS * DAY_MS);
    const receivedAt: Prisma.DateTimeNullableFilter = {};
    if (query.minAgeDays !== undefined) {
      receivedAt.lte = new Date(now.getTime() - query.minAgeDays * DAY_MS);
    }
    if (query.maxAgeDays !== undefined) {
      receivedAt.gte = new Date(now.getTime() - query.maxAgeDays * DAY_MS);
    }

    const lifecycleWhere: Prisma.WarehouseRollWhereInput =
      bucket === 'processed'
        ? {
            reservedAt: { gte: processedCutoff },
            OR: [
              { reservedForOrderId: { not: null } },
              { reservedForPositionId: { not: null } },
              { reservedByProposalId: { not: null } },
              { reservedByCoverageDecisionId: { not: null } },
            ],
          }
        : {
            warehouseStatus: 'received',
            reservedAt: null,
            reservedForOrderId: null,
            reservedForPositionId: null,
            reservedByProposalId: null,
            reservedByCoverageDecisionId: null,
          };
    const searchWhere: Prisma.WarehouseRollWhereInput | null = q
      ? {
          OR: [
            { rollCode: { contains: q, mode: 'insensitive' } },
            {
              producedForStockOrder: {
                is: { stockBatchCode: { contains: q, mode: 'insensitive' } },
              },
            },
            {
              currentCoverageFact: {
                is: { spec: { path: ['filmType'], string_contains: q } },
              },
            },
            {
              currentCoverageFact: {
                is: {
                  sourcePosition: {
                    is: {
                      baseRawMaterialDefinition: {
                        is: { name: { contains: q, mode: 'insensitive' } },
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
                      recipe: {
                        is: { recipeName: { contains: q, mode: 'insensitive' } },
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
                            is: { name: { contains: q, mode: 'insensitive' } },
                          },
                        },
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
                          ingredients: {
                            some: {
                              rawMaterialDefinition: {
                                is: { name: { contains: q, mode: 'insensitive' } },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        }
      : null;
    const companyStockWhere: Prisma.WarehouseRollWhereInput = {
      OR: [
        {
          producedForStockOrderId: { not: null },
          producedForOrderId: null,
          producedForStockOrder: {
            is: {
              requestType: 'stock_reserve',
              ...(batch ? { stockBatchCode: { contains: batch, mode: 'insensitive' } } : {}),
            },
          },
        },
        {
          releasedFromOrderId: { not: null },
          releasedFromOrder: {
            is: {
              cancellationStatus: 'cancelled',
              ...(batch ? { orderNumber: { contains: batch, mode: 'insensitive' } } : {}),
            },
          },
        },
      ],
      ownerCounterpartyId: null,
      currentCoverageFactId: { not: null },
      ...(Object.keys(receivedAt).length > 0 ? { receivedAt } : {}),
    };
    const baseWhere: Prisma.WarehouseRollWhereInput = {
      ...lifecycleWhere,
      AND: [companyStockWhere, ...(searchWhere ? [searchWhere] : [])],
    };
    const cursor = query.cursor ? decodeCursor(query.cursor, bucket) : null;
    const orderBy: Prisma.WarehouseRollOrderByWithRelationInput[] =
      bucket === 'processed'
        ? [{ reservedAt: 'desc' }, { id: 'desc' }]
        : [{ createdAt: 'desc' }, { id: 'desc' }];
    const [page, summary] = await Promise.all([
      this.readValidPage(baseWhere, cursor, bucket, orderBy, limit),
      this.summarize(baseWhere),
    ]);
    const items = page.rows.map((row) => this.project(row, now));
    const pageWeightKg = Number(
      items.reduce((sum, item) => sum + (item.weightKg ?? 0), 0).toFixed(3),
    );
    const totalWeightKg = Number((summary.totalWeightMilliKg / 1000).toFixed(3));
    return {
      items,
      summary: {
        totalCount: summary.totalCount,
        totalWeightKg,
        pageCount: items.length,
        pageWeightKg,
      },
      nextCursor: page.hasNext ? encodeCursor(page.rows.at(-1)!, bucket) : null,
    };
  }

  private async readValidPage(
    baseWhere: Prisma.WarehouseRollWhereInput,
    initialCursor: FinishedStockCursor | null,
    bucket: FinishedStockBucket,
    orderBy: Prisma.WarehouseRollOrderByWithRelationInput[],
    limit: number,
  ): Promise<{ rows: FinishedStockRow[]; hasNext: boolean }> {
    const take = limit + 1;
    const validRows: FinishedStockRow[] = [];
    let scanCursor = initialCursor;

    for (;;) {
      const rows = await this.prisma.warehouseRoll.findMany({
        where: scanCursor ? { AND: [baseWhere, cursorWhere(scanCursor, bucket)] } : baseWhere,
        select: FINISHED_STOCK_SELECT,
        orderBy,
        take,
      });
      for (const row of rows) {
        if (!hasCanonicalCompanyStockProvenance(row)) continue;
        validRows.push(row);
        if (validRows.length > limit) {
          return { rows: validRows.slice(0, limit), hasNext: true };
        }
      }
      if (rows.length < take) {
        return { rows: validRows, hasNext: false };
      }
      scanCursor = cursorForRow(rows.at(-1)!, bucket);
    }
  }

  private async summarize(baseWhere: Prisma.WarehouseRollWhereInput): Promise<SummaryAccumulator> {
    const summary: SummaryAccumulator = { totalCount: 0, totalWeightMilliKg: 0 };
    let afterId: string | null = null;

    do {
      const rows: FinishedStockProvenance[] = await this.prisma.warehouseRoll.findMany({
        where: afterId ? { AND: [baseWhere, { id: { gt: afterId } }] } : baseWhere,
        select: FINISHED_STOCK_PROVENANCE_SELECT,
        orderBy: { id: 'asc' },
        take: SUMMARY_SCAN_SIZE,
      });
      for (const row of rows) {
        if (!hasCanonicalCompanyStockProvenance(row)) continue;
        summary.totalCount += 1;
        summary.totalWeightMilliKg +=
          selectWeightMilliKg(record(row.currentCoverageFact?.spec)) ?? 0;
      }
      if (rows.length < SUMMARY_SCAN_SIZE) return summary;
      afterId = rows.at(-1)!.id;
    } while (afterId);

    return summary;
  }

  private project(row: FinishedStockRow, now: Date): FinishedStockItemResponseDto {
    const spec = record(row.currentCoverageFact?.spec);
    const selectedWeightMilliKg = selectWeightMilliKg(spec);
    const specIngredients = ingredientNames(spec.ingredients);
    const sourcePosition = row.currentCoverageFact?.sourcePosition;
    const recipeIngredients = ingredientNames(sourcePosition?.recipe?.ingredients ?? undefined);
    const catalogIngredients =
      sourcePosition?.recipeDefinitionVersion?.ingredients.map(
        ({ rawMaterialDefinition }) => rawMaterialDefinition.name,
      ) ?? [];
    const baseMaterialName = sourcePosition?.baseRawMaterialDefinition?.name;
    const recipeVersion =
      sourcePosition?.recipe?.recipeName ??
      sourcePosition?.recipeDefinitionVersion?.recipeDefinition.name ??
      baseMaterialName ??
      nonEmptyString(spec.recipeVersion) ??
      nonEmptyString(spec.recipeDefinitionVersionId);
    const recipe =
      stableLabels([
        recipeVersion,
        ...catalogIngredients,
        baseMaterialName,
        ...recipeIngredients,
        ...specIngredients,
      ]).join(' · ') || 'Рецептура не указана';
    const filmType = nonEmptyString(spec.filmType) ?? 'тип не указан';
    const actualThickness = finiteNumber(spec.actualThicknessMilliMicron);
    const accountingThickness = finiteNumber(spec.accountingThicknessMilliMicron);
    const width = finiteNumber(spec.widthMilliMm);
    const plannedLength = finiteNumber(spec.plannedLengthMilliM);
    const spool = nonEmptyString(spec.spoolType);
    const birka = nonEmptyString(spec.birka);
    const specification = stableLabels([
      filmType,
      scaledLabel('факт', actualThickness, 1000, 'мкм'),
      scaledLabel('учёт', accountingThickness, 1000, 'мкм'),
      scaledLabel('ширина', width, 1000, 'мм'),
      scaledLabel('длина', plannedLength, 1000, 'м'),
      scaledLabel('вес', selectedWeightMilliKg, 1000, 'кг'),
      spool ? `шпуля ${spool}` : null,
      birka ? `бирка ${birka}` : null,
    ]).join(' · ');
    return {
      id: row.id,
      rollCode: row.rollCode,
      batchCode:
        row.producedForStockOrder?.stockBatchCode ??
        row.releasedFromOrder?.orderNumber ??
        'Без партии',
      weightKg:
        selectedWeightMilliKg === null ? null : Number((selectedWeightMilliKg / 1000).toFixed(3)),
      recipe,
      specification,
      ageDays: Math.max(
        0,
        Math.floor((now.getTime() - (row.receivedAt ?? row.createdAt).getTime()) / DAY_MS),
      ),
      processedAt: row.reservedAt?.toISOString() ?? null,
    };
  }
}
