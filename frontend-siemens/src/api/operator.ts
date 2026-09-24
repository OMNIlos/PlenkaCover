import {
  ApiResponseParseError,
  apiGet,
  apiGetOptional,
  apiPost,
  type ApiRequestOptions,
} from './client';
import type {
  LabelState,
  OperatorShift,
  OperatorRollProgress,
  OperatorRollReweighResult,
  OperatorRollStepBackResult,
  OperatorRollLine,
  OrderRollGroup,
  ProductionPriority,
  RollWarehouseState,
} from '../domain/types';
import type {
  OperatorOrderRuntime,
  OperatorOrderStatus,
  OperatorRuntimeState,
} from '../domain/operatorRuntime';
import type { MachineChangeFinalizationView, OperatorMachineChangeView } from './production';
import {
  parseOperatorPayrollProjection,
  type ServerOperatorPayrollBreakdownRow,
  type ServerOperatorPayrollPreview,
  type ServerOperatorPayrollUnresolvedFact,
} from './operatorPayroll';
import type { ServerPayrollTariffOrderReference } from './payrollTariffOrders';
import {
  isOperatorReportableProblemType,
  type OperatorReportableProblemType,
} from '../domain/operatorProblem';
import type { DefectBagType } from '../domain/defectBagLabels';

export function fetchCurrentOperatorMachineChange(options?: ApiRequestOptions) {
  return apiGetOptional<OperatorMachineChangeView>(
    '/api/operator/machine-changes/current',
    options,
  );
}

export function finalizeOperatorMachineChange(changeId: string, input: { bigBagId?: string } = {}) {
  return apiPost<MachineChangeFinalizationView>(
    `/api/operator/machine-changes/${encodeURIComponent(changeId)}/finalize`,
    input,
  );
}

export type OperatorShiftBagView = {
  bagId: string;
  code: string;
  material: string;
  materialId: string | null;
  warehouseKg: number | null;
  startKg: number;
  endKg: number | null;
  addedReason: string | null;
  releasedReason: string | null;
  active: boolean;
  releasedAt: string | null;
  sequence: number;
};

export type OperatorShiftBalanceView = {
  producedKg: number;
  defectKg: number;
  expectedUsageKg: number;
  actualUsageKg: number | null;
  deviationPercent: number | null;
  status: 'pending' | 'ok' | 'mismatch';
};

export type OperatorShiftClosingPayrollView = {
  sessionId: string;
  shiftId: string;
  status: ServerOperatorPayrollPreview['status'];
  appliedTariffOrders: ServerPayrollTariffOrderReference[];
  summary: ServerOperatorPayrollPreview['summary'];
  breakdown: ServerOperatorPayrollBreakdownRow[];
  unresolved: ServerOperatorPayrollUnresolvedFact[];
};

export type OperatorShiftCloseResult = {
  balance: OperatorShiftBalanceView;
  problemId: string | null;
  releasedRollIds: string[];
  closingPayroll: OperatorShiftClosingPayrollView;
};

export type OperatorShiftBagReleaseResult = {
  code: string;
  bagId: string;
  startKg: number;
  endKg: number;
  active: false;
  status: 'available' | 'consumed';
  releasedAt: string;
};

export type OperatorBigBagOption = {
  id: string;
  code: string;
  material: string;
  materialId: string | null;
  warehouseKg: number | null;
  currentKg: number | null;
  status: 'available' | 'in_use' | 'consumed';
};

type ServerOperatorShift = {
  id: string;
  status: 'scheduled' | 'start_missing' | 'active' | 'bag_missing' | 'close_pending' | 'closed';
  operatorName: string;
  workplace: string;
  plannedStartAt?: string;
  plannedEndAt?: string;
  bigBagId?: string;
  startKg?: number;
  endKg?: number;
  expectedEndKg?: number;
  plannedShortageKg?: number;
  plannedUsageKg?: number;
  actualUsageKg?: number;
  deviationPercent?: number;
  bags?: OperatorShiftBagView[];
  defectBag?: OperatorShift['defectBag'];
  defectBags?: OperatorShift['defectBags'];
  balance?: OperatorShiftBalanceView;
  plannedConsumptionKg?: number;
  yieldRatio?: number;
  estimatedMinutes?: number;
};

type ServerOperatorRecipe = {
  name: string;
  version: number | null;
  ingredients: Array<{ name: string; shareBasisPoints: number }>;
};

