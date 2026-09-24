import type {
  WarehouseCoverageCalculation as PersistedCoverageCalculation,
  WarehouseCoverageState as PersistedCoverageState,
} from '@prisma/client';
import {
  WAREHOUSE_COVERAGE_ACTIONS,
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_REASON_CODES,
  WAREHOUSE_COVERAGE_STATES,
  type Capability,
  type WarehouseCoverageAction,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageDecisionKind,
  type WarehouseCoverageOwner,
  type WarehouseCoverageProjection,
  type WarehouseCoverageReasonCode,
  type WarehouseCoverageState,
} from '@plenka/contracts';

export interface CoverageProjectionContext {
  workflowVersion: 1 | 2;
  state: PersistedCoverageState | null;
  calculation: PersistedCoverageCalculation | null;
  currentInventoryEpoch: bigint;
  orderCancellationStatus: 'active' | 'cancelled';
  productionOrderExists: boolean;
  currentDecisionKind: WarehouseCoverageDecisionKind | null;
  reserveTaskStatus: 'open' | 'partial' | 'closed' | null;
  permittedActions: readonly WarehouseCoverageAction[];
}

type CoverageRoute = Readonly<{
  nextOwner: WarehouseCoverageOwner;
  actions: readonly WarehouseCoverageAction[];
}>;

const ROUTES = {
  calculating: { nextOwner: 'system', actions: [] },
  awaitingFinance: {
    nextOwner: 'finance',
    actions: ['use_warehouse', 'produce_all', 'request_recheck'],
  },
  stale: { nextOwner: 'system', actions: ['refresh'] },
  orderSpecChangedRefreshable: { nextOwner: 'system', actions: ['refresh'] },
  orderSpecChangedReview: { nextOwner: 'system', actions: [] },
  unknownOrderSpec: { nextOwner: 'commercial', actions: ['correct_order_spec'] },
  unknownRollFact: { nextOwner: 'finance', actions: ['request_recheck'] },
  unsupportedPolicy: { nextOwner: 'system', actions: [] },
  recheckRequested: { nextOwner: 'warehouse', actions: ['resolve_recheck'] },
  productionRequiredPreOrder: { nextOwner: 'system', actions: ['request_recheck'] },
  productionRequiredPostOrder: { nextOwner: 'system', actions: [] },
  warehouseReservedOpen: { nextOwner: 'warehouse', actions: [] },
  warehouseReservedClosed: { nextOwner: 'system', actions: [] },
} as const satisfies Record<string, CoverageRoute>;

const ACTION_CAPABILITY = {
  use_warehouse: 'warehouse_coverage:decide',
  produce_all: 'warehouse_coverage:decide',
  request_recheck: 'warehouse_coverage:request_recheck',
  correct_order_spec: 'order:update_position',
  resolve_recheck: 'warehouse_coverage:resolve_recheck',
  refresh: 'warehouse_coverage:refresh',
  report_physical_exception: 'warehouse_coverage:report_physical_exception',
} as const satisfies Record<WarehouseCoverageAction, Capability>;

const STALE_SENSITIVE_STATES = new Set<WarehouseCoverageState>([
  'awaiting_finance',
  'unknown',
  'production_required',
]);

export function permittedWarehouseCoverageActions(
  capabilities: readonly Capability[],
): WarehouseCoverageAction[] {
  const held = new Set(capabilities);
  return WAREHOUSE_COVERAGE_ACTIONS.filter((action) => held.has(ACTION_CAPABILITY[action]));
}

export function effectiveCoverageRoutingReason(
  reasons: readonly WarehouseCoverageReasonCode[],
): WarehouseCoverageReasonCode | null {
  const present = new Set(reasons);
  if (present.has('unsupported_policy_version')) return 'unsupported_policy_version';
  if (present.has('order_spec_incomplete')) return 'order_spec_incomplete';
  if (present.has('roll_ownership_unverified')) return 'roll_ownership_unverified';
  if (present.has('roll_facts_incomplete')) return 'roll_facts_incomplete';
  return null;
}

