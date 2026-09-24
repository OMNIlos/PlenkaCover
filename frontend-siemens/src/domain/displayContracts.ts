import type {
  AuditEntry,
  Fact,
  InvoiceLifecycleStatus,
  PaymentScheduleEntry,
  PaymentLifecycleStatus,
  SyncJournalStatus,
  WorkObject,
} from './types';
import { businessClockAt } from './runtime/businessClock';

export type FinanceSourceState =
  | 'ready'
  | 'manual_check'
  | 'source_error'
  | 'schedule'
  | 'manual_review';

export type FinanceDisplayContract = {
  orderNumber: string;
  customer: string;
  invoiceStatus: InvoiceLifecycleStatus;
  invoiceLabel: string;
  paymentStatus: PaymentLifecycleStatus;
  paymentLabel: string;
  amountLabel: string;
  amountPaidLabel: string;
  amountRemainingLabel: string;
  nextPaymentLabel: string;
  shipmentDateLabel: string;
  paymentKindLabel: string;
  installmentLabel: string;
  scheduleLabel: string;
  dueDateIso?: string;
  dueDateLabel: string;
  sourceStatus: SyncJournalStatus;
  sourceState: FinanceSourceState;
  sourceLabel: string;
  sourceFreshnessLabel: string;
  latestAuditLabel: string;
  auditEvidenceLabel: string;
  searchText: string;
};

