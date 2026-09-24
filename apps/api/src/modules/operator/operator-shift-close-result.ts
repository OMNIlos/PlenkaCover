import { ConflictException } from '@nestjs/common';
import {
  DIRECTOR_PAYROLL_MACHINE_FAMILIES,
  DIRECTOR_PAYROLL_MATERIAL_CLASSES,
  DIRECTOR_PAYROLL_SHIFT_DURATIONS,
  DIRECTOR_PAYROLL_TARIFF_RULES,
  DIRECTOR_PAYROLL_UNRESOLVED_REASONS,
  type DirectorPayrollMachineFamily,
  type DirectorPayrollMaterialClass,
  type DirectorPayrollShiftDuration,
  type DirectorPayrollTariffRule,
  type DirectorPayrollUnresolvedReason,
  type OperatorPayrollBreakdownRow,
  type OperatorPayrollUnresolvedFact,
  type PayrollTariffMatrixV1,
  type PayrollTariffOrderReference,
  type OperatorShiftBalance,
  type OperatorShiftCloseResult,
  type OperatorShiftClosingPayroll,
} from '@plenka/contracts';
import {
  normalizePayrollBasisLabel,
  payrollShiftBasisLabel,
  resolvePayrollRollRate,
  resolvePayrollShiftRate,
} from '../../common/payroll-tariffs/payroll-tariff-engine';
import {
  LEGACY_PAYROLL_TARIFF_MATRIX_V1,
  LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
} from '../../common/payroll-tariffs/legacy-payroll-tariff-matrix';
import type {
  PayrollTariffSchedule,
  PublishedPayrollTariffOrder,
} from '../../common/payroll-tariffs/payroll-tariff-order.repository';

export type OperatorShiftCloseResultOwnership = {
  sessionId: string;
  shiftId: string;
  postId: string;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const LEGACY_REPLAY_SCHEDULE: PayrollTariffSchedule = Object.freeze([
  Object.freeze({
    reference: LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE,
    effectiveFromMs: Date.parse('2025-09-28T21:00:00.000Z'),
    revision: 1,
    matrix: LEGACY_PAYROLL_TARIFF_MATRIX_V1,
    matrixHash: '',
  }),
]);

function invalidReplay(): never {
  throw new ConflictException({
    code: 'OPERATOR_SHIFT_CLOSE_REPLAY_INVALID',
    message: 'Сохранённый результат сдачи смены повреждён.',
  });
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidReplay();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidReplay();
  }
  return record;
}

function nonBlankString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalidReplay();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : nonBlankString(value);
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidReplay();
  return value as number;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidReplay();
  return value;
}

function kilograms(value: unknown, allowNegative = false): number {
  const kg = finiteNumber(value);
  if ((!allowNegative && kg < 0) || !Number.isSafeInteger(Math.round(kg * 1_000))) {
    invalidReplay();
  }
  if (Math.abs(kg - Math.round(kg * 1_000) / 1_000) > Number.EPSILON * 8) invalidReplay();
  return kg;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalidReplay();
  return value as T[number];
}

function isoInstant(value: unknown): string {
  const instant = nonBlankString(value);
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== instant) invalidReplay();
  return instant;
}

function calendarDate(value: unknown): string {
  const date = nonBlankString(value);
  if (!DATE_PATTERN.test(date)) invalidReplay();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    invalidReplay();
  }
  return date;
}

function tariffOrderReference(value: unknown): PayrollTariffOrderReference {
  const source = exactRecord(value, ['id', 'name', 'effectiveFrom', 'currency']);
  if (source.currency !== 'RUB') invalidReplay();
  return {
    id: nonBlankString(source.id),
    name: nonBlankString(source.name),
    effectiveFrom: calendarDate(source.effectiveFrom),
    currency: 'RUB',
  };
}

