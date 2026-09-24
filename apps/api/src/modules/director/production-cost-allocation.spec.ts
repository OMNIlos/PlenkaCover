import { allocateIntegerByWeight } from './production-cost-allocation';

describe('allocateIntegerByWeight', () => {
  it('preserves every kopeck and uses ids to resolve equal remainders', () => {
    const result = allocateIntegerByWeight(100, [
      { id: 'roll-c', weight: 1 },
      { id: 'roll-a', weight: 1 },
      { id: 'roll-b', weight: 1 },
    ]);

    expect(result).toEqual(
      new Map([
        ['roll-a', 34],
        ['roll-b', 33],
        ['roll-c', 33],
      ]),
    );
    expect([...result.values()].reduce((sum, amount) => sum + amount, 0)).toBe(100);
  });

  it('allocates proportionally with exact integer remainder handling', () => {
    expect(
      allocateIntegerByWeight(101, [
        { id: 'small', weight: 1 },
        { id: 'large', weight: 2 },
      ]),
    ).toEqual(
      new Map([
        ['small', 34],
        ['large', 67],
      ]),
    );
  });

  it('ignores invalid weights and rejects unsafe totals', () => {
    expect(
      allocateIntegerByWeight(10, [
        { id: 'zero', weight: 0 },
        { id: 'valid', weight: 2 },
      ]),
    ).toEqual(new Map([['valid', 10]]));
    expect(() => allocateIntegerByWeight(Number.MAX_SAFE_INTEGER + 1, [])).toThrow(RangeError);
  });
});
