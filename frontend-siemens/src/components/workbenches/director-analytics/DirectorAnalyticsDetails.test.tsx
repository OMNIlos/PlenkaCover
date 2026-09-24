import { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { DirectorAnalyticsDetails, type DirectorAnalyticsTab } from './DirectorAnalyticsDetails';

const applications = {
  definition: 'submitted' as const,
  asOfDate: '2026-07-24',
  periods: [
    {
      period: 'week' as const,
      fromDate: '2026-07-18',
      toDate: '2026-07-24',
      totalCount: 4,
      clientOrderCount: 3,
      stockReserveCount: 1,
    },
  ],
};

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
  operatorOverPlan: {
    series: [],
    totals: [],
    topOperators: [],
    missingPlanCount: 0,
    missingActorCount: 0,
  },
  productionQualitySeries: [],
  materialSpendSeries: [],
  spoolEvidence: {
    availability: 'measured_evidence_only' as const,
    explanation: 'Измеренное производственное свидетельство.',
  },
  commercialApplications: applications,
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

function renderDetails(activeTab: DirectorAnalyticsTab = 'overPlan') {
  const onTabChange = vi.fn<(tab: DirectorAnalyticsTab) => void>();
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorAnalyticsDetails
        activeTab={activeTab}
        onTabChange={onTabChange}
        view={detailsView}
      />,
    );
  });
  return { renderer: renderer!, onTabChange };
}

describe('DirectorAnalyticsDetails', () => {
  it('uses semantic tabs and selects over-plan by default', () => {
    const { renderer, onTabChange } = renderDetails();
    const tablist = renderer.root.findByProps({
      role: 'tablist',
      'aria-label': 'Раздел производственной аналитики',
    });
    const tabs = tablist.findAllByProps({ role: 'tab' });
    expect(tabs).toHaveLength(4);
    expect(tabs.find((tab) => tab.props['aria-selected'] === true)?.props.children).toBe(
      'Перерасход',
    );
    expect(renderer.root.findByProps({ role: 'tabpanel' }).props.id).toBe(
      'director-analytics-panel-overPlan',
    );

    const materials = tabs.find((tab) => tab.props['data-analytics-tab'] === 'materials');
    act(() => materials?.props.onClick());
    expect(onTabChange).toHaveBeenCalledWith('materials');
  });

  it('keeps independent chart/table and production unit choices while switching tabs', () => {
    function Harness() {
      const [activeTab, setActiveTab] = useState<DirectorAnalyticsTab>('production');
      return (
        <DirectorAnalyticsDetails
          activeTab={activeTab}
          onTabChange={setActiveTab}
          view={detailsView}
        />
      );
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Harness />);
    });
    const exact = renderer.root.findByProps({ 'data-display-mode': 'table' });
    act(() => exact.props.onClick());
    const count = renderer.root.findByProps({ 'data-quality-unit': 'count' });
    act(() => count.props.onClick());

    act(() =>
      renderer.root.findByProps({ role: 'tab', 'data-analytics-tab': 'materials' }).props.onClick(),
    );
    expect(renderer.root.findByProps({ 'data-display-mode': 'chart' }).props['aria-pressed']).toBe(
      true,
    );
    act(() => renderer.root.findByProps({ 'data-display-mode': 'table' }).props.onClick());
    act(() =>
      renderer.root
        .findByProps({ role: 'tab', 'data-analytics-tab': 'production' })
        .props.onClick(),
    );
    expect(renderer.root.findByProps({ 'data-display-mode': 'table' }).props['aria-pressed']).toBe(
      true,
    );
    expect(renderer.root.findByProps({ 'data-quality-unit': 'count' }).props['aria-pressed']).toBe(
      true,
    );
    act(() =>
      renderer.root.findByProps({ role: 'tab', 'data-analytics-tab': 'materials' }).props.onClick(),
    );
    expect(renderer.root.findByProps({ 'data-display-mode': 'table' }).props['aria-pressed']).toBe(
      true,
    );
  });

  it('does not expose a misleading graph toggle for cumulative application windows', () => {
    const { renderer } = renderDetails('applications');
    expect(renderer.root.findAllByProps({ 'data-display-mode': 'chart' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-display-mode': 'table' })).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('7 дней');
    expect(renderer.root.findByType('b').children.join('')).toBe('4 шт.');
  });
});
