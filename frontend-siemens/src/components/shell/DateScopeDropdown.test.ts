import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  applyDateScope,
  DateScopeDropdown,
  initialDateScopeMonthKey,
} from './DateScopeDropdown';

const items = [
  { id: 'early', dateKey: '2026-06-01' },
  { id: 'from', dateKey: '2026-06-02' },
  { id: 'middle', dateKey: '2026-06-03' },
  { id: 'to', dateKey: '2026-06-04' },
  { id: 'late', dateKey: '2026-06-05' },
  { id: 'undated' },
];

const scopedIds = (scope: string) => {
  return applyDateScope(items, scope).map((item) => item.id);
};

describe('applyDateScope', () => {
  it('filters an inclusive date range', () => {
    expect(scopedIds('2026-06-02..2026-06-04')).toEqual(['from', 'middle', 'to']);
  });

  it('filters a single date', () => {
    expect(scopedIds('2026-06-03')).toEqual(['middle']);
  });

  it('keeps all items for all scope', () => {
    expect(scopedIds('all')).toEqual([
      'early',
      'from',
      'middle',
      'to',
      'late',
      'undated',
    ]);
  });

  it('keeps only items without date for undated scope', () => {
    expect(scopedIds('undated')).toEqual(['undated']);
  });
});

describe('initialDateScopeMonthKey', () => {
  it('opens the latest month that contains rows when all dates are selected', () => {
    expect(
      initialDateScopeMonthKey(
        [{ dateKey: '2026-06-30' }, { dateKey: '2026-07-15' }, {}],
        'all',
      ),
    ).toBe('2026-07');
  });

  it('falls back to the injected Moscow business month when there are no dated rows', () => {
    expect(
      initialDateScopeMonthKey([], 'all', new Date('2026-07-31T21:00:00.000Z')),
    ).toBe('2026-08');
  });
});

describe('DateScopeDropdown range mode', () => {
  it('labels a range-enabled control as a period', () => {
    const markup = renderToStaticMarkup(
      createElement(DateScopeDropdown, {
        items,
        scope: 'all',
        rangeSelection: true,
        onChange: () => undefined,
      }),
    );

    expect(markup).toContain('aria-label="Период списка: Все"');
    expect(markup).toContain('<small>Период</small>');
  });
});
