import { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectedDirectorAnalyticsView } from '../../../domain/runtime/directorAnalyticsView';
import {
  DirectorAnalyticsSummaryStrip,
  type DirectorAnalyticsTab,
} from './DirectorAnalyticsSummaryStrip';
import { DirectorAnalyticsDetails } from './DirectorAnalyticsDetails';

const summaryView = {
  operatorOverPlan: {
    series: [],
    totals: [
      {
        period: 'week',
        fromDate: '2026-07-18',
        toDate: '2026-07-24',
        affectedRollCount: 2,
        affectedOperatorCount: 1,
        overPlanKg: 5,
      },
      {
        period: 'month',
        fromDate: '2026-06-25',
        toDate: '2026-07-24',
        affectedRollCount: 4,
        affectedOperatorCount: 2,
        overPlanKg: 12.5,
      },
    ],
    topOperators: [],
    missingPlanCount: 1,
    missingActorCount: 1,
  },
  productionQualitySeries: [
    {
      id: 'day:2026-07-24',
      bucketStartDate: '2026-07-24',
      producedRollCount: 7,
      producedKg: 280,
      defectRecordCount: 3,
      defectiveRollCount: 2,
      verifiedDefectKg: 45,
      unverifiedDefectCount: 1,
      returnedSpoolCount: 2,
    },
  ],
  materialSpendSeries: [
    {
      bucketStartDate: '2026-07-24',
      consumedGranulesKg: 275,
      recordedSpoolCount: 6,
      recordedSpoolTareKg: 12,
      missingSpoolEvidenceCount: 1,
    },
  ],
  spoolEvidence: {
    availability: 'measured_evidence_only',
    explanation: 'Измеренное производственное свидетельство.',
  },
  commercialApplications: {
    definition: 'submitted',
    asOfDate: '2026-07-24',
    periods: [
      {
        period: 'week',
        fromDate: '2026-07-18',
        toDate: '2026-07-24',
        totalCount: 4,
        clientOrderCount: 3,
        stockReserveCount: 1,
      },
      {
        period: 'month',
        fromDate: '2026-06-25',
        toDate: '2026-07-24',
        totalCount: 6,
        clientOrderCount: 4,
        stockReserveCount: 2,
      },
      {
        period: '3_months',
        fromDate: '2026-04-24',
        toDate: '2026-07-24',
        totalCount: 8,
        clientOrderCount: 5,
        stockReserveCount: 3,
      },
      {
        period: '6_months',
        fromDate: '2026-01-24',
        toDate: '2026-07-24',
        totalCount: 10,
        clientOrderCount: 6,
        stockReserveCount: 4,
      },
    ],
  },
} satisfies Pick<
  ProjectedDirectorAnalyticsView,
  | 'operatorOverPlan'
  | 'productionQualitySeries'
  | 'materialSpendSeries'
  | 'spoolEvidence'
  | 'commercialApplications'
>;

const detailsView = {
  range: {
    timezone: 'Europe/Moscow' as const,
    requested: { from: '2026-07-18', to: '2026-07-24' },
    effective: {
      fromUtc: '2026-07-17T21:00:00.000Z',
      toExclusiveUtc: '2026-07-24T21:00:00.000Z',
    },
    bucket: 'day' as const,
    generatedAt: '2026-07-24T09:00:00.000Z',
  },
  ...summaryView,
  accountingProduction: {
    source: {
      sourceKind: '1C' as const,
      label: '1С · Отчет производства за смену' as const,
      latestImportedAt: null,
      latestDocumentDate: null,
      stale: true,
    },
    coverage: {
      documentCount: 0,
      excludedOutputLineCount: 0,
      excludedMaterialLineCount: 0,
    },
    productionSeries: [],
    materialSeries: [],
  },
};

describe('DirectorAnalyticsSummaryStrip', () => {
  it('renders all four actionable groups with exact values and visible units', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <DirectorAnalyticsSummaryStrip
          view={summaryView}
          activeTab="overPlan"
          onTabChange={vi.fn()}
        />,
      );
    });

    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain('Перерасход');
    expect(text).toContain('7 дней: 5 кг');
    expect(text).toContain('30 дней: 12,5 кг');
    expect(text).toContain('Производство');
    expect(text).toContain('7 рул.');
    expect(text).toContain('280 кг');
    expect(text).toContain('Брак: 2 рул.');
    expect(text).toContain('Брак, кг: 45 кг');
    expect(text).not.toContain('Шпули возвращены');
    expect(text).toContain('Материалы');
    expect(text).toContain('Гранулы: 275 кг');
    expect(text).toContain('Зафиксировано шпуль (измеренное свидетельство): 6 шт. · 12 кг');
    expect(text).toContain('Без замера шпули: 1 рул.');
    expect(text).toContain('Заявки');
    expect(text).toContain('7 дней: 4 шт.');
    expect(text).toContain('6 месяцев: 10 шт.');
  });

  it('shares live pressed state with the selected detail tab and panel', () => {
    function Harness() {
      const [activeTab, setActiveTab] = useState<DirectorAnalyticsTab>('overPlan');
      return (
        <>
          <DirectorAnalyticsSummaryStrip
            view={summaryView}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
          <DirectorAnalyticsDetails
            activeTab={activeTab}
            onTabChange={setActiveTab}
            view={detailsView}
          />
        </>
      );
    }

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });

    const summary = renderer!.root.findByProps({
      className: 'director-analytics-summary',
    });
    const materials = summary
      .findAllByType('button')
      .find((button) => button.props['data-analytics-tab'] === 'materials');
    act(() => materials?.props.onClick());

    expect(materials?.props['aria-pressed']).toBe(true);
    expect(
      renderer!.root.findByProps({
        role: 'tab',
        'data-analytics-tab': 'materials',
      }).props['aria-selected'],
    ).toBe(true);
    expect(renderer!.root.findByProps({ role: 'tabpanel' }).props.id).toBe(
      'director-analytics-panel-materials',
    );
  });
});
