import type { ActionDescriptor, ActionIntent } from '../../domain/types';

const navigationActionPrefixes = [
  'director-open-',
  'finance-open-warehouse-delivery',
  'warehouse-open-reserve',
  'operator-next-order',
];

const navigationActionIds = new Set([
  'commercial-open-payment-shipment',
  'commercial-open-production',
  'commercial-open-production-problem',
  'commercial-open-warehouse-resolution',
]);

function normalizedActionText(action: ActionDescriptor) {
  return `${action.id} ${action.label}`.toLowerCase().replace(/ё/g, 'е');
}

function isNavigationLikeAction(action: ActionDescriptor) {
  const normalized = normalizedActionText(action);
  const id = action.id.toLowerCase();
  const label = action.label.toLowerCase().replace(/ё/g, 'е').trim();
  return navigationActionIds.has(action.id)
    || navigationActionPrefixes.some((prefix) => id.startsWith(prefix))
    || id.includes('history')
    || id.includes('schedule')
    || id.includes('open-scans')
    || /^history[-:]/.test(id)
    || label.startsWith('открыть ')
    || label.startsWith('показать ')
    || label.startsWith('перейти ')
    || label.startsWith('статус ')
    || label === 'история'
    || label === 'график'
    || normalized.includes('открыть историю')
    || normalized.includes('открыть график');
}

export function actionIntent(action: ActionDescriptor): ActionIntent {
  if (action.actionIntent) return action.actionIntent;
  if (action.level === 'destructive') return 'destructive';
  if (isNavigationLikeAction(action)) {
    const text = normalizedActionText(action);
    if (text.includes('history') || text.includes('истори')) return 'inspect';
    if (text.includes('schedule') || text.includes('график')) return 'inspect';
    if (text.includes('open') || text.includes('открыть') || text.includes('показать') || text.includes('перейти')) return 'navigate';
    return 'disclose';
  }
  if (action.level === 'recommended' || action.level === 'peer') return 'advance';
  return 'mutate';
}

export function actionVisualLevel(action: ActionDescriptor, forcePeer = false) {
  if (!action.enabled || action.level === 'disabled') return 'disabled';
  const intent = actionIntent(action);
  if (intent === 'navigate' || intent === 'inspect' || intent === 'disclose') return 'navigation';
  if (intent === 'destructive') return 'destructive';
  return forcePeer ? 'peer' : action.level;
}

export function actionIcon(action: ActionDescriptor) {
  if (action.id.startsWith('finance-confirm-schedule:')) return 'check';
  if (action.level === 'disabled') return 'stop';
  if (action.id === 'admin-bind-scanner') return 'tasks-open';
  if (action.id === 'admin-check-scale' || action.id.startsWith('admin.device.tested:')) return 'check';
  if (action.id.startsWith('warehouse-print-pallet-list')) return 'print';
  if (action.id === 'commercial-edit-params') return 'table-settings';
  if (action.id === 'commercial-add-position' || action.id === 'commercial-duplicate-position') return 'add-circle';
  if (action.id === 'commercial-request-correction') return 'warning';
  if (action.id === 'commercial-open-warehouse-resolution') return 'capacity-check';
  if (action.id === 'commercial-open-payment-shipment') return 'truck';
  if (action.id === 'operator-activate-scale' || action.id === 'operator-activate-spool-scale') return 'scale';
  if (action.id.startsWith('operator-step-back-')) return 'chevron-left-small';
  if (action.id === 'operator-print-qr') return 'print';
  if (action.id.includes('operator-next-order')) return 'tasks-open';
  if (action.id.includes('scan_duplicate') || action.id.includes('scan_wrong')) return 'warning';
  if (action.id.includes('history')) return 'history';
  if (action.id.includes('schedule')) return 'table-settings';
  if (actionIntent(action) === 'navigate' || actionIntent(action) === 'inspect' || actionIntent(action) === 'disclose') return 'tasks-open';
  if (action.label.toLowerCase().includes('вес')) return 'scale';
  if (action.label.toLowerCase().includes('этикет') || action.label.toLowerCase().includes('печать')) return 'print';
  if (action.id.includes('handover') || action.label.toLowerCase().includes('склад') || action.label.toLowerCase().includes('выдач')) return 'truck';
  if (action.id.includes('approve') || action.id.includes('accept') || action.id.includes('issue') || action.id.includes('update') || action.id.includes('check') || action.id.includes('test')) return 'check';
  if (action.id.includes('scan') || action.id.includes('verify-qr') || action.label.toLowerCase().includes('qr')) return 'qr-code';
  if (action.id.includes('manual')) return 'search';
  if (action.id.includes('problem') || action.id.includes('defect')) return 'warning';
  if (action.id.includes('history') || action.id.includes('open-scans')) return 'history';
  if (action.id.includes('save')) return 'save-all';
  if (action.id.includes('assign') || action.id.includes('handover') || action.id.includes('transfer') || action.id.includes('bind')) return 'tasks-open';
  if (action.id.includes('return') || action.id.includes('reject') || action.id.includes('cancel') || action.id.includes('disable')) return 'close';
  if (action.level === 'destructive') return 'close';
  return 'add-circle';
}

