import type {
  TraceabilityContext,
  TraceabilityDefect,
  TraceabilityLink,
  TraceabilityProblem,
  TraceabilityProductionFact,
  TraceabilityStatus,
  TraceabilityTimelineItem,
} from '@plenka/contracts';

export type TraceabilityWeightRow = {
  id: string;
  operatorRollLineId: string;
  kind: string;
  stable: boolean;
  deviceStatus: string;
  grossKg: number | null;
  spoolKg: number | null;
  netKg: number | null;
  createdAt: Date;
};

export type RawTraceabilityStatus = { kind: string; value: string };
export type RawTraceabilityLink = Omit<TraceabilityLink, 'relationLabel'> & {
  relation: string;
};
export type RawTraceabilityTimelineItem = {
  eventId: string;
  eventType: string;
  label: string | null;
  reason: string | null;
  actorRole: string | null;
  actor?: { displayName: string; role: string } | null;
  occurredAt: string;
};
export type RawTraceabilityProblem = Omit<TraceabilityProblem, 'title' | 'statusLabel'> & {
  type: string;
  status: string;
};
export type RawTraceabilityDefect = Omit<TraceabilityDefect, 'statusLabel'> & {
  status: string;
};
export type RawTraceabilityFact = {
  kind: string;
  value: string | number | boolean | null;
  unit: string | null;
  recordedAt: string;
  source: string;
};
export type RawTraceabilityContext = Omit<
  TraceabilityContext,
  'statuses' | 'links' | 'timeline' | 'problems' | 'defects' | 'productionFacts' | 'warehouseFacts'
> & {
  statuses: RawTraceabilityStatus[];
  links: RawTraceabilityLink[];
  timeline: RawTraceabilityTimelineItem[];
  problems: RawTraceabilityProblem[];
  defects: RawTraceabilityDefect[];
  productionFacts: RawTraceabilityFact[];
  warehouseFacts: RawTraceabilityFact[];
};

const STATUS_TITLES: Readonly<Record<string, string>> = {
  production: 'Производство',
  warehouse_cover: 'Покрытие со склада',
  payment: 'Оплата',
  shipment: 'Отгрузка',
  commercial_stage: 'Этап коммерции',
  dispatch: 'Рулон',
  operator_step: 'Шаг оператора',
  label: 'Этикетка',
  warehouse: 'Склад',
  document: 'Документ',
  document_fields: 'Данные документа',
  format: 'Формат',
  task: 'Задача',
  mode: 'Режим',
  operation: 'Операция',
  kind: 'Тип операции',
  status: 'Статус',
  big_bag: 'Big-Bag',
  registration: 'Регистрация',
  location: 'Местоположение',
  print: 'Печать',
  pallet: 'Палета',
};

