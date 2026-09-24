import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

import type { ServerProductionProblem } from '../../api/production';
import { trapFocusWithin } from '../shell/focusTrap';
import { SiemensIcon } from '../shell/SiemensIcon';

type ProblemType = ServerProductionProblem['type'];
type ProblemFilter = 'all' | ProblemType;
type ProductionProblemsSurfaceMode = 'production' | 'director';

const TYPE_LABEL: Record<ProblemType, string> = {
  defect: 'Брак рулона',
  machine_breakdown: 'Поломка станка',
  shift_balance_mismatch: 'Расхождение баланса смены',
  raw_material_shortage: 'Нехватка сырья',
  general: 'Проблема',
};

const TYPE_TONE: Record<ProblemType, 'critical' | 'warning' | 'info'> = {
  defect: 'critical',
  machine_breakdown: 'critical',
  shift_balance_mismatch: 'warning',
  raw_material_shortage: 'warning',
  general: 'info',
};

const FILTER_ORDER: ProblemFilter[] = [
  'all',
  'defect',
  'machine_breakdown',
  'shift_balance_mismatch',
  'raw_material_shortage',
  'general',
];

const ACTOR_LABEL: Record<string, string> = {
  operator: 'Оператор',
  warehouse: 'Склад',
  production_lead: 'Зав. производства',
  production: 'Зав. производства',
  director: 'Директор',
};

const WEIGHT_SOURCE_LABEL: Record<
  NonNullable<ServerProductionProblem['defectWeightSource']>,
  string
> = {
  operator_scale: 'Весы оператора',
  warehouse_control_scale: 'Контрольные весы склада',
  production_existing_scale: 'Весы производства',
  legacy_unverified: 'Legacy-вес без подтверждения',
};

