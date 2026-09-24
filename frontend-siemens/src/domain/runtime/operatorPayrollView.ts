import { businessClockAt } from './businessClock';
import type { ServerDirectorPayrollUnresolvedReason } from '../../api/directorPayroll';

const DAY_MS = 86_400_000;

function dateKeyFromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function operatorPayrollHeadlineRanges(now = new Date()) {
  const today = businessClockAt(now).dateIso;
  const todayDay = Math.floor(Date.parse(`${today}T00:00:00.000Z`) / DAY_MS);
  return {
    today: { from: today, to: today },
    fortnight: { from: dateKeyFromDay(todayDay - 13), to: today },
  };
}

const operatorPayrollReasonLabels: Record<ServerDirectorPayrollUnresolvedReason, string> = {
  before_policy_effective_date: 'До начала действия тарифа',
  shift_not_closed: 'Смена ещё не закрыта',
  production_operator_unresolved: 'Не определён исполнитель',
  post_session_unresolved: 'Не найдена сессия поста',
  shift_unresolved: 'Не определена смена',
  machine_family_unresolved: 'Не определён станок',
  shift_duration_unresolved: 'Не определена длительность смены',
  material_class_unresolved: 'Не определён тип сырья',
  film_type_unresolved: 'Не определён тип плёнки',
  counterparty_unresolved: 'Не определён контрагент',
};

export function operatorPayrollReasonLabel(reason: ServerDirectorPayrollUnresolvedReason): string {
  return operatorPayrollReasonLabels[reason];
}
