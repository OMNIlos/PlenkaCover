import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesDir = path.join(rootDir, 'src', 'styles');
const srcDir = path.join(rootDir, 'src');
const reportDir = path.join(rootDir, 'qa-screenshots', 'css-debt-2026-07-25');
const reportPath = path.join(reportDir, 'css-debt-report.json');

const baselines = {
  snapshot: {
    auditedAt: '2026-07-25',
    sourceSha: '2f4b79939e1b8cd7f27ee4e2f62f22cdc665ef40',
    adjustments: ['Task26 production label floor: 12px -> 13px'],
  },
  totalCssLines: 29170,
  sub13FontSizes: 379,
  directSiemensUsage: 139,
  fileLines: {
    '00-tokens-base.css': 328,
    '01-shell-navigation.css': 232,
    '02-list-detail.css': 954,
    '03-plenki-vella-primitives.css': 646,
    '10-operator-list.css': 243,
    '100-minimal-ui-diet.css': 152,
    '101-auth-shell.css': 100,
    '106-warehouse-layout-sanity.css': 653,
    '107-warehouse-responsive-sanity.css': 594,
    '12-operator-rolls-hub.css': 727,
    '20-intake-templates.css': 241,
    '21-counterparty-quick-create.css': 188,
    '22-problem-report-dialog.css': 326,
    '23-action-confirmation-dialog.css': 49,
    '24-recipe-editor.css': 231,
    '30-office-workbenches.css': 2437,
    '31-commercial-golden-slice.css': 1944,
    '32-commercial-overview-dashboard.css': 394,
    '32-production-orders-hub.css': 723,
    '33-finance-installment-wizard.css': 680,
    '33-finance-warehouse-coverage.css': 224,
    '33-finance-workbench.css': 2070,
    '34-order-surface-primitives.css': 459,
    '35-production-operator-load.css': 1167,
    '40-hover-actions.css': 308,
    '50-operator-shift.css': 643,
    '51-operator-roll-evidence.css': 209,
    '51-operator-workbench.css': 1463,
    '52-warehouse.css': 573,
    '53-floor-constraint-slice.css': 97,
    '53-warehouse-pallet-label.css': 254,
    '54-admin.css': 798,
    '55-admin-diagnostics-slice.css': 128,
    '56-admin-live-control-plane.css': 404,
    '60-director-tables.css': 1628,
    '61-penalties.css': 129,
    '63-director-dashboard-slice.css': 144,
    '64-director-control-report.css': 1183,
    '65-director-analytics.css': 671,
    '90-responsive-motion.css': 1700,
    '91-commercial-live.css': 434,
    '91-commercial-queue-states.css': 37,
    '92-commercial-order-detail.css': 296,
    '93-commercial-raw-materials.css': 194,
    '94-commercial-mobile.css': 110,
    '95-button-contrast-a11y.css': 291,
    '96-mobile-typography-floor.css': 27,
    '97-selected-state-diet.css': 334,
    '98-wide-screen-layout.css': 75,
    '99-nexius-cbd-integration.css': 187,
    '99-nexius-commercial-cleanup.css': 533,
    '99-severity-signal-diet.css': 239,
    '99-visual-noise-reset.css': 319,
  },
  rawHexAllowedByFile: {
    '101-auth-shell.css': 2,
    '20-intake-templates.css': 12,
    '31-commercial-golden-slice.css': 4,
    '33-finance-workbench.css': 23,
    '40-hover-actions.css': 10,
    '50-operator-shift.css': 4,
    '56-admin-live-control-plane.css': 1,
  },
  overflowHiddenAllowedByFile: {
    '12-operator-rolls-hub.css': 1,
    '24-recipe-editor.css': 1,
  },
  largeFileReportThreshold: 500,
};

const regexes = {
  rawHex: /#[0-9a-fA-F]{3,8}\b/g,
  transitionAll: /transition\s*:\s*all\b/gi,
  overflowHidden: /overflow-x\s*:\s*hidden\b/gi,
  sub13FontSize: /font-size\s*:\s*(10|11|12)px\b/gi,
  siemensUsage: /@siemens\/ix-react|@siemens\/ix-icons|<Ix|<ix-|ix-icon|Ix[A-Z]/g,
};

const countMatches = (content, regex) => [...content.matchAll(regex)].length;

const countMatchingLines = (content, regex) =>
  content
    .split(/\r?\n/)
    .filter((line) => {
      regex.lastIndex = 0;
      return regex.test(line);
    }).length;

const countLines = (content) => {
  if (content.length === 0) {
    return 0;
  }
  const newlineCount = (content.match(/\n/g) ?? []).length;
  return content.endsWith('\n') ? newlineCount : newlineCount + 1;
};

const collectFiles = (dir, predicate) => {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, predicate));
      continue;
    }

    if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files.sort();
};

