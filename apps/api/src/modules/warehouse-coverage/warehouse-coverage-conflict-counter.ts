import { Injectable } from '@nestjs/common';
import type {
  CoverageConflictCode,
  CoverageTerminalConflictHook,
} from './warehouse-coverage-transaction';
import type { WarehouseCoverageMetricsSnapshot } from './warehouse-coverage-metrics.service';

const CONFLICT_CODES = ['P2034', '40001', '40P01', 'coverage_conflict'] as const;

@Injectable()
export class WarehouseCoverageConflictCounter implements CoverageTerminalConflictHook {
  private readonly counts: Record<CoverageConflictCode, number> = {
    P2034: 0,
    '40001': 0,
    '40P01': 0,
    coverage_conflict: 0,
  };
  private readonly resetAt = new Date().toISOString();
  private total = 0;

  increment(code: CoverageConflictCode): void {
    this.counts[code] += 1;
    this.total += 1;
  }

  snapshot(): WarehouseCoverageMetricsSnapshot['processConflicts'] {
    return {
      total: this.total,
      byCode: Object.fromEntries(CONFLICT_CODES.map((code) => [code, this.counts[code]])) as Record<
        CoverageConflictCode,
        number
      >,
      resetAt: this.resetAt,
    };
  }
}