function sameTariffOrderReference(
  left: PayrollTariffOrderReference,
  right: PayrollTariffOrderReference,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.effectiveFrom === right.effectiveFrom &&
    left.currency === right.currency
  );
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function parseBalance(value: unknown): OperatorShiftBalance {
  const row = exactRecord(value, [
    'producedKg',
    'defectKg',
    'expectedUsageKg',
    'actualUsageKg',
    'deviationPercent',
    'status',
  ]);
  const producedKg = kilograms(row.producedKg);
  const defectKg = kilograms(row.defectKg);
  const expectedUsageKg = kilograms(row.expectedUsageKg);
  const actualUsageKg = kilograms(row.actualUsageKg, true);
  const deviationPercent = finiteNumber(row.deviationPercent);
  const status = enumValue(row.status, ['ok', 'mismatch'] as const);
  if (expectedUsageKg !== producedKg) invalidReplay();
  const expectedDeviation = round3(
    (expectedUsageKg > 0
      ? (actualUsageKg - expectedUsageKg) / expectedUsageKg
      : actualUsageKg === 0
        ? 0
        : actualUsageKg > 0
          ? 1
          : -1) * 100,
  );
  if (deviationPercent !== expectedDeviation || (status === 'mismatch' && deviationPercent === 0)) {
    invalidReplay();
  }
  return {
    producedKg,
    defectKg,
    expectedUsageKg,
    actualUsageKg,
    deviationPercent,
    status,
  };
}

function selfBreakdownId(
  row: Omit<OperatorPayrollBreakdownRow, 'id' | 'tariffOrderId'>,
  tariffOrderId?: string,
): string {
  return [
    'self-payroll',
    row.shiftId,
    row.postId,
    ...(tariffOrderId === undefined ? [] : [tariffOrderId]),
    row.tariffRule,
    row.rateKopecksPerKg,
    row.materialClass ?? '',
    row.filmClass ?? '',
    row.specialCustomer ? 1 : 0,
  ]
    .map((part) => encodeURIComponent(String(part)))
    .join(':');
}

function hasLegacyCanonicalTariff(
  row: Omit<OperatorPayrollBreakdownRow, 'id' | 'tariffOrderId'>,
): boolean {
  const startedAt = new Date(0);
  const endedAt = new Date(
    row.shiftDuration === '12h' ? 12 * 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000,
  );
  const resolution = resolvePayrollRollRate(LEGACY_PAYROLL_TARIFF_MATRIX_V1, {
    producedAt: endedAt,
    postName: row.postName,
    shiftStartedAt: startedAt,
    shiftEndedAt: endedAt,
    shiftOutputGrams: Math.round(row.shiftOutputKg * 1_000),
    rollGrams: Math.round(row.payableKg * 1_000),
    materialNames: [row.materialClass === 'secondary' ? 'Вторичный' : 'Первичный'],
    filmType: row.filmClass === 'black_white' ? 'Фальц' : 'Рукав',
    counterpartyLegalName: row.specialCustomer ? 'ОЭЗ ППТ АЛАБУГА АО' : 'ООО Покупатель',
  });
  return (
    resolution.kind === 'resolved' &&
    resolution.machineFamily === row.machineFamily &&
    resolution.shiftDuration === row.shiftDuration &&
    resolution.rateKopecksPerKg === row.rateKopecksPerKg &&
    resolution.tariffRule === row.tariffRule &&
    resolution.basisLabel === row.basisLabel &&
    resolution.materialClass === row.materialClass &&
    resolution.filmClass === row.filmClass &&
    resolution.specialCustomer === row.specialCustomer
  );
}

