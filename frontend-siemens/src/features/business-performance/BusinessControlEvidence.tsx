import { useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchBusinessBigBagEvidence,
  fetchBusinessShiftBalances,
  fetchDirectorAnalytics,
  type DirectorAnalyticsBigBagEvidenceQuery,
  type DirectorAnalyticsShiftEvidenceQuery,
  type ServerDirectorAnalyticsBigBagEvidencePage,
  type ServerDirectorAnalyticsShiftPayroll,
  type ServerDirectorAnalyticsShiftBalancePage,
} from '../../api/director';
import {
  DirectorEvidencePanels,
  type DirectorEvidencePageState,
} from '../../components/workbenches/DirectorProductionCharts';
import {
  buildBigBagEvidenceQuery,
  buildShiftEvidenceQuery,
  emptyBigBagEvidenceFilterDraft,
  emptyShiftEvidenceFilterDraft,
  validateEvidenceFilterDraft,
  type DirectorBigBagEvidenceFilterDraft,
  type DirectorShiftEvidenceFilterDraft,
} from '../../domain/runtime/directorEvidenceFilters';

type CursorNavigation = {
  queryKey: string;
  stack: string[];
};

type BusinessControlEvidenceRange = {
  from: string;
  to: string;
  bucket: 'day' | 'week' | 'month';
};

type BusinessControlRole = 'commercial' | 'director';

// The free-text search commits on every character; waiting for a typing pause
// made it feel dead. The numeric and date filters keep the debounce because a
// half-typed number is a different query, not a narrower one.
const shiftImmediateFilterKeys = new Set<keyof DirectorShiftEvidenceFilterDraft>([
  'q',
  'status',
  'freshness',
]);
const bigBagImmediateFilterKeys = new Set<keyof DirectorBigBagEvidenceFilterDraft>([
  'q',
  'bigBagStatus',
  'usageState',
  'status',
  'freshness',
]);

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => setDebounced(value), delayMs);
    return () => globalThis.clearTimeout(timeout);
  }, [delayMs, value]);

  return debounced;
}

function useEvidencePage<TQuery extends { cursor?: string }, TPage>(
  enabled: boolean,
  query: TQuery | null,
  queryKey: string,
  cursor: string | undefined,
  retryGeneration: number,
  refreshGeneration: string | number,
  load: (query: TQuery) => Promise<TPage>,
): DirectorEvidencePageState<TPage> {
  const [state, setState] = useState<DirectorEvidencePageState<TPage>>({
    status: 'loading',
    page: null,
    error: null,
  });
  const requestGeneration = useRef(0);

  useEffect(() => {
    if (!enabled || query === null) return undefined;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setState((current) => ({ status: 'loading', page: current.page, error: null }));

    void load({ ...query, cursor }).then(
      (page) => {
        if (requestGeneration.current !== generation) return;
        setState({ status: 'ready', page, error: null });
      },
      () => {
        if (requestGeneration.current !== generation) return;
        setState((current) => ({
          status: 'error',
          page: current.page,
          error: 'Не удалось загрузить серверные факты. Повторите запрос.',
        }));
      },
    );

    return () => {
      if (requestGeneration.current === generation) {
        requestGeneration.current += 1;
      }
    };
  }, [cursor, enabled, load, query, queryKey, refreshGeneration, retryGeneration]);

  return state;
}

function useDirectorPayrollBySessionId(
  enabled: boolean,
  range: BusinessControlEvidenceRange,
  refreshGeneration: string | number,
): ReadonlyMap<string, ServerDirectorAnalyticsShiftPayroll> | undefined {
  const [payrollBySessionId, setPayrollBySessionId] = useState<
    ReadonlyMap<string, ServerDirectorAnalyticsShiftPayroll> | undefined
  >();
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    if (!enabled) {
      setPayrollBySessionId(undefined);
      return undefined;
    }

    const controller = new AbortController();
    void fetchDirectorAnalytics(range, { signal: controller.signal }).then(
      (response) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setPayrollBySessionId(
          new Map(response.shiftBalances.map(({ sessionId, payroll }) => [sessionId, payroll])),
        );
      },
      () => {
        // Keep the last authoritative projection during a transient refresh failure.
        // Missing session ids remain visibly unavailable instead of being inferred locally.
      },
    );

    return () => {
      controller.abort();
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [enabled, range.bucket, range.from, range.to, refreshGeneration]);

  return payrollBySessionId;
}