export function actionDisplayLabel(action: ActionDescriptor) {
  const label = action.label.replace('...', '').trim();
  const lower = label.toLowerCase();
  const id = action.id.toLowerCase();

  if (id.startsWith('finance-confirm-schedule:')) return 'Проверить оплату';

  if (id.startsWith('warehouse-print-pallet-list')) return 'Черновик печати';
  if (id === 'admin-check-scale') return 'Проверить связь';
  if (id === 'admin-bind-scanner') return 'Проверить привязку';
  if (id.startsWith('admin.device.tested:')) return label;
  if (id === 'admin-forward-owner' || id === 'admin-forward-finance-source') return label;
  if (id.includes('open-scans')) return 'Открыть складской контекст';
  if (id.startsWith('director-material-confirm')) return 'Подтвердить исключение';
  if (id.startsWith('director-material-return')) return 'Вернуть на разбор';
  if (id === 'commercial-edit-params') return 'Изменить параметры';
  if (id === 'commercial-add-position') return 'Добавить позицию';
  if (id === 'commercial-duplicate-position') return 'Дублировать';
  if (id === 'commercial-request-correction') return 'Запросить изменение';
  if (id === 'commercial-open-warehouse-resolution') return 'Решить складское покрытие';
  if (id === 'commercial-open-payment-shipment') return 'К оплате и отгрузке';
  if (id.includes('operator-next-order')) return 'Следующий заказ';
  if (id.includes('finance-open-warehouse-delivery')) return 'Статус выдачи';
  if (id.includes('schedule')) return 'График';
  if (id.includes('history') || lower.includes('открыть историю')) return 'История';
  if (id.includes('queue-reorder') || lower.includes('изменить порядок')) return 'Очередь';
  if (id.includes('director-comment') || lower.includes('комментарий директору')) return 'Комментарий директору';
  if (id.startsWith('operator-spool-weight')) return 'Зафиксировать вес шпули';
  if (id.startsWith('operator-roll-weight')) return 'Зафиксировать вес рулона';
  if (id === 'operator-defect') return 'Взвесить брак';
  if (id.includes('scan_duplicate')) return 'Повторный QR';
  if (id.includes('scan_wrong')) return 'Чужой QR';
  if (id.includes('scan') || id.includes('verify-qr')) return 'Сканировать QR';
  if (id.includes('manual')) return 'Найти вручную';
  if (id.startsWith('production-create-problem')) return 'Сообщить проблему коммерции';
  if (id === 'commercial-open-production-problem') return 'Разобрать проблему';
  if (action.id.includes('finance-create-problem') || action.id.includes('problem-sync') || action.id === 'problem') return 'Создать проблему';
  if (action.id.includes('problem')) return 'Сообщить проблему';
  if (action.id.includes('defect')) return 'Брак';
  if (action.id.includes('reject')) return 'Оформить исключение';
  if (lower.includes('передать на склад')) return 'Передать на склад';
  if (lower.includes('передать')) return 'Передать';
  if (lower.includes('сохранить черновик')) return 'Сохранить';
  if (lower.includes('сохранить')) return 'Сохранить';
  if (lower.includes('назначить ответственного')) return 'Назначить ответственного';
  if (lower.includes('согласовать')) return 'Согласовать';
  if (lower.includes('подтвердить исключение')) return 'Подтвердить';
  if (lower.includes('подтвердить действие')) return 'Подтвердить';
  if (id.includes('finance-retry-sync') || id === 'retry-sync' || lower.includes('повторить проверку источника')) return 'Повторить проверку источника';
  if (lower.includes('повторить проверку') || lower.includes('повторить синхронизацию') || id.includes('retry-sync')) return 'Повторить проверку';
  if (lower.includes('повторить замер')) return 'Повторить замер';
  if (lower.includes('выставить счет') && lower.includes('к оплате')) return 'Отправить счет к оплате';
  if (lower.includes('выставить счет')) return 'Выставить счет';
  if (id.includes('finance-check-payment') || ['check-payment', 'check-installment', 'check-after-invoice'].includes(id) || lower.includes('сверить источник оплаты') || lower.includes('проверить поступление')) return 'Проверить оплату';
  if (id.startsWith('finance-confirm-cash') || lower.includes('зафиксировать ручную сверку')) return 'Зафиксировать сверку';
  if (lower.includes('отметить оплату вручную') || lower.includes('обновить оплату вручную') || lower.includes('обновить оплату')) return 'Обновить оплату вручную';
  if (id.startsWith('finance-edit-material-cost')) return 'Обновить учетную цену';
  if (lower.includes('проверить оплату')) return 'Проверить оплату';
  if (lower.includes('зафиксировать') && lower.includes('вес')) return 'Зафиксировать вес';
  if (lower.includes('стартовый вес') && lower.includes('big-bag')) return 'Зафиксировать вес';
  if (lower.includes('финальный вес') && lower.includes('big-bag')) return 'Зафиксировать вес';
  if (lower.includes('привязать рабочее место')) return 'Привязать';
  if (lower.includes('проверить устройство')) return 'Проверить';
  if (lower.includes('открыть заказ-наряд')) return 'Статус производства';
  if (lower.includes('открыть проверку')) return 'Проверить заказ';
  if (lower.includes('открыть график')) return 'График';
  if (lower.includes('открыть журнал')) return 'Журнал';
  if (lower.includes('открыть сканы')) return 'Сканы';
  if (lower.includes('добавить комментарий')) return 'Комментарий';
  if (lower.includes('применить шаблон')) return 'Применить шаблон';
  if (lower.includes('частичная приемка')) return 'Частичная приемка';
  if (lower.includes('частичная выдача')) return 'Частичная выдача';
  if (lower.includes('закрыть приемку')) return 'Закрыть приемку';
  if (id.includes('warehouse.delivery.close')) return 'Закрыть выдачу';
  if (lower.includes('отменить заявку')) return 'Отменить';
  if (lower.includes('вернуть в заявку')) return 'Вернуть в заявку';
  if (lower.includes('вернуть на склад')) return 'Вернуть';
  if (lower.includes('заблокировать')) return 'Заблокировать';
  if (lower.includes('отключить')) return 'Отключить';
  if (lower.includes('назначить штраф')) return 'Назначить штраф';
  if (id === 'operator-close-shift-request') return 'Сдать смену';
  if (id === 'operator-close-shift') return 'Закрыть смену';
  if (id === 'operator-close-shift-cancel') return 'Отменить сдачу';
  if (id.includes('close')) return 'Закрыть';
  return label;
}

