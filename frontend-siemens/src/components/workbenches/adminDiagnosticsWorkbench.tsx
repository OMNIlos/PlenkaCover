import type { ActionDescriptor, AdminWorkbench, WorkObject } from '../../domain/types';
import { ActionPanel } from '../shell/ActionPanel';
import { AuditPanel, FactList, StepIllustration } from '../shell/viewPrimitives';
import type { IllustrationKind } from '../shell/viewPrimitives';

function adminIllustrationKind(workbench: AdminWorkbench): IllustrationKind {
  if (workbench.entityType === 'device' && workbench.prompt.toLowerCase().includes('принтер')) return 'printer';
  if (workbench.entityType === 'device') return 'admin';
  if (workbench.entityType === 'access') return 'manual';
  if (workbench.entityType === 'source') return 'manual';
  return 'order';
}

function adminEntityLabel(entityType: AdminWorkbench['entityType']) {
  if (entityType === 'access') return 'Доступы';
  if (entityType === 'roleTemplate') return 'Шаблон роли';
  if (entityType === 'source') return 'Интеграция';
  return 'Устройство';
}

function adminWorkbenchTitle(entityType: AdminWorkbench['entityType']) {
  if (entityType === 'access') return 'Управление доступом';
  if (entityType === 'roleTemplate') return 'Шаблон роли';
  if (entityType === 'source') return 'Связь с 1С';
  return 'Диагностика устройства';
}

function adminBlockerCopy(workbench: AdminWorkbench, object: WorkObject) {
  return workbench.blockingReason ?? object.problems.find((problem) => problem.status === 'open')?.title ?? 'Блокеров нет';
}

function mainAction(actions: ActionDescriptor[]) {
  return actions.find((action) => action.enabled && action.level === 'recommended')
    ?? actions.find((action) => action.enabled && action.level === 'peer')
    ?? actions.find((action) => action.enabled)
    ?? actions[0];
}

function hasProblemAction(actions: ActionDescriptor[]) {
  return actions.some((action) => action.id === 'problem' || action.id.startsWith('problem-'));
}

function isProblemAction(action: ActionDescriptor) {
  return action.id === 'problem' || action.id.startsWith('problem-');
}

function isHistoryAction(action?: ActionDescriptor) {
  return Boolean(action?.id.startsWith('admin-history:'));
}

function isRoutineDiagnosticAction(action: ActionDescriptor | undefined, checkTone: WorkObject['severity'], hasBlockingContext: boolean, hasOpenProblem: boolean) {
  if (!action || checkTone !== 'info' || hasBlockingContext || hasOpenProblem) return false;
  return action.id.startsWith('admin.device.tested:')
    || action.id === 'admin-retry-source-health'
    || action.id === 'admin-save-user-role'
    || action.id.startsWith('admin-template-save-');
}

