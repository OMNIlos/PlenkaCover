import { readFileSync } from 'node:fs';
import TestRenderer, { act } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceCalendarEvent, FinancePaymentCondition } from '../../domain/selectors';
import { FinancePaymentCalendar } from './FinancePaymentCalendar';

const financeStyles = readFileSync(
  new URL('../../styles/33-finance-workbench.css', import.meta.url),
  'utf8',
);

function cssBlock(source: string, selector: string) {
  const start = source.indexOf(selector);
  if (start < 0) return '';
  const open = source.indexOf('{', start + selector.length);
  if (open < 0) return '';
  const close = source.indexOf('}', open + 1);
  return close < 0 ? '' : source.slice(open + 1, close);
}

function paymentEvent(
  id: string,
  kind: FinanceCalendarEvent['kind'],
  dateKind: FinanceCalendarEvent['dateKind'],
): FinanceCalendarEvent {
  return {
    id,
    objectId: id,
    day: 21,
    dateLabel: '21.08.2026',
    title: id,
    customer: 'Заказчик',
    amountLabel: '600 ₽',
    kind,
    sourceState: 'schedule',
    severity: kind === 'overdue' ? 'critical' : 'info',
    recommendedAction: kind === 'overdue' ? 'разобрать просрочку' : 'проверить оплату',
    dateIso: '2026-08-21',
    monthKey: '2026-08',
    dateKind,
  };
}

describe('FinancePaymentCalendar', () => {
  it('shows shipment conditions separately without assigning a calendar date', () => {
    const conditions: FinancePaymentCondition[] = [
      {
        id: 'condition-1',
        objectId: 'finance-1',
        title: 'Платёж 1 · A-1024',
        customer: 'Заказчик',
        amountLabel: '600 ₽',
        conditionLabel: 'через 30 дней после полной отгрузки',
        dateKind: 'condition',
        percentageLabel: '50,00%',
      },
    ];

    const markup = renderToStaticMarkup(
      <FinancePaymentCalendar events={[]} conditions={conditions} onSelectDay={vi.fn()} />,
    );

    expect(markup).toContain('Условия после полной отгрузки');
    expect(markup).toContain('через 30 дней после полной отгрузки');
    expect(markup).not.toContain('21.08.2026');
  });

  it('opens the injected Moscow business month when the schedule has no dated events', () => {
    const markup = renderToStaticMarkup(
      <FinancePaymentCalendar
        events={[]}
        now={new Date('2026-07-31T21:00:00.000Z')}
        onSelectDay={vi.fn()}
      />,
    );

    expect(markup).toContain('Август 2026 · счета, оплаты, рассрочка');
  });

  it('preserves a valid user-selected month when refreshed events get a new array identity', () => {
    const onSelectDay = vi.fn();
    const now = new Date('2026-08-10T09:00:00.000Z');
    const renderCalendar = (events: FinanceCalendarEvent[]) => (
      <FinancePaymentCalendar
        events={events}
        initialMonthKey="2026-08"
        now={now}
        onSelectDay={onSelectDay}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        renderCalendar([paymentEvent('august-payment', 'installment', 'actual')]),
      );
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Предыдущий месяц' }).props.onClick();
    });
    act(() => {
      renderer.update(
        renderCalendar([{ ...paymentEvent('august-payment', 'installment', 'actual') }]),
      );
    });

    const heading = renderer.root.findByProps({ className: 'finance-calendar-head' });
    expect(heading.findAllByType('span')[0].children.join('')).toContain('Июль 2026');
  });

  it('resets an explicit month when the selected finance order changes', () => {
    const renderCalendar = (selectedObjectId: string) => (
      <FinancePaymentCalendar
        events={[paymentEvent(`${selectedObjectId}-payment`, 'installment', 'actual')]}
        initialMonthKey="2026-08"
        now={new Date('2026-08-10T09:00:00.000Z')}
        selectedObjectId={selectedObjectId}
        onSelectDay={vi.fn()}
      />
    );
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(renderCalendar('finance-order-a'));
    });
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Предыдущий месяц' }).props.onClick();
    });
    expect(
      renderer.root
        .findByProps({ className: 'finance-calendar-head' })
        .findAllByType('span')[0]
        .children.join(''),
    ).toContain('Июль 2026');

    act(() => {
      renderer.update(renderCalendar('finance-order-b'));
    });

    expect(
      renderer.root
        .findByProps({ className: 'finance-calendar-head' })
        .findAllByType('span')[0]
        .children.join(''),
    ).toContain('Август 2026');
  });

  it('uses container-adaptive columns without a fixed minimum wider than the calendar band', () => {
    expect(cssBlock(financeStyles, '.finance-payment-calendar-band')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*360px\),\s*1fr\)\);/u,
    );
    expect(financeStyles).not.toMatch(
      /@media \(min-width: 900px\) and \(max-width: 1280px\)[\s\S]*?\.finance-payment-calendar-band\s*\{[^}]*minmax\(320px,[^}]*minmax\(170px,/u,
    );
  });

  it('keeps overdue severity when another payment shares the day', () => {
    const markup = renderToStaticMarkup(
      <FinancePaymentCalendar
        events={[
          paymentEvent('a-installment', 'installment', 'actual'),
          paymentEvent('z-overdue', 'overdue', 'actual'),
        ]}
        initialMonthKey="2026-08"
        onSelectDay={vi.fn()}
      />,
    );

    expect(markup).toContain('class="finance-calendar-day has-events kind-overdue"');
  });

  it('explains a selected agenda with actionable-order and total-event counts', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <FinancePaymentCalendar
          events={[
            paymentEvent('open-payment', 'payment', 'actual'),
            paymentEvent('open-installment', 'installment', 'actual'),
            paymentEvent('open-overdue', 'overdue', 'actual'),
            paymentEvent('paid-first', 'paid', 'actual'),
            paymentEvent('paid-second', 'paid', 'actual'),
          ]}
          initialMonthKey="2026-08"
          selectedDay={21}
          onSelectDay={vi.fn()}
        />,
      );
    });

    const heading = renderer.root.findByProps({ className: 'finance-panel-heading' });
    expect(heading.findByType('span').children.join('')).toBe(
      '21 августа · 3 требуют действия · 5 событий',
    );
  });

  it('uses a singular event label when the selected agenda has one event', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <FinancePaymentCalendar
          events={[paymentEvent('paid-only', 'paid', 'actual')]}
          initialMonthKey="2026-08"
          selectedDay={21}
          onSelectDay={vi.fn()}
        />,
      );
    });

    const heading = renderer.root.findByProps({ className: 'finance-panel-heading' });
    expect(heading.findByType('span').children.join('')).toBe(
      '21 августа · 0 требуют действия · 1 событие',
    );
  });
});
