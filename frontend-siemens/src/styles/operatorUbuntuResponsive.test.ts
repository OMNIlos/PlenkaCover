import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const operatorStyles = readFileSync(
  new URL('./12-operator-rolls-hub.css', import.meta.url),
  'utf8',
);
const operatorShiftStyles = readFileSync(
  new URL('./50-operator-shift.css', import.meta.url),
  'utf8',
);
const operatorWorkbenchStyles = readFileSync(
  new URL('./51-operator-workbench.css', import.meta.url),
  'utf8',
);
const problemReportStyles = readFileSync(
  new URL('./22-problem-report-dialog.css', import.meta.url),
  'utf8',
);
const responsiveStyles = readFileSync(
  new URL('./90-responsive-motion.css', import.meta.url),
  'utf8',
);
const severityStyles = readFileSync(
  new URL('./99-severity-signal-diet.css', import.meta.url),
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

const mediumOperatorBlock = extractCssBlock(
  operatorStyles,
  '@media (min-width: 901px) and (max-width: 1240px)',
);
const wideWorkstationOperatorBlock = extractCssBlock(
  operatorStyles,
  '@media (min-width: 800px) and (max-width: 1240px)',
);
const scaledWorkstationOperatorBlock = extractCssBlock(
  operatorStyles,
  '@media (min-width: 800px) and (max-width: 900px)',
);
const compactOperatorBlock = extractCssBlock(
  operatorStyles,
  '@media (min-width: 641px) and (max-width: 900px)',
);
const mobileOperatorBlock = extractCssBlock(operatorStyles, '@media (max-width: 640px)');
const narrowOperatorBlock = extractCssBlock(
  responsiveStyles,
  '@media (min-width: 901px) and (max-width: 1100px)',
);
const operatorRollDetailDrawerBody = extractCssBlock(
  operatorWorkbenchStyles,
  '.operator-roll-detail-drawer-body',
);
const operatorTableTerminal = extractCssBlock(operatorWorkbenchStyles, '.operator-table-terminal');
const operatorSecondaryActions = extractCssBlock(
  operatorWorkbenchStyles,
  '.operator-row-secondary-rail',
);
const severityOperatorTableTerminal = extractCssBlock(
  severityStyles,
  '.role-operator .operator-terminal.operator-table-terminal',
);
const shortViewportProblemDialogBlock = extractCssBlock(
  problemReportStyles,
  '@media (min-width: 721px) and (max-height: 800px)',
);

describe('operator Ubuntu 1024 responsive contract', () => {
  it('keeps the dynamic problem target and recovery in the initial 1024x768 dialog viewport', () => {
    expect(shortViewportProblemDialogBlock).toBeDefined();
    expect(shortViewportProblemDialogBlock).toMatch(
      /\.problem-report-dialog\.is-compact-role \.problem-report-body\s*\{[^}]*gap:\s*10px;[^}]*padding-block:\s*12px;/u,
    );
    expect(shortViewportProblemDialogBlock).toMatch(
      /\.problem-report-dialog\.is-compact-role \.problem-report-form textarea\s*\{[^}]*height:\s*72px;[^}]*min-height:\s*72px;/u,
    );
  });

  it('lets the shift summary wrap without imposing four 120 px columns on its panel', () => {
    const shiftSummaryBlock = extractCssBlock(operatorShiftStyles, '.shift-summary-strip');

    expect(shiftSummaryBlock).toBeDefined();
    expect(shiftSummaryBlock).toMatch(
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(120px,\s*100%\),\s*1fr\)\);/u,
    );
    expect(shiftSummaryBlock).not.toMatch(/repeat\(4,\s*minmax\(120px,\s*1fr\)\)/u);
  });

  it('keeps the live shift action in the Ubuntu first fold', () => {
    expect(narrowOperatorBlock).toBeDefined();
    expect(narrowOperatorBlock).toMatch(
      /\.shift-surface-grid\s*\{[^}]*grid-template-columns:\s*1fr;/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.operator-shift-panel \.bigbag-picker-cards\s*\{[^}]*max-height:\s*180px;/u,
    );
  });

  it('keeps secondary roll actions in their own grid row', () => {
    expect(operatorTableTerminal).toMatch(
      /"summary"\s*"row-actions"\s*"secondary-actions"\s*"order-mass"/u,
    );
    expect(operatorSecondaryActions).toMatch(/grid-area:\s*secondary-actions;/u);
    expect(severityOperatorTableTerminal).toMatch(
      /"summary"\s*"row-actions"\s*"secondary-actions"\s*"order-mass"/u,
    );
  });

  it('stacks every named roll-detail area on one constrained column', () => {
    expect(operatorRollDetailDrawerBody).toBeDefined();
    expect(operatorRollDetailDrawerBody).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
    expect(operatorRollDetailDrawerBody).toMatch(
      /grid-template-areas:\s*"metrics"\s*"current"\s*"params"\s*"steps"\s*"label"\s*"devices";/u,
    );
    expect(operatorRollDetailDrawerBody).toMatch(/min-width:\s*0;/u);
  });

  it('wraps roll identifiers and bounds parameters and actions at workstation width', () => {
    expect(narrowOperatorBlock).toBeDefined();
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.operator-roll-detail-drawer > summary\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.operator-roll-detail-drawer > summary small\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.current-roll-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.current-roll-summary > div:nth-child\(2\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.current-roll-summary strong\s*\{[^}]*overflow-wrap:\s*anywhere;/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.operator-roll-primary-params,[\s\S]*?\.role-operator \.operator-roll-secondary-params > div\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    );
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.operator-current-actions \.action-tile\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u,
    );
  });

  it('shows complete route labels and values at workstation width', () => {
    expect(narrowOperatorBlock).toMatch(
      /\.role-operator \.operator-step-label,\s*\.role-operator \.operator-step-chip strong\s*\{[^}]*white-space:\s*normal;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;[^}]*overflow-wrap:\s*anywhere;/u,
    );
  });

  it('keeps the desktop operator navigation at workstation width', () => {
    expect(mediumOperatorBlock).toBeDefined();
    expect(mediumOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav \.role-top-nav-list\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(mediumOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav \.floor-mobile-section-nav\s*\{[^}]*display:\s*none;/u,
    );
    expect(mediumOperatorBlock).not.toMatch(/\.app-shell\s+\.role-top-nav-list/u);
  });

  it('places the roll list left and the selected processing window right at 1024', () => {
    expect(wideWorkstationOperatorBlock).toBeDefined();
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\]\s*\{[^}]*grid-template-areas:\s*"nav nav"\s*"hub detail";/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*0\.95fr\)\s*minmax\(0,\s*1\.05fr\);/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub\s*\{[^}]*grid-area:\s*hub;/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(/\.detail-view\s*\{[^}]*grid-area:\s*detail;/u);
  });

  it('keeps the selected processing window stationary while the left list scrolls', () => {
    expect(operatorStyles).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\]\[data-has-detail=['"]true['"]\]\s*>\s*\.detail-view\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--operator-processing-pane-sticky-top\);[^}]*max-height:\s*max\([^;]+;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;/u,
    );
    expect(scaledWorkstationOperatorBlock).toBeDefined();
    expect(scaledWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\]\[data-has-detail=['"]true['"]\]\s*>\s*\.detail-view\s*\{[^}]*position:\s*fixed;[^}]*right:\s*18px;[^}]*width:\s*calc\(\(100vw - 44px\) \* 0\.525\);/u,
    );
    expect(operatorStyles).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\]\s*>\s*\.detail-view\s*>\s*\.detail-header\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*5;/u,
    );
  });

  it('removes the empty detail track and redundant scroll owners at workstation width', () => {
    expect(operatorStyles).toMatch(
      /\.operator-rolls-hub-page\[data-has-detail=['"]false['"]\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(mediumOperatorBlock).toMatch(
      /\.operator-rolls-hub-page\[data-has-detail=['"]false['"]\]\s*\{[^}]*grid-template-areas:\s*"nav"\s*"hub";/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\]\[data-has-detail=['"]false['"]\]\s*\{[^}]*grid-template-areas:\s*"nav"\s*"hub";[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(operatorStyles).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav\s*\{[^}]*margin:\s*0;[^}]*overflow-x:\s*visible;/u,
    );
    expect(mediumOperatorBlock).toMatch(
      /\.operator-rolls-hub-table\s*\{[^}]*overflow-x:\s*visible;/u,
    );
  });

  it('keeps five selection columns in the left pane without horizontal overflow', () => {
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-order-band button\s*\{[^}]*grid-template-columns:\s*20px\s*minmax\(0,\s*1fr\)\s*minmax\(64px,\s*auto\);/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-page\[data-detail-first=['"]false['"]\][\s\S]*?\.operator-rolls-hub-order-band[\s\S]*?button\s*>\s*span:nth-of-type\(n \+ 3\),[\s\S]*?\.operator-rolls-hub-order-band em\s*\{[^}]*display:\s*none;/u,
    );
    expect(wideWorkstationOperatorBlock).toMatch(
      /\.operator-rolls-hub-row\s*\{[^}]*grid-template-columns:\s*minmax\(30px,\s*0\.32fr\)\s*minmax\(0,\s*1\.65fr\)\s*minmax\(0,\s*0\.7fr\)\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\);/u,
    );

    for (const column of ['queue', 'roll', 'order', 'status', 'step']) {
      expect(wideWorkstationOperatorBlock).not.toMatch(
        new RegExp(`\\[data-column="${column}"\\][^{]*\\{[^}]*display:\\s*none;`, 'u'),
      );
    }
    for (const column of [
      'priority',
      'machine',
      'parameters',
      'weight',
      'qrWarehouse',
      'blocker',
      'updated',
    ]) {
      expect(wideWorkstationOperatorBlock).toContain(`[data-column="${column}"]`);
    }
  });

  it('keeps the compact nine-column table through the 900 px boundary', () => {
    expect(compactOperatorBlock).toBeDefined();
    expect(compactOperatorBlock).toMatch(
      /\.operator-rolls-hub-row\s*\{[^}]*grid-template-columns:\s*repeat\(9,\s*minmax\(0,\s*1fr\)\);/u,
    );
    expect(compactOperatorBlock).toMatch(
      /\.operator-rolls-hub-table\s*\{[^}]*overflow-x:\s*visible;/u,
    );
    for (const column of ['parameters', 'qrWarehouse', 'updated']) {
      expect(compactOperatorBlock).toContain(`[data-column="${column}"]`);
    }
  });

  it('uses the compact drawer navigation only on genuinely narrow screens', () => {
    expect(compactOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav \.role-top-nav-list\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(mobileOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav \.role-top-nav-list\s*\{[^}]*display:\s*none;/u,
    );
    expect(mobileOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav \.floor-mobile-section-nav\s*\{[^}]*display:\s*flex;/u,
    );
    expect(mobileOperatorBlock).toMatch(
      /\.operator-rolls-hub-page > \.role-top-nav\s*\{[^}]*overflow-x:\s*hidden;/u,
    );
  });
});
