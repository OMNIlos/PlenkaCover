import { apiGet, type ApiRequestOptions } from './client';
import type {
  DirectorPayrollQuery,
  ServerDirectorPayrollBreakdownRow,
  ServerDirectorPayrollPreview,
  ServerDirectorPayrollUnresolvedFact,
  ServerDirectorPayrollUnresolvedReason,
} from './directorPayroll';
import {
  parsePayrollTariffOrderReference,
  type ServerPayrollTariffOrderReference,
} from './payrollTariffOrders';

export type ServerOperatorPayrollBreakdownRow = Omit<
  ServerDirectorPayrollBreakdownRow,
  'operatorId' | 'operatorName'
>;
export type ServerOperatorPayrollUnresolvedFact = Omit<
  ServerDirectorPayrollUnresolvedFact,
  'operatorId' | 'operatorName'
>;

export type ServerOperatorPayrollPreview = {
  status: ServerDirectorPayrollPreview['status'];
  appliedTariffOrders: ServerPayrollTariffOrderReference[];
  range: ServerDirectorPayrollPreview['range'];
  summary: Omit<ServerDirectorPayrollPreview['summary'], 'operatorCount'>;
  breakdown: ServerOperatorPayrollBreakdownRow[];
  unresolved: ServerOperatorPayrollUnresolvedFact[];
};

export type ServerOperatorPayrollProjection = Pick<
  ServerOperatorPayrollPreview,
  'status' | 'appliedTariffOrders' | 'summary' | 'breakdown' | 'unresolved'
>;

const unresolvedReasonOrder: readonly ServerDirectorPayrollUnresolvedReason[] = [
  'before_policy_effective_date',
  'shift_not_closed',
  'production_operator_unresolved',
  'post_session_unresolved',
  'shift_unresolved',
  'machine_family_unresolved',
  'shift_duration_unresolved',
  'material_class_unresolved',
  'film_type_unresolved',
  'counterparty_unresolved',
];
const unresolvedReasons = new Set<string>(unresolvedReasonOrder);
const machineFamilies = new Set(['urp', 'matil', 'kitayka', 'abc_old', 'abc_new']);
const shiftDurations = new Set(['12h', '24h']);
const tariffRules = new Set([
  'primary',
  'secondary',
  'thin_roll',
  'abc_standard',
  'abc_black_white',
  'alabuga_override',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof value[field] === 'string');
}

function hasNumberFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => isFiniteNumber(value[field]));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRange(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['fromDate', 'toDate', 'timezone', 'generatedAt']) ||
    !hasStringFields(value, ['fromDate', 'toDate', 'generatedAt']) ||
    value.timezone !== 'Europe/Moscow' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.fromDate as string) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.toDate as string)
  ) {
    return false;
  }
  const generatedAt = new Date(value.generatedAt as string);
  return !Number.isNaN(generatedAt.getTime()) && generatedAt.toISOString() === value.generatedAt;
}

function isSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'payableAmountKopecks',
      'payableKg',
      'machineShiftCount',
      'unresolvedKg',
      'unresolvedFactCount',
      'excludedDefectKg',
      'excludedDefectRollCount',
    ]) &&
    hasNumberFields(value, [
      'payableAmountKopecks',
      'payableKg',
      'machineShiftCount',
      'unresolvedKg',
      'unresolvedFactCount',
      'excludedDefectKg',
      'excludedDefectRollCount',
    ]) &&
    Object.values(value).every((item) => typeof item !== 'number' || item >= 0) &&
    Number.isSafeInteger(value.payableAmountKopecks) &&
    Number.isSafeInteger(value.machineShiftCount) &&
    Number.isSafeInteger(value.unresolvedFactCount) &&
    Number.isSafeInteger(value.excludedDefectRollCount)
  );
}

function isBreakdownRow(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'tariffOrderId',
      'shiftId',
      'shiftLabel',
      'shiftDate',
      'postId',
      'postCode',
      'postName',
      'machineFamily',
      'shiftDuration',
      'shiftOutputKg',
      'payableKg',
      'rateKopecksPerKg',
      'amountKopecks',
      'tariffRule',
      'basisLabel',
      'materialClass',
      'filmClass',
      'specialCustomer',
    ]) ||
    !hasStringFields(value, [
      'id',
      'tariffOrderId',
      'shiftId',
      'shiftLabel',
      'shiftDate',
      'postId',
      'postCode',
      'postName',
      'machineFamily',
      'shiftDuration',
      'tariffRule',
      'basisLabel',
    ]) ||
    !hasNumberFields(value, ['shiftOutputKg', 'payableKg', 'rateKopecksPerKg', 'amountKopecks']) ||
    typeof value.specialCustomer !== 'boolean' ||
    !machineFamilies.has(value.machineFamily as string) ||
    !shiftDurations.has(value.shiftDuration as string) ||
    !tariffRules.has(value.tariffRule as string) ||
    (value.materialClass !== null &&
      value.materialClass !== 'primary' &&
      value.materialClass !== 'secondary') ||
    (value.filmClass !== null &&
      value.filmClass !== 'standard' &&
      value.filmClass !== 'black_white') ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value.shiftDate as string) ||
    (value.shiftOutputKg as number) < 0 ||
    (value.payableKg as number) < 0 ||
    !Number.isSafeInteger(value.rateKopecksPerKg) ||
    (value.rateKopecksPerKg as number) < 0 ||
    !Number.isSafeInteger(value.amountKopecks) ||
    (value.amountKopecks as number) < 0
  ) {
    return false;
  }
  const row = value as unknown as ServerOperatorPayrollBreakdownRow;
  const payableGrams = grams(row.payableKg);
  return (
    grams(row.shiftOutputKg) !== null &&
    payableGrams !== null &&
    Math.round((payableGrams * row.rateKopecksPerKg) / 1_000) === row.amountKopecks
  );
}

