import { ReactNode } from 'react';

import { actionGroups } from '../../domain/selectors';
import type { ActionDescriptor } from '../../domain/types';
import { actionDisplayLabel, actionIcon, actionTileMeta, actionVisualLevel, disabledActionMeta } from './actionPresentation';

type HelpPlacement = 'top' | 'right' | 'bottom' | 'left';

export function HelpTooltip({
  text,
  children,
  focusable = true,
  className = '',
}: {
  text?: string;
  children: ReactNode;
  placement?: HelpPlacement;
  focusable?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`help-tooltip-target ${className}`.trim()}
      title={text || undefined}
      aria-label={text || undefined}
      tabIndex={text && focusable ? 0 : undefined}
    >
      {children}
    </span>
  );
}

function actionHelpText(action: ActionDescriptor) {
  if (action.helpText) return action.helpText;
  if (!action.enabled) {
    return `${action.disabledReason ?? 'Сначала нужен предыдущий шаг'}. ${action.recoveryAction ?? action.recoveryOwner ?? ''}`.trim();
  }
  if (action.level === 'destructive') return action.confirmation ?? 'Потребуется указать причину.';
  if (action.level === 'peer') return undefined;
  if (action.confirmation) return action.confirmation;
  if (action.id.includes('open-scans')) return 'Открыть связанный складской контекст без выполнения обычного складского сканирования.';
  if (action.label.includes('QR') || action.id.includes('scan')) return 'Правильный QR увеличит счетчик.';
  if (action.label.includes('вес') || action.id.includes('weight')) return 'Вес записывается только с подключенных весов.';
  if (action.label.includes('синхронизац')) return 'Еще раз проверить внешний источник.';
  if (action.label.includes('историю') || action.id.includes('history')) return 'Показать историю без изменения данных.';
  return undefined;
}

export function ActionPanel({
  actions,
  title = 'Действия',
  variant = 'default',
  embedded = false,
  className = '',
  onAction,
}: {
  actions: ActionDescriptor[];
  title?: string;
  variant?: 'default' | 'large';
  embedded?: boolean;
  className?: string;
  onAction?: (actionId: string) => void;
}) {
  const groups = actionGroups(actions);
  const isLarge = variant === 'large';

  return (
    <section className={`${embedded ? '' : 'surface'} action-surface ${isLarge ? 'large-actions' : ''} ${embedded ? 'embedded-action-surface' : ''} ${className}`.trim()}>
      {title && <h3>{title}</h3>}
      <div className="action-stack">
        <div className="primary-actions">
          {groups.primary.map((action) => (
            <ActionButton key={action.id} action={action} large={isLarge} onAction={onAction} />
          ))}
          {groups.peer.map((action) => (
            <ActionButton key={action.id} action={action} peer large={isLarge} onAction={onAction} />
          ))}
        </div>
        {groups.secondary.length > 0 && (
          <div className="secondary-actions">
            {groups.secondary.map((action) => (
              <ActionButton key={action.id} action={action} large={isLarge} onAction={onAction} />
            ))}
          </div>
        )}
        {groups.destructive.length > 0 && (
          <div className="destructive-actions">
            {groups.destructive.map((action) => (
              <ActionButton key={action.id} action={action} large={isLarge} onAction={onAction} />
            ))}
          </div>
        )}
        {groups.disabled.length > 0 && (
          <div className="disabled-actions">
            {groups.disabled.map((action) => (
              isLarge ? <ActionTile key={action.id} action={action} onAction={onAction} /> : <BlockedNextStep key={action.id} action={action} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BlockedNextStep({ action }: { action: ActionDescriptor }) {
  const help = actionHelpText(action);

  return (
    <div className="blocked-next-step" aria-label={`Недоступно: ${action.label}`} title={help}>
      <div className="blocked-label">
        <ix-icon name="close" size="24" />
        <strong>{action.label}</strong>
      </div>
      <div className="blocked-copy">
        <span>{action.disabledReason}</span>
        {action.recoveryAction && <small>{action.recoveryAction}</small>}
      </div>
    </div>
  );
}

function ActionButton({ action, peer = false, large = false, onAction }: { action: ActionDescriptor; peer?: boolean; large?: boolean; onAction?: (actionId: string) => void }) {
  if (large) return <ActionTile action={action} onAction={onAction} />;
  const help = actionHelpText(action);
  const accessibleLabel = help ? `${action.label}. ${help}` : action.label;

  return (
    <HelpTooltip text={help} focusable={false} className="action-help-frame">
      <button
        className={`compact-action-button action-${actionVisualLevel(action, peer)}`}
        disabled={!action.enabled}
        type="button"
        onClick={() => onAction?.(action.id)}
        title={help || undefined}
        aria-label={accessibleLabel}
      >
        <ix-icon name={actionIcon(action)} size="16" />
        <span>{actionDisplayLabel(action)}</span>
      </button>
    </HelpTooltip>
  );
}

function ActionTile({ action, onAction }: { action: ActionDescriptor; onAction?: (actionId: string) => void }) {
  const label = actionDisplayLabel(action);
  const meta = action.level === 'disabled' ? disabledActionMeta(action) : actionTileMeta(action, label);
  const help = actionHelpText(action);
  const accessibleLabel = help ? `${label}. ${help}` : label;

  return (
    <HelpTooltip text={help} focusable={false} className="action-help-frame">
      <button
        className={`action-tile action-${actionVisualLevel(action)}`}
        disabled={!action.enabled}
        type="button"
        onClick={() => onAction?.(action.id)}
        title={help || undefined}
        aria-label={accessibleLabel}
      >
        <ix-icon name={actionIcon(action)} size="32" />
        <span className="action-tile-text">
          <strong>{label}</strong>
          {meta && <small>{meta}</small>}
        </span>
      </button>
    </HelpTooltip>
  );
}
