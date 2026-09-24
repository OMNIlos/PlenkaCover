import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const performanceStyles = readFileSync(
  new URL('./110-commercial-performance.css', import.meta.url),
  'utf8',
);
const problemStyles = readFileSync(
  new URL('./111-commercial-problems.css', import.meta.url),
  'utf8',
);

function ruleFor(styles: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
}

describe('commercial role module layout', () => {
  it.each([
    [
      'Контроль / Финансы / Производство / Склад',
      performanceStyles,
      '.commercial-performance-workspace',
    ],
    ['Проблемы', problemStyles, '.commercial-problems'],
  ])(
    '%s stays in the workspace to the right of commercial navigation',
    (_label, styles, selector) => {
      const rule = ruleFor(styles, selector);

      expect(rule).toMatch(/grid-column:\s*2\s*\/\s*-1;/u);
      expect(rule).not.toMatch(/grid-column:\s*1\s*\/\s*-1;/u);
      expect(rule).toMatch(/min-height:\s*0;/u);
      expect(rule).toMatch(/overflow:\s*auto;/u);
    },
  );

  it('keeps the directly mounted problems root as the only scroll owner', () => {
    expect(problemStyles).not.toContain('.commercial-problems-shell');
    expect(problemStyles).toMatch(
      /@media\s*\(max-width:\s*900px\)[\s\S]*?\.commercial-problems\s*\{[^}]*grid-column:\s*1;/u,
    );
  });

  it('keeps the production workspace inside the viewport when roll details expand', () => {
    expect(performanceStyles).toMatch(
      /\.app-shell:has\(>\s*\.commercial-performance-workspace\)\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*var\(--app-chrome-height\)\);[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/u,
    );
    expect(performanceStyles).toMatch(
      /\.app-shell\s*>\s*\.commercial-performance-workspace\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/u,
    );
  });

  it('keeps every expanded roll row border on one baseline when parameters wrap', () => {
    const firstCellRule = ruleFor(
      performanceStyles,
      '.production-roll-drilldown-table td:first-child',
    );

    expect(firstCellRule).not.toMatch(/display:\s*grid;/u);
    expect(firstCellRule).toMatch(/vertical-align:\s*middle;/u);
    expect(performanceStyles).toMatch(
      /\.production-roll-drilldown-table td:first-child (?:strong|small),\s*\.production-roll-drilldown-table td:first-child (?:small|strong)\s*\{[^}]*display:\s*block;/u,
    );
  });

  it('highlights director rows by defect, active, and completed lifecycle states', () => {
    expect(performanceStyles).toContain(".app-shell[data-active-role='director']");
    expect(performanceStyles).toContain("[data-order-status='defect']");
    expect(performanceStyles).toContain("[data-order-status='in_production']");
    expect(performanceStyles).toContain("[data-order-status='processing']");
    expect(performanceStyles).toContain("[data-order-status='ready_for_warehouse']");
    expect(performanceStyles).toContain("[data-order-status='warehouse_handed_off']");
    expect(performanceStyles).toContain("[data-order-status='warehouse_accepted']");
    expect(performanceStyles).toContain("[data-order-status='warehouse_delivered']");
    expect(performanceStyles).toContain("[data-order-status='reserve']");
    expect(performanceStyles).not.toContain("[data-order-status='not_started']");
    expect(performanceStyles).not.toContain("[data-order-status='needs_production']");
    expect(performanceStyles).toContain('var(--state-critical-bg)');
    expect(performanceStyles).toContain('var(--state-warning-bg)');
    expect(performanceStyles).toContain('var(--state-success-bg)');
  });

  it('keeps the Control metrics compact on desktop without collapsing mobile cards', () => {
    const metricsRule = ruleFor(performanceStyles, '.commercial-performance-metrics');
    const cardRule = ruleFor(performanceStyles, '.commercial-performance-metrics article');
    const valueRule = ruleFor(performanceStyles, '.commercial-performance-metrics strong');

    expect(metricsRule).toMatch(/grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/u);
    expect(cardRule).toMatch(/min-height:\s*72px;/u);
    expect(cardRule).toMatch(/padding:\s*10px\s+12px;/u);
    expect(valueRule).toMatch(/font-size:\s*clamp\(18px,\s*1\.6vw,\s*24px\);/u);
    expect(performanceStyles).toMatch(
      /@media\s*\(max-width:\s*640px\)[\s\S]*?\.commercial-performance-metrics\s*\{[^}]*grid-template-columns:\s*1fr;/u,
    );
  });
});
