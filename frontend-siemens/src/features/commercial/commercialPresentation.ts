import type {
  CommercialCompletionBlocker,
  CommercialNextActionContract,
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
} from './contracts';

export type CommercialTone = 'neutral' | 'info' | 'warning' | 'critical' | 'success';
type IndicatorGroup = keyof CommercialOrderSummaryContract['indicators'];
type IndicatorValue<Group extends IndicatorGroup> =
  CommercialOrderSummaryContract['indicators'][Group];

const STAGE_LABELS: Record<CommercialOrderDetailContract['commercialStage'], string> = {
  draft: 'Черновик',
  incoming: 'Входящая заявка',
  sent_to_finance: 'Передано в бухгалтерию',
  in_work: 'В работе',
};

const BLOCKER_LABELS: Record<CommercialCompletionBlocker, string> = {
  cover_unresolved: 'Не выбран маршрут покрытия',
  production_incomplete: 'Производство не завершено',
  warehouse_acceptance_incomplete: 'Склад принял не все рулоны',
  warehouse_batch_open: 'Складская операция не закрыта',
  blocking_problem: 'Есть блокирующая проблема',
  facts_unavailable: 'Недостаточно подтверждённых фактов',
};

const OWNER_LABELS: Record<CommercialNextActionContract['ownerRole'], string> = {
  commercial: 'Коммерция',
  production_lead: 'Зав. производства',
  operator: 'Оператор',
  warehouse: 'Склад',
  finance: 'Бухгалтерия',
  director: 'Директор',
  admin: 'Администратор',
};

const INDICATORS: Record<IndicatorGroup, Record<string, { label: string; tone: CommercialTone }>> = {
  production: {
    not_started: { label: 'Не начато', tone: 'neutral' },
    needs_production: { label: 'Нужно производство', tone: 'warning' },
    in_production: { label: 'В производстве', tone: 'info' },
    ready: { label: 'Готово', tone: 'success' },
    needs_approval: { label: 'Нужно согласование', tone: 'warning' },
    defect: { label: 'Проблема', tone: 'critical' },
  },
  warehouseCover: {
    not_checked: { label: 'Не проверено', tone: 'neutral' },
    partial_proposed: { label: 'Предложено частично', tone: 'warning' },
    full_proposed: { label: 'Предложено полностью', tone: 'info' },
    partial_confirmed: { label: 'Частичное покрытие', tone: 'warning' },
    full_confirmed: { label: 'Полное покрытие', tone: 'success' },
    needs_production: { label: 'Нужно производство', tone: 'warning' },
    recheck_requested: { label: 'На перепроверке', tone: 'warning' },
    rejected: { label: 'Отклонено', tone: 'critical' },
  },
  payment: {
    not_applicable: { label: 'Не применяется', tone: 'neutral' },
    unpaid: { label: 'Не оплачено', tone: 'neutral' },
    partial: { label: 'Частично оплачено', tone: 'warning' },
    paid: { label: 'Оплачено', tone: 'success' },
    overdue: { label: 'Просрочено', tone: 'critical' },
    sync_error: { label: 'Источник недоступен', tone: 'critical' },
  },
  shipment: {
    not_applicable: { label: 'Не применяется', tone: 'neutral' },
    not_shipped: { label: 'Не отгружено', tone: 'neutral' },
    partial_shipped: { label: 'Отгружено частично', tone: 'warning' },
    shipped: { label: 'Отгружено', tone: 'success' },
    shipment_problem: { label: 'Проблема отгрузки', tone: 'critical' },
  },
};

export function commercialOwnerLabel(owner: CommercialNextActionContract['ownerRole']) {
  return OWNER_LABELS[owner];
}

export function commercialStageLabel(stage: CommercialOrderDetailContract['commercialStage']) {
  return STAGE_LABELS[stage];
}

export function commercialBlockerLabel(blocker: CommercialCompletionBlocker) {
  return BLOCKER_LABELS[blocker];
}

export function commercialIndicatorPresentation<Group extends IndicatorGroup>(
  group: Group,
  value: IndicatorValue<Group>,
) {
  return INDICATORS[group][value];
}

export function commercialActionPresentation(action: CommercialNextActionContract) {
  return {
    mode:
      action.code.startsWith('wait_') || action.ownerRole !== 'commercial'
        ? ('waiting' as const)
        : action.allowed
          ? ('action' as const)
          : ('disabled' as const),
    owner: commercialOwnerLabel(action.ownerRole),
    label: action.label,
  };
}

export function formatCommercialDateTime(value: string, locale = 'ru-RU', timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatCommercialQueueTime(value: string, now = new Date().toISOString()) {
  const timestamp = new Date(value).getTime();
  const current = new Date(now).getTime();
  if (Number.isNaN(timestamp) || Number.isNaN(current)) return value;
  const minutes = Math.max(0, Math.floor((current - timestamp) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return formatCommercialDateTime(value);
}

export function formatCommercialQuantity(
  value: number | null,
  unit: string | null,
  unavailable: string,
) {
  return value === null || unit === null
    ? unavailable
    : `${value.toLocaleString('ru-RU')} ${unit}`;
}
