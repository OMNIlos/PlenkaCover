import { valueBigBag } from '../../common/money/big-bag-valuation';

describe('valueBigBag', () => {
  it('calculates the total from integer grams with one final half-up rounding', () => {
    expect(valueBigBag({ kg: 12.345, priceKopecksPerKg: 2_500 })).toEqual({
      priceKopecksPerKg: 2_500,
      totalKopecks: 30_863,
    });
  });

  it('keeps zero weight valid for a consumed Big-Bag', () => {
    expect(valueBigBag({ kg: 0, priceKopecksPerKg: 2_500 })).toEqual({
      priceKopecksPerKg: 2_500,
      totalKopecks: 0,
    });
  });
});
