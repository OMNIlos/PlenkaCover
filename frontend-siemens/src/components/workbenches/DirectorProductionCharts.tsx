import { useState } from 'react';

import type {
  ServerDirectorAnalyticsBigBagEvidencePage,
  ServerDirectorAnalyticsShiftPayroll,
  ServerDirectorAnalyticsShiftBalancePage,
} from '../../api/director';
import type { DirectorAnalyticsState } from '../../domain/runtime/directorAnalyticsView';
import type {
  DirectorBigBagEvidenceFilterDraft,
  DirectorShiftEvidenceFilterDraft,
  EvidenceFilterErrors,
} from '../../domain/runtime/directorEvidenceFilters';
import { DirectorBigBagFacts } from './director-analytics/DirectorBigBagFacts';
import { DirectorShiftBalanceTable } from './director-analytics/DirectorShiftBalanceTable';
import { DirectorAnalyticsDetails } from './director-analytics/DirectorAnalyticsDetails';
import {
  DirectorAnalyticsSummaryStrip,
  type DirectorAnalyticsTab,
} from './director-analytics/DirectorAnalyticsSummaryStrip';

export type DirectorEvidencePageState<T> =
  | { status: 'loading'; page: T | null; error: null }
  | { status: 'ready'; page: T; error: null }
  | { status: 'error'; page: T | null; error: string };

type DirectorProductionChartsProps = {
  state: DirectorAnalyticsState;
  shiftBalanceState: DirectorEvidencePageState<ServerDirectorAnalyticsShiftBalancePage>;
  bigBagState: DirectorEvidencePageState<ServerDirectorAnalyticsBigBagEvidencePage>;
  shiftPageNumber: number;
  bigBagPageNumber: number;
  onPreviousShiftPage: () => void;
  onNextShiftPage: () => void;
  onPreviousBigBagPage: () => void;
  onNextBigBagPage: () => void;
  shiftOpen: boolean;
  bigBagOpen: boolean;
  shiftFilters: DirectorShiftEvidenceFilterDraft;
  bigBagFilters: DirectorBigBagEvidenceFilterDraft;
  shiftErrors: EvidenceFilterErrors;
  bigBagErrors: EvidenceFilterErrors;
  onShiftOpenChange: (open: boolean) => void;
  onBigBagOpenChange: (open: boolean) => void;
  onShiftFilterChange: (key: keyof DirectorShiftEvidenceFilterDraft, value: string) => void;
  onBigBagFilterChange: (key: keyof DirectorBigBagEvidenceFilterDraft, value: string) => void;
  onResetShiftFilters: () => void;
  onResetBigBagFilters: () => void;
  onRetryShift: () => void;
  onRetryBigBag: () => void;
  onRetry: () => void;
};

export type DirectorEvidencePanelsProps = Omit<
  DirectorProductionChartsProps,
  'state' | 'onRetry'
> & {
  payrollBySessionId?: ReadonlyMap<string, ServerDirectorAnalyticsShiftPayroll>;
};

export function DirectorEvidencePanels({
  shiftBalanceState,
  bigBagState,
  shiftPageNumber,
  bigBagPageNumber,
  onPreviousShiftPage,
  onNextShiftPage,
  onPreviousBigBagPage,
  onNextBigBagPage,
  shiftOpen,
  bigBagOpen,
  shiftFilters,
  bigBagFilters,
  shiftErrors,
  bigBagErrors,
  onShiftOpenChange,
  onBigBagOpenChange,
  onShiftFilterChange,
  onBigBagFilterChange,
  onResetShiftFilters,
  onResetBigBagFilters,
  onRetryShift,
  onRetryBigBag,
  payrollBySessionId,
}: DirectorEvidencePanelsProps) {
  const shiftPage = shiftBalanceState.page;
  const bigBagPage = bigBagState.page;

  return (
    <>
      <DirectorShiftBalanceTable
        balances={shiftPage?.items ?? []}
        payrollBySessionId={payrollBySessionId}
        pageNumber={shiftPageNumber}
        hasPrevious={shiftPageNumber > 1}
        hasNext={shiftPage?.nextCursor !== null && shiftPage?.nextCursor !== undefined}
        onPrevious={onPreviousShiftPage}
        onNext={onNextShiftPage}
        open={shiftOpen}
        filters={shiftFilters}
        errors={shiftErrors}
        updating={shiftBalanceState.status === 'loading'}
        onOpenChange={onShiftOpenChange}
        onFilterChange={onShiftFilterChange}
        onResetFilters={onResetShiftFilters}
      />
      {shiftBalanceState.status === 'loading' && !shiftPage ? (
        <section className="director-analytics-state is-loading" role="status">
          Загрузка баланса смен…
        </section>
      ) : shiftBalanceState.status === 'error' ? (
        <section className="director-analytics-state is-error" role="alert">
          <strong>Баланс смен недоступен</strong>
          <p>{shiftBalanceState.error}</p>
          <button type="button" onClick={onRetryShift}>
            Повторить баланс смен
          </button>
        </section>
      ) : null}
      <DirectorBigBagFacts
        bags={bigBagPage?.items ?? []}
        pageNumber={bigBagPageNumber}
        hasPrevious={bigBagPageNumber > 1}
        hasNext={bigBagPage?.nextCursor !== null && bigBagPage?.nextCursor !== undefined}
        onPrevious={onPreviousBigBagPage}
        onNext={onNextBigBagPage}
        open={bigBagOpen}
        filters={bigBagFilters}
        errors={bigBagErrors}
        updating={bigBagState.status === 'loading'}
        onOpenChange={onBigBagOpenChange}
        onFilterChange={onBigBagFilterChange}
        onResetFilters={onResetBigBagFilters}
      />
      {bigBagState.status === 'loading' && !bigBagPage ? (
        <section className="director-analytics-state is-loading" role="status">
          Загрузка фактов BigBag…
        </section>
      ) : bigBagState.status === 'error' ? (
        <section className="director-analytics-state is-error" role="alert">
          <strong>Факты BigBag недоступны</strong>
          <p>{bigBagState.error}</p>
          <button type="button" onClick={onRetryBigBag}>
            Повторить факты BigBag
          </button>
        </section>
      ) : null}
    </>
  );
}

