import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5190;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');

// Commercial is exercised against a real Bearer session by commercial-live-smoke.mjs.
// This legacy fixture audit remains focused on the other role surfaces.
const roles = ['production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const globalForbidden = [
  'Демо-роли',
  'demo',
  'mock',
  'adapter',
  'source of truth',
  'ProductionOrder',
  'AuditEvent',
  'OperationalEvent',
  'production-интеграция',
  'started',
  'closed facts',
  'payload',
  'discovery',
  'invoice handoff',
  'manual operation',
  'cash/manual',
  'default_30_days',
  'source_error',
  'Mixed pallet',
  'черновой предпросмотр',
  'contract-only',
  'Проверить QR',
  'Наклеил этикетку',
  'Завпроизводство',
  'Event',
];
const roleForbidden = {
  operator: [
    'Счет',
    'Оплата',
    'Статус оплаты',
    'Бухгалтерская толщина',
    'Отгрузка',
    'Откат',
    '1С',
    'ООО',
    'contract',
  ],
  warehouse: [
    'Откат',
    'Статус оплаты',
    'Бухгалтерская толщина',
    'Сумма',
    'Влияние на стоимость',
    'Частично оплачен',
    'Не оплачен',
    'Просрочка',
  ],
};

function waitForServer() {
  const deadline = Date.now() + 20_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // retry until deadline
      }
      if (Date.now() > deadline) {
        reject(new Error('Vite server did not start in time'));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function collectText(page) {
  const bodyText = await page.locator('body').innerText();
  const attributeText = await page
    .locator('[title], [aria-label], ix-tooltip')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );
  return `${bodyText}\n${attributeText}`;
}

async function collectWorkspaceText(page) {
  const root = page.locator('.app-shell').first();
  const bodyText = await root.innerText();
  const attributeText = await root
    .locator('[title], [aria-label], ix-tooltip')
    .evaluateAll((elements) =>
      elements
        .map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label'), element.textContent]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n'),
    );
  return `${bodyText}\n${attributeText}`;
}

async function collectWorkspaceVisibleText(page) {
  return page.locator('.app-shell').first().innerText();
}

async function selectFirstWorkspaceObject(page, role) {
  if (role === 'operator') {
    if ((await page.locator('.operator-rolls-hub').count()) > 0) {
      await page
        .locator('.operator-rolls-hub-filters')
        .getByRole('radio', { checked: true })
        .first()
        .click();
      await page.waitForTimeout(150);
    }
    const row = page
      .locator(
        '.operator-rolls-hub-row:not(.is-head), .operator-orders-row:not(.is-head), [aria-label^="Открыть рулон"]',
      )
      .first();
    await row.waitFor({ state: 'visible', timeout: 7000 });
    await row.click();
    return;
  }
  await page.locator('.queue-row-main').first().click();
}

