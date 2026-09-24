import { apiGet, type ApiRequestOptions } from './client';
import { parseOperatorPayrollPreview } from './operatorPayroll';
import {
  parseAppliedPayrollTariffOrder,
  type ServerAppliedPayrollTariffOrder,
} from './payrollTariffOrders';

export type DirectorPayrollQuery = { from: string; to: string };

export type ServerDirectorPayrollMachineFamily =
  | 'urp'
  | 'matil'
  | 'kitayka'
  | 'abc_old'
  | 'abc_new';
export type ServerDirectorPayrollShiftDuration = '12h' | '24h';
export type ServerDirectorPayrollMaterialClass = 'primary' | 'secondary';
export type ServerDirectorPayrollTariffRule =
  | 'primary'
  | 'secondary'
  | 'thin_roll'
  | 'abc_standard'
  | 'abc_black_white'
  | 'alabuga_override';
export type ServerDirectorPayrollUnresolvedReason =
  | 'before_policy_effective_date'
  | 'shift_not_closed'
  | 'production_operator_unresolved'
  | 'post_session_unresolved'
  | 'shift_unresolved'
  | 'machine_family_unresolved'
  | 'shift_duration_unresolved'
  | 'material_class_unresolved'
  | 'film_type_unresolved'
  | 'counterparty_unresolved';
export type ServerDirectorPayrollPreviewStatus = 'complete' | 'partial' | 'empty';

export type ServerDirectorPayrollBreakdownRow = {
  id: string;
  tariffOrderId: string;
  operatorId: string;
  operatorName: string;
  shiftId: string;
  shiftLabel: string;
  shiftDate: string;
  postId: string;
  postCode: string;
  postName: string;
  machineFamily: ServerDirectorPayrollMachineFamily;
  shiftDuration: ServerDirectorPayrollShiftDuration;
  shiftOutputKg: number;
  payableKg: number;
  rateKopecksPerKg: number;
  amountKopecks: number;
  tariffRule: ServerDirectorPayrollTariffRule;
  basisLabel: string;
  materialClass: ServerDirectorPayrollMaterialClass | null;
  filmClass: 'standard' | 'black_white' | null;
  specialCustomer: boolean;
};

export type ServerDirectorPayrollOperatorSummary = {
  operatorId: string;
  operatorName: string;
  payableKg: number;
  amountKopecks: number;
  machineShiftCount: number;
  unresolvedFactCount: number;
};

export type ServerDirectorPayrollUnresolvedFact = {
  rollId: string;
  rollCode: string;
  orderId: string;
  orderNumber: string;
  producedAt: string;
  netKg: number;
  operatorId: string | null;
  operatorName: string | null;
  shiftId: string | null;
  shiftLabel: string | null;
  postId: string | null;
  postCode: string | null;
  postName: string | null;
  reasons: ServerDirectorPayrollUnresolvedReason[];
};

export type ServerDirectorPayrollPreview = {
  status: ServerDirectorPayrollPreviewStatus;
  appliedTariffOrders: ServerAppliedPayrollTariffOrder[];
  range: {
    fromDate: string;
    toDate: string;
    timezone: 'Europe/Moscow';
    generatedAt: string;
  };
  summary: {
    payableAmountKopecks: number;
    payableKg: number;
    machineShiftCount: number;
    operatorCount: number;
    unresolvedKg: number;
    unresolvedFactCount: number;
    excludedDefectKg: number;
    excludedDefectRollCount: number;
  };
  operators: ServerDirectorPayrollOperatorSummary[];
  breakdown: ServerDirectorPayrollBreakdownRow[];
  unresolved: ServerDirectorPayrollUnresolvedFact[];
};

