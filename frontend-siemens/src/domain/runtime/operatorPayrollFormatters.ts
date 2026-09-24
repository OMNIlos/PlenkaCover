const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
});
const kilograms = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

export function formatOperatorPayrollMoney(kopecks: number): string {
  return rubles.format(kopecks / 100);
}

export function formatOperatorPayrollKg(value: number): string {
  return `${kilograms.format(value)} кг`;
}

export function formatOperatorPayrollRate(kopecks: number): string {
  return `${formatOperatorPayrollMoney(kopecks)}/кг`;
}
