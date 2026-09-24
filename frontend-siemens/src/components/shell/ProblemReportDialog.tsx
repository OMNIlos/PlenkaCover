import { useMemo, useRef, useState, type KeyboardEvent } from 'react';

import {
  problemReportPayload,
  problemTypeLabels,
  reportableEntityLabels,
} from '../../domain/problemReports';
import {
  isOperatorReportableProblemType,
  OPERATOR_REPORTABLE_PROBLEM_ROUTING,
  OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS,
  OPERATOR_REPORTABLE_PROBLEM_TYPES,
  type OperatorReportableProblemType,
} from '../../domain/operatorProblem';
import type { ProblemReportContext, ProblemReportDraft, ProblemReportPayload, ProblemType, ReportableEntityKind, Role, Severity } from '../../domain/types';
import { trapFocusWithin } from './focusTrap';

const problemTypes: ProblemType[] = [
  'production_change',
  'weight_deviation',
  'device_failure',
  'qr_exception',
  'warehouse_exception',
  'payment_issue',
  'source_sync',
  'inventory_conflict',
  'access_issue',
  'manual_review',
];

const entityKinds: ReportableEntityKind[] = [
  'order',
  'production_order',
  'position',
  'roll',
  'qr_label',
  'weight_device',
  'warehouse_acceptance',
  'warehouse_delivery',
  'payment',
  'invoice',
  'source',
  'inventory',
  'access',
  'admin_device',
  'problem',
];

const severityOptions: Severity[] = ['warning', 'critical', 'info'];

const roleLabels: Record<Role, string> = {
  commercial: 'Коммерция',
  production: 'Зав. производства',
  finance: 'Бухгалтерия',
  director: 'Директор',
  operator: 'Оператор',
  warehouse: 'Склад',
  admin: 'Админ',
};

function isCompactRole(role: Role) {
  return role === 'operator' || role === 'warehouse';
}

function isValidDraft(draft: ProblemReportDraft) {
  return Boolean(draft.entityId.trim()) && Boolean(draft.reason.trim()) && Boolean(draft.ownerRole.trim()) && Boolean(draft.due.trim());
}

type ProblemReportSubmit = (payload: ProblemReportPayload) => Promise<void> | void;

export type ProblemReportSubmissionLock = {
  current: Promise<void> | null;
};

export function executeProblemReportSubmission(
  payload: ProblemReportPayload,
  onSubmit: ProblemReportSubmit,
  lock: ProblemReportSubmissionLock,
): Promise<void> {
  if (lock.current) return lock.current;
  const request = (async () => {
    await onSubmit(payload);
  })().finally(() => {
      if (lock.current === request) lock.current = null;
  });
  lock.current = request;
  return request;
}

