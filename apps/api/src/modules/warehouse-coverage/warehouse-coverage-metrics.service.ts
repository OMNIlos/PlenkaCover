import { Injectable } from '@nestjs/common';
import {
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_STATES,
  type UtcIsoString,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageState,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CoverageConflictCode } from './warehouse-coverage-transaction';
import { WarehouseCoverageConflictCounter } from './warehouse-coverage-conflict-counter';

const RECHECK_ORIGINS = ['finance_request', 'decision_linked_physical_exception'] as const;

type WarehouseCoverageRecheckOrigin = (typeof RECHECK_ORIGINS)[number];

export interface WarehouseCoverageMetricsSnapshot {
  currentStates: Record<WarehouseCoverageState, number>;
  currentAvailability: Record<WarehouseCoverageAvailability, number>;
  openRechecks: Record<WarehouseCoverageRecheckOrigin, number>;
  processConflicts: {
    total: number;
    byCode: Record<CoverageConflictCode, number>;
    resetAt: UtcIsoString;
  };
}

@Injectable()
export class WarehouseCoverageMetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: WarehouseCoverageConflictCounter,
  ) {}

  async snapshot(): Promise<WarehouseCoverageMetricsSnapshot> {
    const [stateRows, availabilityRows, recheckRows] = await Promise.all([
      this.prisma.warehouseCoverageState.groupBy({
        by: ['state'],
        _count: { _all: true },
      }),
      this.prisma.warehouseCoverageCalculation.groupBy({
        by: ['availability'],
        where: { currentForState: { isNot: null } },
        _count: { _all: true },
      }),
      this.prisma.orderResolutionCase.groupBy({
        by: ['coverageOrigin'],
        where: {
          type: 'warehouse_coverage_recheck',
          status: 'open',
          coverageOrigin: { in: [...RECHECK_ORIGINS] },
        },
        _count: { _all: true },
      }),
    ]);

    const currentStates = emptyRecord(WAREHOUSE_COVERAGE_STATES);
    for (const row of stateRows) {
      if (isOneOf(row.state, WAREHOUSE_COVERAGE_STATES)) {
        currentStates[row.state] = row._count._all;
      }
    }

    const currentAvailability = emptyRecord(WAREHOUSE_COVERAGE_AVAILABILITIES);
    for (const row of availabilityRows) {
      if (isOneOf(row.availability, WAREHOUSE_COVERAGE_AVAILABILITIES)) {
        currentAvailability[row.availability] = row._count._all;
      }
    }

    const openRechecks = emptyRecord(RECHECK_ORIGINS);
    for (const row of recheckRows) {
      if (isOneOf(row.coverageOrigin, RECHECK_ORIGINS)) {
        openRechecks[row.coverageOrigin] = row._count._all;
      }
    }

    return {
      currentStates,
      currentAvailability,
      openRechecks,
      processConflicts: this.conflicts.snapshot(),
    };
  }
}

function emptyRecord<const T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

function isOneOf<const T extends readonly string[]>(
  value: string | null,
  values: T,
): value is T[number] {
  return value !== null && (values as readonly string[]).includes(value);
}
