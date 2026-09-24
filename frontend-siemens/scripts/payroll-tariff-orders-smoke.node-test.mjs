import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const smokeUrl = new URL('./payroll-tariff-orders-smoke.mjs', import.meta.url);

test('payroll tariff smoke owns the exact routes and three required viewports', async () => {
  const source = await readFile(smokeUrl, 'utf8');

  for (const route of [
    '/api/director/payroll-preview',
    '/api/director/payroll-tariff-orders',
    '/review',
    '/publish',
  ]) {
    assert.match(source, new RegExp(route.replaceAll('/', '\\/'), 'u'));
  }
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
    [390, 844],
  ]) {
    assert.match(source, new RegExp(`width:\\s*${width},\\s*height:\\s*${height}`, 'u'));
  }
  assert.match(source, /const vitePreviewArgs\s*=\s*\[\s*'preview'/u);
  assert.match(source, /127\.0\.0\.1/u);
});

test('payroll tariff smoke proves the safe mutation state machine and conflict recovery', async () => {
  const source = await readFile(smokeUrl, 'utf8');

  assert.match(source, /assertCancelCreatesNoDraft/u);
  assert.match(source, /assertCreateSaveReviewPublish/u);
  assert.match(source, /assertPublishedReadOnly/u);
  assert.match(source, /assertStaleConflictRetainsInput/u);
  assert.match(source, /PAYROLL_TARIFF_ORDER_DRAFT_STALE/u);
  assert.match(source, /operationKey/u);
  assert.match(source, /expectedRevision/u);
  assert.match(source, /reviewedMatrixHash/u);
  assert.match(source, /Загрузить актуальную редакцию/u);
});

test('payroll tariff smoke covers accessibility, diagnostics and prohibited integrations', async () => {
  const source = await readFile(smokeUrl, 'utf8');

  assert.match(source, /keyboard\.press\('Enter'\)/u);
  assert.match(source, /keyboard\.press\('Escape'\)/u);
  assert.match(source, /document\.activeElement/u);
  assert.match(source, /horizontalOverflow/u);
  assert.match(source, /installPageFailureTracker/u);
  assert.match(source, /forbiddenApiPrefixes/u);
  for (const forbiddenRoute of ['/api/gateway', '/api/admin/devices', '/api/onec']) {
    assert.match(source, new RegExp(forbiddenRoute.replaceAll('/', '\\/'), 'u'));
  }
  assert.match(source, /mkdtemp/u);
  assert.match(source, /screenshot/u);
});

test('package exposes the real payroll tariff browser gate without inventing lint', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(
    packageJson.scripts['check:payroll-tariff-orders'],
    'node scripts/payroll-tariff-orders-smoke.mjs',
  );
  assert.equal(packageJson.scripts.lint, undefined);
});
