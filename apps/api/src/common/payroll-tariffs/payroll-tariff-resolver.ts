import { Injectable } from '@nestjs/common';
import type { PayrollTariffOrderReference } from '@plenka/contracts';
import {
  calculatePayrollAmountKopecks,
  classifyPayrollMachine,
  classifyPayrollShiftDuration,
  payrollShiftBasisLabel,
  resolvePayrollRollRate,
  resolvePayrollShiftRate,
  type PayrollResolvedRollRate,
  type PayrollRollRateInput,
  type PayrollShiftRateInput,
  type PayrollShiftRateResolution,
  type PayrollUnresolvedRate,
} from './payroll-tariff-engine';
import type {
  PayrollTariffSchedule,
  PublishedPayrollTariffOrder,
} from './payroll-tariff-order.repository';

type ResolvedShiftRate = Extract<PayrollShiftRateResolution, { kind: 'resolved' }>;

type ResolvedOrder = {
  tariffOrder: PayrollTariffOrderReference;
  matrixHash: string;
};

export type PayrollResolvedShiftResult =
  | (ResolvedShiftRate & ResolvedOrder)
  | PayrollUnresolvedRate;

export type PayrollResolvedRollResult =
  | (PayrollResolvedRollRate & ResolvedOrder & { amountKopecks: number })
  | PayrollUnresolvedRate;

export type PayrollSessionRoll = { grams: number; birka: string | null };
export type PayrollSessionRateGroup = Omit<ResolvedShiftRate, 'materialClass'> &
  ResolvedOrder & {
    materialClass: PayrollResolvedRollRate['materialClass'];
    payableGrams: number;
  };
export type PayrollResolvedSessionResult =
  | { kind: 'resolved'; groups: PayrollSessionRateGroup[] }
  | PayrollUnresolvedRate;

function selectOrder(
  schedule: PayrollTariffSchedule,
  basisAt: Date,
): PublishedPayrollTariffOrder | null {
  const basisMs = basisAt.getTime();
  if (!Number.isFinite(basisMs)) return null;

  let selected: PublishedPayrollTariffOrder | null = null;
  for (const order of schedule) {
    if (order.effectiveFromMs > basisMs) continue;
    if (
      selected === null ||
      order.effectiveFromMs > selected.effectiveFromMs ||
      (order.effectiveFromMs === selected.effectiveFromMs &&
        order.reference.id > selected.reference.id)
    ) {
      selected = order;
    }
  }
  return selected;
}

function unresolvedBeforePolicy(
  postName: string,
  startedAt: Date | null,
  endedAt: Date | null,
): PayrollUnresolvedRate {
  return {
    kind: 'unresolved',
    reasons: ['before_policy_effective_date'],
    machineFamily: classifyPayrollMachine(postName),
    shiftDuration: classifyPayrollShiftDuration(startedAt, endedAt),
  };
}

function unresolvedOpenShift(input: PayrollShiftRateInput): PayrollUnresolvedRate {
  const machineFamily = classifyPayrollMachine(input.postName);
  const reasons: PayrollUnresolvedRate['reasons'] = [];
  if (machineFamily === null) reasons.push('machine_family_unresolved');
  reasons.push('shift_duration_unresolved');
  return { kind: 'unresolved', reasons, machineFamily, shiftDuration: null };
}

@Injectable()
export class PayrollTariffResolver {
  resolveSession(
    schedule: PayrollTariffSchedule,
    input: PayrollShiftRateInput & { rolls?: readonly PayrollSessionRoll[] },
  ): PayrollResolvedSessionResult {
    const base = this.resolveShift(schedule, input);
    if (base.kind === 'unresolved') return base;
    if (
      input.rolls === undefined ||
      base.machineFamily === 'abc_old' ||
      base.machineFamily === 'abc_new' ||
      (input.processedGrams === 0 && input.rolls.length === 0)
    ) {
      return { kind: 'resolved', groups: [{ ...base, payableGrams: input.processedGrams! }] };
    }
    if (
      input.rolls.some(({ grams }) => !Number.isSafeInteger(grams) || grams <= 0) ||
      input.rolls.reduce((sum, { grams }) => sum + grams, 0) !== input.processedGrams
    ) {
      return {
        kind: 'unresolved',
        reasons: ['shift_not_closed'],
        machineFamily: base.machineFamily,
        shiftDuration: base.shiftDuration,
      };
    }
    const order = selectOrder(schedule, input.endedAt!)!;
    const groups = new Map<string, PayrollSessionRateGroup>();
    for (const roll of input.rolls) {
      const rate = resolvePayrollRollRate(order.matrix, {
        producedAt: input.endedAt!,
        postName: input.postName,
        shiftStartedAt: input.startedAt,
        shiftEndedAt: input.endedAt,
        shiftOutputGrams: input.processedGrams!,
        rollGrams: roll.grams,
        birka: roll.birka,
        materialNames: input.materialNames,
        filmType: null,
        counterpartyLegalName: null,
      });
      if (rate.kind === 'unresolved') return rate;
      const key = `${rate.tariffRule}:${rate.rateKopecksPerKg}`;
      const payableGrams = (groups.get(key)?.payableGrams ?? 0) + roll.grams;
      groups.set(key, {
        ...base,
        rateKopecksPerKg: rate.rateKopecksPerKg,
        tariffRule: rate.tariffRule,
        materialClass: rate.materialClass,
        payableGrams,
        amountKopecks: calculatePayrollAmountKopecks(payableGrams, rate.rateKopecksPerKg),
        basisLabel: payrollShiftBasisLabel(
          input.postName,
          rate.shiftDuration,
          rate.tariffRule,
          rate.materialClass,
          input.processedGrams!,
        ),
      });
    }
    return { kind: 'resolved', groups: [...groups.values()] };
  }

  resolveShift(
    schedule: PayrollTariffSchedule,
    input: PayrollShiftRateInput,
  ): PayrollResolvedShiftResult {
    if (input.endedAt === null) return unresolvedOpenShift(input);
    const order = selectOrder(schedule, input.endedAt);
    if (order === null) {
      return unresolvedBeforePolicy(input.postName, input.startedAt, input.endedAt);
    }

    const result = resolvePayrollShiftRate(order.matrix, input);
    if (result.kind === 'unresolved') return result;
    return {
      ...result,
      tariffOrder: order.reference,
      matrixHash: order.matrixHash,
    };
  }

  resolveRoll(
    schedule: PayrollTariffSchedule,
    input: PayrollRollRateInput,
  ): PayrollResolvedRollResult {
    const order = selectOrder(schedule, input.producedAt);
    if (order === null) {
      return unresolvedBeforePolicy(input.postName, input.shiftStartedAt, input.shiftEndedAt);
    }

    const result = resolvePayrollRollRate(order.matrix, input);
    if (result.kind === 'unresolved') return result;
    return {
      ...result,
      tariffOrder: order.reference,
      matrixHash: order.matrixHash,
      amountKopecks: calculatePayrollAmountKopecks(input.rollGrams, result.rateKopecksPerKg),
    };
  }
}
