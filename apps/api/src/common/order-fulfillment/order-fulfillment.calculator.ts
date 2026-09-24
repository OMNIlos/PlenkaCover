import {
  COMMERCIAL_COMPLETION_BLOCKERS,
  type CommercialCompletionBlocker,
  type ShipmentStatus,
} from '@plenka/contracts';
import type {
  FulfillmentOrder,
  FulfillmentPositionResult,
  FulfillmentTask,
  FulfillmentV1Order,
  FulfillmentV2Order,
  OrderFulfillmentResult,
  WarehouseCoverageCalculationInput,
  WarehouseCoverageDecisionInput,
} from './order-fulfillment.types';

const APPROVED_COVER_STATUSES = new Set(['partial_confirmed', 'full_confirmed']);
const PRODUCTION_ROUTE_STATUSES = new Set(['needs_production', 'rejected']);

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function orderedBlockers(values: Set<CommercialCompletionBlocker>) {
  return COMMERCIAL_COMPLETION_BLOCKERS.filter((blocker) => values.has(blocker));
}

function taskRowsForPosition(
  order: Pick<FulfillmentV1Order, 'id' | 'orderNumber'>,
  positionId: string,
  task: FulfillmentTask,
  expectedRollCodes: ReadonlySet<string>,
) {
  if (task.orderId !== null && task.orderId !== order.id) return [];
  if (task.positionId && task.positionId !== positionId) return [];

  return task.rows.filter((row) => {
    if (!expectedRollCodes.has(row.rollCode)) return false;
    if (task.orderId === order.id) {
      return (
        !row.fromOrderId || row.fromOrderId === order.id || row.fromOrderId === order.orderNumber
      );
    }
    return row.fromOrderId === order.id || row.fromOrderId === order.orderNumber;
  });
}

function acceptedRollCount(
  order: Pick<FulfillmentV1Order, 'id' | 'orderNumber'>,
  positionId: string,
  tasks: FulfillmentTask[],
  expectedRollCodes: ReadonlySet<string>,
): number {
  return new Set(
    tasks.flatMap((task) =>
      taskRowsForPosition(order, positionId, task, expectedRollCodes)
        .filter((row) => row.scanStatus === 'accepted')
        .map((row) => row.rollCode),
    ),
  ).size;
}