export function actionTileMeta(action: ActionDescriptor, displayLabel: string) {
  if (action.confirmation) return action.confirmation;
  if (action.id.startsWith('warehouse-print-pallet-list')) return 'Палетный лист из QR палеты';
  const label = action.label.replace('...', '').trim();
  const normalizedLabel = label.toLowerCase();
  const normalizedDisplay = displayLabel.toLowerCase();
  if (normalizedDisplay === 'очередь') return 'Порядок обновится';
  if (normalizedDisplay === 'история') return 'Аудит и события';
  if (normalizedDisplay === 'график') return 'Платежи по датам';
  if (normalizedDisplay === 'синхронизация') return 'Проверить источник';
  if (normalizedDisplay === 'статус выдачи') return 'Проверить выдачу';
  if (normalizedDisplay === 'следующий заказ') return 'Открыть в Моих заказах';
  if (normalizedDisplay === 'проверить заказ') return 'Полнота полей';
  if (normalizedDisplay === 'отправить счет к оплате') return 'Закрыть напоминание';
  if (normalizedDisplay === 'комментарий директору') return 'Добавить к решению';
  if (normalizedLabel.includes(normalizedDisplay) || normalizedDisplay.includes(normalizedLabel)) return undefined;
  if (normalizedLabel.includes('проблем') && normalizedDisplay.includes('проблем')) return undefined;
  if (normalizedLabel.includes('найти') && normalizedDisplay.includes('найти')) return undefined;
  if (normalizedLabel.includes('скан') && normalizedDisplay.includes('скан')) return undefined;
  if (normalizedLabel.includes('зафиксир') && normalizedDisplay.includes('зафиксир') && normalizedLabel.includes('вес') && normalizedDisplay.includes('вес')) return undefined;
  return label !== displayLabel ? label : undefined;
}

export function disabledActionMeta(action: ActionDescriptor) {
  if (action.recoveryAction === 'Подождать стабильный сигнал весов' && action.disabledReason) return action.disabledReason;
  const meta = action.recoveryAction ?? action.disabledReason;
  if (meta === 'Разобрать последний скан') return 'Разобрать скан';
  return meta;
}