function hasShiftConsumptionTariff(
  row: Omit<OperatorPayrollBreakdownRow, 'id' | 'tariffOrderId'>,
  matrix: PayrollTariffMatrixV1,
): boolean {
  if (
    (row.materialClass === null && row.tariffRule !== 'thin_roll') ||
    (row.tariffRule === 'thin_roll' && row.payableKg <= 0) ||
    row.filmClass !== null ||
    row.specialCustomer
  ) {
    return false;
  }
  const startedAt = new Date(0);
  const endedAt = new Date(
    row.shiftDuration === '12h' ? 12 * 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000,
  );
  const resolution =
    row.tariffRule === 'thin_roll'
      ? resolvePayrollRollRate(matrix, {
          producedAt: endedAt,
          postName: row.postName,
          shiftStartedAt: startedAt,
          shiftEndedAt: endedAt,
          shiftOutputGrams: Math.round(row.shiftOutputKg * 1_000),
          // A breakdown row sums multiple thin rolls; validate a representative
          // roll against the saved matrix, then validate money on the full group.
          rollGrams: Math.min(
            Math.round(row.payableKg * 1_000),
            matrix.specialRules.thinRoll.maxExclusiveGrams - 1,
          ),
          materialNames: [],
          filmType: null,
          counterpartyLegalName: null,
        })
      : resolvePayrollShiftRate(matrix, {
          postName: row.postName,
          startedAt,
          endedAt,
          processedGrams: Math.round(row.shiftOutputKg * 1_000),
          materialNames: [row.materialClass === 'secondary' ? 'Вторичный' : 'Первичный'],
        });
  if (resolution.kind !== 'resolved') return false;

  return (
    resolution.machineFamily === row.machineFamily &&
    resolution.shiftDuration === row.shiftDuration &&
    resolution.rateKopecksPerKg === row.rateKopecksPerKg &&
    resolution.tariffRule === row.tariffRule &&
    resolution.materialClass === row.materialClass &&
    row.basisLabel ===
      payrollShiftBasisLabel(
        row.postName,
        row.shiftDuration,
        row.tariffRule,
        row.materialClass,
        Math.round(row.shiftOutputKg * 1_000),
      )
  );
}

type ReplayTariffContext = {
  legacy: boolean;
  ordersById: ReadonlyMap<string, PublishedPayrollTariffOrder>;
};

function parseBreakdown(
  value: unknown,
  ownership: OperatorShiftCloseResultOwnership,
  context: ReplayTariffContext,
): OperatorPayrollBreakdownRow {
  const source = exactRecord(value, [
    'id',
    ...(context.legacy ? [] : ['tariffOrderId']),
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
  ]);
  const shiftId = nonBlankString(source.shiftId);
  const postId = nonBlankString(source.postId);
  if (shiftId !== ownership.shiftId || postId !== ownership.postId) invalidReplay();
  const row = {
    shiftId,
    shiftLabel: nonBlankString(source.shiftLabel),
    shiftDate: calendarDate(source.shiftDate),
    postId,
    postCode: nonBlankString(source.postCode),
    postName: nonBlankString(source.postName),
    machineFamily: enumValue(
      source.machineFamily,
      DIRECTOR_PAYROLL_MACHINE_FAMILIES,
    ) as DirectorPayrollMachineFamily,
    shiftDuration: enumValue(
      source.shiftDuration,
      DIRECTOR_PAYROLL_SHIFT_DURATIONS,
    ) as DirectorPayrollShiftDuration,
    shiftOutputKg: kilograms(source.shiftOutputKg),
    payableKg: kilograms(source.payableKg),
    rateKopecksPerKg: safeInteger(source.rateKopecksPerKg),
    amountKopecks: safeInteger(source.amountKopecks),
    tariffRule: enumValue(
      source.tariffRule,
      DIRECTOR_PAYROLL_TARIFF_RULES,
    ) as DirectorPayrollTariffRule,
    basisLabel: normalizePayrollBasisLabel(nonBlankString(source.basisLabel)),
    materialClass:
      source.materialClass === null
        ? null
        : (enumValue(
            source.materialClass,
            DIRECTOR_PAYROLL_MATERIAL_CLASSES,
          ) as DirectorPayrollMaterialClass),
    filmClass:
      source.filmClass === null
        ? null
        : enumValue(source.filmClass, ['standard', 'black_white'] as const),
    specialCustomer:
      typeof source.specialCustomer === 'boolean' ? source.specialCustomer : invalidReplay(),
  } satisfies Omit<OperatorPayrollBreakdownRow, 'id' | 'tariffOrderId'>;
  const tariffOrderId = context.legacy
    ? LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id
    : nonBlankString(source.tariffOrderId);
  const order = context.ordersById.get(tariffOrderId);
  if (order === undefined) invalidReplay();
  const id = nonBlankString(source.id);
  const payableGrams = Math.round(row.payableKg * 1_000);
  if (
    row.shiftOutputKg < row.payableKg ||
    row.amountKopecks !== Math.round((payableGrams * row.rateKopecksPerKg) / 1_000) ||
    id !== selfBreakdownId(row, context.legacy ? undefined : tariffOrderId) ||
    (context.legacy
      ? !hasLegacyCanonicalTariff(row) && !hasShiftConsumptionTariff(row, order.matrix)
      : !hasShiftConsumptionTariff(row, order.matrix))
  ) {
    invalidReplay();
  }
  return { id, tariffOrderId, ...row };
}

