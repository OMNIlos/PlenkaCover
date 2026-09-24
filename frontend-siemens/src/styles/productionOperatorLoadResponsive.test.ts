import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const productionStyles = readFileSync(
  new URL('./35-production-operator-load.css', import.meta.url),
  'utf8',
);
const dispatchPanelSource = readFileSync(
  new URL('../components/workbenches/productionDispatchPanel.tsx', import.meta.url),
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

const planningPageBlock = extractCssBlock(productionStyles, '.production-operator-planning-page');
const planningSurfaceBlock = extractCssBlock(
  productionStyles,
  '.production-machine-planning-surface',
);
const workstationBlock = extractCssBlock(
  productionStyles,
  '@media (min-width: 901px) and (max-width: 1100px)',
);
const machineWorkstationBlock = extractCssBlock(
  productionStyles,
  '@media (min-width: 901px) and (max-width: 1240px)',
);
const mobilePrelude = '@media (max-width: 900px)';
const mobileBlock = extractCssBlock(
  productionStyles.slice(productionStyles.lastIndexOf(mobilePrelude)),
  mobilePrelude,
);

describe('production operator assignment at Ubuntu 1024', () => {
  it('gives both planning grids a shrinkable explicit track', () => {
    expect(planningPageBlock).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
    expect(planningSurfaceBlock).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  });

  it('keeps the machine grid shrinkable inside the workstation', () => {
    expect(workstationBlock).toBeDefined();
    expect(workstationBlock).toMatch(
      /\.production-machine-planning-head\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/u,
    );
    expect(workstationBlock).toMatch(
      /\.production-shift-create-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u,
    );
    expect(workstationBlock).toMatch(
      /\.production-machine-planning-table\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/u,
    );
    expect(productionStyles).not.toMatch(
      /\.production-machine-planning-row\s*\{[^}]*min-width:\s*920px;/u,
    );
    expect(machineWorkstationBlock).toMatch(
      /\.production-machine-planning-row\s*\{[^}]*min-width:\s*0;/u,
    );
  });

  it('lets a long shift label shrink instead of widening the whole application', () => {
    expect(productionStyles).toMatch(
      /\.production-machine-planning-head,\s*\.production-machine-planning-head > div,\s*\.production-machine-planning-head > label\s*\{[^}]*min-width:\s*0;/u,
    );
    expect(productionStyles).toMatch(
      /\.production-machine-planning-head select\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u,
    );
  });

  it('uses six compact workload columns without a workstation minimum width', () => {
    const workloadRowBlock = workstationBlock
      ? extractCssBlock(workstationBlock, '.production-operator-load-row')
      : undefined;
    const workloadColumns = workloadRowBlock?.match(/grid-template-columns:\s*([^;]+);/u)?.[1];

    expect(workloadRowBlock).toMatch(/min-width:\s*0;/u);
    expect(workloadColumns?.match(/minmax\(0,/gu)).toHaveLength(6);
    expect(workstationBlock).toMatch(
      /\.production-operator-load-block,\s*\.production-operator-load-detail\s*\{[^}]*min-width:\s*0;/u,
    );
    expect(workstationBlock).not.toMatch(/min-width:\s*840px;/u);
  });

  it('keeps the full mobile card transformation below 901px', () => {
    expect(workstationBlock).not.toMatch(
      /\.production-operator-load-row\.is-head\s*\{[^}]*display:\s*none;/u,
    );
    expect(workstationBlock).not.toMatch(
      /\.production-operator-load-row\s*\{[^}]*grid-template-columns:\s*1fr;/u,
    );
    expect(mobileBlock).toMatch(
      /\.production-operator-load-row\s*\{[^}]*grid-template-columns:\s*1fr;/u,
    );
    expect(mobileBlock).toMatch(
      /\.production-operator-load-row\.is-head\s*\{[^}]*display:\s*none;/u,
    );
    expect(mobileBlock).toMatch(
      /\.production-machine-planning-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*min-width:\s*0;/u,
    );
    expect(mobileBlock).toMatch(
      /\.production-machine-planning-row\.is-head\s*\{[^}]*display:\s*none;/u,
    );
  });

  it('retains only explicit workload expansions when the operator list changes', () => {
    expect(dispatchPanelSource).not.toContain('firstAssignedOperatorId');
    expect(dispatchPanelSource).toMatch(
      /setExpandedOperatorIds\(\(current\) => \{[\s\S]*?validOperatorIds[\s\S]*?retainedOperatorIds = current\.filter\(\(operatorId\) => validOperatorIds\.has\(operatorId\)\);[\s\S]*?return retainedOperatorIds\.length === current\.length \? current : retainedOperatorIds;[\s\S]*?\}\);/u,
    );
  });
});
