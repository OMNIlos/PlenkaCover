import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDistinctPorts,
  assertExpectedCoverageCases,
} from './warehouse-coverage-v2-release-gate.mjs';

const cases = [
  'accept-v1-unchanged keeps the legacy proposal and approval flow',
  'accept-unavailable-production exposes only the atomic production route',
  'accept-unknown-recheck resolves a real warehouse case into a fresh generation',
  'accept-full-recovery releases reserve and opens the decision-linked recovery',
];

function listedCases(names = cases) {
  return [
    'Listing tests:',
    ...['coverage-v2-1024x768', 'coverage-v2-1440x900'].flatMap((project) =>
      names.map(
        (name, index) =>
          `  [${project}] › warehouse-coverage-v2.acceptance.spec.ts:${100 + index}:3 › ${name}`,
      ),
    ),
    `Total: ${names.length * 2} tests in 1 file`,
  ].join('\n');
}

test('rejects a vacuous Playwright list with zero acceptance cases', () => {
  assert.throws(
    () => assertExpectedCoverageCases('Listing tests:\nTotal: 0 tests in 0 files'),
    /expected 8 Playwright cases/u,
  );
});

test('accepts each of the four coverage cases in both required viewport projects', () => {
  assert.doesNotThrow(() => assertExpectedCoverageCases(listedCases()));
});

test('rejects a port plan that could make concurrent servers share a listener', () => {
  assert.throws(() => assertDistinctPorts([31_101, 31_102, 31_101, 52_274]), /must be unique/u);
});
