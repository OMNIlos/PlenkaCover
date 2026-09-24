import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertCompleteNightlyCoverage,
  assertDirectorControlGateWiring,
  assertDirectorMaxLabelGateWiring,
} from './nightly-show-ready-audit-support.mjs';

const roles = ['commercial', 'operator'];
const viewports = [{ name: 'desktop-1440' }, { name: 'tablet-1024' }];

function result(role, viewport, variant = 'row') {
  return { role, viewport, variant, ok: true };
}

function keyboard(role, viewport) {
  return { role, viewport, ok: true };
}

test('rejects a vacuous nightly report with no audited scenarios', () => {
  assert.throws(
    () =>
      assertCompleteNightlyCoverage({
        roles,
        viewports,
        results: [],
        keyboard: [],
      }),
    /missing scenario coverage.*commercial\/desktop-1440/iu,
  );
});

test('accepts row and explicit state scenarios when every role and viewport is audited', () => {
  assert.doesNotThrow(() =>
    assertCompleteNightlyCoverage({
      roles,
      viewports,
      results: [
        result('commercial', 'desktop-1440'),
        result('commercial', 'tablet-1024', 'empty-state'),
        result('operator', 'desktop-1440'),
        result('operator', 'tablet-1024', 'error-state'),
      ],
      keyboard: [
        keyboard('commercial', 'desktop-1440'),
        keyboard('commercial', 'tablet-1024'),
        keyboard('operator', 'desktop-1440'),
        keyboard('operator', 'tablet-1024'),
      ],
    }),
  );
});

test('rejects missing keyboard coverage even when scenario coverage is complete', () => {
  assert.throws(
    () =>
      assertCompleteNightlyCoverage({
        roles,
        viewports,
        results: [
          result('commercial', 'desktop-1440'),
          result('commercial', 'tablet-1024'),
          result('operator', 'desktop-1440'),
          result('operator', 'tablet-1024'),
        ],
        keyboard: [
          keyboard('commercial', 'desktop-1440'),
          keyboard('commercial', 'tablet-1024'),
          keyboard('operator', 'desktop-1440'),
        ],
      }),
    /missing keyboard coverage.*operator\/tablet-1024/iu,
  );
});

test('rejects a nightly composition that can omit the director maximum-label smoke', () => {
  assert.throws(
    () =>
      assertDirectorMaxLabelGateWiring({
        'check:director-analytics:max-label': 'npm run build',
        'check:nightly': 'node scripts/nightly-show-ready-audit.mjs',
      }),
    /maximum-label gate is incomplete.*smoke.*composition/iu,
  );
});

test('package scripts wire the director maximum-label smoke into the nightly gate', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.doesNotThrow(() => assertDirectorMaxLabelGateWiring(packageJson.scripts));
});

test('package scripts wire director gates to the current BusinessPerformanceWorkspace', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.doesNotThrow(() => assertDirectorControlGateWiring(packageJson.scripts));
});

test(
  'director browser gate proves the current Control contract instead of legacy analytics DOM',
  () => {
    const source = readFileSync(
      new URL('./director-control-browser-smoke.mjs', import.meta.url),
      'utf8',
    );

    assert.match(source, /\.commercial-performance-workspace/u);
    assert.match(source, /\/api\/commercial\/performance\/control/u);
    assert.match(source, /data-control-period-id/u);
    assert.match(source, /data-chart-group-id/u);
    assert.match(source, /Факты BigBag/u);
    assert.match(source, /layout-shift/u);
    assert.match(source, /page\.reload/u);
    assert.doesNotMatch(source, /\/api\/director\/analytics/u);
    assert.doesNotMatch(source, /\.management-period-selector|data-analytics-tab/u);
  },
);
