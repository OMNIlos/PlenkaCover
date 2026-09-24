import { WarehouseCoverageConflictCounter } from './warehouse-coverage-conflict-counter';

describe('WarehouseCoverageConflictCounter', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-25T09:30:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts each supported terminal conflict from one reset timestamp', () => {
    const counter = new WarehouseCoverageConflictCounter();

    counter.increment('P2034');
    counter.increment('40001');
    counter.increment('40P01');
    counter.increment('coverage_conflict');
    counter.increment('40P01');

    expect(counter.snapshot()).toEqual({
      total: 5,
      byCode: {
        P2034: 1,
        '40001': 1,
        '40P01': 2,
        coverage_conflict: 1,
      },
      resetAt: '2026-07-25T09:30:00.000Z',
    });
  });

  it('returns an isolated snapshot that cannot mutate later observations', () => {
    const counter = new WarehouseCoverageConflictCounter();
    const first = counter.snapshot();

    first.byCode.P2034 = 99;
    counter.increment('P2034');

    expect(counter.snapshot()).toMatchObject({
      total: 1,
      byCode: { P2034: 1 },
    });
  });
});