type ServerOperatorRoll = {
  id: string;
  dispatchItemId: string;
  replacesDispatchItemId?: string | null;
  sequenceNumber: number;
  attemptNumber?: number;
  orderLineId?: string | null;
  positionSequence?: number;
  filmType?: string | null;
  queueRank: number;
  priority: number;
  machineId: string | null;
  machineLabel: string | null;
  plannedLengthM: number | null;
  rawMaterialId?: string | null;
  rawMaterialLabel?: string | null;
  recipeVersion?: string | null;
  characteristicsSnapshot: {
    actualThickness?: string | null;
    accountingThickness?: string | null;
    widthMm?: number | null;
    spoolType?: string | null;
    birka?: string | null;
    manualBirka?: string | null;
    comment?: string | null;
    recipe?: ServerOperatorRecipe | null;
    legacyRecipeName?: string;
  } | null;
  updatedAt: string;
  status: OperatorOrderStatus;
  plannedNetKg: number | null;
  spoolWeightPolicy?: 'standard_700g' | 'physical_measurement';
  spoolKg: number | null;
  grossKg?: number | null;
  netKg: number | null;
  toleranceOk: boolean | null;
  labelState: string;
  warehouseState: string;
};

type ServerOperatorOrder = {
  id: string;
  title: string;
  customerAlias: string | null;
  commercialComment?: string | null;
  filmType: string | null;
  status: OperatorOrderStatus;
  progress?: OperatorRollProgress;
  plannedRolls: number;
  completedRolls: number;
  currentRoll: number;
  currentDispatchItemId?: string;
  rollPlanKg: number | null;
  spoolKg: number | null;
  rollNetKg: number | null;
  rolls: ServerOperatorRoll[];
};

type ServerOperatorRuntime = {
  shift: ServerOperatorShift | null;
  orders: ServerOperatorOrder[];
  generatedAt: string;
};

const labelStates = new Set<LabelState>([
  'not_printed',
  'delivery_unknown',
  'print_requested',
  'submitted',
  'printed',
  'applied',
  'verified',
  'reprint_requested',
  'voided',
  'damaged_lookup_required',
]);
const warehouseStates = new Set<RollWarehouseState>([
  'not_ready',
  'ready_for_handover',
  'sent',
  'received',
  'missing',
  'delivered',
  // брак, оформленный складом при приёмке (терминальное проблемное состояние)
  'defect',
]);

function priorityFromNumber(priority: number): ProductionPriority {
  if (priority >= 3) return 'критично';
  if (priority >= 2) return 'срочно';
  return 'обычный';
}

function orderState(status: OperatorOrderStatus): OperatorOrderRuntime['state'] {
  if (status === 'assigned') return 'new';
  if (status === 'deferred' || status === 'defect') return 'deferred';
  if (status === 'qr_check') return 'qr_check';
  if (status === 'handover') return 'handover';
  if (status === 'warehouse') return 'warehouse';
  return 'in_progress';
}

function labelState(value: string): LabelState {
  return labelStates.has(value as LabelState) ? (value as LabelState) : 'not_printed';
}

function warehouseState(value: string): RollWarehouseState {
  return warehouseStates.has(value as RollWarehouseState)
    ? (value as RollWarehouseState)
    : 'not_ready';
}