const auditLabels: Record<string, string> = {
  'audit:kickback_changed': 'Откат изменен',
  'audit:penalty_created': 'Штраф назначен',
  'audit:penalty_updated': 'Штраф изменен',
  'audit:commercial_order_draft_created': 'Заявка создана',
  'audit:commercial_order_position_added': 'Позиция добавлена',
  'audit:commercial_order_position_updated': 'Позиция сохранена',
  'audit:commercial_recipe_snapshot_set': 'Рецептура сохранена',
  'audit:production_lead_request_created': 'Заявка создана зав. производства',
  'audit:commercial_recipe_confirmed': 'Рецептура подтверждена коммерцией',
  'audit:commercial_params_editor_opened': 'Редактор параметров открыт',
  'audit:commercial_position_correction_requested': 'Запрошено изменение позиции',
  'audit:position_template_created': 'Шаблон позиции создан',
  'audit:position_template_versioned': 'Шаблон позиции версионирован',
  'audit:position_template_diff_accepted': 'Сверка шаблона позиции принята',
  'audit:position_template_applied': 'Шаблон позиции применен',
  'audit:counterparty_billing_snapshot_set': 'Реквизиты закреплены',
  'audit:counterparty_attached_to_order': 'Контрагент добавлен в заявку',
  'audit:commercial_missing_part_transferred': 'Недостающая часть передана',
  'audit:commercial_payment_shipment_opened': 'Оплата и отгрузка открыты',
  'audit:warehouse_cover_proposed': 'Склад предложил покрытие',
  'audit:warehouse_cover_confirmed': 'Складское покрытие подтверждено',
  'audit:warehouse_cover_disputed': 'Покрытие разобрано коммерцией',
  'audit:warehouse_recheck_requested': 'Запрошена перепроверка склада',
  'notification:warehouse_recheck_requested': 'Запрошена перепроверка склада',
  'audit:warehouse_recheck_resolved': 'Перепроверка склада завершена',
  'notification:warehouse_recheck_resolved': 'Перепроверка склада завершена',
  'audit:warehouse_cover_recalculated': 'Складское покрытие пересчитано',
  'audit:commercial_position_edited_after_warehouse_cover':
    'Позиция изменена после покрытия склада',
  'audit:warehouse_reserve_released': 'Резерв снят с заказа',
  'audit:warehouse_reserve_opened': 'Резерв открыт складом',
  'audit:missing_quantity_sent_to_production': 'Недостача передана в производство',
  'audit:production_delta_finalized': 'Производственная часть обновлена',
  'audit:production_problem_created': 'Проблема производства создана',
  'audit:production_problem_resolved': 'Проблема производства закрыта',
  'audit:roll_reserved_for_order': 'Резерв закреплен под заказ',
  'audit:warehouse_reserved_rolls_prepared': 'Резерв подготовлен складом',
  'audit:mixed_pallet_receiving_opened': 'Приемка палеты открыта',
  'audit:pallet_list_print_requested': 'Палетный лист открыт',
  'audit:warehouse_receiving_opened': 'Приемка открыта',
  'audit:warehouse_qr_accepted': 'QR принят',
  'audit:warehouse_receiving_closed': 'Приемка закрыта',
  'audit:raw_material_reference_imported': 'Учет сырья импортирован',
  'audit:raw_material_position_created': 'Позиция сырья создана',
  'audit:raw_material_position_updated': 'Позиция сырья обновлена',
  'audit:warehouse_inventory_position_created': 'Складская позиция создана',
  'audit:warehouse_inventory_position_updated': 'Складская позиция обновлена',
  'audit:inventory_fact_overrode_accounting_snapshot': 'Складской факт применен',
  'audit:material_received': 'Сырье принято',
  'audit:raw_material_stock_adjusted': 'Фактический склад сырья изменен',
  'audit:raw_material_usage_planned': 'План расхода сырья записан',
  'audit:raw_material_usage_recorded': 'Расход сырья записан',
  'audit:raw_material_reserved_for_order': 'Сырье закреплено под заказ',
  'audit:raw_material_reserve_released': 'Резерв сырья снят',
  'audit:director_finance_override_requested': 'Директор запросил проверку',
  'audit:director_finance_override_applied': 'Директорское решение по финансам',
  'audit:director_finance_recheck_requested': 'Директор отправил на сверку',
  'audit:director_finance_decision_recorded': 'Решение директора записано',
  'audit:director_production_override_applied': 'Директорское решение по производству',
  'audit:director_warehouse_override_applied': 'Директорское решение по складу',
  'problem:inventory_mutation_blocked': 'Изменение остатка заблокировано',
  'audit:secondary_raw_material_transfer_requested': 'Перемещение вторички запрошено',
  'audit:secondary_raw_material_transfer_signed': 'Перемещение вторички подписано',
  'audit:secondary_raw_material_transfer_rejected': 'Перемещение вторички отклонено',
  'audit:tape_consumption_calculated': 'Расход скотча рассчитан',
  'audit:tape_consumption_corrected': 'Расход скотча скорректирован',
  'audit:invoice_status_imported': 'Счет импортирован',
  'audit:invoice_status_updated': 'Статус счета обновлен',
  'audit:payment_status_updated': 'Статус оплаты обновлен',
  'audit:payment_status_imported': 'Платеж импортирован',
  'audit:shipment_completed': 'Отгрузка закрыта',
  'audit:installment_schedule_created': 'Рассрочка запланирована',
  'audit:qr_status_changed': 'QR-статус изменен',
  'audit:label_reprint_requested': 'Переиздание этикетки запрошено',
  'audit:sync_retry_requested': 'Повторная проверка запрошена',
  'audit:task_assigned': 'Ответственный назначен',
  'audit:task_reassigned': 'Ответственный переназначен',
  'audit:production_priority_changed': 'Приоритет производства изменен',
  'audit:roll_dispatch_assigned': 'Рулон назначен',
  'audit:machine_assigned': 'Станок назначен',
  'audit:production_roll_machine_default_applied': 'Default станка применен',
  'audit:production_roll_machine_overridden': 'Станок рулона переопределен',
  'audit:production_queue_reordered': 'Очередь рулонов изменена',
  'audit:pallet_list_export_requested': 'Экспорт палетного листа запрошен',
  'integration:pallet_list_export_requested': 'Экспорт палетного листа передан сервису',
  'audit:correction_applies_from_roll_set': 'Рулон применения задан',
  'audit:current_roll_resolution_set': 'Текущий рулон решен',
  'notification:operator_task_updated': 'Инструкция оператору обновлена',
  'audit:recipe_approved': 'Рецептура подтверждена',
  'audit:problem_confirmed': 'Проблема подтверждена',
  'audit:problem_returned_to_warehouse': 'Проблема возвращена складу',
  'audit:payment_schedule_created': 'График платежа создан',
  'audit:payment_trigger_blocked': 'Финансовый срок заблокирован',
  'op:installment_countdown_started': 'Срок рассрочки запущен',
  'notification:penalty_sent': 'Уведомление отправлено',
  'notification:payment_due_invoice_needed': 'Нужен счет к оплате',
  integration_sync_failed: 'Проверка источника не прошла',
  'problem:payment_overdue': 'Просрочка оплаты',
  'problem:inventory_source_conflict': 'Конфликт источника записан',
  'problem:raw_material_shortage': 'Дефицит сырья записан',
  'problem:payment_source_conflict': 'Проблема источника записана',
  'problem:payment_sync_error': 'Проблема источника записана',
  'problem:warehouse_roll_defect_reported': 'Брак рулона записан',
  'problem:source_sync_reported': 'Проблема источника записана',
  'problem:finance_overdue_created': 'Просрочка оплаты',
  'problem:finance_source_error_created': 'Проблема источника записана',
  'problem:material_shortage_blocker_created': 'Создан блокер недостачи',
};

