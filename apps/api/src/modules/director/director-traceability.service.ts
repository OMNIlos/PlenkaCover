import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  TRACEABILITY_OBJECT_TYPES,
  type TraceabilityContext,
  type TraceabilityMatchKind,
  type TraceabilityObjectType,
  type TraceabilitySearchItem,
  type TraceabilitySearchPage,
} from '@plenka/contracts';
import {
  type PlatformQrObject,
  PlatformQrRecognitionService,
} from '../../common/platform-qr/platform-qr-recognition.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DirectorContainerTraceabilityService } from './director-container-traceability.service';
import { DirectorTraceabilityTimelineService } from './director-traceability-timeline.service';
import {
  projectRawTraceabilityWeightFacts,
  projectTraceabilityContext,
  projectTraceabilityValueLabel,
  type RawTraceabilityContext,
  type RawTraceabilityDefect,
  type RawTraceabilityFact,
  type RawTraceabilityLink,
  type RawTraceabilityProblem,
  type RawTraceabilityTimelineItem,
} from './director-traceability.projection';

export { projectTraceabilityWeightFacts } from './director-traceability.projection';

interface TraceabilitySearchInput {
  cursor?: string;
  limit: number;
  q: string;
}

interface SearchCandidate extends TraceabilitySearchItem {
  identity: string;
}

interface SearchCursor {
  id: string;
  matchRank: number;
  typeRank: number;
}

const MATCH_RANK: Record<TraceabilityMatchKind, number> = {
  exact: 0,
  prefix: 1,
  contains: 2,
};
const TYPE_RANK = new Map<TraceabilityObjectType, number>(
  TRACEABILITY_OBJECT_TYPES.map((type, index) => [type, index]),
);
const MAX_SEARCH_LIMIT = 50;
const SOURCE_CANDIDATE_LIMIT = 101;
const MAX_CONTEXT_LINKS = 100;
const MAX_TIMELINE_ITEMS = 50;
const MAX_PROBLEM_ITEMS = 50;
const MAX_FACT_ITEMS = 100;
function normalized(value: string): string {
  return value.toLocaleLowerCase('ru-RU');
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isSuccessfulWarehouseOperation<T extends { completedAt: Date | null; status: string }>(
  operation: T,
): operation is T & { completedAt: Date } {
  return (
    operation.completedAt !== null &&
    (operation.status === 'succeeded' || operation.status === 'completed')
  );
}

function matchKind(
  query: string,
  exactFields: Array<string | null | undefined>,
  searchableFields: Array<string | null | undefined>,
): TraceabilityMatchKind | null {
  const needle = normalized(query);
  if (
    exactFields.some(
      (value) => value !== null && value !== undefined && normalized(value) === needle,
    )
  ) {
    return 'exact';
  }
  if (
    searchableFields.some(
      (value) => value !== null && value !== undefined && normalized(value).startsWith(needle),
    )
  ) {
    return 'prefix';
  }
  return searchableFields.some(
    (value) => value !== null && value !== undefined && normalized(value).includes(needle),
  )
    ? 'contains'
    : null;
}

function cursorFor(item: TraceabilitySearchItem): SearchCursor {
  return {
    id: item.objectId,
    matchRank: MATCH_RANK[item.matchKind],
    typeRank: TYPE_RANK.get(item.objectType) ?? TRACEABILITY_OBJECT_TYPES.length,
  };
}

function compareCursor(left: SearchCursor, right: SearchCursor): number {
  return (
    left.matchRank - right.matchRank ||
    left.typeRank - right.typeRank ||
    left.id.localeCompare(right.id)
  );
}

function encodeCursor(item: TraceabilitySearchItem): string {
  return Buffer.from(JSON.stringify(cursorFor(item)), 'utf8').toString('base64url');
}

function decodeCursor(value: string): SearchCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<SearchCursor>;
    if (
      !Number.isInteger(parsed.matchRank) ||
      !Number.isInteger(parsed.typeRank) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0 ||
      parsed.id.length > 256 ||
      (parsed.matchRank as number) < 0 ||
      (parsed.matchRank as number) > 2 ||
      (parsed.typeRank as number) < 0 ||
      (parsed.typeRank as number) >= TRACEABILITY_OBJECT_TYPES.length
    ) {
      throw new Error('Invalid traceability cursor');
    }
    return parsed as SearchCursor;
  } catch {
    throw new BadRequestException({
      code: 'TRACEABILITY_CURSOR_INVALID',
      message: 'Traceability cursor is invalid.',
    });
  }
}