function normalizedLegacyInteger(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function isBoundedProgress(
  progress: OperatorRollProgress | undefined,
): progress is OperatorRollProgress {
  if (!progress) return false;
  const values = [progress.current, progress.completed, progress.total];
  return (
    values.every(Number.isInteger) &&
    progress.total >= 0 &&
    progress.current >= 0 &&
    progress.current <= progress.total &&
    progress.completed >= 0 &&
    progress.completed <= progress.total
  );
}

function operatorRollProgress(order: ServerOperatorOrder): OperatorRollProgress {
  if (isBoundedProgress(order.progress)) return { ...order.progress };

  const total = normalizedLegacyInteger(order.plannedRolls);
  return {
    current: Math.min(normalizedLegacyInteger(order.currentRoll), total),
    completed: Math.min(normalizedLegacyInteger(order.completedRolls), total),
    total,
  };
}

function rollPositionKey(roll: ServerOperatorRoll): string {
  const orderLineId = roll.orderLineId?.trim();
  if (orderLineId) return `line:${orderLineId}`;
  const sequence = normalizedLegacyInteger(roll.positionSequence ?? 1);
  return `legacy-sequence:${sequence > 0 ? sequence : 1}`;
}

function rollGroup(
  order: ServerOperatorOrder,
  positionRolls: ServerOperatorRoll[],
  workplace: string,
  positionNumber: number,
): OrderRollGroup {
  const first =
    positionRolls.find((roll) => roll.dispatchItemId === order.currentDispatchItemId) ??
    positionRolls[0];
  const length = first?.plannedLengthM;
  const width = first?.characteristicsSnapshot?.widthMm;
  const actualThickness = first?.characteristicsSnapshot?.actualThickness ?? 'Не указана';
  const accountingThickness = first?.characteristicsSnapshot?.accountingThickness
    ?.replace(/\s*мкм\s*$/iu, '')
    .trim();
  const micron = accountingThickness
    ? `${actualThickness} (${accountingThickness} бух.)`
    : actualThickness;
  const standardBirka = first?.characteristicsSnapshot?.birka?.trim();
  const manualBirka = first?.characteristicsSnapshot?.manualBirka?.trim();
  const recipeSnapshot = first?.rawMaterialId ? null : first?.characteristicsSnapshot?.recipe;
  const recipeName =
    recipeSnapshot?.name.trim() ||
    first?.rawMaterialLabel?.trim() ||
    first?.characteristicsSnapshot?.legacyRecipeName?.trim() ||
    undefined;
  const normalizedFilmType = first?.filmType?.trim() || order.filmType?.trim() || '';
  const rollType =
    ['Полурукав', 'Рукав', 'Полотно', 'Фальц'].find((candidate) =>
      new RegExp(`(?:^|\\s)${candidate}(?:\\s|$)`, 'iu').test(normalizedFilmType),
    ) || normalizedFilmType;
  return {
    id: `${order.id}-position-${positionNumber}`,
    title: `Позиция ${positionNumber}`,
    filmType: normalizedFilmType || 'Не указан',
    rollType: rollType || 'Не указан',
    actualThickness,
    ...(accountingThickness ? { accountingThickness: `${accountingThickness} мкм` } : {}),
    ...(width == null ? {} : { widthMm: width }),
    ...(length == null ? {} : { plannedLengthM: length }),
    micron,
    color: [standardBirka, manualBirka].filter(Boolean).join(' / ') || 'Не указан',
    sizeMeters:
      width == null && length == null
        ? 'Не указан'
        : [width == null ? null : `${width} мм`, length == null ? null : `${length} м`]
            .filter(Boolean)
            .join(' · '),
    sleeve: first?.characteristicsSnapshot?.spoolType ?? 'Не указана',
    recipe: recipeName || 'Не указана',
    recipeVersion: first?.recipeVersion?.trim() || 'Версия не указана',
    ...(recipeName ? { recipeName } : {}),
    ...(recipeSnapshot?.version == null ? {} : { recipeVersionNumber: recipeSnapshot.version }),
    ...(recipeSnapshot?.ingredients.length
      ? {
          recipeIngredients: recipeSnapshot.ingredients.map((ingredient) => ({
            name: ingredient.name,
            shareBasisPoints: ingredient.shareBasisPoints,
          })),
        }
      : {}),
    rawMaterialLabel: first?.rawMaterialLabel?.trim() || undefined,
    comment: first?.characteristicsSnapshot?.comment?.trim() || undefined,
    commercialComment: order.commercialComment?.trim() || undefined,
    plannedRolls: new Set(positionRolls.map((roll) => roll.sequenceNumber)).size,
    plannedNetKg: Number(first?.plannedNetKg ?? order.rollPlanKg ?? 0),
    tolerancePercent: 5,
    machine: first?.machineLabel ?? workplace,
    owner: 'Текущий оператор',
    status: 'Опубликовано зав. производства',
    rollIds: positionRolls.map((roll) => roll.id),
  };
}

function mapOrder(
  order: ServerOperatorOrder,
  shift: ServerOperatorShift | null,
  generatedAt: string,
): OperatorOrderRuntime {
  const progress = operatorRollProgress(order);
  const serverCurrentRoll = normalizedLegacyInteger(order.currentRoll);
  const currentRoll = order.rolls.some((roll) => roll.sequenceNumber === serverCurrentRoll)
    ? serverCurrentRoll
    : progress.current;
  const currentServerAttempt =
    order.rolls.find((roll) => roll.dispatchItemId === order.currentDispatchItemId) ??
    order.rolls.find((roll) => roll.sequenceNumber === currentRoll);
  const workplace =
    currentServerAttempt?.machineLabel ??
    order.rolls.find((roll) => roll.machineLabel)?.machineLabel ??
    shift?.workplace ??
    'Станок не назначен';
  const rollsByPosition = new Map<string, ServerOperatorRoll[]>();
  for (const roll of order.rolls) {
    const positionKey = rollPositionKey(roll);
    const positionRolls = rollsByPosition.get(positionKey) ?? [];
    positionRolls.push(roll);
    rollsByPosition.set(positionKey, positionRolls);
  }
  const groupByPosition = new Map(
    [...rollsByPosition.entries()].map(
      ([positionKey, positionRolls], index) =>
        [positionKey, rollGroup(order, positionRolls, workplace, index + 1)] as const,
    ),
  );
  if (groupByPosition.size === 0) {
    groupByPosition.set('empty', rollGroup(order, [], workplace, 1));
  }
  const rollGroups = [...groupByPosition.values()];
  const currentGroup =
    (currentServerAttempt
      ? groupByPosition.get(rollPositionKey(currentServerAttempt))
      : undefined) ?? rollGroups[0]!;
  const rolls: OperatorRollLine[] = order.rolls.map((roll) => ({
    id: roll.id,
    dispatchItemId: roll.dispatchItemId,
    replacesDispatchItemId: roll.replacesDispatchItemId ?? null,
    updatedAt: roll.updatedAt,
    sequenceNumber: roll.sequenceNumber,
    attemptNumber: roll.attemptNumber ?? 1,
    queueRank: roll.queueRank,
    orderNumber: order.id,
    machineId: roll.machineId ?? undefined,
    machineLabel: roll.machineLabel ?? undefined,
    priority: priorityFromNumber(roll.priority),
    groupId: groupByPosition.get(rollPositionKey(roll))?.id ?? currentGroup.id,
    status: roll.status,
    plannedNetKg: Number(roll.plannedNetKg ?? 0),
    meterageMeters: roll.plannedLengthM ?? undefined,
    spoolWeightPolicy: roll.spoolWeightPolicy ?? 'physical_measurement',
    spoolKg: roll.spoolKg ?? undefined,
    grossKg: roll.grossKg ?? undefined,
    netKg: roll.netKg ?? undefined,
    actualNetKg: roll.netKg ?? undefined,
    toleranceState: roll.toleranceOk == null ? 'pending' : roll.toleranceOk ? 'within' : 'blocked',
    recipeVersion:
      groupByPosition.get(rollPositionKey(roll))?.recipeVersion ?? currentGroup.recipeVersion,
    labelState: labelState(roll.labelState),
    warehouseState: warehouseState(roll.warehouseState),
    // Интерактивные весы: на шагах взвешивания виджет читает реальные весы поста.
    spoolScaleActivated:
      roll.status === 'spool_weight' && roll.spoolWeightPolicy !== 'standard_700g',
    rollScaleActivated: roll.status === 'roll_weight' || roll.status === 'roll_scale_activation',
  }));
  const latestAt =
    order.rolls
      .map((roll) => roll.updatedAt)
      .sort()
      .at(-1) ?? generatedAt;
  return {
    id: order.id,
    title: `Заказ ${order.title}`,
    orderId: order.id,
    customerAlias: '',
    templateName: 'По заявке коммерции',
    filmType: currentGroup.filmType,
    cardSizeMeters: currentGroup.sizeMeters,
    status: order.status,
    state: orderState(order.status),
    lastEventAt: latestAt,
    workplace,
    problemCount: 0,
    rollProgress: progress,
    plannedRolls: progress.total,
    completedRolls: progress.completed,
    deferredRolls: order.status === 'deferred' ? progress.total - progress.completed : 0,
    // Progress is bounded by planned rolls, while currentRoll identifies the
    // actionable production attempt (including an automatic defect replacement).
    currentRoll,
    currentDispatchItemId: order.currentDispatchItemId,
    plannedNetKg: Number(
      order.rolls.reduce((sum, roll) => sum + Number(roll.plannedNetKg ?? 0), 0).toFixed(1),
    ),
    rollPlanKg: Number(order.rollPlanKg ?? 0),
    spoolKg: order.spoolKg ?? undefined,
    rollNetKg: order.rollNetKg ?? undefined,
    materialRecipe: currentGroup.recipe,
    realMicron: currentGroup.micron,
    sizeMeters: currentGroup.sizeMeters,
    rollGroups,
    rolls,
  };
}

export function serverOperatorRuntimeToState(runtime: ServerOperatorRuntime): OperatorRuntimeState {
  const shift = runtime.shift;
  return {
    shift: {
      id: shift?.id ?? 'shift-not-assigned',
      status: shift?.status ?? 'start_missing',
      operatorName: shift?.operatorName ?? 'Оператор',
      workplace: shift?.workplace ?? 'Станок не назначен',
      plannedStartAt: shift?.plannedStartAt,
      plannedEndAt: shift?.plannedEndAt,
      defaultMachineId: shift?.workplace,
      defaultMachineLabel: shift?.workplace,
      bigBagId: shift?.bigBagId ?? 'Не назначен',
      startKg: shift?.startKg,
      endKg: shift?.endKg,
      expectedEndKg: shift?.expectedEndKg ?? 0,
      plannedShortageKg: shift?.plannedShortageKg,
      plannedUsageKg: shift?.plannedUsageKg ?? shift?.plannedConsumptionKg ?? 0,
      actualUsageKg: shift?.actualUsageKg,
      deviationPercent: shift?.deviationPercent,
      bags: shift?.bags,
      defectBag: shift?.defectBag,
      defectBags: shift?.defectBags ?? (shift?.defectBag ? [shift.defectBag] : []),
      balanceStatus: shift?.balance?.status,
      plannedConsumptionKg: shift?.plannedConsumptionKg,
      estimatedMinutes: shift?.estimatedMinutes,
    },
    orders: runtime.orders.map((order) => mapOrder(order, shift, runtime.generatedAt)),
    audit: {},
  };
}

export function fetchOperatorRuntime(options?: ApiRequestOptions): Promise<OperatorRuntimeState> {
  return apiGet<ServerOperatorRuntime>('/api/operator/runtime', options).then(
    serverOperatorRuntimeToState,
  );
}

export type OperatorOrderMass = {
  orderPlannedNetKg: number;
  weighedPlannedNetKg: number;
  actualNetKg: number;
  deviationKg: number;
  weighedRollCount: number;
  totalRollCount: number;
};

const OPERATOR_ORDER_MASS_FIELDS = [
  'orderPlannedNetKg',
  'weighedPlannedNetKg',
  'actualNetKg',
  'deviationKg',
  'weighedRollCount',
  'totalRollCount',
] as const;

function invalidOperatorOrderMass(): never {
  throw new Error('Некорректная масса заказа.');
}

function massKilograms(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidOperatorOrderMass();
  const scaled = value * 1_000;
  if (!Number.isSafeInteger(Math.round(scaled)) || Math.abs(scaled - Math.round(scaled)) > 1e-7) {
    invalidOperatorOrderMass();
  }
  return value;
}

function nonNegativeMassKilograms(value: unknown): number {
  const parsed = massKilograms(value);
  if (parsed < 0) invalidOperatorOrderMass();
  return parsed;
}

function massCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidOperatorOrderMass();
  }
  return value;
}