export function ProblemReportDialog({
  context,
  onCancel,
  onSubmit,
}: {
  context: ProblemReportContext;
  onCancel: () => void;
  onSubmit: ProblemReportSubmit;
}) {
  const [draft, setDraft] = useState<ProblemReportDraft>(context.draft);
  const [pending, setPending] = useState(false);
  const submissionLock = useRef<Promise<void> | null>(null);
  const compact = isCompactRole(context.role);
  const isOperatorProblem = context.role === 'operator' && context.actionId === 'operator-problem';
  const selectedOperatorProblemType = isOperatorReportableProblemType(draft.operatorProblemType)
    ? draft.operatorProblemType
    : 'general';
  const operatorProblemRouting = isOperatorProblem
    ? OPERATOR_REPORTABLE_PROBLEM_ROUTING[selectedOperatorProblemType]
    : null;
  const valid =
    isValidDraft(draft) &&
    (!isOperatorProblem || isOperatorReportableProblemType(draft.operatorProblemType));
  const payload = useMemo(() => problemReportPayload(context, draft), [context, draft]);

  function patch(next: Partial<ProblemReportDraft>) {
    if (pending) return;
    setDraft((current) => ({ ...current, ...next }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pending) return;
      onCancel();
      return;
    }
    trapFocusWithin(event);
  }

  function submit() {
    if (!valid || submissionLock.current) return;
    setPending(true);
    void executeProblemReportSubmission(payload, onSubmit, submissionLock)
      .catch(() => undefined)
      .finally(() => setPending(false));
  }

  return (
    <div className="problem-report-backdrop" role="presentation">
      <div
        className={`problem-report-dialog ${compact ? 'is-compact-role' : 'is-office-role'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="problem-report-title"
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="problem-report-header">
          <div>
            <span className="eyebrow">{roleLabels[context.role]}</span>
            <h2 id="problem-report-title">Сообщить проблему</h2>
          </div>
          <button className="drawer-close-button" type="button" onClick={onCancel} aria-label="Закрыть" disabled={pending}>
            <ix-icon name="close" size="24" />
          </button>
        </header>

        <div className="problem-report-body">
          <section className="problem-report-context" aria-label="Контекст проблемы">
            {context.readOnlyFacts.map((fact) => (
              <div key={`${fact.label}-${fact.value}`}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </div>
            ))}
          </section>

          {context.duplicateProblem && (
            <section className="problem-report-duplicate severity-warning" aria-label="Похожая открытая проблема">
              <div>
                <strong>Уже есть открытая проблема</strong>
                <span>{context.duplicateProblem.title} · {context.duplicateProblem.ownerRole}</span>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={draft.createLinkedDuplicate}
                  onChange={(event) => patch({ createLinkedDuplicate: event.target.checked })}
                />
                Создать новую связанную проблему
              </label>
              <button className="peer-button" type="button" onClick={onCancel}>Открыть существующую</button>
            </section>
          )}

          <form className="problem-report-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            {isOperatorProblem ? (
              <label>
                <span>Тип проблемы</span>
                <select
                  value={draft.operatorProblemType ?? 'general'}
                  disabled={pending}
                  onChange={(event) =>
                    patch({
                      operatorProblemType: event.target.value as OperatorReportableProblemType,
                    })
                  }
                >
                  {OPERATOR_REPORTABLE_PROBLEM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                <span>Тип проблемы</span>
                <select value={draft.type} onChange={(event) => patch({ type: event.target.value as ProblemType })} disabled={compact}>
                  {problemTypes.map((type) => <option key={type} value={type}>{problemTypeLabels[type]}</option>)}
                </select>
              </label>
            )}

            {!compact && (
              <>
                <label>
                  <span>Связанная сущность</span>
                  <select value={draft.entityKind} onChange={(event) => patch({ entityKind: event.target.value as ReportableEntityKind })}>
                    {entityKinds.map((kind) => <option key={kind} value={kind}>{reportableEntityLabels[kind]}</option>)}
                  </select>
                </label>
                <label>
                  <span>ID сущности</span>
                  <input value={draft.entityId} onChange={(event) => patch({ entityId: event.target.value })} />
                </label>
                <label>
                  <span>Ответственный</span>
                  <input value={draft.ownerRole} onChange={(event) => patch({ ownerRole: event.target.value })} readOnly={context.lockedTarget} />
                </label>
                <label>
                  <span>Срок реакции</span>
                  <input value={draft.due} onChange={(event) => patch({ due: event.target.value })} />
                </label>
                <label>
                  <span>Критичность</span>
                  <select value={draft.severity} onChange={(event) => patch({ severity: event.target.value as Severity })}>
                    {severityOptions.map((severity) => <option key={severity} value={severity}>{severity}</option>)}
                  </select>
                </label>
              </>
            )}

            {context.lockedTarget && (
              <div className="problem-report-locked-target">
                <ix-icon name="lock-key" size="16" />
                <span>
                  Цель зафиксирована:{' '}
                  {operatorProblemRouting?.ownerLabel ??
                    (context.draft.targetRole
                      ? roleLabels[context.draft.targetRole]
                      : draft.ownerRole)}
                </span>
              </div>
            )}

            <label className="problem-report-reason">
              <span>Описание проблемы</span>
              <textarea
                value={draft.reason}
                onChange={(event) => patch({ reason: event.target.value })}
                placeholder="Что произошло и какой шаг заблокирован"
                rows={4}
              />
            </label>
          </form>

          <section className="problem-report-next" aria-label="Следующий шаг">
            <span>После отправки</span>
            <strong>{operatorProblemRouting?.recovery ?? context.recovery}</strong>
          </section>
        </div>

        <footer className="problem-report-actions">
          <button className="peer-button" type="button" onClick={onCancel} disabled={pending}>Отмена</button>
          <button className="primary-button" type="button" disabled={pending || !valid || (Boolean(context.duplicateProblem) && !draft.createLinkedDuplicate)} onClick={submit}>
            {pending ? 'Отправляем…' : 'Отправить проблему'}
          </button>
        </footer>
      </div>
    </div>
  );
}
