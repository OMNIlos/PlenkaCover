import type { ProjectedDirectorAnalyticsView } from '../../../domain/runtime/directorAnalyticsView';
import { formatNumber } from './directorAnalyticsFormatters';

export type DirectorAnalyticsTab = 'overPlan' | 'production' | 'materials' | 'applications';

type SummaryView = Pick<
  ProjectedDirectorAnalyticsView,
  | 'operatorOverPlan'
  | 'productionQualitySeries'
  | 'materialSpendSeries'
  | 'spoolEvidence'
  | 'commercialApplications'
>;

type DirectorAnalyticsSummaryStripProps = {
  view: SummaryView;
  activeTab: DirectorAnalyticsTab;
  onTabChange: (tab: DirectorAnalyticsTab) => void;
};

type SummaryGroup = {
  id: DirectorAnalyticsTab;
  label: string;
  metrics: string[];
};

const APPLICATION_LABELS = {
  week: '7 дней',
  month: '30 дней',
  '3_months': '3 месяца',
  '6_months': '6 месяцев',
} as const;

function metric(value: number | undefined, unit: 'кг' | 'рул.' | 'шт.'): string {
  return `${value === undefined ? '—' : formatNumber(value)} ${unit}`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function summaryGroups(view: SummaryView): SummaryGroup[] {
  const week = view.operatorOverPlan.totals.find((total) => total.period === 'week');
  const month = view.operatorOverPlan.totals.find((total) => total.period === 'month');
  const producedRolls = sum(view.productionQualitySeries.map((point) => point.producedRollCount));
  const producedKg = sum(view.productionQualitySeries.map((point) => point.producedKg));
  const defectiveRolls = sum(view.productionQualitySeries.map((point) => point.defectiveRollCount));
  const verifiedDefectKg = sum(view.productionQualitySeries.map((point) => point.verifiedDefectKg));
  const granulesKg = sum(view.materialSpendSeries.map((point) => point.consumedGranulesKg));
  const spoolCount = sum(view.materialSpendSeries.map((point) => point.recordedSpoolCount));
  const spoolTareKg = sum(view.materialSpendSeries.map((point) => point.recordedSpoolTareKg));
  const missingSpoolEvidenceCount = sum(
    view.materialSpendSeries.map((point) => point.missingSpoolEvidenceCount),
  );

  return [
    {
      id: 'overPlan',
      label: 'Перерасход',
      metrics: [
        `7 дней: ${metric(week?.overPlanKg, 'кг')}`,
        `30 дней: ${metric(month?.overPlanKg, 'кг')}`,
      ],
    },
    {
      id: 'production',
      label: 'Производство',
      metrics: [
        `${metric(producedRolls, 'рул.')} · ${metric(producedKg, 'кг')}`,
        `Брак: ${metric(defectiveRolls, 'рул.')}`,
        `Брак, кг: ${metric(verifiedDefectKg, 'кг')}`,
      ],
    },
    {
      id: 'materials',
      label: 'Материалы',
      metrics: [
        `Гранулы: ${metric(granulesKg, 'кг')}`,
        `Зафиксировано шпуль (измеренное свидетельство): ${metric(
          spoolCount,
          'шт.',
        )} · ${metric(spoolTareKg, 'кг')}`,
        `Без замера шпули: ${metric(missingSpoolEvidenceCount, 'рул.')}`,
      ],
    },
    {
      id: 'applications',
      label: 'Заявки',
      metrics: view.commercialApplications.periods.map(
        (period) => `${APPLICATION_LABELS[period.period]}: ${metric(period.totalCount, 'шт.')}`,
      ),
    },
  ];
}

export function DirectorAnalyticsSummaryStrip({
  view,
  activeTab,
  onTabChange,
}: DirectorAnalyticsSummaryStripProps) {
  return (
    <section className="director-analytics-summary" aria-label="Ключевые показатели">
      {summaryGroups(view).map((group) => (
        <button
          key={group.id}
          type="button"
          className="director-analytics-summary-card"
          aria-pressed={activeTab === group.id}
          data-analytics-tab={group.id}
          onClick={() => onTabChange(group.id)}
        >
          <strong>{group.label}</strong>
          {group.metrics.map((value) => (
            <span key={value}>{value}</span>
          ))}
        </button>
      ))}
    </section>
  );
}
