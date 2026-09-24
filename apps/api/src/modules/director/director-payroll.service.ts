import { Injectable } from '@nestjs/common';
import {
  DIRECTOR_PAYROLL_TIMEZONE,
  DIRECTOR_PAYROLL_UNRESOLVED_REASONS,
  type AppliedPayrollTariffOrder,
  type DirectorPayrollBreakdownRow,
  type DirectorPayrollOperatorSummary,
  type DirectorPayrollPreview,
  type DirectorPayrollQuery,
  type DirectorPayrollUnresolvedFact,
  type DirectorPayrollUnresolvedReason,
} from '@plenka/contracts';
import {
  PayrollTariffOrderRepository,
  type PayrollTariffSchedule,
} from '../../common/payroll-tariffs/payroll-tariff-order.repository';
import {
  PayrollTariffResolver,
  type PayrollResolvedSessionResult,
  type PayrollSessionRateGroup,
} from '../../common/payroll-tariffs/payroll-tariff-resolver';
import { corruptPayrollTariffOrder } from '../../common/payroll-tariffs/payroll-tariff-order.errors';
import { payrollShiftBasisLabel } from '../../common/payroll-tariffs/payroll-tariff-engine';
import { directorAnalyticsBucketKey, parseDirectorAnalyticsRange } from './director-analytics.time';
import {
  DirectorPayrollFactsService,
  type DirectorPayrollFactsClient,
  type DirectorPayrollFactsSnapshot,
  type DirectorPayrollProductionFact,
  type DirectorPayrollRootSessionScope,
  type DirectorPayrollSessionFact,
} from './director-payroll-facts.service';

type BreakdownAccumulator = Omit<
  DirectorPayrollBreakdownRow,
  'id' | 'operatorName' | 'shiftLabel' | 'postCode' | 'postName' | 'payableKg'
> & {
  id: string;
  tariffOrderId: string;
  operatorName: string;
  shiftLabel: string;
  postCode: string;
  postName: string;
  payableGrams: number;
};

type OperatorAccumulator = {
  operatorId: string;
  operatorName: string;
  payableGrams: number;
  amountKopecks: number;
  machineShiftKeys: Set<string>;
  unresolvedFactCount: number;
};

export type DirectorPayrollCalculation = Pick<
  DirectorPayrollPreview,
  'status' | 'appliedTariffOrders' | 'summary' | 'operators' | 'breakdown' | 'unresolved'
>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function preferredText(left: string, right: string): string {
  return compareText(left, right) <= 0 ? left : right;
}

function toGrams(kg: number): number {
  return Math.round(kg * 1_000);
}

function gramsToKg(grams: number): number {
  return grams / 1_000;
}

function amountKopecks(grams: number, rateKopecksPerKg: number): number {
  return Math.round((grams * rateKopecksPerKg) / 1_000);
}

function isPositiveWeight(fact: DirectorPayrollProductionFact): boolean {
  return Number.isFinite(fact.actualKg) && fact.actualKg > 0;
}

function isHandedOver(fact: DirectorPayrollProductionFact): boolean {
  return (
    (fact.dispatchStatus === 'ready_for_warehouse' || fact.dispatchStatus === 'done') &&
    fact.operatorStep === 'warehouse'
  );
}

function stableSessionBreakdownId(
  session: DirectorPayrollSessionFact,
  rate: PayrollSessionRateGroup,
): string {
  const parts = [
    session.operatorId!,
    session.shift!.id,
    session.post.id,
    rate.tariffOrder.id,
    // The ladder is part of the row's identity: two stints on one shift can price
    // at the same rate from different ladders, and merging them would report a
    // multi-day stint as a twelve-hour one.
    rate.shiftDuration,
    rate.tariffRule,
    String(rate.rateKopecksPerKg),
    rate.materialClass ?? '',
    '',
    '0',
  ];
  return `payroll:${parts.map(encodeURIComponent).join(':')}`;
}

