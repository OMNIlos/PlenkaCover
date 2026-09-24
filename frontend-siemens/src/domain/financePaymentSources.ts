const PAYMENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  '1C': 'Учётный источник',
  mock_1C: 'Учётный источник',
  manual_platform: 'Внесено вручную',
  warehouse_runtime: 'Подтверждено складом',
};

const SAFE_PAYMENT_SOURCE_LABELS = new Set([
  ...Object.values(PAYMENT_SOURCE_LABELS),
  'Другой источник',
  'Источник не указан',
]);

export function financePaymentSourceLabel(source?: string | null): string {
  const normalized = source?.trim();
  if (!normalized) return 'Источник не указан';
  if (PAYMENT_SOURCE_LABELS[normalized]) return PAYMENT_SOURCE_LABELS[normalized];
  if (SAFE_PAYMENT_SOURCE_LABELS.has(normalized)) return normalized;
  return 'Другой источник';
}
