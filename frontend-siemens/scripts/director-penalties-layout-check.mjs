import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const port = 4193;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = resolve(
  process.env.DIRECTOR_PENALTIES_QA_OUTPUT ?? '/tmp/plenka-director-penalties-qa',
);
const server = spawn(
  'npm',
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

try {
  await waitForServer(baseUrl);
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const cases = [
      { name: '1440x900', width: 1440, height: 900 },
      { name: '1366x768', width: 1366, height: 768 },
      { name: '390x844', width: 390, height: 844 },
    ];
    for (const viewport of cases) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      await page.goto(`${baseUrl}/qa/director-penalties.html`, { waitUntil: 'networkidle' });
      await page.locator('.penalty-workbench.has-drawer').waitFor();

      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            columns: getComputedStyle(element).gridTemplateColumns,
          };
        };
        const scrollRegion = document.querySelector('.penalty-workbench .director-table-wrap');
        if (!(scrollRegion instanceof HTMLElement)) throw new Error('Missing penalty journal');
        return {
          documentOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          drawer: box('.penalty-workbench .director-drawer'),
          assign: box('.penalty-workbench .penalty-assign-command'),
          journal: box('.penalty-workbench .director-table-wrap'),
          id: box('.penalty-detail-id'),
          mobileLabels: [...document.querySelectorAll('[data-penalty-row] td')].map((cell) =>
            cell.getAttribute('data-label'),
          ),
          scrollRegion: {
            tabIndex: scrollRegion.tabIndex,
            overflowX: getComputedStyle(scrollRegion).overflowX,
          },
        };
      });

      const prefix = `${viewport.name}:`;
      assert(
        layout.documentOverflow <= 1,
        `${prefix} page overflows by ${layout.documentOverflow}px`,
      );
      assert(
        layout.drawer.scrollWidth <= layout.drawer.clientWidth + 1,
        `${prefix} detail drawer overflows by ${layout.drawer.scrollWidth - layout.drawer.clientWidth}px`,
      );
      assert(
        layout.assign.scrollWidth <= layout.assign.clientWidth + 1,
        `${prefix} assignment card overflows by ${layout.assign.scrollWidth - layout.assign.clientWidth}px`,
      );
      assert(
        layout.journal.bottom + 8 <= layout.assign.top,
        `${prefix} assignment card overlaps the journal by ${layout.journal.bottom - layout.assign.top}px`,
      );
      assert(
        layout.id.right <= layout.drawer.right + 1,
        `${prefix} penalty ID escapes the drawer by ${layout.id.right - layout.drawer.right}px`,
      );
      assert(layout.scrollRegion.tabIndex === 0, `${prefix} journal is not keyboard-scrollable`);

      if (viewport.width === 1440) {
        assert(
          layout.scrollRegion.overflowX === 'auto',
          `${prefix} journal has no horizontal scrolling`,
        );
        assert(
          layout.journal.scrollWidth > layout.journal.clientWidth,
          `${prefix} test fixture does not exercise horizontal overflow`,
        );
        const scrollResult = await page
          .locator('.penalty-workbench .director-table-wrap')
          .evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
            return { left: element.scrollLeft, max: element.scrollWidth - element.clientWidth };
          });
        assert(
          scrollResult.left === scrollResult.max && scrollResult.max > 0,
          `${prefix} journal did not scroll to the reason column`,
        );
      }

      if (viewport.width === 390) {
        assert(
          layout.assign.columns.trim().split(/\s+/u).length === 1,
          `${prefix} assignment facts are squeezed into multiple columns`,
        );
        assert(
          layout.mobileLabels.every(Boolean),
          `${prefix} penalty cards are missing column labels`,
        );
      }

      await page.screenshot({
        path: resolve(outputDir, `director-penalties-${viewport.name}.png`),
        fullPage: true,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`Director penalties layout passed: ${outputDir}\n`);
} finally {
  server.kill('SIGTERM');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited before QA started:\n${serverLog}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Vite:\n${serverLog}`);
}
