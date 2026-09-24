import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { buildDirectorChartScale } from '../../../domain/runtime/directorAnalyticsPresentation';
import {
  DirectorBarPlot,
  DirectorChartYAxis,
} from './DirectorAnalyticsChartPrimitives';
import { formatNumber } from './directorAnalyticsFormatters';

describe('director analytics formatters', () => {
  it('limits precision to three decimals and uses the true Unicode minus', () => {
    expect(formatNumber(1.23456)).toBe('1,235');
    expect(formatNumber(-4.5)).toBe('−4,5');
  });
});

describe('DirectorChartYAxis', () => {
  it('renders a visible unit and five rounded ticks', () => {
    const scale = buildDirectorChartScale([0, 82.8], 'kg');
    const markup = renderToStaticMarkup(
      <DirectorChartYAxis label="Ось выпуска, кг" scale={scale} unit="kg" side="left" />,
    );

    expect(markup).toContain('<strong>кг</strong>');
    expect(markup.match(/data-axis-tick-kg=/gu)).toHaveLength(5);
    expect(markup).toContain('data-axis-tick-kg="100"');
    expect(markup).toContain('data-axis-tick-kg="0"');
  });

  it('renders one truthful zero tick for an all-zero count scale', () => {
    const scale = buildDirectorChartScale([0, 0], 'count');
    const markup = renderToStaticMarkup(
      <DirectorChartYAxis
        label="Ось количества рулонов, шт."
        scale={scale}
        unit="count"
        side="right"
      />,
    );

    expect(markup).toContain('<strong>шт.</strong>');
    expect(markup.match(/data-axis-tick-rolls=/gu)).toHaveLength(1);
    expect(markup).toContain('data-axis-tick-rolls="0"');
    expect(markup).toContain('director-analytics-y-axis-ticks is-zero');
  });
});

