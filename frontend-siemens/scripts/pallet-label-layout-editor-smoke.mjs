import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

import {
  assertSmokeHealthy,
  collectVisibleErrors,
  installPageFailureTracker,
  startOwnedVite,
} from './release-smoke-runtime.mjs';

const viteBin = path.resolve('node_modules/.bin/vite');
const screenshotDir = path.resolve('output/playwright/pallet-label-layout-publication-2026-08-14');
const profile = 'pallet-100x100-configurable-v7';
const canvas = {
  widthDots: 800,
  heightDots: 800,
  dotsPerMm: 8,
  safeInsetDots: 20,
  provenCutYDots: 570,
};
const editorLayout = {
  schemaVersion: 2,
  profile,
  elements: [
    {
      id: 'order',
      kind: 'text',
      xDots: 36,
      yDots: 36,
      widthDots: 390,
      heightDots: 62,
      maxFontSize: 30,
      minFontSize: 18,
      locked: false,
    },
    {
      id: 'customer',
      kind: 'text',
      xDots: 36,
      yDots: 110,
      widthDots: 390,
      heightDots: 88,
      maxFontSize: 28,
      minFontSize: 16,
      locked: false,
    },
    {
      id: 'formedAt',
      kind: 'text',
      xDots: 36,
      yDots: 210,
      widthDots: 390,
      heightDots: 62,
      maxFontSize: 24,
      minFontSize: 14,
      locked: false,
    },
    {
      id: 'rollCount',
      kind: 'text',
      xDots: 36,
      yDots: 284,
      widthDots: 390,
      heightDots: 62,
      maxFontSize: 30,
      minFontSize: 18,
      locked: false,
    },
    {
      id: 'qr',
      kind: 'qr',
      xDots: 449,
      yDots: 36,
      widthDots: 315,
      heightDots: 315,
      maxFontSize: 0,
      minFontSize: 0,
      locked: true,
    },
    {
      id: 'storage',
      kind: 'text',
      xDots: 36,
      yDots: 380,
      widthDots: 728,
      heightDots: 170,
      maxFontSize: 28,
      minFontSize: 16,
      locked: false,
    },
  ],
};
const bootstrap = {
  schemaVersion: 2,
  profile,
  canvas,
  editorLayout,
  activePublication: null,
  sources: [
    {
      documentId: 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
      kind: 'control',
      label: 'Контрольный синтетический источник',
      palletId: 'CONTROL-VALIDATION-01',
      createdAt: '2026-01-01T00:00:00.000Z',
      rollCount: 24,
    },
  ],
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function mockExactPreviewPng(width, height) {
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    pixels[y * rowBytes] = 0;
    pixels.fill(255, y * rowBytes + 1, (y + 1) * rowBytes);
  }
  const setPixel = (x, y, value = 24) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = y * rowBytes + 1 + x * 4;
    pixels[offset] = value;
    pixels[offset + 1] = value;
    pixels[offset + 2] = value;
    pixels[offset + 3] = 255;
  };
  const line = (x1, y1, x2, y2, thickness = 3) => {
    if (x1 === x2) {
      for (let x = x1; x < x1 + thickness; x += 1) {
        for (let y = y1; y <= y2; y += 1) setPixel(x, y);
      }
      return;
    }
    for (let y = y1; y < y1 + thickness; y += 1) {
      for (let x = x1; x <= x2; x += 1) setPixel(x, y);
    }
  };
  line(20, 20, 779, 20);
  line(20, 20, 20, 779);
  line(779, 20, 779, 779);
  line(20, 779, 779, 779);
  line(20, 82, 779, 82);
  line(435, 82, 435, 570);
  for (let moduleY = 0; moduleY < 37; moduleY += 1) {
    for (let moduleX = 0; moduleX < 37; moduleX += 1) {
      if ((moduleX * 5 + moduleY * 3 + moduleX * moduleY) % 7 > 2) continue;
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) setPixel(477 + moduleX * 7 + x, 120 + moduleY * 7 + y);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const exactPreviewPng = mockExactPreviewPng(800, 800);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function element(body, id) {
  return body.layout.elements.find((item) => item.id === id);
}

let ownedVite;
let browser;
try {
  await mkdir(screenshotDir, { recursive: true });
  ownedVite = await startOwnedVite({
    viteBin,
    cwd: process.cwd(),
    mode: 'test',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_LIVE_CONTOURS: '',
      VITE_REQUIRE_AUTH: 'off',
    },
  });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__palletLayoutPrintCalls = 0;
    window.print = () => {
      window.__palletLayoutPrintCalls += 1;
    };
  });
  const tracker = installPageFailureTracker(page);
  const previewBodies = [];
  const publishBodies = [];
  const adminRequests = [];
  let activePublication = null;

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    adminRequests.push(`${request.method()} ${pathname}`);
    if (request.method() === 'GET' && pathname === '/api/admin/pallet-label-layout-editor') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...bootstrap,
          activePublication,
          editorLayout: activePublication?.layout ?? editorLayout,
        }),
      });
      return;
    }
    if (
      request.method() === 'POST' &&
      pathname === '/api/admin/pallet-label-layout-editor/preview'
    ) {
      const body = request.postDataJSON();
      previewBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: {
          'X-Pallet-Layout-Diagnostics': Buffer.from(
            JSON.stringify({
              belowProvenCut: [],
              outsideSafeArea: [],
              overlaps: [],
            }),
          ).toString('base64url'),
        },
        body: exactPreviewPng,
      });
      return;
    }
    if (
      request.method() === 'POST' &&
      pathname === '/api/admin/pallet-label-layout-editor/publish'
    ) {
      const body = request.postDataJSON();
      publishBodies.push(body);
      activePublication = {
        id: 'publication-browser-smoke-1',
        version: 1,
        contentHash: 'a'.repeat(64),
        activatedAt: '2026-08-11T21:30:00.000Z',
        layout: body.layout,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ publication: activePublication, replayed: false }),
      });
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: `Unhandled smoke route: ${request.method()} ${pathname}` }),
    });
  });

  const url = new URL(ownedVite.baseUrl);
  url.searchParams.set('role', 'admin');
  url.searchParams.set('section', 'Макет палетного листа');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  const editor = page.getByRole('region', { name: 'Макет палетного листа' });
  try {
    await editor.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    const body = (await page.locator('body').innerText()).replace(/\s+/gu, ' ').slice(0, 2_000);
    throw new Error(
      `editor did not open; visible body: ${body}; browser errors: ${tracker.pageErrors.join(' | ')}`,
      { cause: error },
    );
  }
  await page.locator('.pallet-layout-preview img').waitFor({ state: 'visible' });
  const exactPreviewDimensions = await page
    .locator('.pallet-layout-preview img')
    .evaluate((image) => ({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
  assert(
    exactPreviewDimensions.width === 800 && exactPreviewDimensions.height === 800,
    `exact PNG must be 800x800, got ${JSON.stringify(exactPreviewDimensions)}`,
  );
  assert(
    previewBodies.length === 1,
    `expected one initial exact preview, got ${previewBodies.length}`,
  );
  const sourceSelect = page.getByLabel('Источник данных для предпросмотра');
  assert(
    (await sourceSelect.inputValue()) === 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
    'post-purge bootstrap did not retain the stable control source id',
  );
  assert(
    (await sourceSelect.locator('option').textContent()) ===
      'Контрольный синтетический источник · 24 рул.',
    'control source is not presented through its safe label',
  );
  assert(
    previewBodies[0]?.sourceDocumentId === 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
    'initial preview did not use the control source',
  );
  assert(
    (await page.locator('.pallet-layout-safe-boundary').count()) === 1,
    'safe inset guide is missing',
  );
  assert(
    (await page.locator('.pallet-layout-cut-line').count()) === 1,
    'proven cut line is missing',
  );
  await page.getByText('Все блоки в гарантированной зоне').waitFor();
  await page.getByText('Все блоки внутри безопасной границы').waitFor();

  await page.getByRole('button', { name: 'Выбрать блок QR палетного листа' }).click();
  for (const label of [
    'X, мм',
    'Y, мм',
    'Ширина, мм',
    'Высота, мм',
    'Максимальный размер шрифта',
  ]) {
    assert(await page.getByLabel(label).isDisabled(), `${label} must be disabled for QR`);
  }

  const availableActions = await editor.locator('button').allTextContents();
  assert(
    availableActions.some((label) => /опубликовать и применить/i.test(label)),
    `publication action is missing: ${availableActions.join(' | ')}`,
  );
  await page.getByText('Базовый макет v2').waitFor();

  const catalogIds = await page
    .locator('[aria-label="Каталог системных блоков"] [data-catalog-element]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-catalog-element')));
  assert(
    JSON.stringify(catalogIds) ===
      JSON.stringify(['order', 'customer', 'formedAt', 'rollCount', 'qr', 'storage']),
    `system catalog differs: ${JSON.stringify(catalogIds)}`,
  );
  assert(
    (await page.getByRole('button', { name: 'Удалить блок QR палетного листа' }).count()) === 0,
    'mandatory pallet-list QR exposes a remove action',
  );
  const previewsBeforeCatalogEdit = previewBodies.length;
  await page.getByRole('button', { name: 'Удалить блок Заказчик' }).click();
  await page.getByRole('button', { name: 'Вернуть блок Заказчик' }).waitFor();
  assert(
    (await page.locator('[data-layout-element="customer"]').count()) === 0,
    'optional customer block remained on the canvas after removal',
  );
  await page.getByRole('button', { name: 'Вернуть блок Заказчик' }).click();
  await page.getByRole('button', { name: 'Удалить блок Заказчик' }).waitFor();
  assert(
    (await page.locator('[data-layout-element="customer"]').count()) === 1,
    'customer block was not restored exactly once',
  );
  assert(
    previewBodies.length >= previewsBeforeCatalogEdit + 2,
    'catalog remove/restore did not request exact previews',
  );

  const orderBlock = page.locator('[data-layout-element="order"]');
  const box = await orderBlock.boundingBox();
  if (!box) throw new Error('order block has no browser geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.pallet-layout-preview img') !== null);
  for (let attempt = 0; attempt < 20 && previewBodies.length < 2; attempt += 1) {
    await page.waitForTimeout(25);
  }
  assert(previewBodies.length >= 2, 'pointer-up did not trigger an immediate exact preview');
  const lastPreview = previewBodies.at(-1);
  const movedOrder = element(lastPreview, 'order');
  const lockedQr = element(lastPreview, 'qr');
  assert(
    movedOrder.xDots !== 36 || movedOrder.yDots !== 36,
    'order drag did not change geometry',
  );
  const atHorizontalBoundary =
    movedOrder.xDots === 0 || movedOrder.xDots === canvas.widthDots - movedOrder.widthDots;
  const atVerticalBoundary =
    movedOrder.yDots === 0 || movedOrder.yDots === canvas.heightDots - movedOrder.heightDots;
  assert(
    (movedOrder.xDots % canvas.dotsPerMm === 0 || atHorizontalBoundary) &&
      (movedOrder.yDots % canvas.dotsPerMm === 0 || atVerticalBoundary),
    `order did not snap to 1 mm or a canvas boundary: ${JSON.stringify(movedOrder)}`,
  );
  assert(
    JSON.stringify(lockedQr) === JSON.stringify(element({ layout: editorLayout }, 'qr')),
    'QR geometry changed after another block drag',
  );

  const resizeHandle = page.locator('[data-layout-resize="order"]');
  const resizeBox = await resizeHandle.boundingBox();
  if (!resizeBox) throw new Error('selected order has no resize handle geometry');
  const previewsBeforeResize = previewBodies.length;
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    resizeBox.x + resizeBox.width / 2 - 80,
    resizeBox.y + resizeBox.height / 2,
  );
  await page.mouse.up();
  for (
    let attempt = 0;
    attempt < 20 && previewBodies.length === previewsBeforeResize;
    attempt += 1
  ) {
    await page.waitForTimeout(25);
  }
  const widthAfterResizeGesture = await page.getByLabel('Ширина, мм').inputValue();
  assert(
    previewBodies.length > previewsBeforeResize,
    `resize pointer-up did not refresh exact PNG; previews=${previewsBeforeResize}; ` +
      `widthBeforeDots=${movedOrder.widthDots}; widthAfterMm=${widthAfterResizeGesture}; ` +
      `handle=${JSON.stringify(resizeBox)}`,
  );
  const resizedOrder = element(previewBodies.at(-1), 'order');
  assert(resizedOrder.widthDots < movedOrder.widthDots, 'resize did not reduce order width');
  assert(
    JSON.stringify(element(previewBodies.at(-1), 'qr')) ===
      JSON.stringify(element({ layout: editorLayout }, 'qr')),
    'QR geometry changed after resize',
  );

  const fontInput = page.getByLabel('Максимальный размер шрифта');
  const previewsBeforeFont = previewBodies.length;
  await fontInput.fill('26');
  for (let attempt = 0; attempt < 30 && previewBodies.length === previewsBeforeFont; attempt += 1) {
    await page.waitForTimeout(25);
  }
  assert(previewBodies.length > previewsBeforeFont, 'numeric font edit did not refresh exact PNG');
  assert(element(previewBodies.at(-1), 'order').maxFontSize === 26, 'numeric font edit was lost');

  await page.getByRole('button', { name: 'Отменить изменение' }).click();
  assert((await fontInput.inputValue()) !== '26', 'undo did not restore the previous font size');
  await page.getByRole('button', { name: 'Вернуть изменение' }).click();
  assert((await fontInput.inputValue()) === '26', 'redo did not restore the numeric font edit');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать JSON' }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('JSON draft download has no local artifact');
  const importedDraft = JSON.parse(await readFile(downloadPath, 'utf8'));
  importedDraft.layout.elements.find((item) => item.id === 'order').maxFontSize = 25;
  await page.locator('.pallet-layout-import-button input').setInputFiles({
    name: 'pallet-layout-roundtrip.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importedDraft)),
  });
  for (let attempt = 0; attempt < 20 && (await fontInput.inputValue()) !== '25'; attempt += 1) {
    await page.waitForTimeout(25);
  }
  assert((await fontInput.inputValue()) === '25', 'versioned JSON import/export round-trip failed');

  await orderBlock.focus();
  assert(
    await orderBlock.evaluate((node) => document.activeElement === node),
    'layout block is not focusable',
  );
  const xBeforeKeyboardMove = Number(await page.getByLabel('X, мм').inputValue());
  await orderBlock.press('ArrowLeft');
  const xAfterKeyboardMove = Number(await page.getByLabel('X, мм').inputValue());
  assert(
    xAfterKeyboardMove < xBeforeKeyboardMove,
    'keyboard arrow did not move the selected block',
  );

  const storedDraft = await page.evaluate(() =>
    localStorage.getItem('plenki:admin:pallet-label-layout-draft:v2'),
  );
  const parsedStoredDraft = storedDraft ? JSON.parse(storedDraft) : null;
  assert(
    parsedStoredDraft?.schemaVersion === 2 &&
      parsedStoredDraft.sourceDocumentId === 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
    'versioned local draft did not retain the control source id',
  );

  const publishButton = page.getByRole('button', { name: 'Опубликовать и применить' });
  await publishButton.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const button = document.querySelector('[aria-label="Опубликовать и применить"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await publishButton.focus();
  assert(
    await publishButton.evaluate((node) => document.activeElement === node),
    'publish action does not receive keyboard focus',
  );
  await publishButton.press('Enter');
  const confirmationRegion = page.getByRole('region', {
    name: 'Подтверждение публикации макета',
  });
  await confirmationRegion.waitFor({ state: 'visible' });
  assert(
    (await page.getByRole('dialog', { name: 'Подтверждение публикации макета' }).count()) === 0,
    'inline publication confirmation falsely claims modal dialog behavior',
  );
  await page.screenshot({
    path: path.join(screenshotDir, 'confirmation-1440x900.png'),
    fullPage: true,
  });
  const reason = page.getByLabel('Причина публикации макета');
  await reason.waitFor({ state: 'visible' });
  await reason.focus();
  assert(
    await reason.evaluate((node) => document.activeElement === node),
    'publish reason does not receive keyboard focus',
  );
  await reason.fill('Согласован проверенный макет');
  await page.getByRole('button', { name: 'Подтвердить публикацию макета' }).click();
  await page.getByText('Активный макет v1').waitFor();
  await page.getByText('aaaaaaaa', { exact: true }).waitFor();
  await page.getByText(/Ранее сформированные листы не изменятся/u).waitFor();
  assert(publishBodies.length === 1, `expected one publish command, got ${publishBodies.length}`);
  const publishBody = publishBodies[0];
  assert(
    Object.keys(publishBody).sort().join(',') ===
      'expectedActivePublicationId,layout,operationKey,reason,sourceDocumentId',
    `publish command keys differ: ${Object.keys(publishBody).sort().join(',')}`,
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      publishBody.operationKey,
    ),
    `publish operation key is not UUIDv4: ${publishBody.operationKey}`,
  );
  assert(publishBody.expectedActivePublicationId === null, 'first publish did not use null CAS');
  assert(
    publishBody.sourceDocumentId === 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
    'publish source changed from the stable control source',
  );
  assert(publishBody.layout.profile === profile, 'publish did not send configurable-v7');
  assert(
    JSON.stringify(publishBody.layout) === JSON.stringify(previewBodies.at(-1).layout),
    'published geometry differs from the last exact preview',
  );

  for (const viewport of [
    { width: 1440, height: 900, name: '1440x900' },
    { width: 1366, height: 768, name: '1366x768' },
    { width: 1024, height: 768, name: '1024x768' },
    { width: 390, height: 844, name: '390x844' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert(overflow <= 1, `${viewport.name} has ${overflow}px horizontal overflow`);
    await page.screenshot({
      path: path.join(screenshotDir, `${viewport.name}.png`),
      fullPage: true,
    });
    for (const control of [
      page.getByLabel('Источник данных для предпросмотра'),
      page.getByRole('button', { name: 'Скачать JSON' }),
      publishButton,
      fontInput,
    ]) {
      await control.scrollIntoViewIfNeeded();
      assert(await control.isVisible(), `${viewport.name} cannot reach a required editor control`);
    }
  }

  assert(
    (await page.evaluate(() => window.__palletLayoutPrintCalls)) === 0,
    'admin publication invoked window.print()',
  );
  const forbiddenRequests = adminRequests.filter((entry) =>
    /\/warehouse\/pallet-lists\/.+\/print|\/printers|\/devices|\/gateway|\/onec/iu.test(entry),
  );
  assert(
    forbiddenRequests.length === 0,
    `admin publication called forbidden integrations: ${forbiddenRequests.join(' | ')}`,
  );

  ownedVite.assertAlive('pallet label layout editor');
  assertSmokeHealthy(tracker, await collectVisibleErrors(page), 'pallet label layout editor');
  await context.close();
  console.log(
    'OK pallet label layout publication smoke: edit -> preview -> publish at 1440, 1366, 1024, 390',
  );
} finally {
  if (browser) await browser.close();
  ownedVite?.server.kill('SIGTERM');
}
