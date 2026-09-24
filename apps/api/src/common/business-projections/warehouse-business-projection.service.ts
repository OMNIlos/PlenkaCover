import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  WarehouseBusinessPage,
  WarehouseBusinessQuery,
  WarehouseBusinessRow,
  WarehouseBusinessRowKind,
  WarehouseBusinessStatus,
  WarehouseBusinessTemplate,
} from '@plenka/contracts';
import { requestFingerprint } from '../idempotency/request-fingerprint';
import { PrismaService } from '../prisma/prisma.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../../modules/warehouse-coverage/warehouse-coverage-canonical';
import { WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION } from '../../modules/warehouse-coverage/warehouse-roll-coverage-fact.service';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;

const WAREHOUSE_BUSINESS_DETAIL_SELECT = {
  id: true,
  rollCode: true,
  warehouseStatus: true,
  ownerCounterpartyId: true,
  producedForStockOrderId: true,
  producedForOrderId: true,
  releasedFromOrderId: true,
  producedForOrder: { select: { id: true } },
  producedForPositionId: true,
  producedForPosition: { select: { id: true, orderId: true } },
  producedByCoverageDecisionId: true,
  producedByCoverageDecision: { select: { id: true, orderId: true, kind: true } },
  reservedForOrderId: true,
  reservedForPositionId: true,
  reservedForPosition: { select: { orderId: true } },
  reservedByProposalId: true,
  reservedByProposal: { select: { orderId: true, positionId: true } },
  reservedByCoverageDecisionId: true,
  reservedByCoverageDecision: { select: { orderId: true } },
  reservedAt: true,
  currentCoverageFactId: true,
  currentCoverageFact: {
    select: {
      id: true,
      rollId: true,
      specVersion: true,
      specFingerprint: true,
      spec: true,
      sourceOrderId: true,
      sourcePositionId: true,
      sourceOrder: {
        select: {
          id: true,
          requestType: true,
          warehouseCoverageWorkflowVersion: true,
          cancellationStatus: true,
        },
      },
      sourcePosition: { select: { id: true, orderId: true } },
    },
  },
} satisfies Prisma.WarehouseRollSelect;

type WarehouseBusinessRoll = Prisma.WarehouseRollGetPayload<{
  select: typeof WAREHOUSE_BUSINESS_DETAIL_SELECT;
}>;

type GroupPageRow = {
  kind: WarehouseBusinessRowKind | null;
  id: string | null;
  rollIds: string[] | null;
  total: number;
  orderNumber: string | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
};

type TemplateSeed = Omit<WarehouseBusinessTemplate, 'fingerprint'> & {
  ingredients: ReadonlyArray<{ rawMaterialDefinitionId: string; shareBasisPoints: number }>;
  recipeId: string | null;
  recipeDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeVersionNumber: number | null;
};

type GroupIdentity = { kind: WarehouseBusinessRowKind; id: string };