function calculateV1PositionFulfillment(
  order: FulfillmentV1Order,
  position: FulfillmentV1Order['positions'][number],
  tasks: FulfillmentTask[],
): FulfillmentPositionResult {
  const blockers = new Set<CommercialCompletionBlocker>();
  const approvedProposals = position.coverProposals.filter(
    (proposal) =>
      APPROVED_COVER_STATUSES.has(proposal.status) &&
      Boolean(proposal.commercialApprovedAt) &&
      Boolean(proposal.technicalApprovedAt),
  );
  const approvedCoverTarget = approvedProposals.reduce(
    (sum, proposal) => sum + Math.max(0, Math.min(proposal.coverQty, proposal.reserveQty)),
    0,
  );
  const reservedRollIds = new Set(
    approvedProposals.flatMap((proposal) =>
      proposal.reservedRolls
        .filter(
          (roll) =>
            roll.reservedForOrderId === order.id &&
            roll.reservedForPositionId === position.id &&
            roll.reservedByProposalId === proposal.id,
        )
        .map((roll) => roll.id),
    ),
  );
  const coverRollCodes = uniqueSorted(
    approvedProposals.flatMap((proposal) =>
      proposal.reservedRolls
        .filter(
          (roll) =>
            roll.reservedForOrderId === order.id &&
            roll.reservedForPositionId === position.id &&
            roll.reservedByProposalId === proposal.id,
        )
        .map((roll) => roll.rollCode),
    ),
  );
  const coveredQty = Math.min(position.rollCount, reservedRollIds.size);
  if (coveredQty < Math.min(position.rollCount, approvedCoverTarget)) {
    blockers.add('cover_unresolved');
  }

  const dispatchItems =
    order.productionOrder?.dispatchItems.filter((item) => item.orderLineId === position.id) ?? [];
  const acceptedProductionItems = dispatchItems.filter(
    (item) =>
      item.status === 'done' &&
      item.operatorLine &&
      ['received', 'delivered'].includes(item.operatorLine.warehouseState),
  );
  const productionRollCodes = uniqueSorted(acceptedProductionItems.map((item) => item.rollCode));
  const productionQty = Math.max(0, position.rollCount - coveredQty);
  const acceptedProductionQty = Math.min(productionQty, acceptedProductionItems.length);
  const warehouseReadyQty = dispatchItems.filter((item) =>
    ['ready_for_warehouse', 'done'].includes(item.status),
  ).length;
  const routeResolved =
    approvedProposals.length > 0 ||
    PRODUCTION_ROUTE_STATUSES.has(position.warehouseCoverStatus) ||
    dispatchItems.length > 0;
  if (!routeResolved) blockers.add('cover_unresolved');
  if (routeResolved && acceptedProductionQty < productionQty) {
    blockers.add('production_incomplete');
  }
  if (warehouseReadyQty > acceptedProductionQty) {
    blockers.add('warehouse_acceptance_incomplete');
  }
  if (
    order.productionOrder &&
    order.positions.length > 1 &&
    order.productionOrder.dispatchItems.some((item) => !item.orderLineId)
  ) {
    blockers.add('facts_unavailable');
  }

  const approvedProposalIds = new Set(approvedProposals.map((proposal) => proposal.id));
  if (coveredQty > 0) {
    const expectedCoverRollCodes = new Set(coverRollCodes);
    const coverTasks = tasks.filter(
      (task) =>
        task.mode === 'reserve' &&
        ((task.proposalId && approvedProposalIds.has(task.proposalId)) || !task.proposalId) &&
        taskRowsForPosition(order, position.id, task, expectedCoverRollCodes).length > 0,
    );
    if (!coverTasks.length) blockers.add('facts_unavailable');
    else {
      if (coverTasks.some((task) => task.status !== 'closed')) {
        blockers.add('warehouse_batch_open');
      }
      const acceptedRows = acceptedRollCount(
        order,
        position.id,
        coverTasks,
        expectedCoverRollCodes,
      );
      if (acceptedRows < coveredQty) blockers.add('warehouse_acceptance_incomplete');
    }
  }
  if (warehouseReadyQty > 0 || acceptedProductionQty > 0) {
    const expectedProductionRollCodes = new Set(productionRollCodes);
    const receivingTasks = tasks.filter(
      (task) =>
        task.mode === 'receiving' &&
        taskRowsForPosition(order, position.id, task, expectedProductionRollCodes).length > 0,
    );
    if (!receivingTasks.length) blockers.add('facts_unavailable');
    else {
      if (receivingTasks.some((task) => task.status !== 'closed')) {
        blockers.add('warehouse_batch_open');
      }
      const acceptedRows = acceptedRollCount(
        order,
        position.id,
        receivingTasks,
        expectedProductionRollCodes,
      );
      if (acceptedRows < acceptedProductionQty) {
        blockers.add('warehouse_acceptance_incomplete');
      }
    }
  }

  if (
    order.problems.some(
      (problem) =>
        problem.status !== 'resolved' &&
        (!problem.positionId || problem.positionId === position.id),
    )
  ) {
    blockers.add('blocking_problem');
  }

  return {
    positionId: position.id,
    coveredQty,
    productionQty,
    fulfilledQty: Math.min(position.rollCount, coveredQty + acceptedProductionQty),
    fulfilledRollCodes: uniqueSorted([...coverRollCodes, ...productionRollCodes]),
    blockingReasons: orderedBlockers(blockers),
  };
}

