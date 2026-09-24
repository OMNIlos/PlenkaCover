import type {
  ServerDirectorAnalyticsShiftPayroll,
  ServerDirectorPayrollTariffRule,
  ServerDirectorPayrollUnresolvedReason,
} from '../../../api/director';

const NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value).replace(/^-/, '−');
}

export function formatKg(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value)} кг`;
}

export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${formatNumber(value)} %`;
}

const RUBLE_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Money is stored in kopecks; render it as rubles without ever losing a kopeck. */
export function formatRubles(kopecks: number | null): string {
  if (kopecks === null || !Number.isFinite(kopecks)) return '—';
  return `${RUBLE_FORMAT.format(kopecks / 100).replace(/^-/, '−')} ₽`;
}

export function formatRublesPerKg(kopecks: number | null): string {
  if (kopecks === null || !Number.isFinite(kopecks)) return '—';
  return `${RUBLE_FORMAT.format(kopecks / 100).replace(/^-/, '−')} ₽/кг`;
}

const payrollTariffRuleLabels: Record<ServerDirectorPayrollTariffRule, string> = {
  primary: 'Первичное сырьё',
  secondary: 'Вторичное сырьё',
  thin_roll: 'Тонкий рулон',
  abc_standard: 'АВС · стандарт',
  abc_black_white: 'АВС · фальц',
  alabuga_override: 'Алабуга',
};

const payrollUnresolvedReasonLabels: Record<ServerDirectorPayrollUnresolvedReason, string> = {
  before_policy_effective_date: 'До вступления приказа в силу',
  shift_not_closed: 'Смена не закрыта',
  production_operator_unresolved: 'Оператор не определён',
  post_session_unresolved: 'Сессия поста не определена',
  shift_unresolved: 'Смена не определена',
  machine_family_unresolved: 'Семейство станка не определено',
  shift_duration_unresolved: 'Длительность смены не определена',
  material_class_unresolved: 'Сырьё не определено',
  film_type_unresolved: 'Тип плёнки не определён',
  counterparty_unresolved: 'Контрагент не определён',
};

export function formatPayrollTariffRule(rule: ServerDirectorPayrollTariffRule): string {
  return payrollTariffRuleLabels[rule];
}

export function formatPayrollUnresolvedReasons(
  payroll: Extract<ServerDirectorAnalyticsShiftPayroll, { status: 'unresolved' }>,
): string {
  return payroll.reasons.map((reason) => payrollUnresolvedReasonLabels[reason]).join(' · ');
}

export function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  return year && month && day ? `${day}.${month}.${year}` : value;
}

export function formatTimestamp(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_TIME_FORMAT.format(date);
}
