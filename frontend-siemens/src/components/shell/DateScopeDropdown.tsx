import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  addMonths,
  baseCalendarMonthKey,
  calendarWeekdays,
  dateDayLabel,
  monthMeta,
} from '../../domain/calendar';
import type { QueueDateScope } from '../../domain/types';

type DateScopedItem = {
  dateKey?: string;
};

type DateRangeScope = {
  from: string;
  to: string;
};

const isoDateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRangeScope(scope: QueueDateScope): DateRangeScope | null {
  if (!scope.includes('..')) return null;
  const parts = scope.split('..');
  if (parts.length !== 2) return null;
  const [rawFrom, rawTo] = parts;
  if (!isoDateKeyPattern.test(rawFrom) || !isoDateKeyPattern.test(rawTo)) return null;
  return rawFrom <= rawTo
    ? { from: rawFrom, to: rawTo }
    : { from: rawTo, to: rawFrom };
}

function dateLabel(scope: QueueDateScope) {
  if (scope === 'all') return 'Все';
  if (scope === 'undated') return 'Без даты';
  const range = parseDateRangeScope(scope);
  if (range) return `${dateDayLabel(range.from)} – ${dateDayLabel(range.to)}`;
  return dateDayLabel(scope);
}

export function applyDateScope<T extends DateScopedItem>(items: T[], scope: QueueDateScope): T[] {
  if (scope === 'all') return items;
  if (scope === 'undated') return items.filter((item) => !item.dateKey);
  const range = parseDateRangeScope(scope);
  if (range) {
    return items.filter(
      (item) => item.dateKey && item.dateKey >= range.from && item.dateKey <= range.to,
    );
  }
  return items.filter((item) => item.dateKey === scope);
}

export function initialDateScopeMonthKey(
  items: DateScopedItem[],
  scope: QueueDateScope,
  now?: Date,
): string {
  const selectedRange = parseDateRangeScope(scope);
  if (selectedRange) return selectedRange.from.slice(0, 7);
  if (isoDateKeyPattern.test(scope)) return scope.slice(0, 7);
  return items.reduce<string | null>((latestMonthKey, item) => {
    if (!item.dateKey || !isoDateKeyPattern.test(item.dateKey)) return latestMonthKey;
    const monthKey = item.dateKey.slice(0, 7);
    return !latestMonthKey || monthKey > latestMonthKey ? monthKey : latestMonthKey;
  }, null) ?? baseCalendarMonthKey(now);
}