function formatWhen(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatCapturedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defectWeightEvidence(problem: ServerProductionProblem) {
  const { defectWeightKg, defectWeightCapturedAt, defectWeightSource } = problem;
  if (
    typeof defectWeightKg !== 'number' ||
    !Number.isFinite(defectWeightKg) ||
    defectWeightKg <= 0 ||
    !defectWeightCapturedAt ||
    !defectWeightSource ||
    defectWeightSource === 'legacy_unverified'
  ) {
    return {
      confirmed: false,
      weightLabel: 'Вес не подтверждён',
      sourceLabel: defectWeightSource
        ? WEIGHT_SOURCE_LABEL[defectWeightSource]
        : 'Источник не указан',
      capturedAtLabel: defectWeightCapturedAt
        ? formatCapturedAt(defectWeightCapturedAt)
        : 'Время не зафиксировано',
    };
  }

  return {
    confirmed: true,
    weightLabel: `${defectWeightKg.toLocaleString('ru-RU', {
      maximumFractionDigits: 3,
    })} кг`,
    sourceLabel: WEIGHT_SOURCE_LABEL[defectWeightSource],
    capturedAtLabel: formatCapturedAt(defectWeightCapturedAt),
  };
}

function problemContext(problem: ServerProductionProblem): string {
  const parts: string[] = [];
  if (problem.order?.orderNumber) parts.push(`Заказ ${problem.order.orderNumber}`);
  if (problem.rollId) parts.push(`рулон ${problem.rollId}`);
  if (problem.post?.name) parts.push(problem.post.name);
  parts.push(`от: ${ACTOR_LABEL[problem.actorRole] ?? problem.actorRole}`);
  return parts.join(' · ');
}

export function ProductionProblemsSurface({
  problems,
  mode = 'production',
  selectedProblemId = null,
  busy = false,
  onResolveDefect,
  onResolveBreakdown,
  onResolveGeneral,
  onStartRepair,
  onCompleteRepair,
}: {
  problems: ServerProductionProblem[];
  mode?: ProductionProblemsSurfaceMode;
  selectedProblemId?: string | null;
  busy?: boolean;
  onResolveDefect?: (problemId: string) => Promise<void> | void;
  onResolveBreakdown?: (problemId: string, resolution: 'confirm' | 'reject') => void;
  onResolveGeneral?: (problemId: string, note: string) => Promise<void> | void;
  onStartRepair?: (postId: string) => void;
  onCompleteRepair?: (postId: string) => void;
}) {
  const readOnly = mode === 'director';
  const ownerLabel = readOnly ? 'Директор' : 'Зав. производства';
  const openCue = readOnly ? 'Открыть' : 'Решить';
  const [filter, setFilter] = useState<ProblemFilter>('all');
  const [activeProblemId, setActiveProblemId] = useState<string | null>(null);
  const [manualResolution, setManualResolution] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [dialogPending, setDialogPending] = useState(false);
  const selectedProblemElementRef = useRef<HTMLElement | null>(null);
  const focusedProblemIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const activeTriggerRef = useRef<HTMLButtonElement | null>(null);

  const openProblems = useMemo(
    () => problems.filter((problem) => problem.status === 'open'),
    [problems],
  );
  const selectedProblem = useMemo(
    () => problems.find((problem) => problem.id === selectedProblemId) ?? null,
    [problems, selectedProblemId],
  );
  const activeProblem = useMemo(
    () => problems.find((problem) => problem.id === activeProblemId) ?? null,
    [activeProblemId, problems],
  );
  const resolvedProblems = useMemo(() => {
    const resolved = problems.filter((problem) => problem.status === 'resolved');
    const visible = resolved.slice(0, 20);
    const selectedResolved = resolved.find((problem) => problem.id === selectedProblemId);
    if (!selectedResolved || visible.some((problem) => problem.id === selectedResolved.id)) {
      return visible;
    }
    return [...visible.slice(0, 19), selectedResolved];
  }, [problems, selectedProblemId]);
  const visibleOpen = useMemo(() => {
    const filtered = openProblems.filter((problem) => filter === 'all' || problem.type === filter);
    if (
      selectedProblem?.status !== 'open' ||
      filtered.some((problem) => problem.id === selectedProblem.id)
    ) {
      return filtered;
    }
    return [selectedProblem, ...filtered];
  }, [openProblems, filter, selectedProblem]);

  useEffect(() => {
    if (!selectedProblemId) {
      focusedProblemIdRef.current = null;
      return;
    }
    if (!selectedProblem || focusedProblemIdRef.current === selectedProblemId) return;
    const element = selectedProblemElementRef.current;
    if (!element) return;
    element.focus();
    focusedProblemIdRef.current = selectedProblemId;
  }, [selectedProblem, selectedProblemId]);

  useEffect(() => {
    if (!activeProblemId) return;
    if (!activeProblem || activeProblem.status !== 'open') setActiveProblemId(null);
  }, [activeProblem, activeProblemId]);

  useEffect(() => {
    if (!activeProblemId) return;
    setManualResolution('');
    setDialogError('');
    setDialogPending(false);
    if (typeof document === 'undefined') return;

    const appShell = document.querySelector<HTMLElement>('.app-shell');
    const hadInert = appShell?.hasAttribute('inert') ?? false;
    const previousAriaHidden = appShell?.getAttribute('aria-hidden') ?? null;
    appShell?.setAttribute('inert', '');
    appShell?.setAttribute('aria-hidden', 'true');
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frame);
      if (!hadInert) appShell?.removeAttribute('inert');
      if (previousAriaHidden === null) appShell?.removeAttribute('aria-hidden');
      else appShell?.setAttribute('aria-hidden', previousAriaHidden);
      window.requestAnimationFrame(() => {
        if (activeTriggerRef.current?.isConnected) {
          activeTriggerRef.current.focus();
          return;
        }
        document.querySelector<HTMLElement>('[data-dialog-focus-fallback]')?.focus();
      });
    };
  }, [activeProblemId]);

  const countByFilter = (value: ProblemFilter) =>
    value === 'all'
      ? openProblems.length
      : openProblems.filter((problem) => problem.type === value).length;

  function openProblem(problemId: string, trigger: HTMLButtonElement | null) {
    activeTriggerRef.current = trigger;
    setActiveProblemId(problemId);
  }

  function closeProblemDialog() {
    if (!dialogPending) setActiveProblemId(null);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeProblemDialog();
      return;
    }
    trapFocusWithin(event);
  }

  function handleDialogBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) closeProblemDialog();
  }

  async function resolveDefectProblem(problem: ServerProductionProblem) {
    if (!onResolveDefect || dialogPending) return;
    setDialogPending(true);
    setDialogError('');
    try {
      await onResolveDefect(problem.id);
      setActiveProblemId(null);
    } catch (error) {
      setDialogError(
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Проблема не решена. Повторите действие.',
      );
      setDialogPending(false);
    }
  }

  async function resolveManualProblem(problem: ServerProductionProblem) {
    const note = manualResolution.trim();
    if (!note || !onResolveGeneral || dialogPending) return;
    setDialogPending(true);
    setDialogError('');
    try {
      await onResolveGeneral(problem.id, note);
      setActiveProblemId(null);
    } catch (error) {
      setDialogError(
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Проблема не закрыта. Повторите действие.',
      );
      setDialogPending(false);
    }
  }

  const problemDialog = activeProblem?.status === 'open'
    ? (() => {
        const weightEvidence = defectWeightEvidence(activeProblem);
        const isManual =
          ['shift_balance_mismatch'].includes(activeProblem.type) ||
          (activeProblem.type === 'general' && !(activeProblem.positionId && activeProblem.rollId));
        const requiresCommercialCorrection =
          activeProblem.type === 'raw_material_shortage' ||
          (activeProblem.type === 'general' &&
            Boolean(activeProblem.positionId && activeProblem.rollId));
        const canRepairStart = activeProblem.post?.status === 'broken';
        const canRepairDone =
          activeProblem.post?.status === 'broken' || activeProblem.post?.status === 'maintenance';
        return (
          <div
            className="production-problem-dialog-backdrop"
            role="presentation"
            onMouseDown={handleDialogBackdrop}
          >
            <section
              ref={dialogRef}
              className={`production-problem-dialog severity-${TYPE_TONE[activeProblem.type]} ${readOnly ? 'is-readonly' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="production-problem-dialog-title"
              aria-describedby="production-problem-dialog-reason"
              aria-busy={dialogPending || undefined}
              tabIndex={-1}
              onKeyDown={handleDialogKeyDown}
            >
              <header className="production-problem-dialog-head">
                <div>
                  <span className="eyebrow">
                    {readOnly ? 'Просмотр проблемы' : 'Решение проблемы'}
                  </span>
                  <h2 id="production-problem-dialog-title">{TYPE_LABEL[activeProblem.type]}</h2>
                  <small>{problemContext(activeProblem)}</small>
                </div>
                <button
                  className="drawer-close-button"
                  type="button"
                  aria-label="Закрыть"
                  disabled={dialogPending}
                  onClick={closeProblemDialog}
                >
                  <SiemensIcon name="close" size="24" />
                </button>
              </header>

              <div className="production-problem-dialog-body">
                <p id="production-problem-dialog-reason">{activeProblem.reason}</p>
                <dl className="production-problem-dialog-facts">
                  <div>
                    <dt>Создана</dt>
                    <dd>{formatWhen(activeProblem.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Источник</dt>
                    <dd>{ACTOR_LABEL[activeProblem.actorRole] ?? activeProblem.actorRole}</dd>
                  </div>
                  <div>
                    <dt>Статус</dt>
                    <dd>Требует решения</dd>
                  </div>
                </dl>

                {activeProblem.type === 'defect' && (
                  <div
                    className={`production-problem-weight ${weightEvidence.confirmed ? 'is-confirmed' : 'is-unconfirmed'}`}
                    role="status"
                  >
                    <span>Физический вес брака</span>
                    <strong>{weightEvidence.weightLabel}</strong>
                    <small>
                      {weightEvidence.sourceLabel} · {weightEvidence.capturedAtLabel}
                    </small>
                    {!weightEvidence.confirmed && (
                      <em>Учёт веса не изменится при закрытии проблемы.</em>
                    )}
                  </div>
                )}

                {!readOnly && isManual && (
                  <label className="production-problem-dialog-note">
                    <span>Что сделано</span>
                    <textarea
                      value={manualResolution}
                      maxLength={1000}
                      rows={4}
                      placeholder="Коротко зафиксируйте результат"
                      disabled={dialogPending}
                      required
                      onChange={(event) => {
                        setManualResolution(event.currentTarget.value);
                        if (dialogError) setDialogError('');
                      }}
                    />
                    <small>{manualResolution.length}/1000</small>
                  </label>
                )}

                {!readOnly && requiresCommercialCorrection && (
                  <div className="production-problem-dialog-guidance" role="status">
                    <strong>Исправление выполняет коммерция</strong>
                    <span>
                      Изменение сырья или рецептуры должно пройти атомарную корректировку заказа.
                      Здесь проблема доступна для просмотра без опасного ручного закрытия.
                    </span>
                  </div>
                )}

                {!readOnly && dialogError && (
                  <div className="production-problem-dialog-error" role="alert">
                    {dialogError}
                  </div>
                )}
              </div>

              {!readOnly && (
                <footer className="production-problem-dialog-actions">
                  {activeProblem.type === 'defect' && (
                    <button
                      type="button"
                      className="action-recommended"
                      disabled={busy || dialogPending || !onResolveDefect}
                      onClick={() => resolveDefectProblem(activeProblem)}
                    >
                      {dialogPending ? 'Решаем…' : 'Решить'}
                    </button>
                  )}
                  {activeProblem.type === 'machine_breakdown' && (
                    <>
                      {canRepairStart && onStartRepair && activeProblem.post && (
                        <button
                          type="button"
                          className="action-peer"
                          disabled={busy}
                          onClick={() => {
                            onStartRepair(activeProblem.post!.id);
                            setActiveProblemId(null);
                          }}
                        >
                          В ремонт
                        </button>
                      )}
                      {canRepairDone && onCompleteRepair && activeProblem.post && (
                        <button
                          type="button"
                          className="action-recommended"
                          disabled={busy}
                          onClick={() => {
                            onCompleteRepair(activeProblem.post!.id);
                            setActiveProblemId(null);
                          }}
                        >
                          Отремонтирован
                        </button>
                      )}
                      <button
                        type="button"
                        className="action-destructive"
                        disabled={busy || !onResolveBreakdown}
                        onClick={() => {
                          onResolveBreakdown?.(activeProblem.id, 'reject');
                          setActiveProblemId(null);
                        }}
                      >
                        Отклонить заявку
                      </button>
                    </>
                  )}
                  {isManual && (
                    <button
                      type="button"
                      className="action-recommended"
                      disabled={
                        busy ||
                        dialogPending ||
                        !onResolveGeneral ||
                        manualResolution.trim().length === 0
                      }
                      onClick={() => resolveManualProblem(activeProblem)}
                    >
                      {dialogPending ? 'Закрываем…' : 'Закрыть проблему'}
                    </button>
                  )}
                </footer>
              )}
            </section>
          </div>
        );
      })()
    : null;

  return (
    <section
      className="surface production-problems-surface"
      aria-label={readOnly ? 'Проблемы производства для директора' : 'Проблемы производства'}
    >
      <header className="production-problems-head">
        <div>
          <span className="eyebrow">{ownerLabel}</span>
          <h2 tabIndex={-1} data-dialog-focus-fallback>
            <SiemensIcon name="warning" size="24" /> Проблемы
          </h2>
          <p>Брак, поломки станков, баланс смены и нехватка сырья в одном месте.</p>
        </div>
        <div className="production-problems-summary" aria-label="Открытых проблем">
          <strong>{openProblems.length}</strong>
          <span>открытых</span>
        </div>
      </header>

      <div className="production-problems-filters" role="tablist" aria-label="Фильтр проблем">
        {FILTER_ORDER.map((value) => {
          const count = countByFilter(value);
          if (value !== 'all' && count === 0) return null;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`production-problems-filter ${filter === value ? 'is-active' : ''}`}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'Все' : TYPE_LABEL[value]}
              <span className="production-problems-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {visibleOpen.length === 0 ? (
        <div className="production-problems-empty" role="status">
          <strong>Открытых проблем нет</strong>
          <small>Брак, поломки и расхождения появятся здесь по мере поступления.</small>
        </div>
      ) : (
        <ul className="production-problems-list">
          {visibleOpen.map((problem) => {
            const isSelected = problem.id === selectedProblemId;
            const weightEvidence = defectWeightEvidence(problem);
            return (
              <li
                key={problem.id}
                data-problem-id={problem.id}
                className={`production-problem-card severity-${TYPE_TONE[problem.type]} ${isSelected ? 'is-notification-selected' : ''}`}
              >
                <button
                  ref={
                    isSelected
                      ? (node) => {
                          selectedProblemElementRef.current = node;
                        }
                      : undefined
                  }
                  type="button"
                  className="production-problem-card-trigger"
                  data-problem-id={problem.id}
                  aria-current={isSelected ? 'true' : undefined}
                  aria-haspopup="dialog"
                  onClick={(event) => openProblem(problem.id, event?.currentTarget ?? null)}
                >
                  <span className="production-problem-card-main">
                    <span className="production-problem-card-head">
                      <span className={`production-problem-badge is-${TYPE_TONE[problem.type]}`}>
                        {TYPE_LABEL[problem.type]}
                      </span>
                      <time>{formatWhen(problem.createdAt)}</time>
                    </span>
                    <span className="production-problem-reason">{problem.reason}</span>
                    <small className="production-problem-context">{problemContext(problem)}</small>
                    {problem.type === 'defect' && (
                      <span
                        className={`production-problem-weight ${weightEvidence.confirmed ? 'is-confirmed' : 'is-unconfirmed'}`}
                      >
                        <span>Физический вес брака</span>
                        <strong>{weightEvidence.weightLabel}</strong>
                        <small>
                          {weightEvidence.sourceLabel} · {weightEvidence.capturedAtLabel}
                        </small>
                        {!weightEvidence.confirmed && (
                          <em>Учёт веса не изменится при закрытии проблемы.</em>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="production-problem-open-cue">
                    {openCue}
                    <SiemensIcon name="chevron-right-small" size="16" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {resolvedProblems.length > 0 && (
        <details
          className="production-problems-resolved"
          open={selectedProblem?.status === 'resolved' ? true : undefined}
        >
          <summary>Решённые ({resolvedProblems.length})</summary>
          <ul className="production-problems-resolved-list">
            {resolvedProblems.map((problem) => {
              const isSelected = problem.id === selectedProblemId;
              return (
                <li
                  key={problem.id}
                  ref={
                    isSelected
                      ? (node) => {
                          selectedProblemElementRef.current = node;
                        }
                      : undefined
                  }
                  data-problem-id={problem.id}
                  tabIndex={isSelected ? -1 : undefined}
                  aria-current={isSelected ? 'true' : undefined}
                  className={isSelected ? 'is-notification-selected' : undefined}
                >
                  <span className="production-problem-badge is-info">
                    {TYPE_LABEL[problem.type]}
                  </span>
                  <span className="production-problem-resolved-reason">{problem.reason}</span>
                  <span className="production-problem-resolved-meta">
                    {problem.recovery ? `${problem.recovery} · ` : ''}
                    {problem.resolvedAt ? formatWhen(problem.resolvedAt) : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {problemDialog &&
        (typeof document === 'undefined'
          ? problemDialog
          : createPortal(problemDialog, document.body))}
    </section>
  );
}
