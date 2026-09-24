import { useEffect, useMemo, useRef, useState } from 'react';

import { isLiveContour } from '../../api/liveContours';
import { warehouseCoverageApi } from '../../api/warehouse';
import type {
  WarehouseCoverageRecheckItem,
  WarehouseCoverageView,
} from '../../domain/warehouseCoverage';
import type {
  WarehouseCoverFreeRoll,
  WarehouseCoverTask,
  WarehouseCoverTaskPosition,
} from '../../domain/types';
import { WarehouseCoverageRecheckPanel } from './WarehouseCoverageRecheckPanel';

export type WarehouseCoverProposalCommand = {
  orderId: string;
  positionId: string;
  rollIds: string[];
  comment?: string;
};

export type WarehouseCoverFeedback = {
  status: 'idle' | 'submitting' | 'success' | 'error';
  message: string;
};

export type WarehouseCoverPrimaryAction = {
  id: string;
  label: string;
  rollIds: string[];
  route: 'production_only' | 'partial_cover' | 'full_cover';
};

export type WarehouseCoverSubmissionLock = {
  current: Promise<WarehouseCoverFeedback> | null;
};

export function executeWarehouseCoverProposal(
  command: WarehouseCoverProposalCommand,
  propose: (
    orderId: string,
    input: Omit<WarehouseCoverProposalCommand, 'orderId'>,
  ) => Promise<unknown>,
  refresh: () => Promise<unknown> | unknown,
  lock: WarehouseCoverSubmissionLock,
): Promise<WarehouseCoverFeedback> {
  if (lock.current) return lock.current;
  const { orderId, ...input } = command;
  const request = (async () => {
    try {
      await propose(orderId, input);
      await refresh();
      return { status: 'success', message: 'Предложение отправлено' } as const;
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Не удалось отправить предложение',
      } as const;
    }
  })().finally(() => {
    if (lock.current === request) lock.current = null;
  });
  lock.current = request;
  return request;
}

export function reconcileWarehouseCoverTaskSelection(
  currentId: string | null,
  tasks: WarehouseCoverTask[],
): string | null {
  if (currentId && tasks.some((task) => task.caseId === currentId)) return currentId;
  return tasks[0]?.caseId ?? null;
}

export function warehouseCoverObjectId(task: WarehouseCoverTask): string {
  return `WH-COVER-${task.orderId}`;
}

function taskCaseIdFromObjectSelection(
  selectedObjectId: string | null | undefined,
  tasks: WarehouseCoverTask[],
): string | null {
  return tasks.find((task) => warehouseCoverObjectId(task) === selectedObjectId)?.caseId ?? null;
}

function positionNeedsProposal(position: WarehouseCoverTaskPosition): boolean {
  return ['not_checked', 'recheck_requested', 'rejected'].includes(position.warehouseCoverStatus);
}

export function nextWarehouseCoverPositionId(
  task: WarehouseCoverTask,
  currentPositionId: string | null,
  submittedPositionIds: ReadonlySet<string>,
): string | null {
  const current = task.positions.find((position) => position.id === currentPositionId);
  if (current && positionNeedsProposal(current) && !submittedPositionIds.has(current.id)) {
    return current.id;
  }
  return (
    task.positions.find(
      (position) => positionNeedsProposal(position) && !submittedPositionIds.has(position.id),
    )?.id ??
    current?.id ??
    task.positions[0]?.id ??
    null
  );
}

export function compatibleWarehouseCoverRolls(
  position: WarehouseCoverTaskPosition,
  rolls: WarehouseCoverFreeRoll[],
): WarehouseCoverFreeRoll[] {
  return rolls.filter(
    (roll) =>
      roll.warehouseStatus === 'received' &&
      position.filmType !== null &&
      roll.facts.filmType !== null &&
      normalizedText(position.filmType) === normalizedText(roll.facts.filmType) &&
      position.actualThickness !== null &&
      roll.facts.actualThickness !== null &&
      normalizedMeasurement(position.actualThickness) ===
        normalizedMeasurement(roll.facts.actualThickness) &&
      position.birka !== null &&
      roll.facts.birka !== null &&
      normalizedText(position.birka) === normalizedText(roll.facts.birka) &&
      position.spoolType !== null &&
      roll.facts.spoolType !== null &&
      normalizedSpool(position.spoolType) === normalizedSpool(roll.facts.spoolType) &&
      position.plannedWeightKg !== null &&
      roll.facts.plannedWeightKg !== null &&
      Math.abs(position.plannedWeightKg - roll.facts.plannedWeightKg) < 0.001,
  );
}

