export function parseMoneyDraft(value: string): number | undefined {
  const normalized = value
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

export function moneyDraftLabel(amount: number): string {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)} ₽`;
}
