export const COMMERCIAL_PLANNED_WEIGHT_ERROR =
  'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.';

const PLANNED_WEIGHT_PATTERN = /^\d+(?:[.,]\d{1,3})?$/;

export function parseCommercialPlannedWeightKg(value: string): number | null {
  const normalized = value.trim();
  if (!PLANNED_WEIGHT_PATTERN.test(normalized)) return null;
  const kilograms = Number(normalized.replace(',', '.'));
  if (!Number.isFinite(kilograms) || kilograms < 0.001 || kilograms > 100_000) return null;
  return kilograms;
}
