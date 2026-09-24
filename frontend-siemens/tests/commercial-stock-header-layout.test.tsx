import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

import { CommercialWorkspace } from '../src/features/commercial/CommercialWorkspace';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
] as const;
// A cold Vite transform shares CPU with the full Vitest suite; the geometry assertions remain
// deterministic, but the former 15 s deadline only covered an isolated run reliably.
const FULL_SUITE_BROWSER_TIMEOUT_MS = 30_000;

describe('commercial stock action header layout', () => {
  let browser: Browser;
  let page: Page;
  let server: ViteDevServer;
  let serverUrl: string;

  beforeAll(async () => {
    server = await createServer({
      root: process.cwd(),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Vite did not expose a local test port.');
    }
    serverUrl = `http://127.0.0.1:${address.port}/`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it.each(VIEWPORTS)(
    'keeps the queue heading and both create actions visible at $width px',
    async ({ width, height }) => {
      const workspace = renderToStaticMarkup(
        <CommercialWorkspace
          activeSection="Входящие заявки"
          selectedOrderId={null}
          onChangeSection={() => undefined}
          onSelectOrder={() => undefined}
        />,
      );

      await page.setViewportSize({ width, height });
      await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.styleSheets.length >= 2);
      await page.evaluate((markup) => {
        document.body.innerHTML = `<main class="app-shell" data-active-role="commercial"
          style="display:block;width:min(340px,calc(100vw - 32px))">${markup}</main>`;
      }, workspace);

      const geometry = await page
        .locator('.commercial-live-list-panel > .panel-header')
        .evaluate((header) => {
          const heading = header.querySelector('h1');
          const title = header.firstElementChild;
          const actions = header.querySelector('.commercial-live-create-actions');
          const buttons = [...(actions?.querySelectorAll('button') ?? [])];
          if (!heading || !title || !actions || buttons.length !== 2) {
            throw new Error('Commercial queue header is incomplete.');
          }
          const headerRect = header.getBoundingClientRect();
          const headingRect = heading.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          const actionRect = actions.getBoundingClientRect();
          const buttonRects = buttons.map((button) => button.getBoundingClientRect());

          return {
            headingWidth: headingRect.width,
            headingHeight: headingRect.height,
            titleWidth: titleRect.width,
            titleBottom: titleRect.bottom,
            actionTop: actionRect.top,
            actionWidth: actionRect.width,
            buttonWidths: buttonRects.map((rect) => rect.width),
            buttonTops: buttonRects.map((rect) => rect.top),
            buttonsWithinHeader: buttonRects.every(
              (rect) => rect.left >= headerRect.left && rect.right <= headerRect.right + 1,
            ),
            horizontalOverflow: header.scrollWidth - header.clientWidth,
          };
        });

      expect(geometry.headingWidth).toBeGreaterThan(0);
      expect(geometry.headingHeight).toBeGreaterThan(0);
      expect(geometry.titleWidth).toBeGreaterThan(0);
      expect(geometry.actionTop).toBeGreaterThanOrEqual(geometry.titleBottom);
      expect(geometry.actionWidth).toBeGreaterThan(0);
      expect(geometry.buttonWidths.every((buttonWidth) => buttonWidth > 0)).toBe(true);
      expect(new Set(geometry.buttonTops).size).toBe(1);
      expect(geometry.buttonsWithinHeader).toBe(true);
      expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
    },
    FULL_SUITE_BROWSER_TIMEOUT_MS,
  );
});
