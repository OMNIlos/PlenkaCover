import { useState } from 'react';

import { SeverityPill } from '../shell/viewPrimitives';
import { financeDisplayContractFromObject, visibleAuditActionLabel } from '../../domain/displayContracts';
import { getFinanceCalendarEvents, getFinanceCommandCounters, getFinanceCommandItems, getObjectsForRole } from '../../domain/selectors';
import type { FinanceCalendarEvent, FinanceCommandItem, WorkObjectsByRole } from '../../domain/selectors';
import type { ActionDescriptor, FinanceOrder, WorkObject } from '../../domain/types';
import type { EmployeeOption, PenaltyFormPayload } from './directorPenalties';
import { directorSyntheticObject, factValue } from './directorWorkObjectUtils';

type DirectorFinanceKickback = {
  id: string;
  orderId: string;
  amountLabel: string;
  status: 'draft' | 'confirmed' | 'voided';
  createdBy: string;
  updatedAt: string;
  visibility: 'director_only';
  auditEvent: 'audit:kickback_changed';
};

type DirectorFinanceSituation = {
  financeObjectId: string;
  directorObject: WorkObject;
  orderNumber: string;
  customer: string;
  severity: WorkObject['severity'];
  amountRisk: string;
  dueLabel: string;
  sourceLabel: string;
  sourceState: FinanceCommandItem['sourceState'];
  exceptionKind: FinanceCommandItem['exceptionKind'];
  directorActionLabel: string;
  evidence: string[];
  calendarEvents: FinanceCalendarEvent[];
  archiveState: DirectorFinanceArchiveState;
  archiveLabel: string;
  directorReason: string;
};

type DirectorFinanceArchiveState = 'active' | 'recheck' | 'recorded';
type DirectorFinanceRecordOutcome = 'plan' | 'return';

type DirectorFinancePenaltyDraft = PenaltyFormPayload & {
  decisionId: string;
};