const VALUE_LABELS: Readonly<Record<string, string>> = {
  not_started: 'Не начато',
  needs_production: 'Требуется производство',
  in_production: 'В производстве',
  ready: 'Готов',
  needs_approval: 'Требует согласования',
  defect: 'Брак',
  not_checked: 'Не проверено',
  partial_proposed: 'Частичное покрытие предложено',
  full_proposed: 'Полное покрытие предложено',
  partial_confirmed: 'Частично подтверждено',
  full_confirmed: 'Полностью подтверждено',
  recheck_requested: 'Запрошена перепроверка',
  rejected: 'Отклонено',
  unpaid: 'Не оплачено',
  partial: 'Частично оплачено',
  partially_paid: 'Частично оплачено',
  paid: 'Оплачено',
  overdue: 'Просрочено',
  sync_error: 'Ошибка синхронизации',
  not_applicable: 'Не применяется',
  not_shipped: 'Не отгружено',
  partial_shipped: 'Частично отгружено',
  shipped: 'Отгружено',
  shipment_problem: 'Проблема отгрузки',
  draft: 'Черновик',
  incoming: 'Входящий',
  sent_to_finance: 'Передан в бухгалтерию',
  in_work: 'В работе',
  new: 'Новый',
  assigned: 'Назначен',
  in_progress: 'В производстве',
  blocked: 'Заблокирован',
  deferred: 'Отложен',
  ready_for_warehouse: 'Готов к передаче на склад',
  done: 'Завершено',
  cancelled: 'Отменён',
  spool_weight: 'Взвешивание шпули',
  roll_scale_activation: 'Активация весов',
  roll_weight: 'Взвешивание рулона',
  qr_print: 'Печать QR',
  qr_check: 'Проверка QR',
  handover: 'Передача на склад',
  not_printed: 'Не напечатана',
  print_requested: 'Печать запрошена',
  submitted: 'Передана на печать',
  printed: 'Напечатана',
  delivery_unknown: 'Результат печати требует проверки',
  applied: 'Наклеена',
  verified: 'Проверена',
  reprint_requested: 'Перепечать запрошена',
  voided: 'Аннулирован',
  damaged_lookup_required: 'Требуется проверка этикетки',
  not_ready: 'Не готов',
  ready_for_handover: 'Готов к передаче на склад',
  sent: 'Передан на склад',
  received: 'Принят складом',
  sealed: 'Сформирован',
  missing: 'Отсутствует',
  delivered: 'Выдан клиенту',
  expected: 'Ожидается',
  scanned: 'Отсканирован',
  accepted: 'Принят',
  excess: 'Излишек',
  duplicate: 'Дубликат',
  wrong: 'Неверный',
  damaged: 'Повреждён',
  reserved: 'В резерве',
  available: 'Доступен',
  in_use: 'Используется',
  consumed: 'Израсходован',
  pending_scan: 'Ожидает сканирования',
  registered: 'Зарегистрирован',
  warehouse: 'На складе',
  production: 'На производстве',
  queued: 'В очереди',
  uncertain: 'Результат требует проверки',
  failed: 'Ошибка',
  intent_recorded: 'Намерение печати зафиксировано',
  offline: 'Нет связи',
  unstable: 'Нестабильно',
  misconfigured: 'Требует настройки',
  test_failed: 'Тест не пройден',
  waiting: 'Ожидание',
  error: 'Ошибка',
  manual_review: 'Требует проверки',
  retry_requested: 'Повтор запрошен',
  active: 'Активно',
  inactive: 'Неактивно',
  maintenance: 'На обслуживании',
  broken: 'Неисправно',
  online: 'На связи',
  unknown: 'Требует уточнения',
  planned: 'Запланировано',
  open: 'Открыто',
  closed: 'Закрыто',
  locked: 'Зафиксировано',
  breakdown_reassigned: 'Переназначено после поломки',
  completed: 'Завершено',
  succeeded: 'Выполнено',
  resolved: 'Закрыто',
  pdf: 'PDF',
  word: 'Word',
  excel: 'Excel',
  contract_only: 'Контрактный набор',
  receiving: 'Приёмка',
  delivery: 'Выдача',
  reserve: 'Резерв',
  receiving_scan: 'Приёмка по QR',
  reserve_scan: 'Размещение в резерв',
  delivery_scan: 'Выдача по QR',
  production_handover: 'Передан из производства',
  control_weight: 'Контрольное взвешивание',
  mark_damaged: 'Зафиксирован дефект',
  scan: 'Сканирование QR',
};

const RELATION_LABELS: Readonly<Record<string, string>> = {
  belongs_to: 'Относится к',
  contains: 'Содержит',
  produces: 'Производит',
  reserved_for: 'Зарезервирован для',
  reserved_from_stock: 'Выбран из свободного резерва',
  produced_for_stock: 'Произведён в свободный резерв',
  accepted: 'Принят складом',
};

const EVENT_LABELS: Readonly<Record<string, string>> = {
  'audit:operator_roll_accepted': 'Рулон принят оператором',
  'audit:operator_roll_handed_over': 'Передан из производства',
  'audit:operator_roll_reweighed': 'Рулон перевзвешен',
  'audit:operator_roll_step_reopened': 'Шаг рулона открыт повторно',
  'audit:warehouse_roll_received': 'Принят складом',
  'audit:warehouse_roll_shipped': 'Рулон отгружен',
  'audit:warehouse_pallet_opened': 'Палета открыта',
  'audit:warehouse_pallet_sealed': 'Палета сформирована',
  'audit:warehouse_pallet_roll_selected': 'Рулон добавлен в палетный лист',
  'audit:warehouse_pallet_roll_deselected': 'Рулон исключён из палетного листа',
  'audit:warehouse_pallet_voided': 'Палета аннулирована',
  'audit:pallet_list_created': 'Палетный лист сформирован',
  'audit:pallet_list_voided': 'Палетный лист аннулирован',
  'audit:pallet_list_print_requested': 'Печать палетного листа запрошена',
  'audit:pallet_list_print_submitted': 'Палетный лист передан на печать',
  'audit:pallet_list_print_failed': 'Печать палетного листа не выполнена',
  'audit:pallet_list_print_delivery_unknown': 'Результат печати требует проверки',
  'audit:pallet_list_print_reconciled': 'Результат печати подтверждён',
  'audit:pallet_list_reprint_requested': 'Перепечать палетного листа запрошена',
  'audit:pallet_list_exported': 'Палетный лист экспортирован',
  'audit:finished_stock_reserved': 'Рулон зарезервирован для заказа',
  'audit:bigbag_created': 'Big-Bag создан',
  'audit:bigbag_scan_recorded': 'QR Big-Bag проверен',
  'audit:bigbag_weight_recorded': 'Вес Big-Bag зафиксирован',
  'audit:bigbag_registration_confirmed': 'Регистрация Big-Bag подтверждена',
  'audit:bigbag_moved_to_production': 'Big-Bag передан в производство',
  'audit:bigbag_returned_to_warehouse': 'Big-Bag возвращён на склад',
  'audit:bigbag_warehouse_weight_recorded': 'Складской вес Big-Bag зафиксирован',
  'audit:bigbag_label_print_requested': 'Печать этикетки Big-Bag запрошена',
  'audit:bigbag_label_reprint_requested': 'Перепечать этикетки Big-Bag запрошена',
  'audit:bigbag_label_print_submitted': 'Этикетка Big-Bag передана на печать',
  'audit:bigbag_label_print_failed': 'Печать этикетки Big-Bag не выполнена',
  'audit:bigbag_label_print_delivery_unknown': 'Результат печати этикетки требует проверки',
};

