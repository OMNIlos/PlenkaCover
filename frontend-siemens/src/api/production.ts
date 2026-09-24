import { ApiError, apiGet, apiPost, apiPut, type ApiRequestOptions } from './client';
import { isDeliveryUncertain } from './idempotentOperation';
import { auditEntry } from '../domain/prototypeRuntime';
import {
  normalizeWarehouseCoverage,
  type WarehouseCoverageView,
} from '../domain/warehouseCoverage';
import type {
  CommercialOrderRequest,
  OrderRollGroup,
  ProductionPriority,
  ProductionRollDispatchItem,
  WorkObject,
} from '../domain/types';

type ServerCounterparty = {
  id: string;
  displayName: string;
  legalName: string | null;
  inn: string | null;
  billingSource: string;
  syncStatus: string;
};

type ServerProductionCommercialOrder = {
  id: string;
  orderNumber: string;
  creatorRole: 'commercial' | 'production_lead';
  counterpartyId: string | null;
  requestType: 'client_order' | 'stock_reserve';
  productionIndicator: string;
  warehouseCoverStatus: string;
  paymentStatus: string;
  shipmentStatus: string;
  warehouseCoverageWorkflowVersion: 1 | 2;
  commercialConfirmationPolicy: 'required' | 'bypassed_by_delegation';
  createdAt: string;
  updatedAt: string;
  externalId: string | null;
  sourceVersion: string | null;
  counterparty: ServerCounterparty | null;
  stockBatchCode: string | null;
};

export type ServerRollDispatchItem = {
  id: string;
  rollCode: string;
  productionOrderId: string;
  orderLineId?: string | null;
  positionSequence?: number;
  rawMaterialId?: string | null;
  recipeVersion?: string | null;
  filmType?: string | null;
  plannedWeightKg?: number | null;
  plannedLengthM?: number | null;
  widthMm?: number | null;
  characteristicsSnapshot?: {
    actualThickness?: string | null;
    accountingThickness?: string | null;
    widthMm?: number | null;
    rawMaterialId?: string | null;
    spoolType?: string | null;
    birka?: string | null;
  } | null;
  assignedOperatorId?: string | null;
  assignedOperator?: { id: string; displayName: string } | null;
  plannedShiftId?: string | null;
  machineId?: string | null;
  postId?: string | null;
  post?: { id: string; code: string; name: string; status: string } | null;
  operatorLine?: {
    netKg?: number | null;
    step?: string | null;
    warehouseState?: string | null;
  } | null;
  workplaceId?: string | null;
  queueRank: number;
  priority: number;
  status: string;
  bulkGroupId?: string | null;
  replacesDispatchItemId?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ServerProductionOrder = {
  id: string;
  commercialOrderId: string;
  indicator: string;
  approvalState: 'pending' | 'approved';
  assignedOwnerId: string | null;
  blockers: string[];
  canApprove: boolean;
  approvalProblems: Array<{ rollId: string; reasons: string[] }>;
  coverage?: unknown;
  productionQty?: number;
  sourceGeneration?: number | null;
  defectRollCount: number;
  verifiedDefectKg: number;
  returnedSpoolCount: number;
  createdAt: string;
  updatedAt: string;
  commercialOrder: ServerProductionCommercialOrder;
  dispatchItems: ServerRollDispatchItem[];
};

export type ProductionPost = {
  id: string;
  code: string;
  name: string;
  status: string;
  agentStatus: string;
  lastSeenAt?: string | null;
};

export type ProductionShift = {
  id: string;
  label: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status: 'planned' | 'open' | 'closed';
  operationKey?: string | null;
  machineAssignments?: OperatorMachineAssignment[];
};

export type OperatorMachineAssignment = {
  id: string;
  shiftId: string;
  operatorId: string;
  postId: string;
  status: 'planned' | 'locked' | 'breakdown_reassigned' | 'completed' | 'cancelled';
  lockedAt?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  breakdownReason?: string | null;
  operator?: { id: string; displayName: string; isActive?: boolean };
  post?: Pick<ProductionPost, 'id' | 'code' | 'name' | 'status'>;
  machineChanges?: OperatorMachineChangeView[];
};

export type ProductionOperatorMachineView = {
  shift: ProductionShift;
  operators: Array<{ id: string; displayName: string }>;
};

export type ProductionOperatorOption = {
  operatorId: string;
  displayName: string;
  active: number;
  planned: number;
  total: number;
};

export type CreateIndividualOperatorShiftInput = {
  operatorId: string;
  postId: string;
  label?: string;
  operationKey: string;
};

export type IndividualOperatorShiftResult = {
  shift: ProductionShift & {
    plannedStartAt: null;
    plannedEndAt: null;
    status: 'planned';
    operationKey: string;
  };
  assignment: OperatorMachineAssignment & { status: 'planned' };
  dispatchItemIds: string[];
};

export type MachineChangeStatus =
  | 'requested'
  | 'awaiting_final_weight'
  | 'ready'
  | 'completed'
  | 'cancelled';

export type MachineChangePendingBigBag = {
  id: string;
  code: string;
};

export type OperatorMachineChangeView = {
  id: string;
  assignmentId: string;
  shiftId: string;
  operatorId: string;
  fromPostId: string;
  toPostId: string;
  fromPost: Pick<ProductionPost, 'id' | 'code' | 'name'>;
  toPost: Pick<ProductionPost, 'id' | 'code' | 'name'>;
  needsFinalWeight: boolean;
  pendingBigBags: MachineChangePendingBigBag[];
  reason: string;
  status: MachineChangeStatus;
  operationKey: string;
  requestedAt: string;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason?: string | null;
  updatedAt: string;
};

export type ProductionCancellationCommand = {
  operationKey: string;
  reason: string;
};

export type ProductionAssignmentCancellationResult = {
  commandId: string;
  assignmentId: string;
  shiftId: string;
  status: 'cancelled';
  releasedDispatchItemIds: string[];
  shiftClosed: false;
};

export type ProductionMachineChangeCancellationResult = {
  changeId: string;
  status: 'cancelled';
  cancelledAt: string;
  cancellationReason: string;
};

export type MachineChangeFinalizationView = {
  changeId: string;
  status: MachineChangeStatus;
  remainingBigBags: MachineChangePendingBigBag[];
  completedAt: string | null;
};

export type ProductionRollChange = {
  rollId: string;
  operatorId: string;
  priority?: number;
};

export type ProductionCommercialActionOrder = {
  id: string;
  orderNumber: string;
  requestType: 'client_order' | 'stock_reserve';
  stockBatchCode: string | null;
  counterparty: {
    id: string;
    displayName: string;
    legalName: string | null;
    inn: string | null;
  } | null;
  positionCount: number;
  requestedQty: number;
  nextAction: {
    code: string;
    ownerRole: string;
    label: string;
    allowed: boolean;
  };
  updatedAt: string;
};

type ProductionCommercialActionPage = {
  items: ProductionCommercialActionOrder[];
  nextCursor: string | null;
};

export const PRODUCTION_COMMERCIAL_ACTION_PAGE_LIMIT = 100;

type ProductionTechnicalCoverDetail = {
  positions: Array<{
    id: string;
    coverProposals: Array<{
      id: string;
      version: number;
      stale: boolean;
      commercialApproved: boolean;
      technicalApproved: boolean;
    }>;
  }>;
};

export async function fetchProductionOrders(options?: ApiRequestOptions): Promise<WorkObject[]> {
  try {
    const orders = parseProductionOrdersResponse(
      await apiGet<unknown>('/api/production/orders', options),
    );
    return orders.map(serverProductionOrderToWorkObject);
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.status !== 422 ||
      !['PRODUCTION_ORDER_RESPONSE_TOO_LARGE', 'PRODUCTION_ORDER_CATALOG_TOO_LARGE'].includes(error.code ?? '')
    ) {
      throw error;
    }
    const buckets = await Promise.all(
      ['needs_approval', 'approved'].map(async (bucket) =>
        parseProductionOrdersResponse(
          await apiGet<unknown>(`/api/production/orders?bucket=${bucket}`, options),
        ),
      ),
    );
    return [...new Map(buckets.flat().map((order) => [order.id, order])).values()].map(
      serverProductionOrderToWorkObject,
    );
  }
}

