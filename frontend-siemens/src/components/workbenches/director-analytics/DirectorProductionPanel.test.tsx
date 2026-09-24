import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ServerDirectorAccountingProduction,
  ServerDirectorAnalyticsProductionQualityPoint,
} from '../../../api/director';
import { DirectorProductionPanel, sortProductionBuckets } from './DirectorProductionPanel';

const series: ServerDirectorAnalyticsProductionQualityPoint[] = [
  {
    id: 'day:2026-07-24',
    bucketStartDate: '2026-07-24',
    producedRollCount: 7,
    producedKg: 282.125,
    defectRecordCount: 3,
    defectiveRollCount: 2,
    verifiedDefectKg: 5.25,
    unverifiedDefectCount: 1,
  },
];
const accounting: ServerDirectorAccountingProduction = {
  source: {
    sourceKind: '1C',
    label: '1С · Отчет производства за смену',
    latestImportedAt: '2026-07-24T09:00:00.000Z',
    latestDocumentDate: '2026-07-24T08:00:00.000Z',
    stale: false,
  },
  coverage: {
    documentCount: 9,
    excludedOutputLineCount: 1,
    excludedMaterialLineCount: 0,
  },
  productionSeries: [
    {
      bucketStartDate: '2026-07-24',
      documentCount: 9,
      producedKg: 410,
    },
  ],
  materialSeries: [],
};
const accountingOnly: ServerDirectorAccountingProduction = {
  ...accounting,
  productionSeries: [
    {
      bucketStartDate: '2026-07-25',
      documentCount: 4,
      producedKg: 410,
    },
  ],
};

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function renderPanel(
  panelSeries = series,
  displayMode: 'chart' | 'table' = 'table',
): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorProductionPanel
        series={panelSeries}
        accounting={accounting}
        displayMode={displayMode}
        qualityUnit="kg"
      />,
    );
  });
  return renderer;
}

