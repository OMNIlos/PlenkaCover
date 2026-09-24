type BigBagValuationInput = {
  kg: number;
  priceKopecksPerKg: number | null | undefined;
};

export type BigBagValuation = {
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
};

export function valueBigBag(input: BigBagValuationInput): BigBagValuation {
  if (input.priceKopecksPerKg == null) {
    return { priceKopecksPerKg: null, totalKopecks: null };
  }
  if (
    !Number.isFinite(input.kg) ||
    input.kg < 0 ||
    !Number.isSafeInteger(input.priceKopecksPerKg) ||
    input.priceKopecksPerKg < 0
  ) {
    throw new RangeError('Big-Bag valuation requires non-negative kilograms and kopecks.');
  }
  const grams = Math.round(input.kg * 1_000);
  const numerator = grams * input.priceKopecksPerKg;
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError('Big-Bag valuation exceeds the safe integer range.');
  }
  return {
    priceKopecksPerKg: input.priceKopecksPerKg,
    totalKopecks: Math.floor((numerator + 500) / 1_000),
  };
}