function calculateV1OrderFulfillment(
  order: FulfillmentV1Order,
  tasks: FulfillmentTask[],
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  const positions = order.positions.map((position) =>
    calculateV1PositionFulfillment(order, position, tasks),
  );
  const blockers = new Set<CommercialCompletionBlocker>();
  for (const position of positions) {
    for (const blocker of position.blockingReasons) blockers.add(blocker);
  }
  if (!positions.length) blockers.add('facts_unavailable');
  if (
    order.problems.some((problem) => problem.status !== 'resolved') ||
    order.resolutionCases.some((resolution) => resolution.status !== 'resolved')
  ) {
    blockers.add('blocking_problem');
  }

  const requestedQty = order.positions.reduce((sum, position) => sum + position.rollCount, 0);
  const fulfilledQty = Math.min(
    requestedQty,
    positions.reduce((sum, position) => sum + position.fulfilledQty, 0),
  );
  const blockingReasons = orderedBlockers(blockers);
  const fulfilled =
    requestedQty > 0 && fulfilledQty === requestedQty && blockingReasons.length === 0;
  const state = fulfilled
    ? shipment === 'shipped'
      ? 'shipped'
      : 'ready_for_shipment'
    : 'incomplete';

  return {
    completion: { state, requestedQty, fulfilledQty, blockingReasons },
    positions,
    fulfilledRollCodes: uniqueSorted(positions.flatMap((position) => position.fulfilledRollCodes)),
    shipment,
  };
}

type V2RouteContext = {
  calculation: WarehouseCoverageCalculationInput;
  decision: WarehouseCoverageDecisionInput;
};

function requestedQuantity(order: Pick<FulfillmentV2Order, 'positions'>): number | null {
  const positionIds = new Set<string>();
  let requestedQty = 0;
  for (const position of order.positions) {
    if (
      !position.id ||
      positionIds.has(position.id) ||
      !Number.isSafeInteger(position.rollCount) ||
      position.rollCount <= 0 ||
      !Number.isSafeInteger(requestedQty + position.rollCount)
    ) {
      return null;
    }
    positionIds.add(position.id);
    requestedQty += position.rollCount;
  }
  return order.positions.length > 0 ? requestedQty : null;
}

function currentV2Route(order: FulfillmentV2Order): V2RouteContext | null {
  const state = order.coverageState;
  const calculation = state?.currentCalculation;
  const decision = state?.currentDecision;
  if (
    !state ||
    !calculation ||
    !decision ||
    !Number.isSafeInteger(state.stateVersion) ||
    state.stateVersion <= 0 ||
    !Number.isSafeInteger(state.generation) ||
    state.generation <= 0 ||
    state.currentCalculationId !== calculation.id ||
    state.currentDecisionId !== decision.id ||
    state.generation !== calculation.generation ||
    calculation.orderId !== order.id ||
    decision.orderId !== order.id ||
    decision.calculationId !== calculation.id ||
    decision.generation !== calculation.generation ||
    decision.inputFingerprint !== calculation.inputFingerprint
  ) {
    return null;
  }
  return { calculation, decision };
}

function invalidV2Position(
  position: FulfillmentV2Order['positions'][number],
): FulfillmentPositionResult {
  return {
    positionId: position.id,
    coveredQty: 0,
    productionQty: 0,
    fulfilledQty: 0,
    fulfilledRollCodes: [],
    blockingReasons: ['facts_unavailable'],
  };
}

function finalizeV2Order(
  order: FulfillmentV2Order,
  positions: FulfillmentPositionResult[],
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  const blockers = new Set<CommercialCompletionBlocker>();
  for (const position of positions) {
    for (const blocker of position.blockingReasons) blockers.add(blocker);
  }
  if (!positions.length) blockers.add('facts_unavailable');
  if (
    order.problems.some((problem) => problem.status !== 'resolved') ||
    order.resolutionCases.some((resolution) => resolution.status !== 'resolved')
  ) {
    blockers.add('blocking_problem');
  }
  const requestedQty = requestedQuantity(order) ?? 0;
  const fulfilledQty = Math.min(
    requestedQty,
    positions.reduce((sum, position) => sum + position.fulfilledQty, 0),
  );
  const blockingReasons = orderedBlockers(blockers);
  const fulfilled =
    requestedQty > 0 && fulfilledQty === requestedQty && blockingReasons.length === 0;
  const state = fulfilled
    ? shipment === 'shipped'
      ? 'shipped'
      : 'ready_for_shipment'
    : 'incomplete';
  return {
    completion: { state, requestedQty, fulfilledQty, blockingReasons },
    positions,
    fulfilledRollCodes: uniqueSorted(positions.flatMap((position) => position.fulfilledRollCodes)),
    shipment,
  };
}