describe('DirectorProductionPanel', () => {
  it('keeps the shared control presentation free of 1C and secondary defect evidence', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionPanel
        series={series}
        accounting={accounting}
        displayMode="chart"
        qualityUnit="kg"
      />,
    );

    expect(markup).not.toMatch(/1С|Документ|Записей брака|Подтверждённый|Без подтверждённого/u);
    expect(markup).not.toContain('data-series-id="onec-produced"');
  });

  it('plots only the two visible kg facts in kg mode', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionPanel
        series={series}
        accounting={accounting}
        displayMode="chart"
        qualityUnit="kg"
      />,
    );

    expect(markup).toContain('data-value-kg="282.125"');
    expect(markup).toContain('data-value-kg="5.25"');
    expect(markup).not.toContain('data-value-rolls="7"');
    expect(markup).not.toContain('data-value-rolls="2"');
    expect(markup).toContain('is-defect-pattern');
    expect(markup).toContain('Брак, кг');
  });

  it('renders physical production and defect bars on a shared kg scale', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionPanel
        series={series}
        accounting={accounting}
        displayMode="chart"
        qualityUnit="kg"
      />,
    );

    expect(markup).toContain('Изготовлено, кг');
    expect(markup).toContain('Брак, кг');
    expect(markup).toContain('data-series-id="produced"');
    expect(markup).toContain('data-series-id="defect"');
    expect(markup).not.toContain('410 кг');
  });

  it('does not invent a physical production row from an accounting-only bucket', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionPanel
        series={[]}
        accounting={accountingOnly}
        displayMode="chart"
        qualityUnit="kg"
      />,
    );

    expect(markup).not.toContain('25.07.2026');
    expect(markup).not.toContain('410 кг');
  });

  it('plots only roll facts in count mode', () => {
    const markup = renderToStaticMarkup(
      <DirectorProductionPanel
        series={series}
        accounting={accounting}
        displayMode="chart"
        qualityUnit="count"
      />,
    );

    expect(markup).toContain('data-value-rolls="7"');
    expect(markup).toContain('data-value-rolls="2"');
    expect(markup).not.toContain('data-value-kg="282.125"');
    expect(markup).not.toContain('data-value-kg="5.25"');
    expect(markup).toContain('Изготовлено, рул.');
    expect(markup).toContain('Рулонов с браком');
    expect(markup).not.toContain('data-series-id="onec-produced"');
  });

  it('renders exactly the five approved sortable control columns', () => {
    const renderer = renderPanel();
    const table = renderer.root.findByType('table');
    const headers = table
      .findAll((node) => node.type === 'th' && node.props.scope === 'col')
      .map(textContent);
    const row = table.findByType('tbody').findByType('tr');

    expect(headers).toEqual([
      'Период',
      'Изготовлено, рул.',
      'Изготовлено, кг',
      'Рулонов с браком',
      'Брак, кг',
    ]);
    expect(table.findAllByType('button')).toHaveLength(5);
    expect(table.findAllByType('button').every((button) => button.props.type === 'button')).toBe(
      true,
    );
    expect(
      table
        .findAll((node) => node.type === 'th' && node.props.scope === 'col')
        .map((header) => header.props['aria-sort']),
    ).toEqual(['none', 'none', 'none', 'none', 'none']);
    expect(textContent(row.findByType('th'))).toBe('24.07.2026');
    expect(row.findAllByType('td').map(textContent)).toEqual(['7', '282,125 кг', '2', '5,25 кг']);
  });

  it('cycles a native sort control from none to desc to asc and back to none', () => {
    const rows = [
      { ...series[0], bucketStartDate: '2026-07-23', producedRollCount: 2 },
      { ...series[0], bucketStartDate: '2026-07-24', producedRollCount: 7 },
    ];
    const renderer = renderPanel(rows);
    const producedHeader = () =>
      renderer.root
        .findAll((node) => node.type === 'th' && node.props.scope === 'col')
        .find((header) => textContent(header) === 'Изготовлено, рул.');
    const periods = () =>
      renderer.root
        .findByType('tbody')
        .findAllByType('tr')
        .map((row) => textContent(row.findByType('th')));

    expect(producedHeader()?.props['aria-sort']).toBe('none');
    expect(periods()).toEqual(['24.07.2026', '23.07.2026']);

    act(() => producedHeader()?.findByType('button').props.onClick());
    expect(producedHeader()?.props['aria-sort']).toBe('descending');
    expect(periods()).toEqual(['24.07.2026', '23.07.2026']);

    act(() => producedHeader()?.findByType('button').props.onClick());
    expect(producedHeader()?.props['aria-sort']).toBe('ascending');
    expect(periods()).toEqual(['23.07.2026', '24.07.2026']);

    act(() => producedHeader()?.findByType('button').props.onClick());
    expect(producedHeader()?.props['aria-sort']).toBe('none');
    expect(periods()).toEqual(['24.07.2026', '23.07.2026']);
  });

  it('uses period order as a deterministic tie-break without mutating its input', () => {
    const tied = [
      { ...series[0], bucketStartDate: '2026-07-26', producedKg: 100 },
      { ...series[0], bucketStartDate: '2026-07-24', producedKg: 100 },
      { ...series[0], bucketStartDate: '2026-07-25', producedKg: 100 },
    ];

    expect(
      sortProductionBuckets(tied, { key: 'producedKg', direction: 'desc' }).map(
        (point) => point.bucketStartDate,
      ),
    ).toEqual(['2026-07-26', '2026-07-25', '2026-07-24']);
    expect(tied.map((point) => point.bucketStartDate)).toEqual([
      '2026-07-26',
      '2026-07-24',
      '2026-07-25',
    ]);
  });

  it('keeps equal Moscow periods stable by row id after refetch reorders the input', () => {
    const rows = [
      { ...series[0], id: 'period-b', bucketStartDate: '2026-07-24' },
      { ...series[0], id: 'period-a', bucketStartDate: '2026-07-24' },
      { ...series[0], id: 'period-c', bucketStartDate: '2026-07-24' },
    ];
    const ids = (input: typeof rows) =>
      sortProductionBuckets(input, { key: 'period', direction: 'desc' }).map(({ id }) => id);

    expect(ids(rows)).toEqual(['period-a', 'period-b', 'period-c']);
    expect(ids([rows[2], rows[0], rows[1]])).toEqual(['period-a', 'period-b', 'period-c']);
  });

  it('renders equal Moscow periods with unique stable table and chart identities', () => {
    const rows = [
      { ...series[0], id: 'period-b', bucketStartDate: '2026-07-24' },
      { ...series[0], id: 'period-a', bucketStartDate: '2026-07-24' },
      { ...series[0], id: 'period-c', bucketStartDate: '2026-07-24' },
    ];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let table: TestRenderer.ReactTestRenderer | undefined;
    let chart: TestRenderer.ReactTestRenderer | undefined;

    try {
      table = renderPanel(rows, 'table');
      chart = renderPanel(rows, 'chart');

      const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
        call.some((value) => /same key|unique ["']key["']/iu.test(String(value))),
      );
      expect(duplicateKeyWarnings).toEqual([]);
      expect(
        table.root
          .findByType('tbody')
          .findAllByType('tr')
          .map((row) => row.props['data-control-period-id']),
      ).toEqual(['period-a', 'period-b', 'period-c']);
      expect(
        chart.root
          .findAll((node) => node.props['data-chart-group-id'] !== undefined)
          .map((group) => group.props['data-chart-group-id']),
      ).toEqual(['period-a', 'period-b', 'period-c']);
    } finally {
      act(() => {
        table?.unmount();
        chart?.unmount();
      });
      consoleError.mockRestore();
    }
  });
});