const businessCodeLabels: Record<string, string> = {
  received: 'Принят складом',
  receiving_scan: 'Приёмка по QR',
  production_handover: 'Передан из производства',
  warehouse_pallet_roll_selected: 'Рулон добавлен в палетный лист',
  warehouse_pallet_roll_deselected: 'Рулон исключён из палетного листа',
  manual_deselection: 'Исключён вручную',
};

function normalizedBusinessCode(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/^(?:audit|event|source|status):/u, '')
    .replace(/[\s.:/-]+/gu, '_')
    .replace(/_+/gu, '_');
}

function looksTechnical(value: string): boolean {
  return (
    /^(?:audit|event|integration|notification|op|problem|source|status):/iu.test(value) ||
    value.includes('_') ||
    /^[a-z\d][a-z\d .:/-]*$/iu.test(value)
  );
}

export function visibleBusinessCodeLabel(value: string): string {
  const trimmed = value.trim();
  const known = businessCodeLabels[normalizedBusinessCode(trimmed)];
  if (known) return known;
  return looksTechnical(trimmed) ? 'Неизвестное событие' : trimmed;
}

export function visibleAuditActionLabel(actionLabel: string) {
  if (auditLabels[actionLabel]) return auditLabels[actionLabel];
  const businessLabel = visibleBusinessCodeLabel(actionLabel);
  if (businessLabel !== 'Неизвестное событие') return businessLabel;
  if (actionLabel.startsWith('problem:')) return 'Проблема записана';
  if (actionLabel.startsWith('notification:')) return 'Уведомление отправлено';
  if (actionLabel.startsWith('op:')) return 'Операция записана';
  return 'Неизвестное событие';
}

export function factValueFromObject(object: WorkObject, label: string) {
  return (
    object.facts.find((fact) => fact.label === label)?.value ??
    object.sections.flatMap((section) => section.facts).find((fact) => fact.label === label)?.value
  );
}

export function normalizeDisplayText(value: string | undefined) {
  return (value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/1c/g, '1с');
}

export function businessSourceLabel(
  value: string | undefined,
  fallback: SyncJournalStatus = 'ready',
) {
  const source = normalizeDisplayText(value);
  if (source.includes('ошибка') || source.includes('не подтверд')) return 'источник не подтвердил';
  if (source.includes('ручн')) return 'ручная проверка';
  if (source.includes('график') || source.includes('платеж')) return 'график платежа';
  if (source.includes('склад') || source.includes('выдач')) return 'складской контур';
  if (source.includes('1с')) return 'учётный снимок';
  if (fallback === 'error') return 'источник не подтвердил';
  if (fallback === 'waiting') return 'ожидает данных';
  if (fallback === 'manual_review') return 'ручная проверка';
  if (fallback === 'not_required') return 'не требуется';
  return 'источник подтвержден';
}