function parseUnresolved(
  value: unknown,
  ownership: OperatorShiftCloseResultOwnership,
): OperatorPayrollUnresolvedFact {
  const source = exactRecord(value, [
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
  ]);
  if (!Array.isArray(source.reasons) || source.reasons.length === 0) invalidReplay();
  const reasons = source.reasons.map((reason) =>
    enumValue(reason, DIRECTOR_PAYROLL_UNRESOLVED_REASONS),
  ) as DirectorPayrollUnresolvedReason[];
  const ordered = DIRECTOR_PAYROLL_UNRESOLVED_REASONS.filter((reason) => reasons.includes(reason));
  if (
    ordered.length !== reasons.length ||
    ordered.some((reason, index) => reason !== reasons[index])
  ) {
    invalidReplay();
  }
  const shiftId = nullableString(source.shiftId);
  const shiftLabel = nullableString(source.shiftLabel);
  const postId = nullableString(source.postId);
  const postCode = nullableString(source.postCode);
  const postName = nullableString(source.postName);
  if (
    (shiftId === null) !== (shiftLabel === null) ||
    (postId === null) !== (postCode === null) ||
    (postId === null) !== (postName === null) ||
    (shiftId !== null && shiftId !== ownership.shiftId) ||
    (postId !== null && postId !== ownership.postId)
  ) {
    invalidReplay();
  }
  return {
    rollId: nonBlankString(source.rollId),
    rollCode: nonBlankString(source.rollCode),
    orderId: nonBlankString(source.orderId),
    orderNumber: nonBlankString(source.orderNumber),
    producedAt: isoInstant(source.producedAt),
    netKg: kilograms(source.netKg),
    shiftId,
    shiftLabel,
    postId,
    postCode,
    postName,
    reasons,
  };
}

