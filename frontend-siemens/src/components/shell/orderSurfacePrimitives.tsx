import type { ReactNode } from 'react';

import type { ActionDescriptor, Role } from '../../domain/types';
import type { OrderSurfaceProjection, OrderSurfaceRouteItem } from '../../domain/orderSurfaceProjection';
import { ActionPanel } from './ActionPanel';
import { actionDisplayLabel, actionIcon, actionVisualLevel } from './actionPresentation';
import { SiemensIcon } from './SiemensIcon';

type OrderSurfaceProps = {
  projection: OrderSurfaceProjection;
  onAction?: (actionId: string) => void;
  children?: ReactNode;
};

const selfRoleLabels: Record<Role, string> = {
  commercial: 'Коммерция',
  production: 'Зав. производства',
  finance: 'Бухгалтерия',
  director: 'Директор',
  operator: 'Оператор',
  warehouse: 'Склад',
  admin: 'Админ',
};

function isSelfRoleLabel(role: Role, value?: string) {
  return Boolean(value && value.trim().toLocaleLowerCase('ru-RU') === selfRoleLabels[role].toLocaleLowerCase('ru-RU'));
}

export function OrderSurfaceFrame({ projection, onAction, children }: OrderSurfaceProps) {
  return (
    <section className={`surface order-surface role-${projection.role} tone-${projection.tone} severity-${projection.identity.severity}`} aria-label={`${projection.identity.eyebrow}: ${projection.identity.title}`}>
      <OrderObjectHeader projection={projection} />
      <OrderPrimaryAction projection={projection} onAction={onAction} />
      <OrderSecondaryActionGroup actions={projection.secondaryActions} onAction={onAction} />
      <OrderRouteStrip items={projection.route} />
      <OrderFactStrip projection={projection} />
      <OrderProblemBlock projection={projection} />
      {children}
    </section>
  );
}

export function OrderObjectHeader({ projection }: { projection: OrderSurfaceProjection }) {
  const { identity } = projection;
  const showOwner = !isSelfRoleLabel(projection.role, identity.owner);
  return (
    <header className="order-object-header">
      <div className="order-object-title">
        <h3>{identity.title}</h3>
        {identity.subtitle && <p>{identity.subtitle}</p>}
      </div>
      <div className="order-object-state">
        <span className={`order-state-badge severity-${identity.severity}`}>{identity.status}</span>
        {showOwner && <span>{identity.owner}</span>}
      </div>
    </header>
  );
}

export function OrderPrimaryAction({ projection, onAction }: { projection: OrderSurfaceProjection; onAction?: (actionId: string) => void }) {
  if (!projection.primaryAction) return null;

  const action = projection.primaryAction;
  const ownerLabel = action.owner ?? action.recoveryOwner;
  const showOwner = !isSelfRoleLabel(projection.role, ownerLabel);
  return (
    <section className={`order-primary-action severity-${projection.identity.severity}`} aria-label="Действие по заказу">
      <div className="order-primary-copy">
        <h4>{action.label}</h4>
        <div className="order-primary-meta">
          {action.affectedBlock && <span>Блок: {action.affectedBlock}</span>}
          {ownerLabel && showOwner && <span>Исправляет: {ownerLabel}</span>}
          {!action.enabled && action.disabledReason && <span>Причина: {action.disabledReason}</span>}
        </div>
      </div>
      <ActionPanel
        actions={[action]}
        title=""
        variant="default"
        embedded
        className="order-primary-action-panel"
        onAction={onAction}
      />
    </section>
  );
}

export function OrderRouteStrip({ items }: { items: OrderSurfaceRouteItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="order-route-strip" aria-label="Короткий статус заказа">
      {items.map((item) => (
        <div key={`${item.label}-${item.value}`} className={`order-route-item severity-${item.severity ?? 'info'}`}>
          {item.icon && <SiemensIcon name={item.icon} size="16" />}
          <span>{item.label}</span>
          <strong>{item.value}</strong>
          {item.meta && <small>{item.meta}</small>}
        </div>
      ))}
    </div>
  );
}

export function OrderFactStrip({ projection }: { projection: OrderSurfaceProjection }) {
  if (projection.facts.length === 0) return null;

  return (
    <dl className="order-fact-strip" aria-label="Ключевые факты роли">
      {projection.facts.map((fact) => (
        <div key={`${fact.label}-${fact.value}`}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OrderSecondaryActionGroup({ actions, onAction }: { actions: ActionDescriptor[]; onAction?: (actionId: string) => void }) {
  if (actions.length === 0) return null;

  return (
    <section className="order-secondary-actions" aria-label="Дополнительные действия по заказу">
      <span>Действия</span>
      <div>
        {actions.map((action) => (
          <button
            key={action.id}
            className={`compact-action-button action-${actionVisualLevel(action)}`}
            type="button"
            disabled={!action.enabled}
            aria-label={action.disabledReason ? `${actionDisplayLabel(action)}. ${action.disabledReason}` : actionDisplayLabel(action)}
            onClick={() => onAction?.(action.id)}
          >
            <SiemensIcon name={actionIcon(action)} size="16" />
            <span>{actionDisplayLabel(action)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function OrderProblemBlock({ projection }: { projection: OrderSurfaceProjection }) {
  const problem = projection.problem;
  if (!problem) return null;

  return (
    <section className={`order-problem-block severity-${problem.severity}`} aria-label="Проблема выбранного заказа">
      <span className="order-problem-mark"><SiemensIcon name="warning" size="16" /></span>
      <div>
        <span className="eyebrow">Проблема</span>
        <strong>{problem.title}</strong>
        {problem.reason && <p>{problem.reason}</p>}
      </div>
      <div className="order-problem-recovery">
        <span>{problem.ownerRole}</span>
        <strong>{problem.recovery}</strong>
        {problem.due && <small>{problem.due}</small>}
      </div>
    </section>
  );
}

export function OrderContentSection({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow?: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <section className="order-content-section">
      <header>
        <div>
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h4>{title}</h4>
        </div>
        {meta && <span>{meta}</span>}
      </header>
      {children}
    </section>
  );
}
