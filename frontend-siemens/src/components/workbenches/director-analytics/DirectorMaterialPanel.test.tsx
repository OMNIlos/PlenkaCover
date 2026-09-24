import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import type {
  ServerDirectorAccountingProduction,
  ServerDirectorAnalyticsMaterialSpendPoint,
  ServerDirectorAnalyticsSpoolEvidence,
} from '../../../api/director';
import { DirectorMaterialPanel } from './DirectorMaterialPanel';

const series: ServerDirectorAnalyticsMaterialSpendPoint[] = [
  {
    bucketStartDate: '2026-07-24',
    consumedGranulesKg: -5.125,
    recordedSpoolCount: 6,
    recordedSpoolTareKg: 12.75,
    missingSpoolEvidenceCount: 1,
  },
];
const spoolEvidence: ServerDirectorAnalyticsSpoolEvidence = {
  availability: 'measured_evidence_only',
  explanation: 'Только зафиксированные производственные замеры.',
};
const accounting: ServerDirectorAccountingProduction = {
  source: {
    sourceKind: '1C',
    label: '1С · Отчет производства за смену',
    latestImportedAt: '2026-07-24T09:00:00.000Z',
    latestDocumentDate: '2026-07-24T08:00:00.000Z',
    stale: false,
  },
  coverage: {
    documentCount: 3,
    excludedOutputLineCount: 0,
    excludedMaterialLineCount: 2,
  },
  productionSeries: [],
  materialSeries: [{ bucketStartDate: '2026-07-24', consumedKg: 125 }],
};
const accountingOnly: ServerDirectorAccountingProduction = {
  ...accounting,
  materialSeries: [{ bucketStartDate: '2026-07-25', consumedKg: 125 }],
};

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function legacyCellText(row: TestRenderer.ReactTestInstance): string[] {
  return row
    .findAllByType('td')
    .filter((cell) => cell.props['data-column-id'] === undefined)
    .map(textContent);
}

function accountingCellText(row: TestRenderer.ReactTestInstance): string {
  return textContent(row.findByProps({ 'data-column-id': 'onec-consumed-kg' }));
}

describe('DirectorMaterialPanel', () => {
  it('keeps the 1C write-off comparison without the redundant source-status banner', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={accounting}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('data-series-id="onec-materials"');
    expect(markup).not.toContain('aria-label="Источник производственных данных 1С"');
    expect(markup).not.toContain('1С · Отчет производства за смену');
  });

  it('labels closed BigBag facts and preserves a signed patterned correction', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={accounting}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('Расход BigBag');
    expect(markup).toContain('data-value-kg="-5.125"');
    expect(markup).toContain('is-negative-pattern');
    expect(markup).toContain('−5,125 кг');
  });

  it('renders BigBag ERP facts separately from 1C material write-offs on a shared scale', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={accounting}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('Расход BigBag');
    expect(markup).toContain('Бухгалтерское списание');
    expect(markup).toContain('data-series-id="granules"');
    expect(markup).toContain('data-series-id="onec-materials"');
    expect(markup).toContain('data-value-kg="-5.125"');
    expect(markup).toContain('data-value-kg="125"');
    expect(markup).toContain('data-max-annotation="2026-07-24:onec-materials"');
  });

  it('renders an accounting-only material bucket with zero physical BigBag facts', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={[]}
        accounting={accountingOnly}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('25.07.2026');
    expect(markup).toContain('data-series-id="granules"');
    expect(markup).toContain('data-series-id="onec-materials"');
    expect(markup).toContain('data-value-kg="0"');
    expect(markup).toContain('data-value-kg="125"');
    expect(markup).toContain('data-max-annotation="2026-07-25:onec-materials"');
  });

  it('uses neutral shared wording for all-material 1C consumption', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={accounting}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('Расход материала: BigBag и бухгалтерский учёт');
    expect(markup).toContain('Ось расхода материалов, кг');
    expect(markup).toContain('Обозначения расхода материалов');
    expect(markup).not.toContain('Расход гранул по закрытым фактам BigBag: ERP и учёт 1С');
  });

  it('describes spool facts as measured production evidence, never a warehouse write-off', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={accounting}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('Тара шпуль учитывается по измерениям изготовленных рулонов.');
    expect(markup).toContain('Зафиксировано шпуль: 6');
    expect(markup).toContain('Измеренная тара: 12,75 кг');
    expect(markup).toContain('Без замера шпули: 1');
    expect(markup).not.toContain('списано со склада');
  });

  it('shows every material-spend field in exact mode', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <DirectorMaterialPanel
          series={series}
          accounting={accounting}
          spoolEvidence={spoolEvidence}
          displayMode="table"
        />,
      );
    });
    const table = renderer.root.findByType('table');
    const headers = table
      .findAll((node) => node.type === 'th' && node.props.scope === 'col')
      .map(textContent);
    const row = table.findByType('tbody').findByType('tr');

    expect(headers).toEqual([
      'Период',
      'Расход BigBag, кг',
      'Бухгалтерское списание, кг',
      'Зафиксировано шпуль',
      'Измеренная тара, кг',
      'Без замера шпули',
    ]);
    expect(textContent(row.findByType('th'))).toBe('24.07.2026');
    expect(legacyCellText(row)).toEqual(['−5,125 кг', '6', '12,75 кг', '1']);
    expect(accountingCellText(row)).toBe('125 кг');
  });

  it('sorts the exact material table across non-overlapping ERP and 1C buckets', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <DirectorMaterialPanel
          series={series}
          accounting={accountingOnly}
          spoolEvidence={spoolEvidence}
          displayMode="table"
        />,
      );
    });
    const rows = renderer.root.findByType('tbody').findAllByType('tr');

    expect(rows.map((row) => textContent(row.findByType('th')))).toEqual([
      '24.07.2026',
      '25.07.2026',
    ]);
    expect(legacyCellText(rows[0])).toEqual(['−5,125 кг', '6', '12,75 кг', '1']);
    expect(accountingCellText(rows[0])).toBe('0 кг');
    expect(legacyCellText(rows[1])).toEqual(['0 кг', '0', '0 кг', '0']);
    expect(accountingCellText(rows[1])).toBe('125 кг');
  });

  it('does not restore source diagnostics when the 1C comparison is stale', () => {
    const markup = renderToStaticMarkup(
      <DirectorMaterialPanel
        series={series}
        accounting={{
          ...accounting,
          source: { ...accounting.source, stale: true },
          coverage: { ...accounting.coverage, documentCount: 0 },
        }}
        spoolEvidence={spoolEvidence}
        displayMode="chart"
      />,
    );

    expect(markup).toContain('data-series-id="onec-materials"');
    expect(markup).not.toContain('Свежесть: требуется синхронизация');
    expect(markup).not.toContain('Не включено в килограммы: продукция 0, материалы 2.');
    expect(markup).not.toContain('В 1С за период данных нет');
  });
});
