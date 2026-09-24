import { useState } from 'react';

import type {
  ServerDirectorAccountingProduction,
  ServerDirectorAnalyticsProductionQualityPoint,
} from '../../../api/director';
import { buildDirectorChartScale } from '../../../domain/runtime/directorAnalyticsPresentation';
import {
  DirectorBarPlot,
  DirectorChartYAxis,
  type DirectorBarPlotGroup,
} from './DirectorAnalyticsChartPrimitives';
import type {
  DirectorAnalyticsDisplayMode,
  DirectorAnalyticsQualityUnit,
} from './DirectorAnalyticsDetails';
import { formatDate, formatKg, formatNumber } from './directorAnalyticsFormatters';

export type ProductionQualityPoint = ServerDirectorAnalyticsProductionQualityPoint;
export type ControlSortKey =
  | 'period'
  | 'producedRollCount'
  | 'producedKg'
  | 'defectiveRollCount'
  | 'verifiedDefectKg';

export type ControlSort = {
  key: ControlSortKey;
  direction: 'asc' | 'desc';
};

export type DirectorProductionPanelProps = {
  series: ProductionQualityPoint[];
  accounting: ServerDirectorAccountingProduction;
  displayMode: DirectorAnalyticsDisplayMode;
  qualityUnit: DirectorAnalyticsQualityUnit;
  sort?: ControlSort | null;
  onSortChange?: (sort: ControlSort | null) => void;
};

const CONTROL_COLUMNS: ReadonlyArray<{
  key: ControlSortKey;
  label: string;
}> = [
  { key: 'period', label: 'Период' },
  { key: 'producedRollCount', label: 'Изготовлено, рул.' },
  { key: 'producedKg', label: 'Изготовлено, кг' },
  { key: 'defectiveRollCount', label: 'Рулонов с браком' },
  { key: 'verifiedDefectKg', label: 'Брак, кг' },
];

function sortValue(point: ProductionQualityPoint, key: ControlSortKey): string | number {
  return key === 'period' ? point.bucketStartDate : point[key];
}

export function sortProductionBuckets(
  rows: readonly ProductionQualityPoint[],
  sort: ControlSort,
): ProductionQualityPoint[] {
  return rows
    .map((point, index) => ({ point, index }))
    .sort((left, right) => {
      const leftValue = sortValue(left.point, sort.key);
      const rightValue = sortValue(right.point, sort.key);
      const primary =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
      if (primary !== 0) return sort.direction === 'asc' ? primary : -primary;

      const period = right.point.bucketStartDate.localeCompare(left.point.bucketStartDate);
      if (period !== 0) return period;
      return left.point.id.localeCompare(right.point.id);
    })
    .map(({ point }) => point);
}

function defaultProductionBuckets(series: readonly ProductionQualityPoint[]) {
  return sortProductionBuckets(series, { key: 'period', direction: 'desc' });
}

function chartProductionBuckets(series: readonly ProductionQualityPoint[]) {
  return sortProductionBuckets(series, { key: 'period', direction: 'asc' });
}