export function normalizeProductionWarehouseCoverage(input: unknown): WarehouseCoverageView {
  return normalizeWarehouseCoverage(input);
}

export async function fetchProductionCommercialActions(
  options?: ApiRequestOptions,
): Promise<ProductionCommercialActionOrder[]> {
  const pages = await Promise.all(
    ['incoming', 'in_work'].map(async (bucket) => {
      const items: ProductionCommercialActionOrder[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;

      for (let pageIndex = 0; pageIndex < PRODUCTION_COMMERCIAL_ACTION_PAGE_LIMIT; pageIndex += 1) {
        const query = new URLSearchParams({ bucket, mode: 'action_required', limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const page = parseProductionCommercialActionPage(
          await apiGet<unknown>(`/api/commercial/orders?${query.toString()}`, options),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        if (seenCursors.has(page.nextCursor)) {
          throw new Error('Зацикленная пагинация очереди коммерческих действий.');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      throw new Error('Превышен лимит страниц очереди коммерческих действий.');
    }),
  );
  return Array.from(new Map(pages.flat().map((order) => [order.id, order])).values());
}

export async function fetchProductionLiveOrders(
  options?: ApiRequestOptions,
): Promise<WorkObject[]> {
  const [productionOrders, commercialActions] = await Promise.all([
    fetchProductionOrders(options),
    fetchProductionCommercialActions(options),
  ]);
  return mergeProductionOrdersWithCommercialActions(productionOrders, commercialActions);
}

export type ProductionLiveOrdersResult = {
  orders: WorkObject[];
  commercialActionsState: 'ready' | 'error';
};

export class ProductionTechnicalCoverReconciliationError extends Error {
  readonly name = 'ProductionTechnicalCoverReconciliationError';

  constructor(
    readonly orderId: string,
    readonly approvedProposalIds: string[],
    readonly uncertainProposalId: string,
    readonly unattemptedProposalIds: string[],
    readonly originalError: unknown,
  ) {
    super('Результат подтверждения нужно сверить перед повтором.');
  }
}

export async function fetchProductionLiveOrdersWithStatus(
  options?: ApiRequestOptions,
): Promise<ProductionLiveOrdersResult> {
  const [productionResult, commercialActionsResult] = await Promise.allSettled([
    fetchProductionOrders(options),
    fetchProductionCommercialActions(options),
  ]);
  if (productionResult.status === 'rejected') throw productionResult.reason;
  if (commercialActionsResult.status === 'rejected') {
    if (options?.signal?.aborted) throw commercialActionsResult.reason;
    return {
      orders: productionResult.value,
      commercialActionsState: 'error',
    };
  }
  return {
    orders: mergeProductionOrdersWithCommercialActions(
      productionResult.value,
      commercialActionsResult.value,
    ),
    commercialActionsState: 'ready',
  };
}

export async function approveProductionTechnicalCover(orderId: string): Promise<{
  orderId: string;
  approvedProposalIds: string[];
}> {
  const detail = await apiGet<ProductionTechnicalCoverDetail>(
    `/api/commercial/orders/${encodeURIComponent(orderId)}`,
  );
  const proposals = detail.positions.flatMap((position) =>
    position.coverProposals
      .filter(
        (proposal) => proposal.commercialApproved && !proposal.stale && !proposal.technicalApproved,
      )
      .map((proposal) => ({ positionId: position.id, proposal })),
  );

  const approvedProposalIds: string[] = [];
  for (const [index, { positionId, proposal }] of proposals.entries()) {
    try {
      await apiPost(
        `/api/commercial/orders/${encodeURIComponent(orderId)}/positions/${encodeURIComponent(positionId)}/warehouse-cover/${encodeURIComponent(proposal.id)}/technical-approval`,
        { expectedVersion: proposal.version },
      );
      approvedProposalIds.push(proposal.id);
    } catch (error) {
      throw new ProductionTechnicalCoverReconciliationError(
        orderId,
        approvedProposalIds,
        proposal.id,
        proposals.slice(index + 1).map(({ proposal: pending }) => pending.id),
        error,
      );
    }
  }

  return { orderId, approvedProposalIds };
}

function commercialTechnicalCoverRow(order: ProductionCommercialActionOrder): WorkObject {
  const stockOrder = order.requestType === 'stock_reserve';
  const counterparty = stockOrder ? order.stockBatchCode! : order.counterparty!.displayName;
  return {
    id: order.id,
    kind: 'productionOrder',
    title: `Готовность к выпуску ${order.orderNumber}`,
    statusLabel: 'Требует решения',
    nextOwner: 'Зав. производства',
    severity: 'warning',
    filterTags: [
      'Заказ-наряды',
      'Требуют действия',
      'Готовность к выпуску',
      ...(stockOrder ? ['На запас'] : []),
    ],
    facts: [
      { label: 'Номер', value: order.orderNumber, scope: 'production' },
      {
        label: stockOrder ? 'Режим' : 'Контрагент',
        value: counterparty,
        scope: 'production',
      },
      { label: 'Позиции', value: `${order.positionCount} поз.`, scope: 'production' },
      { label: 'Рулоны', value: `${order.requestedQty} рул.`, scope: 'production' },
    ],
    sections: [
      {
        id: 'production-technical-cover-summary',
        title: 'Готовность к выпуску',
        facts: [
          { label: 'Заказ', value: order.orderNumber, scope: 'production' },
          {
            label: stockOrder ? 'Режим' : 'Контрагент',
            value: counterparty,
            scope: 'production',
          },
          { label: 'Позиции', value: `${order.positionCount} поз.`, scope: 'production' },
          { label: 'Объём', value: `${order.requestedQty} рул.`, scope: 'production' },
        ],
      },
    ],
    actions: [
      {
        id: `production-technical-approve-cover:${order.id}`,
        label: order.nextAction.label,
        level: 'recommended',
        enabled: true,
      },
    ],
    problems: [],
    audit: [
      {
        id: `commercial-action-required:${order.id}`,
        objectId: order.id,
        time: order.updatedAt,
        actorLabel: 'Система',
        actionLabel: 'audit:warehouse_cover_commercial_approved',
        detail: `Заказ ${order.orderNumber} ожидает подтверждения возможности выпуска.`,
        scope: 'production',
      },
    ],
  };
}

export function mergeProductionOrdersWithCommercialActions(
  productionOrders: ReadonlyArray<WorkObject>,
  commercialOrders: ReadonlyArray<ProductionCommercialActionOrder>,
): WorkObject[] {
  const existingIds = new Set(productionOrders.map((order) => order.id));
  const productionCommercialOrderIds = new Set(
    productionOrders.flatMap((order) =>
      order.commercialOrder?.id ? [order.commercialOrder.id] : [],
    ),
  );
  const merged = [...productionOrders];

  for (const order of commercialOrders) {
    if (
      order.nextAction.code !== 'technical_approve_cover' ||
      order.nextAction.ownerRole !== 'production_lead' ||
      !order.nextAction.allowed ||
      existingIds.has(order.id) ||
      productionCommercialOrderIds.has(order.id)
    ) {
      continue;
    }
    merged.push(commercialTechnicalCoverRow(order));
    existingIds.add(order.id);
  }

  return merged;
}

const PRODUCTION_INDICATORS = new Set([
  'not_started',
  'needs_production',
  'in_production',
  'ready',
  'needs_approval',
  'defect',
]);
const PRODUCTION_WAREHOUSE_COVER_STATUSES = new Set([
  'not_checked',
  'partial_proposed',
  'full_proposed',
  'partial_confirmed',
  'full_confirmed',
  'needs_production',
  'recheck_requested',
  'rejected',
]);
const PRODUCTION_PAYMENT_STATUSES = new Set([
  'unpaid',
  'partial',
  'paid',
  'overdue',
  'sync_error',
  'not_applicable',
]);
const PRODUCTION_SHIPMENT_STATUSES = new Set([
  'not_shipped',
  'partial_shipped',
  'shipped',
  'shipment_problem',
  'not_applicable',
]);
const PRODUCTION_DISPATCH_STATUSES = new Set([
  'new',
  'assigned',
  'in_progress',
  'blocked',
  'deferred',
  'defect',
  'ready_for_warehouse',
  'done',
]);
const PRODUCTION_ROLES = new Set([
  'commercial',
  'production_lead',
  'operator',
  'warehouse',
  'finance',
  'director',
  'admin',
]);

function parseProductionOrdersResponse(value: unknown): ServerProductionOrder[] {
  if (!Array.isArray(value) || !value.every(isProductionOrderResponse)) {
    throw new Error('Некорректный ответ производственных заказов.');
  }
  const ids = value.map((order) => order.id);
  const commercialOrderIds = value.map((order) => order.commercialOrderId);
  if (new Set(ids).size !== ids.length || new Set(commercialOrderIds).size !== value.length) {
    throw new Error('Некорректный ответ производственных заказов.');
  }
  return value;
}

function parseProductionOrderResponse(value: unknown): ServerProductionOrder {
  if (!isProductionOrderResponse(value)) {
    throw new Error('Некорректный ответ производственного заказа.');
  }
  return value;
}

function isProductionOrderResponse(value: unknown): value is ServerProductionOrder {
  if (!isProductionRecord(value)) return false;
  const requiredKeys = [
    'id',
    'commercialOrderId',
    'indicator',
    'approvalState',
    'assignedOwnerId',
    'blockers',
    'canApprove',
    'approvalProblems',
    'defectRollCount',
    'verifiedDefectKg',
    'returnedSpoolCount',
    'createdAt',
    'updatedAt',
    'commercialOrder',
    'dispatchItems',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isProductionText(value.id) ||
    !isProductionText(value.commercialOrderId) ||
    !PRODUCTION_INDICATORS.has(String(value.indicator)) ||
    !['pending', 'approved'].includes(String(value.approvalState)) ||
    !isProductionNullableText(value.assignedOwnerId) ||
    !Array.isArray(value.blockers) ||
    !value.blockers.every(isProductionText) ||
    typeof value.canApprove !== 'boolean' ||
    !Array.isArray(value.approvalProblems) ||
    !value.approvalProblems.every(isProductionApprovalProblem) ||
    !isProductionTimestamp(value.createdAt) ||
    !isProductionTimestamp(value.updatedAt) ||
    !isProductionCommercialOrder(value.commercialOrder, value.commercialOrderId) ||
    !Array.isArray(value.dispatchItems) ||
    !value.dispatchItems.every((item) => isProductionDispatchItem(item, String(value.id)))
  ) {
    return false;
  }
  const dispatchIds = value.dispatchItems.map((item) => item.id);
  const rollCodes = value.dispatchItems.map((item) => item.rollCode);
  if (
    new Set(dispatchIds).size !== dispatchIds.length ||
    new Set(rollCodes).size !== rollCodes.length
  ) {
    return false;
  }
  for (const key of ['defectRollCount', 'verifiedDefectKg', 'returnedSpoolCount'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) {
      return false;
    }
  }
  const workflowVersion = value.commercialOrder.warehouseCoverageWorkflowVersion;
  if (workflowVersion === 2) {
    return (
      Object.hasOwn(value, 'coverage') &&
      value.coverage !== null &&
      Object.hasOwn(value, 'productionQty') &&
      Number.isSafeInteger(value.productionQty) &&
      Number(value.productionQty) >= 0 &&
      Object.hasOwn(value, 'sourceGeneration') &&
      (value.sourceGeneration === null ||
        (Number.isSafeInteger(value.sourceGeneration) && Number(value.sourceGeneration) > 0))
    );
  }
  return true;
}

function isProductionApprovalProblem(value: unknown): boolean {
  return (
    isProductionRecord(value) &&
    isProductionText(value.rollId) &&
    Array.isArray(value.reasons) &&
    value.reasons.length > 0 &&
    value.reasons.every(isProductionText)
  );
}

function isProductionCommercialOrder(
  value: unknown,
  expectedId: string,
): value is ServerProductionCommercialOrder {
  if (!isProductionRecord(value)) return false;
  const requiredKeys = [
    'id',
    'orderNumber',
    'creatorRole',
    'counterpartyId',
    'requestType',
    'productionIndicator',
    'warehouseCoverStatus',
    'paymentStatus',
    'shipmentStatus',
    'warehouseCoverageWorkflowVersion',
    'commercialConfirmationPolicy',
    'createdAt',
    'updatedAt',
    'externalId',
    'sourceVersion',
    'counterparty',
    'stockBatchCode',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    value.id !== expectedId ||
    !isProductionText(value.id) ||
    !isProductionText(value.orderNumber) ||
    !['commercial', 'production_lead'].includes(String(value.creatorRole)) ||
    !isProductionNullableText(value.counterpartyId) ||
    !['client_order', 'stock_reserve'].includes(String(value.requestType)) ||
    !PRODUCTION_INDICATORS.has(String(value.productionIndicator)) ||
    !PRODUCTION_WAREHOUSE_COVER_STATUSES.has(String(value.warehouseCoverStatus)) ||
    !PRODUCTION_PAYMENT_STATUSES.has(String(value.paymentStatus)) ||
    !PRODUCTION_SHIPMENT_STATUSES.has(String(value.shipmentStatus)) ||
    ![1, 2].includes(Number(value.warehouseCoverageWorkflowVersion)) ||
    !['required', 'bypassed_by_delegation'].includes(String(value.commercialConfirmationPolicy)) ||
    !isProductionTimestamp(value.createdAt) ||
    !isProductionTimestamp(value.updatedAt) ||
    !isProductionNullableText(value.externalId) ||
    !isProductionNullableText(value.sourceVersion) ||
    !isProductionNullableText(value.stockBatchCode) ||
    !isProductionCounterparty(value.counterparty, value.counterpartyId)
  ) {
    return false;
  }
  if (value.requestType === 'stock_reserve') {
    return (
      value.counterpartyId === null &&
      value.counterparty === null &&
      isProductionText(value.stockBatchCode) &&
      value.paymentStatus === 'not_applicable' &&
      value.shipmentStatus === 'not_applicable'
    );
  }
  return (
    isProductionText(value.counterpartyId) &&
    value.counterparty !== null &&
    value.stockBatchCode === null
  );
}

function isProductionCounterparty(
  value: unknown,
  expectedId: unknown,
): value is ServerCounterparty | null {
  if (value === null) return expectedId === null;
  return (
    isProductionRecord(value) &&
    value.id === expectedId &&
    isProductionText(value.id) &&
    isProductionText(value.displayName) &&
    Object.hasOwn(value, 'legalName') &&
    isProductionNullableText(value.legalName) &&
    Object.hasOwn(value, 'inn') &&
    isProductionNullableText(value.inn) &&
    isProductionText(value.billingSource) &&
    isProductionText(value.syncStatus)
  );
}

function isProductionDispatchItem(
  value: unknown,
  expectedOrderId: string,
): value is ServerRollDispatchItem {
  if (!isProductionRecord(value)) return false;
  const requiredKeys = [
    'id',
    'rollCode',
    'productionOrderId',
    'orderLineId',
    'positionSequence',
    'rawMaterialId',
    'recipeVersion',
    'filmType',
    'plannedWeightKg',
    'plannedLengthM',
    'characteristicsSnapshot',
    'assignedOperatorId',
    'assignedOperator',
    'machineId',
    'workplaceId',
    'postId',
    'post',
    'plannedShiftId',
    'queueRank',
    'priority',
    'status',
    'bulkGroupId',
    'replacesDispatchItemId',
    'createdAt',
    'updatedAt',
    'completedAt',
    'operatorLine',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isProductionText(value.id) &&
    isProductionText(value.rollCode) &&
    value.productionOrderId === expectedOrderId &&
    isProductionNullableText(value.orderLineId) &&
    Number.isSafeInteger(value.positionSequence) &&
    Number(value.positionSequence) >= 0 &&
    isProductionNullableText(value.rawMaterialId) &&
    isProductionNullableText(value.recipeVersion) &&
    isProductionNullableText(value.filmType) &&
    isProductionNullablePositiveNumber(value.plannedWeightKg) &&
    isProductionNullableNonnegativeNumber(value.plannedLengthM) &&
    isProductionCharacteristicsSnapshot(value.characteristicsSnapshot) &&
    isProductionNullableText(value.assignedOperatorId) &&
    isProductionAssignedOperator(value.assignedOperator, value.assignedOperatorId) &&
    isProductionNullableText(value.machineId) &&
    isProductionNullableText(value.workplaceId) &&
    isProductionNullableText(value.postId) &&
    isProductionPost(value.post, value.postId) &&
    isProductionNullableText(value.plannedShiftId) &&
    Number.isSafeInteger(value.queueRank) &&
    Number(value.queueRank) >= 0 &&
    Number.isSafeInteger(value.priority) &&
    Number(value.priority) >= 0 &&
    PRODUCTION_DISPATCH_STATUSES.has(String(value.status)) &&
    isProductionNullableText(value.bulkGroupId) &&
    isProductionNullableText(value.replacesDispatchItemId) &&
    isProductionTimestamp(value.createdAt) &&
    isProductionTimestamp(value.updatedAt) &&
    (value.completedAt === null || isProductionTimestamp(value.completedAt)) &&
    isProductionOperatorLine(value.operatorLine)
  );
}

function isProductionOperatorLine(value: unknown): boolean {
  if (value === null) return true;
  return (
    isProductionRecord(value) &&
    Object.hasOwn(value, 'netKg') &&
    isProductionNullableNonnegativeNumber(value.netKg) &&
    Object.hasOwn(value, 'step') &&
    isProductionNullableText(value.step) &&
    Object.hasOwn(value, 'warehouseState') &&
    isProductionNullableText(value.warehouseState)
  );
}

function parseProductionCommercialActionPage(value: unknown): ProductionCommercialActionPage {
  if (
    !isProductionRecord(value) ||
    !Array.isArray(value.items) ||
    !value.items.every(isProductionCommercialActionOrder) ||
    !Object.hasOwn(value, 'nextCursor') ||
    (value.nextCursor !== null && !isProductionText(value.nextCursor))
  ) {
    throw new Error('Некорректная страница очереди коммерческих действий.');
  }
  const ids = value.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Некорректная страница очереди коммерческих действий.');
  }
  return value as ProductionCommercialActionPage;
}

function isProductionCommercialActionOrder(
  value: unknown,
): value is ProductionCommercialActionOrder {
  if (!isProductionRecord(value)) return false;
  const requiredKeys = [
    'id',
    'orderNumber',
    'requestType',
    'stockBatchCode',
    'counterparty',
    'positionCount',
    'requestedQty',
    'nextAction',
    'updatedAt',
  ] as const;
  if (
    !requiredKeys.every((key) => Object.hasOwn(value, key)) ||
    !isProductionText(value.id) ||
    !isProductionText(value.orderNumber) ||
    !['client_order', 'stock_reserve'].includes(String(value.requestType)) ||
    !isProductionNullableText(value.stockBatchCode) ||
    !Number.isSafeInteger(value.positionCount) ||
    Number(value.positionCount) < 0 ||
    !Number.isSafeInteger(value.requestedQty) ||
    Number(value.requestedQty) < 0 ||
    !isProductionTimestamp(value.updatedAt) ||
    !isProductionCommercialActionCounterparty(value.counterparty) ||
    !isProductionCommercialAction(value.nextAction)
  ) {
    return false;
  }
  return value.requestType === 'stock_reserve'
    ? value.counterparty === null && isProductionText(value.stockBatchCode)
    : value.counterparty !== null && value.stockBatchCode === null;
}

function isProductionCommercialActionCounterparty(value: unknown): boolean {
  if (value === null) return true;
  return (
    isProductionRecord(value) &&
    isProductionText(value.id) &&
    isProductionText(value.displayName) &&
    Object.hasOwn(value, 'legalName') &&
    isProductionNullableText(value.legalName) &&
    Object.hasOwn(value, 'inn') &&
    isProductionNullableText(value.inn)
  );
}

function isProductionCommercialAction(value: unknown): boolean {
  return (
    isProductionRecord(value) &&
    isProductionText(value.code) &&
    isProductionText(value.ownerRole) &&
    PRODUCTION_ROLES.has(value.ownerRole) &&
    isProductionText(value.label) &&
    typeof value.allowed === 'boolean'
  );
}

/** Элемент архива: rollDispatchItem из GET /roll-dispatch со вложенным заказом. */
export type ServerArchiveDispatchItem = ServerRollDispatchItem & {
  positionSequence: number;
  rawMaterialId: string | null;
  recipeVersion: string | null;
  bulkGroupId: string | null;
  replacesDispatchItemId: string | null;
  productionOrder: {
    id: string;
    approvalState: 'pending' | 'approved';
    commercialOrder: {
      id: string;
      orderNumber: string;
      counterparty: { id: string; displayName: string } | null;
    };
  };
};

/** Архив выполненных рулонов (status=done) за период — вкладка «Архив». */
export function fetchProductionArchive(
  dateFrom: string,
  dateTo: string,
  options?: ApiRequestOptions,
): Promise<ProductionRollDispatchItem[]> {
  const params = new URLSearchParams({ scope: 'archive', dateFrom, dateTo });
  return apiGet<unknown>(`/api/production/roll-dispatch?${params}`, options)
    .then(parseProductionArchiveResponse)
    .then((items) => items.map(archiveDispatchItemToRoll));
}

function archiveDispatchItemToRoll(item: ServerArchiveDispatchItem): ProductionRollDispatchItem {
  const commercial = item.productionOrder.commercialOrder;
  const snapshot = item.characteristicsSnapshot;
  const filmType = item.filmType ?? 'Не указано';
  const characteristics = [filmType, snapshot?.actualThickness, snapshot?.birka]
    .filter(Boolean)
    .join(' · ');
  const hasMachine = item.machineId !== null;
  return {
    id: item.id,
    productionOrderId: item.productionOrder.id,
    orderId: item.productionOrder.id,
    orderNumber: commercial.orderNumber,
    orderLineId: item.orderLineId ?? 'Без позиции',
    rollId: item.rollCode,
    sequenceNumber: item.positionSequence,
    queueRank: item.queueRank,
    customerAlias: commercial.counterparty?.displayName ?? 'Контрагент не указан',
    operatorId: item.assignedOperatorId ?? '',
    operatorLabel: item.assignedOperator?.displayName ?? item.assignedOperatorId ?? 'Не назначен',
    machineId: item.machineId ?? '',
    machineLabel: item.post?.name ?? item.machineId ?? 'Не назначен',
    defaultMachineIdSnapshot: item.machineId ?? undefined,
    defaultMachineLabelSnapshot: item.post?.name ?? item.machineId ?? undefined,
    machineAssignmentSource: hasMachine ? 'shift_default' : 'unassigned',
    manualMachineOverride: false,
    machineAssignedBy: hasMachine ? 'Зав. производства' : 'Не назначен',
    machineAssignedAt: item.updatedAt,
    machineAssignmentRequired: true,
    shiftId: item.plannedShiftId ?? undefined,
    publicationState: item.productionOrder.approvalState === 'approved' ? 'published' : 'draft',
    assignedAt: item.updatedAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt!,
    priority: priorityFromNumber(item.priority),
    plannedNetKg: item.plannedWeightKg ?? undefined,
    meterageMeters: item.plannedLengthM ?? undefined,
    characteristics: characteristics || 'Нет характеристик',
    filmType,
    actualThickness: snapshot?.actualThickness ?? undefined,
    accountingThickness: snapshot?.accountingThickness ?? undefined,
    widthMm: snapshot?.widthMm ?? undefined,
    plannedLengthM: item.plannedLengthM ?? undefined,
    micron: snapshot?.actualThickness ?? 'Нет данных',
    sizeMeters: item.plannedLengthM === null ? 'Нет данных' : `${item.plannedLengthM} м`,
    status: 'warehouse_pending',
    auditEvent: 'audit:roll_dispatch_assigned',
  };
}

function parseProductionArchiveResponse(value: unknown): ServerArchiveDispatchItem[] {
  if (!Array.isArray(value) || !value.every(isProductionArchiveDispatchItem)) {
    throw new Error('Некорректный ответ архива производства.');
  }
  return value;
}

function isProductionArchiveDispatchItem(value: unknown): value is ServerArchiveDispatchItem {
  if (!isProductionRecord(value)) return false;
  const requiredKeys = [
    'id',
    'rollCode',
    'productionOrderId',
    'orderLineId',
    'positionSequence',
    'rawMaterialId',
    'recipeVersion',
    'filmType',
    'plannedWeightKg',
    'plannedLengthM',
    'characteristicsSnapshot',
    'assignedOperatorId',
    'assignedOperator',
    'machineId',
    'workplaceId',
    'postId',
    'post',
    'plannedShiftId',
    'queueRank',
    'priority',
    'status',
    'bulkGroupId',
    'replacesDispatchItemId',
    'createdAt',
    'updatedAt',
    'completedAt',
    'productionOrder',
  ] as const;
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    isProductionText(value.id) &&
    isProductionText(value.rollCode) &&
    isProductionText(value.productionOrderId) &&
    isProductionNullableText(value.orderLineId) &&
    Number.isSafeInteger(value.positionSequence) &&
    (value.positionSequence as number) >= 1 &&
    isProductionNullableText(value.rawMaterialId) &&
    isProductionNullableText(value.recipeVersion) &&
    isProductionNullableText(value.filmType) &&
    isProductionNullablePositiveNumber(value.plannedWeightKg) &&
    isProductionNullableNonnegativeNumber(value.plannedLengthM) &&
    isProductionCharacteristicsSnapshot(value.characteristicsSnapshot) &&
    isProductionNullableText(value.assignedOperatorId) &&
    isProductionAssignedOperator(value.assignedOperator, value.assignedOperatorId) &&
    isProductionNullableText(value.machineId) &&
    isProductionNullableText(value.workplaceId) &&
    isProductionNullableText(value.postId) &&
    isProductionPost(value.post, value.postId) &&
    isProductionNullableText(value.plannedShiftId) &&
    Number.isSafeInteger(value.queueRank) &&
    (value.queueRank as number) >= 0 &&
    Number.isSafeInteger(value.priority) &&
    (value.priority as number) >= 0 &&
    value.status === 'done' &&
    isProductionNullableText(value.bulkGroupId) &&
    isProductionNullableText(value.replacesDispatchItemId) &&
    isProductionTimestamp(value.createdAt) &&
    isProductionTimestamp(value.updatedAt) &&
    isProductionTimestamp(value.completedAt) &&
    isProductionArchiveOrder(value.productionOrder, value.productionOrderId)
  );
}

function isProductionRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProductionText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isProductionNullableText(value: unknown): boolean {
  return value === null || isProductionText(value);
}

function isProductionNullableNonnegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isProductionNullablePositiveNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function isProductionTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isProductionCharacteristicsSnapshot(value: unknown): boolean {
  if (value === null) return true;
  if (!isProductionRecord(value)) return false;
  return (
    ['actualThickness', 'accountingThickness', 'rawMaterialId', 'spoolType', 'birka'].every(
      (key) => !Object.hasOwn(value, key) || isProductionNullableText(value[key]),
    ) &&
    (!Object.hasOwn(value, 'widthMm') || isProductionNullableNonnegativeNumber(value.widthMm))
  );
}

function isProductionAssignedOperator(value: unknown, expectedId: unknown): boolean {
  if (value === null) return expectedId === null;
  return (
    isProductionRecord(value) &&
    value.id === expectedId &&
    isProductionText(value.id) &&
    isProductionText(value.displayName)
  );
}

function isProductionPost(value: unknown, expectedId: unknown): boolean {
  if (value === null) return expectedId === null;
  return (
    isProductionRecord(value) &&
    value.id === expectedId &&
    isProductionText(value.id) &&
    isProductionText(value.code) &&
    isProductionText(value.name) &&
    isProductionText(value.status)
  );
}

function isProductionArchiveOrder(value: unknown, expectedId: unknown): boolean {
  if (
    !isProductionRecord(value) ||
    value.id !== expectedId ||
    !isProductionText(value.id) ||
    !['pending', 'approved'].includes(String(value.approvalState)) ||
    !isProductionRecord(value.commercialOrder) ||
    !isProductionText(value.commercialOrder.id) ||
    !isProductionText(value.commercialOrder.orderNumber) ||
    !Object.hasOwn(value.commercialOrder, 'counterparty')
  ) {
    return false;
  }
  const counterparty = value.commercialOrder.counterparty;
  return (
    counterparty === null ||
    (isProductionRecord(counterparty) &&
      isProductionText(counterparty.id) &&
      isProductionText(counterparty.displayName))
  );
}

export class ProductionApprovalReconciliationError extends Error {
  readonly name = 'ProductionApprovalReconciliationError';

  constructor(
    readonly orderId: string,
    readonly committed: boolean,
    readonly originalError: unknown,
    readonly reconciliationError: unknown,
  ) {
    super('Результат согласования нужно сверить по данным сервера.');
  }
}

async function fetchApprovedProductionOrder(orderId: string): Promise<WorkObject> {
  const order = parseProductionOrderResponse(
    await apiGet<unknown>(`/api/production/orders/${encodeURIComponent(orderId)}`),
  );
  if (order.id !== orderId || order.approvalState !== 'approved') {
    throw new Error('Сервер не подтвердил согласованный производственный заказ.');
  }
  return serverProductionOrderToWorkObject(order);
}

export async function approveProductionOrder(orderId: string): Promise<WorkObject> {
  let committed = false;
  let originalError: unknown = null;
  try {
    const response = parseProductionOrderResponse(
      await apiPost<unknown>(`/api/production/orders/${encodeURIComponent(orderId)}/approve`),
    );
    if (response.id !== orderId || response.approvalState !== 'approved') {
      throw new Error('Некорректный результат согласования производственного заказа.');
    }
    committed = true;
  } catch (error) {
    originalError = error;
    if (
      !isDeliveryUncertain(error) &&
      !(error instanceof Error && error.message.startsWith('Некорректн'))
    ) {
      throw error;
    }
  }

  try {
    return await fetchApprovedProductionOrder(orderId);
  } catch (reconciliationError) {
    throw new ProductionApprovalReconciliationError(
      orderId,
      committed,
      originalError,
      reconciliationError,
    );
  }
}

export function assignProductionRoll(rollId: string, input: { operatorId: string }) {
  return apiPost<ServerRollDispatchItem>(
    `/api/production/roll-dispatch/${encodeURIComponent(rollId)}/assign`,
    input,
  );
}

export function updateProductionRollPriority(rollId: string, priority: number) {
  return apiPost<ServerRollDispatchItem>(
    `/api/production/roll-dispatch/${encodeURIComponent(rollId)}/priority`,
    { priority },
  );
}

export function batchUpdateProductionRolls(changes: ProductionRollChange[]) {
  return apiPost<{ updated: number }>('/api/production/roll-dispatch/batch-update', { changes });
}

export function reorderProductionRolls(orderedRollIds: string[], reason: string) {
  return apiPost<{ orderedRollIds: string[] }>('/api/production/roll-dispatch/reorder', {
    orderedRollIds,
    reason,
  });
}

export function fetchProductionShifts(options?: ApiRequestOptions) {
  return apiGet<ProductionShift[]>('/api/production/shifts', options);
}

export function selectProductionPlanningShift(
  shifts: ProductionShift[],
  requestedShiftId?: string | null,
  _browserNow?: Date,
): ProductionShift | undefined {
  return (
    shifts.find((shift) => shift.id === requestedShiftId) ??
    shifts.find((shift) => shift.status === 'open') ??
    shifts.find((shift) => shift.status === 'planned') ??
    shifts[0]
  );
}

export function fetchProductionPosts(options?: ApiRequestOptions) {
  return apiGet<ProductionPost[]>('/api/production/posts', options);
}

export function fetchProductionOperatorOptions(options?: ApiRequestOptions) {
  return apiGet<ProductionOperatorOption[]>('/api/production/operators/workload', options);
}

export function fetchProductionOperatorMachines(shiftId: string, options?: ApiRequestOptions) {
  return apiGet<ProductionOperatorMachineView>(
    `/api/production/shifts/${encodeURIComponent(shiftId)}/operator-machines`,
    options,
  );
}

export function createProductionShift(input: {
  label: string;
  plannedStartAt: string;
  plannedEndAt: string;
}) {
  return apiPost<ProductionShift>('/api/production/shifts', input);
}

export function createIndividualOperatorShift(input: CreateIndividualOperatorShiftInput) {
  return apiPost<IndividualOperatorShiftResult>('/api/production/operator-shifts', input);
}

export function assignProductionOperatorMachine(
  shiftId: string,
  operatorId: string,
  postId: string,
) {
  return apiPut<OperatorMachineAssignment>(
    `/api/production/shifts/${encodeURIComponent(shiftId)}/operators/${encodeURIComponent(operatorId)}/machine`,
    { postId },
  );
}

export function breakdownReassignProductionMachine(
  assignmentId: string,
  postId: string,
  reason: string,
) {
  return apiPost<OperatorMachineAssignment>(
    `/api/production/operator-machines/${encodeURIComponent(assignmentId)}/breakdown-reassign`,
    { postId, reason },
  );
}

export function requestIntentionalMachineChange(
  assignmentId: string,
  input: { postId: string; reason: string; operationKey: string },
) {
  return apiPost<OperatorMachineChangeView>(
    `/api/production/operator-machines/${encodeURIComponent(assignmentId)}/machine-change`,
    input,
  );
}

export function cancelProductionAssignment(
  shiftId: string,
  assignmentId: string,
  command: ProductionCancellationCommand,
) {
  return apiPost<ProductionAssignmentCancellationResult>(
    `/api/production/shifts/${encodeURIComponent(shiftId)}/assignments/${encodeURIComponent(assignmentId)}/cancel`,
    command,
  );
}

export function cancelProductionMachineChange(
  changeId: string,
  command: ProductionCancellationCommand,
) {
  return apiPost<ProductionMachineChangeCancellationResult>(
    `/api/production/machine-changes/${encodeURIComponent(changeId)}/cancel`,
    command,
  );
}

// --- Поломки станков и проблемы контура (дизайн 2026-07-14) -----------------

export type ServerProductionProblem = {
  id: string;
  type:
    | 'general'
    | 'raw_material_shortage'
    | 'defect'
    | 'shift_balance_mismatch'
    | 'machine_breakdown';
  status: 'open' | 'resolved';
  orderId?: string | null;
  positionId?: string | null;
  rollId?: string | null;
  actorRole: string;
  reason: string;
  recovery?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
  postId?: string | null;
  post?: { id: string; code: string; name: string; status: string } | null;
  order?: { id: string; orderNumber: string } | null;
  defectWeightKg: number | null;
  defectWeightCapturedAt: string | null;
  defectWeightSource:
    | 'operator_scale'
    | 'warehouse_control_scale'
    | 'production_existing_scale'
    | 'legacy_unverified'
    | null;
};

export function fetchProductionProblems(
  filter?: { status?: string; type?: string },
  options?: ApiRequestOptions,
) {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  if (filter?.type) params.set('type', filter.type);
  const query = params.toString();
  return apiGet<ServerProductionProblem[]>(
    `/api/production/problems${query ? `?${query}` : ''}`,
    options,
  );
}

export function resolveProductionProblem(
  problemId: string,
  body: {
    resolution: 'rework' | 'writeoff' | 'confirm' | 'reject' | 'close';
    note: string;
  },
) {
  return apiPost<ServerProductionProblem>(
    `/api/production/problems/${encodeURIComponent(problemId)}/resolve`,
    {
      resolution: body.resolution,
      note: body.note,
    },
  );
}

export function reportProductionMachineBreakdown(postId: string, reason: string) {
  return apiPost<ServerProductionProblem>(
    `/api/production/posts/${encodeURIComponent(postId)}/breakdown`,
    { reason },
  );
}

export function startProductionMachineRepair(postId: string) {
  return apiPost<ProductionPost>(
    `/api/production/posts/${encodeURIComponent(postId)}/repair-start`,
  );
}

export function completeProductionMachineRepair(postId: string, note?: string) {
  return apiPost<ProductionPost>(
    `/api/production/posts/${encodeURIComponent(postId)}/repair`,
    note ? { note } : {},
  );
}

/** Брак при визуальном контроле: сервер связывает ранее подтвержденный физический вес. */
export function markProductionRollDefect(rollCode: string, reason: string) {
  return apiPost<ServerProductionProblem>(
    `/api/production/rolls/${encodeURIComponent(rollCode)}/defect`,
    { reason },
  );
}

/** Технические причины блокировки приходят из API по-английски — переводим для UI. */
const BLOCKER_REASON_RU: Record<string, string> = {
  'operator is not assigned': 'не назначен оператор',
  'shift is not assigned': 'не назначена смена',
  'machine is not assigned': 'не назначен станок',
  'queue rank is not assigned': 'нет позиции в очереди',
  'planned weight is not set': 'нет планового веса',
  'roll weight is invalid': 'некорректный вес рулона',
};

const INVALID_ROLL_WEIGHT_REASON_RU = 'некорректный вес рулона';

export function blockerReasonRu(reason: string): string {
  return reason
    .split(';')
    .map((part) => BLOCKER_REASON_RU[part.trim()] ?? part.trim())
    .filter(Boolean)
    .join('; ');
}

function productionApprovalRecovery(reasons: string[]): string {
  return reasons.includes(INVALID_ROLL_WEIGHT_REASON_RU)
    ? 'Остановить передачу рулона и провести контролируемую сверку веса'
    : 'Назначить оператора, смену и станок';
}

function serverProductionOrderToWorkObject(order: ServerProductionOrder): WorkObject {
  const commercial = order.commercialOrder;
  const workflowVersion = commercial.warehouseCoverageWorkflowVersion === 2 ? 2 : 1;
  const coverage =
    workflowVersion === 2 ? normalizeProductionWarehouseCoverage(order.coverage) : undefined;
  const productionQty =
    workflowVersion === 2
      ? requireNonNegativeInteger(order.productionQty, 'productionQty')
      : undefined;
  const sourceGeneration =
    workflowVersion === 2
      ? requireNullablePositiveInteger(order.sourceGeneration, 'sourceGeneration')
      : null;
  const isStockOrder = commercial.requestType === 'stock_reserve';
  const counterparty = isStockOrder
    ? commercial.stockBatchCode!
    : counterpartyLabel(commercial.counterparty!);
  const rolls = order.dispatchItems.map((item, index) =>
    serverDispatchItemToRoll(item, order, counterparty, index),
  );
  const rollGroups = rollGroupsForDispatchItems(order, rolls);
  const rollCount = rolls.length;
  const approved = order.approvalState === 'approved';
  const statusLabel = productionOrderStatusLabel(approved, rolls);
  const approvalProblems = (order.approvalProblems ?? []).map((problem) => ({
    ...problem,
    reasons: problem.reasons.map(blockerReasonRu),
  }));
  // Секция «Неполные» — проекция того же списка заказ-нарядов.
  // Неполные — не всем рулонам назначены оператор/станок; полный план публикуется автоматически.
  const blockedRolls = rolls.filter((roll) => roll.status === 'blocked').length;
  const isIncomplete = !approved && (approvalProblems.length > 0 || blockedRolls > 0);
  const qualityFacts = [
    {
      label: 'Брак',
      value: `${order.defectRollCount} рул. · ${order.verifiedDefectKg} кг`,
      scope: 'production' as const,
    },
  ];
  const returnedSpoolFacts = [
    {
      label: 'Шпули возвращены',
      value: `${order.returnedSpoolCount} шт.`,
      scope: 'production' as const,
    },
  ];

  return {
    id: order.id,
    kind: 'productionOrder',
    title: `Заказ-наряд ${commercial.orderNumber}`,
    statusLabel,
    nextOwner:
      statusLabel === 'Передан на склад'
        ? 'Склад'
        : ['Принят складом', 'Выдан со склада'].includes(statusLabel)
          ? 'Коммерция'
          : approved
            ? 'Операторы'
            : 'Зав. производства',
    severity: order.blockers.length || approvalProblems.length ? 'warning' : 'info',
    filterTags: [
      'Заказ-наряды',
      'Все рулоны',
      approved ? statusLabel : 'Неполные',
      ...(approvalProblems.length ? ['Проблемы', 'Без назначения'] : []),
      ...(isIncomplete ? ['Неполные'] : []),
      ...(isStockOrder ? ['На запас'] : []),
    ],
    facts: [
      { label: 'Номер', value: commercial.orderNumber, scope: 'production' },
      {
        label: isStockOrder ? 'Режим' : 'Контрагент',
        value: counterparty,
        scope: isStockOrder ? 'production' : 'legal',
      },
      {
        label: 'Позиции',
        value: `${new Set(order.dispatchItems.map((item) => item.orderLineId)).size} поз.`,
        scope: 'production',
      },
      { label: 'Рулоны', value: `${rollCount} рул.`, scope: 'production' },
      ...qualityFacts,
      ...returnedSpoolFacts,
      {
        label: 'Ответственный',
        value: order.assignedOwnerId ?? 'Не назначен',
        scope: 'production',
      },
      { label: 'Приоритет', value: priorityForOrder(order.dispatchItems), scope: 'production' },
      { label: 'Сырье', value: 'Из заявки коммерции', scope: 'production' },
      {
        label: 'Склад',
        value: warehouseStatusLabel(commercial.warehouseCoverStatus),
        scope: 'production',
      },
      {
        label: 'Источник',
        value: commercial.externalId ?? 'Операционные данные',
        scope: 'rawDiagnostics',
      },
    ],
    sections: [
      {
        id: 'production-live-summary',
        title: 'Производственная часть',
        facts: [
          { label: 'Заказ', value: commercial.orderNumber, scope: 'production' },
          { label: 'Контрагент', value: counterparty, scope: 'legal' },
          { label: 'Рулоны', value: `${rollCount} рул. в dispatch`, scope: 'production' },
          ...qualityFacts,
          {
            label: 'Шпули на складе',
            value: `${order.returnedSpoolCount} шт.`,
            scope: 'production' as const,
          },
          { label: 'Статус', value: statusLabel, scope: 'production' },
        ],
      },
      {
        id: 'production-live-rolls',
        title: 'Рулоны',
        facts: rolls.slice(0, 12).map((roll) => ({
          label: roll.rollId,
          value: `${roll.filmType} · ${roll.status === 'blocked' ? roll.blocker : roll.status}`,
          scope: 'production' as const,
        })),
      },
    ],
    actions: approved
      ? [
          {
            id: `production-in-progress:${order.id}`,
            label: 'Передано операторам',
            level: 'disabled',
            enabled: false,
            disabledReason: 'Заказ-наряд уже передан операторам',
            recoveryOwner: 'Операторы',
            recoveryAction: 'Открыть очередь рулонов',
          },
        ]
      : [
          {
            id: `production-save-draft:${order.id}`,
            label: 'Сохранить черновик',
            level: 'secondary',
            enabled: true,
          },
          {
            id: `production-return-intake:${order.id}`,
            label: 'Вернуть в заявку',
            level: 'destructive',
            enabled: true,
          },
        ],
    problems: [
      ...order.blockers.map(blockerReasonRu).map((problem, index) => ({
        id: `${order.id}-problem-${index}`,
        objectId: order.id,
        stage: 'Производство',
        title: problem,
        severity: 'warning' as const,
        ownerRole: 'Зав. производства',
        due: 'до полного назначения',
        reason: problem,
        recovery: 'Заполнить заказ-наряд или вернуть в коммерцию',
        status: 'open' as const,
      })),
      ...approvalProblems.map((problem) => ({
        id: `${order.id}-${problem.rollId}-approval`,
        objectId: order.id,
        stage: 'Производство',
        title: `Не готов ${problem.rollId}`,
        severity: 'warning' as const,
        ownerRole: 'Зав. производства',
        due: 'до полного назначения',
        reason: problem.reasons.join('; '),
        recovery: productionApprovalRecovery(problem.reasons),
        status: 'open' as const,
      })),
    ],
    audit: [
      auditEntry(
        order.id,
        'Система',
        'integration:production_order_loaded',
        `Заказ-наряд ${commercial.orderNumber} получен в производство.`,
      ),
    ],
    rollGroups,
    commercialOrder: commercialOrderForProduction(order),
    productionRollDispatchItems: rolls,
    warehouseCoverageWorkflowVersion: workflowVersion,
    coverage,
    productionQty,
    sourceGeneration,
    productionOrderId: order.id,
  };
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid production coverage field: ${field}`);
  }
  return Number(value);
}

function requireNullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`Invalid production coverage field: ${field}`);
  }
  return Number(value);
}

function serverDispatchItemToRoll(
  item: ServerRollDispatchItem,
  order: ServerProductionOrder,
  counterparty: string,
  index: number,
): ProductionRollDispatchItem {
  const hasOperator = Boolean(item.assignedOperatorId);
  const hasMachine = Boolean(item.machineId);
  const plannedNetKg = item.plannedWeightKg ?? undefined;
  const status = dispatchStatus(item, hasOperator, hasMachine, plannedNetKg);
  const machineLabel = item.post?.name ?? item.machineId ?? 'Не назначен';
  const filmType = item.filmType ?? 'Плёнка';
  const characteristics = [
    filmType,
    item.characteristicsSnapshot?.actualThickness,
    item.characteristicsSnapshot?.birka,
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    id: item.id,
    productionOrderId: order.id,
    orderId: order.id,
    orderNumber: order.commercialOrder.orderNumber,
    orderLineId: item.orderLineId ?? 'Без позиции',
    rollId: item.rollCode,
    sequenceNumber: index + 1,
    queueRank: item.queueRank,
    customerAlias: counterparty,
    operatorId: item.assignedOperatorId ?? '',
    operatorLabel: item.assignedOperator?.displayName ?? item.assignedOperatorId ?? 'Не назначен',
    machineId: item.machineId ?? '',
    machineLabel,
    defaultMachineIdSnapshot: item.machineId ?? undefined,
    defaultMachineLabelSnapshot: item.post?.name ?? item.machineId ?? undefined,
    machineAssignmentSource: hasMachine ? 'shift_default' : 'unassigned',
    manualMachineOverride: false,
    machineAssignedBy: hasMachine ? 'Зав. производства' : 'Не назначен',
    machineAssignedAt: item.updatedAt,
    machineAssignmentRequired: true,
    shiftId: item.plannedShiftId ?? undefined,
    publicationState: order.approvalState === 'approved' ? 'published' : 'draft',
    assignedAt: item.updatedAt,
    updatedAt: item.updatedAt,
    priority: priorityFromNumber(item.priority),
    plannedNetKg,
    actualNetKg: item.operatorLine?.netKg ?? undefined,
    meterageMeters: item.plannedLengthM ?? undefined,
    plannedLengthM: item.plannedLengthM ?? undefined,
    characteristics,
    filmType,
    actualThickness: item.characteristicsSnapshot?.actualThickness ?? undefined,
    accountingThickness: item.characteristicsSnapshot?.accountingThickness ?? undefined,
    widthMm: item.widthMm ?? item.characteristicsSnapshot?.widthMm ?? undefined,
    micron: item.characteristicsSnapshot?.actualThickness ?? 'из заявки',
    sizeMeters: item.plannedLengthM == null ? 'нет данных' : `${item.plannedLengthM} м`,
    status,
    completedAt: item.completedAt ?? undefined,
    blocker:
      status === 'blocked' ? blockedRollReason(hasOperator, hasMachine, plannedNetKg) : undefined,
    auditEvent: 'audit:roll_dispatch_assigned',
  };
}

function dispatchStatus(
  item: ServerRollDispatchItem,
  hasOperator: boolean,
  hasMachine: boolean,
  plannedNetKg: number | undefined,
): ProductionRollDispatchItem['status'] {
  if (item.status === 'in_progress') return 'in_work';
  if (item.status === 'ready_for_warehouse') return 'handover_ready';
  if (item.status === 'done') {
    if (item.operatorLine?.warehouseState === 'sent') return 'warehouse_handed_off';
    if (item.operatorLine?.warehouseState === 'received') return 'warehouse_accepted';
    if (item.operatorLine?.warehouseState === 'delivered') return 'warehouse_delivered';
    return 'warehouse_pending';
  }
  if (hasOperator && hasMachine && plannedNetKg !== undefined && plannedNetKg > 0) {
    return item.status === 'assigned' ? 'assigned' : 'queued';
  }
  return 'blocked';
}

function productionOrderStatusLabel(approved: boolean, rolls: ProductionRollDispatchItem[]) {
  if (!approved) return 'Назначение не завершено';
  if (rolls.length === 0) return 'В производстве';
  const statuses = rolls.map((roll) => roll.status);
  if (statuses.every((status) => status === 'warehouse_delivered')) return 'Выдан со склада';
  if (statuses.every((status) => ['warehouse_accepted', 'warehouse_delivered'].includes(status))) {
    return 'Принят складом';
  }
  if (
    statuses.every((status) =>
      ['warehouse_handed_off', 'warehouse_accepted', 'warehouse_delivered'].includes(status),
    )
  ) {
    return 'Передан на склад';
  }
  if (statuses.every((status) => status === 'warehouse_pending')) return 'Ждет склад';
  return 'В производстве';
}

function blockedRollReason(
  hasOperator: boolean,
  hasMachine: boolean,
  plannedNetKg: number | undefined,
) {
  const missing = [
    !hasOperator ? 'оператор' : undefined,
    !hasMachine ? 'станок' : undefined,
    plannedNetKg === undefined || plannedNetKg <= 0 ? 'плановый вес' : undefined,
  ].filter(Boolean);
  return missing.length ? `Нужен ${missing.join(', ')}` : 'Нужна проверка рулона';
}

function rollGroupsForDispatchItems(
  order: ServerProductionOrder,
  rolls: ProductionRollDispatchItem[],
): OrderRollGroup[] {
  const groups = new Map<string, ProductionRollDispatchItem[]>();
  for (const roll of rolls) {
    groups.set(roll.orderLineId, [...(groups.get(roll.orderLineId) ?? []), roll]);
  }
  return Array.from(groups.entries()).map(([lineId, items], index) => {
    const first = items[0];
    const plannedNetKg = items.every((item) => item.plannedNetKg !== undefined)
      ? items.reduce((sum, item) => sum + item.plannedNetKg!, 0)
      : undefined;
    return {
      id: lineId,
      title: `Позиция ${index + 1}`,
      filmType: first?.filmType ?? 'Пленка',
      micron: first?.micron ?? 'из заявки',
      color: 'по заявке',
      sizeMeters: first?.sizeMeters ?? 'нет данных',
      sleeve: 'по заявке',
      recipe: 'из коммерческой заявки',
      recipeVersion: 'backend',
      plannedRolls: items.length,
      plannedNetKg,
      tolerancePercent: 5,
      machine: first?.machineLabel ?? 'Не назначен',
      owner: first?.operatorLabel ?? 'Зав. производства',
      status: order.approvalState === 'approved' ? 'approved' : 'pending',
      blocker: items.some((item) => item.status === 'blocked')
        ? 'Не все рулоны назначены'
        : undefined,
      rollIds: items.map((item) => item.rollId),
    };
  });
}

function commercialOrderForProduction(order: ServerProductionOrder): CommercialOrderRequest {
  const commercial = order.commercialOrder;
  const counterparty = commercial.counterparty;
  const isStockOrder = commercial.requestType === 'stock_reserve';
  const billingSnapshot =
    !isStockOrder && counterparty && commercial.counterpartyId
      ? {
          id: `${commercial.id}-billing`,
          counterpartyId: commercial.counterpartyId,
          label: counterpartyLabel(counterparty),
          type: 'legal_entity' as const,
          inn: counterparty.inn ?? undefined,
          source:
            counterparty.billingSource === 'manual_platform'
              ? ('manual_order_entry' as const)
              : ('counterparty_card_snapshot' as const),
          syncStatus:
            counterparty.syncStatus === 'ready'
              ? ('mock_snapshot' as const)
              : ('needs_1C_discovery' as const),
          createdBy: 'Система',
          createdAt: commercial.createdAt,
        }
      : undefined;
  return {
    id: commercial.id,
    createdBy: commercial.creatorRole === 'production_lead' ? 'Зав. производства' : 'Коммерция',
    creatorRole: commercial.creatorRole,
    ...(commercial.counterpartyId ? { counterpartyId: commercial.counterpartyId } : {}),
    ...(billingSnapshot ? { billingSnapshot } : {}),
    requestType:
      commercial.requestType === 'stock_reserve' ? 'на склад/резерв' : 'клиентский заказ',
    status: 'in_work',
    productionStatus: order.indicator === 'in_production' ? 'in_production' : 'needs_production',
    warehouseCoverStatus: warehouseStatus(commercial.warehouseCoverStatus),
    paymentStatus: paymentStatus(commercial.paymentStatus),
    shipmentStatus: shipmentStatus(commercial.shipmentStatus),
    createdAt: commercial.createdAt,
    submittedAt: commercial.createdAt,
    commercialConfirmationPolicy:
      commercial.commercialConfirmationPolicy === 'bypassed_by_delegation'
        ? 'bypassed_by_delegation'
        : 'required',
    requiresCommercialRecipeConfirmation: commercial.creatorRole === 'production_lead',
    positions: [],
  };
}

function counterpartyLabel(counterparty: ServerCounterparty | null) {
  return (
    counterparty?.displayName ||
    counterparty?.legalName ||
    counterparty?.id ||
    'Контрагент не указан'
  );
}

function priorityFromNumber(priority: number): ProductionPriority {
  if (priority >= 100) return 'критично';
  if (priority >= 50) return 'срочно';
  return 'обычный';
}

function priorityForOrder(items: ServerRollDispatchItem[]) {
  return items.some((item) => item.priority >= 100)
    ? 'критично'
    : items.some((item) => item.priority >= 50)
      ? 'срочно'
      : 'обычный';
}

function warehouseStatus(value: string): CommercialOrderRequest['warehouseCoverStatus'] {
  if (value === 'needs_production') return 'needs_production';
  if (value === 'partial_proposed') return 'partial_proposed';
  if (value === 'full_proposed') return 'full_proposed';
  if (value === 'partial_confirmed') return 'partial_confirmed';
  if (value === 'full_confirmed') return 'full_confirmed';
  if (value === 'recheck_requested') return 'recheck_requested';
  if (value === 'rejected') return 'rejected';
  return 'not_checked';
}

function warehouseStatusLabel(value: string) {
  if (value === 'needs_production') return 'в производство';
  if (value === 'partial_proposed') return 'часть со склада';
  if (value === 'full_proposed') return 'склад закрывает';
  if (value === 'partial_confirmed' || value === 'full_confirmed') return 'резерв подтвержден';
  if (value === 'recheck_requested') return 'перепроверка склада';
  return 'не проверено';
}

function paymentStatus(value: string): CommercialOrderRequest['paymentStatus'] {
  if (value === 'paid') return 'оплачен';
  if (value === 'partial') return 'частично оплачен';
  if (value === 'overdue') return 'просрочка';
  return 'не оплачен';
}

function shipmentStatus(value: string): CommercialOrderRequest['shipmentStatus'] {
  if (value === 'shipped') return 'отгружено';
  if (value === 'partially_shipped') return 'частично отгружено';
  if (value === 'problem') return 'проблема отгрузки';
  return 'не отгружено';
}
