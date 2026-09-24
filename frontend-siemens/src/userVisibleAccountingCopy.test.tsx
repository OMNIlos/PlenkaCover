import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDirectorAccountingProduction } from './api/director';
import { FinanceInvoiceWizard } from './components/workbenches/FinanceInvoiceWizard';
import { DirectorPayrollSurface } from './components/workbenches/DirectorPayrollSurface';
import { DirectorAccountingSource } from './components/workbenches/director-analytics/DirectorAccountingSource';
import { DirectorMaterialPanel } from './components/workbenches/director-analytics/DirectorMaterialPanel';
import { roleAccessPolicies } from './domain/accessPolicy';
import { externalSourceLabel } from './domain/adapters/sourceProjection';
import { businessSourceLabel, warehouseSourceLabel } from './domain/displayContracts';
import { financePaymentSourceLabel } from './domain/financePaymentSources';

const oneCBrand = /(?:1[СC]|OneC)/iu;
const visibleText = (markup: string) => markup.replace(/<[^>]+>/gu, ' ');

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
    excludedOutputLineCount: 0,
    excludedMaterialLineCount: 0,
  },
  productionSeries: [],
  materialSeries: [{ bucketStartDate: '2026-07-28', consumedKg: 125 }],
};

describe('user-visible accounting copy', () => {
  it('keeps source projections useful without exposing the disabled integration brand', () => {
    const labels = [
      businessSourceLabel('1C'),
      warehouseSourceLabel('mock_1C'),
      externalSourceLabel('1C'),
      financePaymentSourceLabel('1C'),
    ];

    expect(labels).toEqual([
      'учётный снимок',
      'учётный снимок',
      'учётный снимок',
      'Учётный источник',
    ]);
    expect(labels.join(' ')).not.toMatch(oneCBrand);
  });

  it('keeps all role access explanations free of the disabled integration brand', () => {
    const accessCopy = Object.values(roleAccessPolicies)
      .flatMap((policy) => [policy.visibleSections, policy.accessSummary])
      .flat()
      .join(' ');

    expect(accessCopy).not.toMatch(oneCBrand);
  });

  it('renders director accounting, material and payroll surfaces without integration branding', () => {
    const markup = visibleText([
      renderToStaticMarkup(<DirectorAccountingSource accounting={accounting} />),
      renderToStaticMarkup(
        <DirectorMaterialPanel
          series={[]}
          accounting={accounting}
          spoolEvidence={{
            availability: 'measured_evidence_only',
            explanation: 'Только зафиксированные производственные замеры.',
          }}
          displayMode="chart"
        />,
      ),
      renderToStaticMarkup(<DirectorPayrollSurface useLiveData={false} />),
    ].join(' '));

    expect(markup).not.toMatch(oneCBrand);
    expect(markup).toContain('Учётный источник');
    expect(markup).toContain('Бухгалтерское списание');
  });

  it('keeps the ordinary invoice workflow while removing integration copy', () => {
    const markup = renderToStaticMarkup(
      <FinanceInvoiceWizard
        action={{ id: 'finance-create-invoice', label: 'Оформить счёт', level: 'recommended', enabled: true }}
        financeOrderId="finance-1"
        onClose={vi.fn()}
      />,
    );

    const text = visibleText(markup);
    expect(text).toContain('Сумма и строки счёта фиксируются вручную в платформе.');
    expect(text).not.toMatch(oneCBrand);
  });
});
