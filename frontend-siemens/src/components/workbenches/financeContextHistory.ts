import type { AuditEntry } from '../../domain/types';

const LEGACY_ACTIONS: Readonly<Record<string, { label: string; detail: string }>> = {
  'audit:invoice_status_imported': {
    label: 'Счёт подтверждён',
    detail: 'Статус счёта обновлён.',
  },
  'audit:invoice_status_updated': {
    label: 'Статус счёта изменён',
    detail: 'Статус счёта обновлён.',
  },
  'audit:payment_status_imported': {
    label: 'Платёж подтверждён',
    detail: 'Статус оплаты обновлён.',
  },
  'audit:payment_status_updated': {
    label: 'Статус оплаты изменён',
    detail: 'Статус оплаты обновлён.',
  },
  'audit:payment_schedule_created': {
    label: 'График платежей создан',
    detail: 'Условия рассрочки зафиксированы.',
  },
  'audit:sync_retry_requested': {
    label: 'Запрошена повторная проверка',
    detail: 'Подтверждение поступления запрошено повторно.',
  },
  'problem:finance_overdue_created': {
    label: 'Просрочка зафиксирована',
    detail: 'Срок оплаты пропущен.',
  },
  'problem:finance_source_error_created': {
    label: 'Поступление не подтверждено',
    detail: 'Требуется повторная проверка поступления.',
  },
  'problem:payment_overdue': {
    label: 'Просрочка зафиксирована',
    detail: 'Срок оплаты пропущен.',
  },
  'problem:payment_sync_error': {
    label: 'Поступление не подтверждено',
    detail: 'Требуется повторная проверка поступления.',
  },
};

const LEGACY_VALUES: Readonly<Record<string, string>> = {
  due_today: 'Оплата сегодня',
  issued: 'Счёт выставлен',
  overdue: 'Просрочен',
  paid: 'Оплачен',
  partial: 'Частично оплачен',
  sent: 'Счёт отправлен',
  unpaid: 'Не оплачен',
};

const INTERNAL_TEXT =
  /(?:audit:|problem:|notification:|raw_?payload|request_?fingerprint|operation_?key|\b[a-z]+_[a-z_]+\b)/iu;

function safeValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (LEGACY_VALUES[normalized]) return LEGACY_VALUES[normalized];
  const prefixedStatus = Object.entries(LEGACY_VALUES).find(([status]) =>
    normalized.startsWith(`${status}:`),
  );
  if (prefixedStatus) {
    const suffix = value.slice(value.indexOf(':') + 1).trim();
    return suffix ? `${prefixedStatus[1]}: ${suffix}` : prefixedStatus[1];
  }
  return INTERNAL_TEXT.test(value) ? undefined : value;
}

function safeActor(actorLabel: string): string {
  if (/снимок\s+1[сc]/iu.test(actorLabel) || INTERNAL_TEXT.test(actorLabel)) {
    return 'Система · Финансы';
  }
  return actorLabel;
}

export function projectFinanceContextHistory(entries: AuditEntry[]): AuditEntry[] {
  const seen = new Set<string>();
  const projected: AuditEntry[] = [];

  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);

    const legacy = LEGACY_ACTIONS[entry.actionLabel];
    const internalAction = entry.actionLabel.includes(':') || INTERNAL_TEXT.test(entry.actionLabel);
    if (internalAction) {
      const oldValue = legacy ? safeValue(entry.oldValue) : undefined;
      const newValue = legacy ? safeValue(entry.newValue) : undefined;
      projected.push({
        id: entry.id,
        objectId: entry.objectId,
        time: entry.time,
        actorLabel: safeActor(entry.actorLabel),
        actionLabel: legacy?.label ?? 'Неизвестное событие',
        detail: legacy?.detail ?? 'Подробности события недоступны.',
        ...(oldValue !== undefined ? { oldValue } : {}),
        ...(newValue !== undefined ? { newValue } : {}),
        scope: 'finance',
      });
      continue;
    }

    const oldValue = safeValue(entry.oldValue);
    const newValue = safeValue(entry.newValue);
    projected.push({
      id: entry.id,
      objectId: entry.objectId,
      time: entry.time,
      actorLabel: safeActor(entry.actorLabel),
      actionLabel: entry.actionLabel,
      detail: INTERNAL_TEXT.test(entry.detail) ? 'Подробности события недоступны.' : entry.detail,
      ...(oldValue !== undefined ? { oldValue } : {}),
      ...(newValue !== undefined ? { newValue } : {}),
      ...(entry.reason && !INTERNAL_TEXT.test(entry.reason) ? { reason: entry.reason } : {}),
      scope: 'finance',
    });
  }

  return projected;
}