function shiftBasisLabel(
  session: DirectorPayrollSessionFact,
  rate: PayrollSessionRateGroup,
  processedKg: number,
): string {
  return payrollShiftBasisLabel(
    session.post.name,
    rate.shiftDuration,
    rate.tariffRule,
    rate.materialClass,
    toGrams(processedKg),
  );
}

function orderedReasons(
  reasons: Iterable<DirectorPayrollUnresolvedReason>,
): DirectorPayrollUnresolvedReason[] {
  const included = new Set(reasons);
  return DIRECTOR_PAYROLL_UNRESOLVED_REASONS.filter((reason) => included.has(reason));
}

function structuralReasons(fact: DirectorPayrollProductionFact): DirectorPayrollUnresolvedReason[] {
  const reasons: DirectorPayrollUnresolvedReason[] = [];
  const operatorWorkCompleted =
    fact.rootSessionStatus === 'closed' &&
    fact.rootSessionEndedAt instanceof Date &&
    Number.isFinite(fact.rootSessionEndedAt.getTime()) &&
    fact.machineAssignment?.status === 'completed';
  if (fact.shift !== null && fact.shift.status !== 'closed' && !operatorWorkCompleted) {
    reasons.push('shift_not_closed');
  }
  if (
    fact.operatorId === null ||
    fact.operatorId.length === 0 ||
    fact.operatorName === null ||
    fact.operatorName.trim().length === 0
  ) {
    reasons.push('production_operator_unresolved');
  }
  if (fact.rootSessionId === null || fact.rootSessionId.length === 0) {
    reasons.push('post_session_unresolved');
  }
  if (fact.shift === null) {
    reasons.push('shift_unresolved');
  }
  if (fact.post === null) {
    reasons.push('machine_family_unresolved');
  }
  return reasons;
}

function unresolvedFact(
  fact: DirectorPayrollProductionFact,
  grams: number,
  reasons: DirectorPayrollUnresolvedReason[],
): DirectorPayrollUnresolvedFact {
  return {
    rollId: fact.rollId,
    rollCode: fact.rollCode,
    orderId: fact.orderId,
    orderNumber: fact.orderNumber,
    producedAt: fact.producedAt.toISOString(),
    netKg: gramsToKg(grams),
    operatorId: fact.operatorId,
    operatorName: fact.operatorName,
    shiftId: fact.shift?.id ?? null,
    shiftLabel: fact.shift?.label ?? null,
    postId: fact.post?.id ?? null,
    postCode: fact.post?.code ?? null,
    postName: fact.post?.name ?? null,
    reasons,
  };
}

function compareBreakdown(
  left: DirectorPayrollBreakdownRow,
  right: DirectorPayrollBreakdownRow,
): number {
  return (
    compareText(right.shiftDate, left.shiftDate) ||
    compareText(left.operatorName, right.operatorName) ||
    compareText(left.operatorId, right.operatorId) ||
    compareText(left.id, right.id)
  );
}

function compareUnresolved(
  left: DirectorPayrollUnresolvedFact,
  right: DirectorPayrollUnresolvedFact,
): number {
  return compareText(right.producedAt, left.producedAt) || compareText(left.rollId, right.rollId);
}

function compareOperators(
  left: DirectorPayrollOperatorSummary,
  right: DirectorPayrollOperatorSummary,
): number {
  return (
    right.amountKopecks - left.amountKopecks ||
    compareText(left.operatorName, right.operatorName) ||
    compareText(left.operatorId, right.operatorId)
  );
}

@Injectable()
export class DirectorPayrollService {
  constructor(
    private readonly facts: DirectorPayrollFactsService,
    private readonly tariffOrders: PayrollTariffOrderRepository,
    private readonly tariffResolver: PayrollTariffResolver,
  ) {}

  async getPreview(
    query: DirectorPayrollQuery,
    generatedAt?: Date,
  ): Promise<DirectorPayrollPreview> {
    return this.buildPreview(query, generatedAt);
  }