function invalidV2Order(
  order: FulfillmentV2Order,
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  return finalizeV2Order(order, order.positions.map(invalidV2Position), shipment);
}

function warehouseMatchesByPosition(
  order: FulfillmentV2Order,
  route: V2RouteContext,
): Map<string, string[]> | null {
  const { calculation, decision } = route;
  const requestedQty = requestedQuantity(order);
  if (
    requestedQty === null ||
    order.coverageState?.state !== 'warehouse_reserved' ||
    calculation.availability !== 'verified_full' ||
    calculation.requiredRollCount !== requestedQty ||
    calculation.matchedRollCount !== requestedQty ||
    calculation.matches.length !== requestedQty ||
    decision.kind !== 'use_warehouse' ||
    decision.expectedRollCount !== requestedQty
  ) {
    return null;
  }

  const positions = new Map(order.positions.map((position) => [position.id, position]));
  const slotsByPosition = new Map<string, Set<number>>();
  const codesByPosition = new Map<string, string[]>();
  const rollIds = new Set<string>();
  const rollCodes = new Set<string>();
  for (const match of calculation.matches) {
    const position = positions.get(match.positionId);
    const roll = match.roll;
    const slots = slotsByPosition.get(match.positionId) ?? new Set<number>();
    if (
      !position ||
      match.orderId !== order.id ||
      match.generation !== calculation.generation ||
      !Number.isSafeInteger(match.slotIndex) ||
      match.slotIndex <= 0 ||
      match.slotIndex > position.rollCount ||
      slots.has(match.slotIndex) ||
      rollIds.has(match.rollId) ||
      !roll.rollCode ||
      rollCodes.has(roll.rollCode) ||
      roll.id !== match.rollId ||
      roll.currentCoverageFactId !== match.coverageFactId ||
      roll.reservedForOrderId !== order.id ||
      (roll.reservedForPositionId !== null &&
        roll.reservedForPositionId !== match.positionId) ||
      roll.reservedByProposalId !== null ||
      roll.reservedByCoverageDecisionId !== decision.id ||
      roll.reservedAt === null ||
      !['received', 'delivered'].includes(roll.warehouseStatus)
    ) {
      return null;
    }
    slots.add(match.slotIndex);
    slotsByPosition.set(match.positionId, slots);
    codesByPosition.set(match.positionId, [
      ...(codesByPosition.get(match.positionId) ?? []),
      roll.rollCode,
    ]);
    rollIds.add(match.rollId);
    rollCodes.add(roll.rollCode);
  }
  for (const position of order.positions) {
    const slots = slotsByPosition.get(position.id);
    if (
      slots?.size !== position.rollCount ||
      Array.from({ length: position.rollCount }, (_, index) => index + 1).some(
        (slot) => !slots.has(slot),
      )
    ) {
      return null;
    }
  }
  return codesByPosition;
}

function v2WarehouseTaskBlockers(
  order: FulfillmentV2Order,
  tasks: FulfillmentTask[],
  decisionId: string,
  expectedRollCodes: string[],
): CommercialCompletionBlocker[] {
  const linkedTasks = tasks.filter((task) => task.coverageDecisionId === decisionId);
  if (linkedTasks.length !== 1) return ['facts_unavailable'];
  const [task] = linkedTasks;
  if (
    !task ||
    task.orderId !== order.id ||
    task.mode !== 'reserve' ||
    task.positionId !== null ||
    task.proposalId !== null
  ) {
    return ['facts_unavailable'];
  }
  if (task.status !== 'closed') {
    return task.status === 'open' || task.status === 'partial'
      ? ['warehouse_batch_open']
      : ['facts_unavailable'];
  }
  if (task.rows.some((row) => row.fromOrderId !== order.id)) {
    return ['facts_unavailable'];
  }
  const expected = new Set(expectedRollCodes);
  const observed = new Set(task.rows.map((row) => row.rollCode));
  if (
    task.rows.length !== expected.size ||
    observed.size !== expected.size ||
    [...observed].some((rollCode) => !expected.has(rollCode)) ||
    task.rows.some((row) => row.scanStatus !== 'accepted')
  ) {
    return ['warehouse_acceptance_incomplete'];
  }
  return [];
}

