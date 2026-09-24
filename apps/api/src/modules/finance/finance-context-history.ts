type FinanceContextEvent = {
  id: string;
  objectId: string;
  type: string;
  actorRole: string | null;
  actorId: string | null;
  actorDisplayName: string | null;
  createdAt: Date;
  reason: string | null;
  oldValue: unknown;
  newValue: unknown;
  detail: unknown;
};

type FinanceContextHistoryEntry = {
  id: string;
  occurredAt: string;
  actor: string;
  actorRole: string;
  action: string;
  field: string | null;
  previousValue: string | null;
  currentValue: string | null;
  reason: string | null;
};

const ROLE_LABELS: Record<string, string> = {
  commercial: 'Коммерция',
  finance: 'Бухгалтерия',
  production_lead: 'Зав. производства',
  director: 'Директор',
  admin: 'Администратор',
  system: 'Система',
};

type HistoryFieldContract = { key: string; label: string };
type HistoryEventContract = { action: string; fields: readonly HistoryFieldContract[] };

const EVENT_CONTRACTS: Record<string, HistoryEventContract> = {
  'audit:commercial_order_comment_updated': {
    action: 'Комментарий коммерции изменён',
    fields: [{ key: 'comment', label: 'Комментарий' }],
  },
  'audit:commercial_finance_note_updated': {
    action: 'Финансовый комментарий коммерции изменён',
    fields: [
      { key: 'commercialFinanceNote', label: 'Финансовый комментарий' },
      { key: 'financeNote', label: 'Финансовый комментарий' },
    ],
  },
  'audit:commercial_position_updated': {
    action: 'Параметры заказа изменены',
    fields: [
      { key: 'rollCount', label: 'Количество рулонов' },
      { key: 'filmType', label: 'Тип плёнки' },
      { key: 'actualThickness', label: 'Фактическая толщина' },
      { key: 'accountingThickness', label: 'Учётная толщина' },
      { key: 'widthMm', label: 'Ширина' },
      { key: 'plannedLengthM', label: 'Плановая длина' },
      { key: 'spoolType', label: 'Тип шпули' },
      { key: 'birka', label: 'Бирка' },
      { key: 'manualBirka', label: 'Текст бирки' },
      { key: 'comment', label: 'Комментарий позиции' },
      { key: 'plannedWeightKg', label: 'Плановый вес' },
    ],
  },
  'audit:commercial_order_amended': {
    action: 'Заказ скорректирован',
    fields: [
      { key: 'rollCount', label: 'Количество рулонов' },
      { key: 'filmType', label: 'Тип плёнки' },
      { key: 'actualThickness', label: 'Фактическая толщина' },
      { key: 'accountingThickness', label: 'Учётная толщина' },
      { key: 'widthMm', label: 'Ширина' },
      { key: 'plannedLengthM', label: 'Плановая длина' },
      { key: 'spoolType', label: 'Тип шпули' },
      { key: 'birka', label: 'Бирка' },
      { key: 'manualBirka', label: 'Текст бирки' },
      { key: 'comment', label: 'Комментарий позиции' },
      { key: 'plannedWeightKg', label: 'Плановый вес' },
      { key: 'recipeVersion', label: 'Версия рецептуры' },
      { key: 'status', label: 'Статус заказа' },
    ],
  },
  'audit:invoice_status_updated': {
    action: 'Статус счёта изменён',
    fields: [
      { key: 'invoiceStatus', label: 'Статус счёта' },
      { key: 'status', label: 'Статус счёта' },
    ],
  },
  'audit:payment_status_updated': {
    action: 'Статус оплаты изменён',
    fields: [
      { key: 'paymentStatus', label: 'Статус оплаты' },
      { key: 'status', label: 'Статус оплаты' },
    ],
  },
  'audit:payment_status_imported': {
    action: 'Поступление подтверждено',
    fields: [
      { key: 'paymentStatus', label: 'Статус оплаты' },
      { key: 'status', label: 'Статус оплаты' },
      { key: 'amount', label: 'Сумма' },
    ],
  },
  'audit:manual_payment_corrected': {
    action: 'Оплата скорректирована',
    fields: [
      { key: 'paymentStatus', label: 'Статус оплаты' },
      { key: 'status', label: 'Статус оплаты' },
      { key: 'amount', label: 'Сумма' },
    ],
  },
  'audit:payment_policy_created': {
    action: 'График рассрочки создан',
    fields: [
      { key: 'revision', label: 'Версия условий оплаты' },
      { key: 'installmentDays', label: 'Срок рассрочки' },
    ],
  },
  'audit:payment_policy_updated': {
    action: 'График рассрочки изменён',
    fields: [
      { key: 'revision', label: 'Версия условий оплаты' },
      { key: 'installmentDays', label: 'Срок рассрочки' },
    ],
  },
  'audit:payment_schedule_item_confirmed': {
    action: 'Этап рассрочки подтверждён',
    fields: [
      { key: 'status', label: 'Статус этапа' },
      { key: 'amount', label: 'Сумма этапа' },
    ],
  },
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeScalar(record: Record<string, unknown> | null, key: string): string | null {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  if (value === null) return 'Не указано';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function changedFields(
  event: FinanceContextEvent,
  contract: HistoryEventContract,
): HistoryFieldContract[] {
  const previous = objectRecord(event.oldValue);
  const current = objectRecord(event.newValue);
  const declared = objectRecord(event.detail)?.changedFields;
  const declaredKeys = Array.isArray(declared)
    ? new Set(declared.filter((value): value is string => typeof value === 'string'))
    : null;
  const changed = contract.fields.filter(({ key }) => {
    if (declaredKeys?.has(key)) return true;
    const before = safeScalar(previous, key);
    const after = safeScalar(current, key);
    return before !== after && (before !== null || after !== null);
  });
  if (changed.length > 0) return changed.slice(0, 5);
  return contract.fields
    .filter(({ key }) => safeScalar(previous, key) !== null || safeScalar(current, key) !== null)
    .slice(0, 1);
}

function historyValue(
  record: Record<string, unknown> | null,
  fields: HistoryFieldContract[],
): string | null {
  const values = fields.flatMap(({ key, label }) => {
    const value = safeScalar(record, key);
    return value === null ? [] : [{ label, value }];
  });
  if (values.length === 0) return null;
  if (fields.length === 1) return values[0].value;
  return values.map(({ label, value }) => `${label}: ${value}`).join('; ');
}

function safeReason(reason: string | null): string | null {
  const normalized = reason?.trim();
  return normalized ? normalized.slice(0, 500) : null;
}

export function projectFinanceContextHistory(
  events: FinanceContextEvent[],
): FinanceContextHistoryEntry[] {
  const unique = new Map(events.map((event) => [event.id, event]));
  return [...unique.values()]
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
    )
    .map((event) => {
      const contract = EVENT_CONTRACTS[event.type];
      const role = event.actorRole ? (ROLE_LABELS[event.actorRole] ?? 'Сотрудник') : 'Система';
      const fields = contract ? changedFields(event, contract) : [];
      return {
        id: event.id,
        occurredAt: event.createdAt.toISOString(),
        actor: event.actorDisplayName?.trim() || role,
        actorRole: role,
        action: contract?.action ?? 'Неизвестное событие',
        field: fields.length > 0 ? fields.map(({ label }) => label).join(', ') : null,
        previousValue: contract ? historyValue(objectRecord(event.oldValue), fields) : null,
        currentValue: contract ? historyValue(objectRecord(event.newValue), fields) : null,
        reason: contract ? safeReason(event.reason) : null,
      };
    });
}