const EVENT_FAMILY_LABELS: Readonly<Record<string, string>> = {
  audit: 'Действие аудита',
  problem: 'Проблема',
  notification: 'Уведомление',
  device: 'Событие оборудования',
  admin: 'Административное событие',
  integration: 'Событие интеграции',
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  commercial: 'Коммерция',
  production_lead: 'Зав. производства',
  operator: 'Оператор',
  warehouse: 'Склад',
  finance: 'Бухгалтерия',
  director: 'Директор',
  admin: 'Администратор',
  system: 'Система',
};

const FACT_TITLES: Readonly<Record<string, string>> = {
  dispatch_status: 'Статус рулона',
  warehouse_status: 'Статус на складе',
  coverage_fact_version: 'Версия подтверждения покрытия',
  warehouse_operation: 'Операция склада',
  current_spool_net_weight: 'Текущий принятый вес шпули',
  previous_spool_net_weight: 'Предыдущее измерение шпули',
  current_roll_net_weight: 'Текущий принятый вес рулона',
  previous_roll_net_weight: 'Предыдущее измерение рулона',
  big_bag_material: 'Материал',
  big_bag_batch: 'Партия',
  big_bag_initial_weight: 'Начальный вес',
  big_bag_current_weight: 'Текущий вес',
  big_bag_last_measurement_weight: 'Последнее измерение',
  big_bag_last_warehouse_weight: 'Последний вес склада',
  big_bag_shift_usage: 'Использование в смене',
  big_bag_movement: 'Движение Big-Bag',
  big_bag_print: 'Печать этикетки',
  pallet_formed_at: 'Дата формирования',
  pallet_roll_count: 'Количество рулонов',
  pallet_orders: 'Заказы',
  pallet_customers: 'Заказчики',
  pallet_rolls: 'Рулоны',
  pallet_print: 'Печать',
  pallet_void_reason: 'Аннулирование',
  pallet_document: 'Статус документа',
};

const TEXT_FACT_KINDS = new Set([
  'big_bag_material',
  'big_bag_batch',
  'big_bag_shift_usage',
  'big_bag_movement',
  'pallet_formed_at',
  'pallet_orders',
  'pallet_customers',
  'pallet_rolls',
  'pallet_void_reason',
]);

const PROBLEM_TITLES: Readonly<Record<string, string>> = {
  quality: 'Проверка качества',
  weight_deviation: 'Отклонение веса',
  general: 'Производственная проблема',
  raw_material_shortage: 'Нехватка сырья',
  defect: 'Брак',
  shift_balance_mismatch: 'Расхождение баланса смены',
  machine_breakdown: 'Поломка станка',
};

const safeBusinessEventLabel = (label: string | null): string | null => {
  const value = label?.trim();
  if (!value || value.length > 160 || !/[А-Яа-яЁё]/u.test(value)) return null;
  if (
    /raw|payload|token|hash|secret|password|prisma|sql|gateway|device|adapter|internal|[_:]/iu.test(
      value,
    )
  ) {
    return null;
  }
  return value;
};

const formatNumber = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);

export const projectTraceabilityValueLabel = (value: string): string =>
  VALUE_LABELS[value] ?? 'Статус зафиксирован';

