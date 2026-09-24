import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Role,
  WarehouseCoverCriteria,
  WarehouseCoverProposalProjection,
  WarehouseCoverRoute,
  WarehouseCoverStatus,
  WarehouseCoverageWorkflowVersion,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../../common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  acquireWarehouseCoverCase,
  assertWarehouseCoverActionable,
  WAREHOUSE_COVER_ACTIONABLE_WHERE,
  withWarehouseCoverCaseTransaction,
} from '../../common/warehouse-cover-task';
import type {
  WarehouseCoverDecisionDto,
  WarehouseCoverRecheckDto,
  WarehouseCoverTechnicalApprovalDto,
} from './dto/warehouse-cover-decision.dto';
import { assertCoverageWorkflow } from '../warehouse-coverage/warehouse-coverage-workflow';

const COVER_PROPOSAL_INCLUDE = {
  position: true,
  order: { include: { positions: true } },
  matches: { include: { roll: true }, orderBy: { rollId: 'asc' } },
  reservedRolls: { orderBy: { id: 'asc' } },
} satisfies Prisma.WarehouseCoverProposalInclude;

type CoverProposalAggregate = Prisma.WarehouseCoverProposalGetPayload<{
  include: typeof COVER_PROPOSAL_INCLUDE;
}>;

type CoverActor = { userId: string | null; role: Role };

type PositionCompatibilityFacts = {
  filmType: string;
  actualThickness: string;
  birka: string | null;
  spoolType: string | null;
  plannedWeightKg: number | null;
};