  async getOperatorPreview(
    query: DirectorPayrollQuery,
    operatorId: string,
    generatedAt?: Date,
  ): Promise<DirectorPayrollPreview> {
    return this.buildPreview(query, generatedAt, operatorId);
  }

  async getOperatorRootSessionCalculation(
    scope: DirectorPayrollRootSessionScope,
    generatedAt: Date,
    client: DirectorPayrollFactsClient,
  ): Promise<DirectorPayrollCalculation> {
    const snapshot = await this.facts.loadForOperatorRootSession(scope, generatedAt, client);
    const date = directorAnalyticsBucketKey(generatedAt, 'day');
    const range = parseDirectorAnalyticsRange({ from: date, to: date, bucket: 'day' });
    const { status, appliedTariffOrders, summary, operators, breakdown, unresolved } =
      await this.buildPreviewFromSnapshot(snapshot, range, generatedAt, scope.operatorId, client);
    return { status, appliedTariffOrders, summary, operators, breakdown, unresolved };
  }

  private async buildPreview(
    query: DirectorPayrollQuery,
    generatedAt?: Date,
    operatorId?: string,
  ): Promise<DirectorPayrollPreview> {
    const instant = generatedAt ?? new Date();
    const range = parseDirectorAnalyticsRange({
      from: query.from,
      to: query.to,
      bucket: 'day',
    });
    const snapshot = await this.facts.load(range, instant);
    return this.buildPreviewFromSnapshot(snapshot, range, instant, operatorId);
  }

