export const BUSINESS_TIME_ZONE = 'Europe/Moscow' as const;

export type BusinessClockSnapshot = Readonly<{
  timeZone: typeof BUSINESS_TIME_ZONE;
  dateIso: string;
  monthKey: string;
  dateLabel: string;
}>;

const businessDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessClockAt(now = new Date()): BusinessClockSnapshot {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Business clock requires a valid date.');

  const parts = businessDateFormatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Business clock date is unavailable.');

  return {
    timeZone: BUSINESS_TIME_ZONE,
    dateIso: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
    dateLabel: `${day}.${month}.${year}`,
  };
}
