import type { ActionDescriptor, Role } from '../../domain/types';
import { actionGroups } from '../../domain/selectors';
import { actionDisplayLabel, actionIcon, actionTileMeta, disabledActionMeta } from './actionPresentation';
import { HelpTooltip } from './ActionPanel';

export type OfficeActionOutcome = {
  tone: 'success' | 'info' | 'warning' | 'critical';
  title: string;
  detail?: string;
};

type OfficeCommandBarProps = {
  role: Extract<Role, 'production' | 'finance'>;
  actions: ActionDescriptor[];
  outcome?: OfficeActionOutcome | null;
  onAction?: (actionId: string) => void;
};

function actionHelpText(action: ActionDescriptor) {
  if (action.helpText) return action.helpText;
  if (!action.enabled) return [action.disabledReason, action.recoveryAction].filter(Boolean).join('. ');
  if (action.confirmation) return action.confirmation;
  return actionTileMeta(action, actionDisplayLabel(action));
}

function commandClass(action: ActionDescriptor, level: 'primary' | 'secondary' | 'danger' | 'blocked') {
  const isDone = !action.enabled && /передано|возвращено|оплачено|закрыто|согласовано/i.test(action.label);
  return [
    'office-command-button',
    `office-command-${level}`,
    action.enabled ? '' : 'is-disabled',
    isDone ? 'action-success' : '',
  ].filter(Boolean).join(' ');
}

function CommandButton({
  action,
  level,
  onAction,
}: {
  action: ActionDescriptor;
  level: 'primary' | 'secondary' | 'danger' | 'blocked';
  onAction?: (actionId: string) => void;
}) {
  const label = actionDisplayLabel(action);
  const help = actionHelpText(action);
  const meta = action.enabled ? actionTileMeta(action, label) : disabledActionMeta(action);
  const accessibleLabel = help ? `${label}. ${help}` : label;

  return (
    <HelpTooltip text={help} focusable={false} className="office-command-help">
      <button
        className={commandClass(action, level)}
        disabled={!action.enabled}
        type="button"
        onClick={() => onAction?.(action.id)}
        title={help || undefined}
        aria-label={accessibleLabel}
      >
        <ix-icon name={actionIcon(action)} size={level === 'primary' ? '24' : '16'} />
        <span>
          <strong>{label}</strong>
          {meta && <small>{meta}</small>}
        </span>
      </button>
    </HelpTooltip>
  );
}

export function OfficeCommandBar({ role, actions, outcome, onAction }: OfficeCommandBarProps) {
  const groups = actionGroups(actions);
  const primaryActions = [...groups.primary, ...groups.peer];
  const secondaryActions = groups.secondary;

  return (
    <section className={`surface office-command-bar role-${role}`} aria-label="Действия по выбранной карточке">
      <div className="office-command-header">
        <div>
          <span className="eyebrow">Действия</span>
          <h3>{role === 'production' ? 'Заказ-наряд' : 'Финансы'}</h3>
        </div>
      </div>

      <div className="office-command-layout">
        <div className="office-command-primary-zone">
          {primaryActions.map((action) => (
            <CommandButton key={action.id} action={action} level="primary" onAction={onAction} />
          ))}
        </div>

        {secondaryActions.length > 0 && (
          <div className="office-command-secondary-zone">
            {secondaryActions.map((action) => (
              <CommandButton key={action.id} action={action} level="secondary" onAction={onAction} />
            ))}
          </div>
        )}

        {groups.destructive.length > 0 && (
          <div className="office-command-danger-zone">
            {groups.destructive.map((action) => (
              <CommandButton key={action.id} action={action} level="danger" onAction={onAction} />
            ))}
          </div>
        )}

        {groups.disabled.length > 0 && (
          <div className="office-command-blocker-zone">
            {groups.disabled.map((action) => (
              <CommandButton key={action.id} action={action} level="blocked" onAction={onAction} />
            ))}
          </div>
        )}
      </div>

      {outcome && (
        <div className={`office-action-outcome tone-${outcome.tone}`} role="status" aria-live="polite">
          <ix-icon name={outcome.tone === 'success' ? 'check' : outcome.tone === 'critical' ? 'warning' : 'info'} size="16" />
          <span>
            <strong>{outcome.title}</strong>
            {outcome.detail && <small>{outcome.detail}</small>}
          </span>
        </div>
      )}
    </section>
  );
}
