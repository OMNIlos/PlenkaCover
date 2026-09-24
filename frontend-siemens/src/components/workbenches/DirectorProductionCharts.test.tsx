import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ServerDirectorAnalyticsBigBagEvidencePage,
  ServerDirectorAnalyticsShiftBalancePage,
} from '../../api/director';
import type {
  DirectorAnalyticsState,
  ProjectedDirectorAnalyticsView,
} from '../../domain/runtime/directorAnalyticsView';
import {
  emptyBigBagEvidenceFilterDraft,
  emptyShiftEvidenceFilterDraft,
} from '../../domain/runtime/directorEvidenceFilters';
import {
  DirectorProductionCharts,
  type DirectorEvidencePageState,
} from './DirectorProductionCharts';

const readyView: ProjectedDirectorAnalyticsView = {
  range: {
    timezone: 'Europe/Moscow',
    requested: { from: '2026-07-20', to: '2026-07-21' },
    effective: {
      fromUtc: '2026-07-19T21:00:00.000Z',
      toExclusiveUtc: '2026-07-21T21:00:00.000Z',
    },
    bucket: 'day',
    generatedAt: '2026-07-21T19:00:00.000Z',
  },
  productionSeries: [
    { bucketStartDate: '2026-07-20', rollCount: 0, producedKg: 0 },
    { bucketStartDate: '2026-07-21', rollCount: 3, producedKg: 82.8 },
  ],
  materialSeries: [
    { bucketStartDate: '2026-07-20', expectedUsageKg: 0, actualUsageKg: -4.5 },
    { bucketStartDate: '2026-07-21', expectedUsageKg: 82.8, actualUsageKg: 80.25 },
  ],
  shiftBalances: [
    {
      sessionId: 'session-1',
      shiftId: 'shift-1',
      shiftLabel: 'Смена 1',
      operatorId: 'operator-1',
      operatorName: 'Оператор 1',
      postId: 'post-1',
      postCode: 'POST-1',
      postName: 'Экструдер 1',
      startedAt: '2026-07-21T06:00:00.000Z',
      endedAt: '2026-07-21T14:00:00.000Z',
      rollCount: 3,
      producedKg: 82.8,
      expectedUsageKg: 82.8,
      actualUsageKg: null,
      deviationPercent: null,
      status: 'pending',
      payroll: {
        status: 'unresolved',
        reasons: ['material_class_unresolved'],
      },
    },
  ],
  bigBags: [
    {
      id: 'bag-1',
      code: 'BB-1',
      materialId: null,
      material: 'ПНД',
      status: 'in_use',
      initialKg: 1_000,
      priceKopecksPerKg: null,
      totalKopecks: null,
      priceEffectiveAt: null,
      currentSnapshot: {
        measuredKg: null,
        measuredAt: null,
      },
      usageHistory: [
        {
          id: 'usage-1',
          sessionId: 'session-1',
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          operatorId: 'operator-1',
          operatorName: 'Оператор 1',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'Экструдер 1',
          startKg: 100,
          endKg: null,
          deltaKg: null,
          openedAt: '2026-07-21T06:00:00.000Z',
          closedAt: null,
        },
      ],
    },
  ],
  operatorOverPlan: {
    series: [],
    totals: [],
    topOperators: [],
    missingPlanCount: 0,
    missingActorCount: 0,
  },
  productionQualitySeries: [
    {
      id: 'day:2026-07-20',
      bucketStartDate: '2026-07-20',
      producedRollCount: 0,
      producedKg: 0,
      defectRecordCount: 0,
      defectiveRollCount: 0,
      verifiedDefectKg: 0,
      unverifiedDefectCount: 0,
    },
    {
      id: 'day:2026-07-21',
      bucketStartDate: '2026-07-21',
      producedRollCount: 3,
      producedKg: 82.8,
      defectRecordCount: 1,
      defectiveRollCount: 1,
      verifiedDefectKg: 4.5,
      unverifiedDefectCount: 0,
    },
  ],
  materialSpendSeries: [
    {
      bucketStartDate: '2026-07-20',
      consumedGranulesKg: -4.5,
      recordedSpoolCount: 0,
      recordedSpoolTareKg: 0,
      missingSpoolEvidenceCount: 0,
    },
    {
      bucketStartDate: '2026-07-21',
      consumedGranulesKg: 80.25,
      recordedSpoolCount: 3,
      recordedSpoolTareKg: 2.25,
      missingSpoolEvidenceCount: 0,
    },
  ],
  accountingProduction: {
    source: {
      sourceKind: '1C',
      label: '1С · Отчет производства за смену',
      latestImportedAt: '2026-07-21T18:00:00.000Z',
      latestDocumentDate: '2026-07-21T12:00:00.000Z',
      stale: false,
    },
    coverage: {
      documentCount: 2,
      excludedOutputLineCount: 0,
      excludedMaterialLineCount: 0,
    },
    productionSeries: [
      { bucketStartDate: '2026-07-20', documentCount: 0, producedKg: 0 },
      { bucketStartDate: '2026-07-21', documentCount: 2, producedKg: 84.2 },
    ],
    materialSeries: [
      { bucketStartDate: '2026-07-20', consumedKg: 0 },
      { bucketStartDate: '2026-07-21', consumedKg: 81.1 },
    ],
  },
  spoolEvidence: {
    availability: 'measured_evidence_only',
    explanation: 'Measured production evidence only.',
  },
  commercialApplications: {
    definition: 'submitted',
    asOfDate: '2026-07-21',
    periods: [],
  },
  presentation: {
    productionBars: [
      {
        bucketStartDate: '2026-07-20',
        magnitudePercent: 0,
        negative: false,
        rollMagnitudePercent: 0,
        rollNegative: false,
      },
      {
        bucketStartDate: '2026-07-21',
        magnitudePercent: 100,
        negative: false,
        rollMagnitudePercent: 100,
        rollNegative: false,
      },
    ],
    materialBars: [
      {
        bucketStartDate: '2026-07-20',
        expectedMagnitudePercent: 0,
        expectedNegative: false,
        actualMagnitudePercent: 5.435,
        actualNegative: true,
      },
      {
        bucketStartDate: '2026-07-21',
        expectedMagnitudePercent: 100,
        expectedNegative: false,
        actualMagnitudePercent: 96.92,
        actualNegative: false,
      },
    ],
  },
};