export function DateScopeDropdown({
  items,
  scope,
  onChange,
  rangeSelection = false,
  now,
}: {
  items: DateScopedItem[];
  scope: QueueDateScope;
  onChange: (scope: QueueDateScope) => void;
  rangeSelection?: boolean;
  now?: Date;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<'down' | 'up'>('down');
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const selectedRange = parseDateRangeScope(scope);
  const isSingleDateScope = isoDateKeyPattern.test(scope);
  const effectiveNow = now ?? new Date();
  const currentMonthKey = baseCalendarMonthKey(effectiveNow);
  const monthKeys = useMemo(() => {
    const keys = new Set([
      addMonths(currentMonthKey, -1),
      currentMonthKey,
      addMonths(currentMonthKey, 1),
    ]);
    const range = parseDateRangeScope(scope);
    if (range) {
      keys.add(range.from.slice(0, 7));
      keys.add(range.to.slice(0, 7));
    } else if (isoDateKeyPattern.test(scope)) {
      keys.add(scope.slice(0, 7));
    }
    items.forEach((item) => {
      if (item.dateKey) keys.add(item.dateKey.slice(0, 7));
    });
    return Array.from(keys).sort();
  }, [currentMonthKey, items, scope]);
  const initialMonthKey = initialDateScopeMonthKey(items, scope, effectiveNow);
  const initialMonthIndex = Math.max(0, monthKeys.indexOf(initialMonthKey));
  const [monthIndex, setMonthIndex] = useState(initialMonthIndex);
  useEffect(() => {
    setMonthIndex(initialMonthIndex);
  }, [initialMonthIndex]);
  const months = monthKeys.map(monthMeta);
  const month =
    months[Math.min(monthIndex, months.length - 1)] ?? monthMeta(currentMonthKey);
  const eventsByDay = useMemo(() => {
    return items.reduce<Record<number, DateScopedItem[]>>((acc, item) => {
      if (!item.dateKey || item.dateKey.slice(0, 7) !== month.key) return acc;
      const day = Number(item.dateKey.slice(8, 10));
      acc[day] = [...(acc[day] ?? []), item];
      return acc;
    }, {});
  }, [items, month.key]);
  const undatedCount = items.filter((item) => !item.dateKey).length;
  const canGoPrevious = monthIndex > 0;
  const canGoNext = monthIndex < months.length - 1;
  const activeRange = rangeStart ? null : selectedRange;
  const scopeKindLabel = rangeSelection ? 'Период' : 'Дата';

  const selectDate = (dateKey: string) => {
    if (!rangeSelection) {
      onChange(dateKey);
      setIsOpen(false);
      return;
    }

    if (!rangeStart) {
      setRangeStart(dateKey);
      return;
    }

    const from = rangeStart <= dateKey ? rangeStart : dateKey;
    const to = rangeStart <= dateKey ? dateKey : rangeStart;
    onChange(from === to ? from : `${from}..${to}`);
    setRangeStart(null);
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current || rootRef.current.contains(event.target as Node)) return;
      setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) setRangeStart(null);
  }, [isOpen]);

  useEffect(() => {
    if (!rangeSelection) setRangeStart(null);
  }, [rangeSelection]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement('down');
      return;
    }

    const updatePlacement = () => {
      const root = rootRef.current;
      const popover = popoverRef.current;
      if (!root || !popover) return;

      const triggerRect = root.getBoundingClientRect();
      const popoverHeight = popover.offsetHeight || 340;
      const viewportHeight = window.innerHeight;
      const margin = 14;
      const spaceBelow = viewportHeight - triggerRect.bottom;
      const spaceAbove = triggerRect.top;

      setPlacement(spaceBelow < popoverHeight + margin && spaceAbove > spaceBelow ? 'up' : 'down');
    };

    updatePlacement();
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [isOpen, monthIndex, items.length]);

  return (
    <div className={`date-scope-dropdown ${isOpen ? 'is-open' : ''} is-${placement}`} ref={rootRef}>
      <button
        className="date-scope-trigger"
        type="button"
        aria-expanded={isOpen}
        aria-label={`${scopeKindLabel} списка: ${dateLabel(scope)}`}
        onClick={() => setIsOpen((current) => !current)}
      >
        <ix-icon name="calendar" size="16" />
        <span className="date-scope-trigger-copy">
          <small>{scopeKindLabel}</small>
          <strong>{dateLabel(scope)}</strong>
        </span>
      </button>
      {isOpen && (
        <div
          className="date-scope-popover"
          role="dialog"
          aria-label={rangeSelection ? 'Выбор периода очереди' : 'Выбор даты очереди'}
          ref={popoverRef}
        >
          <div className="date-scope-head">
            <button type="button" disabled={!canGoPrevious} aria-label="Предыдущий месяц" onClick={() => setMonthIndex((current) => Math.max(0, current - 1))}>‹</button>
            <strong>{month.label}</strong>
            <button type="button" disabled={!canGoNext} aria-label="Следующий месяц" onClick={() => setMonthIndex((current) => Math.min(months.length - 1, current + 1))}>›</button>
          </div>
          <div className="date-scope-grid" role="grid" aria-label="Календарь очереди">
            {calendarWeekdays.map((weekday) => <span className="date-scope-weekday" key={weekday}>{weekday}</span>)}
            {Array.from({ length: month.firstWeekday }, (_, index) => <span className="date-scope-day is-empty" key={`empty-${index}`} />)}
            {Array.from({ length: month.days }, (_, index) => {
              const day = index + 1;
              const dayItems = eventsByDay[day] ?? [];
              const dateKey = `${month.key}-${String(day).padStart(2, '0')}`;
              const isRangeBoundary = Boolean(
                activeRange && (dateKey === activeRange.from || dateKey === activeRange.to),
              );
              const isInRange = Boolean(
                activeRange && dateKey > activeRange.from && dateKey < activeRange.to,
              );
              const dayClassName = [
                'date-scope-day',
                scope === dateKey || rangeStart === dateKey || isRangeBoundary ? 'is-active' : '',
                isInRange ? 'is-in-range' : '',
                dayItems.length > 0 ? 'has-events' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  className={dayClassName}
                  type="button"
                  key={dateKey}
                  disabled={!rangeSelection && dayItems.length === 0}
                  aria-label={`${day} ${month.dayLabel}: ${dayItems.length} строк`}
                  onClick={() => selectDate(dateKey)}
                >
                  <span>{day}</span>
                  {dayItems.length > 0 && <small>{dayItems.length}</small>}
                </button>
              );
            })}
          </div>
          <div className="date-scope-actions">
            <button
              type="button"
              className={scope === 'undated' ? 'is-active' : ''}
              disabled={undatedCount === 0}
              onClick={() => {
                setRangeStart(null);
                onChange('undated');
                setIsOpen(false);
              }}
            >
              Без даты · {undatedCount}
            </button>
            <button
              type="button"
              onClick={() => {
                setRangeStart(null);
                onChange('all');
                setIsOpen(false);
              }}
            >
              Сбросить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
