import { RollProductionCostReconcilerScheduler } from './roll-production-cost-reconciler.scheduler';

function setup(enabled: boolean) {
  const snapshots = {
    reconcileNextBatch: jest.fn().mockResolvedValue({ attempted: 1, created: 1 }),
  };
  const scheduler = new RollProductionCostReconcilerScheduler(snapshots as never, {
    productionCostReconcilerEnabled: enabled,
    productionCostReconcilerIntervalMs: 60_000,
    productionCostReconcilerBatchSize: 37,
  });
  return { scheduler, snapshots };
}

describe('RollProductionCostReconcilerScheduler', () => {
  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('registers no timer and performs no writes while disabled by default', async () => {
    const { scheduler, snapshots } = setup(false);

    scheduler.onModuleInit();

    expect(jest.getTimerCount()).toBe(0);
    await expect(scheduler.runNow()).resolves.toEqual({ skipped: true, reason: 'disabled' });
    expect(snapshots.reconcileNextBatch).not.toHaveBeenCalled();
  });

  it('runs bounded single-flight batches and disposes its configurable timer', async () => {
    const { scheduler, snapshots } = setup(true);

    scheduler.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(snapshots.reconcileNextBatch).toHaveBeenCalledTimes(1);
    expect(snapshots.reconcileNextBatch).toHaveBeenCalledWith(37, expect.any(Date));
    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
