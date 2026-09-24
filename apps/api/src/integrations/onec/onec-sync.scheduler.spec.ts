import { ConflictException, Logger } from '@nestjs/common';
import { OneCSyncScheduler } from './onec-sync.scheduler';

function setup(enabled: boolean) {
  const sync = { run: jest.fn().mockResolvedValue({ status: 'completed' }) };
  const prisma = {
    oneCSyncRun: {
      findFirst: jest.fn().mockResolvedValue({ id: 'initial-apply' }),
    },
  };
  const scheduler = new OneCSyncScheduler(
    {
      onecSyncEnabled: enabled,
      onecSyncIntervalMs: 60_000,
    } as never,
    sync as never,
    prisma as never,
  );
  return { scheduler, sync, prisma };
}

describe('OneCSyncScheduler', () => {
  beforeEach(() => jest.useFakeTimers());

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('does not create a timer while scheduled sync is disabled', () => {
    const { scheduler } = setup(false);

    scheduler.onModuleInit();

    expect(jest.getTimerCount()).toBe(0);
  });

  it('runs a scheduled read-only synchronization on the validated interval', async () => {
    const { scheduler, sync } = setup(true);
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(sync.run).toHaveBeenCalledWith({ userId: null, role: 'admin' }, 'scheduled');
    await scheduler.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for a successful manual apply before starting scheduled synchronization', async () => {
    const { scheduler, sync, prisma } = setup(true);
    prisma.oneCSyncRun.findFirst.mockResolvedValue(null);
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(sync.run).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('treats the DB-backed overlap conflict as an expected scheduler state', async () => {
    const { scheduler, sync } = setup(true);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    sync.run.mockRejectedValue(
      new ConflictException({
        code: 'ONEC_SYNC_IN_PROGRESS',
        message: 'Sync already running.',
      }),
    );
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(error).not.toHaveBeenCalled();
    await scheduler.onModuleDestroy();
  });

  it('signals an unexpected scheduled synchronization failure', async () => {
    const { scheduler, sync } = setup(true);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    sync.run.mockRejectedValue(new Error('adapter unavailable'));
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(error).toHaveBeenCalledWith('Scheduled 1С synchronization failed.');
    await scheduler.onModuleDestroy();
  });
});
