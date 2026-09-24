import { WarehouseCoverageConflictCounter } from './warehouse-coverage-conflict-counter';
import { WarehouseCoverageMetricsService } from './warehouse-coverage-metrics.service';

function setup() {
  const prisma = {
    warehouseCoverageState: {
      groupBy: jest.fn().mockResolvedValue([
        { state: 'awaiting_finance', _count: { _all: 2 } },
        { state: 'stale', _count: { _all: 1 } },
        { state: 'order_spec_changed', _count: { _all: 1 } },
      ]),
    },
    warehouseCoverageCalculation: {
      groupBy: jest.fn().mockResolvedValue([
        { availability: 'verified_full', _count: { _all: 2 } },
        { availability: 'unknown', _count: { _all: 1 } },
      ]),
    },
    orderResolutionCase: {
      groupBy: jest.fn().mockResolvedValue([
        { coverageOrigin: 'finance_request', _count: { _all: 1 } },
        {
          coverageOrigin: 'decision_linked_physical_exception',
          _count: { _all: 1 },
        },
      ]),
    },
  };
  const counter = new WarehouseCoverageConflictCounter();
  counter.increment('P2034');
  counter.increment('40P01');
  counter.increment('coverage_conflict');
  const metrics = new WarehouseCoverageMetricsService(prisma as never, counter);
  return { prisma, metrics };
}

describe('WarehouseCoverageMetricsService', () => {
  it('counts only current state, calculation result, and open recheck rows', async () => {
    const { prisma, metrics } = setup();

    await expect(metrics.snapshot()).resolves.toEqual({
      currentStates: {
        calculating: 0,
        awaiting_finance: 2,
        production_required: 0,
        unknown: 0,
        recheck_requested: 0,
        warehouse_reserved: 0,
        stale: 1,
        order_spec_changed: 1,
      },
      currentAvailability: {
        verified_full: 2,
        unavailable: 0,
        unknown: 1,
      },
      openRechecks: {
        finance_request: 1,
        decision_linked_physical_exception: 1,
      },
      processConflicts: expect.objectContaining({
        total: 3,
        byCode: {
          P2034: 1,
          '40001': 0,
          '40P01': 1,
          coverage_conflict: 1,
        },
        resetAt: expect.stringMatching(/Z$/u),
      }),
    });
    expect(prisma.warehouseCoverageCalculation.groupBy).toHaveBeenCalledWith({
      by: ['availability'],
      where: { currentForState: { isNot: null } },
      _count: { _all: true },
    });
    expect(prisma.orderResolutionCase.groupBy).toHaveBeenCalledWith({
      by: ['coverageOrigin'],
      where: {
        type: 'warehouse_coverage_recheck',
        status: 'open',
        coverageOrigin: {
          in: ['finance_request', 'decision_linked_physical_exception'],
        },
      },
      _count: { _all: true },
    });
  });
});
