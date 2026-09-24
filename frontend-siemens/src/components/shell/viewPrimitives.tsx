export type IllustrationKind = 'scale' | 'roll' | 'qr' | 'warehouse' | 'printer' | 'manual' | 'stop' | 'admin' | 'handover' | 'order';


import { IxPill } from '@siemens/ix-react';

import { severityLabel, severityTone } from '../../domain/copy';
import { visibleAuditActionLabel } from '../../domain/displayContracts';
import type { ActionDescriptor, Fact, ProblemCase, Role, WorkObject } from '../../domain/types';

function severityHelp(severity: WorkObject['severity']) {
  if (severity === 'critical') return 'Критично: действие или закрытие процесса заблокировано до разбора причины.';
  if (severity === 'warning') return 'Требует внимания: можно продолжать только если блокер не мешает следующему шагу.';
  return 'В норме: строка не содержит открытого блокера для текущей роли.';
}

export function visibleAuditAction(actionLabel: string) {
  return visibleAuditActionLabel(actionLabel);
}

export function factHelpText(fact: Fact) {
  if (fact.helpText) return fact.helpText;
  const label = fact.label.toLowerCase();
  const value = fact.value.toLowerCase();

  if (label.includes('источник')) return 'Откуда пришли данные.';
  if (label.includes('шаблон')) return 'Типовые параметры клиента.';
  if (label.includes('ответственный') || label.includes('владелец')) return 'Кто должен продолжить работу.';
  if (label.includes('блокер') || value.includes('заблок')) return 'Что мешает нажать действие.';
  if (label.includes('синхронизация')) return 'Проверка внешних данных.';
  if (label.includes('рассрочка')) return 'Срок после выдачи со склада.';
  if (label.includes('последняя связь')) return 'Когда источник отвечал последний раз.';
  if (label.includes('результат теста')) return 'Последняя проверка.';
  if (label.includes('разобранные данные')) return 'Что система поняла из ответа.';
  if (label.includes('счетчик')) return 'Считаются только правильные QR.';
  if (label.includes('последний скан') || label.includes('последний qr')) return 'Последний считанный код.';
  if (label.includes('не хватает') || label.includes('лишние')) return 'Расхождение с планом.';
  if (label.includes('рабочее место')) return 'Где выполняется работа.';
  return undefined;
}

function illustrationIcon(kind: IllustrationKind) {
  const icons: Record<IllustrationKind, string> = {
    scale: 'scale',
    roll: 'package',
    qr: 'qr-code',
    warehouse: 'box-open',
    printer: 'print',
    manual: 'hand',
    stop: 'stop',
    admin: 'factory-reset',
    handover: 'truck',
    order: 'tasks-open',
  };
  return icons[kind];
}

export function StepIllustration({
  kind,
  label,
  tone = 'info',
}: {
  kind: IllustrationKind;
  label: string;
  tone?: WorkObject['severity'];
}) {
  return (
    <div className={`step-illustration tone-${tone}`} title={label} aria-label={label}>
      <ix-icon name={illustrationIcon(kind)} size="32" />
    </div>
  );
}

function compactSeverityLabel(severity: WorkObject['severity']) {
  if (severity === 'warning') return 'Внимание';
  if (severity === 'critical') return 'Критично';
  return 'Норма';
}

