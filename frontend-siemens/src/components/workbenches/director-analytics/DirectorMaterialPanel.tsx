import type {
  ServerDirectorAccountingProduction,
  ServerDirectorAnalyticsMaterialSpendPoint,
  ServerDirectorAnalyticsSpoolEvidence,
} from '../../../api/director';
import { buildDirectorChartScale } from '../../../domain/runtime/directorAnalyticsPresentation';
import {
  DirectorBarPlot,
  DirectorChartYAxis,
  type DirectorBarPlotGroup,
} from './DirectorAnalyticsChartPrimitives';
import type { DirectorAnalyticsDisplayMode } from './DirectorAnalyticsDetails';
import { buildDirectorMaterialComparisonRows } from './directorAnalyticsComparisonBuckets';
import { formatDate, formatKg, formatNumber } from './directorAnalyticsFormatters';

type DirectorMaterialPanelProps = {
  series: ServerDirectorAnalyticsMaterialSpendPoint[];
  accounting: ServerDirectorAccountingProduction;
  spoolEvidence: ServerDirectorAnalyticsSpoolEvidence;
  displayMode: DirectorAnalyticsDisplayMode;
};

function totals(series: ServerDirectorAnalyticsMaterialSpendPoint[]) {
  return series.reduce(
    (result, point) => ({
      recordedSpoolCount: result.recordedSpoolCount + point.recordedSpoolCount,
      recordedSpoolTareKg: result.recordedSpoolTareKg + point.recordedSpoolTareKg,
      missingSpoolEvidenceCount: result.missingSpoolEvidenceCount + point.missingSpoolEvidenceCount,
    }),
    {
      recordedSpoolCount: 0,
      recordedSpoolTareKg: 0,
      missingSpoolEvidenceCount: 0,
    },
  );
}

function GranuleChart({
  series,
  accounting,
}: Pick<DirectorMaterialPanelProps, 'series' | 'accounting'>) {
  const buckets = buildDirectorMaterialComparisonRows(series, accounting.materialSeries);
  const scaleValues: number[] = [];
  for (const bucket of buckets) {
    scaleValues.push(bucket.physical.consumedGranulesKg, bucket.accounting.consumedKg);
  }
  const scale = buildDirectorChartScale(scaleValues, 'kg');
  const groups: DirectorBarPlotGroup[] = buckets.map((bucket) => ({
    id: bucket.bucketStartDate,
    label: formatDate(bucket.bucketStartDate),
    bars: [
      {
        id: 'granules',
        className: 'is-granules',
        label: 'Расход BigBag',
        scale,
        unit: 'kg',
        value: bucket.physical.consumedGranulesKg,
        valueKind: 'kg',
      },
      {
        id: 'onec-materials',
        className: 'is-onec',
        label: 'Бухгалтерское списание',
        scale,
        unit: 'kg',
        value: bucket.accounting.consumedKg,
        valueKind: 'kg',
      },
    ],
  }));

  return (
    <figure className="director-analytics-figure">
      <figcaption>Расход материала: BigBag и бухгалтерский учёт</figcaption>
      <div className="director-analytics-chart-frame">
        <DirectorChartYAxis
          label="Ось расхода материалов, кг"
          scale={scale}
          unit="kg"
          side="left"
        />
        <DirectorBarPlot
          ariaLabel="Сравнение расхода BigBag и бухгалтерского списания материалов"
          groups={groups}
          variant="comparison"
        />
      </div>
      <div className="director-analytics-legend" aria-label="Обозначения расхода материалов">
        <span>
          <i className="is-granules" />
          Расход BigBag
        </span>
        <span>
          <i className="is-onec" />
          Бухгалтерское списание
        </span>
        <small>Отрицательная корректировка сохраняет знак и показана штриховкой.</small>
      </div>
    </figure>
  );
}

function MaterialTable({
  series,
  accounting,
}: Pick<DirectorMaterialPanelProps, 'series' | 'accounting'>) {
  const buckets = buildDirectorMaterialComparisonRows(series, accounting.materialSeries);

  return (
    <div className="director-analytics-table-scroll">
      <table className="director-analytics-table">
        <caption>Точные производственные свидетельства расхода</caption>
        <thead>
          <tr>
            <th scope="col">Период</th>
            <th scope="col">Расход BigBag, кг</th>
            <th scope="col" data-column-id="onec-consumed-kg">
              Бухгалтерское списание, кг
            </th>
            <th scope="col">Зафиксировано шпуль</th>
            <th scope="col">Измеренная тара, кг</th>
            <th scope="col">Без замера шпули</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={bucket.bucketStartDate}>
              <th scope="row">{formatDate(bucket.bucketStartDate)}</th>
              <td className={bucket.physical.consumedGranulesKg < 0 ? 'is-negative' : undefined}>
                {formatKg(bucket.physical.consumedGranulesKg)}
              </td>
              <td data-column-id="onec-consumed-kg">{formatKg(bucket.accounting.consumedKg)}</td>
              <td>{formatNumber(bucket.physical.recordedSpoolCount)}</td>
              <td>{formatKg(bucket.physical.recordedSpoolTareKg)}</td>
              <td>{formatNumber(bucket.physical.missingSpoolEvidenceCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DirectorMaterialPanel({
  series,
  accounting,
  spoolEvidence,
  displayMode,
}: DirectorMaterialPanelProps) {
  const evidenceTotals = totals(series);

  return (
    <section className="director-material-spend-panel" aria-label="Материалы">
      {displayMode === 'chart' ? (
        <GranuleChart series={series} accounting={accounting} />
      ) : (
        <MaterialTable series={series} accounting={accounting} />
      )}
      <aside
        className="director-analytics-spool-evidence"
        aria-label="Производственные свидетельства по шпулям"
        data-evidence-availability={spoolEvidence.availability}
      >
        <strong>Учёт шпуль</strong>
        <p>Тара шпуль учитывается по измерениям изготовленных рулонов.</p>
        <span>Зафиксировано шпуль: {formatNumber(evidenceTotals.recordedSpoolCount)}</span>
        <span>Измеренная тара: {formatKg(evidenceTotals.recordedSpoolTareKg)}</span>
        <span>Без замера шпули: {formatNumber(evidenceTotals.missingSpoolEvidenceCount)}</span>
        <small>{spoolEvidence.explanation}</small>
      </aside>
    </section>
  );
}
