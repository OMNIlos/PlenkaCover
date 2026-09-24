import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ServerDirectorAccountingProduction } from '../../../api/director';
import { DirectorAccountingSource } from './DirectorAccountingSource';

const accounting: ServerDirectorAccountingProduction = {
  source: {
    sourceKind: '1C',
    label: '1С · Отчет производства за смену',
    latestImportedAt: '2026-07-28T09:00:00.000Z',
    latestDocumentDate: '2026-07-27T21:00:00.000Z',
    stale: false,
  },
  coverage: {
    documentCount: 4,
    excludedOutputLineCount: 1,
    excludedMaterialLineCount: 2,
  },
  productionSeries: [],
  materialSeries: [],
};

describe('DirectorAccountingSource', () => {
  it('renders separate import, document and coverage facts for the accounting source', () => {
    const markup = renderToStaticMarkup(<DirectorAccountingSource accounting={accounting} />);

    expect(markup).toContain('aria-label="Учётный источник производственных данных"');
    expect(markup).toContain('Учётный источник · Отчёт производства за смену');
    expect(markup).toContain('Импорт: 28.07.2026, 12:00');
    expect(markup).toContain('Последний документ: 28.07.2026, 00:00');
    expect(markup).toContain('Учётных документов: 4');
    expect(markup).toContain('Свежесть: актуально');
  });

  it('renders the server-projected stale state at the exact 24-hour threshold', () => {
    const markup = renderToStaticMarkup(
      <DirectorAccountingSource
        accounting={{
          ...accounting,
          source: {
            ...accounting.source,
            latestImportedAt: '2026-07-28T09:00:00.000Z',
            stale: true,
          },
        }}
      />,
    );

    expect(markup).toContain('director-accounting-source is-stale');
    expect(markup).toContain('Свежесть: требуется синхронизация');
    expect(markup).toContain('role="status"');
  });

  it('reports excluded output and material lines without exposing source rows', () => {
    const markup = renderToStaticMarkup(<DirectorAccountingSource accounting={accounting} />);

    expect(markup).toContain('Не включено в килограммы: продукция 1, материалы 2.');
    expect(markup).not.toContain('rawPayload');
    expect(markup).not.toContain('externalId');
  });

  it('keeps an empty selected period separate from the latest document date', () => {
    const markup = renderToStaticMarkup(
      <DirectorAccountingSource
        accounting={{
          ...accounting,
          coverage: {
            ...accounting.coverage,
            documentCount: 0,
          },
        }}
      />,
    );

    expect(markup).toContain(
      'За период учётных данных нет. Последний документ: 28.07.2026, 00:00',
    );
  });

  it('renders unknown import and document timestamps honestly', () => {
    const markup = renderToStaticMarkup(
      <DirectorAccountingSource
        accounting={{
          ...accounting,
          source: {
            ...accounting.source,
            latestImportedAt: null,
            latestDocumentDate: null,
            stale: true,
          },
          coverage: {
            ...accounting.coverage,
            documentCount: 0,
          },
        }}
      />,
    );

    expect(markup).toContain('Импорт: —');
    expect(markup).toContain('Последний документ: —');
    expect(markup).toContain('За период учётных данных нет. Последний документ: —');
  });
});