export function warehouseSourceLabel(value: string | undefined) {
  const source = normalizeDisplayText(value);
  if (!source) return 'склад';
  if (source.includes('warehousecoverproposal')) return 'резерв склада';
  if (source.includes('audit') || source.includes('source layer')) return 'история склада';
  if (source.includes('manual') || source.includes('ручн')) return 'ручной учет';
  if (source.includes('warehouse') || source.includes('склад')) return 'склад';
  if (source.includes('1с')) return 'учётный снимок';
  if (source.includes('директор') || source.includes('олег'))
    return value ?? 'решение руководителя';
  return value ?? 'склад';
}

function statusSource(value: string | undefined): SyncJournalStatus {
  const source = normalizeDisplayText(value);
  if (source.includes('ошибка') || source.includes('не подтверд')) return 'error';
  if (source.includes('ожида') || source.includes('ждет')) return 'waiting';
  if (source.includes('ручн') || source.includes('провер')) return 'manual_review';
  if (source.includes('не требуется')) return 'not_required';
  return 'ready';
}

function sourceStateFromStatus(status: SyncJournalStatus, sourceLabel: string): FinanceSourceState {
  const source = normalizeDisplayText(sourceLabel);
  if (status === 'error') return 'source_error';
  if (status === 'manual_review') return 'manual_review';
  if (source.includes('график') || source.includes('платеж')) return 'schedule';
  if (source.includes('провер')) return 'manual_check';
  return 'ready';
}

function invoiceStatusFromText(
  object: WorkObject,
  invoiceLabel: string,
  paymentLabel: string,
): InvoiceLifecycleStatus {
  const text = normalizeDisplayText(`${object.statusLabel} ${invoiceLabel} ${paymentLabel}`);
  if (text.includes('ошибка источника') || text.includes('ошибка синхронизации'))
    return 'sync_error';
  if (text.includes('требует проверки') || text.includes('не подтвержден'))
    return 'not_confirmed_by_source';
  if (text.includes('ждет выдачу') || text.includes('выдача еще не закрыта'))
    return 'waiting_delivery';
  if (text.includes('просроч')) return 'overdue';
  if (text.includes('к оплате') || text.includes('оплата сегодня')) return 'payment_due_today';
  if (text.includes('рассроч')) return 'installment_running';
  if (text.includes('оплачено') || text.includes('оплачен')) return 'paid';
  if (
    text.includes('счет отправлен') ||
    text.includes('счет выставлен') ||
    text.includes('счет связан')
  )
    return 'issued';
  return 'waiting_invoice';
}

function paymentStatusFromText(
  object: WorkObject,
  paymentLabel: string,
  installmentLabel: string,
): PaymentLifecycleStatus {
  const text = normalizeDisplayText(`${object.statusLabel} ${paymentLabel} ${installmentLabel}`);
  if (
    text.includes('ошибка источника') ||
    text.includes('ошибка синхронизации') ||
    text.includes('требует проверки')
  )
    return 'sync_error';
  if (text.includes('просроч')) return 'overdue';
  if (text.includes('частич')) return 'partial';
  if (text.includes('оплачено') || text.includes('оплачен')) return 'paid';
  if (text.includes('ждет выдачу') || text.includes('выдача еще не закрыта'))
    return 'waiting_delivery';
  if (
    text.includes('к оплате') ||
    text.includes('оплата сегодня') ||
    text.includes('день плановой оплаты')
  )
    return 'payment_due_today';
  if (text.includes('рассроч') || text.includes('дней')) return 'installment_running';
  if (text.includes('ожидает оплаты') || text.includes('ждет оплат')) return 'unpaid';
  return 'not_expected';
}

export function invoiceLifecycleLabel(status: InvoiceLifecycleStatus, rawLabel?: string) {
  const raw = rawLabel?.trim();
  if (raw && !normalizeDisplayText(raw).includes('нет данных')) return raw;
  const labels: Record<InvoiceLifecycleStatus, string> = {
    waiting_invoice: 'Не выставлен',
    issued: 'Счет отправлен',
    not_confirmed_by_source: 'Требует проверки',
    waiting_delivery: 'Ждет выдачу',
    installment_running: 'Счет отправлен',
    payment_due_today: 'Счет к оплате',
    overdue: 'Счет отправлен',
    paid: 'Счет отправлен',
    sync_error: 'Источник не подтвердил',
  };
  return labels[status];
}

