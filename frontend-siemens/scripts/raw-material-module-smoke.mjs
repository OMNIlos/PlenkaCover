import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const port = 5206;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = path.resolve('qa-screenshots/raw-material-module-2026-06-23');
const reportPath = path.join(screenshotDir, 'raw-material-module-smoke-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');
const WAREHOUSE_STOCK_SECTION = 'Все рулоны';
const WAREHOUSE_PROCESSED_VIEW = 'Обработанные';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rawMaterialSection(role) {
  return role === 'commercial' ? 'Сырьё' : 'Сырье';
}

async function projectionChecks() {
  const vite = await createServer({
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  });
  try {
    const rawMaterialModule = await vite.ssrLoadModule('/src/domain/rawMaterialUsage.ts');
    const warehouseCloseout = await vite.ssrLoadModule('/src/domain/warehouseCloseout.ts');
    const accessPolicy = await vite.ssrLoadModule('/src/domain/accessPolicy.ts');
    const demoData = await vite.ssrLoadModule('/src/domain/demoData.ts');
    const sourceObject = demoData.workObjects.warehouse.find(
      (object) => object.id === 'WH-INV-RAW',
    );
    assert(sourceObject, 'WH-INV-RAW source object is missing');

    const summaries = rawMaterialModule.buildRawMaterialUsageSummaries(sourceObject);
    const byId = new Map(summaries.map((summary) => [summary.rawMaterialId, summary]));
    const pvd15803 = byId.get('ПВД-15803-020');
    const pvd10803 = byId.get('ПВД-10803-020');
    const secondary = byId.get('ВТОР-РЕГРАН-01');

    assert(pvd15803?.actualQty === 1186, 'ПВД-15803 actual stock must come from warehouse fact');
    assert(pvd15803?.referenceQty === 1240, 'ПВД-15803 must keep accounting reference snapshot');
    assert(
      pvd15803?.recordedUsageQty === 69,
      'ПВД-15803 recorded usage must come from audit event',
    );
    assert(
      pvd15803?.plannedUsageQty > pvd15803?.recordedUsageQty,
      'ПВД-15803 planned usage must not be replaced by recorded event',
    );
    assert(
      pvd15803?.sourceStatus === 'расхождение с учетом',
      'ПВД-15803 must expose accounting conflict as status',
    );

    assert(pvd10803?.actualQty === 60, 'ПВД-10803 actual stock must come from warehouse fact');
    assert(pvd10803?.reservedQty === 40, 'ПВД-10803 reserved qty must come from reservation event');
    assert((pvd10803?.availableAfterPlanQty ?? 0) < 0, 'ПВД-10803 must show shortage after plan');
    assert(
      pvd10803?.sourceStatus === 'дефицит',
      'ПВД-10803 shortage must outrank accounting conflict',
    );

    assert(secondary?.materialKind === 'secondary', 'secondary material must remain in projection');
    assert(
      secondary?.source === 'manual_platform',
      'secondary material must keep manual platform source',
    );

    const productionProjection = rawMaterialModule.buildRawMaterialModuleProjection(
      'production',
      sourceObject,
    );
    const financeProjection = rawMaterialModule.buildRawMaterialModuleProjection(
      'finance',
      sourceObject,
    );
    const warehouseProjection = rawMaterialModule.buildRawMaterialModuleProjection(
      'warehouse',
      sourceObject,
    );

    assert(
      productionProjection.tabs.find((tab) => tab.id === 'usage')?.rows.length === summaries.length,
      'production must see usage rows',
    );
    assert(
      financeProjection.tabs.find((tab) => tab.id === 'usage')?.rows.length === 0,
      'finance must not see usage rows',
    );
    assert(
      productionProjection.tabs
        .find((tab) => tab.id === 'movements')
        ?.rows.some(
          (row) =>
            row.title.includes('Цех 1') ||
            row.details.some((detail) => detail.value.includes('Зав. производства')),
        ),
      'production must see secondary movement signatures',
    );
    assert(
      warehouseProjection.tabs
        .flatMap((tab) => tab.rows)
        .some((row) =>
          row.actions.some((action) => action.id.startsWith('warehouse-open-stock-mutation')),
        ),
      'warehouse must receive stock mutation entry actions',
    );
    assert(
      !financeProjection.tabs
        .flatMap((tab) => tab.rows)
        .some((row) => row.actions.some((action) => action.id.startsWith('warehouse-'))),
      'finance must not receive warehouse actions',
    );

    const rolesWithModule = ['commercial', 'production', 'finance', 'director', 'warehouse'];
    for (const role of rolesWithModule) {
      assert(
        accessPolicy.getRoleAccessPolicy(role).visibleSections.includes(rawMaterialSection(role)),
        `${role} must have raw material section`,
      );
      assert(
        accessPolicy.roleHasCapability(role, 'raw_material.view_summary'),
        `${role} must have raw material summary capability`,
      );
    }
    const adminPolicy = accessPolicy.getRoleAccessPolicy('admin');
    assert(
      !adminPolicy.visibleSections.some((section) => /^Сырь[её]$/u.test(section)),
      'admin raw-material access must remain inside diagnostics instead of a business section',
    );
    assert(
      accessPolicy.roleHasCapability('admin', 'raw_material.view_summary'),
      'admin diagnostics must retain raw material summary capability',
    );
    assert(
      !accessPolicy
        .getRoleAccessPolicy('operator')
        .visibleSections.some((section) => /^Сырь[её]$/u.test(section)),
      'operator must not have raw material section',
    );
    assert(
      !accessPolicy.roleHasCapability('operator', 'raw_material.view_summary'),
      'operator must not have raw material summary capability',
    );
    assert(
      !accessPolicy.roleHasCapability('finance', 'raw_material.mutate_stock'),
      'finance must not mutate warehouse stock',
    );
    assert(
      !accessPolicy.roleHasCapability('commercial', 'raw_material.mutate_stock'),
      'commercial must not mutate warehouse stock',
    );

    const receiveResult = warehouseCloseout.applyWarehouseStockMutation(sourceObject, {
      materialId: 'ПВД-15803-020',
      kind: 'receive',
      qty: 10,
      reason: 'Контрольная приемка projection smoke',
    });
    const receivedStock = receiveResult.object.rawMaterialStocks?.find(
      (stock) => stock.rawMaterialId === 'ПВД-15803-020',
    );
    assert(receiveResult.applied, 'warehouse receive mutation must apply');
    assert(
      receivedStock?.actualQty === 1196,
      'warehouse receive mutation must update runtime stock',
    );
    assert(
      receiveResult.object.inventoryMutations?.[0]?.reason ===
        'Контрольная приемка projection smoke',
      'warehouse receive mutation must persist reason',
    );
    assert(
      receiveResult.object.audit[0]?.actionLabel ===
        'audit:inventory_fact_overrode_accounting_snapshot' ||
        receiveResult.object.audit[0]?.actionLabel === 'audit:material_received',
      'warehouse receive mutation must write audit',
    );

    const blockedWriteOff = warehouseCloseout.applyWarehouseStockMutation(sourceObject, {
      materialId: 'ПВД-10803-020',
      kind: 'write_off',
      qty: 10000,
      reason: 'Проверка запрета сверх доступного остатка',
    });
    assert(!blockedWriteOff.applied, 'warehouse write-off above available stock must be blocked');
    assert(
      blockedWriteOff.object.inventoryMutations?.[0]?.blocked === true,
      'blocked stock mutation must be recorded as blocked',
    );
    assert(
      blockedWriteOff.object.audit[0]?.actionLabel === 'problem:inventory_mutation_blocked',
      'blocked stock mutation must write problem audit event',
    );

    const missingReason = warehouseCloseout.applyWarehouseStockMutation(sourceObject, {
      materialId: 'ПВД-15803-020',
      kind: 'receive',
      qty: 5,
      reason: '   ',
    });
    assert(!missingReason.applied, 'warehouse mutation without reason must be blocked');

    const reserveResult = warehouseCloseout.applyWarehouseStockMutation(sourceObject, {
      materialId: 'ПВД-10803-020',
      kind: 'reserve',
      qty: 10,
      reason: 'Резерв под контрольный заказ',
      linkedOrderId: 'З-2606-SMOKE',
    });
    const reservedStock = reserveResult.object.rawMaterialStocks?.find(
      (stock) => stock.rawMaterialId === 'ПВД-10803-020',
    );
    const reserveSummary = rawMaterialModule
      .buildRawMaterialUsageSummaries(reserveResult.object)
      .find((summary) => summary.rawMaterialId === 'ПВД-10803-020');
    assert(reserveResult.applied, 'warehouse reserve mutation must apply');
    assert(reservedStock?.actualQty === 60, 'warehouse reserve mutation must not write off stock');
    assert(
      reserveSummary?.reservedQty === 50,
      'warehouse reserve mutation must increase reserved qty',
    );

    const releaseResult = warehouseCloseout.applyWarehouseStockMutation(reserveResult.object, {
      materialId: 'ПВД-10803-020',
      kind: 'release_reserve',
      qty: 5,
      reason: 'Снятие части резерва smoke',
      linkedOrderId: 'З-2606-SMOKE',
    });
    const releaseSummary = rawMaterialModule
      .buildRawMaterialUsageSummaries(releaseResult.object)
      .find((summary) => summary.rawMaterialId === 'ПВД-10803-020');
    assert(releaseResult.applied, 'warehouse release reserve mutation must apply');
    assert(
      releaseSummary?.reservedQty === 45,
      'warehouse release reserve mutation must decrease reserved qty',
    );
  } finally {
    await vite.close();
  }
}