@Injectable()
export class DirectorTraceabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly qrRecognition: PlatformQrRecognitionService,
    private readonly containerTraceability: DirectorContainerTraceabilityService,
    private readonly timeline: DirectorTraceabilityTimelineService,
  ) {}

  async search(input: TraceabilitySearchInput): Promise<TraceabilitySearchPage> {
    const query = input.q.trim();
    if (query.length === 0 || query.length > 128) {
      throw new BadRequestException({
        code: 'TRACEABILITY_QUERY_INVALID',
        message: 'Traceability query must contain from 1 to 128 characters.',
      });
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_LIMIT) {
      throw new BadRequestException({
        code: 'TRACEABILITY_LIMIT_INVALID',
        message: `Traceability limit must be from 1 to ${MAX_SEARCH_LIMIT}.`,
      });
    }

    const qrResolution = await this.qrRecognition.resolve(query);
    if (qrResolution.outcome === 'not_found') return { items: [], nextCursor: null };
    if (qrResolution.outcome === 'recognized') {
      return this.paginate([this.qrCandidate(qrResolution.object)], input.cursor, input.limit);
    }

    const [
      warehouseRolls,
      dispatchRolls,
      bigBags,
      orders,
      pallets,
      warehouseTasks,
      warehouseOperations,
    ] = await Promise.all([
      this.prisma.warehouseRoll.findMany({
        where: {
          OR: [{ id: query }, { rollCode: { contains: query, mode: 'insensitive' } }],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          rollCode: true,
          warehouseStatus: true,
        },
      }),
      this.prisma.rollDispatchItem.findMany({
        where: {
          OR: [{ id: query }, { rollCode: { contains: query, mode: 'insensitive' } }],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          rollCode: true,
          status: true,
        },
      }),
      this.prisma.bigBagUnit.findMany({
        where: {
          OR: [{ id: query }, { code: { contains: query, mode: 'insensitive' } }],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          code: true,
          material: true,
        },
      }),
      this.prisma.commercialOrder.findMany({
        where: {
          OR: [
            { id: query },
            { orderNumber: { contains: query, mode: 'insensitive' } },
            { title: { contains: query, mode: 'insensitive' } },
          ],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          orderNumber: true,
          title: true,
        },
      }),
      this.prisma.palletListDocument.findMany({
        where: {
          OR: [{ id: query }, { palletId: { contains: query, mode: 'insensitive' } }],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          palletId: true,
        },
      }),
      this.prisma.warehouseAcceptanceTask.findMany({
        where: {
          OR: [{ id: query }, { operationCode: { contains: query, mode: 'insensitive' } }],
        },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          operationCode: true,
          mode: true,
          status: true,
        },
      }),
      this.prisma.warehouseOperation.findMany({
        where: { id: { contains: query, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
        take: SOURCE_CANDIDATE_LIMIT,
        select: {
          id: true,
          kind: true,
          status: true,
        },
      }),
    ]);

    const candidates = new Map<string, SearchCandidate>();
    const add = (candidate: SearchCandidate | null) => {
      if (!candidate) return;
      const current = candidates.get(candidate.identity);
      if (!current || MATCH_RANK[candidate.matchKind] < MATCH_RANK[current.matchKind]) {
        candidates.set(candidate.identity, candidate);
      }
    };

    for (const roll of warehouseRolls) {
      const kind = matchKind(query, [roll.id, roll.rollCode], [roll.rollCode]);
      add(
        kind
          ? {
              identity: `roll:${normalized(roll.rollCode)}`,
              objectType: 'roll',
              objectId: roll.id,
              displayName: `Рулон ${roll.rollCode}`,
              secondaryLabel: null,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const roll of dispatchRolls) {
      const kind = matchKind(query, [roll.id, roll.rollCode], [roll.rollCode]);
      add(
        kind
          ? {
              identity: `roll:${normalized(roll.rollCode)}`,
              objectType: 'roll',
              objectId: roll.id,
              displayName: `Рулон ${roll.rollCode}`,
              secondaryLabel: null,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const bigBag of bigBags) {
      const kind = matchKind(query, [bigBag.id, bigBag.code], [bigBag.code]);
      add(
        kind
          ? {
              identity: `big_bag:${bigBag.id}`,
              objectType: 'big_bag',
              objectId: bigBag.id,
              displayName: `Big-Bag ${bigBag.code}`,
              secondaryLabel: bigBag.material,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const order of orders) {
      const kind = matchKind(
        query,
        [order.id, order.orderNumber, order.title],
        [order.orderNumber, order.title],
      );
      add(
        kind
          ? {
              identity: `order:${order.id}`,
              objectType: 'order',
              objectId: order.id,
              displayName: `Заказ ${order.orderNumber}`,
              secondaryLabel: order.title,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const pallet of pallets) {
      const kind = matchKind(query, [pallet.id, pallet.palletId], [pallet.palletId]);
      add(
        kind
          ? {
              identity: `pallet:${pallet.id}`,
              objectType: 'pallet',
              objectId: pallet.id,
              displayName: `Палетный лист ${pallet.palletId}`,
              secondaryLabel: null,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const task of warehouseTasks) {
      const kind = matchKind(query, [task.id, task.operationCode], [task.operationCode]);
      add(
        kind
          ? {
              identity: `warehouse_task:${task.id}`,
              objectType: 'warehouse_task',
              objectId: task.id,
              displayName: `Складская задача ${task.operationCode ?? task.id}`,
              secondaryLabel: `${projectTraceabilityValueLabel(task.mode)} · ${projectTraceabilityValueLabel(task.status)}`,
              matchKind: kind,
            }
          : null,
      );
    }
    for (const operation of warehouseOperations) {
      const kind = matchKind(query, [operation.id], [operation.id]);
      add(
        kind
          ? {
              identity: `warehouse_operation:${operation.id}`,
              objectType: 'warehouse_operation',
              objectId: operation.id,
              displayName: `Складская операция ${operation.id}`,
              secondaryLabel: `${projectTraceabilityValueLabel(operation.kind)} · ${projectTraceabilityValueLabel(operation.status)}`,
              matchKind: kind,
            }
          : null,
      );
    }

    return this.paginate([...candidates.values()], input.cursor, input.limit);
  }

  private qrCandidate(object: PlatformQrObject): SearchCandidate {
    if (object.kind === 'roll') {
      return {
        identity: `roll:${normalized(object.code)}`,
        objectType: 'roll',
        objectId: object.objectId,
        displayName: `Рулон ${object.code}`,
        secondaryLabel: null,
        matchKind: 'exact',
      };
    }
    if (object.kind === 'big_bag') {
      return {
        identity: `big_bag:${object.objectId}`,
        objectType: 'big_bag',
        objectId: object.objectId,
        displayName: `Big-Bag ${object.code}`,
        secondaryLabel: object.material,
        matchKind: 'exact',
      };
    }
    return {
      identity: `pallet:${object.objectId}`,
      objectType: 'pallet',
      objectId: object.objectId,
      displayName: `Палетный лист ${object.code}`,
      secondaryLabel: null,
      matchKind: 'exact',
    };
  }

  async getContext(
    objectType: TraceabilityObjectType,
    objectId: string,
  ): Promise<TraceabilityContext> {
    const raw =
      objectType === 'order'
        ? await this.getOrderContext(objectId)
        : objectType === 'position'
          ? await this.getPositionContext(objectId)
          : objectType === 'roll'
            ? await this.getRollContext(objectId)
            : objectType === 'big_bag'
              ? await this.containerTraceability.getBigBagContext(objectId)
              : objectType === 'pallet'
                ? await this.containerTraceability.getPalletContext(objectId)
                : objectType === 'warehouse_task'
                  ? await this.getWarehouseTaskContext(objectId)
                  : objectType === 'warehouse_operation'
                    ? await this.getWarehouseOperationContext(objectId)
                    : null;
    if (!raw) throw this.notFound();
    return projectTraceabilityContext(raw);
  }

  private async getOrderContext(objectId: string): Promise<RawTraceabilityContext> {
    const order = await this.prisma.commercialOrder.findFirst({
      where: {
        OR: [{ id: objectId }, { orderNumber: objectId }],
      },
      select: {
        id: true,
        orderNumber: true,
        title: true,
        productionIndicator: true,
        warehouseCoverStatus: true,
        paymentStatus: true,
        shipmentStatus: true,
        commercialStage: true,
        createdAt: true,
        positions: {
          orderBy: { id: 'asc' },
          take: MAX_CONTEXT_LINKS,
          select: {
            id: true,
            filmType: true,
            warehouseCoverStatus: true,
          },
        },
      },
    });
    if (!order) throw this.notFound();

    const dispatchItems = await this.prisma.rollDispatchItem.findMany({
      where: {
        productionOrder: { commercialOrderId: order.id },
      },
      orderBy: { id: 'asc' },
      take: MAX_CONTEXT_LINKS,
      select: {
        id: true,
        rollCode: true,
        orderLineId: true,
        status: true,
        updatedAt: true,
        completedAt: true,
        operatorLine: {
          select: {
            id: true,
            step: true,
            labelState: true,
            warehouseState: true,
          },
        },
      },
    });

    const positionIds = order.positions.map((position) => position.id);
    const dispatchIds = dispatchItems.map((item) => item.id);
    const rollCodes = dispatchItems.map((item) => item.rollCode);
    const lineIds = dispatchItems
      .map((item) => item.operatorLine?.id)
      .filter((id): id is string => id !== undefined);
    const reservedStockRollRefs = await this.prisma.warehouseRoll.findMany({
      where: {
        reservedForOrderId: order.id,
        producedForStockOrder: { is: { requestType: 'stock_reserve' } },
      },
      orderBy: { id: 'asc' },
      take: MAX_CONTEXT_LINKS,
      select: { id: true },
    });
    const timelineObjectIds = [
      ...new Set([
        order.id,
        ...reservedStockRollRefs.map(({ id }) => id),
        ...positionIds,
        ...dispatchIds,
        ...rollCodes,
        ...lineIds,
      ]),
    ].slice(0, MAX_CONTEXT_LINKS);

    const [timelineRows, problemRows, defectRows, weightRows, warehouseRolls, warehouseOperations] =
      await Promise.all([
        this.prisma.domainEvent.findMany({
          where: { objectId: { in: timelineObjectIds } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_TIMELINE_ITEMS,
          select: {
            id: true,
            type: true,
            label: true,
            reason: true,
            actorRole: true,
            actor: { select: { displayName: true, role: true } },
            createdAt: true,
          },
        }),
        this.prisma.productionProblem.findMany({
          where: {
            OR: [
              { orderId: order.id },
              { positionId: { in: positionIds } },
              { rollId: { in: [...dispatchIds, ...rollCodes] } },
            ],
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_PROBLEM_ITEMS,
          select: {
            id: true,
            type: true,
            status: true,
            reason: true,
            createdAt: true,
            resolvedAt: true,
          },
        }),
        lineIds.length > 0
          ? this.prisma.defectRecord.findMany({
              where: { operatorRollLineId: { in: lineIds } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: MAX_PROBLEM_ITEMS,
              select: {
                id: true,
                blocking: true,
                comment: true,
                weightKg: true,
                createdAt: true,
              },
            })
          : [],
        lineIds.length > 0
          ? this.prisma.weightCapture.findMany({
              where: {
                operatorRollLineId: { in: lineIds },
                stable: true,
                deviceStatus: 'ready',
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: MAX_FACT_ITEMS,
              select: {
                id: true,
                operatorRollLineId: true,
                kind: true,
                stable: true,
                deviceStatus: true,
                grossKg: true,
                spoolKg: true,
                netKg: true,
                toleranceOk: true,
                createdAt: true,
              },
            })
          : [],
        this.prisma.warehouseRoll.findMany({
          where: {
            OR: [
              ...(rollCodes.length > 0 ? [{ rollCode: { in: rollCodes } }] : []),
              { reservedForOrderId: order.id },
            ],
          },
          orderBy: { id: 'asc' },
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            rollCode: true,
            warehouseStatus: true,
            reservedForOrderId: true,
            producedForStockOrderId: true,
            updatedAt: true,
            producedForStockOrder: {
              select: {
                id: true,
                orderNumber: true,
                stockBatchCode: true,
                requestType: true,
              },
            },
            currentCoverageFact: {
              select: {
                id: true,
                version: true,
                source: true,
                createdAt: true,
              },
            },
          },
        }),
        rollCodes.length > 0
          ? this.prisma.warehouseOperation.findMany({
              where: { rollCode: { in: rollCodes } },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: MAX_FACT_ITEMS,
              select: {
                id: true,
                kind: true,
                status: true,
                taskId: true,
                rollCode: true,
                createdAt: true,
                completedAt: true,
              },
            })
          : [],
      ]);

    const links: RawTraceabilityLink[] = [
      ...order.positions.map((position, index) => ({
        objectType: 'position' as const,
        objectId: position.id,
        displayName: `Позиция ${index + 1}`,
        relation: 'contains',
      })),
      ...dispatchItems.map((item) => ({
        objectType: 'roll' as const,
        objectId: item.id,
        displayName: `Рулон ${item.rollCode}`,
        relation: 'produces',
      })),
      ...warehouseRolls
        .filter(
          (roll) =>
            roll.reservedForOrderId === order.id &&
            !dispatchItems.some((item) => item.rollCode === roll.rollCode),
        )
        .map((roll) => ({
          objectType: 'roll' as const,
          objectId: roll.id,
          displayName: [`Рулон ${roll.rollCode}`, roll.producedForStockOrder?.stockBatchCode]
            .filter(Boolean)
            .join(' · '),
          relation: 'reserved_from_stock',
        })),
    ].slice(0, MAX_CONTEXT_LINKS);
    const timeline: RawTraceabilityTimelineItem[] = timelineRows
      .slice(0, MAX_TIMELINE_ITEMS)
      .map((event) => ({
        eventId: event.id,
        eventType: event.type,
        label: event.label,
        reason: event.reason,
        actorRole: event.actorRole,
        actor: event.actor,
        occurredAt: toIso(event.createdAt),
      }));
    const problems: RawTraceabilityProblem[] = problemRows
      .slice(0, MAX_PROBLEM_ITEMS)
      .map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        reason: row.reason,
        createdAt: toIso(row.createdAt),
        resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
      }));
    const defects: RawTraceabilityDefect[] = defectRows.slice(0, MAX_PROBLEM_ITEMS).map((row) => ({
      id: row.id,
      status: row.blocking ? 'blocking' : 'recorded',
      reason: row.comment,
      weightKg: row.weightKg,
      recordedAt: toIso(row.createdAt),
    }));
    const productionFacts: RawTraceabilityFact[] = [
      ...dispatchItems.map((item) => ({
        kind: 'dispatch_status',
        value: item.status,
        unit: null,
        recordedAt: toIso(item.completedAt ?? item.updatedAt),
        source: 'platform',
      })),
      ...projectRawTraceabilityWeightFacts(weightRows),
    ].slice(0, MAX_FACT_ITEMS);
    const warehouseFacts: RawTraceabilityFact[] = [
      ...warehouseRolls.flatMap((roll) => [
        {
          kind: 'warehouse_status',
          value: roll.warehouseStatus,
          unit: null,
          recordedAt: toIso(roll.updatedAt),
          source: 'platform',
        },
        ...(roll.currentCoverageFact
          ? [
              {
                kind: 'coverage_fact_version',
                value: roll.currentCoverageFact.version,
                unit: null,
                recordedAt: toIso(roll.currentCoverageFact.createdAt),
                source: roll.currentCoverageFact.source,
              },
            ]
          : []),
      ]),
      ...warehouseOperations.filter(isSuccessfulWarehouseOperation).map((operation) => ({
        kind: 'warehouse_operation',
        value: operation.kind,
        unit: null,
        recordedAt: toIso(operation.completedAt as Date),
        source: 'platform',
      })),
    ].slice(0, MAX_FACT_ITEMS);

    return {
      objectType: 'order',
      objectId: order.id,
      displayName: `Заказ ${order.orderNumber}`,
      statuses: [
        { kind: 'production', value: order.productionIndicator },
        { kind: 'warehouse_cover', value: order.warehouseCoverStatus },
        { kind: 'payment', value: order.paymentStatus },
        { kind: 'shipment', value: order.shipmentStatus },
        { kind: 'commercial_stage', value: order.commercialStage },
      ],
      links,
      timeline,
      problems,
      defects,
      productionFacts,
      warehouseFacts,
    };
  }

  private async getRollContext(objectId: string): Promise<RawTraceabilityContext> {
    let warehouseRoll = await this.prisma.warehouseRoll.findFirst({
      where: {
        OR: [{ id: objectId }, { rollCode: objectId }],
      },
      select: {
        id: true,
        rollCode: true,
        warehouseStatus: true,
        reservedForOrderId: true,
        reservedForPositionId: true,
        producedForStockOrderId: true,
        producedForStockOrder: {
          select: {
            id: true,
            orderNumber: true,
            stockBatchCode: true,
            requestType: true,
          },
        },
        updatedAt: true,
        currentCoverageFact: {
          select: {
            id: true,
            version: true,
            source: true,
            sourceOrderId: true,
            sourcePositionId: true,
            createdAt: true,
          },
        },
      },
    });
    const dispatchItem = await this.prisma.rollDispatchItem.findFirst({
      where: {
        OR: [{ id: objectId }, { rollCode: warehouseRoll?.rollCode ?? objectId }],
      },
      select: {
        id: true,
        rollCode: true,
        orderLineId: true,
        status: true,
        updatedAt: true,
        completedAt: true,
        operatorLine: {
          select: {
            id: true,
            step: true,
            labelState: true,
            warehouseState: true,
          },
        },
        productionOrder: {
          select: {
            id: true,
            commercialOrder: {
              select: {
                id: true,
                orderNumber: true,
                title: true,
                requestType: true,
                stockBatchCode: true,
                productionIndicator: true,
                warehouseCoverStatus: true,
                paymentStatus: true,
                shipmentStatus: true,
              },
            },
          },
        },
      },
    });
    if (!warehouseRoll && dispatchItem) {
      warehouseRoll = await this.prisma.warehouseRoll.findFirst({
        where: { rollCode: dispatchItem.rollCode },
        select: {
          id: true,
          rollCode: true,
          warehouseStatus: true,
          reservedForOrderId: true,
          reservedForPositionId: true,
          producedForStockOrderId: true,
          producedForStockOrder: {
            select: {
              id: true,
              orderNumber: true,
              stockBatchCode: true,
              requestType: true,
            },
          },
          updatedAt: true,
          currentCoverageFact: {
            select: {
              id: true,
              version: true,
              source: true,
              sourceOrderId: true,
              sourcePositionId: true,
              createdAt: true,
            },
          },
        },
      });
    }
    if (!warehouseRoll && !dispatchItem) throw this.notFound();

    const rollCode = warehouseRoll?.rollCode ?? dispatchItem!.rollCode;
    const lineId = dispatchItem?.operatorLine?.id;
    const sourceOrder = dispatchItem?.productionOrder.commercialOrder;
    const sourceOrderId =
      sourceOrder?.id ??
      warehouseRoll?.currentCoverageFact?.sourceOrderId ??
      warehouseRoll?.producedForStockOrderId ??
      null;
    const reservedOrderId = warehouseRoll?.reservedForOrderId ?? null;
    const sourcePositionId =
      dispatchItem?.orderLineId ?? warehouseRoll?.currentCoverageFact?.sourcePositionId ?? null;
    const reservedPositionId = warehouseRoll?.reservedForPositionId ?? null;
    const reservedOrder =
      reservedOrderId && reservedOrderId !== sourceOrderId
        ? await this.prisma.commercialOrder.findUnique({
            where: { id: reservedOrderId },
            select: { id: true, orderNumber: true },
          })
        : null;
    const timelineObjectIds = [warehouseRoll?.id, dispatchItem?.id, rollCode, lineId].filter(
      (id): id is string => typeof id === 'string',
    );

    const [timelineRows, problemRows, defectRows, weightRows, operationRows] = await Promise.all([
      this.prisma.domainEvent.findMany({
        where: { objectId: { in: timelineObjectIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_TIMELINE_ITEMS,
        select: {
          id: true,
          type: true,
          label: true,
          reason: true,
          actorRole: true,
          actor: { select: { displayName: true, role: true } },
          createdAt: true,
        },
      }),
      this.prisma.productionProblem.findMany({
        where: {
          OR: [
            ...(sourceOrderId ? [{ orderId: sourceOrderId }] : []),
            ...(reservedOrderId ? [{ orderId: reservedOrderId }] : []),
            ...(sourcePositionId ? [{ positionId: sourcePositionId }] : []),
            ...(reservedPositionId ? [{ positionId: reservedPositionId }] : []),
            {
              rollId: {
                in: [warehouseRoll?.id, dispatchItem?.id, rollCode].filter(
                  (id): id is string => typeof id === 'string',
                ),
              },
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_PROBLEM_ITEMS,
        select: {
          id: true,
          type: true,
          status: true,
          reason: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
      lineId
        ? this.prisma.defectRecord.findMany({
            where: { operatorRollLineId: lineId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: MAX_PROBLEM_ITEMS,
            select: {
              id: true,
              blocking: true,
              comment: true,
              weightKg: true,
              createdAt: true,
            },
          })
        : [],
      lineId
        ? this.prisma.weightCapture.findMany({
            where: {
              operatorRollLineId: lineId,
              stable: true,
              deviceStatus: 'ready',
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: MAX_FACT_ITEMS,
            select: {
              id: true,
              operatorRollLineId: true,
              kind: true,
              stable: true,
              deviceStatus: true,
              grossKg: true,
              spoolKg: true,
              netKg: true,
              toleranceOk: true,
              createdAt: true,
            },
          })
        : [],
      this.prisma.warehouseOperation.findMany({
        where: { rollCode },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_FACT_ITEMS,
        select: {
          id: true,
          kind: true,
          status: true,
          taskId: true,
          rollCode: true,
          createdAt: true,
          completedAt: true,
        },
      }),
    ]);

    const links: RawTraceabilityLink[] = [];
    if (sourceOrderId) {
      links.push({
        objectType: 'order',
        objectId: sourceOrderId,
        displayName: [
          sourceOrder
            ? `Заказ ${sourceOrder.orderNumber}`
            : warehouseRoll?.producedForStockOrder
              ? `Заказ ${warehouseRoll.producedForStockOrder.orderNumber}`
              : `Заказ ${sourceOrderId}`,
          sourceOrder?.stockBatchCode ?? warehouseRoll?.producedForStockOrder?.stockBatchCode,
        ]
          .filter(Boolean)
          .join(' · '),
        relation:
          sourceOrder?.requestType === 'stock_reserve' ||
          warehouseRoll?.producedForStockOrder?.requestType === 'stock_reserve'
            ? 'produced_for_stock'
            : 'belongs_to',
      });
    }
    if (reservedOrderId && reservedOrderId !== sourceOrderId) {
      links.push({
        objectType: 'order',
        objectId: reservedOrderId,
        displayName: reservedOrder
          ? `Заказ ${reservedOrder.orderNumber}`
          : `Заказ ${reservedOrderId}`,
        relation: 'reserved_for',
      });
    }
    if (sourcePositionId) {
      links.push({
        objectType: 'position',
        objectId: sourcePositionId,
        displayName: `Позиция ${sourcePositionId}`,
        relation: 'belongs_to',
      });
    }
    if (reservedPositionId && reservedPositionId !== sourcePositionId) {
      links.push({
        objectType: 'position',
        objectId: reservedPositionId,
        displayName: `Позиция ${reservedPositionId}`,
        relation: 'reserved_for',
      });
    }

    const timeline: RawTraceabilityTimelineItem[] = timelineRows
      .slice(0, MAX_TIMELINE_ITEMS)
      .map((event) => ({
        eventId: event.id,
        eventType: event.type,
        label: event.label,
        reason: event.reason,
        actorRole: event.actorRole,
        actor: event.actor,
        occurredAt: toIso(event.createdAt),
      }));
    const problems: RawTraceabilityProblem[] = problemRows
      .slice(0, MAX_PROBLEM_ITEMS)
      .map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        reason: row.reason,
        createdAt: toIso(row.createdAt),
        resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
      }));
    const defects: RawTraceabilityDefect[] = defectRows.slice(0, MAX_PROBLEM_ITEMS).map((row) => ({
      id: row.id,
      status: row.blocking ? 'blocking' : 'recorded',
      reason: row.comment,
      weightKg: row.weightKg,
      recordedAt: toIso(row.createdAt),
    }));
    const productionFacts: RawTraceabilityFact[] = [
      ...(dispatchItem
        ? [
            {
              kind: 'dispatch_status',
              value: dispatchItem.status,
              unit: null,
              recordedAt: toIso(dispatchItem.completedAt ?? dispatchItem.updatedAt),
              source: 'platform',
            },
          ]
        : []),
      ...projectRawTraceabilityWeightFacts(weightRows),
    ].slice(0, MAX_FACT_ITEMS);
    const warehouseFacts: RawTraceabilityFact[] = [
      ...(warehouseRoll
        ? [
            {
              kind: 'warehouse_status',
              value: warehouseRoll.warehouseStatus,
              unit: null,
              recordedAt: toIso(warehouseRoll.updatedAt),
              source: 'platform',
            },
            ...(warehouseRoll.currentCoverageFact
              ? [
                  {
                    kind: 'coverage_fact_version',
                    value: warehouseRoll.currentCoverageFact.version,
                    unit: null,
                    recordedAt: toIso(warehouseRoll.currentCoverageFact.createdAt),
                    source: warehouseRoll.currentCoverageFact.source,
                  },
                ]
              : []),
          ]
        : []),
      ...operationRows.filter(isSuccessfulWarehouseOperation).map((operation) => ({
        kind: 'warehouse_operation',
        value: operation.kind,
        unit: null,
        recordedAt: toIso(operation.completedAt as Date),
        source: 'platform',
      })),
    ].slice(0, MAX_FACT_ITEMS);
    const statuses = [];
    if (dispatchItem) statuses.push({ kind: 'dispatch', value: dispatchItem.status });
    if (dispatchItem?.operatorLine) {
      statuses.push(
        { kind: 'operator_step', value: dispatchItem.operatorLine.step },
        { kind: 'label', value: dispatchItem.operatorLine.labelState },
        { kind: 'warehouse', value: dispatchItem.operatorLine.warehouseState },
      );
    }
    if (warehouseRoll) {
      statuses.push({ kind: 'warehouse', value: warehouseRoll.warehouseStatus });
    }

    return {
      objectType: 'roll',
      objectId: warehouseRoll?.id ?? dispatchItem!.id,
      displayName: `Рулон ${rollCode}`,
      statuses,
      links,
      timeline,
      problems,
      defects,
      productionFacts,
      warehouseFacts,
    };
  }

  private async getPositionContext(objectId: string): Promise<RawTraceabilityContext> {
    const position = await this.prisma.commercialOrderPosition.findFirst({
      where: { id: objectId },
      select: {
        id: true,
        filmType: true,
        warehouseCoverStatus: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            title: true,
          },
        },
      },
    });
    if (!position) throw this.notFound();

    const dispatchItems = await this.prisma.rollDispatchItem.findMany({
      where: { orderLineId: position.id },
      orderBy: { id: 'asc' },
      take: MAX_CONTEXT_LINKS,
      select: {
        id: true,
        rollCode: true,
        status: true,
        updatedAt: true,
        completedAt: true,
        operatorLine: {
          select: {
            id: true,
            step: true,
            labelState: true,
            warehouseState: true,
          },
        },
      },
    });
    const lineIds = dispatchItems
      .map((item) => item.operatorLine?.id)
      .filter((id): id is string => id !== undefined);
    const timeline = await this.timeline.get([
      position.id,
      ...dispatchItems.flatMap((item) => [item.id, item.rollCode]),
      ...lineIds,
    ]);
    const problemRows = await this.prisma.productionProblem.findMany({
      where: {
        OR: [
          { positionId: position.id },
          { rollId: { in: dispatchItems.flatMap((item) => [item.id, item.rollCode]) } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_PROBLEM_ITEMS,
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    return {
      objectType: 'position',
      objectId: position.id,
      displayName: `Позиция ${position.filmType}`,
      statuses: [{ kind: 'warehouse_cover', value: position.warehouseCoverStatus }],
      links: [
        {
          objectType: 'order' as const,
          objectId: position.order.id,
          displayName: `Заказ ${position.order.orderNumber}`,
          relation: 'belongs_to',
        },
        ...dispatchItems.map((item) => ({
          objectType: 'roll' as const,
          objectId: item.id,
          displayName: `Рулон ${item.rollCode}`,
          relation: 'produces',
        })),
      ].slice(0, MAX_CONTEXT_LINKS),
      timeline,
      problems: problemRows.slice(0, MAX_PROBLEM_ITEMS).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        reason: row.reason,
        createdAt: toIso(row.createdAt),
        resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
      })),
      defects: [],
      productionFacts: dispatchItems.slice(0, MAX_FACT_ITEMS).map((item) => ({
        kind: 'dispatch_status',
        value: item.status,
        unit: null,
        recordedAt: toIso(item.completedAt ?? item.updatedAt),
        source: 'platform',
      })),
      warehouseFacts: [],
    };
  }

  private async getWarehouseTaskContext(objectId: string): Promise<RawTraceabilityContext> {
    const task = await this.prisma.warehouseAcceptanceTask.findFirst({
      where: {
        OR: [{ id: objectId }, { operationCode: objectId }],
      },
      select: {
        id: true,
        operationCode: true,
        mode: true,
        status: true,
        orderId: true,
        positionId: true,
        createdAt: true,
        updatedAt: true,
        rows: {
          orderBy: { id: 'asc' },
          take: MAX_CONTEXT_LINKS,
          select: {
            id: true,
            rollCode: true,
            scanStatus: true,
          },
        },
        operations: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            kind: true,
            status: true,
            rollCode: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });
    if (!task) throw this.notFound();

    const rollCodes = task.rows.map((row) => row.rollCode);
    const timeline = await this.timeline.get([
      task.id,
      task.operationCode,
      ...rollCodes,
      ...task.operations.map((operation) => operation.id),
    ]);
    const problemRows = await this.prisma.productionProblem.findMany({
      where: {
        OR: [
          ...(task.orderId ? [{ orderId: task.orderId }] : []),
          ...(task.positionId ? [{ positionId: task.positionId }] : []),
          { rollId: { in: rollCodes } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_PROBLEM_ITEMS,
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    return {
      objectType: 'warehouse_task',
      objectId: task.id,
      displayName: `Складская задача ${task.operationCode ?? task.id}`,
      statuses: [
        { kind: 'task', value: task.status },
        { kind: 'mode', value: task.mode },
      ],
      links: [
        ...(task.orderId
          ? [
              {
                objectType: 'order' as const,
                objectId: task.orderId,
                displayName: `Заказ ${task.orderId}`,
                relation: 'belongs_to',
              },
            ]
          : []),
        ...(task.positionId
          ? [
              {
                objectType: 'position' as const,
                objectId: task.positionId,
                displayName: `Позиция ${task.positionId}`,
                relation: 'belongs_to',
              },
            ]
          : []),
        ...task.rows.map((row) => ({
          objectType: 'roll' as const,
          objectId: row.rollCode,
          displayName: `Рулон ${row.rollCode}`,
          relation: row.scanStatus,
        })),
        ...task.operations.map((operation) => ({
          objectType: 'warehouse_operation' as const,
          objectId: operation.id,
          displayName: `Складская операция ${operation.id}`,
          relation: 'contains',
        })),
      ].slice(0, MAX_CONTEXT_LINKS),
      timeline,
      problems: problemRows.slice(0, MAX_PROBLEM_ITEMS).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        reason: row.reason,
        createdAt: toIso(row.createdAt),
        resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
      })),
      defects: [],
      productionFacts: [],
      warehouseFacts: task.operations
        .filter(isSuccessfulWarehouseOperation)
        .slice(0, MAX_FACT_ITEMS)
        .map((operation) => ({
          kind: 'warehouse_operation',
          value: operation.kind,
          unit: null,
          recordedAt: toIso(operation.completedAt as Date),
          source: 'platform',
        })),
    };
  }

  private async getWarehouseOperationContext(objectId: string): Promise<RawTraceabilityContext> {
    const operation = await this.prisma.warehouseOperation.findFirst({
      where: { id: objectId },
      select: {
        id: true,
        kind: true,
        status: true,
        taskId: true,
        rollCode: true,
        createdAt: true,
        completedAt: true,
        task: {
          select: {
            id: true,
            operationCode: true,
            mode: true,
            status: true,
          },
        },
        scanRow: {
          select: {
            id: true,
            rollCode: true,
            scanStatus: true,
          },
        },
      },
    });
    if (!operation) throw this.notFound();

    const timeline = await this.timeline.get([
      operation.id,
      operation.taskId,
      operation.rollCode,
      operation.scanRow.id,
    ]);
    const problemRows = await this.prisma.productionProblem.findMany({
      where: { rollId: operation.rollCode },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_PROBLEM_ITEMS,
      select: {
        id: true,
        type: true,
        status: true,
        reason: true,
        createdAt: true,
        resolvedAt: true,
      },
    });

    return {
      objectType: 'warehouse_operation',
      objectId: operation.id,
      displayName: `Складская операция ${operation.id}`,
      statuses: [
        { kind: 'operation', value: operation.status },
        { kind: 'kind', value: operation.kind },
      ],
      links: [
        {
          objectType: 'warehouse_task',
          objectId: operation.taskId,
          displayName: `Складская задача ${operation.task.operationCode ?? operation.taskId}`,
          relation: 'belongs_to',
        },
        {
          objectType: 'roll',
          objectId: operation.rollCode,
          displayName: `Рулон ${operation.rollCode}`,
          relation: operation.scanRow.scanStatus,
        },
      ],
      timeline,
      problems: problemRows.slice(0, MAX_PROBLEM_ITEMS).map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        reason: row.reason,
        createdAt: toIso(row.createdAt),
        resolvedAt: row.resolvedAt ? toIso(row.resolvedAt) : null,
      })),
      defects: [],
      productionFacts: [],
      warehouseFacts: isSuccessfulWarehouseOperation(operation)
        ? [
            {
              kind: 'warehouse_operation',
              value: operation.kind,
              unit: null,
              recordedAt: toIso(operation.completedAt),
              source: 'platform',
            },
          ]
        : [],
    };
  }

  private paginate(
    candidates: SearchCandidate[],
    encodedCursor: string | undefined,
    limit: number,
  ): TraceabilitySearchPage {
    const cursor = encodedCursor ? decodeCursor(encodedCursor) : null;
    const ordered = candidates
      .sort((left, right) => compareCursor(cursorFor(left), cursorFor(right)))
      .filter((item) => !cursor || compareCursor(cursorFor(item), cursor) > 0);
    const page = ordered.slice(0, limit);
    const items = page.map(({ identity: _identity, ...item }): TraceabilitySearchItem => item);

    return {
      items,
      nextCursor: ordered.length > limit && items.length > 0 ? encodeCursor(items.at(-1)!) : null,
    };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'TRACEABILITY_NOT_FOUND',
      message: 'Traceability object was not found.',
    });
  }
}