export function projectWarehouseCoverage(
  context: CoverageProjectionContext,
): WarehouseCoverageProjection {
  assertContextEnvelope(context);
  if (context.state === null) {
    if (context.calculation !== null) invariant('calculation exists without coverage state');
    return emptyProjection(context.workflowVersion, 0);
  }

  const state = coverageState(context.state.state);
  const stateVersion = positiveInteger(context.state.stateVersion, 'stateVersion');
  nonNegativeInteger(context.state.generation, 'state generation');

  if (context.calculation === null) {
    if (
      state !== 'calculating' ||
      context.state.generation !== 0 ||
      context.state.currentCalculationId !== null ||
      context.state.currentDecisionId !== null
    ) {
      invariant('missing calculation is only valid for the initial calculating state');
    }
    return emptyProjection(context.workflowVersion, stateVersion);
  }

  const calculation = validateCalculation(context.state, context.calculation);
  const normalizedReasons = normalizeReasons(calculation.reasonCodes);
  const epochMismatch = calculation.inventoryEpoch !== context.currentInventoryEpoch;
  const staleSensitive =
    STALE_SENSITIVE_STATES.has(state) &&
    (state !== 'production_required' ||
      (context.currentDecisionKind === 'auto_produce_all' &&
        !context.productionOrderExists));
  const projectedState = state === 'stale' || (staleSensitive && epochMismatch) ? 'stale' : state;
  const reasonCodes =
    projectedState === 'stale'
      ? (['inventory_changed'] as WarehouseCoverageReasonCode[])
      : projectedState === 'recheck_requested'
        ? (['warehouse_recheck_pending'] as WarehouseCoverageReasonCode[])
        : normalizedReasons;
  const route = routeFor({
    state: projectedState,
    availability: calculation.availability,
    reasonCodes,
    productionOrderExists: context.productionOrderExists,
    orderCancellationStatus: context.orderCancellationStatus,
    currentDecisionKind: context.currentDecisionKind,
    reserveTaskStatus: context.reserveTaskStatus,
  });
  const permitted = new Set(context.permittedActions);

  return {
    workflowVersion: context.workflowVersion,
    state: projectedState,
    stateVersion,
    generation: calculation.generation,
    availability: calculation.availability,
    reasonCodes,
    nextOwner: route.nextOwner,
    availableActions: route.actions.filter((action) => permitted.has(action)),
    requiredRollCount: calculation.requiredRollCount,
    matchedRollCount: calculation.matchedRollCount,
    uncertainRollCount: calculation.uncertainRollCount,
    calculatedAt: calculation.calculatedAt.toISOString(),
    stale: projectedState === 'stale' || projectedState === 'order_spec_changed',
  };
}

function emptyProjection(
  workflowVersion: 1 | 2,
  stateVersion: number,
): WarehouseCoverageProjection {
  return {
    workflowVersion,
    state: 'calculating',
    stateVersion,
    generation: null,
    availability: null,
    reasonCodes: [],
    nextOwner: 'system',
    availableActions: [],
    requiredRollCount: 0,
    matchedRollCount: 0,
    uncertainRollCount: 0,
    calculatedAt: null,
    stale: false,
  };
}

function routeFor(input: {
  state: WarehouseCoverageState;
  availability: WarehouseCoverageAvailability;
  reasonCodes: readonly WarehouseCoverageReasonCode[];
  productionOrderExists: boolean;
  orderCancellationStatus: CoverageProjectionContext['orderCancellationStatus'];
  currentDecisionKind: CoverageProjectionContext['currentDecisionKind'];
  reserveTaskStatus: CoverageProjectionContext['reserveTaskStatus'];
}): CoverageRoute {
  switch (input.state) {
    case 'calculating':
      return invariant('calculating state cannot reference a published calculation');
    case 'awaiting_finance':
      if (
        input.availability !== 'verified_full' ||
        !input.reasonCodes.includes('full_cover_available')
      ) {
        invariant('awaiting_finance requires verified full coverage');
      }
      return ROUTES.awaitingFinance;
    case 'stale':
      if (!input.reasonCodes.includes('inventory_changed')) {
        invariant('stale state requires inventory_changed');
      }
      return ROUTES.stale;
    case 'order_spec_changed':
      return input.currentDecisionKind === null && input.orderCancellationStatus === 'active'
        ? ROUTES.orderSpecChangedRefreshable
        : ROUTES.orderSpecChangedReview;
    case 'unknown': {
      if (input.availability !== 'unknown') {
        invariant('unknown state requires unknown availability');
      }
      const reason = effectiveCoverageRoutingReason(input.reasonCodes);
      if (reason === 'unsupported_policy_version') return ROUTES.unsupportedPolicy;
      if (reason === 'order_spec_incomplete') return ROUTES.unknownOrderSpec;
      if (reason === 'roll_ownership_unverified' || reason === 'roll_facts_incomplete') {
        return ROUTES.unknownRollFact;
      }
      return invariant('unknown state requires one routable reason');
    }
    case 'recheck_requested':
      if (!input.reasonCodes.includes('warehouse_recheck_pending')) {
        invariant('recheck_requested requires warehouse_recheck_pending');
      }
      return ROUTES.recheckRequested;
    case 'production_required':
      if (input.currentDecisionKind === 'produce_all') {
        if (input.availability !== 'verified_full') {
          invariant('explicit produce_all requires verified full coverage');
        }
        return ROUTES.productionRequiredPostOrder;
      }
      if (input.currentDecisionKind === 'auto_produce_all') {
        if (input.availability !== 'unavailable') {
          invariant('auto_produce_all requires unavailable coverage');
        }
        return input.productionOrderExists
          ? ROUTES.productionRequiredPostOrder
          : ROUTES.productionRequiredPreOrder;
      }
      return invariant('production_required requires a production decision');
    case 'warehouse_reserved':
      if (input.availability !== 'verified_full') {
        invariant('warehouse_reserved requires verified full coverage');
      }
      if (input.reserveTaskStatus === 'open' || input.reserveTaskStatus === 'partial') {
        return ROUTES.warehouseReservedOpen;
      }
      if (input.reserveTaskStatus === 'closed') return ROUTES.warehouseReservedClosed;
      invariant('warehouse_reserved requires an exact reserve task');
  }
}