@Injectable()
export class CommercialCoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fulfillmentHandoff: OrderFulfillmentHandoffService,
  ) {}

  approveCommercial(
    actor: CoverActor,
    orderId: string,
    positionId: string,
    proposalId: string,
    dto: WarehouseCoverDecisionDto,
  ) {
    return this.serializable(async (tx) => {
      await this.assertOrderWorkflow(tx, orderId, 1);
      const proposal = await this.loadProposal(tx, orderId, positionId, proposalId);

      if (proposal.commercialApprovedAt) {
        if (proposal.route !== dto.route) {
          throw new ConflictException(
            'Warehouse cover was already approved with a different route',
          );
        }
        return this.project(proposal);
      }
      this.assertVersion(proposal, dto.expectedVersion);
      this.assertFresh(proposal);

      if (dto.route !== 'production_only') {
        this.assertRouteMatchesQuantity(proposal, dto.route);
        this.assertCompatibleMatches(proposal);
      }

      const now = new Date();
      const isProductionOnly = dto.route === 'production_only';
      const nextStatus: WarehouseCoverStatus = isProductionOnly
        ? 'needs_production'
        : proposal.status === 'partial_proposed'
          ? 'partial_proposed'
          : 'full_proposed';
      const coverQty = isProductionOnly ? 0 : proposal.matches.length;
      const productionQty = Math.max(0, proposal.position.rollCount - coverQty);
      const updated = await tx.warehouseCoverProposal.updateMany({
        where: {
          id: proposal.id,
          version: dto.expectedVersion,
          commercialApprovedAt: null,
        },
        data: {
          route: dto.route,
          status: nextStatus,
          coverType: coverQty === proposal.position.rollCount ? 'full' : 'partial',
          coverQty,
          reserveQty: 0,
          productionQty,
          commercialApprovedById: actor.userId,
          commercialApprovedAt: now,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Warehouse cover proposal changed; reload and retry');
      }

      if (isProductionOnly) {
        await this.updatePositionAndOrder(tx, proposal, 'needs_production', productionQty);
      }

      await this.audit.record(
        {
          type: 'audit:warehouse_cover_commercial_approved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: {
            proposalId: proposal.id,
            version: proposal.version,
            route: proposal.route,
            status: proposal.status,
          },
          newValue: {
            proposalId: proposal.id,
            version: proposal.version + 1,
            route: dto.route,
            status: nextStatus,
            coverQty,
            productionQty,
          },
          detail: { positionId, matchedRollIds: proposal.matches.map((match) => match.rollId) },
        },
        tx,
      );

      return this.project({
        ...proposal,
        route: dto.route,
        status: nextStatus,
        version: proposal.version + 1,
        coverQty,
        reserveQty: 0,
        productionQty,
        commercialApprovedById: actor.userId,
        commercialApprovedAt: now,
      });
    });
  }

  finalizeTechnicalApproval(
    actor: CoverActor,
    orderId: string,
    positionId: string,
    proposalId: string,
    dto: WarehouseCoverTechnicalApprovalDto,
  ) {
    return this.serializable(async (tx) => {
      await this.assertOrderWorkflow(tx, orderId, 1);
      const proposal = await this.loadProposal(tx, orderId, positionId, proposalId);
      if (proposal.technicalApprovedAt) {
        this.assertFinalReservation(proposal);
        return this.project(proposal);
      }

      this.assertVersion(proposal, dto.expectedVersion);
      this.assertFresh(proposal);
      if (!proposal.commercialApprovedAt) {
        throw new ConflictException('Commercial approval is required first');
      }
      if (proposal.route === 'production_only') {
        throw new BadRequestException('Production-only route does not need technical approval');
      }
      this.assertRouteMatchesQuantity(proposal, proposal.route as WarehouseCoverRoute);
      this.assertCompatibleMatches(proposal);

      const now = new Date();
      const claimed = await tx.warehouseCoverProposal.updateMany({
        where: {
          id: proposal.id,
          version: dto.expectedVersion,
          technicalApprovedAt: null,
        },
        data: {
          technicalApprovedById: actor.userId,
          technicalApprovedAt: now,
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Warehouse cover proposal changed; reload and retry');
      }

      for (const match of proposal.matches) {
        const reserved = await tx.warehouseRoll.updateMany({
          where: {
            id: match.roll.id,
            reservedForOrderId: null,
            OR: [{ producedForOrderId: null }, { releasedFromOrderId: { not: null } }],
            warehouseStatus: 'received',
          },
          data: {
            reservedForOrderId: orderId,
            reservedForPositionId: positionId,
            reservedByProposalId: proposal.id,
            reservedAt: now,
          },
        });
        if (reserved.count !== 1) {
          throw new ConflictException(
            `Warehouse roll ${match.roll.rollCode} was reserved concurrently`,
          );
        }
      }

      const existingTask = await tx.warehouseAcceptanceTask.findFirst({
        where: { proposalId: proposal.id },
      });
      if (!existingTask) {
        await tx.warehouseAcceptanceTask.create({
          data: {
            mode: 'reserve',
            status: 'open',
            orderId,
            positionId,
            proposalId: proposal.id,
            rows: {
              create: proposal.matches.map((match) => ({
                rollCode: match.roll.rollCode,
                fromOrderId: proposal.order.orderNumber,
                scanStatus: 'expected',
              })),
            },
          },
        });
      }

      const status: WarehouseCoverStatus =
        proposal.route === 'full_cover' ? 'full_confirmed' : 'partial_confirmed';
      const coverQty = proposal.matches.length;
      const productionQty = Math.max(0, proposal.position.rollCount - coverQty);
      await tx.warehouseCoverProposal.update({
        where: { id: proposal.id },
        data: {
          status,
          coverQty,
          reserveQty: coverQty,
          productionQty,
        },
      });
      await this.updatePositionAndOrder(tx, proposal, status, productionQty);

      await this.audit.record(
        {
          type: 'audit:warehouse_cover_technical_approved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          oldValue: { proposalId: proposal.id, version: proposal.version, status: proposal.status },
          newValue: {
            proposalId: proposal.id,
            version: proposal.version + 1,
            status,
            coverQty,
            productionQty,
          },
          detail: { positionId },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'audit:warehouse_rolls_reserved_for_order',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          newValue: {
            proposalId: proposal.id,
            positionId,
            rollIds: proposal.matches.map((match) => match.roll.id),
          },
        },
        tx,
      );
      await this.fulfillmentHandoff.reconcile(actor, orderId, tx);

      return this.project({
        ...proposal,
        status,
        version: proposal.version + 1,
        coverQty,
        reserveQty: coverQty,
        productionQty,
        technicalApprovedById: actor.userId,
        technicalApprovedAt: now,
        reservedRolls: proposal.matches.map((match) => ({
          ...match.roll,
          reservedForOrderId: orderId,
          reservedForPositionId: positionId,
          reservedByProposalId: proposal.id,
          reservedAt: now,
        })),
      });
    });
  }

  requestRecheck(
    actor: CoverActor,
    orderId: string,
    positionId: string,
    proposalId: string,
    dto: WarehouseCoverRecheckDto,
  ) {
    return withWarehouseCoverCaseTransaction(this.prisma, async (tx) => {
      await this.assertOrderWorkflow(tx, orderId, 1);
      const proposal = await this.loadProposal(tx, orderId, positionId, proposalId);
      assertWarehouseCoverActionable(proposal.order);
      const acquired = await acquireWarehouseCoverCase(tx, {
        orderId,
        affectedPositionIds: [positionId],
        actorRole: actor.role,
        actorId: actor.userId,
        reason: dto.reason,
      });
      if (proposal.status === 'recheck_requested' && !acquired.created && !acquired.scopeExpanded) {
        return this.project(proposal);
      }
      const needsProposalTransition = proposal.status !== 'recheck_requested';
      if (needsProposalTransition) {
        this.assertVersion(proposal, dto.expectedVersion);
        if (proposal.technicalApprovedAt || proposal.reservedRolls.length > 0) {
          throw new ConflictException('Reserved warehouse cover cannot be rechecked');
        }
        const updated = await tx.warehouseCoverProposal.updateMany({
          where: { id: proposal.id, version: dto.expectedVersion },
          data: { status: 'recheck_requested', version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new ConflictException('Warehouse cover proposal changed; reload and retry');
        }
        await tx.commercialOrderPosition.update({
          where: { id: positionId },
          data: { warehouseCoverStatus: 'recheck_requested' },
        });
        const orderUpdated = await tx.commercialOrder.updateMany({
          where: {
            id: orderId,
            version: proposal.order.version,
            ...WAREHOUSE_COVER_ACTIONABLE_WHERE,
          },
          data: { warehouseCoverStatus: 'recheck_requested', version: { increment: 1 } },
        });
        if (orderUpdated.count !== 1) {
          throw new ConflictException('Warehouse cover order changed; reload and retry');
        }
      }
      const nextVersion = needsProposalTransition ? proposal.version + 1 : proposal.version;
      await this.audit.record(
        {
          type: 'audit:warehouse_cover_recheck_requested',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          reason: dto.reason,
          oldValue: { proposalId, version: proposal.version, status: proposal.status },
          newValue: {
            proposalId,
            version: nextVersion,
            status: 'recheck_requested',
          },
          detail: { positionId, caseId: acquired.case.id },
        },
        tx,
      );
      return this.project({
        ...proposal,
        version: nextVersion,
        status: 'recheck_requested',
      });
    });
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException(
          'Warehouse cover conflicted with another request; reload and retry',
        );
      }
      throw error;
    }
  }

  private async loadProposal(
    tx: Prisma.TransactionClient,
    orderId: string,
    positionId: string,
    proposalId: string,
  ) {
    const proposal = await tx.warehouseCoverProposal.findUnique({
      where: { id: proposalId },
      include: COVER_PROPOSAL_INCLUDE,
    });
    if (
      !proposal ||
      proposal.orderId !== orderId ||
      proposal.positionId !== positionId ||
      proposal.position.orderId !== orderId
    ) {
      throw new NotFoundException(
        `Warehouse cover proposal ${proposalId} not found for position ${positionId}`,
      );
    }
    return proposal;
  }

  private async assertOrderWorkflow(
    tx: Prisma.TransactionClient,
    orderId: string,
    expected: WarehouseCoverageWorkflowVersion,
  ): Promise<void> {
    const order = await tx.commercialOrder.findUnique({
      where: { id: orderId },
      select: { warehouseCoverageWorkflowVersion: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    assertCoverageWorkflow(
      order.warehouseCoverageWorkflowVersion as WarehouseCoverageWorkflowVersion,
      expected,
    );
  }

  private assertVersion(proposal: CoverProposalAggregate, expectedVersion: number) {
    if (proposal.version !== expectedVersion) {
      throw new ConflictException('Warehouse cover proposal changed; reload and retry');
    }
  }

  private assertFresh(proposal: CoverProposalAggregate) {
    if (proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('Warehouse cover proposal is stale; request a recheck');
    }
  }

  private assertRouteMatchesQuantity(proposal: CoverProposalAggregate, route: WarehouseCoverRoute) {
    const matchedQty = proposal.matches.length;
    if (route === 'full_cover' && matchedQty !== proposal.position.rollCount) {
      throw new BadRequestException('Full cover requires one compatible roll per requested roll');
    }
    if (
      route === 'partial_cover' &&
      (matchedQty < 1 || matchedQty >= proposal.position.rollCount)
    ) {
      throw new BadRequestException('Partial cover requires a strict subset of requested rolls');
    }
  }

  private assertCompatibleMatches(proposal: CoverProposalAggregate) {
    for (const match of proposal.matches) {
      const criteria = evaluateWarehouseCoverCompatibility(
        proposal.position,
        match.roll.positionSnapshot,
      );
      if (!match.compatible || !criteriaAreCompatible(criteria)) {
        throw new BadRequestException(
          `Warehouse roll ${match.roll.rollCode} is not compatible with the order position`,
        );
      }
      if (match.roll.reservedForOrderId && match.roll.reservedByProposalId !== proposal.id) {
        throw new ConflictException(`Warehouse roll ${match.roll.rollCode} is already reserved`);
      }
      if (match.roll.warehouseStatus !== 'received') {
        throw new ConflictException(
          `Warehouse roll ${match.roll.rollCode} is not available for reservation`,
        );
      }
    }
  }

  private assertFinalReservation(proposal: CoverProposalAggregate) {
    const expectedRollIds = new Set(proposal.matches.map((match) => match.rollId));
    const actualRollIds = new Set(
      proposal.reservedRolls
        .filter(
          (roll) =>
            roll.reservedForOrderId === proposal.orderId &&
            roll.reservedForPositionId === proposal.positionId &&
            roll.reservedByProposalId === proposal.id,
        )
        .map((roll) => roll.id),
    );
    if (
      expectedRollIds.size !== actualRollIds.size ||
      [...expectedRollIds].some((rollId) => !actualRollIds.has(rollId))
    ) {
      throw new ConflictException('Finalized warehouse cover has inconsistent reservations');
    }
  }

  private async updatePositionAndOrder(
    tx: Prisma.TransactionClient,
    proposal: CoverProposalAggregate,
    positionStatus: WarehouseCoverStatus,
    productionQty: number,
  ) {
    await tx.commercialOrderPosition.update({
      where: { id: proposal.positionId },
      data: { warehouseCoverStatus: positionStatus },
    });
    const statuses = proposal.order.positions.map((position) =>
      position.id === proposal.positionId ? positionStatus : position.warehouseCoverStatus,
    );
    const orderStatus = aggregateWarehouseCoverStatus(statuses);
    const productionRequired =
      productionQty > 0 ||
      proposal.order.positions.some(
        (position) =>
          position.id !== proposal.positionId && position.warehouseCoverStatus !== 'full_confirmed',
      );
    await tx.commercialOrder.update({
      where: { id: proposal.orderId },
      data: {
        warehouseCoverStatus: orderStatus,
        productionIndicator: productionRequired ? 'needs_production' : 'not_started',
        version: { increment: 1 },
      },
    });
  }

  private project(proposal: CoverProposalAggregate): WarehouseCoverProposalProjection {
    const stale = Boolean(proposal.expiresAt && proposal.expiresAt.getTime() <= Date.now());
    return {
      id: proposal.id,
      orderId: proposal.orderId,
      positionId: proposal.positionId,
      version: proposal.version,
      route: proposal.route as WarehouseCoverRoute,
      status: proposal.status as WarehouseCoverStatus,
      coverQty: proposal.coverQty,
      reserveQty: proposal.reserveQty,
      productionQty: proposal.productionQty,
      sourceCapturedAt: proposal.sourceCapturedAt.toISOString(),
      expiresAt: proposal.expiresAt?.toISOString() ?? null,
      stale,
      commercialApproved: Boolean(proposal.commercialApprovedAt),
      technicalApproved: Boolean(proposal.technicalApprovedAt),
      matches: proposal.matches.map((match) => {
        const criteria = evaluateWarehouseCoverCompatibility(
          proposal.position,
          match.roll.positionSnapshot,
        );
        return {
          rollId: match.roll.id,
          rollCode: match.roll.rollCode,
          compatible: match.compatible && criteriaAreCompatible(criteria),
          criteria,
        };
      }),
    };
  }
}

export function evaluateWarehouseCoverCompatibility(
  position: PositionCompatibilityFacts,
  snapshot: Prisma.JsonValue | null,
): WarehouseCoverCriteria {
  const value = isJsonObject(snapshot) ? snapshot : {};
  const expectedWeight = finiteNumber(position.plannedWeightKg);
  const actualWeight = finiteNumber(value.plannedWeightKg);
  return {
    filmType: criterion(
      position.filmType,
      stringValue(value.filmType),
      normalizedText(position.filmType) === normalizedText(stringValue(value.filmType)),
    ),
    actualThickness: criterion(
      position.actualThickness,
      stringValue(value.actualThickness),
      normalizedMeasurement(position.actualThickness) ===
        normalizedMeasurement(stringValue(value.actualThickness)),
    ),
    birka: criterion(
      position.birka,
      stringValue(value.birka),
      normalizedText(position.birka) === normalizedText(stringValue(value.birka)),
    ),
    spoolType: criterion(
      position.spoolType,
      stringValue(value.spoolType),
      normalizedSpool(position.spoolType) === normalizedSpool(stringValue(value.spoolType)),
    ),
    weight: criterion(
      expectedWeight,
      actualWeight,
      expectedWeight !== null &&
        actualWeight !== null &&
        Math.abs(expectedWeight - actualWeight) < 0.001,
    ),
  };
}

export function criteriaAreCompatible(criteria: WarehouseCoverCriteria) {
  return Object.values(criteria).every((item) => item.matches);
}

function criterion(
  expected: string | number | null,
  actual: string | number | null,
  matches: boolean,
) {
  return { expected, actual, matches: expected !== null && actual !== null && matches };
}

function isJsonObject(value: Prisma.JsonValue | null): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: Prisma.JsonValue | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value: Prisma.JsonValue | number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedText(value: string | null) {
  return (
    value
      ?.toLocaleLowerCase('ru-RU')
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]+/gi, '') ?? ''
  );
}

function normalizedMeasurement(value: string | null) {
  const numeric = value?.replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0];
  return numeric ? Number(numeric).toString() : normalizedText(value);
}

function normalizedSpool(value: string | null) {
  return normalizedText(value).replace(/^шпуля/, '');
}

function aggregateWarehouseCoverStatus(statuses: string[]): WarehouseCoverStatus {
  if (statuses.some((status) => status === 'recheck_requested')) return 'recheck_requested';
  if (statuses.length > 0 && statuses.every((status) => status === 'full_confirmed')) {
    return 'full_confirmed';
  }
  if (statuses.some((status) => ['partial_confirmed', 'full_confirmed'].includes(status))) {
    return 'partial_confirmed';
  }
  if (statuses.length > 0 && statuses.every((status) => status === 'needs_production')) {
    return 'needs_production';
  }
  if (statuses.some((status) => ['partial_proposed', 'full_proposed'].includes(status))) {
    return 'partial_proposed';
  }
  return 'not_checked';
}