function calculateV2WarehouseFulfillment(
  order: FulfillmentV2Order,
  tasks: FulfillmentTask[],
  shipment: ShipmentStatus,
  route: V2RouteContext,
): OrderFulfillmentResult | null {
  const codesByPosition = warehouseMatchesByPosition(order, route);
  if (!codesByPosition) return null;
  const allCodes = uniqueSorted([...codesByPosition.values()].flat());
  const taskBlockers = v2WarehouseTaskBlockers(order, tasks, route.decision.id, allCodes);
  const positions = order.positions.map((position) => {
    const blockers = new Set<CommercialCompletionBlocker>(taskBlockers);
    if (
      order.problems.some(
        (problem) =>
          problem.status !== 'resolved' &&
          (!problem.positionId || problem.positionId === position.id),
      )
    ) {
      blockers.add('blocking_problem');
    }
    return {
      positionId: position.id,
      coveredQty: position.rollCount,
      productionQty: 0,
      fulfilledQty: position.rollCount,
      fulfilledRollCodes: uniqueSorted(codesByPosition.get(position.id) ?? []),
      blockingReasons: orderedBlockers(blockers),
    };
  });
  return finalizeV2Order(order, positions, shipment);
}

function productionRouteIsExact(order: FulfillmentV2Order, route: V2RouteContext): boolean {
  const { calculation, decision } = route;
  const productionOrder = order.productionOrder;
  const requestedQty = requestedQuantity(order);
  const availabilityMatchesKind =
    (decision.kind === 'produce_all' && calculation.availability === 'verified_full') ||
    (decision.kind === 'auto_produce_all' && calculation.availability === 'unavailable');
  const calculationCountsAreExact =
    requestedQty !== null &&
    calculation.requiredRollCount === requestedQty &&
    Number.isSafeInteger(calculation.matchedRollCount) &&
    calculation.matchedRollCount >= 0 &&
    calculation.matchedRollCount <= requestedQty &&
    ((calculation.availability === 'verified_full' &&
      calculation.matchedRollCount === requestedQty &&
      calculation.matches.length === requestedQty) ||
      (calculation.availability === 'unavailable' &&
        calculation.matchedRollCount < requestedQty &&
        calculation.matches.length === 0));
  return Boolean(
    order.coverageState?.state === 'production_required' &&
      availabilityMatchesKind &&
      calculationCountsAreExact &&
      decision.expectedRollCount === 0 &&
      productionOrder &&
      productionOrder.commercialOrderId === order.id &&
      productionOrder.sourceCoverageCalculationId === calculation.id &&
      productionOrder.sourceCoverageDecisionId === decision.id &&
      productionOrder.sourceCoverageInputFingerprint === calculation.inputFingerprint &&
      productionOrder.sourceCoverageGeneration === calculation.generation,
  );
}

