import path from 'node:path';

const DEFAULT_ARTIFACT_DIRECTORY = 'qa-screenshots/phase3-demo-2026-06-11';

function safeRunKey(value) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
}

export function resolvePhase3ArtifactPaths({
  cwd,
  runId,
  callerPort,
}) {
  const artifactRoot = path.resolve(cwd, DEFAULT_ARTIFACT_DIRECTORY);
  const explicitRunKey = runId ? safeRunKey(runId) : '';
  const runKey = explicitRunKey
    ? `run-${explicitRunKey}`
    : callerPort
      ? `port-${callerPort}`
      : '';
  const screenshotDir = runKey ? path.join(artifactRoot, 'runs', runKey) : artifactRoot;

  return {
    screenshotDir,
    reportPath: path.join(screenshotDir, 'phase3-demo-smoke-report.json'),
  };
}