export function parseOperatorOrderMass(value: unknown): OperatorOrderMass {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalidOperatorOrderMass();
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (
    keys.length !== OPERATOR_ORDER_MASS_FIELDS.length ||
    !keys.every((key) => OPERATOR_ORDER_MASS_FIELDS.includes(key as never))
  ) {
    invalidOperatorOrderMass();
  }
  const weighedRollCount = massCount(item.weighedRollCount);
  const totalRollCount = massCount(item.totalRollCount);
  if (weighedRollCount > totalRollCount) invalidOperatorOrderMass();
  const orderPlannedNetKg = nonNegativeMassKilograms(item.orderPlannedNetKg);
  const weighedPlannedNetKg = nonNegativeMassKilograms(item.weighedPlannedNetKg);
  const actualNetKg = nonNegativeMassKilograms(item.actualNetKg);
  const deviationKg = massKilograms(item.deviationKg);
  if (
    weighedPlannedNetKg > orderPlannedNetKg ||
    (weighedRollCount === totalRollCount && weighedPlannedNetKg !== orderPlannedNetKg) ||
    (totalRollCount === 0 && orderPlannedNetKg !== 0) ||
    (weighedRollCount === 0 && (weighedPlannedNetKg !== 0 || actualNetKg !== 0)) ||
    Math.round(deviationKg * 1_000) !==
      Math.round(actualNetKg * 1_000) - Math.round(weighedPlannedNetKg * 1_000)
  ) {
    invalidOperatorOrderMass();
  }
  return {
    orderPlannedNetKg,
    weighedPlannedNetKg,
    actualNetKg,
    deviationKg,
    weighedRollCount,
    totalRollCount,
  };
}