  private async buildPreviewFromSnapshot(
    snapshot: DirectorPayrollFactsSnapshot,
    range: ReturnType<typeof parseDirectorAnalyticsRange>,
    instant: Date,
    operatorId?: string,
    client?: DirectorPayrollFactsClient,
  ): Promise<DirectorPayrollPreview> {
    const gramsByLineId = new Map<string, number>();
    const breakdownById = new Map<string, BreakdownAccumulator>();
    const operatorsById = new Map<string, OperatorAccumulator>();
    const unresolved: DirectorPayrollUnresolvedFact[] = [];
    let unresolvedGrams = 0;
    let excludedDefectGrams = 0;
    let excludedDefectRollCount = 0;

    const sessionFacts =
      operatorId === undefined
        ? snapshot.sessionFacts
        : snapshot.sessionFacts.filter((session) => session.operatorId === operatorId);
    const schedule = await this.loadSchedule(sessionFacts, client);
    const scheduleById = new Map(schedule.map((order) => [order.reference.id, order]));
    const appliedOrdersById = new Map<string, AppliedPayrollTariffOrder>();

    // Pay is earned per session, on its canonical non-defective roll output. The
    // individual rolls below only decide what still needs the director's attention.
    const sessionRates = new Map<string, PayrollResolvedSessionResult>();
    for (const session of sessionFacts) {
      const rate = this.tariffResolver.resolveSession(schedule, {
        postName: session.post.name,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        processedGrams: session.processedKg === null ? null : toGrams(session.processedKg),
        materialNames: session.materialNames,
        rolls: session.rolls,
      });
      sessionRates.set(session.sessionId, rate);
      if (rate.kind === 'unresolved') continue;
      for (const group of rate.groups) {
        this.addBreakdownSession(breakdownById, scheduleById, appliedOrdersById, session, group);
      }
    }

    const periodFacts =
      operatorId === undefined
        ? snapshot.periodFacts
        : snapshot.periodFacts.filter((fact) => fact.operatorId === operatorId);

    for (const fact of periodFacts) {
      if (!isPositiveWeight(fact)) continue;
      if (fact.hasDefect) {
        const grams = this.normalizedGrams(fact, gramsByLineId);
        excludedDefectGrams += grams;
        excludedDefectRollCount += 1;
        continue;
      }
      if (!isHandedOver(fact)) continue;

      const grams = this.normalizedGrams(fact, gramsByLineId);
      const reasons = this.rollReasons(fact, sessionRates);
      if (reasons.length === 0) continue;

      unresolved.push(unresolvedFact(fact, grams, reasons));
      unresolvedGrams += grams;
      const operator = this.operatorFor(operatorsById, fact);
      if (operator !== null) operator.unresolvedFactCount += 1;
    }

    const breakdown: DirectorPayrollBreakdownRow[] = [];
    const machineShiftKeys = new Set<string>();
    let payableAmountKopecks = 0;
    let payableGrams = 0;
    for (const { payableGrams: rowPayableGrams, ...sourceRow } of breakdownById.values()) {
      const row: DirectorPayrollBreakdownRow = {
        ...sourceRow,
        payableKg: gramsToKg(rowPayableGrams),
      };
      breakdown.push(row);
      payableAmountKopecks += row.amountKopecks;
      payableGrams += rowPayableGrams;
      const operator = this.operatorFor(operatorsById, {
        operatorId: row.operatorId,
        operatorName: row.operatorName,
      });
      if (operator === null) continue;
      operator.payableGrams += rowPayableGrams;
      operator.amountKopecks += row.amountKopecks;
      const key = `${row.shiftId}\u0000${row.postId}`;
      operator.machineShiftKeys.add(key);
      machineShiftKeys.add(key);
    }
    breakdown.sort(compareBreakdown);

    const operators = [...operatorsById.values()]
      .map(
        (operator): DirectorPayrollOperatorSummary => ({
          operatorId: operator.operatorId,
          operatorName: operator.operatorName,
          payableKg: gramsToKg(operator.payableGrams),
          amountKopecks: operator.amountKopecks,
          machineShiftCount: operator.machineShiftKeys.size,
          unresolvedFactCount: operator.unresolvedFactCount,
        }),
      )
      .sort(compareOperators);
    unresolved.sort(compareUnresolved);

    const status = unresolved.length > 0 ? 'partial' : breakdown.length > 0 ? 'complete' : 'empty';

    return {
      status,
      appliedTariffOrders: [...appliedOrdersById.values()].sort(
        (left, right) =>
          compareText(left.effectiveFrom, right.effectiveFrom) || compareText(left.id, right.id),
      ),
      range: {
        fromDate: range.from,
        toDate: range.to,
        timezone: DIRECTOR_PAYROLL_TIMEZONE,
        generatedAt: instant.toISOString(),
      },
      summary: {
        payableAmountKopecks,
        payableKg: gramsToKg(payableGrams),
        machineShiftCount: machineShiftKeys.size,
        operatorCount: operators.length,
        unresolvedKg: gramsToKg(unresolvedGrams),
        unresolvedFactCount: unresolved.length,
        excludedDefectKg: gramsToKg(excludedDefectGrams),
        excludedDefectRollCount,
      },
      operators,
      breakdown,
      unresolved,
    };
  }

  /**
   * Why this roll's work is still waiting on the director. An empty list means
   * the session it belongs to was priced, so the roll needs no attention — the
   * session aggregate is the pay basis and the individual weight is not restated.
   */
  private rollReasons(
    fact: DirectorPayrollProductionFact,
    sessionRates: ReadonlyMap<string, PayrollResolvedSessionResult>,
  ): DirectorPayrollUnresolvedReason[] {
    const reasons = structuralReasons(fact);
    const rate = fact.rootSessionId === null ? undefined : sessionRates.get(fact.rootSessionId);
    if (rate === undefined) {
      // No payable session covers this roll — it was produced on a stint that
      // had not been handed over by the end of the period.
      reasons.push('shift_not_closed');
    } else if (rate.kind === 'unresolved') {
      reasons.push(...rate.reasons);
    }
    return orderedReasons(reasons);
  }

