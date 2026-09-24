import { OneCFinanceSyncScheduler } from './onec-finance-sync.scheduler';

function setup(
  config = {
    onecFinanceSyncEnabled: false,
    onecPaymentSyncEnabled: false,
    onecFinanceSyncIntervalMs: 300_000,
  },
) {
  const prisma = {
    financeOrder: {
      findMany: jest.fn().mockResolvedValue([{ id: 'fo-1' }, { id: 'fo-2' }]),
    },
  };
  const invoice = { refresh: jest.fn().mockResolvedValue({}) };
  const payment = { sync: jest.fn().mockResolvedValue({}) };
  const scheduler = new OneCFinanceSyncScheduler(
    prisma as never,
    invoice as never,
    payment as never,
    config as never,
  );
  return { invoice, payment, prisma, scheduler };
}

describe('OneCFinanceSyncScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is disabled by default and does not schedule background work', () => {
    const { scheduler } = setup();
    const interval = jest.spyOn(global, 'setInterval');

    expect(scheduler.isEnabled()).toBe(false);
    scheduler.start();
    expect(interval).not.toHaveBeenCalled();

    interval.mockRestore();
  });

  it('starts immediately and then repeats on the configured interval', () => {
    jest.useFakeTimers();
    const { scheduler } = setup({
      onecFinanceSyncEnabled: true,
      onecPaymentSyncEnabled: true,
      onecFinanceSyncIntervalMs: 300_000,
    });
    const runOnce = jest
      .spyOn(scheduler, 'runOnce')
      .mockImplementation(async () => ({ skipped: true, reason: 'test' }) as never);

    scheduler.start();
    expect(runOnce).toHaveBeenCalledTimes(1);
    scheduler.start();
    expect(runOnce).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(300_000);
    expect(runOnce).toHaveBeenCalledTimes(2);

    scheduler.onModuleDestroy();
  });

  it('refreshes finance orders and payments with the compatible automation actor', async () => {
    const { invoice, payment, scheduler } = setup({
      onecFinanceSyncEnabled: true,
      onecPaymentSyncEnabled: true,
      onecFinanceSyncIntervalMs: 300_000,
    });

    await scheduler.runOnce();

    const actor = {
      userId: null,
      role: 'finance',
    };
    expect(invoice.refresh).toHaveBeenCalledTimes(2);
    expect(invoice.refresh).toHaveBeenNthCalledWith(
      1,
      actor,
      'fo-1',
      expect.objectContaining({ operationKey: expect.any(String) }),
    );
    expect(payment.sync).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ operationKey: expect.any(String) }),
    );
  });
});