function ProductionQualityChart({
  series,
  qualityUnit,
}: Pick<DirectorProductionPanelProps, 'series' | 'qualityUnit'>) {
  const isKg = qualityUnit === 'kg';
  const buckets = chartProductionBuckets(series);
  const scaleValues = buckets.flatMap((point) =>
    isKg
      ? [point.producedKg, point.verifiedDefectKg]
      : [point.producedRollCount, point.defectiveRollCount],
  );
  const scale = buildDirectorChartScale(scaleValues, isKg ? 'kg' : 'count');
  const groups: DirectorBarPlotGroup[] = buckets.map((point) => ({
    id: point.id,
    label: formatDate(point.bucketStartDate),
    bars: isKg
      ? [
          {
            id: 'produced',
            className: 'is-production',
            label: 'Изготовлено, кг',
            scale,
            unit: 'kg',
            value: point.producedKg,
            valueKind: 'kg',
          },
          {
            id: 'defect',
            className: 'is-defect is-defect-pattern',
            label: 'Брак, кг',
            scale,
            unit: 'kg',
            value: point.verifiedDefectKg,
            valueKind: 'kg',
          },
        ]
      : [
          {
            id: 'produced-rolls',
            className: 'is-production-rolls',
            label: 'Изготовлено, рул.',
            scale,
            unit: 'count',
            value: point.producedRollCount,
            valueKind: 'rolls',
          },
          {
            id: 'defective-rolls',
            className: 'is-defect is-defect-pattern',
            label: 'Рулонов с браком',
            scale,
            unit: 'count',
            value: point.defectiveRollCount,
            valueKind: 'rolls',
          },
        ],
  }));

  return (
    <figure className="director-analytics-figure">
      <figcaption>
        {isKg ? 'Изготовлено и брак, кг' : 'Изготовлено и рулоны с браком, шт.'}
      </figcaption>
      <div className="director-analytics-chart-frame">
        <DirectorChartYAxis
          label={isKg ? 'Ось веса производства, кг' : 'Ось количества рулонов, шт.'}
          scale={scale}
          unit={isKg ? 'kg' : 'count'}
          side="left"
        />
        <DirectorBarPlot
          annotationMode="all"
          ariaLabel={
            isKg
              ? 'График изготовленного веса и брака'
              : 'График изготовленных рулонов и рулонов с браком'
          }
          groups={groups}
          variant="comparison"
        />
      </div>
      <div className="director-analytics-legend" aria-label="Обозначения качества производства">
        <span>
          <i className={isKg ? 'is-production' : 'is-production-rolls'} />
          {isKg ? 'Изготовлено, кг' : 'Изготовлено, рул.'}
        </span>
        <span>
          <i className="is-defect is-defect-pattern" />
          {isKg ? 'Брак, кг' : 'Рулонов с браком'}
        </span>
        <small>Брак обозначен штриховкой и подписью, а не только цветом.</small>
      </div>
    </figure>
  );
}

function nextSort(current: ControlSort | null, key: ControlSortKey): ControlSort | null {
  if (current?.key !== key) return { key, direction: 'desc' };
  if (current.direction === 'desc') return { key, direction: 'asc' };
  return null;
}

function ariaSort(
  current: ControlSort | null,
  key: ControlSortKey,
): 'none' | 'ascending' | 'descending' {
  if (current?.key !== key) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

function ProductionQualityTable({
  series,
  sort,
  onSortChange,
}: Pick<DirectorProductionPanelProps, 'series'> & {
  sort: ControlSort | null;
  onSortChange: (sort: ControlSort | null) => void;
}) {
  const buckets = sort ? sortProductionBuckets(series, sort) : defaultProductionBuckets(series);

  return (
    <div className="director-analytics-table-scroll">
      <table className="director-analytics-table">
        <caption>Точные данные производства и брака</caption>
        <thead>
          <tr>
            {CONTROL_COLUMNS.map((column) => (
              <th key={column.key} scope="col" aria-sort={ariaSort(sort, column.key)}>
                <button
                  type="button"
                  className="director-analytics-sort-button"
                  onClick={() => onSortChange(nextSort(sort, column.key))}
                >
                  {column.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((point) => (
            <tr key={point.id} data-control-period-id={point.id}>
              <th scope="row">{formatDate(point.bucketStartDate)}</th>
              <td>{formatNumber(point.producedRollCount)}</td>
              <td>{formatKg(point.producedKg)}</td>
              <td>{formatNumber(point.defectiveRollCount)}</td>
              <td>{formatKg(point.verifiedDefectKg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DirectorProductionPanel({
  series,
  displayMode,
  qualityUnit,
  sort: controlledSort,
  onSortChange,
}: DirectorProductionPanelProps) {
  const [localSort, setLocalSort] = useState<ControlSort | null>(null);
  const sort = controlledSort === undefined ? localSort : controlledSort;
  const setSort = onSortChange ?? setLocalSort;

  return (
    <section className="director-production-quality-panel" aria-label="Производство и брак">
      {displayMode === 'chart' ? (
        <ProductionQualityChart series={series} qualityUnit={qualityUnit} />
      ) : (
        <ProductionQualityTable series={series} sort={sort} onSortChange={setSort} />
      )}
    </section>
  );
}
