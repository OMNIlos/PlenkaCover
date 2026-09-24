import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('warehouse fixture falls back instead of manufacturing a 404 for another contour', async () => {
  const { installWarehouseApiFixture } = await import('./role-display-contract-smoke-fixture.mjs');
  let handler;
  await installWarehouseApiFixture({
    async route(pattern, candidate) {
      assert.equal(pattern, '**/api/**');
      handler = candidate;
    },
  });

  let action = '';
  await handler({
    request: () => ({ url: () => 'https://plenka.test/api/commercial/performance/control' }),
    fallback: async () => {
      action = 'fallback';
    },
    fulfill: async () => {
      action = 'fulfill';
    },
  });

  assert.equal(action, 'fallback');
});

test('warehouse fixture does not mask obsolete post routes', async () => {
  const { installWarehouseApiFixture } = await import('./role-display-contract-smoke-fixture.mjs');
  let handler;
  await installWarehouseApiFixture({
    async route(pattern, candidate) {
      assert.equal(pattern, '**/api/**');
      handler = candidate;
    },
  });

  for (const pathname of ['/api/warehouse/physical-posts', '/api/warehouse/post-binding']) {
    let action = '';
    await handler({
      request: () => ({ url: () => `https://plenka.test${pathname}` }),
      fallback: async () => {
        action = 'fallback';
      },
      fulfill: async () => {
        action = 'fulfill';
      },
    });
    assert.equal(action, 'fallback', `${pathname} must not be mocked`);
  }
});

test('cross-contour smoke forbids warehouse post routes without pre-binding the session', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /apiRequest\('\/api\/warehouse\/post-binding'/u);
  assert.doesNotMatch(source, /warehousePostBinding(Requests|Response)/u);
  assert.match(source, /obsoleteWarehousePostRequests\.length === 0/u);
});

test('cross-contour unified inventory fixture uses canonical production statuses', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const fixture = source.slice(
    source.indexOf('async function createUnifiedInventoryFixture'),
    source.indexOf('\nlet browser;'),
  );

  assert.doesNotMatch(fixture, /(?:productionIndicator|indicator|status): 'completed'/u);
  assert.match(fixture, /productionIndicator: 'ready'/u);
  assert.match(fixture, /indicator: 'ready'/u);
  assert.match(fixture, /status: 'done'/u);
});

