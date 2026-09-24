import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { resolvePhase3ArtifactPaths } from './phase3-demo-artifacts.mjs';

const cwd = '/workspace/frontend-siemens';
const artifactRoot = path.join(cwd, 'qa-screenshots/phase3-demo-2026-06-11');

test('ordinary manual phase3 run preserves the canonical artifact paths', () => {
  assert.deepEqual(resolvePhase3ArtifactPaths({ cwd }), {
    screenshotDir: artifactRoot,
    reportPath: path.join(artifactRoot, 'phase3-demo-smoke-report.json'),
  });
});

test('concurrent run ids and caller ports resolve to distinct safe artifact paths', () => {
  const firstPortRun = resolvePhase3ArtifactPaths({ cwd, callerPort: 53101 });
  const secondPortRun = resolvePhase3ArtifactPaths({ cwd, callerPort: 53102 });
  const explicitRun = resolvePhase3ArtifactPaths({
    cwd,
    runId: 'review/A 02',
    callerPort: 53101,
  });
  const traversalRun = resolvePhase3ArtifactPaths({ cwd, runId: '..' });

  assert.equal(firstPortRun.screenshotDir, path.join(artifactRoot, 'runs/port-53101'));
  assert.equal(secondPortRun.screenshotDir, path.join(artifactRoot, 'runs/port-53102'));
  assert.equal(explicitRun.screenshotDir, path.join(artifactRoot, 'runs/run-review-A-02'));
  assert.equal(traversalRun.screenshotDir, path.join(artifactRoot, 'runs/run-..'));
  assert.notEqual(firstPortRun.reportPath, secondPortRun.reportPath);
  assert.notEqual(firstPortRun.reportPath, explicitRun.reportPath);
});
