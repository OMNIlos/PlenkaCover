import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sliceStyles = readFileSync(new URL('./113-production-cost.css', import.meta.url), 'utf8');
const performanceStyles = readFileSync(
  new URL('./110-commercial-performance.css', import.meta.url),
  'utf8',
);

function ruleFor(styles: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
}

describe('roll-cost responsive layout', () => {
  it('allows unresolved cost text to wrap without widening the roll table cell', () => {
    const cell = ruleFor(sliceStyles, '.production-roll-cost-column');
    const cost = ruleFor(sliceStyles, '.roll-cost-cell');

    expect(cell).toMatch(/white-space:\s*normal;/u);
    expect(cost).toMatch(/display:\s*grid;/u);
    expect(cost).toMatch(/max-width:\s*240px;/u);
    expect(cost).toMatch(/overflow-wrap:\s*anywhere;/u);
    expect(performanceStyles).toMatch(
      /\.commercial-performance-content\s*\{[^}]*overflow-x:\s*auto;/u,
    );
    expect(sliceStyles).toMatch(
      /@media\s*\(max-width:\s*1024px\)[\s\S]*?\.production-roll-cost-column\s*\{[^}]*max-width:\s*200px;/u,
    );
  });

  it('wraps four warehouse receipt fields and keeps its summary bounded', () => {
    const form = ruleFor(sliceStyles, '.warehouse-spool-price-form');
    const fields = ruleFor(sliceStyles, '.warehouse-spool-price-fields');
    const feedback = ruleFor(sliceStyles, '.warehouse-spool-price-feedback');
    const summary = ruleFor(sliceStyles, '.spool-stock-summary');

    expect(form).toMatch(/max-width:\s*100%;/u);
    expect(form).toMatch(/min-width:\s*0;/u);
    expect(fields).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/u);
    expect(feedback).toMatch(/min-height:\s*20px;/u);
    expect(summary).toMatch(/max-width:\s*100%;/u);
    expect(summary).toMatch(/min-width:\s*0;/u);
    expect(sliceStyles).toMatch(
      /@media\s*\(max-width:\s*1024px\)[\s\S]*?\.warehouse-spool-price-fields\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    );
    expect(sliceStyles).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.warehouse-spool-price-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
  });
});
