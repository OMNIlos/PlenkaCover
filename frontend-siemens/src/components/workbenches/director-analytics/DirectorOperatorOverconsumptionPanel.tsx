import type {
  ServerDirectorAnalyticsOperatorOverPlan,
  ServerDirectorOperatorRollVariance,
} from '../../../api/director';
import { buildDirectorChartScale } from '../../../domain/runtime/directorAnalyticsPresentation';
import {
  DirectorBarPlot,
  DirectorChartYAxis,
  type DirectorBarPlotGroup,
} from './DirectorAnalyticsChartPrimitives';
import { formatDate, formatKg, formatNumber, formatTimestamp } from './directorAnalyticsFormatters';
import {
  useDirectorOperatorRollVariances,
  type DirectorOperatorRollVariancesResult,
} from './useDirectorOperatorRollVariances';

type DirectorOperatorOverconsumptionPanelProps = {
  aggregate: ServerDirectorAnalyticsOperatorOverPlan;
  range: { from: string; to: string };
  displayMode: 'chart' | 'table';
};

const PERIOD_LABELS = {
  week: '7 дней',
  month: '30 дней',
} as const;

function AggregateView({ aggregate }: { aggregate: ServerDirectorAnalyticsOperatorOverPlan }) {
  const scale = buildDirectorChartScale(
    aggregate.series.map((point) => point.overPlanKg),
    'kg',
  );
  const groups: DirectorBarPlotGroup[] = aggregate.series.map((point) => ({
    id: point.bucketStartDate,
    label: formatDate(point.bucketStartDate),
    bars: [
      {
        id: 'over-plan',
        className: 'is-over-plan',
        label: 'Перерасход',
        scale,
        unit: 'kg',
        value: point.overPlanKg,
        valueKind: 'kg',
      },
    ],
  }));

  return (
    <div className="director-operator-overconsumption-aggregate">
      <section className="director-analytics-fixed-totals" aria-label="Итоги перерасхода">
        {aggregate.totals.map((total) => (
          <article key={total.period}>
            <strong>{PERIOD_LABELS[total.period]}</strong>
            <b>{formatKg(total.overPlanKg)}</b>
            <span>
              {formatNumber(total.affectedRollCount)} рул. ·{' '}
              {formatNumber(total.affectedOperatorCount)} опер.
            </span>
          </article>
        ))}
        <small>Только положительное превышение плана</small>
      </section>

      <section className="director-analytics-chart-frame" aria-label="Динамика перерасхода">
        <DirectorChartYAxis label="Ось перерасхода, кг" scale={scale} unit="kg" side="left" />
        <DirectorBarPlot ariaLabel="График перерасхода по рулонам" groups={groups} />
      </section>

      <section className="director-analytics-top-operators" aria-label="Операторы с перерасходом">
        <h3>Операторы с перерасходом</h3>
        {aggregate.topOperators.length === 0 ? (
          <p>За выбранный период перерасхода по операторам нет.</p>
        ) : (
          <ol>
            {aggregate.topOperators.map((operator) => (
              <li key={operator.operatorId}>
                <strong>{operator.operatorName}</strong>
                <span>{formatNumber(operator.affectedRollCount)} рул.</span>
                <b>{formatKg(operator.overPlanKg)}</b>
              </li>
            ))}
          </ol>
        )}
      </section>

      <aside className="director-analytics-partial-data" aria-label="Неполные данные">
        <strong>Неполные данные</strong>
        <span>План не зафиксирован: {formatNumber(aggregate.missingPlanCount)} рул.</span>
        <span>Исполнитель не определён: {formatNumber(aggregate.missingActorCount)} рул.</span>
      </aside>
    </div>
  );
}

function planLabel(row: ServerDirectorOperatorRollVariance): string {
  return row.plannedKg === null ? 'План не зафиксирован' : formatKg(row.plannedKg);
}

function producerLabel(row: ServerDirectorOperatorRollVariance): string {
  return row.operatorName ?? 'Исполнитель не определён';
}

function ExactRows({ rows }: { rows: ServerDirectorOperatorRollVariance[] }) {
  return (
    <div className="director-analytics-table-scroll">
      <table className="director-operator-variance-table">
        <caption>История веса по каждому рулону</caption>
        <thead>
          <tr>
            <th scope="col">Заказ</th>
            <th scope="col">Рулон</th>
            <th scope="col">План</th>
            <th scope="col">Факт</th>
            <th scope="col">Отклонение</th>
            <th scope="col">Перерасход</th>
            <th scope="col">Исполнитель</th>
            <th scope="col">Произведён</th>
            <th scope="col">Замер веса</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rollId} data-provenance={row.provenance}>
              <td>{row.orderNumber}</td>
              <td>{row.rollCode}</td>
              <td>{planLabel(row)}</td>
              <td>{formatKg(row.actualKg)}</td>
              <td>{formatKg(row.varianceKg)}</td>
              <td>{formatKg(row.overPlanKg)}</td>
              <td>{producerLabel(row)}</td>
              <td>{formatTimestamp(row.producedAt)}</td>
              <td>{formatTimestamp(row.actualCapturedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExactView({ result }: { result: DirectorOperatorRollVariancesResult }) {
  if (result.status === 'idle' || result.status === 'loading') {
    return <p role="status">Загружаем точные данные…</p>;
  }

  if (result.status === 'error') {
    return (
      <div role="alert" className="director-analytics-load-error">
        <strong>Не удалось загрузить точные данные</strong>
        <span>{result.error}</span>
        <button type="button" onClick={result.retry}>
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="director-operator-overconsumption-exact">
      {result.page.items.length === 0 ? (
        <p>В выбранном периоде рулонов нет.</p>
      ) : (
        <ExactRows rows={result.page.items} />
      )}
      <nav className="director-analytics-pagination" aria-label="Страницы истории рулонов">
        <button type="button" disabled={!result.canBack} onClick={result.back}>
          Назад
        </button>
        <span>Стр. {formatNumber(result.pageNumber)}</span>
        <button type="button" disabled={!result.canNext} onClick={result.next}>
          Вперёд
        </button>
      </nav>
    </div>
  );
}

export function DirectorOperatorOverconsumptionPanel({
  aggregate,
  range,
  displayMode,
}: DirectorOperatorOverconsumptionPanelProps) {
  const result = useDirectorOperatorRollVariances({
    enabled: displayMode === 'table',
    range,
  });

  return (
    <section className="director-operator-overconsumption-panel" aria-label="Перерасход операторов">
      {displayMode === 'chart' ? (
        <AggregateView aggregate={aggregate} />
      ) : (
        <ExactView result={result} />
      )}
    </section>
  );
}