test('cross-contour proves hard-reload persistence and bounded role-safe code presentation', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const plannedWeightGate = source.slice(
    source.indexOf('async function verifyCommercialPlannedWeightBoundary'),
    source.indexOf('\nasync function openCommercialOrder'),
  );
  const roleSafeGate = source.slice(
    source.indexOf('async function verifyRoleSafeBusinessCodePresentation'),
    source.indexOf('\nasync function waitForControl'),
  );

  assert.match(plannedWeightGate, /page\.reload\(\{ waitUntil: 'domcontentloaded' \}\)/u);
  assert.match(plannedWeightGate, /openCommercialOrder\([\s\S]*orderId,[\s\S]*orderNumber/u);
  assert.match(plannedWeightGate, /inputValue\(\)\) === '37\.001'/u);
  for (const [code, label] of [
    ['received', 'Принят складом'],
    ['receiving scan', 'Приёмка по QR'],
    ['production_handover', 'Передан из производства'],
    ['audit:warehouse_pallet_roll_selected', 'Рулон добавлен в палетный лист'],
    ['audit:warehouse pallet roll deselected', 'Рулон исключён из палетного листа'],
    ['manual_deselection', 'Исключён вручную'],
  ]) {
    assert.match(source, new RegExp(`\\['${code}', '${label}'\\]`, 'u'));
  }
  assert.match(roleSafeGate, /roleSafeBusinessCodeCases\.length === 6/u);
  assert.match(roleSafeGate, /text\.includes\('Передан из производства'\)/u);
  assert.match(roleSafeGate, /text\.includes\('Принят складом'\)/u);
  assert.match(roleSafeGate, /const \{ visibleBusinessCodeLabel \} = await import\(assetUrl\)/u);
  assert.match(roleSafeGate, /cases\.map\(\(\[code\]\) => visibleBusinessCodeLabel\(code\)\)/u);
  assert.match(roleSafeGate, /visibleBusinessCodeLabel\(unknownCode\)/u);
  assert.match(roleSafeGate, /presentation\.unknown === 'Неизвестное событие'/u);
  assert.match(roleSafeGate, /data-cd1-presentation-seam/u);
  assert.match(roleSafeGate, /\[\.\.\.expectedLabels, 'Неизвестное событие'\]/u);
  assert.match(roleSafeGate, /CD-1 \$\{actor\} DOM leaked raw business codes/u);
  assert.doesNotMatch(roleSafeGate, /import\('\/src\//u);
});

test('cross-contour hard reloads exact delivered roll identities after closing delivery', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const deliveredGate = source.slice(
    source.indexOf("'Закрыть выдачу'"),
    source.indexOf('SETUP_SEAM overdue clock'),
  );

  assert.match(
    deliveredGate,
    /for \(const actor of \['commercial', 'production', 'warehouse', 'director'\]\)/u,
  );
  assert.match(deliveredGate, /pages\[actor\]\.reload\(\{ waitUntil: 'domcontentloaded' \}\)/u);
  assert.match(deliveredGate, /lifecycleStatus: 'warehouse_delivered'/u);
  assert.match(deliveredGate, /label: 'Выдан со склада'/u);
  assert.match(deliveredGate, /url\.searchParams\.get\('mode'\) === 'delivery'/u);
  assert.match(deliveredGate, /task\.id === deliveryTask\.id/u);
  assert.match(deliveredGate, /ownedClosedTask\.status === 'closed'/u);
  assert.match(deliveredGate, /new Set\(ownedClosedRows\.map\(\(row\) => row\.id\)\)\.size === 2/u);
  assert.match(deliveredGate, /row\.scanStatus === 'accepted'/u);
  assert.doesNotMatch(deliveredGate, /warehouseArchiveFilter|getByRole\('radio'/u);
  assert.match(deliveredGate, /`delivery-\$\{deliveryTask\.id\}`/u);
  assert.match(deliveredGate, /\[data-roll-code="\$\{candidate\.rollCode\}"\]/u);
  assert.match(deliveredGate, /includes\('Выдача закрыта'\)/u);
  assert.doesNotMatch(deliveredGate, /url\.searchParams\.get\('view'\) === 'processed'/u);
  assert.match(deliveredGate, /CD-7 commercial post-delivery reload keeps exact shipment/u);
});

test('cross-contour preview serves and verifies the exact built JavaScript asset', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const viteLaunch = source.slice(
    source.indexOf("path.resolve(frontendDir, 'node_modules/vite/bin/vite.js')"),
    source.indexOf("await waitForHttp(webBase, 'Vite'"),
  );

  assert.match(viteLaunch, /'preview'/u);
  assert.match(source, /initialBrowserEntry\.url === `\/\$\{initialBuiltAsset\.relativePath\}`/u);
  assert.match(source, /initialBrowserEntry\.sha256 === initialBuiltAsset\.sha256/u);
  assert.match(source, /initialBrowserEntry\.bytes === initialBuiltAsset\.bytes/u);
  assert.match(source, /cacheControl\?\.includes\('no-cache'\)/u);
  assert.match(source, /Boolean\(initialBrowserEntry\.etag\)/u);
  assert.match(source, /finalBrowserEntry\.etag === initialBrowserEntry\.etag/u);
  assert.match(source, /rmSync\(roleSafePresentationAssetPath, \{ force: true \}\)/u);
  assert.doesNotMatch(source, /import\('\/src\//u);
});

test('cross-contour preserves CD-3 controls across manual refresh and reloads canonical defaults', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const cd3 = source.slice(
    source.indexOf('async function verifyDirectorProductionManualRefresh'),
    source.indexOf('\nasync function verifyDelayedProductionLifecycleCannotRegress'),
  );

  assert.match(cd3, /from: initialControls\.to/u);
  assert.match(cd3, /grouping: 'week'/u);
  assert.match(cd3, /productionRequests === 0 && rollRequests === 0/u);
  assert.match(cd3, /productionRequests === 1 && rollRequests === 1/u);
  assert.match(cd3, /page\.on\('request', countRequest\)/u);
  assert.match(cd3, /await refreshRolePage\(page\)/u);
  assert.match(cd3, /response\.ok\(\)/u);
  assert.match(cd3, /await response\.finished\(\)/u);
  assert.match(cd3, /awaitTwoAnimationFrames/u);
  assert.match(cd3, /controlsAfterManualRefresh/u);
  assert.match(cd3, /page\.reload\(\{ waitUntil: 'domcontentloaded' \}\)/u);
  assert.match(cd3, /controlsAfterReload/u);
  assert.match(
    cd3,
    /JSON\.stringify\(controlsAfterReload\) === JSON\.stringify\(initialControls\)/u,
  );
  assert.match(cd3, /const lifecycleAfterReload = await Promise\.all/u);
  assert.match(cd3, /lifecycleAfterReload\.every\(Boolean\)/u);
  assert.doesNotMatch(cd3, /\.every\(async/u);
});

test('cross-contour waits for stale body-or-abort outcomes and React commits', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const cd7 = source.slice(
    source.indexOf('async function verifyDelayedProductionLifecycleCannotRegress'),
    source.indexOf('\nconst businessPerformanceSmoke'),
  );
  const op1 = source.slice(
    source.indexOf("const bigBagRoute = '**/api/operator/big-bags'"),
    source.indexOf('\n  const addBigBag'),
  );
  assert(
    source.indexOf("const bigBagRoute = '**/api/operator/big-bags'") <
      source.indexOf("getByRole('button', { name: 'Сдать Big-Bag', exact: true })"),
    'OP-1 must hold a real 5000 kg request before the release mutation',
  );

  assert.match(cd7, /newerResponse\.finished\(\)/u);
  assert.match(cd7, /waitForRequestBodyOrAbort/u);
  assert.match(cd7, /staleOutcome === 'aborted' \|\| staleOutcome === 'finished'/u);
  assert.match(cd7, /awaitTwoAnimationFrames\(page\)/u);
  assert.match(op1, /waitForRequestBodyOrAbort/u);
  assert.match(op1, /const upstream = await route\.fetch\(\)/u);
  assert.match(op1, /currentKg\s*===\s*5_000/u);
  assert.match(op1, /newerBigBagResponse\.finished\(\)/u);
  assert.match(op1, /currentKg\s*===\s*4_000/u);
  assert.match(op1, /OP-1 pre-reload UI rejects the settled stale 5000 kg body/u);
  assert.match(op1, /immediateAddBigBag\.locator\('#bigbag-add-weight'\)\.inputValue\(\)/u);
  assert.match(op1, /staleBigBagOutcome === 'aborted' \|\| staleBigBagOutcome === 'finished'/u);
  assert.match(op1, /awaitTwoAnimationFrames\(activeOperatorPage\)/u);
  assert.match(source, /page\.on\('requestfailed', onRequestFailed\)/u);
});

test('business-performance live helper uses only its injected callable assertion contract', async () => {
  const source = await readFile(
    new URL('./business-performance-live-smoke.mjs', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /assert\.[A-Za-z]+/u);
  assert.match(source, /\.commercial-problem-row\[data-problem-id="\$\{expectedProblemId\}"\]/u);
  assert.match(
    source,
    /item\.id === expectedProblemId && item\.kind === 'defect' && item\.reason === marker/u,
  );
});

test('cross-contour warehouse task selection uses visible identity and proves the exact object', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const helper = source.slice(
    source.indexOf('async function openWarehouseTask'),
    source.indexOf('\nasync function issuePostpayInvoice'),
  );

  assert.match(helper, /getByText\(rowLabel, \{ exact: true \}\)/u);
  assert.match(helper, /searchParams\.get\('object'\) === objectId/u);
  assert.doesNotMatch(helper, /filter\(\{ hasText: objectId \}\)/u);
});

test('cross-contour warehouse pallet flow uses the explicit public selection command', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /PALLET_LABEL_PROFILE:\s*process\.env\.PALLET_LABEL_PROFILE \?\?\s*'pallet-100x100-extended-v6'/u,
  );
  const flow = source.slice(
    source.indexOf('const receivingScanResult = await receivingScanResponse.json()'),
    source.indexOf('\n  let deliveryTask = null;'),
  );

  assert.match(flow, /receivingScanResult\.task\.rolls\.find/u);
  assert.match(
    flow,
    /getByLabel\(\s*`Добавить \$\{receivedRoll\.rollCode\} в палетный лист`,?\s*\)/u,
  );
  assert.match(
    flow,
    /`\/api\/warehouse\/intake\/\$\{handover\.id\}\/pallet-selection\/\$\{receivedRoll\.scanRowId\}`/u,
  );
  assert.match(flow, /response\.request\(\)\.method\(\) === 'PUT'/u);
  assert.match(
    flow,
    /selectionResult\.activePallet\.rows\.some\(\(row\) => row\.rollCode === candidate\.rollCode\)/u,
  );
  assert.match(flow, /section\.warehouse-active-pallet\[aria-label="Текущий палет"\]/u);
  assert.match(
    flow,
    /activePallet\.getByText\(\s*selectionResult\.activePallet\.palletCode,\s*\{\s*exact:\s*true,?\s*\},?\s*\)/u,
  );
  assert.match(flow, /activePallet\.getByText\(ownedRoll\.rollCode, \{ exact: true \}\)/u);
  assert.doesNotMatch(flow, /getByLabel\('Текущий палет'\)\.count\(\) === 1/u);
  assert.match(flow, /`\/api\/warehouse\/intake\/\$\{handover\.id\}\/pallets\/current\/seal`/u);
  assert.match(
    flow,
    /`\/api\/warehouse\/pallet-lists\/\$\{sealedDocumentId\}\/system-print-intents`/u,
  );
  assert.match(flow, /`\/api\/warehouse\/pallet-lists\/\$\{sealedDocumentId\}\/preview`/u);
  assert.match(
    flow,
    /const \[sealResponse, intentResponse, previewResponse\] = await Promise\.all\(\[\s*sealPalletResponse,\s*systemPrintIntentResponse,\s*palletPreviewResponse,?\s*\]\)/u,
  );
  assert.match(
    flow,
    /activePallet\.getByLabel\('Принтер для текущего палета'\)\.count\(\)\) === 0/u,
  );
  assert.match(flow, /fetch\(`\$\{apiBase\}\$\{palletPreviewPath\}`/u);
  assert.match(flow, /Authorization: `Bearer \$\{sessions\.warehouse\.token\}`/u);
  assert.match(flow, /Buffer\.from\(await canonicalPreviewResponse\.arrayBuffer\(\)\)/u);
  assert.match(flow, /canonicalPreviewBody\.readUInt32BE\(16\) === 800/u);
  assert.match(flow, /canonicalPreviewBody\.readUInt32BE\(20\) === 800/u);
  assert.doesNotMatch(flow, /previewResponse\.body\(\)/u);
  assert.match(source, /const forbiddenWarehousePrintRequests = \[\];/u);
  assert.match(
    flow,
    /const forbiddenWarehousePrintRequestBaseline = forbiddenWarehousePrintRequests\.length/u,
  );
  assert.match(
    flow,
    /forbiddenWarehousePrintRequests\.slice\(\s*forbiddenWarehousePrintRequestBaseline,?\s*\)/u,
  );
  assert.match(source, /__plenkaWarehouseSystemPrintCalls/u);
  assert.match(source, /Object\.defineProperty\(window, 'print'/u);
  assert.doesNotMatch(source, /Object\.defineProperty\(Window\.prototype, 'print'/u);
  assert.match(source, /window\.dispatchEvent\(new Event\('afterprint'\)\)/u);
  assert.doesNotMatch(flow, /api\/warehouse\/printers|close-and-print|\.selectOption\(/u);
  const selectionResultIndex = flow.indexOf('selectionResult = await selectionResponse.json()');
  const visibleSelectionIndex = flow.indexOf(
    "await waitUntil('warehouse explicit pallet selection is visible'",
  );
  const canonicalRefreshIndex = flow.indexOf(
    'const palletSelectionRefresh = pages.warehouse.waitForResponse',
  );
  const focusedRefreshIndex = flow.indexOf(
    'await focusRefresh(pages.warehouse)',
    canonicalRefreshIndex,
  );
  assert.ok(
    selectionResultIndex < visibleSelectionIndex &&
      visibleSelectionIndex < canonicalRefreshIndex &&
      canonicalRefreshIndex < focusedRefreshIndex,
    'canonical intake GET must be armed and focused only after the UI selection is visible',
  );
  assert.doesNotMatch(flow, /intake scan did not open a physical pallet/iu);
});

test('auth shell uses a real seeded operator identity', async () => {
  const source = await readFile(new URL('./auth-shell-smoke.mjs', import.meta.url), 'utf8');

  assert.match(source, /\['ахметов булат', 'operator'\]/u);
  assert.doesNotMatch(source, /\['оператор', 'operator'\]/u);
});

test('API and visible UI failures make a release smoke unhealthy', async () => {
  const { assertSmokeHealthy } = await import('./release-smoke-runtime.mjs');

  assert.throws(
    () =>
      assertSmokeHealthy(
        {
          apiFailures: [
            {
              method: 'GET',
              status: 404,
              statusText: 'Not Found',
              url: 'https://plenka.test/api/finance/invoices',
            },
          ],
          pageErrors: [],
        },
        [],
        'role display',
      ),
    /GET 404.*finance\/invoices/u,
  );
  assert.throws(
    () =>
      assertSmokeHealthy(
        { apiFailures: [], pageErrors: [] },
        ['Не удалось загрузить подтверждённые данные'],
        'director control',
      ),
    /visible errors.*Не удалось загрузить/u,
  );
});

test('readiness rejects a dead child even when an incumbent answers the port', async () => {
  const { assertOwnedServerAlive } = await import('./release-smoke-runtime.mjs');

  assert.throws(
    () =>
      assertOwnedServerAlive(
        { exitCode: 1, signalCode: null },
        ['error when starting dev server: Port 5198 is already in use'],
        'readiness',
      ),
    /own Vite child exited[\s\S]*5198 is already in use/u,
  );
});

test('director control requires loaded content and concrete metrics, not its outer workspace', async () => {
  const { assertDirectorControlState } = await import('./release-smoke-runtime.mjs');

  assert.throws(
    () =>
      assertDirectorControlState(
        {
          workspaceVisible: true,
          contentVisible: false,
          metricLabels: [],
          alertTexts: ['Ошибка 502: Bad Gateway'],
        },
        'director control',
      ),
    /did not load|visible errors/u,
  );
  assert.doesNotThrow(() =>
    assertDirectorControlState(
      {
        workspaceVisible: true,
        contentVisible: true,
        metricLabels: ['Выставлено', 'Оплачено', 'Произведено'],
        alertTexts: [],
      },
      'director control',
    ),
  );
});

test('finance positive-first state is proven before an invoice is selected', async () => {
  const { assertFinancePositiveDefaultState } = await import('./release-smoke-runtime.mjs');

  assert.throws(
    () =>
      assertFinancePositiveDefaultState(
        {
          activeSection: 'Просрочки',
          registryVisible: false,
          selectedDetails: 1,
          explicitObject: true,
          visibleAlerts: [],
        },
        'finance default',
      ),
    /active invoices|registry|selected/u,
  );
  assert.doesNotThrow(() =>
    assertFinancePositiveDefaultState(
      {
        activeSection: 'Счета',
        registryVisible: true,
        selectedDetails: 0,
        explicitObject: false,
        visibleAlerts: [],
      },
      'finance default',
    ),
  );
});

test('cross-contour waits for the strict invoice client boundary to close its wizard', async () => {
  const source = await readFile(new URL('./cross-contour-live-smoke.mjs', import.meta.url), 'utf8');
  const issueInvoice = source.slice(
    source.indexOf('async function issuePostpayInvoice'),
    source.indexOf('\nasync function screenshot'),
  );

  assert.match(issueInvoice, /finance invoice wizard closes after successful create/u);
  assert.match(issueInvoice, /wizard\.getByRole\('alert'\)/u);
  assert.match(issueInvoice, /\(await wizard\.count\(\)\) === 0/u);
});