export function FactList({ facts }: { facts: Fact[] }) {
  if (facts.length === 0) return <p className="muted">Нет доступных полей для роли.</p>;
  return (
    <dl className="fact-list">
      {facts.map((fact) => {
        return (
          <div key={`${fact.label}-${fact.value}`} className="fact-row">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function firstUsefulAction(actions: ActionDescriptor[]) {
  return actions.find((action) => action.enabled && action.level === 'recommended')
    ?? actions.find((action) => action.enabled && action.level === 'peer')
    ?? actions.find((action) => action.enabled && action.level === 'secondary')
    ?? actions.find((action) => action.level === 'disabled')
    ?? actions[0];
}

function actionFirstObjectLabel(role: Role, object: WorkObject) {
  return factValue(object, 'Номер')
    ?? factValue(object, 'Объект')
    ?? factValue(object, 'Заказ')
    ?? factValue(object, 'Заявка')
    ?? (role === 'admin' ? factValue(object, 'Email') ?? factValue(object, 'Устройство') : undefined)
    ?? object.title;
}

function actionFirstDecisionLabel(object: WorkObject, actions: ActionDescriptor[]) {
  const openProblem = object.problems.find((problem) => problem.status === 'open');
  const action = firstUsefulAction(actions);
  return openProblem?.recovery
    ?? factValue(object, 'Что решить')
    ?? factValue(object, 'Следующий шаг')
    ?? action?.label
    ?? object.statusLabel;
}

function actionFirstRiskLabel(object: WorkObject) {
  const openProblem = object.problems.find((problem) => problem.status === 'open');
  if (openProblem) return openProblem.title;
  return factValue(object, 'Риск')
    ?? factValue(object, 'Блокер')
    ?? factValue(object, 'Состояние')
    ?? (object.severity === 'info' ? 'Нет блокера' : object.statusLabel);
}

export function ActionFirstSummary({
  role,
  object,
  actions = object.actions,
  className = '',
}: {
  role: Role;
  object: WorkObject;
  actions?: ActionDescriptor[];
  className?: string;
}) {
  const openProblem = object.problems.find((problem) => problem.status === 'open');
  const items: Array<{ label: string; value: string; tone?: WorkObject['severity'] }> = [
    { label: 'Объект', value: actionFirstObjectLabel(role, object) },
    { label: 'Действие', value: actionFirstDecisionLabel(object, actions) },
    { label: 'Риск', value: actionFirstRiskLabel(object), tone: object.severity },
    { label: 'Владелец', value: openProblem?.ownerRole ?? object.nextOwner },
  ];

  return (
    <section className={`surface action-first-summary ${className}`.trim()} aria-label="Действие сейчас">
      <div className="action-first-heading">
        <span className="eyebrow">Действие</span>
        <strong>{object.statusLabel}</strong>
      </div>
      <div className="action-first-grid">
        {items.map((item) => (
          <div key={`${item.label}-${item.value}`} className={item.tone ? `tone-${item.tone}` : undefined}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function RoleEvidenceStrip({ role, object }: { role: Role; object: WorkObject }) {
  const items = evidenceItems(role, object);
  if (items.length === 0) return null;

  return (
    <section className={`surface evidence-strip evidence-${role}`} aria-label="Ключевые индикаторы">
      <div className="evidence-heading">
        <span className="eyebrow">{evidenceTitle(role)}</span>
        <strong>{object.statusLabel}</strong>
      </div>
      <div className="evidence-grid">
        {items.map((item) => (
          <div key={`${item.label}-${item.value}`} className={`evidence-item ${item.tone ? `tone-${item.tone}` : ''}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function evidenceTitle(role: Role) {
  if (role === 'commercial') return 'Полнота заявки';
  if (role === 'production') return 'Проверка производства';
  if (role === 'finance') return 'Финансовый контроль';
  if (role === 'director') return 'На чем основано';
  if (role === 'admin') return 'Диагностика';
  return 'Ключевые индикаторы';
}

function factValue(object: WorkObject, label: string) {
  const direct = object.facts.find((fact) => fact.label === label)?.value;
  if (direct) return direct;
  return object.sections.flatMap((section) => section.facts).find((fact) => fact.label === label)?.value;
}

export function evidenceItems(role: Role, object: WorkObject): Array<Fact & { tone?: 'critical' | 'warning' | 'ok' }> {
  const openProblem = object.problems.find((problem) => problem.status === 'open');
  const byLabel = (label: string) => object.facts.find((fact) => fact.label === label)?.value;
  const itemTone = object.severity === 'critical' ? 'critical' : object.severity === 'warning' ? 'warning' : 'ok';

  if (role === 'commercial') {
    return [
      { label: 'Контрагент', value: byLabel('Контрагент') ?? 'Не указан', tone: byLabel('Контрагент') ? 'ok' : 'warning' },
      { label: 'Позиции', value: byLabel('Позиции') ?? 'Не заполнены', tone: byLabel('Позиции') ? 'ok' : 'warning' },
      { label: 'Блокер', value: openProblem?.recovery ?? byLabel('Полнота') ?? 'Нет', tone: openProblem ? itemTone : 'ok' },
    ];
  }

  if (role === 'production') {
    const positionsValue = factValue(object, 'Позиции') ?? factValue(object, 'Пленка') ?? factValue(object, 'Рулоны');
    const machineValue = factValue(object, 'Станок');
    return [
      { label: 'Позиции', value: positionsValue ?? 'Не заполнены', tone: positionsValue ? 'ok' : 'warning' },
      { label: 'Станок', value: machineValue ?? 'Не выбран', tone: machineValue ? 'ok' : 'warning' },
      { label: 'Готовность', value: openProblem?.title ?? object.statusLabel, tone: openProblem ? itemTone : 'ok' },
    ];
  }

  if (role === 'finance') {
    return [
      { label: 'Сумма', value: byLabel('Сумма') ?? 'Не рассчитана', tone: byLabel('Сумма') ? itemTone : 'warning' },
      { label: 'Статус', value: byLabel('Статус оплаты') ?? byLabel('Статус счета') ?? object.statusLabel, tone: itemTone },
      { label: byLabel('Дата оплаты') ? 'Дата оплаты' : 'Источник', value: byLabel('Дата оплаты') ?? byLabel('Источник данных') ?? 'История объекта', tone: byLabel('Дата оплаты') && (object.statusLabel === 'Оплата сегодня' || object.statusLabel === 'К оплате') ? 'warning' : 'ok' },
    ];
  }

  if (role === 'director') {
    return [
      { label: 'Решение', value: object.statusLabel, tone: itemTone },
      { label: 'Риск', value: openProblem?.title ?? 'Нет блокера', tone: openProblem ? itemTone : 'ok' },
      { label: 'Кто дальше', value: object.nextOwner, tone: 'ok' },
    ];
  }

  if (role === 'admin') {
    const isSource = object.workbench?.type === 'admin' && object.workbench.entityType === 'source';
    return [
      { label: 'Статус', value: object.statusLabel, tone: itemTone },
      { label: isSource ? 'Источник' : 'Доступ', value: byLabel('Шаблон роли') ?? byLabel('Email') ?? byLabel('Устройство') ?? byLabel('Источник данных') ?? 'Админ', tone: itemTone },
      { label: isSource ? 'Ошибка источника' : 'Ошибка', value: byLabel(isSource ? 'Ошибка источника' : 'Ошибка устройства') ?? openProblem?.title ?? 'Нет', tone: openProblem ? itemTone : 'ok' },
    ];
  }

  return object.facts.slice(0, 3).map((fact) => ({ ...fact, tone: itemTone }));
}

export function largeActionVariant(role: Role, object: WorkObject): 'default' | 'large' {
  if (['operator', 'director', 'warehouse'].includes(role)) return 'large';
  if (role === 'admin') return 'default';
  if (object.severity === 'critical') return 'large';
  return 'default';
}

function CompactContext({ object }: { object: WorkObject }) {
  const openProblems = object.problems.filter((problem) => problem.status === 'open');
  const primaryProblem = openProblems[0];
  const lastAudit = object.audit[0];

  return (
    <section className={`surface compact-context ${primaryProblem ? `severity-${primaryProblem.severity}` : ''}`} aria-label="Что мешает и что уже сделали">
      <div className="context-title">
        <h3>Что мешает</h3>
        <IxPill>{openProblems.length}</IxPill>
      </div>
      {primaryProblem ? (
        <div className="compact-problem">
          <span className="eyebrow">{primaryProblem.stage}</span>
          <strong>{primaryProblem.title}</strong>
          <p>{primaryProblem.recovery}</p>
        </div>
      ) : (
        <p className="muted">Нет блокирующих проблем.</p>
      )}
      {lastAudit && (
        <div className="compact-audit">
          <time>{lastAudit.time}</time>
          <strong>{visibleAuditAction(lastAudit.actionLabel)}</strong>
          <span>{lastAudit.detail}</span>
        </div>
      )}
    </section>
  );
}

export function ContextPanel({ object }: { object: WorkObject | null }) {
  if (!object) {
    return (
      <section className="context-empty">
        <h3>Контекст</h3>
        <p>После выбора строки здесь будет видно, что мешает и что уже сделали.</p>
      </section>
    );
  }

  const warehouseAuditIds = new Set([
    object.id,
    object.materialReceivingGate?.id,
    object.materialReceivingGate?.materialId,
    object.materialReceivingGate?.materialLabel,
  ].filter(Boolean));
  const visibleAudit = object.kind === 'warehouseJob'
    ? object.audit.filter((entry) =>
        warehouseAuditIds.has(entry.objectId)
        || (entry.sourceSnapshot ? warehouseAuditIds.has(entry.sourceSnapshot) : false)
        || entry.scope === 'warehouse'
      )
    : object.audit;
  const defaultAuditOpen = object.kind === 'warehouseJob' && (
    visibleAudit.length > 0
    || Boolean(object.filterTags?.some((tag) => tag === 'Закрытые' || tag === 'Завершены' || tag === 'Завершенные'))
  );

  return (
    <div className="context-stack">
      <ProblemsPanel problems={object.problems} />
      <AuditPanel key={object.id} objectTitle={object.title} audit={visibleAudit} excludePositionTemplateAudit={object.kind === 'warehouseJob'} defaultOpen={defaultAuditOpen} />
    </div>
  );
}

export function InlineContextPanel({ object }: { object: WorkObject }) {
  const openProblems = object.problems.filter((problem) => problem.status === 'open').length;
  const defaultOpen = object.kind === 'warehouseJob' && (
    openProblems > 0
    || Boolean(object.filterTags?.some((tag) => tag === 'Закрытые' || tag === 'Завершены' || tag === 'Завершенные'))
  );
  return (
    <details className="inline-context-details" open={defaultOpen}>
      <summary>
        <span>Проблемы и история</span>
        {openProblems > 0 && <IxPill>{openProblems}</IxPill>}
      </summary>
      <ContextPanel object={object} />
    </details>
  );
}

export function ProblemsPanel({ problems }: { problems: ProblemCase[] }) {
  const openProblems = problems.filter((problem) => problem.status === 'open');
  if (openProblems.length === 0) return null;

  return (
    <section className="surface context-card">
      <div className="context-title">
        <h3>Проблемы</h3>
        <IxPill>{openProblems.length}</IxPill>
      </div>
      <div className="problem-stack">
        {openProblems.map((problem) => (
          <article key={problem.id} className={`problem-card severity-${problem.severity}`}>
            <div>
              <span className="eyebrow">{problem.stage}</span>
              <h4>{problem.title}</h4>
            </div>
            <p>{problem.reason}</p>
            <div className="problem-recovery">
              <span>{problem.ownerRole}</span>
              <strong>{problem.recovery}</strong>
              <small>{problem.due}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function isPositionTemplateAudit(entry: WorkObject['audit'][number]) {
  const visibleLabel = visibleAuditAction(entry.actionLabel);
  return entry.actionLabel.startsWith('audit:position_template_')
    || entry.actionLabel.includes('Шаблон позиции')
    || visibleLabel.includes('Шаблон позиции')
    || entry.detail.includes('Шаблон ');
}

export function AuditPanel({
  objectTitle,
  audit,
  excludePositionTemplateAudit = false,
  defaultOpen = false,
}: {
  objectTitle: string;
  audit: WorkObject['audit'];
  excludePositionTemplateAudit?: boolean;
  defaultOpen?: boolean;
}) {
  const visibleAudit = excludePositionTemplateAudit ? audit.filter((entry) => !isPositionTemplateAudit(entry)) : audit;

  return (
    <details className="surface context-card audit-details" open={defaultOpen}>
      <summary className="context-title">
        <h3>История объекта</h3>
        <span className="object-scope">{objectTitle}</span>
      </summary>
      <div className="audit-stack">
        {visibleAudit.length > 0 ? (
          visibleAudit.map((entry) => (
            <article key={entry.id} className="audit-row">
              <time>{entry.time}</time>
              <div>
                <strong>{visibleAuditAction(entry.actionLabel)}</strong>
                <span>{entry.actorLabel}</span>
                <p>{entry.detail}</p>
              </div>
            </article>
          ))
        ) : (
          <p className="audit-empty">Событий пока нет.</p>
        )}
      </div>
    </details>
  );
}

export function SeverityPill({ severity, compact = false }: { severity: WorkObject['severity']; compact?: boolean }) {
  return (
    <span className={`severity-pill severity-${severity} ${compact ? 'is-compact' : ''}`} data-tone={severityTone(severity)} aria-label={severityHelp(severity)}>
      {compact ? compactSeverityLabel(severity) : severityLabel(severity)}
    </span>
  );
}
