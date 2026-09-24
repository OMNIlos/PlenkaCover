function coverageKey(role, viewport) {
  return `${role}/${viewport}`;
}

function missingCoverage(roles, viewports, entries) {
  const covered = new Set(entries.map((entry) => coverageKey(entry.role, entry.viewport)));
  return roles.flatMap((role) =>
    viewports
      .map((viewport) => coverageKey(role, viewport.name))
      .filter((key) => !covered.has(key)),
  );
}

export function assertCompleteNightlyCoverage({ roles, viewports, results, keyboard }) {
  const missingScenarios = missingCoverage(roles, viewports, results);
  const missingKeyboard = missingCoverage(roles, viewports, keyboard);
  const failures = [];
  if (missingScenarios.length > 0) {
    failures.push(`missing scenario coverage: ${missingScenarios.join(', ')}`);
  }
  if (missingKeyboard.length > 0) {
    failures.push(`missing keyboard coverage: ${missingKeyboard.join(', ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`Nightly show-ready audit is incomplete; ${failures.join('; ')}`);
  }
}

export function assertDirectorMaxLabelGateWiring(scripts) {
  const gateName = 'check:director-analytics:max-label';
  const gate = scripts?.[gateName] ?? '';
  const nightly = scripts?.['check:nightly'] ?? '';
  const missing = [];
  if (!gate.includes('npm run build')) missing.push(`${gateName} build`);
  if (!gate.includes('node scripts/director-control-browser-smoke.mjs')) {
    missing.push(`${gateName} smoke`);
  }
  if (!nightly.includes(`npm run ${gateName}`)) missing.push('check:nightly composition');
  if (missing.length > 0) {
    throw new Error(`Director maximum-label gate is incomplete: ${missing.join(', ')}`);
  }
}

export function assertDirectorControlGateWiring(scripts) {
  const liveName = 'check:director-analytics';
  const e2eName = 'check:director-analytics:e2e';
  const live = scripts?.[liveName] ?? '';
  const e2e = scripts?.[e2eName] ?? '';
  const missing = [];
  if (!live.includes('npm run build')) missing.push(`${liveName} build`);
  if (!live.includes('node scripts/director-control-browser-smoke.mjs')) {
    missing.push(`${liveName} current Control smoke`);
  }
  if (!e2e.includes('npm run build')) missing.push(`${e2eName} build`);
  if (!e2e.includes('node scripts/cross-contour-live-smoke.mjs')) {
    missing.push(`${e2eName} current live API smoke`);
  }
  if (missing.length > 0) {
    throw new Error(`Director Control gates are incomplete: ${missing.join(', ')}`);
  }
}