function isUnresolvedRow(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'rollId',
      'rollCode',
      'orderId',
      'orderNumber',
      'producedAt',
      'netKg',
      'shiftId',
      'shiftLabel',
      'postId',
      'postCode',
      'postName',
      'reasons',
    ])
  ) {
    return false;
  }
  if (
    !hasStringFields(value, ['rollId', 'rollCode', 'orderId', 'orderNumber', 'producedAt']) ||
    !isFiniteNumber(value.netKg) ||
    value.netKg <= 0 ||
    grams(value.netKg) === null ||
    !Array.isArray(value.reasons) ||
    value.reasons.length === 0 ||
    !value.reasons.every((reason) => typeof reason === 'string' && unresolvedReasons.has(reason)) ||
    new Set(value.reasons).size !== value.reasons.length ||
    !['shiftId', 'shiftLabel', 'postId', 'postCode', 'postName'].every(
      (key) => value[key] === null || typeof value[key] === 'string',
    )
  ) {
    return false;
  }
  const producedAt = value.producedAt as string;
  const parsedAt = new Date(producedAt);
  if (Number.isNaN(parsedAt.getTime()) || parsedAt.toISOString() !== producedAt) return false;
  const indexes = value.reasons.map((reason) => unresolvedReasonOrder.indexOf(reason as never));
  return indexes.every((index, position) => position === 0 || index > indexes[position - 1]!);
}

function grams(value: number): number | null {
  const result = Math.round(value * 1_000);
  return Number.isSafeInteger(result) && Math.abs(result / 1_000 - value) < 1e-9 ? result : null;
}

function isConsistentProjection(value: ServerOperatorPayrollProjection): boolean {
  const breakdownIds = value.breakdown.map(({ id }) => id);
  if (new Set(breakdownIds).size !== breakdownIds.length) return false;

  const payableGrams = value.breakdown.reduce<number | null>((sum, row) => {
    const rowGrams = grams(row.payableKg);
    return sum === null || rowGrams === null ? null : sum + rowGrams;
  }, 0);
  const unresolvedGrams = value.unresolved.reduce<number | null>((sum, row) => {
    const rowGrams = grams(row.netKg);
    return sum === null || rowGrams === null ? null : sum + rowGrams;
  }, 0);
  if (
    payableGrams === null ||
    unresolvedGrams === null ||
    grams(value.summary.payableKg) !== payableGrams ||
    grams(value.summary.unresolvedKg) !== unresolvedGrams ||
    value.summary.payableAmountKopecks !==
      value.breakdown.reduce((sum, row) => sum + row.amountKopecks, 0) ||
    value.summary.unresolvedFactCount !== value.unresolved.length
  ) {
    return false;
  }

  const machineShifts = new Set(value.breakdown.map((row) => `${row.shiftId}\u0000${row.postId}`));
  if (value.summary.machineShiftCount !== machineShifts.size) return false;

  if (value.status === 'partial') return value.unresolved.length > 0;
  if (value.status === 'complete') {
    return value.unresolved.length === 0 && value.breakdown.length > 0;
  }
  return value.breakdown.length === 0 && value.unresolved.length === 0;
}

export function parseOperatorPayrollProjection(value: unknown): ServerOperatorPayrollProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'appliedTariffOrders', 'summary', 'breakdown', 'unresolved']) ||
    (value.status !== 'complete' && value.status !== 'partial' && value.status !== 'empty') ||
    !Array.isArray(value.appliedTariffOrders) ||
    !isSummary(value.summary) ||
    !Array.isArray(value.breakdown) ||
    !value.breakdown.every(isBreakdownRow) ||
    !Array.isArray(value.unresolved) ||
    !value.unresolved.every(isUnresolvedRow)
  ) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  let references: ServerPayrollTariffOrderReference[];
  try {
    references = value.appliedTariffOrders.map(parsePayrollTariffOrderReference);
  } catch {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  const ids = new Set(references.map(({ id }) => id));
  if (
    ids.size !== references.length ||
    value.breakdown.some(
      (row) => !ids.has((row as ServerOperatorPayrollBreakdownRow).tariffOrderId),
    )
  ) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  const projection = value as ServerOperatorPayrollProjection;
  if (!isConsistentProjection(projection)) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  return projection;
}

export function parseOperatorPayrollPreview(value: unknown): ServerOperatorPayrollPreview {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'status',
      'appliedTariffOrders',
      'range',
      'summary',
      'breakdown',
      'unresolved',
    ]) ||
    !isRange(value.range)
  ) {
    throw new Error('Некорректный ответ расчёта зарплаты');
  }
  const projection = parseOperatorPayrollProjection({
    status: value.status,
    appliedTariffOrders: value.appliedTariffOrders,
    summary: value.summary,
    breakdown: value.breakdown,
    unresolved: value.unresolved,
  });
  return {
    ...projection,
    range: value.range as ServerOperatorPayrollPreview['range'],
  };
}

export async function fetchOperatorPayroll(
  query: DirectorPayrollQuery,
  options?: ApiRequestOptions,
): Promise<ServerOperatorPayrollPreview> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  const response = await apiGet<unknown>(`/api/operator/payroll?${params.toString()}`, options);
  return parseOperatorPayrollPreview(response);
}
