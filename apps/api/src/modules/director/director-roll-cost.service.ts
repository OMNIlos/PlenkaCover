import { Injectable } from '@nestjs/common';
import {
  DIRECTOR_PAYROLL_TIMEZONE,
  type DirectorRollCostPreview,
  type DirectorRollCostQuery,
  type RollProductionCostView,
} from '@plenka/contracts';
import { parseDirectorAnalyticsRange } from './director-analytics.time';
import {
  DirectorPayrollFactsService,
  type DirectorPayrollProductionFact,
} from './director-payroll-facts.service';
import { RollProductionCostSnapshotService } from './roll-production-cost-snapshot.service';

function isCompatibilityRoll(fact: DirectorPayrollProductionFact): boolean {
  return (
    Number.isFinite(fact.actualKg) &&
    fact.actualKg > 0 &&
    !fact.hasDefect &&
    (fact.dispatchStatus === 'ready_for_warehouse' || fact.dispatchStatus === 'done') &&
    fact.operatorStep === 'warehouse'
  );
}

function checkedAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('director production cost summary exceeds the safe integer range');
  }
  return value;
}

function rowProducedAt(fact: DirectorPayrollProductionFact, cost: RollProductionCostView): string {
  return cost.kind === 'actual_snapshot' ? cost.producedAt : fact.producedAt.toISOString();
}

@Injectable()
export class DirectorRollCostService {
  constructor(
    private readonly facts: DirectorPayrollFactsService,
    private readonly snapshots: RollProductionCostSnapshotService,
  ) {}

  async getPreview(
    query: DirectorRollCostQuery,
    generatedAt = new Date(),
  ): Promise<DirectorRollCostPreview> {
    const range = parseDirectorAnalyticsRange({ ...query, bucket: 'day' });
    const snapshot = await this.facts.load(range, generatedAt);
    const periodFacts = snapshot.periodFacts.filter(isCompatibilityRoll);
    const byRoll = new Map<string, DirectorPayrollProductionFact>();
    for (const fact of periodFacts) {
      if (byRoll.has(fact.rollId)) {
        throw new RangeError(`duplicate production fact for roll ${fact.rollId}`);
      }
      byRoll.set(fact.rollId, fact);
    }
    const rollIds = [...byRoll.keys()].sort();
    const costs = await this.snapshots.getViewsForRollIds(rollIds, generatedAt);

    let completeCostKopecks = 0;
    let completeRollCount = 0;
    const rows = rollIds
      .map((rollId) => {
        const fact = byRoll.get(rollId)!;
        const cost = costs.get(rollId);
        if (!cost) throw new RangeError(`missing production cost projection for roll ${rollId}`);
        const complete = cost.status === 'complete';
        if (complete) {
          completeRollCount += 1;
          completeCostKopecks = checkedAdd(completeCostKopecks, cost.totalAmountKopecks);
        }
        return {
          rollId: fact.rollId,
          rollCode: fact.rollCode,
          orderId: fact.orderId,
          orderNumber: fact.orderNumber,
          producedAt: rowProducedAt(fact, cost),
          netKg: fact.actualKg,
          operatorName: fact.operatorName,
          status: complete ? ('complete' as const) : ('partial' as const),
          materialAmountKopecks: cost.materialAmountKopecks,
          payrollAmountKopecks: cost.payrollAmountKopecks,
          payrollSource: cost.payrollSource,
          additionalAmountKopecks: cost.additionalAmountKopecks,
          totalAmountKopecks: complete ? cost.totalAmountKopecks : null,
          materialSources: [],
          additionalSources: [],
          unresolvedReasons: cost.unresolvedReasons,
        };
      })
      .sort(
        (left, right) =>
          right.producedAt.localeCompare(left.producedAt) ||
          left.rollCode.localeCompare(right.rollCode),
      );
    const partialRollCount = rows.length - completeRollCount;

    return {
      status: rows.length === 0 ? 'empty' : partialRollCount > 0 ? 'partial' : 'complete',
      range: {
        fromDate: range.from,
        toDate: range.to,
        timezone: DIRECTOR_PAYROLL_TIMEZONE,
        generatedAt: generatedAt.toISOString(),
      },
      summary: {
        rollCount: rows.length,
        completeRollCount,
        partialRollCount,
        completeCostKopecks,
      },
      rows,
    };
  }
}