const ROOT_KEYS = [
  'status',
  'appliedTariffOrders',
  'range',
  'summary',
  'operators',
  'breakdown',
  'unresolved',
] as const;
const OPERATOR_KEYS = [
  'operatorId',
  'operatorName',
  'payableKg',
  'amountKopecks',
  'machineShiftCount',
  'unresolvedFactCount',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function grams(value: number): number | null {
  const result = Math.round(value * 1_000);
  return Number.isSafeInteger(result) && Math.abs(result / 1_000 - value) < 1e-9 ? result : null;
}

function isOperator(value: unknown): value is ServerDirectorPayrollOperatorSummary {
  return (
    isRecord(value) &&
    hasExactKeys(value, OPERATOR_KEYS) &&
    isNonEmptyString(value.operatorId) &&
    isNonEmptyString(value.operatorName) &&
    typeof value.payableKg === 'number' &&
    Number.isFinite(value.payableKg) &&
    value.payableKg >= 0 &&
    grams(value.payableKg) !== null &&
    Number.isSafeInteger(value.amountKopecks) &&
    (value.amountKopecks as number) >= 0 &&
    Number.isSafeInteger(value.machineShiftCount) &&
    (value.machineShiftCount as number) >= 0 &&
    Number.isSafeInteger(value.unresolvedFactCount) &&
    (value.unresolvedFactCount as number) >= 0
  );
}

function hasAttribution(value: unknown): value is Record<string, unknown> & {
  operatorId: string;
  operatorName: string;
} {
  return (
    isRecord(value) && isNonEmptyString(value.operatorId) && isNonEmptyString(value.operatorName)
  );
}

function hasNullableAttribution(value: unknown): value is Record<string, unknown> & {
  operatorId: string | null;
  operatorName: string | null;
} {
  return (
    isRecord(value) &&
    (value.operatorId === null || isNonEmptyString(value.operatorId)) &&
    (value.operatorName === null || isNonEmptyString(value.operatorName))
  );
}

function operatorSummariesAreConsistent(
  operators: readonly ServerDirectorPayrollOperatorSummary[],
  breakdown: readonly ServerDirectorPayrollBreakdownRow[],
  unresolved: readonly ServerDirectorPayrollUnresolvedFact[],
): boolean {
  const byId = new Map(operators.map((operator) => [operator.operatorId, operator]));
  if (byId.size !== operators.length) return false;
  if (breakdown.some((row) => !byId.has(row.operatorId))) return false;
  if (
    unresolved.some(
      (row) => row.operatorId !== null && row.operatorName !== null && !byId.has(row.operatorId),
    )
  ) {
    return false;
  }

  return operators.every((operator) => {
    const rows = breakdown.filter((row) => row.operatorId === operator.operatorId);
    const payableGrams = rows.reduce((sum, row) => sum + (grams(row.payableKg) ?? NaN), 0);
    const amountKopecks = rows.reduce((sum, row) => sum + row.amountKopecks, 0);
    const machineShifts = new Set(rows.map((row) => `${row.shiftId}\u0000${row.postId}`));
    const unresolvedFactCount = unresolved.filter(
      (row) => row.operatorId === operator.operatorId && row.operatorName !== null,
    ).length;
    return (
      grams(operator.payableKg) === payableGrams &&
      operator.amountKopecks === amountKopecks &&
      operator.machineShiftCount === machineShifts.size &&
      operator.unresolvedFactCount === unresolvedFactCount
    );
  });
}

export function parseDirectorPayrollPreview(value: unknown): ServerDirectorPayrollPreview {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ROOT_KEYS) ||
    !Array.isArray(value.appliedTariffOrders) ||
    !isRecord(value.summary) ||
    !Number.isSafeInteger(value.summary.operatorCount) ||
    (value.summary.operatorCount as number) < 0 ||
    !Array.isArray(value.operators) ||
    !value.operators.every(isOperator) ||
    !Array.isArray(value.breakdown) ||
    !value.breakdown.every(hasAttribution) ||
    !Array.isArray(value.unresolved) ||
    !value.unresolved.every(hasNullableAttribution)
  ) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }

  let appliedTariffOrders: ServerAppliedPayrollTariffOrder[];
  try {
    appliedTariffOrders = value.appliedTariffOrders.map(parseAppliedPayrollTariffOrder);
  } catch {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  const orderIds = new Set(appliedTariffOrders.map(({ id }) => id));
  if (orderIds.size !== appliedTariffOrders.length) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  const operatorCount = value.summary.operatorCount as number;
  const { operatorCount: _operatorCount, ...operatorSummary } = value.summary;
  const operatorPreview = parseOperatorPayrollPreview({
    status: value.status,
    appliedTariffOrders: appliedTariffOrders.map(({ matrix: _matrix, ...reference }) => reference),
    range: value.range,
    summary: operatorSummary,
    breakdown: value.breakdown.map(
      ({ operatorId: _operatorId, operatorName: _operatorName, ...row }) => row,
    ),
    unresolved: value.unresolved.map(
      ({ operatorId: _operatorId, operatorName: _operatorName, ...row }) => row,
    ),
  });
  const operators = value.operators as ServerDirectorPayrollOperatorSummary[];
  const breakdown = value.breakdown as ServerDirectorPayrollBreakdownRow[];
  const unresolved = value.unresolved as ServerDirectorPayrollUnresolvedFact[];
  if (
    operatorCount !== operators.length ||
    breakdown.some(({ tariffOrderId }) => !orderIds.has(tariffOrderId)) ||
    !operatorSummariesAreConsistent(operators, breakdown, unresolved)
  ) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }

  return {
    ...operatorPreview,
    appliedTariffOrders,
    summary: { ...operatorPreview.summary, operatorCount },
    operators,
    breakdown,
    unresolved,
  };
}

export async function fetchDirectorPayrollPreview(
  query: DirectorPayrollQuery,
  options?: ApiRequestOptions,
): Promise<ServerDirectorPayrollPreview> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  const response = await apiGet<unknown>(
    `/api/director/payroll-preview?${params.toString()}`,
    options,
  );
  return parseDirectorPayrollPreview(response);
}