export function BusinessControlEvidence({
  role,
  range,
  refreshGeneration,
}: {
  role: BusinessControlRole;
  range: BusinessControlEvidenceRange;
  refreshGeneration: string | number;
}) {
  const [shiftDraft, setShiftDraft] = useState(emptyShiftEvidenceFilterDraft);
  const [bigBagDraft, setBigBagDraft] = useState(emptyBigBagEvidenceFilterDraft);
  const [committedShiftDraft, setCommittedShiftDraft] = useState(emptyShiftEvidenceFilterDraft);
  const [committedBigBagDraft, setCommittedBigBagDraft] = useState(emptyBigBagEvidenceFilterDraft);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [bigBagOpen, setBigBagOpen] = useState(false);
  const [shiftRetryGeneration, setShiftRetryGeneration] = useState(0);
  const [bigBagRetryGeneration, setBigBagRetryGeneration] = useState(0);
  const [shiftNavigation, setShiftNavigation] = useState<CursorNavigation>({
    queryKey: '',
    stack: [],
  });
  const [bigBagNavigation, setBigBagNavigation] = useState<CursorNavigation>({
    queryKey: '',
    stack: [],
  });
  const debouncedShiftDraft = useDebouncedValue(shiftDraft, 300);
  const debouncedBigBagDraft = useDebouncedValue(bigBagDraft, 300);

  useEffect(() => setCommittedShiftDraft(debouncedShiftDraft), [debouncedShiftDraft]);
  useEffect(() => setCommittedBigBagDraft(debouncedBigBagDraft), [debouncedBigBagDraft]);

  const queryContext = useMemo(
    () => ({ from: range.from, to: range.to, bucket: range.bucket, limit: 20 }),
    [range.bucket, range.from, range.to],
  );
  const shiftQueryBuild = useMemo(
    () => buildShiftEvidenceQuery(queryContext, committedShiftDraft),
    [committedShiftDraft, queryContext],
  );
  const bigBagQueryBuild = useMemo(
    () => buildBigBagEvidenceQuery(queryContext, committedBigBagDraft),
    [committedBigBagDraft, queryContext],
  );
  const shiftQuery = shiftQueryBuild.ok ? shiftQueryBuild.query : null;
  const bigBagQuery = bigBagQueryBuild.ok ? bigBagQueryBuild.query : null;
  const shiftQueryKey = shiftQueryBuild.ok
    ? JSON.stringify(shiftQueryBuild.query)
    : `invalid:${JSON.stringify(committedShiftDraft)}`;
  const bigBagQueryKey = bigBagQueryBuild.ok
    ? JSON.stringify(bigBagQueryBuild.query)
    : `invalid:${JSON.stringify(committedBigBagDraft)}`;
  const shiftCursorStack = shiftNavigation.queryKey === shiftQueryKey ? shiftNavigation.stack : [];
  const bigBagCursorStack =
    bigBagNavigation.queryKey === bigBagQueryKey ? bigBagNavigation.stack : [];
  const shiftBalanceState = useEvidencePage<
    DirectorAnalyticsShiftEvidenceQuery,
    ServerDirectorAnalyticsShiftBalancePage
  >(
    shiftQueryBuild.ok,
    shiftQuery,
    shiftQueryKey,
    shiftCursorStack.at(-1),
    shiftRetryGeneration,
    refreshGeneration,
    fetchBusinessShiftBalances,
  );
  const bigBagState = useEvidencePage<
    DirectorAnalyticsBigBagEvidenceQuery,
    ServerDirectorAnalyticsBigBagEvidencePage
  >(
    bigBagQueryBuild.ok,
    bigBagQuery,
    bigBagQueryKey,
    bigBagCursorStack.at(-1),
    bigBagRetryGeneration,
    refreshGeneration,
    fetchBusinessBigBagEvidence,
  );
  const payrollBySessionId = useDirectorPayrollBySessionId(
    role === 'director',
    range,
    refreshGeneration,
  );
  const shiftErrors = useMemo(() => validateEvidenceFilterDraft(shiftDraft), [shiftDraft]);
  const bigBagErrors = useMemo(() => validateEvidenceFilterDraft(bigBagDraft), [bigBagDraft]);

  const updateShiftFilter = (key: keyof DirectorShiftEvidenceFilterDraft, value: string) => {
    setShiftDraft((current) => ({ ...current, [key]: value }));
    if (shiftImmediateFilterKeys.has(key)) {
      setCommittedShiftDraft((current) => ({ ...current, [key]: value }));
    }
  };
  const updateBigBagFilter = (key: keyof DirectorBigBagEvidenceFilterDraft, value: string) => {
    setBigBagDraft((current) => ({ ...current, [key]: value }));
    if (bigBagImmediateFilterKeys.has(key)) {
      setCommittedBigBagDraft((current) => ({ ...current, [key]: value }));
    }
  };

  return (
    <section
      className="director-production-analytics business-control-evidence"
      aria-label="Операционные таблицы контроля"
    >
      <DirectorEvidencePanels
        shiftBalanceState={shiftBalanceState}
        bigBagState={bigBagState}
        shiftPageNumber={shiftCursorStack.length + 1}
        bigBagPageNumber={bigBagCursorStack.length + 1}
        onPreviousShiftPage={() =>
          setShiftNavigation({ queryKey: shiftQueryKey, stack: shiftCursorStack.slice(0, -1) })
        }
        onNextShiftPage={() => {
          const nextCursor = shiftBalanceState.page?.nextCursor;
          if (!nextCursor) return;
          setShiftNavigation({
            queryKey: shiftQueryKey,
            stack: [...shiftCursorStack, nextCursor],
          });
        }}
        onPreviousBigBagPage={() =>
          setBigBagNavigation({
            queryKey: bigBagQueryKey,
            stack: bigBagCursorStack.slice(0, -1),
          })
        }
        onNextBigBagPage={() => {
          const nextCursor = bigBagState.page?.nextCursor;
          if (!nextCursor) return;
          setBigBagNavigation({
            queryKey: bigBagQueryKey,
            stack: [...bigBagCursorStack, nextCursor],
          });
        }}
        shiftOpen={shiftOpen}
        bigBagOpen={bigBagOpen}
        shiftFilters={shiftDraft}
        bigBagFilters={bigBagDraft}
        shiftErrors={shiftErrors}
        bigBagErrors={bigBagErrors}
        onShiftOpenChange={setShiftOpen}
        onBigBagOpenChange={setBigBagOpen}
        onShiftFilterChange={updateShiftFilter}
        onBigBagFilterChange={updateBigBagFilter}
        onResetShiftFilters={() => {
          setShiftDraft(emptyShiftEvidenceFilterDraft);
          setCommittedShiftDraft(emptyShiftEvidenceFilterDraft);
        }}
        onResetBigBagFilters={() => {
          setBigBagDraft(emptyBigBagEvidenceFilterDraft);
          setCommittedBigBagDraft(emptyBigBagEvidenceFilterDraft);
        }}
        onRetryShift={() => setShiftRetryGeneration((current) => current + 1)}
        onRetryBigBag={() => setBigBagRetryGeneration((current) => current + 1)}
        payrollBySessionId={payrollBySessionId}
      />
    </section>
  );
}