function parseClosingPayroll(
  value: unknown,
  ownership: OperatorShiftCloseResultOwnership,
  schedule: PayrollTariffSchedule,
): OperatorShiftClosingPayroll {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidReplay();
  const legacy = !Object.hasOwn(value, 'appliedTariffOrders');
  const source = exactRecord(value, [
    'sessionId',
    'shiftId',
    'status',
    ...(legacy ? [] : ['appliedTariffOrders']),
    'summary',
    'breakdown',
    'unresolved',
  ]);
  const ordersById = new Map(schedule.map((order) => [order.reference.id, order]));
  const appliedTariffOrders = legacy
    ? [LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE]
    : (() => {
        if (!Array.isArray(source.appliedTariffOrders)) invalidReplay();
        return source.appliedTariffOrders.map(tariffOrderReference);
      })();
  if (new Set(appliedTariffOrders.map(({ id }) => id)).size !== appliedTariffOrders.length) {
    invalidReplay();
  }
  for (const reference of appliedTariffOrders) {
    const order = ordersById.get(reference.id);
    if (order === undefined || !sameTariffOrderReference(reference, order.reference)) {
      invalidReplay();
    }
  }
  const context = { legacy, ordersById } satisfies ReplayTariffContext;
  const sessionId = nonBlankString(source.sessionId);
  const shiftId = nonBlankString(source.shiftId);
  if (sessionId !== ownership.sessionId || shiftId !== ownership.shiftId) invalidReplay();
  if (!Array.isArray(source.breakdown) || !Array.isArray(source.unresolved)) invalidReplay();
  const breakdown = source.breakdown.map((row) => parseBreakdown(row, ownership, context));
  const unresolved = source.unresolved.map((row) => parseUnresolved(row, ownership));
  if (new Set(breakdown.map(({ id }) => id)).size !== breakdown.length) invalidReplay();
  if (new Set(unresolved.map(({ rollId }) => rollId)).size !== unresolved.length) invalidReplay();
  if (!legacy) {
    const usedOrderIds = [...new Set(breakdown.map(({ tariffOrderId }) => tariffOrderId!))].sort();
    const referencedOrderIds = appliedTariffOrders.map(({ id }) => id).sort();
    if (
      usedOrderIds.length !== referencedOrderIds.length ||
      usedOrderIds.some((id, index) => id !== referencedOrderIds[index])
    ) {
      invalidReplay();
    }
  }

  const summarySource = exactRecord(source.summary, [
    'payableAmountKopecks',
    'payableKg',
    'machineShiftCount',
    'unresolvedKg',
    'unresolvedFactCount',
    'excludedDefectKg',
    'excludedDefectRollCount',
  ]);
  const summary = {
    payableAmountKopecks: safeInteger(summarySource.payableAmountKopecks),
    payableKg: kilograms(summarySource.payableKg),
    machineShiftCount: safeInteger(summarySource.machineShiftCount),
    unresolvedKg: kilograms(summarySource.unresolvedKg),
    unresolvedFactCount: safeInteger(summarySource.unresolvedFactCount),
    excludedDefectKg: kilograms(summarySource.excludedDefectKg),
    excludedDefectRollCount: safeInteger(summarySource.excludedDefectRollCount),
  };
  const payableGrams = breakdown.reduce((sum, row) => sum + Math.round(row.payableKg * 1_000), 0);
  const unresolvedGrams = unresolved.reduce((sum, row) => sum + Math.round(row.netKg * 1_000), 0);
  const amountKopecks = breakdown.reduce((sum, row) => sum + row.amountKopecks, 0);
  const machineShiftCount = new Set(
    breakdown.map(({ shiftId: rowShiftId, postId }) => `${rowShiftId}\u0000${postId}`),
  ).size;
  if (
    !Number.isSafeInteger(payableGrams) ||
    !Number.isSafeInteger(unresolvedGrams) ||
    !Number.isSafeInteger(amountKopecks) ||
    summary.payableKg !== payableGrams / 1_000 ||
    summary.payableAmountKopecks !== amountKopecks ||
    summary.machineShiftCount !== machineShiftCount ||
    summary.unresolvedKg !== unresolvedGrams / 1_000 ||
    summary.unresolvedFactCount !== unresolved.length
  ) {
    invalidReplay();
  }
  const expectedStatus =
    unresolved.length > 0 ? 'partial' : breakdown.length > 0 ? 'complete' : 'empty';
  const status = enumValue(source.status, ['complete', 'partial', 'empty'] as const);
  if (status !== expectedStatus) invalidReplay();
  return {
    sessionId,
    shiftId,
    status,
    appliedTariffOrders,
    summary,
    breakdown,
    unresolved,
  };
}

export function referencedPayrollTariffOrderIds(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidReplay();
  const closingPayroll = (value as Record<string, unknown>).closingPayroll;
  if (
    closingPayroll === null ||
    typeof closingPayroll !== 'object' ||
    Array.isArray(closingPayroll)
  ) {
    invalidReplay();
  }
  const source = closingPayroll as Record<string, unknown>;
  if (!Object.hasOwn(source, 'appliedTariffOrders')) {
    return [LEGACY_PAYROLL_TARIFF_ORDER_REFERENCE.id];
  }
  if (!Array.isArray(source.appliedTariffOrders)) invalidReplay();
  const ids = source.appliedTariffOrders.map((reference) => tariffOrderReference(reference).id);
  if (new Set(ids).size !== ids.length) invalidReplay();
  return [...ids].sort();
}

export function parseOperatorShiftCloseResult(
  value: unknown,
  ownership: OperatorShiftCloseResultOwnership,
  schedule: PayrollTariffSchedule = LEGACY_REPLAY_SCHEDULE,
): OperatorShiftCloseResult {
  const source = exactRecord(value, ['balance', 'problemId', 'releasedRollIds', 'closingPayroll']);
  const balance = parseBalance(source.balance);
  const problemId = nullableString(source.problemId);
  if (balance.status === 'ok' && problemId !== null) invalidReplay();
  if (!Array.isArray(source.releasedRollIds)) invalidReplay();
  const releasedRollIds = source.releasedRollIds.map(nonBlankString);
  if (new Set(releasedRollIds).size !== releasedRollIds.length) invalidReplay();
  return {
    balance,
    problemId,
    releasedRollIds,
    closingPayroll: parseClosingPayroll(source.closingPayroll, ownership, schedule),
  };
}