export function paymentLifecycleLabel(status: PaymentLifecycleStatus, rawLabel?: string) {
  if (status === 'overdue') return 'Просрочка оплаты';
  if (status === 'payment_due_today') return 'День плановой оплаты';
  if (status === 'sync_error') return 'Требует проверки';
  const raw = rawLabel?.trim();
  if (raw && !normalizeDisplayText(raw).includes('нет данных')) return raw;
  const labels: Record<PaymentLifecycleStatus, string> = {
    not_expected: 'Не ожидается до счета',
    waiting_delivery: 'Ждет выдачу',
    unpaid: 'Ожидает оплаты',
    partial: 'Частично оплачен',
    installment_running: 'Рассрочка',
    payment_due_today: 'День плановой оплаты',
    overdue: 'Просрочка оплаты',
    paid: 'Оплачено',
    sync_error: 'Требует проверки',
  };
  return labels[status];
}

function extractIsoDate(...values: Array<string | undefined>) {
  for (const value of values) {
    const match = value?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (match) return match[1];
  }
  return undefined;
}

function scheduleDateIso(schedule: PaymentScheduleEntry): string | undefined {
  return schedule.dueDateIso;
}

function currentLivePaymentSchedule(object: WorkObject): PaymentScheduleEntry | undefined {
  const schedules = object.paymentSchedules ?? [];
  const open = schedules.filter((schedule) => schedule.status !== 'paid');
  const candidates = open.length > 0 ? open : schedules;
  return [...candidates].sort((left, right) => {
    const leftDate = scheduleDateIso(left) ?? '9999-12-31';
    const rightDate = scheduleDateIso(right) ?? '9999-12-31';
    return (
      leftDate.localeCompare(rightDate) ||
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id)
    );
  })[0];
}

function paymentStatusFromLiveSchedule(
  object: WorkObject,
  fallback: PaymentLifecycleStatus,
  schedule: PaymentScheduleEntry | undefined,
  todayIso: string,
): PaymentLifecycleStatus {
  const schedules = object.paymentSchedules ?? [];
  if (schedules.length === 0) return fallback;
  if (schedules.every((entry) => entry.status === 'paid')) return 'paid';

  const actualDueDateIso = schedule?.dueDateIso;
  if (actualDueDateIso && actualDueDateIso < todayIso) return 'overdue';
  if (actualDueDateIso === todayIso) return 'payment_due_today';
  if (fallback === 'partial') return 'partial';
  return 'installment_running';
}

function dueDateForObject(
  object: WorkObject,
  paymentStatus: PaymentLifecycleStatus,
  rawDueLabel: string,
  todayIso: string,
  liveSchedule: PaymentScheduleEntry | undefined,
) {
  if (liveSchedule) return scheduleDateIso(liveSchedule);
  const explicit = extractIsoDate(
    object.paymentSchedule?.dueDateLabel,
    rawDueLabel,
    factValueFromObject(object, 'Дата оплаты'),
  );
  if (explicit) return explicit;
  if (paymentStatus === 'payment_due_today') return todayIso;
  return undefined;
}

function dueLabel(
  dateIso: string | undefined,
  fallback: string,
  paymentStatus: PaymentLifecycleStatus,
  todayIso: string,
) {
  if (paymentStatus === 'overdue') return 'просрочено';
  if (paymentStatus === 'payment_due_today') return 'сегодня';
  if (!dateIso) return fallback || 'не назначен';
  if (dateIso === todayIso) return 'сегодня';
  return dateIso;
}

function auditEvidence(entry: AuditEntry | undefined) {
  if (!entry) return { latestAuditLabel: 'нет события', auditEvidenceLabel: 'нет события' };
  const label = visibleAuditActionLabel(entry.actionLabel);
  return {
    latestAuditLabel: label,
    auditEvidenceLabel: `${entry.time} · ${label}`,
  };
}

