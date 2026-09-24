import { businessClockAt } from './businessClock';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

export type DirectorPayrollPreset =
  | 'current_month'
  | 'previous_month'
  | 'current_week'
  | 'custom';

export type DirectorPayrollRange = {
  preset: DirectorPayrollPreset;
  from: string;
  to: string;
};

function parseDateKey(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new RangeError('Date must be a real YYYY-MM-DD value.');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9998) {
    throw new RangeError('Date year must be between 0001 and 9998.');
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError('Date must be a real YYYY-MM-DD value.');
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function dateKeyFromDay(day: number): string {
  const date = new Date(day * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dateOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${dateOfMonth}`;
}

function customDirectorPayrollRange(
  custom: Pick<DirectorPayrollRange, 'from' | 'to'> | undefined,
): DirectorPayrollRange {
  if (!custom) throw new RangeError('Custom payroll range requires from and to dates.');

  const fromDay = parseDateKey(custom.from);
  const toDay = parseDateKey(custom.to);
  if (fromDay > toDay) throw new RangeError('Payroll range from date must not be after to date.');
  if (toDay - fromDay + 1 > MAX_RANGE_DAYS) {
    throw new RangeError('Payroll range must not exceed 366 days.');
  }
  return { preset: 'custom', from: dateKeyFromDay(fromDay), to: dateKeyFromDay(toDay) };
}

export function createDirectorPayrollRange(
  preset: DirectorPayrollPreset,
  now = new Date(),
  custom?: Pick<DirectorPayrollRange, 'from' | 'to'>,
): DirectorPayrollRange {
  if (preset === 'custom') return customDirectorPayrollRange(custom);

  const todayKey = businessClockAt(now).dateIso;
  const today = parseDateKey(todayKey);
  if (preset === 'current_week') {
    const mondayOffset = (new Date(today * DAY_MS).getUTCDay() + 6) % 7;
    return { preset, from: dateKeyFromDay(today - mondayOffset), to: todayKey };
  }
  if (preset === 'current_month') {
    return { preset, from: `${todayKey.slice(0, 8)}01`, to: todayKey };
  }

  const firstDayOfCurrentMonth = parseDateKey(`${todayKey.slice(0, 8)}01`);
  const previousMonthLastDay = firstDayOfCurrentMonth - 1;
  const previousMonthStart = `${dateKeyFromDay(previousMonthLastDay).slice(0, 8)}01`;
  return { preset, from: previousMonthStart, to: dateKeyFromDay(previousMonthLastDay) };
}
