import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  loadBusinessOperationalProblem,
  loadBusinessOperationalProblems,
  resolveBusinessOperationalProblem,
  type BusinessOperationalProblem,
  type BusinessOperationalProblemQuery,
} from '../../api/businessPerformance';
import { PlenkiModal } from '../../components/plenki-ui/PlenkiPrimitives';
import { OPERATOR_REPORTABLE_PROBLEM_ROUTING } from '../../domain/operatorProblem';

type ProblemFilter = NonNullable<BusinessOperationalProblemQuery['filter']>;
type ProblemResolution = 'rework' | 'writeoff' | 'confirm' | 'reject';

type ProblemState = {
  status: 'loading' | 'refreshing' | 'ready' | 'error';
  items: BusinessOperationalProblem[];
  nextCursor: string | null;
  loadingMore: boolean;
  error: string | null;
  failedAction: 'refresh' | 'more' | null;
};

const FILTERS: ReadonlyArray<{ value: ProblemFilter; label: string; empty: string }> = [
  { value: 'open', label: 'Открытые', empty: 'Открытых проблем нет' },
  { value: 'resolved', label: 'Решённые', empty: 'Решённых проблем нет' },
  { value: 'all', label: 'Все', empty: 'Проблем нет' },
];

const KIND_LABELS: Record<BusinessOperationalProblem['kind'], string> = {
  general: 'Общая проблема',
  raw_material_shortage: 'Нехватка сырья',
  weight_deviation: 'Отклонение веса',
  defect: 'Брак',
  machine_breakdown: 'Поломка станка',
};

const OWNER_LABELS: Record<BusinessOperationalProblem['kind'], string> = {
  general: OPERATOR_REPORTABLE_PROBLEM_ROUTING.general.ownerLabel,
  raw_material_shortage: OPERATOR_REPORTABLE_PROBLEM_ROUTING.raw_material_shortage.ownerLabel,
  weight_deviation: 'Склад',
  defect: 'Зав. производства',
  machine_breakdown: 'Зав. производства',
};

const DEFECT_RESOLUTIONS = [
  { value: 'rework', label: 'Переделать' },
  { value: 'writeoff', label: 'Списать' },
] as const;

const BREAKDOWN_RESOLUTIONS = [
  { value: 'confirm', label: 'Подтвердить поломку' },
  { value: 'reject', label: 'Отклонить поломку' },
] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось обновить список.';
}

function mutationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '';
  return /[\p{Script=Cyrillic}]/u.test(message)
    ? message
    : 'Не удалось применить решение. Обновите данные и повторите.';
}

function appendUnique(
  current: readonly BusinessOperationalProblem[],
  incoming: readonly BusinessOperationalProblem[],
) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('ru-RU');
}

