const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_applicable: 'Не применяется',
  unpaid: 'Не оплачено',
  partial: 'Частично оплачено',
  paid: 'Оплачено',
  overdue: 'Просрочено',
  sync_error: 'Требует проверки',
};

const WAREHOUSE_COVERAGE_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_checked: 'Не проверено',
  partial_proposed: 'Предложено частично',
  full_proposed: 'Предложено полностью',
  partial_confirmed: 'Частичное покрытие',
  full_confirmed: 'Полное покрытие',
  needs_production: 'Нужно производство',
  recheck_requested: 'На перепроверке',
  rejected: 'Отклонено',
};

const SHIPMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_applicable: 'Не применяется',
  not_shipped: 'Не отгружено',
  partial_shipped: 'Отгружено частично',
  shipped: 'Отгружено',
  shipment_problem: 'Проблема отгрузки',
};

function statusLabel(labels: Readonly<Record<string, string>>, status: string) {
  return labels[status.trim().toLowerCase()] ?? 'Не определено';
}

export function businessPaymentStatusLabel(status: string) {
  return statusLabel(PAYMENT_STATUS_LABELS, status);
}

export function businessWarehouseCoverageStatusLabel(status: string) {
  return statusLabel(WAREHOUSE_COVERAGE_STATUS_LABELS, status);
}

export function businessShipmentStatusLabel(status: string) {
  return statusLabel(SHIPMENT_STATUS_LABELS, status);
}
