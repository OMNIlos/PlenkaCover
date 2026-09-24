import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const warehouseResponsiveStyles = readFileSync(
  new URL('./107-warehouse-responsive-sanity.css', import.meta.url),
  'utf8',
);
const warehouseLayoutStyles = readFileSync(
  new URL('./106-warehouse-layout-sanity.css', import.meta.url),
  'utf8',
);

function extractCssBlock(source: string, prelude: string) {
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

const workstationBlock = extractCssBlock(warehouseResponsiveStyles, '@media (max-width: 1180px)');
const narrowRollTableBlock = extractCssBlock(
  warehouseResponsiveStyles,
  '@container (max-width: 820px)',
);
const narrowBlock = extractCssBlock(warehouseResponsiveStyles, '@media (max-width: 900px)');
const compactWorkstationBlock = workstationBlock?.replace(/\s+/gu, ' ');

describe('warehouse Ubuntu 1024 responsive contract', () => {
  it('bounds the desktop operation master and gives the remaining width to its detail', () => {
    expect(warehouseLayoutStyles).toMatch(
      /\.warehouse-scan-station-layout\s*\{[^}]*grid-template-columns:\s*minmax\(300px,\s*420px\)\s+minmax\(0,\s*1fr\);/u,
    );
  });

  it('keeps the desktop queue compact without switching the master table into cards', () => {
    expect(warehouseLayoutStyles).toMatch(
      /\.warehouse-scan-station-data-table\s*\{[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed;/u,
    );
    expect(warehouseResponsiveStyles).not.toContain('@container warehouse-scan-queue');
    expect(warehouseResponsiveStyles).not.toMatch(/grid-row:\s*1\s*\/\s*span\s*8/u);
  });

  it('stacks roll facts by the detail container width and keeps actions inside the card', () => {
    expect(narrowRollTableBlock).toBeDefined();
    expect(narrowRollTableBlock).toMatch(
      /\.warehouse-roll-row,\s*\.warehouse-roll-row\.is-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(narrowRollTableBlock).toMatch(
      /\.warehouse-row-actions\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/u,
    );
    expect(narrowRollTableBlock).toMatch(
      /\.warehouse-row-actions > \.warehouse-row-action\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/u,
    );
    expect(narrowRollTableBlock).not.toMatch(/(?:^|\n)\s*\.warehouse-row-action\s*\{/u);
  });

  it('uses compact navigation for both warehouse hubs by 1180px', () => {
    expect(workstationBlock).toBeDefined();
    for (const hub of ['warehouse-scan-hub-page', 'warehouse-inventory-hub-page']) {
      expect(workstationBlock).toMatch(
        new RegExp(`\\.${hub} \\.role-top-nav-list[^{]*\\{[^}]*display:\\s*none;`, 'u'),
      );
      expect(workstationBlock).toMatch(
        new RegExp(`\\.${hub} \\.floor-mobile-section-nav[^{]*\\{[^}]*display:\\s*flex;`, 'u'),
      );
    }
  });

  it('stacks both warehouse master/detail workstations before either side becomes cramped', () => {
    expect(workstationBlock).toMatch(
      /\.warehouse-scan-station-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(workstationBlock).not.toMatch(
      /\.warehouse-(?:scan-station-detail|inventory-detail)[^{]*\{[^}]*order:\s*-1;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-scan-station-detail,\s*\.warehouse-inventory-detail\s*\{[^}]*order:\s*0;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-scan-station-detail\s*\{[^}]*position:\s*static;[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-layout,[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-detail\s*\{[^}]*position:\s*static;[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/u,
    );
  });

  it('does not turn both sides of the two-column workstation into cards at one outer breakpoint', () => {
    const queueBecomesCards = Boolean(
      workstationBlock?.match(
        /\.warehouse-scan-station-table \.warehouse-scan-station-data-table,\s*\.warehouse-scan-station-table \.warehouse-scan-station-data-table tbody,\s*\.warehouse-scan-station-table \.warehouse-scan-station-data-table tr,\s*\.warehouse-scan-station-table \.warehouse-scan-station-data-table td\s*\{[^}]*display:\s*block;/u,
      ),
    );
    const detailBecomesCards = Boolean(
      workstationBlock?.match(
        /\.warehouse-scan-station-detail \.warehouse-roll-row,\s*\.warehouse-scan-station-detail \.warehouse-roll-row\.is-head\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
      ),
    );

    expect(queueBecomesCards && detailBecomesCards).toBe(false);
  });

  it('keeps the compact queue and roll table in table mode at the outer stack breakpoint', () => {
    expect(workstationBlock).not.toContain(
      '.warehouse-scan-station-table .warehouse-scan-station-data-table thead',
    );
    expect(workstationBlock).not.toContain('.warehouse-scan-station-detail .warehouse-roll-row');
  });

  it('renders inventory rows as cards inside the narrow workstation column', () => {
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table\s*\{[^}]*min-width:\s*0;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table thead\s*\{[^}]*display:\s*block;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table thead tr\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table,\s*\.warehouse-inventory-main \.warehouse-inventory-data-table tbody,\s*\.warehouse-inventory-main \.warehouse-inventory-data-table tr,\s*\.warehouse-inventory-main \.warehouse-inventory-data-table td\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table td\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\([^)]*\)\s+minmax\(0,\s*1fr\);/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table td::before\s*\{[^}]*content:\s*attr\(data-label\);/u,
    );
    expect(workstationBlock).not.toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table td::before\s*\{[^}]*grid-row:\s*1\s*\/\s*span\s*8;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-row-edit-actions\s*\{[^}]*display:\s*grid;[^}]*width:\s*100%;/u,
    );
    expect(workstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-row-edit-actions button\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/u,
    );
  });

  it('lets empty inventory states use the full table width without a synthetic label', () => {
    expect(compactWorkstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table \.plenki-data-table-empty-row td\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;/u,
    );
    expect(compactWorkstationBlock).toMatch(
      /\.warehouse-inventory-main \.warehouse-inventory-data-table \.plenki-data-table-empty-row td::before\s*\{[^}]*display:\s*none;/u,
    );
    expect(compactWorkstationBlock).not.toContain('.warehouse-inventory-data-table-empty-row');
  });

  it('keeps the narrow inventory detail after its table', () => {
    expect(narrowBlock).toBeDefined();
    expect(narrowBlock).toMatch(
      /\.warehouse-scan-station-layout,\s*\.warehouse-inventory-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(narrowBlock).toMatch(/\.warehouse-inventory-detail\s*\{[^}]*order:\s*2;/u);
  });
});
