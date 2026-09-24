export type SpoolPolicy =
  | { mode: 'standard_700g'; kg: 0.7 }
  | { mode: 'physical_measurement'; kg: null };

const THIN_SPOOL_VALUES = new Set(['тонкая', 'тонкая шпуля', 'тонкая втулка', 'thin']);

export function resolveSpoolPolicy(input: { spoolType?: string | null }): SpoolPolicy {
  const spoolType = input.spoolType?.trim().toLocaleLowerCase('ru-RU') ?? '';
  if (THIN_SPOOL_VALUES.has(spoolType)) {
    return { mode: 'standard_700g', kg: 0.7 };
  }
  return { mode: 'physical_measurement', kg: null };
}