function compactAdminText(text: string) {
  return text
    .replace(/^Источник в норме:\s*/i, '')
    .replace(/^Устройство:\s*/i, '')
    .replace(/; тест записан/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueFacts(facts: Array<{ label: string; value: string }>) {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.label}:${fact.value}`;
    if (!fact.value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function AdminWorkbenchView({
  object,
  workbench,
  onAction,
}: {
  object: WorkObject;
  workbench: AdminWorkbench;
  onAction?: (actionId: string) => void;
}) {
  const hasBlockingContext = Boolean(workbench.blockingReason || workbench.recovery);
  const checkTone: WorkObject['severity'] = workbench.checks.some((check) => check.severity === 'critical')
    ? 'critical'
    : workbench.checks.some((check) => check.severity === 'warning')
      ? 'warning'
      : 'info';
  const shortError = workbench.blockingReason ?? object.problems.find((problem) => problem.status === 'open')?.title ?? workbench.testResult;
  const blockerCopy = adminBlockerCopy(workbench, object);
  const hasOpenProblem = object.problems.some((problem) => problem.status === 'open');
  const primaryAction = mainAction(object.actions);
  const primaryIsHistory = isHistoryAction(primaryAction);
  const isHistorySurface = object.id === 'ADM-HISTORY-01';
  const shouldPromotePrimary = Boolean(primaryAction)
    && !primaryIsHistory
    && !isRoutineDiagnosticAction(primaryAction, checkTone, hasBlockingContext, hasOpenProblem);
  const promotedAction = shouldPromotePrimary ? primaryAction : undefined;
  const serviceActions = isHistorySurface
    ? []
    : object.actions
        .filter((action) => action.id !== promotedAction?.id)
        .filter((action) => !(hasOpenProblem && isProblemAction(action)));
  const now = workbench.now ?? workbench.status;
  const why = workbench.why ?? blockerCopy;
  const after = workbench.after ?? workbench.nextEffect ?? 'Результат пишется в историю админа без выполнения производственного действия.';
  const headerEntityLabel = isHistorySurface ? 'Журнал админа' : adminEntityLabel(workbench.entityType);
  const headerTitle = isHistorySurface ? 'Проблемы и история действий' : adminWorkbenchTitle(workbench.entityType);
  const keyLabel = workbench.entityType === 'source'
    ? '1С'
    : workbench.entityType === 'device'
      ? 'Устройство'
      : workbench.entityType === 'access'
        ? 'Доступ'
        : 'Шаблон';
  const keyTitle = hasOpenProblem ? compactAdminText(shortError) : compactAdminText(workbench.status);
  const keyMeta = hasOpenProblem
    ? compactAdminText(why)
    : workbench.lastSeen
      ? `Связь: ${workbench.lastSeen}`
      : compactAdminText(now);
  const briefFacts = uniqueFacts(
    workbench.entityType === 'source'
      ? [
          { label: 'Система', value: object.title },
          { label: 'Владелец', value: workbench.owner },
          { label: 'Снимок', value: workbench.lastSeen },
          { label: 'Статус', value: compactAdminText(hasOpenProblem ? shortError : workbench.testResult) },
        ]
      : [
          { label: 'Объект', value: object.title },
          { label: 'Владелец', value: workbench.owner },
          { label: 'Результат', value: compactAdminText(workbench.testResult) },
          { label: 'Статус', value: compactAdminText(hasOpenProblem ? shortError : workbench.status) },
        ]
  ).slice(0, 4);
  const evidenceFacts = workbench.evidence && workbench.evidence.length > 0
    ? workbench.evidence
    : [
        { label: 'Ответственный', value: workbench.owner },
        { label: 'Последняя проверка', value: workbench.lastSeen },
        { label: 'Результат', value: workbench.testResult },
      ];
  const detailsSummary = isHistorySurface ? 'Журнал и диагностика' : 'Служебные детали';

  return (
    <section className={`surface admin-diagnostics admin-${workbench.entityType}`}>
      <div className="admin-diagnostics-header">
        <div className="workbench-visual-row">
          <StepIllustration kind={adminIllustrationKind(workbench)} label={`Администрирование: ${workbench.prompt}`} tone={checkTone} />
          <div>
            <span className="eyebrow">{headerEntityLabel}</span>
            <h3>{headerTitle}</h3>
          </div>
        </div>
        <span className={`admin-state-badge ${isHistorySurface ? 'is-muted' : ''}`} title="Итог диагностики: влияет на доступность действий восстановления и привязки.">
          {isHistorySurface ? 'Журнал' : workbench.status}
        </span>
      </div>

      <section className={`admin-keyline admin-primary-safe-action severity-${checkTone}`} aria-label="Главный факт">
        <div>
          <span>{keyLabel}</span>
          <strong>{keyTitle}</strong>
          <small>{keyMeta}</small>
        </div>
        {promotedAction && (
          <button
            className={`compact-action-button action-${promotedAction.enabled ? 'recommended' : 'disabled'}`}
            type="button"
            disabled={!promotedAction.enabled}
            onClick={() => onAction?.(promotedAction.id)}
            title={promotedAction.helpText ?? promotedAction.recoveryAction ?? promotedAction.label}
          >
            <ix-icon name="check" size="16" />
            <span>{promotedAction.label}</span>
          </button>
        )}
        {!promotedAction && serviceActions.length > 0 && (
          <button
            className="compact-action-button action-secondary"
            type="button"
            onClick={(event) => {
              const details = event.currentTarget.closest('.admin-diagnostics')?.querySelector<HTMLDetailsElement>('.admin-service-details');
              if (details) {
                details.open = true;
                details.scrollIntoView({ block: 'nearest' });
              }
            }}
          >
            <ix-icon name="tasks-open" size="16" />
            <span>Открыть действия</span>
          </button>
        )}
      </section>

      <dl className="admin-brief-grid" aria-label="Ключевые факты">
        {briefFacts.map((fact) => (
          <div key={`${fact.label}-${fact.value}`}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <details className="admin-service-details admin-diagnostics-details">
        <summary>{detailsSummary}</summary>
        {serviceActions.length > 0 && (
          <ActionPanel actions={serviceActions} title="" variant="default" embedded className="admin-actions" onAction={onAction} />
        )}
        {hasBlockingContext && (
          <div className={`admin-recovery-card severity-${workbench.checks.some((check) => check.severity === 'critical') ? 'critical' : 'warning'}`}>
            <strong>{workbench.blockingReason ?? 'Требуется действие администратора'}</strong>
            <span>{workbench.recovery}</span>
          </div>
        )}
        <div className="admin-diagnostic-grid">
          <section className="admin-diagnostic-panel">
            <h4>Диагностика</h4>
            <FactList
              facts={[
                { label: 'Статус', value: workbench.status },
                { label: 'Последняя связь', value: workbench.lastSeen },
                { label: 'Результат теста', value: workbench.testResult },
                { label: 'Ответственный', value: workbench.owner },
              ]}
            />
          </section>
          <section className="admin-diagnostic-panel">
            <h4>Что система поняла</h4>
            <FactList facts={workbench.parsedRows} />
          </section>
        </div>
        {workbench.nextEffect && (
          <div className="admin-next-effect">
            <span>Что изменится</span>
            <strong>{workbench.nextEffect}</strong>
          </div>
        )}
        <FactList facts={evidenceFacts} />
        <FactList facts={workbench.rawRows} />
        <AuditPanel objectTitle={object.title} audit={object.audit} />
      </details>
    </section>
  );
}