function findLeaks(text, terms) {
  const normalized = text.toLowerCase();
  return terms.filter((term) => {
    if (term === '1С') {
      return /(^|[\s"'«(])1с(?=$|[\s"'»:;,.!?)])/.test(normalized);
    }
    return normalized.includes(term.toLowerCase());
  });
}

const roleActionForbidden = {
  commercial: [
    'К заказ-наряду',
    'В заказ-наряд',
    'Открыть заказ-наряд',
    'Согласовать заказ-наряд',
    'Назначить оператора',
  ],
  finance: ['К выдаче склада', 'Открыть выдачу на складе'],
  warehouse: [
    'Проверить оплату',
    'Отметить оплату вручную',
    'Обновить оплату',
    'Выставить счет',
    'Согласовать заказ-наряд',
  ],
  operator: ['Заказ-наряд', 'Согласовать', 'Назначить оператора', 'Счет', 'Оплата'],
  admin: ['Согласовать заказ-наряд', 'Назначить оператора', 'Зафиксировать вес', 'Закрыть выдачу'],
};

const visibleSubtitleForbidden = [
  'Клиентский заказ без ERP-вкладок',
  'После подтверждения недостающая часть уйдет в производство',
  'После подтверждения производство не требуется',
  'Действие обновит маршрут заявки',
  'Минимальный billing snapshot',
  'Готовые наборы доступа для типовых ролей',
  'Проверьте параметры, маршрут и передайте заказ дальше',
  'Только операторские штрафы · агрегат не виден в роли оператора',
];

const currentRoleLabels = {
  commercial: 'Коммерция',
  production: 'Зав. производства',
  finance: 'Бухгалтерия',
  warehouse: 'Склад',
};

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function assertNoSelfRoleChipNoise(page, role, context) {
  const roleLabel = currentRoleLabels[role];
  if (!roleLabel) return;

  const detail = page.locator('.detail-view').first();
  if ((await detail.count()) === 0) return;

  const detailText = await detail.innerText();
  const forbidden =
    role === 'commercial'
      ? ['Главный блок коммерции', 'Ожидает: Коммерция', 'Владелец: Коммерция']
      : [`Владелец: ${roleLabel}`];
  const hits = forbidden.filter((term) => detailText.includes(term));
  if (hits.length > 0) {
    throw new Error(`${context}: self-role owner/chip noise visible: ${hits.join(', ')}`);
  }
  const splitOwnerPattern = new RegExp(`Владелец\\s+${escapedRegex(roleLabel)}`, 'i');
  if (splitOwnerPattern.test(detailText)) {
    throw new Error(
      `${context}: current role rendered as split owner label: Владелец ${roleLabel}`,
    );
  }

  const ownerChipTexts = await detail
    .locator('.commercial-owner-chip, .order-object-state > span:not(.order-state-badge)')
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    );
  const selfOwnerChips = ownerChipTexts.filter((text) => text === roleLabel);
  if (selfOwnerChips.length > 0) {
    throw new Error(
      `${context}: current role rendered as standalone owner chip: ${selfOwnerChips.join(', ')}`,
    );
  }
}

function assertRoleActionBoundary(role, text) {
  const leaks = findLeaks(text, roleActionForbidden[role] ?? []);
  if (leaks.length > 0) {
    throw new Error(
      `${role} role-action boundary leak: ${leaks.join(', ')}\n${leakContexts(text, leaks).join('\n')}`,
    );
  }
}

function leakContexts(text, leaks) {
  const normalized = text.toLowerCase();
  return leaks.map((term) => {
    const index = normalized.indexOf(term.toLowerCase());
    const start = Math.max(0, index - 80);
    const end = Math.min(text.length, index + term.length + 80);
    return `${term}: ${text.slice(start, end).replace(/\s+/g, ' ')}`;
  });
}

const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: 'pipe',
  shell: false,
  env: { ...process.env, VITE_LIVE_CONTOURS: '', VITE_REQUIRE_AUTH: 'off' },
});

