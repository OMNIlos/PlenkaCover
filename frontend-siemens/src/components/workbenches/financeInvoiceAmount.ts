export function financeInvoiceActionNeedsAmountInput(...amountLabels: Array<string | undefined>) {
  return amountLabels.every((amountLabel) => parsedPositiveMoneyAmount(amountLabel) === undefined);
}

function parsedPositiveMoneyAmount(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.]/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}
