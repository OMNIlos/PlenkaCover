/** Control-weight deviation that sends an accepted roll to free reserve. */
export function overweightReserveThreshold(): number {
  const parsed = Number(process.env.WAREHOUSE_OVERWEIGHT_RESERVE ?? 0.1);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.1;
}