function validateCalculation(
  state: PersistedCoverageState,
  calculation: PersistedCoverageCalculation,
): PersistedCoverageCalculation & { availability: WarehouseCoverageAvailability } {
  if (
    calculation.orderId !== state.orderId ||
    state.currentCalculationId !== calculation.id ||
    state.generation !== calculation.generation
  ) {
    invariant('state and calculation provenance mismatch');
  }
  positiveInteger(calculation.generation, 'generation');
  const requiredRollCount = nonNegativeInteger(calculation.requiredRollCount, 'requiredRollCount');
  const matchedRollCount = nonNegativeInteger(calculation.matchedRollCount, 'matchedRollCount');
  nonNegativeInteger(calculation.uncertainRollCount, 'uncertainRollCount');
  if (matchedRollCount > requiredRollCount) invariant('matchedRollCount exceeds requiredRollCount');
  if (!Number.isFinite(calculation.calculatedAt.getTime())) invariant('invalid calculatedAt');

  return {
    ...calculation,
    availability: coverageAvailability(calculation.availability),
  };
}

function normalizeReasons(value: unknown): WarehouseCoverageReasonCode[] {
  if (!Array.isArray(value)) invariant('reasonCodes must be an array');
  const reasons = new Set<WarehouseCoverageReasonCode>();
  for (const reason of value) {
    if (
      typeof reason !== 'string' ||
      !(WAREHOUSE_COVERAGE_REASON_CODES as readonly string[]).includes(reason)
    ) {
      invariant('unknown reason code');
    }
    reasons.add(reason as WarehouseCoverageReasonCode);
  }
  return WAREHOUSE_COVERAGE_REASON_CODES.filter((reason) => reasons.has(reason));
}

function coverageState(value: string): WarehouseCoverageState {
  if (!(WAREHOUSE_COVERAGE_STATES as readonly string[]).includes(value)) {
    invariant('unknown state');
  }
  return value as WarehouseCoverageState;
}

function coverageAvailability(value: string): WarehouseCoverageAvailability {
  if (!(WAREHOUSE_COVERAGE_AVAILABILITIES as readonly string[]).includes(value)) {
    invariant('unknown availability');
  }
  return value as WarehouseCoverageAvailability;
}

function assertContextEnvelope(context: CoverageProjectionContext): void {
  if (context.workflowVersion !== 1 && context.workflowVersion !== 2) {
    invariant('unknown workflow version');
  }
  if (context.currentInventoryEpoch < 0n) invariant('negative inventory epoch');
  if (
    context.orderCancellationStatus !== 'active' &&
    context.orderCancellationStatus !== 'cancelled'
  ) {
    invariant('unknown order cancellation status');
  }
  if (context.workflowVersion === 1 && (context.state !== null || context.calculation !== null)) {
    invariant('V1 order cannot carry V2 coverage state');
  }
  for (const action of context.permittedActions) {
    if (!(WAREHOUSE_COVERAGE_ACTIONS as readonly string[]).includes(action)) {
      invariant('unknown permitted action');
    }
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) invariant(`${field} must be positive`);
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) invariant(`${field} must be nonnegative`);
  return value;
}

function invariant(detail: string): never {
  throw new Error(`Warehouse coverage projection invariant: ${detail}`);
}