const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    VITE_LIVE_CONTOURS: '__demo__',
    VITE_REQUIRE_AUTH: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const serverLogs = [];
server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

async function waitForServer() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite preview exited before ready.\n${serverLogs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(
        `${baseUrl}/?role=warehouse&section=${encodeURIComponent('Сырье')}`,
      );
      if (response.ok) return;
    } catch {
      // Keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite preview did not start in time.\n${serverLogs.join('\n').slice(-2000)}`);
}

async function gotoRawMaterial(page, role, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto(
    `${baseUrl}/?role=${role}&section=${encodeURIComponent(rawMaterialSection(role))}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
  const safeProjection = role === 'production' || role === 'director';
  await page
    .locator(
      role === 'warehouse'
        ? '.warehouse-inventory-cockpit'
        : safeProjection
          ? '.safe-inventory-surface'
          : '.raw-material-module',
    )
    .waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
}

async function gotoWarehouseInventory(page, section, viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  const url = new URL(baseUrl);
  url.searchParams.set('role', 'warehouse');
  url.searchParams.set(
    'section',
    section === WAREHOUSE_PROCESSED_VIEW ? WAREHOUSE_STOCK_SECTION : section,
  );
  if (section === WAREHOUSE_PROCESSED_VIEW) url.searchParams.set('view', 'processed');
  url.searchParams.set('object', 'WH-INV-RAW');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('.warehouse-inventory-cockpit').waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(200);
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label]')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label')]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );
  return `${bodyText}\n${attributeText}`;
}

function assertIncludes(text, needles, context) {
  const normalized = text.toLowerCase();
  const missing = needles.filter((needle) => !normalized.includes(needle.toLowerCase()));
  assert(missing.length === 0, `${context}: missing ${missing.join(', ')}`);
}

function assertNoTerms(text, terms, context) {
  const normalized = text.toLowerCase();
  const hits = terms.filter((term) => normalized.includes(term.toLowerCase()));
  assert(hits.length === 0, `${context}: forbidden terms visible: ${hits.join(', ')}`);
}

async function assertNoHorizontalOverflow(page, context) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    htmlScrollWidth: document.documentElement.scrollWidth,
  }));
  const overflow = Math.max(metrics.bodyScrollWidth, metrics.htmlScrollWidth) - metrics.viewport;
  assert(overflow <= 1, `${context}: horizontal overflow ${overflow}px`);
}

async function screenshot(page, name) {
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function browserChecks() {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const report = { baseUrl, screenshotDir, checks: [] };
  let text;

  try {
    for (const role of ['commercial', 'production', 'finance', 'director']) {
      await gotoRawMaterial(page, role);
      const text = await collectText(page);
      if (role === 'production' || role === 'director') {
        const projectionText = await page.locator('.safe-inventory-surface').innerText();
        assertIncludes(
          projectionText,
          ['Сырье', 'Поиск', 'Категория', 'Доступность'],
          `${role} safe raw material projection`,
        );
        assertNoTerms(
          projectionText,
          ['Источник', 'Состояние источника'],
          `${role} safe raw material projection diagnostics`,
        );
      } else {
        assertIncludes(
          text,
          [
            'Факт склада',
            'План расхода',
            'Сводка',
            'Наличие',
            'Использование',
            'Движения',
            'Расхождения',
          ],
          `${role} raw material module`,
        );
      }
      assertNoTerms(
        text,
        ['audit:', 'problem:', 'mock_1C', 'payload', 'WarehouseCoverProposal'],
        `${role} raw material raw labels`,
      );
      report.checks.push({ role, viewport: 'desktop', ok: true });
    }

    for (const section of [
      'Сырье',
      WAREHOUSE_STOCK_SECTION,
      WAREHOUSE_PROCESSED_VIEW,
    ]) {
      await gotoWarehouseInventory(page, section);
      text = await collectText(page);
      if (section === WAREHOUSE_STOCK_SECTION || section === WAREHOUSE_PROCESSED_VIEW) {
        const workspace = page.locator('.warehouse-stock-workspace');
        assert(
          (await workspace.count()) === 1,
          `warehouse ${section}: unified stock workspace is missing`,
        );
        assert(
          (await page
            .locator('.warehouse-finished-stock, .warehouse-cover-tasks-panel')
            .count()) === 0,
          `warehouse ${section}: legacy stock surfaces are still rendered`,
        );
        const unavailable = await workspace.evaluate((element) =>
          element.classList.contains('is-unavailable'),
        );
        if (unavailable) {
          assertIncludes(
            text,
            [WAREHOUSE_STOCK_SECTION, 'Все рулоны временно недоступны'],
            'warehouse inventory reserve demo boundary',
          );
          assert(
            (await workspace.locator('button', { hasText: 'Добавить рулон' }).count()) === 0,
            'warehouse inventory reserve: unavailable contour must not expose a dead action',
          );
        } else {
          assertIncludes(
            text,
            [
              WAREHOUSE_STOCK_SECTION,
              section === WAREHOUSE_PROCESSED_VIEW
                ? 'История обработанных рулонов'
                : 'Рулоны на складе',
              'Рулоны',
              'Обработанные',
              'Поиск',
              'Партия',
            ],
            'warehouse inventory reserve',
          );
          assert(
            (await page.locator('.warehouse-stock-data-table').count()) === 1,
            'warehouse inventory reserve: unified stock table is missing',
          );
        }
        report.checks.push({ role: 'warehouse', section, viewport: 'desktop', ok: true });
        continue;
      }
      if (section === 'Расходники') {
        const accountingPanel = await page
          .locator('.warehouse-accounting-panel[aria-label="Расходники"]')
          .count();
        if (accountingPanel === 1) {
          assertIncludes(
            text,
            ['Расходники', 'Количество по проведенным складским документам', 'Найти'],
            'warehouse inventory consumables',
          );
          report.checks.push({ role: 'warehouse', section, viewport: 'desktop', ok: true });
          continue;
        }
      }
      if (section === 'Движения') {
        const accountingPanel = await page
          .locator('.warehouse-accounting-panel[aria-label="Движения"]')
          .count();
        if (accountingPanel === 1) {
          assertIncludes(
            text,
            ['Движения', 'Проведенные складские документы', 'Найти'],
            'warehouse inventory movements',
          );
          report.checks.push({ role: 'warehouse', section, viewport: 'desktop', ok: true });
          continue;
        }
      }
      assertIncludes(
        text,
        [section, 'Все', 'Внимание', 'Норма', 'найдено', 'Сбросить', 'Объект', 'Откуда'],
        `warehouse inventory ${section}`,
      );
      if (section !== 'Расходники') {
        assertIncludes(text, ['Статус'], `warehouse inventory ${section} status column`);
      }
      assert(
        (await page.locator('.warehouse-inventory-main > .warehouse-inventory-tabs').count()) === 0,
        `warehouse inventory ${section}: duplicate category tabs must not render`,
      );
      assert(
        (await page.locator('.warehouse-section-list').count()) === 0,
        `warehouse inventory ${section}: duplicate left row list must not render`,
      );
      assert(
        (await page.locator('.warehouse-inventory-toolbar').count()) === 1,
        `warehouse inventory ${section}: table toolbar is missing`,
      );
      assert(
        (await page.locator('.warehouse-inventory-table-actions button').count()) >= 2,
        `warehouse inventory ${section}: add buttons are missing`,
      );
      assert(
        (await page
          .locator('.warehouse-inventory-data-table tbody tr.is-interactive button', {
            hasText: 'Правка',
          })
          .count()) > 0,
        `warehouse inventory ${section}: row edit button is missing`,
      );
      const searchInput = page.locator('.warehouse-inventory-toolbar .plenki-search-field input');
      assert(
        (await searchInput.inputValue()) === '',
        `warehouse inventory ${section}: search must reset on section open`,
      );
      const firstTitle = await page
        .locator(
          '.warehouse-inventory-data-table tbody tr.is-interactive [data-label="Объект"] strong',
        )
        .first()
        .innerText();
      await searchInput.fill(firstTitle.split(/\s+/)[0]);
      assert(
        (await page.locator('.warehouse-inventory-data-table tbody tr.is-interactive').count()) > 0,
        `warehouse inventory ${section}: search returned no rows for existing object`,
      );
      await page
        .locator('.warehouse-inventory-toolbar .plenki-toolbar-meta button', {
          hasText: 'Сбросить',
        })
        .click();
      assert(
        (await searchInput.inputValue()) === '',
        `warehouse inventory ${section}: reset did not clear search`,
      );
      const sortableLabels =
        section === 'Расходники'
          ? ['Объект', 'Характеристика', 'Норма', 'Единица / эффект', 'Откуда']
          : ['Объект', 'На складе', 'По учету / эффект', 'Статус', 'Откуда'];
      for (const label of sortableLabels) {
        const button = page
          .locator('.warehouse-inventory-data-table thead th button')
          .filter({ hasText: label })
          .first();
        const header = button.locator('xpath=..');
        await button.click();
        assert(
          (await header.getAttribute('aria-sort')) === 'ascending',
          `warehouse inventory ${section}: ${label} sort did not switch to asc`,
        );
        await button.click();
        assert(
          (await header.getAttribute('aria-sort')) === 'descending',
          `warehouse inventory ${section}: ${label} sort did not switch to desc`,
        );
        await button.click();
        assert(
          (await header.getAttribute('aria-sort')) === null,
          `warehouse inventory ${section}: ${label} sort did not reset`,
        );
      }
      await page.locator('.warehouse-inventory-data-table tbody tr.is-interactive').first().click();
      text = await collectText(page);
      assertNoTerms(
        text,
        ['Показать резерв', 'Освободить рулоны', 'WarehouseCoverProposal'],
        `warehouse inventory ${section} stale labels`,
      );
      assert(
        (await page.locator('.warehouse-inventory-quick-edit input').count()) > 0,
        `warehouse inventory ${section}: quick numeric edit is missing`,
      );
      if (section === 'Сырье') {
        assert(
          (await page.locator('.warehouse-inventory-quick-edit select').count()) > 0,
          'warehouse raw inventory: stock mutation operation selector is missing',
        );
        assert(
          (await page.locator('.warehouse-inventory-quick-edit textarea').count()) > 0,
          'warehouse raw inventory: mutation reason field is missing',
        );
        assertIncludes(
          text,
          ['Операция', 'Причина', 'Записать изменение'],
          'warehouse raw inventory mutation form',
        );
      }
      if (section === 'Расходники') {
        assertIncludes(
          text,
          [
            'Характеристика',
            'рукав · 70 мкм',
            '1000 м x 1.1 м',
            'скотч ПП',
            'м/рулон',
            'черновая норма склада',
          ],
          'warehouse consumables characteristics',
        );
      }
      report.checks.push({ role: 'warehouse', section, viewport: 'desktop', ok: true });
    }

    await gotoWarehouseInventory(page, 'Сырье');
    await page
      .locator('.warehouse-inventory-data-table tbody tr.is-interactive')
      .filter({ hasText: 'ПВД 15803-020' })
      .first()
      .click();
    await page.locator('.warehouse-inventory-quick-edit select').selectOption('receive');
    await page.locator('.warehouse-inventory-quick-edit input[type="number"]').fill('10');
    await page
      .locator('.warehouse-inventory-quick-edit textarea')
      .fill('Контрольная приемка smoke test');
    await page
      .locator('.warehouse-inventory-quick-edit button', { hasText: 'Записать изменение' })
      .click();
    await page.waitForTimeout(150);
    text = await collectText(page);
    assertIncludes(
      text,
      ['1196 кг', 'Приемка сырья записана'],
      'warehouse stock mutation receive flow',
    );
    report.checks.push({
      role: 'warehouse',
      section: 'Сырье',
      action: 'receive mutation',
      viewport: 'desktop',
      ok: true,
    });

    await page
      .locator('.warehouse-inventory-table-actions button', { hasText: '+ Новый материал' })
      .click();
    const dialog = page.locator('.warehouse-material-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    assert(
      await dialog.locator('button', { hasText: 'Записать' }).isDisabled(),
      'warehouse manual material create: empty form must be blocked',
    );
    await dialog
      .locator('label', { hasText: 'Материал' })
      .locator('input')
      .fill('Smoke manual PE 071');
    await dialog.locator('label', { hasText: 'Количество' }).locator('input').fill('7');
    await dialog.locator('label', { hasText: 'Документ' }).locator('input').fill('SMOKE-071');
    await dialog
      .locator('label', { hasText: 'Причина' })
      .locator('textarea')
      .fill('Smoke ручное добавление сырья');
    await dialog.locator('button', { hasText: 'Записать' }).click();
    await page.waitForTimeout(150);
    text = await collectText(page);
    assertIncludes(
      text,
      ['Smoke manual PE 071', 'Позиция создана'],
      'warehouse manual material create flow',
    );

    const createdRow = page
      .locator('.warehouse-inventory-data-table tbody tr.is-interactive')
      .filter({ hasText: 'Smoke manual PE 071' })
      .first();
    await createdRow.locator('button', { hasText: 'Правка' }).click();
    const editingRow = page.locator('.warehouse-inventory-data-table tbody tr.is-editing').first();
    await editingRow.locator('input[aria-label="Факт склада"]').fill('8');
    await editingRow.locator('input[aria-label="Причина"]').fill('Smoke правка позиции');
    await editingRow.locator('button', { hasText: 'Сохранить' }).click();
    await page.waitForTimeout(150);
    text = await collectText(page);
    assertIncludes(text, ['Smoke manual PE 071', '8 кг'], 'warehouse manual material edit flow');
    report.checks.push({
      role: 'warehouse',
      section: 'Сырье',
      action: 'create and edit material',
      viewport: 'desktop',
      ok: true,
    });

    await gotoRawMaterial(page, 'finance');
    text = await collectText(page);
    assertNoTerms(
      text,
      ['Принять сырье/рулон', 'Скорректировать остаток', 'Подписать перемещение'],
      'finance warehouse actions',
    );

    await gotoRawMaterial(page, 'commercial');
    text = await collectText(page);
    assertNoTerms(
      text,
      ['Открыть источник', 'Принять сырье/рулон', 'Скорректировать остаток'],
      'commercial diagnostics and warehouse actions',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/?role=operator`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 5000 });
    const operatorRawNavCount = await page
      .locator('.section-nav-button, .role-top-nav-item')
      .filter({ hasText: /^Сырь[её]$/u })
      .count();
    assert(
      operatorRawNavCount === 0,
      'operator must not receive standalone raw material module navigation',
    );
    report.checks.push({ role: 'operator', viewport: 'mobile', ok: true });

    await gotoWarehouseInventory(page, 'Сырье', { width: 390, height: 844 });
    await assertNoHorizontalOverflow(page, 'warehouse inventory mobile');
    await screenshot(page, 'warehouse-mobile-raw-material');

    await gotoRawMaterial(page, 'production', { width: 390, height: 844 });
    await assertNoHorizontalOverflow(page, 'production raw material mobile');
    await screenshot(page, 'production-mobile-raw-material');

    await gotoWarehouseInventory(page, WAREHOUSE_STOCK_SECTION, {
      width: 1366,
      height: 900,
    });
    await assertNoHorizontalOverflow(page, 'warehouse inventory desktop');
    await screenshot(page, 'warehouse-desktop-stock-workspace');

    await gotoRawMaterial(page, 'production', { width: 1440, height: 900 });
    await assertNoHorizontalOverflow(page, 'production raw material desktop');
    await screenshot(page, 'production-desktop-raw-material');

    await mkdir(screenshotDir, { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`Raw material module smoke passed. Report: ${reportPath}`);
  } finally {
    await browser.close();
  }
}

try {
  await projectionChecks();
  await browserChecks();
} finally {
  server.kill('SIGTERM');
}
