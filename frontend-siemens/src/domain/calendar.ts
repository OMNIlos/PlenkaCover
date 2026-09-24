import { businessClockAt } from './runtime/businessClock';

export const calendarWeekdays = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];

export function baseCalendarMonthKey(now?: Date) {
  return businessClockAt(now).monthKey;
}

const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const monthNamesGenitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function addMonths(monthKey: string, offset: number) {
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthMeta(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  return {
    key: monthKey,
    label: `${monthNames[month - 1]} ${year}`,
    dayLabel: monthNamesGenitive[month - 1],
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    firstWeekday: (first.getUTCDay() + 6) % 7,
  };
}

export function dateDayLabel(dateKey: string) {
  const [, month, day] = dateKey.split('-').map(Number);
  return `${day} ${monthNamesGenitive[month - 1]}`;
}