  private addBreakdownSession(
    rows: Map<string, BreakdownAccumulator>,
    scheduleById: ReadonlyMap<string, PayrollTariffSchedule[number]>,
    appliedOrdersById: Map<string, AppliedPayrollTariffOrder>,
    session: DirectorPayrollSessionFact,
    rate: PayrollSessionRateGroup,
  ): void {
    const processedGrams = rate.payableGrams;
    if (
      session.operatorId === null ||
      session.operatorId.length === 0 ||
      session.operatorName === null ||
      session.operatorName.trim().length === 0 ||
      session.shift === null
    ) {
      return;
    }

    const appliedOrder = scheduleById.get(rate.tariffOrder.id);
    if (appliedOrder === undefined) throw corruptPayrollTariffOrder();
    appliedOrdersById.set(rate.tariffOrder.id, {
      ...rate.tariffOrder,
      matrix: appliedOrder.matrix,
    });

    const id = stableSessionBreakdownId(session, rate);
    const current = rows.get(id);
    if (current !== undefined) {
      current.payableGrams += processedGrams;
      current.shiftOutputKg += session.processedKg!;
      // Rounded once, from the row total: rounding each stint and adding drifts
      // a kopeck away from the total the row reports.
      current.amountKopecks = amountKopecks(current.payableGrams, rate.rateKopecksPerKg);
      current.basisLabel = shiftBasisLabel(session, rate, current.shiftOutputKg);
      return;
    }

    rows.set(id, {
      id,
      tariffOrderId: rate.tariffOrder.id,
      operatorId: session.operatorId,
      operatorName: session.operatorName,
      shiftId: session.shift.id,
      shiftLabel: session.shift.label,
      shiftDate: directorAnalyticsBucketKey(session.endedAt!, 'day'),
      postId: session.post.id,
      postCode: session.post.code,
      postName: session.post.name,
      machineFamily: rate.machineFamily,
      shiftDuration: rate.shiftDuration,
      shiftOutputKg: session.processedKg!,
      payableGrams: processedGrams,
      amountKopecks: amountKopecks(processedGrams, rate.rateKopecksPerKg),
      rateKopecksPerKg: rate.rateKopecksPerKg,
      tariffRule: rate.tariffRule,
      basisLabel: shiftBasisLabel(session, rate, session.processedKg!),
      materialClass: rate.materialClass,
      filmClass: null,
      specialCustomer: false,
    });
  }

  private async loadSchedule(
    sessions: readonly DirectorPayrollSessionFact[],
    client?: DirectorPayrollFactsClient,
  ): Promise<PayrollTariffSchedule> {
    const maxBasisMs = sessions.reduce((max, { endedAt }) => {
      const value = endedAt?.getTime();
      return value !== undefined && Number.isFinite(value) ? Math.max(max, value) : max;
    }, Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(maxBasisMs)) return [];
    return this.tariffOrders.loadPublishedSchedule(new Date(maxBasisMs), client);
  }

  private normalizedGrams(
    fact: DirectorPayrollProductionFact,
    gramsByLineId: Map<string, number>,
  ): number {
    const normalized = gramsByLineId.get(fact.lineId);
    if (normalized !== undefined) return normalized;

    const grams = toGrams(fact.actualKg);
    gramsByLineId.set(fact.lineId, grams);
    return grams;
  }

  private operatorFor(
    rows: Map<string, OperatorAccumulator>,
    fact: Pick<DirectorPayrollProductionFact, 'operatorId' | 'operatorName'>,
  ): OperatorAccumulator | null {
    if (
      fact.operatorId === null ||
      fact.operatorId.length === 0 ||
      fact.operatorName === null ||
      fact.operatorName.trim().length === 0
    ) {
      return null;
    }

    const current = rows.get(fact.operatorId);
    if (current !== undefined) {
      current.operatorName = preferredText(current.operatorName, fact.operatorName);
      return current;
    }

    const created: OperatorAccumulator = {
      operatorId: fact.operatorId,
      operatorName: fact.operatorName,
      payableGrams: 0,
      amountKopecks: 0,
      machineShiftKeys: new Set(),
      unresolvedFactCount: 0,
    };
    rows.set(fact.operatorId, created);
    return created;
  }
}