export function warehouseCoverPrimaryAction(
  task: WarehouseCoverTask,
  position: WarehouseCoverTaskPosition,
  selectedRollIds: string[],
): WarehouseCoverPrimaryAction {
  const rollIds = selectedRollIds.slice(0, position.rollCount);
  const id = `warehouse-cover-propose:${task.orderId}:${position.id}`;
  if (rollIds.length === 0) {
    return {
      id,
      label: 'Предложить производство без резерва',
      rollIds,
      route: 'production_only',
    };
  }
  if (rollIds.length === position.rollCount) {
    return {
      id,
      label: 'Предложить покрытие',
      rollIds,
      route: 'full_cover',
    };
  }
  return {
    id,
    label: 'Предложить покрытие',
    rollIds,
    route: 'partial_cover',
  };
}

export function WarehouseCoverTasksPanel({
  tasks,
  freeRolls,
  coverageRechecks,
  selectedObjectId,
  onSelectObject,
  onPropose,
  onRefresh,
  liveCoverageEnabled = isLiveContour('warehouse'),
  refreshGeneration = 0,
}: {
  tasks: WarehouseCoverTask[];
  freeRolls: WarehouseCoverFreeRoll[];
  coverageRechecks?: WarehouseCoverageRecheckItem[];
  selectedObjectId?: string | null;
  onSelectObject?: (objectId: string) => void;
  onPropose: (
    orderId: string,
    input: Omit<WarehouseCoverProposalCommand, 'orderId'>,
  ) => Promise<unknown>;
  onRefresh: () => Promise<unknown> | unknown;
  liveCoverageEnabled?: boolean;
  refreshGeneration?: number;
}) {
  const [loadedRechecks, setLoadedRechecks] = useState<WarehouseCoverageRecheckItem[]>(
    () => coverageRechecks ?? [],
  );
  const [coverageMode, setCoverageMode] = useState<'loading' | 'error' | 'v1' | 'v2'>(() => {
    if (coverageRechecks === undefined) return liveCoverageEnabled ? 'loading' : 'v1';
    return coverageRechecks.length > 0 ? 'v2' : 'v1';
  });
  const [recheckReloadVersion, setRecheckReloadVersion] = useState(0);
  const [recheckLoadFailed, setRecheckLoadFailed] = useState(false);
  const [resolvedCaseIds, setResolvedCaseIds] = useState<string[]>([]);
  const [selectedRecheckCaseId, setSelectedRecheckCaseId] = useState<string | null>(
    () => coverageRechecks?.[0]?.caseId ?? null,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => taskCaseIdFromObjectSelection(selectedObjectId, tasks) ?? tasks[0]?.caseId ?? null,
  );
  const initialTask = tasks.find((task) => task.caseId === selectedTaskId) ?? tasks[0];
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(
    () => initialTask?.positions[0]?.id ?? null,
  );
  const [selectedRollIds, setSelectedRollIds] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [submittedPositionIdsByTask, setSubmittedPositionIdsByTask] = useState<
    Record<string, string[]>
  >({});
  const [feedback, setFeedback] = useState<WarehouseCoverFeedback>({
    status: 'idle',
    message: '',
  });
  const submissionLock = useRef<Promise<WarehouseCoverFeedback> | null>(null);
  const availableRechecks = useMemo(
    () =>
      (coverageRechecks ?? loadedRechecks).filter((item) => !resolvedCaseIds.includes(item.caseId)),
    [coverageRechecks, loadedRechecks, resolvedCaseIds],
  );
  const selectedRecheck =
    availableRechecks.find((item) => item.caseId === selectedRecheckCaseId) ?? availableRechecks[0];

  useEffect(() => {
    if (coverageRechecks !== undefined) {
      setLoadedRechecks(coverageRechecks);
      setCoverageMode((current) =>
        coverageRechecks.length > 0 ? 'v2' : current === 'loading' ? 'v1' : current,
      );
      return;
    }
    if (!liveCoverageEnabled) {
      setLoadedRechecks([]);
      setCoverageMode('v1');
      return;
    }
    let active = true;
    setRecheckLoadFailed(false);
    setCoverageMode((current) => (current === 'error' ? 'loading' : current));
    warehouseCoverageApi
      .listRechecks()
      .then((items) => {
        if (!active) return;
        setLoadedRechecks(items);
        setCoverageMode((current) =>
          items.length === 0 ? 'v1' : current === 'v1' && tasks.length > 0 ? 'v1' : 'v2',
        );
      })
      .catch(() => {
        if (active) {
          setRecheckLoadFailed(true);
          setCoverageMode((current) => (current === 'loading' ? 'error' : current));
        }
      });
    return () => {
      active = false;
    };
  }, [
    coverageRechecks,
    liveCoverageEnabled,
    recheckReloadVersion,
    refreshGeneration,
    tasks.length,
  ]);

  useEffect(() => {
    setSelectedRecheckCaseId((current) => {
      if (current && availableRechecks.some((item) => item.caseId === current)) {
        return current;
      }
      return availableRechecks[0]?.caseId ?? null;
    });
  }, [availableRechecks]);

  useEffect(() => {
    const controlledTaskId = taskCaseIdFromObjectSelection(selectedObjectId, tasks);
    setSelectedTaskId(
      (current) => controlledTaskId ?? reconcileWarehouseCoverTaskSelection(current, tasks),
    );
  }, [selectedObjectId, tasks]);

  const selectedTask = tasks.find((task) => task.caseId === selectedTaskId) ?? tasks[0];
  const submittedPositionIds = useMemo(
    () => new Set(selectedTask ? (submittedPositionIdsByTask[selectedTask.caseId] ?? []) : []),
    [selectedTask, submittedPositionIdsByTask],
  );

  useEffect(() => {
    if (!selectedTask) {
      setSelectedPositionId(null);
      return;
    }
    setSelectedPositionId((current) =>
      nextWarehouseCoverPositionId(selectedTask, current, submittedPositionIds),
    );
  }, [selectedTask, submittedPositionIds]);

  const selectedPosition = selectedTask?.positions.find(
    (position) => position.id === selectedPositionId,
  );
  const compatibleRolls = useMemo(
    () => (selectedPosition ? compatibleWarehouseCoverRolls(selectedPosition, freeRolls) : []),
    [freeRolls, selectedPosition],
  );

  useEffect(() => {
    const compatibleIds = new Set(compatibleRolls.map((roll) => roll.id));
    setSelectedRollIds((current) =>
      current
        .filter((rollId) => compatibleIds.has(rollId))
        .slice(0, selectedPosition?.rollCount ?? 0),
    );
  }, [compatibleRolls, selectedPosition?.rollCount]);

  function selectTask(caseId: string) {
    if (feedback.status === 'submitting') return;
    const nextTask = tasks.find((task) => task.caseId === caseId);
    setSelectedTaskId(caseId);
    setSelectedPositionId(nextTask?.positions[0]?.id ?? null);
    setSelectedRollIds([]);
    setFeedback({ status: 'idle', message: '' });
    if (nextTask) onSelectObject?.(warehouseCoverObjectId(nextTask));
  }

  function selectPosition(positionId: string) {
    if (feedback.status === 'submitting') return;
    setSelectedPositionId(positionId);
    setSelectedRollIds([]);
    setFeedback({ status: 'idle', message: '' });
  }

  function toggleRoll(rollId: string) {
    if (!selectedPosition || feedback.status === 'submitting') return;
    setSelectedRollIds((current) => {
      if (current.includes(rollId)) return current.filter((id) => id !== rollId);
      if (current.length >= selectedPosition.rollCount) return current;
      return [...current, rollId];
    });
    setFeedback({ status: 'idle', message: '' });
  }

  async function submit() {
    if (!selectedTask || !selectedPosition || feedback.status === 'submitting') return;
    if (!positionNeedsProposal(selectedPosition) || submittedPositionIds.has(selectedPosition.id))
      return;
    const action = warehouseCoverPrimaryAction(selectedTask, selectedPosition, selectedRollIds);
    setFeedback({ status: 'submitting', message: 'Отправляем предложение…' });
    const result = await executeWarehouseCoverProposal(
      {
        orderId: selectedTask.orderId,
        positionId: selectedPosition.id,
        rollIds: action.rollIds,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      },
      onPropose,
      onRefresh,
      submissionLock,
    );
    setFeedback(result);
    if (result.status === 'success') {
      const completed = new Set(submittedPositionIds);
      completed.add(selectedPosition.id);
      setSubmittedPositionIdsByTask((current) => ({
        ...current,
        [selectedTask.caseId]: [...completed],
      }));
      setSelectedPositionId(
        nextWarehouseCoverPositionId(selectedTask, selectedPosition.id, completed),
      );
      setSelectedRollIds([]);
      setComment('');
    }
  }

  function resolveRecheck(caseId: string, _result: WarehouseCoverageView) {
    setResolvedCaseIds((current) => (current.includes(caseId) ? current : [...current, caseId]));
    setLoadedRechecks((current) => current.filter((item) => item.caseId !== caseId));
    void Promise.resolve()
      .then(() => onRefresh())
      .catch(() => undefined);
  }

  if (coverageMode === 'loading') {
    return (
      <section
        className="warehouse-cover-tasks-panel"
        aria-label="Проверки покрытия заказов"
        aria-busy="true"
      >
        <header className="warehouse-cover-tasks-head">
          <div>
            <h3>Проверки покрытия</h3>
          </div>
        </header>
        <p className="warehouse-cover-empty" role="status">
          Загружаем проверки покрытия…
        </p>
      </section>
    );
  }

  const loadError = recheckLoadFailed && (
    <div className="warehouse-cover-load-error" role="alert">
      <span>Не удалось загрузить перепроверки покрытия.</span>
      <button
        type="button"
        className="action-secondary"
        onClick={() => setRecheckReloadVersion((current) => current + 1)}
      >
        Повторить
      </button>
    </div>
  );

  if (
    coverageMode === 'error' ||
    (recheckLoadFailed && tasks.length === 0 && availableRechecks.length === 0)
  ) {
    return (
      <section className="warehouse-cover-tasks-panel" aria-label="Проверки покрытия заказов">
        <header className="warehouse-cover-tasks-head">
          <div>
            <h3>Проверки покрытия</h3>
          </div>
        </header>
        {loadError}
      </section>
    );
  }

  if (tasks.length === 0 && availableRechecks.length === 0) return null;

  if (coverageMode === 'v2') {
    return (
      <section
        className="warehouse-cover-tasks-panel warehouse-cover-tasks-panel-v2"
        aria-label="Перепроверки покрытия заказов"
      >
        <header className="warehouse-cover-tasks-head">
          <div>
            <h3>Перепроверки покрытия</h3>
          </div>
          {tasks.length > 0 && (
            <button type="button" onClick={() => setCoverageMode('v1')}>
              Проверки заказов ({tasks.length})
            </button>
          )}
          {availableRechecks.length > 0 ? (
            <span className="warehouse-cover-action-badge">
              {availableRechecks.length} {taskCountLabel(availableRechecks.length)}
            </span>
          ) : null}
        </header>
        {loadError}
        {selectedRecheck ? (
          <div className="warehouse-coverage-recheck-layout">
            <div
              className="warehouse-coverage-recheck-queue"
              role="list"
              aria-label="Очередь перепроверок покрытия"
            >
              {availableRechecks.map((item) => (
                <button
                  key={item.caseId}
                  type="button"
                  role="listitem"
                  data-recheck-case-id={item.caseId}
                  className={item.caseId === selectedRecheck.caseId ? 'is-selected' : ''}
                  aria-pressed={item.caseId === selectedRecheck.caseId}
                  onClick={() => setSelectedRecheckCaseId(item.caseId)}
                >
                  <strong>{item.members.map((member) => member.rollCode).join(', ')}</strong>
                  <small>{item.members.length} рул. · перепроверить факты</small>
                </button>
              ))}
            </div>
            <WarehouseCoverageRecheckPanel
              key={`${selectedRecheck.caseId}:${selectedRecheck.caseVersion}`}
              item={selectedRecheck}
              onResolved={resolveRecheck}
            />
          </div>
        ) : (
          <p className="warehouse-cover-empty" role="status">
            Новых перепроверок покрытия нет.
          </p>
        )}
      </section>
    );
  }

  return (
    <>
      {loadError}
      {availableRechecks.length > 0 && (
        <button type="button" onClick={() => setCoverageMode('v2')}>
          Перепроверки ({availableRechecks.length})
        </button>
      )}
      <WarehouseCoverTasksPanelView
        tasks={tasks}
        freeRolls={freeRolls}
        selectedTaskId={selectedTask?.caseId ?? null}
        selectedPositionId={selectedPosition?.id ?? null}
        selectedRollIds={selectedRollIds}
        comment={comment}
        feedback={feedback}
        completedPositionIds={[...submittedPositionIds]}
        onSelectTask={selectTask}
        onSelectPosition={selectPosition}
        onToggleRoll={toggleRoll}
        onCommentChange={setComment}
        onSubmit={() => void submit()}
      />
    </>
  );
}

