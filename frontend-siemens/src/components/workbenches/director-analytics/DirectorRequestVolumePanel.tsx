import type { ServerDirectorCommercialApplications } from '../../../api/director';
import { formatDate, formatNumber } from './directorAnalyticsFormatters';

type DirectorRequestVolumePanelProps = {
  applications: ServerDirectorCommercialApplications;
};

const PERIOD_LABELS = {
  week: '7 дней',
  month: '30 дней',
  '3_months': '3 месяца',
  '6_months': '6 месяцев',
} as const;

export function DirectorRequestVolumePanel({ applications }: DirectorRequestVolumePanelProps) {
  return (
    <section className="director-request-volume-panel" aria-label="Количество поданных заявок">
      <header>
        <strong>Поданные заявки</strong>
        <span>По состоянию на {formatDate(applications.asOfDate)}</span>
      </header>
      <div className="director-analytics-application-windows">
        {applications.periods.map((period) => (
          <article key={period.period} data-application-period={period.period}>
            <strong>{PERIOD_LABELS[period.period]}</strong>
            <b>{formatNumber(period.totalCount)} шт.</b>
            <span>
              Клиентские: {formatNumber(period.clientOrderCount)} шт. · Резерв:{' '}
              {formatNumber(period.stockReserveCount)} шт.
            </span>
            <small>
              {formatDate(period.fromDate)} — {formatDate(period.toDate)}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}