export function fetchOperatorOrderMass(
  orderNumber: string,
  signal?: AbortSignal,
): Promise<OperatorOrderMass> {
  return apiGet<unknown>(
    `/api/operator/orders/${encodeURIComponent(orderNumber)}/mass-summary`,
    signal ? { signal } : undefined,
  ).then(parseOperatorOrderMass);
}

// --- Live mutations (design 2026-07-13: смена с мешками + пайплайн рулона) ----

export type OperatorScaleReading = {
  deviceId: string;
  kind: 'spool' | 'roll';
  status: 'ready' | 'offline' | 'unstable' | 'misconfigured' | 'test_failed' | string;
  stable: boolean;
  grossKg: number;
  at: string;
};

/** Живое (не фиксирующее) чтение весов поста — для интерактивного виджета. */
export function fetchOperatorScaleReading(kind: 'spool' | 'roll'): Promise<OperatorScaleReading> {
  return apiGet<OperatorScaleReading>(`/api/operator/scale/reading?kind=${kind}`);
}

export function fetchOperatorBigBags(options?: ApiRequestOptions): Promise<OperatorBigBagOption[]> {
  return apiGet<OperatorBigBagOption[]>('/api/operator/big-bags', options);
}

export function openOperatorShift(input: {
  bigBagId: string;
  startKg: number;
  postCode?: string;
}): Promise<void> {
  return apiPost('/api/operator/shift/open', input).then(() => undefined);
}