export function BusinessProblemsWorkspace({
  refreshGeneration = 0,
  allowProductionOverride = false,
  selectedProblemId: routedProblemId = null,
  onOpenMaterialShortageCorrection,
  headerAction,
}: {
  refreshGeneration?: string | number;
  allowProductionOverride?: boolean;
  selectedProblemId?: string | null;
  onOpenMaterialShortageCorrection?: (target: {
    orderId: string;
    problemId: string;
  }) => void;
  headerAction?: ReactNode;
}) {
  const [filter, setFilter] = useState<ProblemFilter>('open');
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<ProblemState>({
    status: 'loading',
    items: [],
    nextCursor: null,
    loadingMore: false,
    error: null,
    failedAction: null,
  });
  const [routedRevision, setRoutedRevision] = useState(0);
  const routedRequestKey = routedProblemId
    ? JSON.stringify([routedProblemId, routedRevision])
    : null;
  const [detailsSelection, setDetailsSelection] = useState<{
    problemId: string;
    routedRequestKey: string | null;
    supersedesRoutedRequestKey?: string | null;
  } | null>(null);
  const [routedSnapshot, setRoutedSnapshot] = useState<{
    requestKey: string;
    problem: BusinessOperationalProblem;
  } | null>(null);
  const [routedProblemError, setRoutedProblemError] = useState<{
    requestKey: string;
    message: string;
  } | null>(null);
  const [routedProblemLoadingKey, setRoutedProblemLoadingKey] = useState<string | null>(null);
  const [resolution, setResolution] = useState<ProblemResolution | null>(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [mutation, setMutation] = useState<{
    status: 'idle' | 'submitting' | 'error';
    error: string | null;
  }>({ status: 'idle', error: null });
  const requestGeneration = useRef(0);
  const lastFilter = useRef(filter);
  const loadMoreController = useRef<AbortController | null>(null);
  const loadMoreInFlight = useRef(false);
  const visitedCursors = useRef(new Set<string>());
  const problemRows = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    const filterChanged = lastFilter.current !== filter;
    lastFilter.current = filter;
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    loadMoreInFlight.current = false;
    setState((current) => {
      const items = filterChanged ? [] : current.items;
      return {
        ...current,
        items,
        nextCursor: filterChanged ? null : current.nextCursor,
        status: items.length === 0 ? 'loading' : 'refreshing',
        loadingMore: false,
        error: null,
        failedAction: null,
      };
    });

    void loadBusinessOperationalProblems({ filter, limit: 20 }, { signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        visitedCursors.current.clear();
        setState({
          status: 'ready',
          items: appendUnique([], page.items),
          nextCursor: page.nextCursor,
          loadingMore: false,
          error: null,
          failedAction: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setState((current) => ({
          ...current,
          status: current.items.length === 0 ? 'error' : 'ready',
          loadingMore: false,
          error: errorMessage(error),
          failedAction: 'refresh',
        }));
      });

    return () => {
      controller.abort();
      loadMoreController.current?.abort();
    };
  }, [filter, refreshGeneration, revision]);

  useEffect(() => {
    if (!routedProblemId || !routedRequestKey) return undefined;
    const controller = new AbortController();
    setRoutedProblemError(null);
    setRoutedProblemLoadingKey(routedRequestKey);

    void loadBusinessOperationalProblem(routedProblemId, { signal: controller.signal })
      .then((problem) => {
        if (controller.signal.aborted) return;
        setRoutedSnapshot({ requestKey: routedRequestKey, problem });
        setDetailsSelection((current) =>
          current?.routedRequestKey === null &&
          current.supersedesRoutedRequestKey === routedRequestKey
            ? current
            : { problemId: problem.id, routedRequestKey },
        );
        setResolution(null);
        setResolutionNote('');
        setMutation({ status: 'idle', error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRoutedSnapshot((current) =>
          current?.requestKey === routedRequestKey ? null : current,
        );
        setRoutedProblemError({ requestKey: routedRequestKey, message: errorMessage(error) });
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setRoutedProblemLoadingKey((current) =>
          current === routedRequestKey ? null : current,
        );
      });

    return () => controller.abort();
  }, [refreshGeneration, routedProblemId, routedRequestKey]);

  const loadMore = useCallback(() => {
    if (loadMoreInFlight.current || state.loadingMore || !state.nextCursor) return;
    const cursor = state.nextCursor;
    if (visitedCursors.current.has(cursor)) {
      setState((current) => ({ ...current, nextCursor: null }));
      return;
    }

    const controller = new AbortController();
    const generation = requestGeneration.current;
    loadMoreInFlight.current = true;
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setState((current) => ({
      ...current,
      loadingMore: true,
      error: null,
      failedAction: null,
    }));

    void loadBusinessOperationalProblems(
      { filter, cursor, limit: 20 },
      { signal: controller.signal },
    )
      .then((page) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        visitedCursors.current.add(cursor);
        const nextCursor =
          page.nextCursor &&
          page.nextCursor !== cursor &&
          !visitedCursors.current.has(page.nextCursor)
            ? page.nextCursor
            : null;
        setState((current) => ({
          ...current,
          status: 'ready',
          items: appendUnique(current.items, page.items),
          nextCursor,
          loadingMore: false,
          error: null,
          failedAction: null,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setState((current) => ({
          ...current,
          loadingMore: false,
          error: errorMessage(error),
          failedAction: 'more',
        }));
      })
      .finally(() => {
        if (loadMoreController.current !== controller) return;
        loadMoreController.current = null;
        loadMoreInFlight.current = false;
      });
  }, [filter, state.loadingMore, state.nextCursor]);

  const emptyMessage = FILTERS.find((item) => item.value === filter)?.empty ?? 'Проблем нет';
  const routedSnapshotProblem =
    routedSnapshot?.requestKey === routedRequestKey ? routedSnapshot.problem : null;
  const listedRoutedProblem = routedProblemId
    ? state.items.find((problem) => problem.id === routedProblemId) ?? null
    : null;
  const routedProblem = listedRoutedProblem ?? routedSnapshotProblem;
  const visibleProblems =
    routedProblem && !listedRoutedProblem
      ? appendUnique(state.items, [routedProblem])
      : state.items;
  const detailsProblemId =
    detailsSelection &&
    (routedRequestKey === null
      ? detailsSelection.routedRequestKey === null
      : detailsSelection.routedRequestKey === routedRequestKey ||
        (detailsSelection.routedRequestKey === null &&
          detailsSelection.supersedesRoutedRequestKey === routedRequestKey))
      ? detailsSelection.problemId
      : null;
  const currentRoutedProblemError =
    routedProblemError?.requestKey === routedRequestKey ? routedProblemError.message : null;
  const routedProblemLoading = routedProblemLoadingKey === routedRequestKey;
  const selectedProblem =
    visibleProblems.find((problem) => problem.id === detailsProblemId) ?? null;

  useEffect(() => {
    if (!detailsProblemId) return;
    const row = problemRows.current.get(detailsProblemId);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [detailsProblemId, routedProblem]);
  const applicableResolutions =
    selectedProblem?.kind === 'defect'
      ? DEFECT_RESOLUTIONS
      : selectedProblem?.kind === 'machine_breakdown'
        ? BREAKDOWN_RESOLUTIONS
        : [];
  const canResolveSelected =
    allowProductionOverride &&
    selectedProblem?.status === 'open' &&
    applicableResolutions.length > 0;
  const normalizedResolutionNote = resolutionNote.trim();
  const retry = () => {
    if (state.failedAction === 'more') {
      loadMore();
      return;
    }
    setRevision((current) => current + 1);
  };
  const openDetails = (problemId: string) => {
    setDetailsSelection({
      problemId,
      routedRequestKey: null,
      supersedesRoutedRequestKey: routedRequestKey,
    });
    setResolution(null);
    setResolutionNote('');
    setMutation({ status: 'idle', error: null });
  };
  const closeDetails = () => {
    if (mutation.status === 'submitting') return;
    setDetailsSelection(null);
    setResolution(null);
    setResolutionNote('');
    setMutation({ status: 'idle', error: null });
  };
  const retryRoutedProblem = () => setRoutedRevision((current) => current + 1);
  const submitResolution = async () => {
    if (
      !selectedProblem ||
      !canResolveSelected ||
      !resolution ||
      !normalizedResolutionNote ||
      mutation.status === 'submitting'
    ) {
      return;
    }
    setMutation({ status: 'submitting', error: null });
    try {
      await resolveBusinessOperationalProblem(selectedProblem.id, {
        resolution,
        note: normalizedResolutionNote,
      });
      const resolvedRoutedProblem =
        routedRequestKey !== null &&
        detailsSelection?.routedRequestKey === routedRequestKey &&
        routedProblemId === selectedProblem.id;
      setDetailsSelection(null);
      if (resolvedRoutedProblem) {
        setRoutedSnapshot(null);
        setRoutedRevision((current) => current + 1);
      }
      setResolution(null);
      setResolutionNote('');
      setMutation({ status: 'idle', error: null });
      setRevision((current) => current + 1);
    } catch (error: unknown) {
      setMutation({ status: 'error', error: mutationErrorMessage(error) });
    }
  };
  const resolutionSubmitLabel =
    resolution === 'writeoff'
      ? 'Подтвердить списание'
      : resolution === 'rework'
        ? 'Подтвердить переделку'
        : resolution === 'confirm'
          ? 'Подтвердить поломку'
          : 'Отклонить поломку';

  return (
    <section
      className="commercial-problems"
      aria-labelledby="business-problems-heading"
      aria-busy={
        state.status === 'loading' || state.status === 'refreshing' || routedProblemLoading
      }
    >
      <header className="commercial-problems-header">
        <h1 id="business-problems-heading">Проблемы</h1>
        <div className="commercial-problems-header-actions">
          <div className="commercial-problems-filters" aria-label="Фильтр проблем">
            {FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={filter === item.value}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {headerAction}
        </div>
      </header>

      {visibleProblems.length === 0 && state.status === 'loading' ? (
        <p className="commercial-problems-state" aria-live="polite">
          Загрузка проблем…
        </p>
      ) : null}

      {state.error ? (
        <div className="commercial-problems-load-error" role="status">
          <span>Не удалось обновить список.</span>
          <button type="button" onClick={retry}>
            Повторить
          </button>
        </div>
      ) : null}

      {currentRoutedProblemError ? (
        <div className="commercial-problems-load-error" role="status">
          <span>Не удалось открыть выбранную проблему.</span>
          <button type="button" onClick={retryRoutedProblem}>
            Повторить
          </button>
        </div>
      ) : null}

      {visibleProblems.length === 0 && state.status !== 'loading' && !state.error ? (
        <p className="commercial-problems-state" aria-live="polite">
          {emptyMessage}
        </p>
      ) : null}

      {visibleProblems.length > 0 ? (
        <div className="commercial-problems-list">
          {visibleProblems.map((problem) => (
            <article
              key={problem.id}
              className="commercial-problem-row"
              data-problem-id={problem.id}
              data-problem-selected={problem.id === detailsProblemId ? 'true' : 'false'}
              tabIndex={-1}
              ref={(node) => {
                if (node) problemRows.current.set(problem.id, node);
                else problemRows.current.delete(problem.id);
              }}
            >
              <header>
                <div>
                  <span>{KIND_LABELS[problem.kind]}</span>
                  <strong>{problem.label}</strong>
                </div>
                <div className="commercial-problem-row-actions">
                  <span data-problem-status={problem.status}>
                    {problem.status === 'open' ? 'Открыта' : 'Решена'}
                  </span>
                  <button type="button" onClick={() => openDetails(problem.id)}>
                    Подробнее
                  </button>
                </div>
              </header>
              <dl>
                {problem.orderNumber ? (
                  <div>
                    <dt>Заказ</dt>
                    <dd>{problem.orderNumber}</dd>
                  </div>
                ) : null}
                {problem.rollCode ? (
                  <div>
                    <dt>Рулон</dt>
                    <dd>{problem.rollCode}</dd>
                  </div>
                ) : null}
                {problem.machineName ? (
                  <div>
                    <dt>Станок</dt>
                    <dd>{problem.machineName}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Ответственный</dt>
                  <dd>{OWNER_LABELS[problem.kind]}</dd>
                </div>
                <div>
                  <dt>Зафиксировано</dt>
                  <dd>{formatDate(problem.createdAt)}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : null}

      {state.nextCursor && !state.error ? (
        <button
          className="commercial-problems-load-more"
          type="button"
          disabled={state.loadingMore}
          onClick={loadMore}
        >
          {state.loadingMore ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}

      {selectedProblem ? (
        <PlenkiModal
          title={selectedProblem.label}
          eyebrow={KIND_LABELS[selectedProblem.kind]}
          className="commercial-problem-dialog"
          bodyClassName="commercial-problem-dialog-body"
          onClose={closeDetails}
        >
          <div aria-busy={mutation.status === 'submitting'}>
            <dl className="commercial-problem-dialog-facts">
              <div>
                <dt>Статус</dt>
                <dd>{selectedProblem.status === 'open' ? 'Открыта' : 'Решена'}</dd>
              </div>
              <div>
                <dt>Ответственный за решение</dt>
                <dd>{OWNER_LABELS[selectedProblem.kind]}</dd>
              </div>
              {selectedProblem.orderNumber ? (
                <div>
                  <dt>Заказ</dt>
                  <dd>{selectedProblem.orderNumber}</dd>
                </div>
              ) : null}
              {selectedProblem.rollCode ? (
                <div>
                  <dt>Рулон</dt>
                  <dd>{selectedProblem.rollCode}</dd>
                </div>
              ) : null}
              {selectedProblem.machineName ? (
                <div>
                  <dt>Станок</dt>
                  <dd>{selectedProblem.machineName}</dd>
                </div>
              ) : null}
              <div>
                <dt>Зафиксировано</dt>
                <dd>{formatDate(selectedProblem.createdAt)}</dd>
              </div>
              <div className="commercial-problem-dialog-reason">
                <dt>Причина</dt>
                <dd>{selectedProblem.reason ?? 'Не указана'}</dd>
              </div>
            </dl>

            {selectedProblem.kind === 'raw_material_shortage' &&
            selectedProblem.status === 'open' &&
            selectedProblem.orderId &&
            onOpenMaterialShortageCorrection ? (
              <button
                type="button"
                onClick={() =>
                  onOpenMaterialShortageCorrection({
                    orderId: selectedProblem.orderId!,
                    problemId: selectedProblem.id,
                  })
                }
              >
                Перейти к корректировке сырья
              </button>
            ) : null}

            {canResolveSelected ? (
              <div className="commercial-problem-resolution">
                <div className="commercial-problem-resolution-actions">
                  {applicableResolutions.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={resolution === item.value}
                      onClick={() => {
                        setResolution(item.value);
                        setMutation({ status: 'idle', error: null });
                      }}
                      disabled={mutation.status === 'submitting'}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {resolution ? (
                  <div className="commercial-problem-resolution-form">
                    <label>
                      <span>Основание решения</span>
                      <textarea
                        value={resolutionNote}
                        maxLength={1000}
                        placeholder="Что проверено и почему выбрано это решение"
                        onChange={(event) => setResolutionNote(event.target.value)}
                        disabled={mutation.status === 'submitting'}
                      />
                    </label>
                    {mutation.error ? (
                      <p className="commercial-problem-resolution-error" role="status">
                        {mutation.error}
                      </p>
                    ) : null}
                    <button
                      className="commercial-problem-resolution-submit"
                      type="button"
                      disabled={
                        !normalizedResolutionNote || mutation.status === 'submitting'
                      }
                      onClick={() => void submitResolution()}
                    >
                      {mutation.status === 'submitting'
                        ? 'Сохраняем решение…'
                        : resolutionSubmitLabel}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </PlenkiModal>
      ) : null}
    </section>
  );
}
