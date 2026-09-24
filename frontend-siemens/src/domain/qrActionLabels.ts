const qrActionLabels: Record<string, string> = {
  comment: 'Комментарий',
  attach: 'Вложение',
  request_status_change: 'Запрос смены статуса',
  change_status: 'Смена статуса',
  request_reprint: 'Запрос переиздания бирки',
  reprint_with_reason: 'Повторная печать с причиной',
  view_history: 'История QR',
  scan_qr: 'Сканирование QR',
  print_qr: 'Печать QR',
  delete_roll: 'Удаление рулона',
  silent_reprint: 'Переиздание без записи',
};

export function listQrActionLabels(values: string[] | undefined): string {
  if (!values || values.length === 0) return 'Нет';
  return values.map((value) => qrActionLabels[value] ?? 'Действие недоступно').join(', ');
}