try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  for (const role of roles) {
    await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 7000 });
    const text = await collectText(page);
    const workspaceText = await collectWorkspaceText(page);
    const workspaceVisibleText = await collectWorkspaceVisibleText(page);
    const leaks = [
      ...findLeaks(text, globalForbidden),
      ...findLeaks(text, roleForbidden[role] ?? []),
    ];
    if (leaks.length > 0) {
      throw new Error(
        `${role} DOM leakage: ${leaks.join(', ')}\n${leakContexts(text, leaks).join('\n')}`,
      );
    }
    assertRoleActionBoundary(role, workspaceText);
    const visibleSubtitleLeaks = findLeaks(workspaceVisibleText, visibleSubtitleForbidden);
    if (visibleSubtitleLeaks.length > 0) {
      throw new Error(
        `${role} visible subtitle copy leak: ${visibleSubtitleLeaks.join(', ')}\n${leakContexts(workspaceVisibleText, visibleSubtitleLeaks).join('\n')}`,
      );
    }

    if (role === 'commercial') {
      if ((await page.locator('.list-panel .queue-row').count()) === 0) {
        throw new Error('commercial must open with a visible work queue');
      }
      if (
        (await page.locator('.queue-row.is-selected').count()) !== 0 ||
        (await page.locator('.detail-view').count()) !== 0
      ) {
        throw new Error(
          'commercial desktop must open with an empty detail pane until explicit card selection',
        );
      }
    }

    const positiveFirstDetailSelector =
      role === 'warehouse' ? '.warehouse-scan-station-detail .warehouse-scan' : '.detail-view';
    if (
      !['commercial', 'production', 'operator', 'finance', 'director'].includes(role) &&
      (await page.locator(positiveFirstDetailSelector).count()) === 0
    ) {
      throw new Error(`${role} must open with a selected positive-first detail pane`);
    }

    if (role === 'commercial') {
      await page.locator('.queue-row-main').first().click();
      await page.waitForTimeout(250);
      if ((await page.locator('.list-panel .queue-row').count()) === 0) {
        throw new Error('commercial list must stay visible after selecting a card');
      }
      const selectedWorkspaceText = await collectWorkspaceText(page);
      // Новый флоу: складское покрытие подтверждается через передачу в бухгалтерию.
      if (
        !selectedWorkspaceText.includes('Подтвердить складское покрытие') &&
        !selectedWorkspaceText.includes('Подтверждение резерва') &&
        !selectedWorkspaceText.includes('Направить в бухгалтерию')
      ) {
        throw new Error('commercial must open with a clean warehouse-cover confirmation context');
      }
      await assertNoSelfRoleChipNoise(page, role, 'commercial selected detail');
    }

    if (role === 'production') {
      const selectedWorkspaceText = await collectWorkspaceText(page);
      if (
        (await page.locator('.production-orders-hub').count()) === 0 ||
        (await page.locator('.detail-view').count()) > 0
      ) {
        throw new Error('production order section must open as a standalone orders hub page');
      }
      for (const required of ['Заказ-наряды', 'Заказы', 'Рулоны']) {
        if (!selectedWorkspaceText.includes(required)) {
          throw new Error(`production orders hub missing: ${required}`);
        }
      }
      for (const hiddenInOrderSelection of ['Архив', 'Сводка']) {
        if (selectedWorkspaceText.includes(hiddenInOrderSelection)) {
          throw new Error(`production order-selection mode leaked: ${hiddenInOrderSelection}`);
        }
      }
      if (selectedWorkspaceText.includes('Параметры заказ-наряда')) {
        throw new Error(
          'production orders hub must not render the old order-detail parameters card',
        );
      }
      if ((await page.locator('.detail-panel .production-operator-load-card').count()) > 0) {
        throw new Error('production order detail must not embed shift operator workload');
      }
      await page
        .getByRole('button', { name: /Все рулоны/i })
        .first()
        .click();
      await page.waitForTimeout(250);
      if (
        (await page.locator('.production-orders-hub').count()) === 0 ||
        (await page.locator('.detail-view').count()) > 0
      ) {
        throw new Error('production all-rolls section must open inside the standalone orders hub');
      }
      const allRollsText = await collectWorkspaceText(page);
      for (const required of ['Рулоны', 'Архив', 'Сводка']) {
        if (!allRollsText.includes(required)) {
          throw new Error(`production all-rolls hub missing: ${required}`);
        }
      }
      const dispatchTable = page.locator('.production-roll-dispatch-table').first();
      if ((await dispatchTable.count()) === 0) {
        throw new Error('production all-rolls page must expose roll-level dispatch table');
      }
      if ((await page.locator('.production-roll-table-toolbar').count()) !== 0) {
        throw new Error(
          'production all-rolls page must not render the old permanent roll queue toolbar',
        );
      }
      if ((await page.locator('.production-priority-group-strip').count()) !== 0) {
        throw new Error('production all-rolls page must not render priority group summary cards');
      }
      for (const label of [
        /Выбрать все рулоны/i,
        /Выбрать рулон/i,
        /Поднять рулон/i,
        /Опустить рулон/i,
        /Оператор для рулона/i,
        /Станок для рулона/i,
        /Приоритет для рулона/i,
      ]) {
        if ((await page.getByLabel(label).count()) === 0) {
          throw new Error(`production roll dispatch controls missing label: ${label}`);
        }
      }
      if (
        (await page.locator('.operator-roll-table.is-primary, .operator-rolls-hub').count()) > 0
      ) {
        throw new Error('production must not reuse operator roll hub/table surface');
      }
      const dispatchText = await dispatchTable.innerText();
      for (const required of ['Рулон', 'Заказ', 'Параметры', 'Оператор', 'Станок', 'Приоритет']) {
        if (!dispatchText.includes(required)) {
          throw new Error(`production roll dispatch table missing column: ${required}`);
        }
      }
      if (
        (await dispatchTable.getByRole('columnheader', { name: /Статус/i }).count()) > 0 ||
        (await dispatchTable.locator('[data-label="Статус"]').count()) > 0
      ) {
        throw new Error('production roll dispatch table must not render the removed status column');
      }
      for (const orderId of ['ЗН-2606-014', 'ЗН-2606-020']) {
        if (!dispatchText.includes(orderId)) {
          throw new Error(
            `production roll dispatch table must aggregate roll rows across orders: missing ${orderId}`,
          );
        }
      }
      if (!/POS-|позици/i.test(dispatchText)) {
        throw new Error(
          'production roll dispatch table must keep order line/position reference visible',
        );
      }
      if (dispatchText.includes('Сортировка')) {
        throw new Error(
          'production roll dispatch table must not show the removed sort toolbar copy',
        );
      }
      await page
        .getByRole('button', { name: /Операторы \/ загрузка/i })
        .first()
        .click();
      await page.waitForTimeout(250);
      const loadText = await collectWorkspaceText(page);
      if (
        (await page.locator('.production-operator-load-surface').count()) === 0 ||
        (await page.locator('.detail-view').count()) > 0
      ) {
        throw new Error('production operator workload section must open as a standalone page');
      }
      if (
        !loadText.includes('Операторы / загрузка') ||
        (await page.locator('.production-operator-load-disclosure').count()) === 0
      ) {
        throw new Error('production operator workload page must expose operator load module');
      }
      if (
        (await page.getByRole('heading', { name: 'Загрузка операторов', exact: true }).count()) > 0
      ) {
        throw new Error('production operator workload page must not repeat its inner title');
      }
      if (loadText.includes('Параметры заказ-наряда')) {
        throw new Error(
          'production operator workload page must not render order-detail parameters',
        );
      }
      await assertNoSelfRoleChipNoise(page, role, 'production selected detail');
    }

    if (role === 'finance') {
      if (
        (await page.locator('.role-nav .rail-title').count()) > 0 ||
        (await page.locator('.role-nav-total').count()) > 0 ||
        (await page.locator('.panel-count-label').count()) > 0
      ) {
        throw new Error('finance shell must not repeat rail or list totals');
      }
      if ((await page.locator('.queue-row-main').count()) > 0) {
        await page.locator('.queue-row-main').first().click();
        await page.waitForTimeout(250);
      }
      if (
        (await page.locator('.finance-header-meta[aria-label="Счет, клиент и дело"]').count()) >
          0 ||
        (await page.locator('.finance-command-source .finance-state-badge').count()) > 0
      ) {
        throw new Error('finance detail header must not repeat metadata or payment state');
      }
      await assertNoSelfRoleChipNoise(page, role, 'finance selected detail');
    }

    if (role === 'operator') {
      if (text.includes('Открыть смену')) {
        throw new Error(
          'operator default screen must start from active shift and positive order card',
        );
      }
      await page
        .locator('.section-nav-button, .role-top-nav-item, .role-nav button, .role-top-nav button')
        .filter({ hasText: /Смена/i })
        .first()
        .click();
      const shiftText = await collectText(page);
      if (!shiftText.includes('Стартовый вес') || !shiftText.includes('700 кг')) {
        throw new Error(
          'operator shift section must expose the fixed start Big-bag weight for the active happy path',
        );
      }
      await page
        .locator('.section-nav-button, .role-top-nav-item, .role-nav button, .role-top-nav button')
        .filter({ hasText: /Мои рулоны|Рулоны и заказы/i })
        .first()
        .click();
      await page.waitForTimeout(250);
      await selectFirstWorkspaceObject(page, role);
      const operatorHubBox = await page.locator('.operator-rolls-hub').boundingBox();
      if (!operatorHubBox || operatorHubBox.y > 760) {
        throw new Error('operator workbench must show the roll hub in the first working viewport');
      }
      const operatorActionScope = page
        .locator('.operator-rolls-hub-page .detail-view, .detail-panel .detail-view')
        .first();
      const operatorFocusBox = await page
        .locator('.operator-focus.operator-focus-compact')
        .boundingBox();
      if (!operatorFocusBox) {
        throw new Error('operator compact step card must stay visible after roll selection');
      }
      if ((await page.locator('.operator-current-actions .action-tile:visible').count()) === 0) {
        throw new Error(
          'operator must expose the current large action in the terminal detail area',
        );
      }
      if (
        (await page
          .locator('.operator-terminal.operator-table-terminal .terminal-actions')
          .count()) > 0
      ) {
        throw new Error(
          'operator table terminal must not keep the old dominant terminal action panel',
        );
      }
      if (
        (await page
          .locator(
            '.operator-terminal.operator-table-terminal .operator-roll-mobile-evidence:visible',
          )
          .count()) > 0
      ) {
        throw new Error(
          'operator table terminal must not render competing mobile roll evidence cards',
        );
      }
      const selectedHubRow = page.locator('.operator-rolls-hub-row.is-selected').first();
      const selectedHubRowBox = await selectedHubRow.boundingBox();
      if (!selectedHubRowBox) {
        throw new Error('operator hub row click must select a roll');
      }
      await operatorActionScope
        .locator('button')
        .filter({ hasText: /Примите заказ|Принять/i })
        .first()
        .click();
      const activeOperatorText = await collectText(page);
      const operatorInternalLeaks = findLeaks(activeOperatorText, [
        'contract',
        'mock',
        'adapter',
        'ООО',
      ]);
      if (operatorInternalLeaks.length > 0) {
        throw new Error(
          `operator must not expose internal/customer legal terms: ${operatorInternalLeaks.join(', ')}`,
        );
      }
      const forbiddenManualProductionWeight =
        /ручн[а-я\s-]*(ввод|ввести|записать)[а-я\s-]*(рулон|шпул|брак)|(рулон|шпул|брак)[а-я\s-]*ручн[а-я\s-]*(ввод|ввести|записать)/i;
      if (forbiddenManualProductionWeight.test(activeOperatorText)) {
        throw new Error('operator must not expose manual roll/spool/defect weight entry');
      }
      if (!activeOperatorText.toLowerCase().includes('вес шпули')) {
        throw new Error('operator order flow must keep spool weight step visible');
      }
      const enabledSpoolCapture = operatorActionScope
        .getByRole('button', { name: /Зафиксируйте вес шпули|Зафиксировать вес шпули/i })
        .first();
      if ((await enabledSpoolCapture.count()) === 0 || (await enabledSpoolCapture.isDisabled())) {
        throw new Error(
          'operator must expose spool weight capture when stable scale signal is ready',
        );
      }
      if ((await operatorActionScope.getByRole('button', { name: /Включить весы/i }).count()) > 0) {
        throw new Error('operator must not expose fake scale activation as a required user step');
      }
      await enabledSpoolCapture.click();
      const rollBeforeScaleText = await collectText(page);
      if (!rollBeforeScaleText.toLowerCase().includes('вес рулона')) {
        throw new Error(
          'operator order flow must move from spool capture to roll weight on the same workbench',
        );
      }
      const enabledRollCapture = operatorActionScope
        .getByRole('button', { name: /Зафиксируйте вес рулона|Зафиксировать вес рулона/i })
        .first();
      if ((await enabledRollCapture.count()) === 0 || (await enabledRollCapture.isDisabled())) {
        throw new Error(
          'operator must expose roll weight capture when stable scale signal is ready',
        );
      }
      if ((await operatorActionScope.getByRole('button', { name: /Включить весы/i }).count()) > 0) {
        throw new Error(
          'operator must not reintroduce fake scale activation before roll weight capture',
        );
      }
      const rollOperatorText = await collectText(page);
      if (
        !rollOperatorText.toLowerCase().includes('вес рулона') ||
        !rollOperatorText.toLowerCase().includes('стабильный сигнал')
      ) {
        throw new Error(
          'operator order flow must keep roll weight step visible with stable scale signal context',
        );
      }
      const defectAction = page.getByRole('button', { name: /Брак/i }).first();
      if ((await defectAction.count()) > 0) {
        const defectReasonHint = `${(await defectAction.getAttribute('title')) ?? ''} ${(await defectAction.getAttribute('aria-label')) ?? ''}`;
        if (!/причин|форм/i.test(defectReasonHint)) {
          throw new Error('operator defect action must indicate reason/confirmation flow');
        }
      }
      await enabledRollCapture.click();
      const qrPrintText = await collectText(page);
      if (!qrPrintText.toLowerCase().includes('напечатайте qr')) {
        throw new Error('operator order flow must require QR print before scan');
      }
      if (
        (await operatorActionScope
          .getByRole('button', { name: /Сканируйте QR|Сканировать QR/i })
          .count()) > 0
      ) {
        throw new Error('operator must not expose QR scan before QR print');
      }
      const enabledHandoverBeforeQr = await operatorActionScope
        .getByRole('button', { name: /Передайте рулон на склад|На склад/i })
        .evaluateAll(
          (buttons) =>
            buttons.filter((button) => {
              const rect = button.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                !(button instanceof HTMLButtonElement && button.disabled) &&
                button.getAttribute('aria-disabled') !== 'true'
              );
            }).length,
        );
      if (enabledHandoverBeforeQr > 0) {
        throw new Error('operator must not expose warehouse handover before verified QR');
      }
      await operatorActionScope
        .getByRole('button', { name: /Напечатайте QR|Напечатать QR/i })
        .first()
        .click();
      const qrScanText = await collectText(page);
      if (!qrScanText.toLowerCase().includes('сканируйте qr')) {
        throw new Error('operator order flow must expose QR scan only after print');
      }
      await operatorActionScope
        .getByRole('button', { name: /Сканируйте QR|Сканировать QR/i })
        .first()
        .click();
      const operatorScanner = page.getByLabel('Сканирование QR оператора');
      if ((await operatorScanner.inputValue()) !== '') {
        throw new Error('operator HID input must start blank');
      }
      await operatorScanner.fill('dom-hid-scanner-payload');
      await operatorScanner.press('Enter');
      const afterScanText = (await collectText(page)).toLowerCase();
      const manualHandoverAfterQr = await operatorActionScope
        .getByRole('button', { name: /Передайте рулон на склад|На склад/i })
        .count();
      if (manualHandoverAfterQr > 0) {
        throw new Error('operator order flow must not expose manual handover after verified QR');
      }
      if (
        !afterScanText.includes('передан на склад') &&
        !afterScanText.includes('зафиксировать вес шпули')
      ) {
        throw new Error('operator QR scan must automatically advance warehouse handover');
      }
    }

    if (role === 'warehouse') {
      const mixedPalletRow = page
        .locator(
          '.warehouse-scan-station-data-table tbody tr[role="button"], .queue-row-main, .queue-row',
        )
        .filter({ hasText: /PAL-2606-07|Сборная палета/i })
        .first();
      if ((await mixedPalletRow.count()) > 0) {
        await mixedPalletRow.click();
        await page.waitForTimeout(250);
      }
      const warehouseText = await collectWorkspaceText(page);
      await assertNoSelfRoleChipNoise(page, role, 'warehouse selected detail');
      if ((await page.locator('.warehouse-command-strip').count()) === 0) {
        throw new Error('warehouse must keep scan-first session strip visible');
      }
      if (
        (await page.locator('.warehouse-roll-table').count()) === 0 ||
        !warehouseText.includes('Ожидаемые рулоны')
      ) {
        throw new Error('warehouse must expose expected rolls table');
      }
      const expectedRollRows = page.locator(
        '.warehouse-roll-table .warehouse-roll-row:not(.is-head)',
      );
      if (
        (await expectedRollRows.count()) < 5 ||
        !warehouseText.includes('A-17') ||
        !warehouseText.includes('B-11') ||
        !warehouseText.includes('C-04')
      ) {
        throw new Error(
          'warehouse mixed pallet table must show expected roll rows across multiple orders',
        );
      }
      const palletHistory = page.locator('.warehouse-pallet-history').first();
      const openPalletDocument = palletHistory
        .getByRole('button', { name: /Открыть палетный лист PAL-2606-07/i })
        .first();
      if ((await openPalletDocument.count()) !== 1) {
        throw new Error('warehouse mixed-pallet history must expose its pallet document');
      }
      await openPalletDocument.click();
      const palletPanel = page.locator('.warehouse-pallet-label-panel').first();
      await palletPanel.waitFor({ state: 'visible', timeout: 7000 });
      const palletPanelText = await palletPanel.innerText();
      if (
        !palletPanelText.includes('Статус палетного листа не подтвержден') ||
        !palletPanelText.includes(
          'Обновите приёмку: печать, выгрузка и действия с листом пока недоступны.',
        ) ||
        palletPanelText.includes('________________')
      ) {
        throw new Error(
          'warehouse fixture pallet document must fail closed without a confirmed server lifecycle',
        );
      }
      if (
        (await palletPanel
          .locator(
            '.warehouse-pallet-print-button, .warehouse-pallet-export-toolbar, .warehouse-pallet-export-button',
          )
          .count()) !== 0
      ) {
        throw new Error(
          'warehouse fixture pallet document must not expose print or export controls without a confirmed server lifecycle',
        );
      }
      if (
        (await page
          .locator('.warehouse-action-deck')
          .getByText(/черновик печати|палетный лист/i)
          .count()) > 0
      ) {
        throw new Error(
          'warehouse pallet print action must not be duplicated in the large action deck',
        );
      }
      if (warehouseText.includes('Ошибки') && warehouseText.includes('1 к разбору')) {
        throw new Error('warehouse must not count successful mixed-pallet scan result as an error');
      }
      if (warehouseText.includes('Перевзвесить') || warehouseText.includes('Брак')) {
        throw new Error('warehouse must not expose operator reweigh or defect actions');
      }
    }
  }

  await browser.close();
  console.log('DOM leakage checks passed');
} finally {
  server.kill('SIGTERM');
}