export function addOperatorShiftBag(input: { bigBagId: string; startKg: number }): Promise<void> {
  return apiPost('/api/operator/shift/bags', input).then(() => undefined);
}

export function releaseOperatorShiftBag(
  bigBagId: string,
  input: { operationKey: string; endKg: number },
): Promise<OperatorShiftBagReleaseResult> {
  return apiPost<unknown>(
    `/api/operator/shift/bags/${encodeURIComponent(bigBagId)}/release`,
    input,
  ).then(parseOperatorShiftBagReleaseResult);
}

function parseOperatorShiftBagReleaseResult(value: unknown): OperatorShiftBagReleaseResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'bagId', 'startKg', 'endKg', 'active', 'status', 'releasedAt']) ||
    typeof value.code !== 'string' ||
    value.code.trim().length === 0 ||
    typeof value.bagId !== 'string' ||
    value.bagId.trim().length === 0 ||
    typeof value.startKg !== 'number' ||
    !Number.isFinite(value.startKg) ||
    typeof value.endKg !== 'number' ||
    !Number.isFinite(value.endKg) ||
    value.endKg < 0 ||
    value.endKg > value.startKg ||
    value.active !== false ||
    (value.status !== 'available' && value.status !== 'consumed') ||
    typeof value.releasedAt !== 'string' ||
    Number.isNaN(Date.parse(value.releasedAt)) ||
    new Date(value.releasedAt).toISOString() !== value.releasedAt
  ) {
    throw new ApiResponseParseError(200, new Error('Некорректный ответ возврата Big-Bag.'));
  }
  return value as OperatorShiftBagReleaseResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isShiftBalance(value: unknown): value is OperatorShiftBalanceView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'producedKg',
      'defectKg',
      'expectedUsageKg',
      'actualUsageKg',
      'deviationPercent',
      'status',
    ]) ||
    !['pending', 'ok', 'mismatch'].includes(String(value.status))
  ) {
    return false;
  }
  return (
    ['producedKg', 'defectKg', 'expectedUsageKg'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0,
    ) &&
    (value.actualUsageKg === null ||
      (typeof value.actualUsageKg === 'number' &&
        Number.isFinite(value.actualUsageKg) &&
        value.actualUsageKg >= 0)) &&
    (value.deviationPercent === null ||
      (typeof value.deviationPercent === 'number' && Number.isFinite(value.deviationPercent)))
  );
}