export function DirectorProductionCharts({
  state,
  shiftBalanceState,
  bigBagState,
  shiftPageNumber,
  bigBagPageNumber,
  onPreviousShiftPage,
  onNextShiftPage,
  onPreviousBigBagPage,
  onNextBigBagPage,
  shiftOpen,
  bigBagOpen,
  shiftFilters,
  bigBagFilters,
  shiftErrors,
  bigBagErrors,
  onShiftOpenChange,
  onBigBagOpenChange,
  onShiftFilterChange,
  onBigBagFilterChange,
  onResetShiftFilters,
  onResetBigBagFilters,
  onRetryShift,
  onRetryBigBag,
  onRetry,
}: DirectorProductionChartsProps) {
  const [activeTab, setActiveTab] = useState<DirectorAnalyticsTab>('overPlan');
  const payrollBySessionId = new Map(
    (state.view?.shiftBalances ?? []).map(({ sessionId, payroll }) => [sessionId, payroll]),
  );
  const evidencePanels = (
    <DirectorEvidencePanels
      shiftBalanceState={shiftBalanceState}
      bigBagState={bigBagState}
      shiftPageNumber={shiftPageNumber}
      bigBagPageNumber={bigBagPageNumber}
      onPreviousShiftPage={onPreviousShiftPage}
      onNextShiftPage={onNextShiftPage}
      onPreviousBigBagPage={onPreviousBigBagPage}
      onNextBigBagPage={onNextBigBagPage}
      shiftOpen={shiftOpen}
      bigBagOpen={bigBagOpen}
      shiftFilters={shiftFilters}
      bigBagFilters={bigBagFilters}
      shiftErrors={shiftErrors}
      bigBagErrors={bigBagErrors}
      onShiftOpenChange={onShiftOpenChange}
      onBigBagOpenChange={onBigBagOpenChange}
      onShiftFilterChange={onShiftFilterChange}
      onBigBagFilterChange={onBigBagFilterChange}
      onResetShiftFilters={onResetShiftFilters}
      onResetBigBagFilters={onResetBigBagFilters}
      onRetryShift={onRetryShift}
      onRetryBigBag={onRetryBigBag}
      payrollBySessionId={payrollBySessionId}
    />
  );

  if (state.status === 'error') {
    return (
      <section className="director-production-analytics" aria-label="Производственная аналитика">
        <section className="director-analytics-state is-error" role="alert">
          <strong>Производственная аналитика недоступна</strong>
          <p>{state.error ?? 'Не удалось загрузить подтверждённые данные.'}</p>
          <button type="button" onClick={onRetry}>
            Повторить загрузку
          </button>
        </section>
        {evidencePanels}
      </section>
    );
  }

  if (state.status === 'empty') {
    return (
      <section className="director-production-analytics" aria-label="Производственная аналитика">
        <section className="director-analytics-state is-empty" role="status" aria-live="polite">
          За выбранный период агрегированных рядов нет.
        </section>
        {evidencePanels}
      </section>
    );
  }

  // Only the very first load has nothing to show; a reload keeps the previous
  // charts up rather than collapsing the section to a loading row.
  if (state.view === null) {
    return (
      <section className="director-production-analytics" aria-label="Производственная аналитика">
        <section className="director-analytics-state is-loading" role="status" aria-live="polite">
          Загрузка производственной аналитики…
        </section>
        {evidencePanels}
      </section>
    );
  }

  return (
    <section className="director-production-analytics" aria-label="Производственная аналитика">
      <DirectorAnalyticsSummaryStrip
        view={state.view}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      <DirectorAnalyticsDetails
        activeTab={activeTab}
        onTabChange={setActiveTab}
        view={state.view}
      />
      {evidencePanels}
    </section>
  );
}
