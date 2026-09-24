export type WeightedAllocationInput = {
  id: string;
  weight: number;
};

/**
 * Allocates an integer amount without losing kopecks. Largest fractional
 * remainders win; stable ids break ties, so retries produce the same result.
 */
export function allocateIntegerByWeight(
  total: number,
  inputs: readonly WeightedAllocationInput[],
): Map<string, number> {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('allocation total must be a non-negative safe integer');
  }
  const rows = inputs
    .map(({ id, weight }) => ({ id, weight: Math.round(weight) }))
    .filter(({ weight }) => Number.isSafeInteger(weight) && weight > 0);
  const totalWeight = rows.reduce((sum, { weight }) => sum + weight, 0);
  if (rows.length === 0 || !Number.isSafeInteger(totalWeight) || totalWeight <= 0) {
    return new Map();
  }

  const denominator = BigInt(totalWeight);
  const totalBigInt = BigInt(total);
  const allocations = rows.map(({ id, weight }) => {
    const numerator = totalBigInt * BigInt(weight);
    return {
      id,
      amount: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });
  let remainder = total - allocations.reduce((sum, row) => sum + row.amount, 0);
  allocations.sort(
    (left, right) =>
      (left.remainder === right.remainder ? 0 : left.remainder > right.remainder ? -1 : 1) ||
      left.id.localeCompare(right.id),
  );
  for (let index = 0; index < allocations.length && remainder > 0; index += 1) {
    allocations[index].amount += 1;
    remainder -= 1;
  }
  return new Map(allocations.map(({ id, amount }) => [id, amount]));
}