function state(
  status: DirectorAnalyticsState['status'],
  overrides: Partial<DirectorAnalyticsState> = {},
): DirectorAnalyticsState {
  return {
    status,
    generation: 1,
    view: status === 'ready' ? readyView : null,
    error: status === 'error' ? 'Сервис временно недоступен' : null,
    ...overrides,
  } as DirectorAnalyticsState;
}

const source = {
  usage: 'shift_bag_usage',
  production: 'canonical_roll_weight_capture',
  defects: 'linked_stable_defect_weight_capture',
  latestEvidenceAt: '2026-07-21T14:00:00.000Z',
  freshness: 'fresh',
} as const;
const shiftBalanceState: DirectorEvidencePageState<ServerDirectorAnalyticsShiftBalancePage> = {
  status: 'ready',
  error: null,
  page: {
    items: [
      {
        sessionId: 'session-1',
        shiftId: 'shift-1',
        shiftLabel: 'Смена 1',
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Экструдер 1',
        startedAt: '2026-07-21T06:00:00.000Z',
        endedAt: '2026-07-21T14:00:00.000Z',
        bigBags: [],
        startKg: 100,
        endKg: null,
        currentKg: null,
        rollCount: 3,
        producedKg: 82.8,
        expectedUsageKg: 82.8,
        actualUsageKg: null,
        defectKg: 0,
        defectCount: 0,
        unverifiedDefectCount: 0,
        deviationKg: null,
        deviationPercent: null,
        status: 'pending',
        source,
      },
    ],
    nextCursor: null,
  },
};
const bigBagState: DirectorEvidencePageState<ServerDirectorAnalyticsBigBagEvidencePage> = {
  status: 'ready',
  error: null,
  page: {
    items: [
      {
        id: 'usage-1',
        bigBagId: 'bag-1',
        bigBagCode: 'BB-1',
        materialId: null,
        material: 'ПНД',
        bigBagStatus: 'in_use',
        sessionId: 'session-1',
        shiftId: 'shift-1',
        shiftLabel: 'Смена 1',
        operatorId: 'operator-1',
        operatorName: 'Оператор 1',
        postId: 'post-1',
        postCode: 'POST-1',
        postName: 'Экструдер 1',
        openedAt: '2026-07-21T06:00:00.000Z',
        closedAt: null,
        startKg: 100,
        endKg: null,
        currentKg: null,
        currentMeasuredAt: null,
        priceKopecksPerKg: null,
        totalKopecks: null,
        priceEffectiveAt: null,
        bagUsageKg: null,
        actualUsageKg: null,
        expectedUsageKg: 82.8,
        calculatedRemainderKg: null,
        producedKg: 82.8,
        rollCount: 3,
        defectKg: 0,
        defectCount: 0,
        unverifiedDefectCount: 0,
        deviationKg: null,
        deviationPercent: null,
        balanceScope: 'usage_episodes',
        status: 'pending',
        source,
      },
    ],
    nextCursor: null,
  },
};