export function projectTraceabilityStatus(kind: string, value: string): TraceabilityStatus {
  const contextualValue =
    value === 'voided' && kind === 'pallet'
      ? 'Аннулирована'
      : value === 'voided' && kind === 'label'
        ? 'Аннулирована'
        : projectTraceabilityValueLabel(value);
  return {
    title: STATUS_TITLES[kind] ?? 'Статус',
    valueLabel: contextualValue,
  };
}

export function projectTraceabilityEvent(
  event: RawTraceabilityTimelineItem,
): TraceabilityTimelineItem {
  const role = event.actor?.role ?? event.actorRole ?? 'system';
  const roleLabel = ROLE_LABELS[role] ?? 'Сотрудник';
  const family = event.eventType.split(':', 1)[0] ?? '';
  return {
    eventId: event.eventId,
    actionLabel:
      EVENT_LABELS[event.eventType] ??
      safeBusinessEventLabel(event.label) ??
      EVENT_FAMILY_LABELS[family] ??
      'Системное событие',
    reason: event.reason,
    actor: {
      displayName: event.actor?.displayName?.trim() || roleLabel,
      roleLabel,
    },
    occurredAt: event.occurredAt,
  };
}

export function projectTraceabilityFact(fact: RawTraceabilityFact): TraceabilityProductionFact {
  const title = FACT_TITLES[fact.kind];
  let projectedValue = 'Нет данных';
  if (!title) projectedValue = fact.value === null ? 'Нет данных' : 'Зафиксировано';
  else if (fact.value !== null) {
    if (typeof fact.value === 'number') {
      projectedValue = `${formatNumber(fact.value)}${fact.unit === 'kg' ? ' кг' : ''}`;
    } else if (typeof fact.value === 'boolean') {
      projectedValue = fact.value ? 'Да' : 'Нет';
    } else if (TEXT_FACT_KINDS.has(fact.kind)) {
      projectedValue = fact.value.trim() || 'Нет данных';
    } else {
      projectedValue = projectTraceabilityValueLabel(fact.value);
    }
  }
  return {
    title: title ?? 'Зафиксированный факт',
    valueLabel: projectedValue,
    recordedAt: fact.recordedAt,
    isCurrent: fact.kind.startsWith('current_')
      ? true
      : fact.kind.startsWith('previous_')
        ? false
        : null,
  };
}

export function projectRawTraceabilityWeightFacts(
  rows: TraceabilityWeightRow[],
): RawTraceabilityFact[] {
  const currentKeys = new Set<string>();
  return [...rows]
    .filter((capture) => capture.stable && capture.deviceStatus === 'ready')
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
    )
    .map((capture) => {
      const ownerKey = `${capture.operatorRollLineId}:${capture.kind}`;
      const state = currentKeys.has(ownerKey) ? 'previous' : 'current';
      currentKeys.add(ownerKey);
      return {
        kind: `${state}_${capture.kind}_net_weight`,
        value: capture.netKg ?? capture.grossKg ?? capture.spoolKg,
        unit: 'kg',
        recordedAt: capture.createdAt.toISOString(),
        source: 'device_scale',
      };
    });
}

export function projectTraceabilityWeightFacts(
  rows: TraceabilityWeightRow[],
): TraceabilityProductionFact[] {
  return projectRawTraceabilityWeightFacts(rows).map(projectTraceabilityFact);
}

export function projectTraceabilityContext(raw: RawTraceabilityContext): TraceabilityContext {
  return {
    objectType: raw.objectType,
    objectId: raw.objectId,
    displayName: raw.displayName,
    statuses: raw.statuses.map(({ kind, value }) => projectTraceabilityStatus(kind, value)),
    links: raw.links.map(({ relation, ...link }) => ({
      ...link,
      relationLabel: RELATION_LABELS[relation] ?? 'Связанный объект',
    })),
    timeline: raw.timeline.map(projectTraceabilityEvent),
    problems: raw.problems.map((problem) => ({
      id: problem.id,
      title: PROBLEM_TITLES[problem.type] ?? 'Производственная проблема',
      statusLabel: projectTraceabilityValueLabel(problem.status),
      reason: problem.reason,
      createdAt: problem.createdAt,
      resolvedAt: problem.resolvedAt,
    })),
    defects: raw.defects.map((defect) => ({
      id: defect.id,
      statusLabel:
        defect.status === 'blocking'
          ? 'Блокирующий'
          : defect.status === 'recorded'
            ? 'Зафиксирован'
            : 'Статус зафиксирован',
      reason: defect.reason,
      weightKg: defect.weightKg,
      recordedAt: defect.recordedAt,
    })),
    productionFacts: raw.productionFacts.map(projectTraceabilityFact),
    warehouseFacts: raw.warehouseFacts.map(projectTraceabilityFact),
  };
}