export function financeDisplayContractFromObject(
  object: WorkObject,
  now?: Date,
): FinanceDisplayContract {
  const todayIso = businessClockAt(now).dateIso;
  const rawInvoiceLabel = factValueFromObject(object, 'Статус счета') ?? '';
  const rawPaymentLabel = factValueFromObject(object, 'Статус оплаты') ?? object.statusLabel;
  const rawInstallmentLabel = factValueFromObject(object, 'Рассрочка') ?? '';
  const sourceRaw = factValueFromObject(object, 'Источник данных') ?? '';
  const sourceStatus = statusSource(
    `${object.statusLabel} ${sourceRaw} ${rawInvoiceLabel} ${rawPaymentLabel}`,
  );
  const sourceLabel = businessSourceLabel(sourceRaw, sourceStatus);
  const sourceState = sourceStateFromStatus(sourceStatus, sourceLabel);
  const invoiceStatus = invoiceStatusFromText(object, rawInvoiceLabel, rawPaymentLabel);
  const textPaymentStatus = paymentStatusFromText(object, rawPaymentLabel, rawInstallmentLabel);
  const liveSchedule = currentLivePaymentSchedule(object);
  const paymentStatus = paymentStatusFromLiveSchedule(
    object,
    textPaymentStatus,
    liveSchedule,
    todayIso,
  );
  const rawDueLabel =
    liveSchedule?.dueDateLabel ??
    object.paymentSchedule?.dueDateLabel ??
    factValueFromObject(object, 'Дата оплаты') ??
    factValueFromObject(object, 'Следующий платеж') ??
    '';
  const dueDateIso = dueDateForObject(object, paymentStatus, rawDueLabel, todayIso, liveSchedule);
  const audit = auditEvidence(object.audit[0]);
  const contract = {
    orderNumber:
      factValueFromObject(object, 'Номер') ??
      factValueFromObject(object, 'Заказ') ??
      factValueFromObject(object, 'Заказ-наряд') ??
      object.id,
    customer:
      factValueFromObject(object, 'Заказчик') ??
      factValueFromObject(object, 'Контрагент') ??
      'нет данных',
    invoiceStatus,
    invoiceLabel: invoiceLifecycleLabel(invoiceStatus, rawInvoiceLabel),
    paymentStatus,
    paymentLabel: paymentLifecycleLabel(
      paymentStatus,
      object.paymentSchedules?.length ? undefined : rawPaymentLabel,
    ),
    amountLabel:
      factValueFromObject(object, 'Сумма') ??
      factValueFromObject(object, 'Сумма к счету') ??
      'нет данных',
    amountPaidLabel: factValueFromObject(object, 'Оплачено') ?? '0 ₽',
    amountRemainingLabel: factValueFromObject(object, 'Остаток') ?? 'нет данных',
    nextPaymentLabel: factValueFromObject(object, 'Следующий платеж') ?? 'нет данных',
    shipmentDateLabel: factValueFromObject(object, 'Дата отгрузки') ?? 'нет данных',
    paymentKindLabel: factValueFromObject(object, 'Вид оплаты') ?? 'unknown',
    installmentLabel: rawInstallmentLabel || 'не началась',
    scheduleLabel: factValueFromObject(object, 'График') ?? 'нет данных',
    dueDateIso,
    dueDateLabel: dueLabel(dueDateIso, rawDueLabel, paymentStatus, todayIso),
    sourceStatus,
    sourceState,
    sourceLabel,
    sourceFreshnessLabel: sourceRaw || sourceLabel,
    ...audit,
  };

  return {
    ...contract,
    searchText: normalizeDisplayText(
      [
        object.statusLabel,
        contract.invoiceLabel,
        contract.paymentLabel,
        contract.installmentLabel,
        contract.sourceLabel,
        contract.sourceFreshnessLabel,
      ].join(' '),
    ),
  };
}

export function hasInternalDisplayToken(text: string) {
  return (
    /\b(?:audit|problem|notification):/.test(text) ||
    text.includes('mock_1C') ||
    text.includes('warehouse_delivery_mock') ||
    text.includes('payment_schedule_mock') ||
    text.includes('source error')
  );
}

export function filterDisplayFacts(facts: Fact[]) {
  return facts.map((fact) => ({
    ...fact,
    value: hasInternalDisplayToken(fact.value) ? 'служебное событие скрыто' : fact.value,
  }));
}