function renderCharts(analyticsState: DirectorAnalyticsState): string {
  return renderToStaticMarkup(
    <DirectorProductionCharts
      state={analyticsState}
      shiftBalanceState={shiftBalanceState}
      bigBagState={bigBagState}
      shiftPageNumber={1}
      bigBagPageNumber={1}
      onPreviousShiftPage={vi.fn()}
      onNextShiftPage={vi.fn()}
      onPreviousBigBagPage={vi.fn()}
      onNextBigBagPage={vi.fn()}
      shiftOpen={false}
      bigBagOpen={false}
      shiftFilters={emptyShiftEvidenceFilterDraft}
      bigBagFilters={emptyBigBagEvidenceFilterDraft}
      shiftErrors={{}}
      bigBagErrors={{}}
      onShiftOpenChange={vi.fn()}
      onBigBagOpenChange={vi.fn()}
      onShiftFilterChange={vi.fn()}
      onBigBagFilterChange={vi.fn()}
      onResetShiftFilters={vi.fn()}
      onResetBigBagFilters={vi.fn()}
      onRetryShift={vi.fn()}
      onRetryBigBag={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('DirectorProductionCharts states', () => {
  it('announces loading without exposing charts', () => {
    const markup = renderCharts(state('loading'));

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Загрузка производственной аналитики');
    expect(markup).not.toContain('Точные данные выпуска');
  });

  it('shows an explicit empty result instead of zero-filled charts', () => {
    const markup = renderCharts(state('empty', { view: readyView }));

    expect(markup).toContain('role="status"');
    expect(markup).toContain('За выбранный период агрегированных рядов нет');
    expect(markup).not.toContain('Точные данные выпуска');
  });

  it('keeps an empty result compact without restoring the removed 1C source banner', () => {
    const emptyView: ProjectedDirectorAnalyticsView = {
      ...readyView,
      accountingProduction: {
        ...readyView.accountingProduction,
        coverage: {
          ...readyView.accountingProduction.coverage,
          documentCount: 0,
        },
        productionSeries: [],
        materialSeries: [],
      },
    };
    const markup = renderCharts(state('empty', { view: emptyView }));

    expect(markup).toContain('За выбранный период агрегированных рядов нет');
    expect(markup).not.toContain('aria-label="Источник производственных данных 1С"');
    expect(markup).not.toContain('В 1С за период данных нет');
    expect(markup).not.toContain('director-analytics-figure');
  });

  it('keeps independently queried evidence visible when the aggregate series is empty', () => {
    const markup = renderCharts(state('empty', { view: readyView }));

    expect(markup).toContain('За выбранный период агрегированных рядов нет');
    expect(markup).toContain('<summary>Баланс смен · Показано: 1</summary>');
    expect(markup).toContain('<summary>Факты BigBag · Показано: 1</summary>');
  });

  it('offers retry on error and never reveals a stale prior view', () => {
    const markup = renderCharts(state('error', { view: readyView }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Производственная аналитика недоступна');
    expect(markup).toContain('Сервис временно недоступен');
    expect(markup).toContain('Повторить загрузку');
    expect(markup).toContain('82,8 кг');
    expect(markup).toContain('Точный баланс смен');
    expect(markup).not.toContain('Точные данные выпуска');
  });
});

describe('DirectorProductionCharts truthful ready view', () => {
  const renderReady = () => renderCharts(state('ready'));

  it('renders only the active V2 detail while retaining the evidence sections', () => {
    const markup = renderReady();

    expect(markup.match(/role="tabpanel"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-label="Перерасход операторов"');
    expect(markup).not.toContain('director-analytics-grid');
    expect(markup).not.toContain('График выпуска по периодам');
    expect(markup).not.toContain('График расхода сырья: план и факт');
    expect(markup).not.toContain('<caption>Точные данные выпуска</caption>');
    expect(markup).not.toContain('<caption>Точный расход сырья: план и факт</caption>');
    expect(markup).toContain('<summary>Баланс смен · Показано: 1</summary>');
    expect(markup).toContain('<summary>Факты BigBag · Показано: 1</summary>');
  });

  it('renders exact closed-shift balances and keeps nullable facts pending', () => {
    const markup = renderReady();

    expect(markup.match(/<details class="director-analytics-evidence"[^>]*>/gu)).toHaveLength(2);
    expect(markup).not.toContain('<details class="director-analytics-evidence" open="">');
    expect(markup).toContain('<summary>Баланс смен · Показано: 1</summary>');
    expect(markup).toContain('<caption>Точный баланс смен</caption>');
    expect(markup).toContain('Смена 1');
    expect(markup).toContain('Оператор 1');
    expect(markup).toContain('POST-1 · Экструдер 1');
    expect(markup).toContain('82,8 кг');
    expect(markup).toContain('Ожидает фактов');
    expect(markup).toContain('Сырьё не определено');
    expect(markup).toContain('—');
  });

  it('joins the aggregate backend payroll projection to the paginated evidence row by session', () => {
    const resolvedView: ProjectedDirectorAnalyticsView = {
      ...readyView,
      shiftBalances: readyView.shiftBalances.map((balance) => ({
        ...balance,
        payroll: {
          status: 'resolved',
          tariffOrder: {
            id: 'payroll-order-joined',
            name: 'Приказ № 12-08/26',
            effectiveFrom: '2026-07-20',
            currency: 'RUB',
          },
          rateKopecksPerKg: 321,
          amountKopecks: 54_321,
          tariffRule: 'secondary',
          basisLabel: 'Серверная проекция баланса',
        },
      })),
    };
    const markup = renderCharts(state('ready', { view: resolvedView }));

    expect(markup).toContain('543,21 ₽');
    expect(markup).toContain('3,21 ₽/кг');
    expect(markup).toContain('Приказ № 12-08/26');
    expect(markup).toContain('Серверная проекция баланса');
  });

  it('renders immutable paginated BigBag usage evidence', () => {
    const markup = renderReady();

    expect(markup).toContain('<summary>Факты BigBag · Показано: 1</summary>');
    expect(markup).toContain('<caption>Неизменяемые факты BigBag</caption>');
    expect(markup).toContain('BB-1');
    expect(markup).toContain('В работе');
    expect(markup).toContain('100 кг');
    expect(markup).toContain('Ожидает фактов');
    expect(markup).toContain('—');
  });
});

describe('DirectorProductionCharts resilient evidence shells', () => {
  it('keeps both controlled tables open with stale rows while one table refreshes', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionCharts
        state={state('ready')}
        shiftBalanceState={{ status: 'loading', page: shiftBalanceState.page, error: null }}
        bigBagState={bigBagState}
        shiftPageNumber={2}
        bigBagPageNumber={1}
        onPreviousShiftPage={vi.fn()}
        onNextShiftPage={vi.fn()}
        onPreviousBigBagPage={vi.fn()}
        onNextBigBagPage={vi.fn()}
        shiftOpen
        bigBagOpen
        shiftFilters={emptyShiftEvidenceFilterDraft}
        bigBagFilters={emptyBigBagEvidenceFilterDraft}
        shiftErrors={{}}
        bigBagErrors={{}}
        onShiftOpenChange={vi.fn()}
        onBigBagOpenChange={vi.fn()}
        onShiftFilterChange={vi.fn()}
        onBigBagFilterChange={vi.fn()}
        onResetShiftFilters={vi.fn()}
        onResetBigBagFilters={vi.fn()}
        onRetryShift={vi.fn()}
        onRetryBigBag={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(markup.match(/<details[^>]*open=""/gu)).toHaveLength(2);
    // The live snapshot refreshes every 5s; mounting a banner under an already
    // populated table made it blink. Rows stay put and aria-busy carries the state.
    expect(markup).not.toContain('Обновляем баланс смен');
    expect(markup).not.toContain('Загрузка баланса смен');
    expect(markup).toContain('Смена 1');
    expect(markup).toContain('BB-1');
    expect(markup).toContain('aria-busy="true"');
  });

  it('keeps a failed table shell and retries only that table', () => {
    const onRetryShift = vi.fn();
    const onRetryBigBag = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <DirectorProductionCharts
          state={state('ready')}
          shiftBalanceState={{
            status: 'error',
            page: shiftBalanceState.page,
            error: 'Смена недоступна',
          }}
          bigBagState={bigBagState}
          shiftPageNumber={1}
          bigBagPageNumber={1}
          onPreviousShiftPage={vi.fn()}
          onNextShiftPage={vi.fn()}
          onPreviousBigBagPage={vi.fn()}
          onNextBigBagPage={vi.fn()}
          shiftOpen
          bigBagOpen
          shiftFilters={emptyShiftEvidenceFilterDraft}
          bigBagFilters={emptyBigBagEvidenceFilterDraft}
          shiftErrors={{}}
          bigBagErrors={{}}
          onShiftOpenChange={vi.fn()}
          onBigBagOpenChange={vi.fn()}
          onShiftFilterChange={vi.fn()}
          onBigBagFilterChange={vi.fn()}
          onResetShiftFilters={vi.fn()}
          onResetBigBagFilters={vi.fn()}
          onRetryShift={onRetryShift}
          onRetryBigBag={onRetryBigBag}
          onRetry={vi.fn()}
        />,
      );
    });

    const retry = renderer.root
      .findAllByType('button')
      .find((button) => nodeText(button) === 'Повторить баланс смен');
    expect(retry).toBeDefined();
    act(() => retry!.props.onClick());
    expect(onRetryShift).toHaveBeenCalledOnce();
    expect(onRetryBigBag).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('table')).toHaveLength(2);
  });
});