export function DirectorFinanceSituations({
  selectedId,
  workObjectsByRole,
  onSelect,
  onAction,
  onPenaltyCreate,
  penaltyEmployees,
  recordLocalPenaltyLink = true,
}: {
  selectedId: string | null;
  workObjectsByRole: WorkObjectsByRole;
  onSelect: (id: string) => void;
  onAction: (actionId: string, object: WorkObject) => void;
  onPenaltyCreate: (
    payload: PenaltyFormPayload,
  ) => void | boolean | Promise<void | boolean>;
  penaltyEmployees?: EmployeeOption[];
  recordLocalPenaltyLink?: boolean;
}) {
  const [recordOutcomeByObject, setRecordOutcomeByObject] = useState<Record<string, DirectorFinanceRecordOutcome>>({});
  const [decisionReasonByObject, setDecisionReasonByObject] = useState<Record<string, string>>({});
  const [penaltyDraft, setPenaltyDraft] = useState<DirectorFinancePenaltyDraft | null>(null);
  const [penaltyPending, setPenaltyPending] = useState(false);
  const financeObjects = getObjectsForRole('finance', workObjectsByRole).filter((object) => shouldExposeFinanceToDirector(object));
  const activeFinanceObjects = financeObjects.filter((object) => directorFinanceArchiveState(object) === 'active');
  const commandItems = getFinanceCommandItems(activeFinanceObjects);
  const archivedCommandItems = getFinanceCommandItems(financeObjects.filter((object) => directorFinanceArchiveState(object) !== 'active'));
  const counters = getFinanceCommandCounters(activeFinanceObjects);
  const calendarEvents = getFinanceCalendarEvents(financeObjects);
  const situations = commandItems
    .map((item) => directorFinanceSituation(item, activeFinanceObjects, calendarEvents))
    .filter((situation): situation is DirectorFinanceSituation => Boolean(situation));
  const archivedSituations = archivedCommandItems
    .map((item) => directorFinanceSituation(item, financeObjects, calendarEvents))
    .filter((situation): situation is DirectorFinanceSituation => Boolean(situation));
  const selectedSituation = situations.find((situation) => selectedId && (
    situation.directorObject.id === selectedId ||
    situation.financeObjectId === selectedId ||
    situation.directorObject.id.endsWith(selectedId)
  )) ?? archivedSituations.find((situation) => selectedId && (
    situation.directorObject.id === selectedId ||
    situation.financeObjectId === selectedId ||
    situation.directorObject.id.endsWith(selectedId)
  )) ?? situations[0] ?? null;
  const isSelectedArchived = Boolean(selectedSituation && selectedSituation.archiveState !== 'active');
  const selectedOutcome = selectedSituation ? recordOutcomeByObject[selectedSituation.financeObjectId] ?? 'plan' : 'plan';
  const selectedReason = selectedSituation ? decisionReasonByObject[selectedSituation.financeObjectId] ?? '' : '';
  const selectedReasonTrimmed = selectedReason.trim();
  const selectedReasonSuffix = selectedReasonTrimmed ? `:reason=${encodeURIComponent(selectedReasonTrimmed)}` : '';
  const visibleEvents = selectedSituation
    ? selectedSituation.calendarEvents.slice(0, 3)
    : calendarEvents.slice(0, 3);
  const situationGroups = directorFinanceSituationGroups(situations);
  const selectablePenaltyEmployees =
    penaltyEmployees === undefined ? directorFinancePenaltyEmployees : penaltyEmployees;

  function setSelectedOutcome(outcome: DirectorFinanceRecordOutcome) {
    if (!selectedSituation) return;
    setRecordOutcomeByObject((current) => ({ ...current, [selectedSituation.financeObjectId]: outcome }));
  }

  function setSelectedReason(value: string) {
    if (!selectedSituation) return;
    setDecisionReasonByObject((current) => ({ ...current, [selectedSituation.financeObjectId]: value }));
  }

  function openPenaltyDialog(situation: DirectorFinanceSituation) {
    const employee =
      selectablePenaltyEmployees.find((candidate) => candidate.role === 'Зав. производства') ??
      selectablePenaltyEmployees[0];
    if (!employee) return;
    const decisionId = directorFinanceDecisionId(situation);
    setPenaltyDraft({
      employeeId: employee.id,
      employeeName: employee.name,
      employeeRole: employee.role,
      amountLabel: '',
      reason: `${situation.archiveLabel}: ${situation.orderNumber}. ${situation.directorReason || 'Решение директора записано.'}`,
      scopeObjectId: `${situation.financeObjectId} / ${decisionId}`,
      author: 'Директор',
      decisionId,
    });
  }

  async function submitPenaltyDialog() {
    if (!penaltyDraft || !selectedSituation || penaltyPending) return;
    if (!penaltyDraft.amountLabel.trim() || !penaltyDraft.reason.trim()) return;
    setPenaltyPending(true);
    try {
      const created = await onPenaltyCreate({
        employeeId: penaltyDraft.employeeId,
        employeeName: penaltyDraft.employeeName,
        employeeRole: penaltyDraft.employeeRole,
        amountLabel: penaltyDraft.amountLabel.trim(),
        reason: penaltyDraft.reason.trim(),
        scopeObjectId: penaltyDraft.scopeObjectId.trim(),
        author: penaltyDraft.author.trim() || 'Директор',
      });
      if (created === false) return;
      if (recordLocalPenaltyLink) {
        onAction(`director-penalty-finance:${selectedSituation.financeObjectId}:${penaltyDraft.decisionId}`, selectedSituation.directorObject);
      }
      setPenaltyDraft(null);
    } finally {
      setPenaltyPending(false);
    }
  }

  return (
    <section className="surface director-finance-surface" aria-label="Финансовые ситуации директора">
      <header className="director-finance-hero">
        <div>
          <span className="eyebrow">Финансы</span>
          <h2>Решения по финансовым ситуациям</h2>
        </div>
      </header>

      <div className="director-finance-risk-strip" aria-label="Финансовые показатели директора">
        {counters.map((counter) => (
          <div key={counter.id} className={`director-finance-counter counter-${counter.id}`} role="status">
            <span>{counter.label}</span>
            <strong>{counter.value}</strong>
          </div>
        ))}
      </div>

      <div className="director-finance-type-strip" aria-label="Типы финансовых ситуаций">
        {situationGroups.map((group) => (
          <span key={group.key}>
            <strong>{group.count}</strong>
            {group.label}
          </span>
        ))}
      </div>

      <div className="director-finance-layout">
        <section className="director-finance-ledger" aria-label="Финансовые дела">
          <div className="management-section-header">
            <span className="eyebrow">Активный реестр</span>
            <strong>{situations.length}</strong>
          </div>
          {situations.map((situation) => (
            <button
              key={situation.directorObject.id}
              type="button"
              className={`director-finance-row severity-${situation.severity} ${selectedSituation?.directorObject.id === situation.directorObject.id ? 'is-selected' : ''}`}
              onClick={() => onSelect(situation.directorObject.id)}
              title={`${situation.orderNumber}: ${situation.directorActionLabel}. Источник: ${situation.sourceLabel}.`}
            >
              <span>
                <strong>{situation.orderNumber}</strong>
                <small>{situation.customer}</small>
              </span>
              <em>{situation.amountRisk}</em>
              <span>
                <strong>{situation.directorActionLabel}</strong>
                <small>{situation.dueLabel}</small>
              </span>
            </button>
          ))}
          {situations.length === 0 && (
            <div className="management-empty-state">Активных финансовых решений нет.</div>
          )}
          <details className="director-finance-disclosure director-finance-archive">
            <summary>
              <span>Записанные / на сверке</span>
              <strong>{archivedSituations.length}</strong>
            </summary>
            <div className="director-finance-archive-list">
              {archivedSituations.length > 0 ? archivedSituations.map((situation) => (
                <button
                  key={situation.directorObject.id}
                  type="button"
                  className={`director-finance-archive-row ${selectedSituation?.directorObject.id === situation.directorObject.id ? 'is-selected' : ''}`}
                  onClick={() => onSelect(situation.directorObject.id)}
                >
                  <span>
                    <strong>{situation.orderNumber}</strong>
                    <small>{situation.customer}</small>
                  </span>
                  <em>{situation.archiveLabel}</em>
                </button>
              )) : (
                <p>Пока пусто.</p>
              )}
            </div>
          </details>
        </section>

        <aside className={`director-finance-evidence severity-${selectedSituation?.severity ?? 'info'}`} aria-label="Подтверждения финансовой ситуации">
          {selectedSituation ? (
            <>
              <header className="director-finance-card-head">
                <div>
                  <span className="eyebrow">На чем основано</span>
                  <h3>{selectedSituation.orderNumber} · {selectedSituation.customer}</h3>
                  <p>{isSelectedArchived ? `${selectedSituation.archiveLabel}. ${selectedSituation.directorActionLabel}` : selectedSituation.directorActionLabel}</p>
                </div>
                <SeverityPill severity={selectedSituation.severity} />
              </header>
              <div className="drawer-evidence-grid">
                <div><span>Сумма риска</span><strong>{selectedSituation.amountRisk}</strong></div>
                <div><span>Срок</span><strong>{selectedSituation.dueLabel}</strong></div>
                <div><span>Источник</span><strong>{selectedSituation.sourceLabel}</strong></div>
                <div><span>Тип</span><strong>{directorFinanceExceptionLabel(selectedSituation.exceptionKind)}</strong></div>
              </div>
              {isSelectedArchived ? (
                <section className="director-finance-complete-state" aria-label="Записанное решение">
                  <span>{selectedSituation.archiveLabel}</span>
                  <strong>{selectedSituation.directorReason || 'Причина записана в истории финансовой карточки.'}</strong>
                  {selectedSituation.archiveState === 'recorded' && (
                    <button
                      type="button"
                      disabled={selectablePenaltyEmployees.length === 0}
                      title={
                        selectablePenaltyEmployees.length === 0
                          ? 'Список сотрудников ещё не загружен.'
                          : undefined
                      }
                      onClick={() => openPenaltyDialog(selectedSituation)}
                    >
                      Назначить штраф по этому решению
                    </button>
                  )}
                </section>
              ) : (
                <section className="director-supervisor-panel" aria-label="Ручное решение директора по финансам">
                  <div className="management-section-header">
                    <span className="eyebrow">Решение директора</span>
                    <strong>обязательна причина</strong>
                  </div>
                  <div className="director-finance-decision-flow director-finance-actions">
                    <label className="director-finance-reason-field">
                      <span>Причина</span>
                      <textarea
                        rows={3}
                        value={selectedReason}
                        onChange={(event) => setSelectedReason(event.target.value)}
                        placeholder="Коротко почему"
                        aria-label="Причина решения директора"
                      />
                    </label>
                    <button
                      className="director-finance-recheck-action"
                      type="button"
                      disabled={!selectedReasonTrimmed}
                      onClick={() => onAction(`director-finance-recheck:${selectedSituation.financeObjectId}${selectedReasonSuffix}`, selectedSituation.directorObject)}
                    >
                      Перепроверить
                    </button>
                    <p className="director-finance-selected-outcome">
                      Исход: {selectedOutcome === 'plan' ? 'подтверждение плана оплаты' : 'возврат бухгалтерии'}
                    </p>
                    <div className="director-finance-outcome-toggle" role="group" aria-label="Результат решения директора">
                      <button type="button" className={selectedOutcome === 'return' ? 'is-selected' : ''} onClick={() => setSelectedOutcome('return')}>
                        Вернуть бухгалтерии
                      </button>
                      <button type="button" className={selectedOutcome === 'plan' ? 'is-selected' : ''} onClick={() => setSelectedOutcome('plan')}>
                        Подтвердить план оплаты
                      </button>
                    </div>
                    <button
                      className="director-finance-record-action"
                      type="button"
                      disabled={!selectedReasonTrimmed}
                      onClick={() => onAction(`director-finance-record-${selectedOutcome}:${selectedSituation.financeObjectId}${selectedReasonSuffix}`, selectedSituation.directorObject)}
                    >
                      Записать решение
                    </button>
                  </div>
                </section>
              )}
              <ul className="management-evidence-list director-finance-key-evidence">
                {selectedSituation.evidence.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <details className="director-finance-disclosure" open={false}>
                <summary>
                  <span>Финансовый файл и история</span>
                  <strong>{selectedSituation.directorObject.sections.length}</strong>
                </summary>
                <div className="director-finance-full-file" aria-label="Полный финансовый файл директора">
                  {selectedSituation.directorObject.sections.map((section) => (
                    <div key={section.id} className="director-finance-file-section">
                      <strong>{section.title}</strong>
                      <dl>
                        {section.facts.map((fact) => (
                          <div key={`${section.id}-${fact.label}-${fact.value}`}>
                            <dt>{fact.label}</dt>
                            <dd>{fact.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </div>
              </details>
              <details className="director-finance-disclosure">
                <summary>
                  <span>Ближайшие даты</span>
                  <strong>{visibleEvents.length}</strong>
                </summary>
                <div className="director-finance-calendar-inline">
                  {visibleEvents.map((event) => (
                    <article key={event.id} className={`director-calendar-event kind-${event.kind} severity-${event.severity}`}>
                      <span>{event.dateLabel}</span>
                      <strong>{event.title}</strong>
                      <small>{event.customer} · {event.amountLabel}</small>
                    </article>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <div className="management-empty-state">Нет финансового риска для директорского разбора.</div>
          )}
        </aside>

      </div>
      {penaltyDraft && selectedSituation && (
        <div className="penalty-dialog-backdrop" role="presentation">
          <section className="penalty-dialog director-finance-penalty-dialog" role="dialog" aria-modal="true" aria-labelledby="director-finance-penalty-title" aria-busy={penaltyPending} tabIndex={-1}>
            <header className="penalty-dialog-header">
              <div>
                <span className="eyebrow">Штраф по решению</span>
                <h2 id="director-finance-penalty-title">{selectedSituation.orderNumber} · {selectedSituation.customer}</h2>
                <p>{penaltyDraft.decisionId}</p>
              </div>
              <button className="drawer-close-button" type="button" disabled={penaltyPending} onClick={() => setPenaltyDraft(null)} aria-label="Закрыть">
                <ix-icon name="close" size="24" />
              </button>
            </header>
            <div className="penalty-dialog-body director-finance-penalty-form">
              <label>
                <span>Сотрудник</span>
                <select
                  value={penaltyDraft.employeeId}
                  onChange={(event) => {
                    const employee = selectablePenaltyEmployees.find((item) => item.id === event.target.value) ?? selectablePenaltyEmployees[0];
                    setPenaltyDraft((current) => current ? { ...current, employeeId: employee.id, employeeName: employee.name, employeeRole: employee.role } : current);
                  }}
                >
                  {selectablePenaltyEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.name} · {employee.role}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Сумма</span>
                <input value={penaltyDraft.amountLabel} onChange={(event) => setPenaltyDraft((current) => current ? { ...current, amountLabel: event.target.value } : current)} placeholder="2 000 ₽" />
              </label>
              <label>
                <span>Связанный объект</span>
                <input value={penaltyDraft.scopeObjectId} onChange={(event) => setPenaltyDraft((current) => current ? { ...current, scopeObjectId: event.target.value } : current)} />
              </label>
              <label className="is-wide">
                <span>Причина</span>
                <textarea value={penaltyDraft.reason} onChange={(event) => setPenaltyDraft((current) => current ? { ...current, reason: event.target.value } : current)} />
              </label>
              <div className="template-editor-actions">
                <button
                  className="action-tile action-recommended create-intake-button"
                  type="button"
                  disabled={penaltyPending || !penaltyDraft.amountLabel.trim() || !penaltyDraft.reason.trim()}
                  onClick={() => void submitPenaltyDialog()}
                >
                  {penaltyPending ? 'Назначаем…' : 'Назначить штраф'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

const directorFinancePenaltyEmployees = [
  { id: 'production-lead-a', name: 'Зав. производства Артур', role: 'Зав. производства' },
  { id: 'operator-line-a', name: 'Иван Петров', role: 'Оператор' },
  { id: 'operator-line-b', name: 'Сергей Ким', role: 'Оператор' },
];

function directorFinanceArchiveState(object: WorkObject): DirectorFinanceArchiveState {
  const decisionState = factValue(object, 'Состояние директорского решения') ?? '';
  if (decisionState.includes('На сверке') || object.statusLabel === 'На сверке') return 'recheck';
  if (decisionState.includes('Решение записано') || object.statusLabel === 'Решение записано') return 'recorded';
  return 'active';
}

function directorFinanceArchiveLabel(state: DirectorFinanceArchiveState, object: WorkObject) {
  if (state === 'recheck') return 'На сверке у бухгалтерии';
  if (state === 'recorded') return 'Решение записано';
  return 'Активно';
}

function directorFinanceDecisionId(situation: DirectorFinanceSituation) {
  return `${situation.archiveState === 'recheck' ? 'RECHECK' : 'DECISION'}-${situation.financeObjectId}`;
}

function directorFinanceSituation(
  item: FinanceCommandItem,
  financeObjects: WorkObject[],
  calendarEvents: FinanceCalendarEvent[]
): DirectorFinanceSituation | null {
  const sourceObject = financeObjects.find((object) => object.id === item.id);
  if (!sourceObject) return null;
  const directorObject = directorFinanceDecisionObject(sourceObject);
  const display = financeDisplayContractFromObject(sourceObject);
  const kickback = directorKickbackForFinanceObject(sourceObject);
  const dueEvidence = item.dueLabel && item.dueLabel !== 'не назначен' ? `Срок: ${item.dueLabel}` : 'Срок оплаты не назначен';
  const sourceEvidence = `${directorFinanceSourceStateLabel(item.sourceState)} · ${item.sourceLabel}`;
  const actionLabel = directorFinanceActionLabel(item, kickback);
  const archiveState = directorFinanceArchiveState(sourceObject);

  return {
    financeObjectId: sourceObject.id,
    directorObject,
    orderNumber: item.orderNumber,
    customer: item.customer,
    severity: item.severity,
    amountRisk: item.amountRisk,
    dueLabel: item.dueLabel,
    sourceLabel: item.sourceLabel,
    sourceState: item.sourceState,
    exceptionKind: item.exceptionKind,
    directorActionLabel: actionLabel,
    evidence: [
      `Счет: ${item.invoiceLabel}`,
      `Оплата: ${item.paymentLabel}`,
      `Остаток: ${display.amountRemainingLabel}`,
      dueEvidence,
      sourceEvidence,
      item.auditEvidence,
      kickback ? `Откат: ${kickback.amountLabel}, видимость только директор` : undefined,
    ].filter(Boolean) as string[],
    calendarEvents: calendarEvents.filter((event) => event.objectId === item.id),
    archiveState,
    archiveLabel: directorFinanceArchiveLabel(archiveState, sourceObject),
    directorReason: factValue(sourceObject, 'Причина director override') ?? factValue(sourceObject, 'Причина директорского решения') ?? '',
  };
}

function directorFinanceSituationGroups(situations: DirectorFinanceSituation[]) {
  const labels: Record<string, string> = {
    billing_blocker: 'счет',
    history: 'история',
    kickback: 'откат',
    installment: 'рассрочка',
    today: 'платеж сегодня',
    overdue: 'просрочка',
    source_error: 'ошибка источника',
    partial_payment: 'частичная оплата',
  };
  const counts = situations.reduce<Record<string, number>>((acc, situation) => {
    const key = directorFinanceGroupKey(situation);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return Object.entries(labels)
    .map(([key, label]) => ({ key, label, count: counts[key] ?? 0 }))
    .filter((group) => group.count > 0);
}

function directorFinanceGroupKey(situation: DirectorFinanceSituation) {
  if (situation.directorActionLabel.includes('откат')) return 'kickback';
  if (situation.exceptionKind === 'overdue') return 'overdue';
  if (situation.exceptionKind === 'source_error' || situation.sourceState === 'source_error') return 'source_error';
  if (situation.exceptionKind === 'partial_payment') return 'partial_payment';
  if (situation.exceptionKind === 'billing_blocker') return 'billing_blocker';
  if (situation.directorActionLabel.includes('рассроч')) return 'installment';
  if (situation.directorActionLabel.includes('платеж')) return 'today';
  return 'history';
}

function directorFinanceActionLabel(item: FinanceCommandItem, kickback: DirectorFinanceKickback | null) {
  if (kickback?.status === 'draft') return 'Проверить откат';
  if (item.exceptionKind === 'overdue') return 'Разобрать просрочку';
  if (item.sourceState === 'source_error') return 'Проверить источник';
  if (item.dueBucket === 'сегодня') return 'Проконтролировать платеж';
  if (item.exceptionKind === 'partial_payment') return 'Проверить остаток';
  if (item.mode === 'installments') return 'Контроль рассрочки';
  if (item.exceptionKind === 'billing_blocker') return 'Проверить счет';
  return 'Открыть историю';
}

function directorFinanceExceptionLabel(exceptionKind: FinanceCommandItem['exceptionKind']) {
  const labels: Record<FinanceCommandItem['exceptionKind'], string> = {
    none: 'без исключения',
    overdue: 'просрочка',
    source_error: 'ошибка источника',
    delivery_blocked: 'ждет выдачу',
    unmatched_payment: 'неразнесенная оплата',
    billing_blocker: 'блокер счета',
    partial_payment: 'частичная оплата',
  };
  return labels[exceptionKind];
}

function directorFinanceSourceStateLabel(state: FinanceCommandItem['sourceState']) {
  const labels: Record<FinanceCommandItem['sourceState'], string> = {
    ready: 'источник подтвержден',
    manual_check: 'ручная проверка',
    source_error: 'источник не подтвердил',
    schedule: 'график платежа',
    manual_review: 'ручная сверка',
  };
  return labels[state];
}

function financeContractFromObject(object: WorkObject): FinanceOrder {
  const display = financeDisplayContractFromObject(object);
  const paymentSchedule = object.paymentSchedule;
  const paymentDate = paymentSchedule?.dueDateLabel ?? display.dueDateLabel;
  const notificationState = factValue(object, 'Уведомление') ?? '';
  const paymentKind = display.paymentKindLabel;

  return {
    id: object.id,
    orderId: display.orderNumber,
    counterparty: display.customer,
    counterpartyLabel: display.customer,
    invoiceStatus: display.invoiceStatus,
    paymentStatus: display.paymentStatus,
    shipmentDateLabel: display.shipmentDateLabel,
    installmentTerms: paymentSchedule
      ? { days: paymentSchedule.termsDays, daysLeft: paymentSchedule.status === 'due_today' ? 0 : 8, startRule: 'after_delivery_close', calendarMode: 'calendar_days', source: 'finance_source' }
      : display.installmentLabel.includes('дней')
        ? { days: 30, daysLeft: object.statusLabel === 'Оплата сегодня' ? 0 : object.statusLabel === 'Просрочка' ? -3 : 8, startRule: 'after_delivery_close', calendarMode: 'calendar_days', source: 'finance_source' }
        : undefined,
    paymentSchedule: paymentSchedule
      ? paymentSchedule
      : paymentDate
      ? {
          id: `schedule-${object.id}`,
          orderId: display.orderNumber,
          triggerId: `trigger-${object.id}`,
          termsDays: 30,
          dueDateLabel: paymentDate,
          dueAmountLabel: display.nextPaymentLabel !== 'нет данных' ? display.nextPaymentLabel : display.amountLabel,
          status: object.statusLabel === 'Оплата сегодня' ? 'due_today' : object.statusLabel === 'Просрочка' ? 'overdue' : 'scheduled',
          invoiceReminderStatus: notificationState.includes('Закрыто') ? 'closed' : notificationState.includes('Отправлено') ? 'sent' : 'pending',
          notifiedAt: notificationState.includes('Отправлено') ? '09:00' : undefined,
          source: 'warehouse_delivery_mock',
        }
      : undefined,
    amountLabel: display.amountLabel,
    amountTotalLabel: display.amountLabel,
    amountPaidLabel: display.amountPaidLabel,
    amountRemainingLabel: display.amountRemainingLabel,
    nextPaymentAmountLabel: display.nextPaymentLabel,
    paymentKind: paymentKind.includes('cash') ? 'cash' : paymentKind.includes('mixed') ? 'mixed' : paymentKind.includes('bank') ? 'bank' : 'unknown',
    sourceStatus: display.sourceStatus,
    sourceLabel: display.sourceLabel,
    invoiceSourceStatus: display.invoiceStatus === 'sync_error' || display.invoiceStatus === 'not_confirmed_by_source' ? 'error' : 'ready',
    paymentSourceStatus: display.sourceStatus,
    directorVisible: true,
  };
}

export function shouldExposeFinanceToDirector(_object?: WorkObject) {
  return true;
}

export function directorFinanceDecisionObject(financeObject: WorkObject): WorkObject {
  const contract = financeContractFromObject(financeObject);
  const display = financeDisplayContractFromObject(financeObject);
  const hasOpenProblem = financeObject.problems.some((problem) => problem.status === 'open');
  const kickback = directorKickbackForFinanceObject(financeObject);
  const scheduleStatusLabel = (status?: string) => {
    if (status === 'sent') return 'Отправлено';
    if (status === 'closed') return 'Закрыто';
    if (status === 'pending') return 'Ждет действия';
    return 'Не требуется';
  };
  const sourceStatusLabel = (status?: string) => {
    if (status === 'error') return 'Ошибка';
    if (status === 'waiting') return 'Ожидает данных';
    if (status === 'not_required') return 'Не требуется';
    return 'Готов';
  };
  const severity: WorkObject['severity'] = contract.paymentStatus === 'overdue' || contract.sourceStatus === 'error'
    ? 'critical'
    : hasOpenProblem || contract.paymentStatus === 'installment_running' || contract.paymentStatus === 'payment_due_today' || contract.paymentStatus === 'partial'
      ? 'warning'
      : 'info';
  const baseSections = [
    {
      id: `director-finance-source-${financeObject.id}`,
      title: 'Финансовые факты',
      facts: [
        { label: 'Счет', value: display.invoiceLabel },
        { label: 'Оплата', value: display.paymentLabel },
        { label: 'Оплачено', value: contract.amountPaidLabel ?? 'нет данных' },
        { label: 'Остаток', value: contract.amountRemainingLabel ?? 'нет данных' },
        { label: 'Дата отгрузки', value: contract.shipmentDateLabel ?? 'нет данных' },
        { label: 'Дата оплаты', value: display.dueDateLabel },
        { label: 'График', value: display.scheduleLabel },
        { label: 'Уведомление', value: factValue(financeObject, 'Уведомление') ?? 'не требуется' },
        { label: 'Источник', value: contract.sourceLabel },
      ],
    },
    {
      id: `director-payment-schedule-${financeObject.id}`,
      title: 'График и доказательства',
      facts: [
        { label: 'Основание срока', value: contract.paymentSchedule ? 'Закрытая выдача склада' : 'нет данных' },
        { label: 'Дата оплаты', value: contract.paymentSchedule?.dueDateLabel ?? 'нет данных' },
        { label: 'Сумма к дате', value: contract.paymentSchedule?.dueAmountLabel ?? contract.nextPaymentAmountLabel ?? 'нет данных' },
        { label: 'Уведомление', value: scheduleStatusLabel(contract.paymentSchedule?.invoiceReminderStatus) },
        { label: 'Состояние источника', value: `${sourceStatusLabel(contract.invoiceSourceStatus ?? contract.sourceStatus)} / ${sourceStatusLabel(contract.paymentSourceStatus ?? contract.sourceStatus)}` },
      ],
    },
    ...financeObject.sections.slice(0, 1),
  ];
  const sections = kickback
    ? [
        ...baseSections,
        {
          id: `director-kickback-${financeObject.id}`,
          title: 'Откат',
          scope: 'sensitiveFinance' as const,
          facts: [
            { label: 'Статус', value: kickback.status === 'confirmed' ? 'Подтвержден' : kickback.status === 'voided' ? 'Аннулирован' : 'Черновик', scope: 'sensitiveFinance' as const },
            { label: 'Сумма', value: kickback.amountLabel, scope: 'sensitiveFinance' as const },
            { label: 'Видимость', value: 'Только директор', scope: 'sensitiveFinance' as const },
            { label: 'История', value: 'Любое изменение суммы записывается со значениями было/стало', scope: 'sensitiveFinance' as const },
          ],
        },
      ]
    : baseSections;
  const archiveState = directorFinanceArchiveState(financeObject);
  const actions: ActionDescriptor[] = [
    ...(archiveState === 'active'
      ? [
          { id: `director-finance-recheck:${financeObject.id}`, label: 'Перепроверить', level: 'secondary' as const, enabled: true, confirmation: 'Нужна причина запроса сверки' },
          { id: `director-finance-record-plan:${financeObject.id}`, label: 'Записать решение: подтвердить план', level: 'peer' as const, enabled: true, confirmation: 'Нужна причина директорского решения' },
          { id: `director-finance-record-return:${financeObject.id}`, label: 'Записать решение: вернуть бухгалтерии', level: 'peer' as const, enabled: true, confirmation: 'Нужна причина возврата' },
        ]
      : [
          {
            id: `director-history-finance:${financeObject.id}`,
            label: 'Открыть историю решения',
            level: 'secondary' as const,
            enabled: true,
            helpText: 'Финансовое решение закрыто для действий; доступна история и связанный финансовый контур.',
          },
        ]),
    ...(kickback?.status === 'draft'
      ? [{ id: `director-confirm-kickback:${financeObject.id}`, label: 'Подтвердить откат...', level: 'peer' as const, enabled: true }]
      : kickback
        ? [{
            id: `director-kickback-history:${financeObject.id}`,
            label: 'История отката',
            level: 'secondary' as const,
            enabled: true,
            helpText: 'Откат уже подтвержден или аннулирован; изменение возможно только через новое директорское решение.',
          }]
        : []),
    { id: `director-open-finance:${financeObject.id}`, label: 'Открыть финансовый контекст', level: 'secondary' as const, enabled: true },
  ];

  return {
    ...financeObject,
    id: `DIR-${financeObject.id}`,
    kind: 'directorDecision',
    title: `Финансовое решение ${financeObject.id}`,
    statusLabel: financeObject.statusLabel,
    nextOwner: 'Директор',
    severity,
    facts: [
      { label: 'Номер', value: contract.orderId },
      { label: 'Заказчик', value: contract.counterparty, scope: 'legal' },
      { label: 'Сумма', value: contract.amountLabel, scope: 'sensitiveFinance' },
      { label: 'Остаток', value: contract.amountRemainingLabel ?? 'нет данных', scope: 'sensitiveFinance' },
      { label: 'Статус оплаты', value: display.paymentLabel, scope: 'sensitiveFinance' },
      { label: 'Дата отгрузки', value: contract.shipmentDateLabel ?? 'нет данных', scope: 'sensitiveFinance' },
      { label: 'Дата оплаты', value: display.dueDateLabel, scope: 'sensitiveFinance' },
      { label: 'Уведомление', value: factValue(financeObject, 'Уведомление') ?? 'не требуется', scope: 'finance' },
      { label: 'Источник данных', value: contract.sourceLabel, scope: 'finance' },
    ],
    sections,
    actions,
    problems: financeObject.problems,
    audit: kickback
      ? [
          {
            id: `a-director-kickback-${financeObject.id}`,
            objectId: `DIR-${financeObject.id}`,
            time: kickback.updatedAt ?? '13:18',
            actorLabel: kickback.createdBy ?? 'Директор',
            actionLabel: 'Откат изменен',
            detail: 'Откат доступен только в закрытом директорском контуре.',
            reason: 'Решение директора',
            oldValue: 'Черновик',
            newValue: `${kickback.status === 'confirmed' ? 'Подтвержден' : kickback.status === 'voided' ? 'Аннулирован' : 'Черновик'}: ${kickback.amountLabel}`,
            sourceSnapshot: 'Директорский контур',
            scope: 'sensitiveFinance',
          },
          ...financeObject.audit,
        ]
      : [
          {
            id: `a-director-senior-access-${financeObject.id}`,
            objectId: `DIR-${financeObject.id}`,
            time: 'сейчас',
            actorLabel: 'Директор',
            actionLabel: visibleAuditActionLabel('audit:senior_access_viewed'),
            detail: 'Директор открыл полный финансовый файл для ручного решения.',
            reason: 'Senior access',
            sourceSnapshot: 'Финансовый файл + source history',
          },
          ...financeObject.audit,
        ],
  };
}

function directorKickbackForFinanceObject(financeObject: WorkObject): DirectorFinanceKickback | null {
  if (financeObject.id !== 'FIN-2606-021' && financeObject.id !== 'FIN-2606-025') return null;
  return {
    id: `KB-${financeObject.id}`,
    orderId: factValue(financeObject, 'Номер') ?? financeObject.id,
    amountLabel: financeObject.id === 'FIN-2606-021' ? '18 000 ₽' : '12 000 ₽',
    status: 'draft' as const,
    createdBy: 'Директор',
    updatedAt: '13:18',
    visibility: 'director_only' as const,
    auditEvent: 'audit:kickback_changed' as const,
  };
}