const cssFiles = collectFiles(stylesDir, (file) => file.endsWith('.css'));
const tsFiles = collectFiles(srcDir, (file) => /\.(ts|tsx)$/.test(file));

const cssReports = cssFiles.map((file) => {
  const content = readFileSync(file, 'utf8');
  const name = path.basename(file);

  return {
    file: path.relative(rootDir, file),
    name,
    lines: countLines(content),
    rawHex: name === '00-tokens-base.css' ? 0 : countMatches(content, regexes.rawHex),
    rawHexIncludingTokens: countMatches(content, regexes.rawHex),
    transitionAll: countMatches(content, regexes.transitionAll),
    overflowHidden: countMatches(content, regexes.overflowHidden),
    sub13FontSizes: countMatches(content, regexes.sub13FontSize),
  };
});

const directSiemensUsage = tsFiles.reduce((total, file) => {
  const content = readFileSync(file, 'utf8');
  return total + countMatchingLines(content, regexes.siemensUsage);
}, 0);

const totals = cssReports.reduce(
  (acc, item) => ({
    cssLines: acc.cssLines + item.lines,
    rawHexOutsideTokens: acc.rawHexOutsideTokens + item.rawHex,
    transitionAll: acc.transitionAll + item.transitionAll,
    overflowHidden: acc.overflowHidden + item.overflowHidden,
    sub13FontSizes: acc.sub13FontSizes + item.sub13FontSizes,
  }),
  {
    cssLines: 0,
    rawHexOutsideTokens: 0,
    transitionAll: 0,
    overflowHidden: 0,
    sub13FontSizes: 0,
  },
);

totals.directSiemensUsage = directSiemensUsage;

const largestFiles = [...cssReports]
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 10)
  .map(({ file, lines }) => ({ file, lines }));

const oversizedFiles = cssReports
  .filter((item) => item.lines > baselines.largeFileReportThreshold)
  .map(({ file, lines }) => ({ file, lines }));

const failures = [];

if (totals.cssLines > baselines.totalCssLines) {
  failures.push(`CSS line total grew: ${totals.cssLines} > ${baselines.totalCssLines}`);
}

if (totals.sub13FontSizes > baselines.sub13FontSizes) {
  failures.push(`Sub-13px font-size count grew: ${totals.sub13FontSizes} > ${baselines.sub13FontSizes}`);
}

if (totals.directSiemensUsage > baselines.directSiemensUsage) {
  failures.push(`Direct Siemens/iX usage grew: ${totals.directSiemensUsage} > ${baselines.directSiemensUsage}`);
}

if (totals.transitionAll > 0) {
  failures.push(`transition: all occurrences found: ${totals.transitionAll}`);
}

for (const item of cssReports) {
  const fileBaseline = baselines.fileLines[item.name];

  if (fileBaseline === undefined) {
    failures.push(`Unbaselined CSS file found: ${item.file} (${item.lines} lines)`);
  }

  if (fileBaseline !== undefined && item.lines > fileBaseline) {
    failures.push(`CSS file grew past baseline: ${item.file} ${item.lines} > ${fileBaseline}`);
  }

  if (item.name === '00-tokens-base.css') {
    continue;
  }

  const rawHexLimit = baselines.rawHexAllowedByFile[item.name] ?? 0;
  if (item.rawHex > rawHexLimit) {
    failures.push(`Raw hex outside token baseline grew: ${item.file} ${item.rawHex} > ${rawHexLimit}`);
  }

  const overflowHiddenLimit = baselines.overflowHiddenAllowedByFile[item.name] ?? 0;
  if (item.overflowHidden > overflowHiddenLimit) {
    failures.push(
      `overflow-x: hidden baseline grew: ${item.file} ${item.overflowHidden} > ${overflowHiddenLimit}`,
    );
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  rootDir,
  baselines,
  totals,
  largestFiles,
  oversizedFiles,
  files: cssReports,
  failures,
};

mkdirSync(reportDir, { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('CSS debt audit');
console.log(
  `- baseline: ${baselines.snapshot.auditedAt} @ ${baselines.snapshot.sourceSha.slice(0, 7)}`,
);
console.log(`- total CSS lines: ${totals.cssLines}/${baselines.totalCssLines}`);
console.log(`- sub-13px font-size declarations: ${totals.sub13FontSizes}/${baselines.sub13FontSizes}`);
console.log(`- raw hex outside tokens: ${totals.rawHexOutsideTokens}`);
console.log(`- transition: all: ${totals.transitionAll}`);
console.log(`- overflow-x: hidden: ${totals.overflowHidden}`);
console.log(`- direct Siemens/iX usage: ${totals.directSiemensUsage}/${baselines.directSiemensUsage}`);
console.log(`- report: ${path.relative(rootDir, reportPath)}`);

if (failures.length > 0) {
  console.error('\nCSS debt audit failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