export function WarehouseCoverTasksPanelView({
  tasks,
  freeRolls,
  selectedTaskId,
  selectedPositionId,
  selectedRollIds,
  comment,
  feedback,
  completedPositionIds = [],
  onSelectTask,
  onSelectPosition,
  onToggleRoll,
  onCommentChange,
  onSubmit,
}: {
  tasks: WarehouseCoverTask[];
  freeRolls: WarehouseCoverFreeRoll[];
  selectedTaskId: string | null;
  selectedPositionId: string | null;
  selectedRollIds: string[];
  comment: string;
  feedback: WarehouseCoverFeedback;
  completedPositionIds?: string[];
  onSelectTask: (caseId: string) => void;
  onSelectPosition: (positionId: string) => void;
  onToggleRoll: (rollId: string) => void;
  onCommentChange: (comment: string) => void;
  onSubmit: () => void;
}) {
  const selectedTask = tasks.find((task) => task.caseId === selectedTaskId) ?? tasks[0];
  const selectedPosition =
    selectedTask?.positions.find((position) => position.id === selectedPositionId) ??
    selectedTask?.positions[0];
  const compatibleRolls = selectedPosition
    ? compatibleWarehouseCoverRolls(selectedPosition, freeRolls)
    : [];
  const action =
    selectedTask && selectedPosition
      ? warehouseCoverPrimaryAction(selectedTask, selectedPosition, selectedRollIds)
      : null;
  const busy = feedback.status === 'submitting';
  const completedPositionIdSet = new Set(completedPositionIds);
  const positionDone = selectedPosition
    ? !positionNeedsProposal(selectedPosition) || completedPositionIdSet.has(selectedPosition.id)
    : false;
  const selectedCount = action?.rollIds.length ?? 0;
  const productionCount = selectedPosition ? selectedPosition.rollCount - selectedCount : 0;

  return (
    <section
      className="warehouse-cover-tasks-panel"
      aria-label="Проверки покрытия заказов"
      aria-busy={busy}
      data-selected-task={selectedTask?.caseId}
    >
      <header className="warehouse-cover-tasks-head">
        <div>
          <h3>Проверки покрытия</h3>
        </div>
        {tasks.length > 0 ? (
          <span className="warehouse-cover-action-badge">
            {tasks.length} {taskCountLabel(tasks.length)}
          </span>
        ) : null}
      </header>

      {tasks.length === 0 ? (
        <p className="warehouse-cover-empty" role="status">
          Новых проверок покрытия нет.
        </p>
      ) : (
        <div className="warehouse-cover-tasks-layout">
          <div className="warehouse-cover-task-queue" role="list" aria-label="Очередь проверок">
            {tasks.map((task) => (
              <button
                key={task.caseId}
                type="button"
                role="listitem"
                className={task.caseId === selectedTask?.caseId ? 'is-selected' : ''}
                aria-pressed={task.caseId === selectedTask?.caseId}
                disabled={busy}
                onClick={() => onSelectTask(task.caseId)}
              >
                <span>
                  <strong>{task.orderNumber}</strong>
                  <small>{task.customerAlias}</small>
                </span>
                <span>
                  <small>{formatRequestedAt(task.requestedAt)}</small>
                  <b>Требует решения</b>
                </span>
              </button>
            ))}
          </div>

          {selectedTask && selectedPosition && action && (
            <div className="warehouse-cover-task-detail">
              <div className="warehouse-cover-task-summary">
                <span>
                  <small>Заказ</small>
                  <strong>{selectedTask.orderNumber}</strong>
                </span>
                <span>
                  <small>Клиент</small>
                  <strong>{selectedTask.customerAlias}</strong>
                </span>
                <span>
                  <small>Позиции</small>
                  <strong>{selectedTask.positions.length}</strong>
                </span>
                <span>
                  <small>Запрошено</small>
                  <strong>{formatRequestedAt(selectedTask.requestedAt)}</strong>
                </span>
              </div>

              <div
                className="warehouse-cover-position-tabs"
                role="tablist"
                aria-label="Позиции заказа"
              >
                {selectedTask.positions.map((position, index) => (
                  <button
                    key={position.id}
                    type="button"
                    role="tab"
                    aria-selected={position.id === selectedPosition.id}
                    disabled={busy}
                    onClick={() => onSelectPosition(position.id)}
                  >
                    Позиция {index + 1} · {position.rollCount} рул. ·{' '}
                    {positionNeedsProposal(position) && !completedPositionIdSet.has(position.id)
                      ? 'проверить'
                      : 'предложено'}
                  </button>
                ))}
              </div>

              <dl className="warehouse-cover-position-facts" aria-label="Параметры позиции">
                <div>
                  <dt>Пленка</dt>
                  <dd>{selectedPosition.filmType}</dd>
                </div>
                <div>
                  <dt>Толщина</dt>
                  <dd>{selectedPosition.actualThickness}</dd>
                </div>
                <div>
                  <dt>Шпуля</dt>
                  <dd>{selectedPosition.spoolType ?? 'не указана'}</dd>
                </div>
                <div>
                  <dt>Бирка</dt>
                  <dd>{selectedPosition.birka ?? 'не указана'}</dd>
                </div>
                <div>
                  <dt>Вес рулона</dt>
                  <dd>
                    {selectedPosition.plannedWeightKg === null
                      ? 'не указан'
                      : `${selectedPosition.plannedWeightKg} кг`}
                  </dd>
                </div>
              </dl>

              <fieldset className="warehouse-cover-rolls" disabled={busy}>
                <legend>Совместимый свободный резерв · {compatibleRolls.length}</legend>
                {compatibleRolls.length === 0 ? (
                  <p>Совместимых рулонов нет — позиция пойдет в производство.</p>
                ) : (
                  compatibleRolls.map((roll) => (
                    <label key={roll.id}>
                      <input
                        type="checkbox"
                        checked={selectedRollIds.includes(roll.id)}
                        onChange={() => onToggleRoll(roll.id)}
                      />
                      <span>
                        <strong>{roll.rollCode}</strong>
                        <small>
                          {roll.facts.filmType} · {roll.facts.actualThickness} ·{' '}
                          {roll.facts.spoolType} · {roll.facts.birka} · {roll.facts.plannedWeightKg}{' '}
                          кг
                        </small>
                      </span>
                    </label>
                  ))
                )}
              </fieldset>

              <dl className="warehouse-cover-route-summary" aria-label="Маршрут предложения">
                <div>
                  <dt>Со склада</dt>
                  <dd>{selectedCount} рул.</dd>
                </div>
                <div>
                  <dt>В производство</dt>
                  <dd>{productionCount} рул.</dd>
                </div>
              </dl>

              <label className="warehouse-cover-comment">
                <span>Комментарий склада</span>
                <textarea
                  value={comment}
                  maxLength={1000}
                  disabled={busy}
                  onChange={(event) => onCommentChange(event.target.value)}
                  placeholder="Необязательно"
                />
              </label>

              <div className="warehouse-cover-submit-row">
                <button
                  id={action.id}
                  type="button"
                  className="ix-button action-recommended"
                  data-cover-primary-action
                  disabled={busy || positionDone}
                  onClick={onSubmit}
                >
                  {positionDone ? 'Предложение уже отправлено' : action.label}
                </button>
                {feedback.status !== 'idle' && (
                  <p
                    className={`warehouse-cover-feedback is-${feedback.status}`}
                    role={feedback.status === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {feedback.message}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function normalizedText(value: string | null): string {
  return (value ?? '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}

function normalizedMeasurement(value: string | null): string {
  const numeric = value?.replace(',', '.').match(/\d+(?:\.\d+)?/)?.[0];
  return numeric ? Number(numeric).toString() : normalizedText(value);
}

function normalizedSpool(value: string | null): string {
  return normalizedText(value).replace(/^шпуля/, '');
}

function formatRequestedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(date);
}

function taskCountLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'требуют действия';
  return mod10 === 1 ? 'требует действия' : 'требуют действия';
}
