import { useEffect, useMemo, useState } from 'react';

import {
  addMonths,
  baseCalendarMonthKey,
  calendarWeekdays,
  monthMeta,
} from '../../domain/calendar';
import {
  countActionableFinanceOrders,
  type FinanceCalendarEvent,
  type FinancePaymentCondition,
} from '../../domain/selectors';

function actionableOrderLabel(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return `${count} заказов ожидают выплату`;
  }
  if (lastDigit === 1) return `${count} заказ ожидает выплату`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} заказа ожидают выплату`;
  return `${count} заказов ожидают выплату`;
}

function eventCountLabel(count: number): string {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${count} событий`;
  if (lastDigit === 1) return `${count} событие`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} события`;
  return `${count} событий`;
}

function paymentEventSummary(event: FinanceCalendarEvent): string {
  const amount = [event.percentageLabel, event.amountLabel].filter(Boolean).join(' · ');
  const state =
    event.dateKind === 'unavailable' ? 'Дата не определена' : event.recommendedAction;
  return [amount, state].filter(Boolean).join(' · ');
}

const eventKindPriority: Record<FinanceCalendarEvent['kind'], number> = {
  source_error: 6,
  overdue: 5,
  due_today: 4,
  invoice: 3,
  installment: 2,
  payment: 1,
  paid: 0,
};

function primaryDayEvent(events: FinanceCalendarEvent[]): FinanceCalendarEvent | undefined {
  return events.reduce<FinanceCalendarEvent | undefined>(
    (primary, event) =>
      !primary || eventKindPriority[event.kind] > eventKindPriority[primary.kind] ? event : primary,
    undefined,
  );
}

export function FinancePaymentCalendar({
  events,
  conditions = [],
  selectedDay,
  selectedObjectId,
  onSelectDay,
  onSelectEvent,
  title = 'Платежный календарь',
  subtitle = 'счета, оплаты, рассрочка',
  agendaTitle = 'Повестка дня',
  initialMonthKey,
  now,
}: {
  events: FinanceCalendarEvent[];
  conditions?: FinancePaymentCondition[];
  selectedDay?: number;
  selectedObjectId?: string;
  onSelectDay: (day: number | undefined) => void;
  onSelectEvent?: (objectId: string) => void;
  title?: string;
  subtitle?: string;
  agendaTitle?: string;
  initialMonthKey?: string;
  now?: Date;
}) {
  const currentMonthKey = baseCalendarMonthKey(now);
  const resolvedInitialMonthKey = initialMonthKey ?? currentMonthKey;
  const financeCalendarMonths = useMemo(() => {
    const keys = new Set([
      addMonths(currentMonthKey, -1),
      currentMonthKey,
      addMonths(currentMonthKey, 1),
      resolvedInitialMonthKey,
    ]);
    events.forEach((event) => {
      if (event.monthKey) keys.add(event.monthKey);
    });
    return Array.from(keys).sort().map(monthMeta);
  }, [currentMonthKey, events, resolvedInitialMonthKey]);
  const [selectedMonthKey, setSelectedMonthKey] = useState(() => resolvedInitialMonthKey);
  const monthIndex = financeCalendarMonths.findIndex((month) => month.key === selectedMonthKey);
  const initialMonthIndex = financeCalendarMonths.findIndex(
    (month) => month.key === resolvedInitialMonthKey,
  );
  const resolvedMonthIndex =
    monthIndex >= 0 ? monthIndex : initialMonthIndex >= 0 ? initialMonthIndex : 0;
  useEffect(() => {
    if (monthIndex >= 0) return;
    setSelectedMonthKey(financeCalendarMonths[resolvedMonthIndex].key);
  }, [financeCalendarMonths, monthIndex, resolvedMonthIndex]);
  useEffect(() => {
    setSelectedMonthKey(resolvedInitialMonthKey);
  }, [resolvedInitialMonthKey, selectedObjectId]);
  const month = financeCalendarMonths[resolvedMonthIndex];
  const visibleEvents = events.filter((event) => event.monthKey === month.key && event.day);
  const undatedEvents = events.filter((event) => !event.monthKey || !event.day);
  const eventsByDay = useMemo(() => {
    return visibleEvents.reduce<Record<number, FinanceCalendarEvent[]>>((acc, event) => {
      if (!event.day) return acc;
      acc[event.day] = [...(acc[event.day] ?? []), event];
      return acc;
    }, {});
  }, [visibleEvents]);
  const agendaEvents = selectedDay !== undefined ? (eventsByDay[selectedDay] ?? []) : [];
  const agendaActionableCount = countActionableFinanceOrders(agendaEvents);
  const agendaActionLabel = `${agendaActionableCount} ${
    agendaActionableCount === 1 ? 'требует' : 'требуют'
  } действия`;
  const selectedAgendaLabel =
    selectedDay === undefined
      ? 'день не выбран'
      : [
          `${selectedDay} ${month.dayLabel}`,
          agendaActionLabel,
          eventCountLabel(agendaEvents.length),
        ].join(' · ');
  const visibleDateCount = Object.keys(eventsByDay).length;
  const canGoPrevious = resolvedMonthIndex > 0;
  const canGoNext = resolvedMonthIndex < financeCalendarMonths.length - 1;

  return (
    <section className="finance-payment-calendar-band" aria-label={title}>
      <div className="finance-calendar-card">
        <div className="finance-calendar-head">
          <div>
            <h4>{title}</h4>
            <span>
              {month.label} · {subtitle}
            </span>
          </div>
          <span className="finance-calendar-month-controls">
            <button
              type="button"
              disabled={!canGoPrevious}
              aria-label="Предыдущий месяц"
              onClick={() => setSelectedMonthKey(financeCalendarMonths[resolvedMonthIndex - 1].key)}
            >
              ‹
            </button>
            <b>
              {visibleDateCount} дат
              {undatedEvents.length > 0 ? ` · ${undatedEvents.length} без даты` : ''}
            </b>
            <button
              type="button"
              disabled={!canGoNext}
              aria-label="Следующий месяц"
              onClick={() => setSelectedMonthKey(financeCalendarMonths[resolvedMonthIndex + 1].key)}
            >
              ›
            </button>
          </span>
        </div>
        <div
          className="finance-calendar-grid"
          role="grid"
          aria-label="Календарь финансовых событий"
        >
          {calendarWeekdays.map((weekday) => (
            <div className="finance-calendar-weekday" key={weekday}>
              {weekday}
            </div>
          ))}
          {Array.from({ length: month.firstWeekday }, (_, index) => (
            <span
              className="finance-calendar-day is-empty"
              key={`empty-${index}`}
              aria-hidden="true"
            />
          ))}
          {Array.from({ length: month.days }, (_, index) => {
            const day = index + 1;
            const dayEvents = eventsByDay[day] ?? [];
            const actionableCount = countActionableFinanceOrders(dayEvents);
            const primaryEvent = primaryDayEvent(dayEvents);
            const className = [
              'finance-calendar-day',
              selectedDay === day ? 'is-active' : '',
              dayEvents.length > 0 ? 'has-events' : '',
              primaryEvent ? `kind-${primaryEvent.kind}` : '',
              dayEvents.some((event) => event.objectId === selectedObjectId)
                ? 'has-selected-object'
                : '',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <button
                aria-label={`${day} ${month.dayLabel}: ${actionableCount > 0 ? actionableOrderLabel(actionableCount) : dayEvents.length > 0 ? `${dayEvents.length} завершенных выплат` : 'нет событий'}`}
                className={className}
                key={day}
                type="button"
                aria-pressed={selectedDay === day}
                onClick={() => onSelectDay(selectedDay === day ? undefined : day)}
              >
                <span>{day}</span>
                {actionableCount > 0 && <small>{actionableCount}</small>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="finance-calendar-agenda" aria-label={agendaTitle}>
        <div className="finance-panel-heading">
          <h4>{agendaTitle}</h4>
          <span>{selectedAgendaLabel}</span>
        </div>
        <div className="finance-calendar-agenda-list">
          {selectedDay === undefined ? (
            <div className="finance-calendar-empty-day">
              <strong>Выберите день в календаре</strong>
              <span>Повестка покажет дела выбранного дня: счета, оплаты и рассрочку.</span>
            </div>
          ) : agendaEvents.length > 0 ? (
            agendaEvents.map((event) => (
              <button
                className={`finance-calendar-agenda-item kind-${event.kind} is-${event.dateKind} ${event.objectId === selectedObjectId ? 'is-selected' : ''}`.trim()}
                key={event.id}
                type="button"
                onClick={() => onSelectEvent?.(event.objectId)}
              >
                <span>{event.dateLabel}</span>
                <strong>
                  {event.title} · {event.customer}
                </strong>
                <small>{paymentEventSummary(event)}</small>
              </button>
            ))
          ) : (
            <div className="finance-calendar-empty-day">
              <strong>Нет финансовых дел</strong>
              <span>На этот день нет счетов, оплат и платежей по графику.</span>
            </div>
          )}
        </div>
        {undatedEvents.length > 0 ? (
          <div className="finance-calendar-undated" aria-label="Платежи без определённой даты">
            <div className="finance-panel-heading">
              <h4>Дата не определена</h4>
              <span>{undatedEvents.length}</span>
            </div>
            <div className="finance-calendar-agenda-list">
              {undatedEvents.map((event) => (
                <button
                  className={`finance-calendar-agenda-item kind-${event.kind} is-unavailable ${event.objectId === selectedObjectId ? 'is-selected' : ''}`.trim()}
                  key={event.id}
                  type="button"
                  onClick={() => onSelectEvent?.(event.objectId)}
                >
                  <strong>
                    {event.title} · {event.customer}
                  </strong>
                  <small>{paymentEventSummary(event)}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {conditions.length > 0 ? (
        <div
          className="finance-calendar-conditions"
          aria-label="Условия платежей после полной отгрузки"
        >
          <div className="finance-panel-heading">
            <h4>Условия после полной отгрузки</h4>
            <span>{conditions.length}</span>
          </div>
          <div className="finance-calendar-agenda-list">
            {conditions.map((condition) => (
              <button
                className={`finance-calendar-agenda-item is-condition ${condition.objectId === selectedObjectId ? 'is-selected' : ''}`.trim()}
                key={condition.id}
                type="button"
                onClick={() => onSelectEvent?.(condition.objectId)}
              >
                <strong>
                  {condition.title} · {condition.customer}
                </strong>
                <span>{condition.conditionLabel}</span>
                <small>
                  {[condition.percentageLabel, condition.amountLabel].filter(Boolean).join(' · ')}
                </small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