export function parseOperatorShiftCloseResult(value: unknown): OperatorShiftCloseResult {
  const invalid = () => {
    throw new Error('Некорректный итог закрытия смены');
  };
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['balance', 'problemId', 'releasedRollIds', 'closingPayroll']) ||
    !isShiftBalance(value.balance) ||
    !['ok', 'mismatch'].includes(value.balance.status) ||
    (value.problemId !== null && typeof value.problemId !== 'string') ||
    !Array.isArray(value.releasedRollIds) ||
    !value.releasedRollIds.every((id) => typeof id === 'string' && id.length > 0) ||
    new Set(value.releasedRollIds).size !== value.releasedRollIds.length ||
    !isRecord(value.closingPayroll) ||
    !hasExactKeys(value.closingPayroll, [
      'sessionId',
      'shiftId',
      'status',
      'appliedTariffOrders',
      'summary',
      'breakdown',
      'unresolved',
    ]) ||
    typeof value.closingPayroll.sessionId !== 'string' ||
    value.closingPayroll.sessionId.length === 0 ||
    typeof value.closingPayroll.shiftId !== 'string' ||
    value.closingPayroll.shiftId.length === 0
  ) {
    return invalid();
  }
  try {
    const projection = parseOperatorPayrollProjection({
      status: value.closingPayroll.status,
      appliedTariffOrders: value.closingPayroll.appliedTariffOrders,
      summary: value.closingPayroll.summary,
      breakdown: value.closingPayroll.breakdown,
      unresolved: value.closingPayroll.unresolved,
    });
    const shiftId = value.closingPayroll.shiftId;
    if (
      projection.breakdown.some((row) => row.shiftId !== shiftId) ||
      projection.unresolved.some((row) => row.shiftId !== null && row.shiftId !== shiftId)
    ) {
      return invalid();
    }
  } catch {
    return invalid();
  }
  return value as unknown as OperatorShiftCloseResult;
}

export function closeOperatorShift(input: {
  operationKey: string;
  bags: Array<{ bigBagId: string; endKg: number }>;
}): Promise<OperatorShiftCloseResult> {
  return apiPost<unknown>('/api/operator/shift/close', input).then((value) => {
    try {
      return parseOperatorShiftCloseResult(value);
    } catch (error) {
      throw new ApiResponseParseError(200, error);
    }
  });
}

export const MACHINE_BREAKDOWN_TYPES = [
  'screw_jam',
  'extruder_stopped',
  'drive_stopped',
  'belt_break',
  'other',
] as const;

export type OperatorMachineBreakdownType = (typeof MACHINE_BREAKDOWN_TYPES)[number];

export const MACHINE_BREAKDOWN_TYPE_LABELS = {
  screw_jam: 'Клин шнека',
  extruder_stopped: 'Экструдер остановился',
  drive_stopped: 'Остановка привода',
  belt_break: 'Обрыв ремня',
  other: 'Другая поломка',
} as const satisfies Record<OperatorMachineBreakdownType, string>;

export type OperatorMachineBreakdownRequest = {
  type: OperatorMachineBreakdownType;
  details?: string;
};

export const OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX = 'operator-machine-breakdown:';

const machineBreakdownTypeSet = new Set<string>(MACHINE_BREAKDOWN_TYPES);

export function isOperatorMachineBreakdownType(
  value: unknown,
): value is OperatorMachineBreakdownType {
  return typeof value === 'string' && machineBreakdownTypeSet.has(value);
}

export function operatorMachineBreakdownAction(input: OperatorMachineBreakdownRequest): string {
  const details = input.details?.trim();
  const payload: OperatorMachineBreakdownRequest = {
    type: input.type,
    ...(details ? { details } : {}),
  };
  return `${OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`;
}

export function parseOperatorMachineBreakdownAction(
  actionId: string,
): OperatorMachineBreakdownRequest | null {
  if (!actionId.startsWith(OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX)) return null;

  try {
    const encoded = actionId.slice(OPERATOR_MACHINE_BREAKDOWN_ACTION_PREFIX.length);
    const payload: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

    const record = payload as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!keys.includes('type') || keys.some((key) => key !== 'type' && key !== 'details')) {
      return null;
    }
    if (!isOperatorMachineBreakdownType(record.type)) return null;

    if (record.details === undefined) {
      return { type: record.type };
    }
    if (typeof record.details !== 'string' || !record.details.trim()) return null;

    return {
      type: record.type,
      details: record.details.trim(),
    };
  } catch {
    return null;
  }
}

