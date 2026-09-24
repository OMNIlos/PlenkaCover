import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertBefore(source, earlier, later, context) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert(earlierIndex >= 0, `${context}: missing ${earlier}`);
  assert(laterIndex >= 0, `${context}: missing ${later}`);
  assert(earlierIndex < laterIndex, `${context}: ${earlier} must be before ${later}`);
}

function assertHandlerDoesNotContain(source, startNeedle, forbiddenNeedle, context) {
  const startIndex = source.indexOf(startNeedle);
  assert(startIndex >= 0, `${context}: missing ${startNeedle}`);
  const endIndex = source.indexOf('\n      }\n', startIndex);
  const block = source.slice(startIndex, endIndex > startIndex ? endIndex : startIndex + 900);
  assert(!block.includes(forbiddenNeedle), `${context}: forbidden ${forbiddenNeedle}`);
}

const app = read('src/App.tsx');
const commercial = read('src/domain/fixtures/commercial.ts');
const director = read('src/domain/fixtures/director.ts');
const operator = read('src/domain/operator/fixtures.ts');
const warehouse = read('src/domain/fixtures/warehouse.ts');
const finance = read('src/domain/fixtures/finance.ts');
const admin = read('src/domain/fixtures/admin.ts');
const production = read('src/domain/fixtures/production.ts');
const actions = read('src/domain/actions.ts');

assertBefore(commercial, "id: 'З-2606-021'", "id: 'З-2606-019'", 'commercial positive scenario order');
assertBefore(director, "id: 'DIR-2606-004'", "id: 'DIR-2606-006'", 'director happy path order');
assert(director.includes("id: 'DIR-2606-004'") && director.includes("severity: 'info'"), 'director happy path must be info');
assert(operator.includes("status: 'active'") && operator.includes('startKg: 700'), 'operator shift must start active with start Big-bag weight');
assert(warehouse.includes("'WH-2606-046': 0"), 'warehouse WH-2606-046 must be first-priority happy path');

[
  ['finance route to warehouse', finance, 'finance-open-warehouse-delivery:WH-2606-047'],
  ['finance route handler', app, "actionId.startsWith('finance-open-warehouse-delivery:')"],
  ['admin source action', admin, 'admin-retry-finance-source'],
  ['admin scale action', admin, 'admin-check-scale'],
  ['admin scanner action', admin, 'admin-bind-scanner'],
  ['admin diagnostic handler', app, 'resolveAdminDiagnosticObject'],
  ['production apply route', actions, 'productionApplyTemplate'],
  ['production fill route', actions, 'productionFillRequired'],
  ['production recovery handler', app, 'recoverProductionObject'],
  ['warehouse static scan handler', app, "'scan-ready'"],
  ['warehouse partial handler', app, "actionId === 'partial' || actionId === 'partial-receiving'"],
  ['generic problem context', app, 'createProblemReportContext(role, object, actionId)'],
  ['generic problem submit', app, 'addProblemReportToObject(object, payload)'],
].forEach(([label, source, needle]) => assert(source.includes(needle), `${label}: missing ${needle}`));

assertHandlerDoesNotContain(app, "actionId.startsWith('finance-open-warehouse-delivery:')", "changeRole('warehouse')", 'finance delivery status must stay in finance role');
assertHandlerDoesNotContain(app, "action.kind === 'commercialOpenProduction'", "changeRole('production')", 'commercial production status must stay in commercial role');
assertHandlerDoesNotContain(app, "normalized.includes('open-scans')", "changeRole('warehouse')", 'director warehouse drilldown must stay in director role');

const fixtureSources = [
  ['commercial', commercial],
  ['production', production],
  ['finance', finance],
  ['director', director],
  ['warehouse', warehouse],
  ['admin', admin],
].map(([name, source]) => [name, source.replace(/\n/g, ' ')]);

fixtureSources.forEach(([name, source]) => {
  const disabledActions = source.match(/\{[^{}]*disabledReason:[^{}]*\}/g) ?? [];
  disabledActions.forEach((block, index) => {
    assert(block.includes('recoveryAction:'), `${name}: disabled action #${index + 1} lacks recoveryAction`);
    assert(block.includes('recoveryOwner:'), `${name}: disabled action #${index + 1} lacks recoveryOwner`);
  });

  const openProblems = source.match(/\{[^{}]*status: 'open'[^{}]*\}/g) ?? [];
  openProblems.forEach((block, index) => {
    assert(block.includes('ownerRole:'), `${name}: open problem #${index + 1} lacks ownerRole`);
    assert(block.includes('reason:'), `${name}: open problem #${index + 1} lacks reason`);
    assert(block.includes('recovery:'), `${name}: open problem #${index + 1} lacks recovery`);
  });
});

const actionSources = [
  ['commercial', commercial],
  ['production', production],
  ['finance', finance],
  ['director', director],
  ['warehouse', warehouse],
  ['admin', admin],
];

function sourceHandlesActionId(source, id) {
  if (source.includes(id)) return true;
  const prefixKey = id.includes(':') ? `${id.split(':')[0]}:` : null;
  return Boolean(prefixKey && source.includes(prefixKey));
}

const handledByRole = {
  finance: () => true,
  director: () => true,
  warehouse: (id) =>
    [
      'scan',
      'scan-ready',
      'scan-wrong',
      'scan-partial',
      'scan-delivery',
      'manual',
      'manual-ready',
      'manual-wrong',
      'refresh-wait',
      'partial',
      'partial-receiving',
      'reject',
      'reject-ready',
      'reject-partial',
      'reject-wrong',
      'problem',
      'problem-partial',
      'problem-wrong',
      'close-disabled',
      'close-ready-disabled',
      'close-wrong-disabled',
      'history-receiving-complete',
      'history-delivery-closed',
    ].includes(id)
    || id.startsWith('warehouse-')
    || id.startsWith('history-'),
  admin: (id) =>
    [
      'admin-retry-finance-source',
      'admin-retry-source-health',
      'admin-check-scale',
      'admin-bind-scanner',
      'admin-forward-finance-source',
      'admin-forward-owner',
      'admin-assign-template',
      'admin-save-user-role',
    ].includes(id)
    || id.startsWith('admin-template-save-')
    || id.startsWith('admin-history:'),
  commercial: (id) => sourceHandlesActionId(actions, id) || sourceHandlesActionId(app, id),
  production: (id) => sourceHandlesActionId(actions, id) || sourceHandlesActionId(app, id),
};

function actionBlocks(source) {
  return source.replace(/\n/g, ' ').match(/\{[^{}]*id: '[^']+'[^{}]*label: '[^']+'[^{}]*level: '[^']+'[^{}]*\}/g) ?? [];
}

actionSources.forEach(([role, source]) => {
  actionBlocks(source).forEach((block) => {
    const id = block.match(/id: '([^']+)'/)?.[1];
    const level = block.match(/level: '([^']+)'/)?.[1];
    if (!id || level === 'disabled') return;
    assert(handledByRole[role](id), `${role}: enabled visible action ${id} has no handler/route contract`);
  });
});

console.log('Recovery audit passed: positive-first cards, recovery actions and visible action contracts are wired.');
