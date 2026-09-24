import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

import {
  hasFirstViewportPrimarySurface,
  visualNoisePrimarySelectors,
} from './visual-noise-audit-support.mjs';

async function loadVisualNoiseAuditRoutes() {
  const source = await readFile(new URL('./visual-noise-audit.mjs', import.meta.url), 'utf8');
  return [...source.matchAll(/\{ role: '([^']+)', section: '([^']*)' \}/g)].map(
    ([, role, section]) => ({ role, section }),
  );
}

async function loadWarehouseNavigationContract() {
  const source = await readFile(new URL('../src/domain/warehouseSections.ts', import.meta.url), {
    encoding: 'utf8',
  });
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  return import(moduleUrl).then(({ WAREHOUSE_STOCK_SECTION, WAREHOUSE_VISIBLE_SECTIONS }) => ({
    stockSection: WAREHOUSE_STOCK_SECTION,
    visibleSections: WAREHOUSE_VISIBLE_SECTIONS,
  }));
}

test('production template toolbar is a valid first-viewport primary surface', () => {
  const visibleSelectors = new Set(['.template-directory-toolbar']);

  assert.equal(
    hasFirstViewportPrimarySurface('production', (selector) => visibleSelectors.has(selector)),
    true,
  );
  assert.ok(visualNoisePrimarySelectors.production.includes('.template-directory-toolbar'));
});

test('shared business performance workspace is a valid director primary surface', () => {
  const visibleSelectors = new Set(['.commercial-performance-workspace']);

  assert.equal(
    hasFirstViewportPrimarySurface('director', (selector) => visibleSelectors.has(selector)),
    true,
  );
  assert.ok(visualNoisePrimarySelectors.director.includes('.commercial-performance-workspace'));
});

test('warehouse audit routes use canonical visible navigation labels', async () => {
  const { stockSection, visibleSections } = await loadWarehouseNavigationContract();
  const auditRoutes = await loadVisualNoiseAuditRoutes();
  const auditedSections = auditRoutes
    .filter(({ role, section }) => role === 'warehouse' && section)
    .map(({ section }) => section);

  assert.ok(auditedSections.length > 0);
  assert.ok(auditedSections.includes(stockSection));
  assert.deepEqual(
    auditedSections.filter((section) => !visibleSections.includes(section)),
    [],
  );
});
