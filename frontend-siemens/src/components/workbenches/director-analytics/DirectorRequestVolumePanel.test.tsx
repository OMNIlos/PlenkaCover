import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type { ServerDirectorCommercialApplications } from '../../../api/director';
import { DirectorRequestVolumePanel } from './DirectorRequestVolumePanel';

const applications: ServerDirectorCommercialApplications = {
  definition: 'submitted',
  asOfDate: '2026-07-24',
  periods: [
    {
      period: 'week',
      fromDate: '2026-07-18',
      toDate: '2026-07-24',
      totalCount: 4,
      clientOrderCount: 3,
      stockReserveCount: 1,
    },
    {
      period: 'month',
      fromDate: '2026-06-25',
      toDate: '2026-07-24',
      totalCount: 6,
      clientOrderCount: 4,
      stockReserveCount: 2,
    },
    {
      period: '3_months',
      fromDate: '2026-04-25',
      toDate: '2026-07-24',
      totalCount: 8,
      clientOrderCount: 5,
      stockReserveCount: 3,
    },
    {
      period: '6_months',
      fromDate: '2026-01-25',
      toDate: '2026-07-24',
      totalCount: 10,
      clientOrderCount: 6,
      stockReserveCount: 4,
    },
  ],
};

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

describe('DirectorRequestVolumePanel', () => {
  it('renders exact cumulative windows with boundaries and client/reserve splits', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<DirectorRequestVolumePanel applications={applications} />);
    });
    const expected = {
      week: '7 дней4 шт.Клиентские: 3 шт. · Резерв: 1 шт.18.07.2026 — 24.07.2026',
      month: '30 дней6 шт.Клиентские: 4 шт. · Резерв: 2 шт.25.06.2026 — 24.07.2026',
      '3_months': '3 месяца8 шт.Клиентские: 5 шт. · Резерв: 3 шт.25.04.2026 — 24.07.2026',
      '6_months': '6 месяцев10 шт.Клиентские: 6 шт. · Резерв: 4 шт.25.01.2026 — 24.07.2026',
    } as const;

    for (const [period, content] of Object.entries(expected)) {
      const cell = renderer.root.findByProps({ 'data-application-period': period });
      expect(textContent(cell)).toBe(content);
    }
  });

  it('uses cumulative cells without a misleading chart or graph toggle', () => {
    const markup = renderToStaticMarkup(<DirectorRequestVolumePanel applications={applications} />);

    expect(markup).not.toContain('role="img"');
    expect(markup).not.toContain('График');
    expect(markup).not.toContain('data-display-mode');
  });
});
