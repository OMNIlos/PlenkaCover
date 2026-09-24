import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Role,
  WarehouseCoverRequestCase,
  WarehouseCoverRequestOrder,
  WarehouseCoverStatus,
} from '@plenka/contracts';
import type { PrismaService } from './prisma/prisma.service';

export const WAREHOUSE_COVER_ACTIONABLE_STAGES = [
  'incoming',
  'sent_to_finance',
  'in_work',
] as const;

export const WAREHOUSE_COVER_ACTIONABLE_WHERE = {
  commercialStage: { in: [...WAREHOUSE_COVER_ACTIONABLE_STAGES] },
  shipmentStatus: { not: 'shipped' },
  readyForShipmentAt: null,
  shipmentCompletedAt: null,
} satisfies Prisma.CommercialOrderWhereInput;

type ActionableCoverOrder = {
  commercialStage: string;
  shipmentStatus: string;
  readyForShipmentAt?: Date | null;
  shipmentCompletedAt?: Date | null;
  positions: Array<{ id: string }>;
};

type AcquireCoverCaseInput = {
  orderId: string;
  affectedPositionIds: string[];
  actorRole: Role;
  actorId: string | null;
  reason: string;
};

class WarehouseCoverScopeStaleError extends Error {
  constructor() {
    super('Warehouse cover task scope changed concurrently');
    this.name = 'WarehouseCoverScopeStaleError';
  }
}

export function warehouseCoverScopeKey(orderId: string) {
  return `warehouse_cover:${orderId}`;
}

export function projectWarehouseCoverRequestCase(resolutionCase: {
  id: string;
  orderId: string;
  status: string;
  ownerRole: Role;
  affectedPositionIds: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): WarehouseCoverRequestCase {
  if (resolutionCase.status !== 'open' || resolutionCase.ownerRole !== 'warehouse') {
    throw new ConflictException('Warehouse cover task is no longer actionable');
  }
  const affectedPositionIds = Array.isArray(resolutionCase.affectedPositionIds)
    ? resolutionCase.affectedPositionIds.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  return {
    id: resolutionCase.id,
    orderId: resolutionCase.orderId,
    state: 'open',
    ownerRole: 'warehouse',
    affectedPositionIds,
    requestedAt: resolutionCase.createdAt.toISOString(),
    updatedAt: resolutionCase.updatedAt.toISOString(),
  };
}

export function projectWarehouseCoverRequestOrder(order: {
  id: string;
  orderNumber: string;
  version: number;
  warehouseCoverStatus: string;
}): WarehouseCoverRequestOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    version: order.version,
    warehouseCoverStatus: order.warehouseCoverStatus as WarehouseCoverStatus,
  };
}

export function assertWarehouseCoverActionable(order: ActionableCoverOrder) {
  if (!WAREHOUSE_COVER_ACTIONABLE_STAGES.some((stage) => stage === order.commercialStage)) {
    throw new ConflictException('Warehouse cover cannot be requested for this order stage');
  }
  if (order.readyForShipmentAt || order.shipmentCompletedAt || order.shipmentStatus === 'shipped') {
    throw new ConflictException('Warehouse cover cannot be requested for a completed order');
  }
  if (order.positions.length === 0) {
    throw new ConflictException('Warehouse cover requires at least one order position');
  }
}

export async function acquireWarehouseCoverCase(
  tx: Prisma.TransactionClient,
  input: AcquireCoverCaseInput,
) {
  const openScopeKey = warehouseCoverScopeKey(input.orderId);
  const existing = await tx.orderResolutionCase.findUnique({ where: { openScopeKey } });
  if (existing) {
    if (
      existing.orderId !== input.orderId ||
      existing.type !== 'warehouse_cover_check' ||
      existing.status !== 'open' ||
      existing.ownerRole !== 'warehouse'
    ) {
      throw new ConflictException('Warehouse cover task scope is occupied by an incompatible case');
    }
    const currentPositionIds = Array.isArray(existing.affectedPositionIds)
      ? existing.affectedPositionIds.filter((value): value is string => typeof value === 'string')
      : [];
    const affectedPositionIds = [
      ...currentPositionIds,
      ...input.affectedPositionIds.filter((positionId) => !currentPositionIds.includes(positionId)),
    ];
    if (affectedPositionIds.length === currentPositionIds.length) {
      return { case: existing, created: false, scopeExpanded: false } as const;
    }
    const expanded = await tx.orderResolutionCase.updateMany({
      where: {
        id: existing.id,
        version: existing.version,
        status: 'open',
        openScopeKey,
      },
      data: { affectedPositionIds, version: { increment: 1 } },
    });
    if (expanded.count !== 1) {
      throw new WarehouseCoverScopeStaleError();
    }
    const expandedCase = await tx.orderResolutionCase.findUniqueOrThrow({
      where: { id: existing.id },
    });
    return { case: expandedCase, created: false, scopeExpanded: true } as const;
  }

  const resolutionCase = await tx.orderResolutionCase.create({
    data: {
      orderId: input.orderId,
      type: 'warehouse_cover_check',
      status: 'open',
      ownerRole: 'warehouse',
      openScopeKey,
      affectedPositionIds: input.affectedPositionIds,
      affectedRollIds: [],
      reason: input.reason,
      nextOwnerRole: 'warehouse',
      createdByRole: input.actorRole,
      createdById: input.actorId,
    },
  });
  return { case: resolutionCase, created: true, scopeExpanded: false } as const;
}

export async function withWarehouseCoverCaseTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(work);
    } catch (error) {
      if (!isWarehouseCoverTransactionConflict(error)) throw error;
      if (attempt === 2) {
        throw new ConflictException('Warehouse cover request conflicted; reload and retry');
      }
    }
  }
  throw new ConflictException('Warehouse cover request conflicted; reload and retry');
}

function isWarehouseCoverTransactionConflict(error: unknown) {
  if (error instanceof WarehouseCoverScopeStaleError) return true;
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.some((field) => field === 'openScopeKey')
    : typeof target === 'string' && target.includes('openScopeKey');
}