describe('DirectorBarPlot', () => {
  it('annotates the first stable maximum and draws a leader without changing plot layout', () => {
    const markup = renderToStaticMarkup(
      <DirectorBarPlot
        ariaLabel="План и факт"
        groups={[
          {
            id: 'g1',
            label: 'Первая',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 80,
                valueKind: 'kg',
              },
              {
                id: 'expected',
                className: 'is-expected',
                label: 'План',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 80,
                valueKind: 'kg',
              },
            ],
          },
          {
            id: 'g2',
            label: 'Вторая',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 80,
                valueKind: 'kg',
              },
            ],
          },
        ]}
      />,
    );

    expect(markup).toContain('data-max-annotation="g1:actual"');
    expect(markup.match(/data-max-annotation=/gu)).toHaveLength(1);
    expect(markup).toContain('director-analytics-max-leader');
    expect(markup).toContain('data-series-id="actual"');
    expect(markup).toContain('80 кг');
  });

  it('annotates every positive bar when requested', () => {
    const markup = renderToStaticMarkup(
      <DirectorBarPlot
        ariaLabel="План и факт"
        annotationMode="all"
        groups={[
          {
            id: 'g1',
            label: 'Первая',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 80,
                valueKind: 'kg',
              },
              {
                id: 'expected',
                className: 'is-expected',
                label: 'План',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 0,
                valueKind: 'kg',
              },
            ],
          },
          {
            id: 'g2',
            label: 'Вторая',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: 40,
                valueKind: 'kg',
              },
            ],
          },
        ]}
      />,
    );

    expect(markup.match(/data-bar-annotation=/gu)).toHaveLength(2);
    expect(markup).toContain('data-bar-annotation="g1:actual"');
    expect(markup).toContain('data-bar-annotation="g2:actual"');
    expect(markup).not.toContain('data-bar-annotation="g1:expected"');
  });

  it('does not render a false maximum label for empty or all-zero data', () => {
    const emptyMarkup = renderToStaticMarkup(
      <DirectorBarPlot
        ariaLabel="Пустой график"
        groups={[{ id: 'g1', label: 'Первая', bars: [] }]}
      />,
    );
    const zeroMarkup = renderToStaticMarkup(
      <DirectorBarPlot
        ariaLabel="Нулевой график"
        groups={[
          {
            id: 'g1',
            label: 'Первая',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 0, ticks: [0] },
                unit: 'kg',
                value: 0,
                valueKind: 'kg',
              },
            ],
          },
        ]}
      />,
    );

    expect(emptyMarkup).not.toContain('data-max-annotation');
    expect(zeroMarkup).not.toContain('data-max-annotation');
  });

  it('reveals the latest buckets when a long production period overflows', () => {
    const plot = {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 640,
    };

    act(() => {
      create(
        <DirectorBarPlot
          ariaLabel="График выпуска"
          groups={[
            {
              id: '2026-07-01',
              label: '01.07.2026',
              bars: [],
            },
            {
              id: '2026-07-24',
              label: '24.07.2026',
              bars: [],
            },
          ]}
        />,
        {
          createNodeMock: (element) =>
            element.props.className?.includes('director-analytics-chart') ? plot : {},
        },
      );
    });

    expect(plot.scrollLeft).toBe(440);
  });

  it('preserves manual scroll when a rerender keeps the full bucket identity unchanged', () => {
    const plot = {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 640,
    };
    const groups = [
      { id: '2026-07-01', label: '01.07.2026', bars: [] },
      { id: '2026-07-02', label: '02.07.2026', bars: [] },
      { id: '2026-07-24', label: '24.07.2026', bars: [] },
    ];
    let renderer!: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <DirectorBarPlot ariaLabel="График выпуска" groups={groups} />,
        {
          createNodeMock: (element) =>
            element.props.className?.includes('director-analytics-chart') ? plot : {},
        },
      );
    });
    plot.scrollLeft = 120;

    act(() => {
      renderer.update(
        <DirectorBarPlot
          ariaLabel="График выпуска"
          groups={groups.map((group) => ({ ...group }))}
        />,
      );
    });

    expect(plot.scrollLeft).toBe(120);
  });

  it('reveals the latest buckets when the full identity changes with the same count and end', () => {
    const plot = {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 640,
    };
    let renderer!: ReturnType<typeof create>;

    act(() => {
      renderer = create(
        <DirectorBarPlot
          ariaLabel="График выпуска"
          groups={[
            { id: '2026-07-01', label: '01.07.2026', bars: [] },
            { id: '2026-07-02', label: '02.07.2026', bars: [] },
            { id: '2026-07-24', label: '24.07.2026', bars: [] },
          ]}
        />,
        {
          createNodeMock: (element) =>
            element.props.className?.includes('director-analytics-chart') ? plot : {},
        },
      );
    });
    plot.scrollLeft = 120;

    act(() => {
      renderer.update(
        <DirectorBarPlot
          ariaLabel="График выпуска"
          groups={[
            { id: '2026-07-01', label: '01.07.2026', bars: [] },
            { id: '2026-07-03', label: '03.07.2026', bars: [] },
            { id: '2026-07-24', label: '24.07.2026', bars: [] },
          ]}
        />,
      );
    });

    expect(plot.scrollLeft).toBe(440);
  });

  it('keeps the latest-bucket scroll target nonnegative when the plot does not overflow', () => {
    const plot = {
      clientWidth: 200,
      scrollLeft: 35,
      scrollWidth: 160,
    };

    act(() => {
      create(
        <DirectorBarPlot
          ariaLabel="График выпуска"
          groups={[{ id: '2026-07-24', label: '24.07.2026', bars: [] }]}
        />,
        {
          createNodeMock: (element) =>
            element.props.className?.includes('director-analytics-chart') ? plot : {},
        },
      );
    });

    expect(plot.scrollLeft).toBe(0);
  });

  it('labels negative values, applies a state and pattern class, and keeps height nonnegative', () => {
    const markup = renderToStaticMarkup(
      <DirectorBarPlot
        ariaLabel="График расхода сырья: план и факт"
        variant="comparison"
        groups={[
          {
            id: '2026-07-20',
            label: '20.07.2026',
            bars: [
              {
                id: 'actual',
                className: 'is-actual',
                label: 'Факт',
                scale: { maximum: 100, ticks: [100, 75, 50, 25, 0] },
                unit: 'kg',
                value: -4.5,
                valueKind: 'kg',
              },
            ],
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Факт: −4,5 кг; отрицательное значение"');
    expect(markup).toContain(
      'director-analytics-bar is-actual is-negative is-negative-pattern',
    );
    expect(markup).toContain('data-value-kg="-4.5"');
    expect(markup).toContain('style="height:4.5%"');
    expect(markup).not.toMatch(/height:-/u);
  });
});
