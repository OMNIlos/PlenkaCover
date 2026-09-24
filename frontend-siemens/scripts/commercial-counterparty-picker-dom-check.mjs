import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const port = Number(process.env.COMMERCIAL_PICKER_CHECK_PORT ?? 5198);
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Counterparty picker check server did not start in time.');
}

const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(),
  stdio: 'ignore',
});

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const container = document.createElement('main');
    container.id = 'counterparty-picker-harness';
    document.body.append(container);
    const { mountCounterpartyPickerHarness } = await import(
      '/scripts/commercial-counterparty-picker-harness.tsx'
    );
    mountCounterpartyPickerHarness(container);
  });

  const searchbox = page.getByRole('searchbox', {
    name: 'Поиск контрагента',
    exact: true,
  });
  await searchbox.waitFor({ state: 'visible' });
  const combobox = page.getByRole('combobox', { name: 'Контрагент', exact: true });
  assert(
    (await combobox.count()) === 1,
    'Counterparty combobox is not exposed with the accessible name "Контрагент".',
  );
  const labelState = await combobox.evaluate((element) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    return {
      labelledBy,
      labelText: labelledBy ? document.getElementById(labelledBy)?.textContent?.trim() : null,
      insideLabel: Boolean(element.closest('label')),
    };
  });
  assert(labelState.labelledBy, 'Counterparty combobox has no aria-labelledby association.');
  assert(labelState.labelText === 'Контрагент', 'Counterparty combobox caption is not associated.');
  assert(!labelState.insideLabel, 'Counterparty picker remains nested in an outer label.');

  assert(
    (await page.locator('.counterparty-search-picker-selected').count()) === 0,
    'The selected counterparty is repeated above the searchable selector.',
  );
  assert(
    (await page.locator('.counterparty-search-picker-results').count()) === 0,
    'Counterparty options still use an overlay list.',
  );

  const loadMore = page.getByRole('button', { name: 'Показать ещё', exact: true });
  const quickCreate = page.getByRole('button', { name: 'Новый контрагент', exact: true });
  const templateSelector = page.getByRole('combobox', { name: 'Шаблон', exact: true });
  const picker = page.locator('.counterparty-search-picker');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const pickerLayout = await Promise.all([
      picker.boundingBox(),
      searchbox.boundingBox(),
      combobox.boundingBox(),
      loadMore.boundingBox(),
      quickCreate.boundingBox(),
      templateSelector.boundingBox(),
    ]);
    const [pickerBox, searchboxBox, comboboxBox, loadMoreBox, quickCreateBox, templateBox] =
      pickerLayout;
    assert(
      pickerBox &&
        searchboxBox &&
        comboboxBox &&
        loadMoreBox &&
        quickCreateBox &&
        templateBox,
      `Counterparty picker layout is incomplete at ${viewport.width}px.`,
    );
    assert(
      Math.abs(searchboxBox.y - loadMoreBox.y) <= 2,
      `Load more must align with counterparty search at ${viewport.width}px.`,
    );
    assert(
      Math.abs(comboboxBox.y - quickCreateBox.y) <= 2,
      `Quick create must align with the counterparty selector at ${viewport.width}px.`,
    );
    const actionGap = quickCreateBox.y - (loadMoreBox.y + loadMoreBox.height);
    assert(
      actionGap >= 0 && actionGap <= 8,
      `Counterparty actions must stay compact at ${viewport.width}px; gap is ${actionGap}px.`,
    );
    assert(
      Math.abs(loadMoreBox.x - quickCreateBox.x) <= 2 &&
        Math.abs(loadMoreBox.width - quickCreateBox.width) <= 2,
      `Counterparty actions must share one column at ${viewport.width}px.`,
    );
    assert(
      comboboxBox.y >= searchboxBox.y + searchboxBox.height,
      'The native counterparty selector must render below the search field.',
    );
    assert(
      Math.abs(comboboxBox.width - searchboxBox.width) <= 2,
      'Counterparty search and selector must have the same width.',
    );
    assert(
      comboboxBox.y - (searchboxBox.y + searchboxBox.height) <= 8,
      'The native counterparty selector must stay compact below search.',
    );
    const pickerOverflow = await picker.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    assert(
      pickerOverflow <= 1,
      `Counterparty picker overflows by ${pickerOverflow}px at ${viewport.width}px.`,
    );
    assert(
      loadMoreBox.x + loadMoreBox.width <= pickerBox.x + pickerBox.width + 1 &&
        quickCreateBox.x + quickCreateBox.width <= pickerBox.x + pickerBox.width + 1,
      `Counterparty actions leave the picker at ${viewport.width}px.`,
    );
    if (viewport.width > 900) {
      assert(
        templateBox.x >= pickerBox.x + pickerBox.width &&
          Math.abs(templateBox.y - searchboxBox.y) <= 2,
        `Template selector must remain beside the counterparty picker at ${viewport.width}px.`,
      );
    } else {
      assert(
        templateBox.y >= pickerBox.y + pickerBox.height,
        'Template selector must follow the counterparty picker at 390px.',
      );
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  await searchbox.focus();
  await page.keyboard.press('Tab');
  assert(
    await combobox.evaluate((element) => document.activeElement === element),
    'Tab from counterparty search must reach the native selector.',
  );
  await page.keyboard.press('Tab');
  assert(
    await loadMore.evaluate((element) => document.activeElement === element),
    'Load more must follow the native selector in the Tab order.',
  );
  await page.keyboard.press('Tab');
  assert(
    await quickCreate.evaluate((element) => document.activeElement === element),
    'Quick create must follow load more in the Tab order.',
  );

  await searchbox.fill('Урал');
  assert(
    (await combobox.locator('option').allTextContents()).includes('УралПак'),
    'Counterparty search did not retain the matching native option.',
  );
  await combobox.selectOption({ label: 'УралПак' });
  assert(
    (await combobox.inputValue()) === 'cp-uralpak',
    'The native selector did not persist the canonical counterparty id.',
  );

  const actionArea = page.locator('.drawer-actions');
  const summary = actionArea.locator('.intake-create-summary');
  assert(
    (await summary.count()) === 1,
    'The request warning is not inside the bottom action area.',
  );
  const summaryAndDraft = await Promise.all([
    summary.boundingBox(),
    actionArea.getByRole('button', { name: 'Сохранить черновик', exact: true }).boundingBox(),
  ]);
  const [summaryBox, draftButtonBox] = summaryAndDraft;
  assert(
    summaryBox && draftButtonBox && summaryBox.y < draftButtonBox.y,
    'The request warning must render immediately above the action buttons.',
  );

  await quickCreate.focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('dialog', { name: 'Быстро создать контрагента', exact: true })
    .waitFor({ state: 'visible' });

  console.log('Commercial counterparty picker DOM check passed.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