export function weighOperatorDefectBag(
  operationKey: string,
  weightKg: number,
  defectType: DefectBagType | null,
): Promise<NonNullable<OperatorShift['defectBag']>> {
  return apiPost('/api/operator/shift/defect-bag/weigh', {
    operationKey, weightKg, ...(defectType ? { defectType } : {}),
  });
}

export function printOperatorDefectBag(
  operationKey: string,
  reason?: string,
  defectBagId?: string,
): Promise<NonNullable<OperatorShift['defectBag']>> {
  return apiPost('/api/operator/shift/defect-bag/print', {
    operationKey,
    ...(reason ? { reason } : {}),
    ...(defectBagId ? { defectBagId } : {}),
  });
}

/** «Станок сломался»: пост помечается broken, заявка уходит зав. производства. */
export function reportOperatorMachineBreakdown(
  input: OperatorMachineBreakdownRequest,
): Promise<{ id: string; status: string }> {
  return apiPost('/api/operator/machine-breakdown', input);
}

export function acceptOperatorRoll(rollCode: string, operationKey: string): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/accept`, {
    operationKey,
  }).then(() => undefined);
}

export function captureOperatorSpoolWeight(rollCode: string, operationKey: string): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/spool-weight`, {
    operationKey,
  }).then(() => undefined);
}

export function captureOperatorRollWeight(rollCode: string, operationKey: string): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/roll-weight`, {
    operationKey,
  }).then(() => undefined);
}

export function reweighOperatorRoll(
  rollCode: string,
  operationKey: string,
): Promise<OperatorRollReweighResult> {
  return apiPost<OperatorRollReweighResult & Record<string, unknown>>(
    `/api/operator/rolls/${encodeURIComponent(rollCode)}/reweigh`,
    { operationKey },
  ).then((result) => ({
    rollCode: result.rollCode,
    step: result.step,
    previousWeight: {
      grossKg: result.previousWeight.grossKg,
      netKg: result.previousWeight.netKg,
      toleranceOk: result.previousWeight.toleranceOk,
    },
    currentWeight: {
      grossKg: result.currentWeight.grossKg,
      netKg: result.currentWeight.netKg,
      toleranceOk: result.currentWeight.toleranceOk,
    },
  }));
}

export function stepBackOperatorRoll(
  rollCode: string,
  operationKey: string,
): Promise<OperatorRollStepBackResult> {
  return apiPost<OperatorRollStepBackResult & Record<string, unknown>>(
    `/api/operator/rolls/${encodeURIComponent(rollCode)}/step-back`,
    { operationKey },
  ).then((result) => ({
    rollCode: result.rollCode,
    previousStep: result.previousStep,
    step: result.step,
  }));
}

export function printOperatorQr(
  rollCode: string,
  operationKey: string,
  reason?: string,
): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/qr-print`, {
    operationKey,
    ...(reason ? { reason } : {}),
  }).then(() => undefined);
}

export function verifyOperatorQr(
  rollCode: string,
  operationKey: string,
  payload: string,
): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/qr-verify`, {
    operationKey,
    payload,
  }).then(() => undefined);
}

export function verifyAndHandoverOperatorQr(
  rollCode: string,
  operationKey: string,
  handoverOperationKey: string,
  payload: string,
): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/qr-verify-and-handover`, {
    operationKey,
    handoverOperationKey,
    payload,
  }).then(() => undefined);
}

export function handoverOperatorRoll(rollCode: string, operationKey: string): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/handover`, {
    operationKey,
  }).then(() => undefined);
}

export function deferOperatorRoll(
  rollCode: string,
  operationKey: string,
  reason: string,
): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/defer`, {
    operationKey,
    reason,
  }).then(() => undefined);
}

export function resumeOperatorRoll(rollCode: string, operationKey: string): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(rollCode)}/resume`, {
    operationKey,
  }).then(() => undefined);
}

export function reportOperatorDefect(input: {
  rollCode: string;
  operationKey: string;
}): Promise<void> {
  return apiPost(`/api/operator/rolls/${encodeURIComponent(input.rollCode)}/defects`, {
    operationKey: input.operationKey,
  }).then(() => undefined);
}

export function reportOperatorProblem(input: {
  operationKey: string;
  type: OperatorReportableProblemType;
  rollId: string;
  reason: string;
  recovery?: string;
}): Promise<void> {
  if (!isOperatorReportableProblemType(input.type)) {
    return Promise.reject(new Error('Недопустимый тип проблемы оператора.'));
  }
  return apiPost('/api/operator/problems', {
    ...input,
  }).then(() => undefined);
}
