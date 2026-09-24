import { useState } from 'react';

import type { ProjectedDirectorAnalyticsView } from '../../../domain/runtime/directorAnalyticsView';
import { DirectorMaterialPanel } from './DirectorMaterialPanel';
import { DirectorOperatorOverconsumptionPanel } from './DirectorOperatorOverconsumptionPanel';
import { DirectorProductionPanel } from './DirectorProductionPanel';
import { DirectorRequestVolumePanel } from './DirectorRequestVolumePanel';
import type { DirectorAnalyticsTab } from './DirectorAnalyticsSummaryStrip';

export type { DirectorAnalyticsTab } from './DirectorAnalyticsSummaryStrip';

export type DirectorAnalyticsDisplayMode = 'chart' | 'table';
export type DirectorAnalyticsQualityUnit = 'kg' | 'count';

type DirectorAnalyticsDetailsProps = {
  activeTab: DirectorAnalyticsTab;
  onTabChange: (tab: DirectorAnalyticsTab) => void;
  view: Pick<
    ProjectedDirectorAnalyticsView,
    | 'range'
    | 'operatorOverPlan'
    | 'productionQualitySeries'
    | 'materialSpendSeries'
    | 'spoolEvidence'
    | 'commercialApplications'
    | 'accountingProduction'
  >;
};

const TABS: Array<{ id: DirectorAnalyticsTab; label: string }> = [
  { id: 'overPlan', label: 'Перерасход' },
  { id: 'production', label: 'Производство' },
  { id: 'materials', label: 'Материалы' },
  { id: 'applications', label: 'Заявки' },
];

type ModeTab = Exclude<DirectorAnalyticsTab, 'applications'>;

function ModeButtons({
  value,
  onChange,
}: {
  value: DirectorAnalyticsDisplayMode;
  onChange: (mode: DirectorAnalyticsDisplayMode) => void;
}) {
  return (
    <div className="director-analytics-mode-switch" role="group" aria-label="Вид данных">
      <button
        type="button"
        data-display-mode="chart"
        aria-pressed={value === 'chart'}
        onClick={() => onChange('chart')}
      >
        График
      </button>
      <button
        type="button"
        data-display-mode="table"
        aria-pressed={value === 'table'}
        onClick={() => onChange('table')}
      >
        Точные данные
      </button>
    </div>
  );
}

export function DirectorAnalyticsDetails({
  activeTab,
  onTabChange,
  view,
}: DirectorAnalyticsDetailsProps) {
  const [displayModes, setDisplayModes] = useState<Record<ModeTab, DirectorAnalyticsDisplayMode>>({
    overPlan: 'chart',
    production: 'chart',
    materials: 'chart',
  });
  const [qualityUnit, setQualityUnit] = useState<DirectorAnalyticsQualityUnit>('kg');
  const mode = activeTab === 'applications' ? null : displayModes[activeTab];

  const setMode = (nextMode: DirectorAnalyticsDisplayMode) => {
    if (activeTab === 'applications') return;
    setDisplayModes((current) => ({ ...current, [activeTab]: nextMode }));
  };

  return (
    <section className="director-analytics-details" aria-label="Детали аналитики">
      <div role="tablist" aria-label="Раздел производственной аналитики">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`director-analytics-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`director-analytics-panel-${tab.id}`}
            data-analytics-tab={tab.id}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        role="tabpanel"
        id={`director-analytics-panel-${activeTab}`}
        aria-labelledby={`director-analytics-tab-${activeTab}`}
      >
        {mode === null ? (
          <DirectorRequestVolumePanel applications={view.commercialApplications} />
        ) : (
          <>
            <ModeButtons value={mode} onChange={setMode} />
            {activeTab === 'production' ? (
              <div
                className="director-analytics-quality-unit"
                role="group"
                aria-label="Единица качества"
              >
                <button
                  type="button"
                  data-quality-unit="kg"
                  aria-pressed={qualityUnit === 'kg'}
                  onClick={() => setQualityUnit('kg')}
                >
                  кг
                </button>
                <button
                  type="button"
                  data-quality-unit="count"
                  aria-pressed={qualityUnit === 'count'}
                  onClick={() => setQualityUnit('count')}
                >
                  шт.
                </button>
              </div>
            ) : null}
            <div className="director-analytics-detail-slot" data-detail-tab={activeTab}>
              {activeTab === 'overPlan' ? (
                <DirectorOperatorOverconsumptionPanel
                  aggregate={view.operatorOverPlan}
                  range={view.range.requested}
                  displayMode={displayModes.overPlan}
                />
              ) : activeTab === 'production' ? (
                <DirectorProductionPanel
                  series={view.productionQualitySeries}
                  accounting={view.accountingProduction}
                  displayMode={displayModes.production}
                  qualityUnit={qualityUnit}
                />
              ) : (
                <DirectorMaterialPanel
                  series={view.materialSpendSeries}
                  accounting={view.accountingProduction}
                  spoolEvidence={view.spoolEvidence}
                  displayMode={displayModes.materials}
                />
              )}
            </div>
          </>
        )}
      </section>
    </section>
  );
}