function calculateV2ProductionFulfillment(
  order: FulfillmentV2Order,
  tasks: FulfillmentTask[],
  shipment: ShipmentStatus,
  route: V2RouteContext,
): OrderFulfillmentResult | null {
  if (!productionRouteIsExact(order, route) || !order.productionOrder) return null;
  const knownPositionIds = new Set(order.positions.map((position) => position.id));
  const dispatchItems = order.productionOrder.dispatchItems;
  const duplicateRollCodes = new Set<string>();
  const observedRollCodes = new Set<string>();
  let malformedDispatch = false;
  for (const item of dispatchItems) {
    if (
      !item.rollCode ||
      observedRollCodes.has(item.rollCode) ||
      !item.orderLineId ||
      !knownPositionIds.has(item.orderLineId)
    ) {
      malformedDispatch = true;
      if (observedRollCodes.has(item.rollCode)) duplicateRollCodes.add(item.rollCode);
    }
    observedRollCodes.add(item.rollCode);
  }

  const positions = order.positions.map((position) => {
    const blockers = new Set<CommercialCompletionBlocker>();
    if (malformedDispatch || duplicateRollCodes.size > 0) blockers.add('facts_unavailable');
    const positionItems = dispatchItems.filter((item) => item.orderLineId === position.id);
    if (positionItems.length > position.rollCount) blockers.add('facts_unavailable');
    const acceptedItems = positionItems.filter(
      (item) =>
        item.status === 'done' &&
        item.operatorLine &&
        ['received', 'delivered'].includes(item.operatorLine.warehouseState),
    );
    const productionRollCodes = uniqueSorted(acceptedItems.map((item) => item.rollCode));
    const acceptedProductionQty = Math.min(position.rollCount, acceptedItems.length);
    if (acceptedProductionQty < position.rollCount) blockers.add('production_incomplete');
    const warehouseReadyQty = positionItems.filter((item) =>
      ['ready_for_warehouse', 'done'].includes(item.status),
    ).length;
    if (warehouseReadyQty > acceptedProductionQty) {
      blockers.add('warehouse_acceptance_incomplete');
    }
    if (warehouseReadyQty > 0 || acceptedProductionQty > 0) {
      const expectedCodes = new Set(productionRollCodes);
      const receivingTasks = tasks.filter(
        (task) =>
          task.mode === 'receiving' &&
          task.proposalId === null &&
          (task.coverageDecisionId === null || task.coverageDecisionId === undefined) &&
          taskRowsForPosition(order, position.id, task, expectedCodes).length > 0,
      );
      if (!receivingTasks.length) blockers.add('facts_unavailable');
      else {
        if (receivingTasks.some((task) => task.status !== 'closed')) {
          blockers.add('warehouse_batch_open');
        }
        if (
          acceptedRollCount(order, position.id, receivingTasks, expectedCodes) <
          acceptedProductionQty
        ) {
          blockers.add('warehouse_acceptance_incomplete');
        }
      }
    }
    if (
      order.problems.some(
        (problem) =>
          problem.status !== 'resolved' &&
          (!problem.positionId || problem.positionId === position.id),
      )
    ) {
      blockers.add('blocking_problem');
    }
    return {
      positionId: position.id,
      coveredQty: 0,
      productionQty: position.rollCount,
      fulfilledQty: acceptedProductionQty,
      fulfilledRollCodes: productionRollCodes,
      blockingReasons: orderedBlockers(blockers),
    };
  });
  return finalizeV2Order(order, positions, shipment);
}

function calculateV2OrderFulfillment(
  order: FulfillmentV2Order,
  tasks: FulfillmentTask[],
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  const route = currentV2Route(order);
  if (!route || requestedQuantity(order) === null) return invalidV2Order(order, shipment);
  return (
    calculateV2WarehouseFulfillment(order, tasks, shipment, route) ??
    calculateV2ProductionFulfillment(order, tasks, shipment, route) ??
    invalidV2Order(order, shipment)
  );
}

function unknownWorkflowFulfillment(
  order: FulfillmentOrder,
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  const v2Shape = {
    id: order.id,
    orderNumber: order.orderNumber,
    positions: order.positions.map((position) => ({
      id: position.id,
      rollCount: position.rollCount,
    })),
    coverageState: null,
    productionOrder: null,
    problems: order.problems,
    resolutionCases: order.resolutionCases,
  } satisfies FulfillmentV2Order;
  return invalidV2Order(v2Shape, shipment);
}

export function calculateOrderFulfillment(
  order: FulfillmentOrder,
  tasks: FulfillmentTask[],
  shipment: ShipmentStatus,
): OrderFulfillmentResult {
  if (order.warehouseCoverageWorkflowVersion === 1) {
    return calculateV1OrderFulfillment(order, tasks, shipment);
  }
  if (order.warehouseCoverageWorkflowVersion === 2) {
    return calculateV2OrderFulfillment(order, tasks, shipment);
  }
  return unknownWorkflowFulfillment(order, shipment);
}
