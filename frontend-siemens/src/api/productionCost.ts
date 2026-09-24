export const PRODUCTION_COST_UNRESOLVED_REASONS = [
  'weight_unresolved',
  'material_usage_unresolved',
  'material_price_unresolved',
  'spool_type_unresolved',
  'spool_price_unresolved',
  'spool_geometry_unresolved',
  'payroll_unresolved',
  'order_cost_allocation_unresolved',
  'additional_cost_unresolved',
  'canonical_capture_unresolved',
  'defect_present',
  'operator_step_unresolved',
  'dispatch_not_completed',
  'post_session_not_closed',
  'machine_assignment_not_completed',
  'shift_not_closed',
  'snapshot_pending',
] as const;

export type ProductionCostUnresolvedReason =
  (typeof PRODUCTION_COST_UNRESOLVED_REASONS)[number];

export const PRODUCTION_COST_UNRESOLVED_LABELS: Record<
  ProductionCostUnresolvedReason,
  string
> = {
  weight_unresolved: 'Нет подтверждённого веса рулона',
  material_usage_unresolved: 'Не определена рецептура или расход сырья',
  material_price_unresolved: 'Нет цены сырья на дату выпуска',
  spool_type_unresolved: 'Не определён тип шпули',
  spool_price_unresolved: 'Нет цены шпули на дату выпуска',
  spool_geometry_unresolved: 'Нет ширины шпули',
  payroll_unresolved: 'Не рассчитана работа оператора',
  order_cost_allocation_unresolved: 'Не закрыта база распределения расходов заказа',
  additional_cost_unresolved: 'Не определена дополнительная производственная затрата',
  canonical_capture_unresolved: 'Нет канонического замера веса',
  defect_present: 'Рулон отмечен как брак',
  operator_step_unresolved: 'Рулон не передан на склад',
  dispatch_not_completed: 'Выпуск рулона не завершён',
  post_session_not_closed: 'Сеанс оператора не закрыт',
  machine_assignment_not_completed: 'Назначение на станок не завершено',
  shift_not_closed: 'Смена не закрыта',
  snapshot_pending: 'Себестоимость ожидает фонового расчёта',
};

export const PRODUCTION_COST_CALCULATION_VERSION = 'production-cost-v1' as const;

export type ProductionCostBasis =
  | { kind: 'planned'; weightGrams: number }
  | { kind: 'actual'; weightGrams: number };

export type ProductionCostNullableBasis =
  | ProductionCostBasis
  | { kind: 'actual'; weightGrams: null };

export type NonEmptyProductionCostReasons = [
  ProductionCostUnresolvedReason,
  ...ProductionCostUnresolvedReason[],
];

export type ProductionCostCompleteAmounts = {
  materialAmountKopecks: number;
  spoolAmountKopecks: number;
  payrollAmountKopecks: number;
  additionalAmountKopecks: number;
  totalAmountKopecks: number;
  totalKopecksPerKg: number;
  unresolvedReasons: [];
};

export type ProductionCostPartialAmounts = {
  materialAmountKopecks: number | null;
  spoolAmountKopecks: number | null;
  payrollAmountKopecks: number | null;
  additionalAmountKopecks: number;
  totalAmountKopecks: null;
  totalKopecksPerKg: null;
  unresolvedReasons: NonEmptyProductionCostReasons;
};

type RollProductionCostPlannedPreviewBase = {
  kind: 'planned_preview';
  calculationVersion: typeof PRODUCTION_COST_CALCULATION_VERSION;
  basis: Extract<ProductionCostBasis, { kind: 'planned' }>;
};

export type RollProductionCostPlannedPreviewView = RollProductionCostPlannedPreviewBase &
  (
    | (ProductionCostCompleteAmounts & { status: 'complete' })
    | (ProductionCostPartialAmounts & { status: 'partial' })
  );

type PersistedRollProductionCostSnapshotBase = {
  kind: 'actual_snapshot';
  calculationVersion: string;
  snapshotId: string;
  version: number;
  producedAt: string;
  closedAt: string;
  createdAt: string;
  basis: Extract<ProductionCostBasis, { kind: 'actual' }>;
};

export type PersistedRollProductionCostSnapshotView =
  PersistedRollProductionCostSnapshotBase &
    (
      | (ProductionCostCompleteAmounts & { status: 'complete' })
      | (ProductionCostPartialAmounts & { status: 'partial' })
    );

export type RollProductionCostPendingView = ProductionCostPartialAmounts & {
  kind: 'actual_pending';
  status: 'pending';
  calculationVersion: typeof PRODUCTION_COST_CALCULATION_VERSION;
  basis: Extract<ProductionCostNullableBasis, { kind: 'actual' }>;
};

export type RollProductionCostView =
  | RollProductionCostPlannedPreviewView
  | PersistedRollProductionCostSnapshotView
  | RollProductionCostPendingView;

const INVALID_RESPONSE = 'Некорректные данные бизнес-показателей.';

function invalid(): never {
  throw new Error(INVALID_RESPONSE);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') invalid();
  return value;
}

function canonicalIso(value: unknown): string {
  const parsed = stringValue(value);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) invalid();
  return parsed;
}

function safeNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    invalid();
  }
  return value;
}

function positiveSafeInteger(value: unknown): number {
  const parsed = safeNonNegativeInteger(value);
  if (parsed === 0) invalid();
  return parsed;
}

function nullableMoney(value: unknown): number | null {
  return value === null ? null : safeNonNegativeInteger(value);
}

function parseReasons(value: unknown): NonEmptyProductionCostReasons {
  if (!Array.isArray(value) || value.length === 0) invalid();
  let previousReasonIndex = -1;
  const reasons = value.map((reason) => {
    if (typeof reason !== 'string') invalid();
    const reasonIndex = PRODUCTION_COST_UNRESOLVED_REASONS.indexOf(
      reason as ProductionCostUnresolvedReason,
    );
    if (reasonIndex <= previousReasonIndex) invalid();
    previousReasonIndex = reasonIndex;
    return reason as ProductionCostUnresolvedReason;
  });
  return reasons as NonEmptyProductionCostReasons;
}

function parseBasis(
  value: unknown,
  expectedKind: 'planned' | 'actual',
  nullable: boolean,
): { kind: 'planned' | 'actual'; weightGrams: number | null } {
  const basis = record(value);
  if (basis.kind !== expectedKind) invalid();
  if (basis.weightGrams === null && nullable) {
    return { kind: expectedKind, weightGrams: null };
  }
  return {
    kind: expectedKind,
    weightGrams: positiveSafeInteger(basis.weightGrams),
  };
}

function parseCompleteAmounts(value: Record<string, unknown>): ProductionCostCompleteAmounts {
  if (!Array.isArray(value.unresolvedReasons) || value.unresolvedReasons.length !== 0) {
    invalid();
  }
  return {
    materialAmountKopecks: safeNonNegativeInteger(value.materialAmountKopecks),
    spoolAmountKopecks: safeNonNegativeInteger(value.spoolAmountKopecks),
    payrollAmountKopecks: safeNonNegativeInteger(value.payrollAmountKopecks),
    additionalAmountKopecks: safeNonNegativeInteger(value.additionalAmountKopecks),
    totalAmountKopecks: safeNonNegativeInteger(value.totalAmountKopecks),
    totalKopecksPerKg: safeNonNegativeInteger(value.totalKopecksPerKg),
    unresolvedReasons: [],
  };
}

function parsePartialAmounts(value: Record<string, unknown>): ProductionCostPartialAmounts {
  if (value.totalAmountKopecks !== null || value.totalKopecksPerKg !== null) invalid();
  return {
    materialAmountKopecks: nullableMoney(value.materialAmountKopecks),
    spoolAmountKopecks: nullableMoney(value.spoolAmountKopecks),
    payrollAmountKopecks: nullableMoney(value.payrollAmountKopecks),
    additionalAmountKopecks: safeNonNegativeInteger(value.additionalAmountKopecks),
    totalAmountKopecks: null,
    totalKopecksPerKg: null,
    unresolvedReasons: parseReasons(value.unresolvedReasons),
  };
}

function parseCurrentCalculationVersion(value: unknown) {
  if (value !== PRODUCTION_COST_CALCULATION_VERSION) invalid();
  return PRODUCTION_COST_CALCULATION_VERSION;
}

export function parseRollProductionCost(value: unknown): RollProductionCostView {
  const cost = record(value);

  if (cost.kind === 'planned_preview') {
    const base = {
      kind: 'planned_preview' as const,
      calculationVersion: parseCurrentCalculationVersion(cost.calculationVersion),
      basis: parseBasis(cost.basis, 'planned', false) as Extract<
        ProductionCostBasis,
        { kind: 'planned' }
      >,
    };
    if (cost.status === 'complete') {
      return { ...base, status: 'complete', ...parseCompleteAmounts(cost) };
    }
    if (cost.status === 'partial') {
      return { ...base, status: 'partial', ...parsePartialAmounts(cost) };
    }
    return invalid();
  }

  if (cost.kind === 'actual_snapshot') {
    const base = {
      kind: 'actual_snapshot' as const,
      calculationVersion: stringValue(cost.calculationVersion),
      snapshotId: stringValue(cost.snapshotId),
      version: positiveSafeInteger(cost.version),
      producedAt: canonicalIso(cost.producedAt),
      closedAt: canonicalIso(cost.closedAt),
      createdAt: canonicalIso(cost.createdAt),
      basis: parseBasis(cost.basis, 'actual', false) as Extract<
        ProductionCostBasis,
        { kind: 'actual' }
      >,
    };
    if (cost.status === 'complete') {
      return { ...base, status: 'complete', ...parseCompleteAmounts(cost) };
    }
    if (cost.status === 'partial') {
      return { ...base, status: 'partial', ...parsePartialAmounts(cost) };
    }
    return invalid();
  }

  if (cost.kind === 'actual_pending' && cost.status === 'pending') {
    return {
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: parseCurrentCalculationVersion(cost.calculationVersion),
      basis: parseBasis(cost.basis, 'actual', true) as Extract<
        ProductionCostNullableBasis,
        { kind: 'actual' }
      >,
      ...parsePartialAmounts(cost),
    };
  }

  return invalid();
}
