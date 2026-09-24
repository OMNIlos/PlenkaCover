import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./66-director-payroll.css', import.meta.url), 'utf8');
const tariffOrderStyles = readFileSync(
  new URL('./66-director-payroll-tariff-orders.css', import.meta.url),
  'utf8',
);

function extractCssBlock(source: string, prelude: string): string | undefined {
  const start = source.indexOf(prelude);
  if (start < 0) return undefined;
  const openingBrace = source.indexOf('{', start + prelude.length);
  if (openingBrace < 0) return undefined;

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  return undefined;
}

describe('director payroll responsive contract', () => {
  const tabletBlock = extractCssBlock(styles, '@media (max-width: 1180px)');
  const narrowBlock = extractCssBlock(styles, '@media (max-width: 900px)');
  const narrowTariffOrderBlock = extractCssBlock(
    tariffOrderStyles,
    '@media (max-width: 900px)',
  );

  it('adapts the summary from four columns to two and then one', () => {
    expect(styles).toMatch(
      /\.director-payroll-summary\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/u,
    );
    expect(tabletBlock).toMatch(
      /\.director-payroll-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u,
    );
    expect(narrowBlock).toMatch(
      /\.director-payroll-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
    );
  });

  it('renders payroll tables as labelled cards on narrow viewports', () => {
    expect(narrowBlock).toMatch(/\.director-payroll-table[^{]*\{[^}]*min-width:\s*0/u);
    expect(narrowBlock).toMatch(/\.director-payroll-table thead\s*\{[^}]*display:\s*none/u);
    expect(narrowBlock).toMatch(
      /\.director-payroll-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/u,
    );
  });

  it('keeps the responsive contract scoped to the payroll surface', () => {
    expect(styles).not.toMatch(/(?:^|[},])\s*body\s*\{|\.director-table\s*\{/u);
    expect(styles).not.toMatch(/transition\s*:\s*all\b/u);
  });

  it('makes the tariff-order dialog full-screen at 390px without page-level overflow', () => {
    expect(tariffOrderStyles).toMatch(/\.payroll-tariff-order-dialog\s*\{[^}]*width:\s*min\(/u);
    expect(narrowTariffOrderBlock).toMatch(
      /\.payroll-tariff-order-dialog\s*\{[^}]*width:\s*100vw[^}]*height:\s*100dvh/u,
    );
    expect(narrowTariffOrderBlock).toMatch(
      /\.payroll-tariff-order-dialog-body\s*\{[^}]*overflow-y:\s*auto/u,
    );
    expect(narrowTariffOrderBlock).not.toMatch(/overflow-x:\s*hidden/u);
  });
});