function normalizeQuery(query: WarehouseBusinessQuery) {
  return {
    page: query.page ?? DEFAULT_PAGE,
    pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

function safeTemplate(row: WarehouseBusinessRoll): WarehouseBusinessTemplate | null {
  const fact = row.currentCoverageFact;
  if (!fact || fact.specVersion !== WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION) return null;
  try {
    const spec = canonicalizeRollCoverageSpec(fact.spec);
    if (fingerprintRollFact(spec) !== fact.specFingerprint) return null;
    const seed: TemplateSeed = {
      filmType: spec.filmType,
      actualThicknessMicron: spec.actualThicknessMilliMicron / 1_000,
      accountingThicknessMicron: spec.accountingThicknessMilliMicron / 1_000,
      widthMm: spec.widthMilliMm / 1_000,
      plannedLengthM: spec.plannedLengthMilliM / 1_000,
      birka: spec.birka,
      spoolType: spec.spoolType,
      plannedWeightKg: spec.plannedWeightMilliKg / 1_000,
      recipeVersion: spec.recipeVersion,
      ingredients: spec.ingredients,
      recipeId: spec.recipeId,
      recipeDefinitionId: spec.recipeDefinitionId,
      recipeDefinitionVersionId: spec.recipeDefinitionVersionId,
      recipeVersionNumber: spec.recipeVersionNumber,
    };
    const fingerprint = requestFingerprint(seed);
    const {
      ingredients: _ingredients,
      recipeId: _recipeId,
      recipeDefinitionId: _recipeDefinitionId,
      recipeDefinitionVersionId: _recipeDefinitionVersionId,
      recipeVersionNumber: _recipeVersionNumber,
      ...template
    } = seed;
    return { fingerprint, ...template };
  } catch {
    return null;
  }
}

function hasCanonicalProvenance(row: WarehouseBusinessRoll): boolean {
  const fact = row.currentCoverageFact;
  const sourceOrder = fact?.sourceOrder;
  const sourcePosition = fact?.sourcePosition;
  const spec = fact?.spec;
  if (
    !fact ||
    fact.specVersion !== WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION ||
    fact.id !== row.currentCoverageFactId ||
    fact.rollId !== row.id ||
    !sourceOrder ||
    sourceOrder.id !== fact.sourceOrderId ||
    !sourcePosition ||
    sourcePosition.id !== fact.sourcePositionId ||
    sourcePosition.orderId !== fact.sourceOrderId ||
    !spec ||
    Array.isArray(spec) ||
    typeof spec !== 'object' ||
    spec.rollCode !== row.rollCode ||
    spec.sourceOrderId !== fact.sourceOrderId ||
    spec.sourcePositionId !== fact.sourcePositionId
  ) {
    return false;
  }

  if (row.releasedFromOrderId) {
    return (
      row.releasedFromOrderId === sourceOrder.id &&
      sourceOrder.cancellationStatus === 'cancelled' &&
      row.ownerCounterpartyId === null
    );
  }
  if (sourceOrder.requestType === 'client_order') {
    const hasNoReservationProvenance =
      row.reservedForPositionId === null &&
      row.reservedForPosition === null &&
      row.reservedByProposalId === null &&
      row.reservedByProposal === null &&
      row.reservedByCoverageDecisionId === null &&
      row.reservedByCoverageDecision === null &&
      row.reservedAt === null;
    if (sourceOrder.warehouseCoverageWorkflowVersion === 1) {
      return (
        row.producedForStockOrderId === null &&
        row.producedForOrderId === null &&
        row.producedForOrder === null &&
        row.producedForPositionId === null &&
        row.producedForPosition === null &&
        row.producedByCoverageDecisionId === null &&
        row.producedByCoverageDecision === null &&
        row.reservedForOrderId === fact.sourceOrderId &&
        hasNoReservationProvenance
      );
    }
    const productionDecision = row.producedByCoverageDecision;
    return (
      sourceOrder.warehouseCoverageWorkflowVersion === 2 &&
      row.producedForStockOrderId === null &&
      row.producedForOrderId === fact.sourceOrderId &&
      row.producedForOrder?.id === fact.sourceOrderId &&
      row.producedForPositionId === fact.sourcePositionId &&
      row.producedForPosition?.id === fact.sourcePositionId &&
      row.producedForPosition.orderId === fact.sourceOrderId &&
      row.producedByCoverageDecisionId !== null &&
      productionDecision?.id === row.producedByCoverageDecisionId &&
      productionDecision.orderId === fact.sourceOrderId &&
      (productionDecision.kind === 'produce_all' ||
        productionDecision.kind === 'auto_produce_all') &&
      row.reservedForOrderId === null &&
      hasNoReservationProvenance
    );
  }
  return (
    sourceOrder.requestType === 'stock_reserve' &&
    row.producedForStockOrderId === fact.sourceOrderId &&
    row.producedForOrderId === null &&
    row.producedForOrder === null &&
    row.producedForPositionId === null &&
    row.producedForPosition === null &&
    row.producedByCoverageDecisionId === null &&
    row.producedByCoverageDecision === null
  );
}

function resolveGroupIdentity(
  row: WarehouseBusinessRoll,
  targetCounterpartyId: string | null,
): GroupIdentity | null {
  if (!hasCanonicalProvenance(row)) return null;
  const sourceOrder = row.currentCoverageFact?.sourceOrder;
  if (!sourceOrder) return null;
  if (
    (row.reservedForPositionId && !row.reservedForPosition) ||
    (row.reservedByProposalId && !row.reservedByProposal) ||
    (row.reservedByCoverageDecisionId && !row.reservedByCoverageDecision)
  ) {
    return null;
  }
  if (
    row.reservedForPositionId &&
    row.reservedByProposal?.positionId &&
    row.reservedForPositionId !== row.reservedByProposal.positionId
  ) {
    return null;
  }

  const linkedOrderIds = [
    row.reservedForOrderId,
    row.reservedForPosition?.orderId,
    row.reservedByProposal?.orderId,
    row.reservedByCoverageDecision?.orderId,
  ].filter((id): id is string => Boolean(id));
  const uniqueOrderIds = new Set(linkedOrderIds);

  if (sourceOrder.requestType === 'client_order' && !row.releasedFromOrderId) {
    if ([...uniqueOrderIds].some((id) => id !== sourceOrder.id)) return null;
    if (row.ownerCounterpartyId && row.ownerCounterpartyId !== targetCounterpartyId) return null;
    return { kind: 'client_order', id: sourceOrder.id };
  }
  if (
    (!row.releasedFromOrderId && sourceOrder.requestType !== 'stock_reserve') ||
    uniqueOrderIds.size > 1
  )
    return null;

  const allocatedOrderId = linkedOrderIds[0] ?? null;
  if (allocatedOrderId) {
    if (row.ownerCounterpartyId && row.ownerCounterpartyId !== targetCounterpartyId) return null;
    return { kind: 'client_order', id: allocatedOrderId };
  }
  if (row.ownerCounterpartyId || row.reservedAt) return null;
  return { kind: 'reserve', id: sourceOrder.id };
}

function groupStatus(
  kind: WarehouseBusinessRowKind,
  rows: WarehouseBusinessRoll[],
): WarehouseBusinessStatus | null {
  if (!rows.some(({ warehouseStatus }) => warehouseStatus === 'received')) return null;
  if (
    rows.some(
      ({ warehouseStatus }) => warehouseStatus !== 'received' && warehouseStatus !== 'delivered',
    )
  ) {
    return null;
  }
  if (rows.some(({ warehouseStatus }) => warehouseStatus === 'delivered')) return 'processing';
  return kind === 'reserve' ? 'reserve' : 'awaiting_shipment';
}

function compareTemplates(left: WarehouseBusinessTemplate, right: WarehouseBusinessTemplate) {
  return (
    left.filmType.localeCompare(right.filmType, 'ru-RU') ||
    left.actualThicknessMicron - right.actualThicknessMicron ||
    left.widthMm - right.widthMm ||
    left.plannedLengthM - right.plannedLengthM ||
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

@Injectable()
export class WarehouseBusinessProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: WarehouseBusinessQuery): Promise<WarehouseBusinessPage> {
    const { page, pageSize } = normalizeQuery(query);
    const offset = (page - 1) * pageSize;
    const groupPage = await this.prisma.$queryRaw<GroupPageRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT
          roll.id AS roll_id,
          roll."warehouseStatus" AS warehouse_status,
          roll."ownerCounterpartyId" AS owner_counterparty_id,
          roll."reservedForOrderId" AS reserved_order_id,
          roll."reservedForPositionId" AS reserved_position_id,
          reserved_position."orderId" AS position_order_id,
          roll."reservedByProposalId" AS reserved_proposal_id,
          proposal."orderId" AS proposal_order_id,
          proposal."positionId" AS proposal_position_id,
          roll."reservedByCoverageDecisionId" AS reserved_decision_id,
          decision."orderId" AS decision_order_id,
          roll."reservedAt" AS reserved_at,
          source_order.id AS source_order_id,
          CASE WHEN roll."releasedFromOrderId" IS NOT NULL THEN 'stock_reserve'
            ELSE source_order."requestType" END AS source_request_type,
          source_order."warehouseCoverageWorkflowVersion" AS source_workflow_version
        FROM warehouse_rolls AS roll
        INNER JOIN warehouse_roll_coverage_facts AS fact
          ON fact.id = roll."currentCoverageFactId"
          AND fact."rollId" = roll.id
        INNER JOIN commercial_orders AS source_order
          ON source_order.id = fact."sourceOrderId"
        INNER JOIN commercial_order_positions AS source_position
          ON source_position.id = fact."sourcePositionId"
          AND source_position."orderId" = fact."sourceOrderId"
        LEFT JOIN commercial_orders AS produced_order
          ON produced_order.id = roll."producedForOrderId"
        LEFT JOIN commercial_order_positions AS produced_position
          ON produced_position.id = roll."producedForPositionId"
        LEFT JOIN warehouse_coverage_decisions AS produced_decision
          ON produced_decision.id = roll."producedByCoverageDecisionId"
        LEFT JOIN commercial_order_positions AS reserved_position
          ON reserved_position.id = roll."reservedForPositionId"
        LEFT JOIN warehouse_cover_proposals AS proposal
          ON proposal.id = roll."reservedByProposalId"
        LEFT JOIN warehouse_coverage_decisions AS decision
          ON decision.id = roll."reservedByCoverageDecisionId"
        WHERE roll."warehouseStatus" IN ('received', 'delivered')
          AND fact."specVersion" = ${WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION}
          AND jsonb_typeof(fact."spec") = 'object'
          AND jsonb_typeof(fact."spec" -> 'rollCode') = 'string'
          AND jsonb_typeof(fact."spec" -> 'sourceOrderId') = 'string'
          AND jsonb_typeof(fact."spec" -> 'sourcePositionId') = 'string'
          AND fact."spec" ->> 'rollCode' = roll."rollCode"
          AND fact."spec" ->> 'sourceOrderId' = fact."sourceOrderId"
          AND fact."spec" ->> 'sourcePositionId' = fact."sourcePositionId"
          AND (
            (roll."releasedFromOrderId" = source_order.id
              AND source_order."cancellationStatus" = 'cancelled'
              AND roll."ownerCounterpartyId" IS NULL)
            OR (
              source_order."requestType" = 'client_order'
              AND source_order."warehouseCoverageWorkflowVersion" = 1
              AND roll."producedForStockOrderId" IS NULL
              AND roll."producedForOrderId" IS NULL
              AND produced_order.id IS NULL
              AND roll."producedForPositionId" IS NULL
              AND produced_position.id IS NULL
              AND roll."producedByCoverageDecisionId" IS NULL
              AND produced_decision.id IS NULL
              AND roll."reservedForOrderId" = fact."sourceOrderId"
              AND roll."reservedForPositionId" IS NULL
              AND roll."reservedByProposalId" IS NULL
              AND roll."reservedByCoverageDecisionId" IS NULL
              AND roll."reservedAt" IS NULL
            )
            OR (
              source_order."requestType" = 'client_order'
              AND source_order."warehouseCoverageWorkflowVersion" = 2
              AND roll."producedForStockOrderId" IS NULL
              AND roll."producedForOrderId" = fact."sourceOrderId"
              AND produced_order.id = roll."producedForOrderId"
              AND roll."producedForPositionId" = fact."sourcePositionId"
              AND produced_position.id = roll."producedForPositionId"
              AND produced_position."orderId" = fact."sourceOrderId"
              AND produced_decision.id = roll."producedByCoverageDecisionId"
              AND produced_decision."orderId" = fact."sourceOrderId"
              AND produced_decision."kind" IN ('produce_all', 'auto_produce_all')
              AND roll."reservedForOrderId" IS NULL
              AND roll."reservedForPositionId" IS NULL
              AND roll."reservedByProposalId" IS NULL
              AND roll."reservedByCoverageDecisionId" IS NULL
              AND roll."reservedAt" IS NULL
            )
            OR (
              source_order."requestType" = 'stock_reserve'
              AND roll."producedForStockOrderId" = fact."sourceOrderId"
              AND roll."producedForOrderId" IS NULL
              AND produced_order.id IS NULL
              AND roll."producedForPositionId" IS NULL
              AND produced_position.id IS NULL
              AND roll."producedByCoverageDecisionId" IS NULL
              AND produced_decision.id IS NULL
            )
          )
      ),
      linked AS (
        SELECT
          candidates.*,
          COALESCE(
            reserved_order_id,
            position_order_id,
            proposal_order_id,
            decision_order_id
          ) AS allocation_order_id,
          (
            (reserved_position_id IS NULL OR position_order_id IS NOT NULL)
            AND (reserved_proposal_id IS NULL OR proposal_order_id IS NOT NULL)
            AND (reserved_decision_id IS NULL OR decision_order_id IS NOT NULL)
            AND (
              reserved_position_id IS NULL
              OR proposal_position_id IS NULL
              OR reserved_position_id = proposal_position_id
            )
          ) AS links_complete
        FROM candidates
      ),
      resolved AS (
        SELECT
          linked.*,
          CASE
            WHEN source_request_type = 'client_order'
              AND links_complete
              AND (reserved_order_id IS NULL OR reserved_order_id = source_order_id)
              AND (position_order_id IS NULL OR position_order_id = source_order_id)
              AND (proposal_order_id IS NULL OR proposal_order_id = source_order_id)
              AND (decision_order_id IS NULL OR decision_order_id = source_order_id)
              THEN 'client_order'
            WHEN source_request_type = 'stock_reserve'
              AND links_complete
              AND (reserved_order_id IS NULL OR reserved_order_id = allocation_order_id)
              AND (position_order_id IS NULL OR position_order_id = allocation_order_id)
              AND (proposal_order_id IS NULL OR proposal_order_id = allocation_order_id)
              AND (decision_order_id IS NULL OR decision_order_id = allocation_order_id)
              AND (
                allocation_order_id IS NOT NULL
                OR (owner_counterparty_id IS NULL AND reserved_at IS NULL)
              )
              THEN CASE
                WHEN allocation_order_id IS NULL THEN 'reserve'
                ELSE 'client_order'
              END
            ELSE NULL
          END AS kind,
          CASE
            WHEN source_request_type = 'client_order' THEN source_order_id
            WHEN source_request_type = 'stock_reserve' THEN
              COALESCE(allocation_order_id, source_order_id)
            ELSE NULL
          END AS group_id
        FROM linked
      ),
      grouped AS (
        SELECT
          resolved.kind,
          resolved.group_id,
          ARRAY_AGG(resolved.roll_id ORDER BY resolved.roll_id) AS roll_ids,
          CASE WHEN resolved.kind = 'reserve' THEN NULL ELSE business_order."orderNumber" END
            AS order_number,
          CASE WHEN resolved.kind = 'reserve' THEN NULL ELSE business_order."counterpartyId" END
            AS counterparty_id,
          CASE WHEN resolved.kind = 'reserve' THEN NULL ELSE counterparty."displayName" END
            AS counterparty_name
        FROM resolved
        INNER JOIN commercial_orders AS business_order ON business_order.id = resolved.group_id
        LEFT JOIN counterparties AS counterparty
          ON counterparty.id = business_order."counterpartyId"
        WHERE resolved.kind IS NOT NULL
          AND business_order."shipmentStatus" <> 'shipped'
          AND (
            resolved.kind <> 'client_order'
            OR resolved.owner_counterparty_id IS NULL
            OR resolved.owner_counterparty_id = business_order."counterpartyId"
          )
          AND (
            (resolved.kind = 'reserve' AND (business_order."requestType" = 'stock_reserve'
              OR business_order."cancellationStatus" = 'cancelled'))
            OR (resolved.kind = 'client_order' AND business_order."requestType" = 'client_order')
          )
        GROUP BY
          resolved.kind,
          resolved.group_id,
          business_order."orderNumber",
          business_order."counterpartyId",
          counterparty."displayName"
        HAVING BOOL_OR(resolved.warehouse_status = 'received')
      ),
      totals AS (
        SELECT COUNT(*)::int AS total FROM grouped
      ),
      paged AS (
        SELECT *
        FROM grouped
        ORDER BY kind, COALESCE(order_number, group_id::text) COLLATE "C", group_id
        OFFSET ${offset}
        LIMIT ${pageSize}
      )
      SELECT
        paged.kind,
        paged.group_id AS id,
        paged.roll_ids AS "rollIds",
        totals.total,
        paged.order_number AS "orderNumber",
        paged.counterparty_id AS "counterpartyId",
        paged.counterparty_name AS "counterpartyName"
      FROM totals
      LEFT JOIN paged ON TRUE
      ORDER BY
        paged.kind,
        COALESCE(paged.order_number, paged.group_id::text) COLLATE "C",
        paged.group_id
    `);

    const total = groupPage[0]?.total ?? 0;
    const groups = groupPage.filter(
      (
        row,
      ): row is GroupPageRow & { kind: WarehouseBusinessRowKind; id: string; rollIds: string[] } =>
        (row.kind === 'client_order' || row.kind === 'reserve') &&
        typeof row.id === 'string' &&
        Array.isArray(row.rollIds) &&
        row.rollIds.length > 0,
    );
    const rollIds = [...new Set(groups.flatMap(({ rollIds: ids }) => ids))];
    if (rollIds.length === 0) return { items: [], page, pageSize, total };

    const rolls = await this.prisma.warehouseRoll.findMany({
      where: { id: { in: rollIds } },
      select: WAREHOUSE_BUSINESS_DETAIL_SELECT,
      orderBy: { id: 'asc' },
    });
    const rollsById = new Map(rolls.map((roll) => [roll.id, roll]));
    const items: WarehouseBusinessRow[] = [];

    for (const group of groups) {
      const groupRolls = group.rollIds
        .map((id) => rollsById.get(id))
        .filter((roll): roll is WarehouseBusinessRoll => Boolean(roll));
      if (groupRolls.length !== group.rollIds.length) continue;
      if (
        groupRolls.some((roll) => {
          const identity = resolveGroupIdentity(roll, group.counterpartyId);
          return !identity || identity.kind !== group.kind || identity.id !== group.id;
        })
      ) {
        continue;
      }
      const status = groupStatus(group.kind, groupRolls);
      if (!status) continue;
      const projectedTemplates = groupRolls.map(safeTemplate);
      const templates = new Map<string, WarehouseBusinessTemplate>();
      for (const template of projectedTemplates) {
        if (template) templates.set(template.fingerprint, template);
      }
      items.push({
        kind: group.kind,
        id: group.id,
        templates: [...templates.values()].sort(compareTemplates),
        status,
        orderNumber: group.kind === 'reserve' ? null : group.orderNumber,
        counterpartyName: group.kind === 'reserve' ? null : group.counterpartyName,
      });
    }

    return { items, page, pageSize, total };
  }
}
