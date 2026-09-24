import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { visualNoisePrimarySelectors } from './visual-noise-audit-support.mjs';

const port = 5227;
const baseUrl = `http://127.0.0.1:${port}`;
const viteBin = path.resolve('node_modules/.bin/vite');
const reportDir = path.resolve('qa-screenshots/visual-noise-reset-2026-07-02');
const reportPath = path.join(reportDir, 'visual-noise-report.json');

const viewports = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];

const routes = [
  { role: 'commercial', section: '' },
  { role: 'commercial', section: 'Входящие заявки' },
  { role: 'commercial', section: 'В работе' },
  { role: 'production', section: '' },
  { role: 'production', section: 'Операторы / загрузка' },
  { role: 'production', section: 'Контрагенты и шаблоны' },
  { role: 'finance', section: '' },
  { role: 'director', section: '' },
  { role: 'director', section: 'Контроль' },
  { role: 'director', section: 'Финансы' },
  { role: 'director', section: 'Производство' },
  { role: 'director', section: 'Склад' },
  { role: 'director', section: 'Штрафы' },
  { role: 'director', section: 'Аудит / QR' },
  { role: 'operator', section: '' },
  { role: 'warehouse', section: '' },
  { role: 'warehouse', section: 'Все рулоны' },
  { role: 'warehouse', section: 'Сырье' },
  { role: 'admin', section: '' },
  { role: 'admin', section: 'Доступы' },
  { role: 'admin', section: 'Устройства' },
];

const hardLimits = {
  maxOverflow: 0,
  maxJunk: 48,
  maxChipLike: 24,
  maxCardLike: 42,
  maxTinyText: 190,
  maxGradient: 8,
  maxNoiseScore: 285,
};

const forbiddenVisibleTerms = [
  'mock',
  'adapter',
  'payload',
  'contract-only',
  'prototype/mock',
  'backend RBAC',
  'source_error',
  'raw enum',
  'internal enum',
  'AuditEvent',
  'OperationalEvent',
  'WarehouseCoverProposal',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function score(metrics) {
  return (
    metrics.junk * 2 +
    metrics.chipLike * 2 +
    metrics.cardLike +
    metrics.borderCount / 6 +
    metrics.shadowCount / 4 +
    metrics.gradientCount +
    metrics.tinyText / 2 +
    metrics.overflowCount * 4
  );
}

async function waitForServer(server, logs) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Vite preview exited before ready.\n${logs.join('\n').slice(-2000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/?role=commercial`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`Vite preview did not start in time.\n${logs.join('\n').slice(-2000)}`);
}

async function openRoute(page, route, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${baseUrl}/?role=${route.role}`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 7_000 });
  await page.waitForTimeout(250);

  if (route.section) {
    const candidates = page
      .locator('.section-nav-button, .role-top-nav-item, .mobile-section-nav-item')
      .filter({ hasText: route.section });
    let opened = false;

    for (let index = 0; index < (await candidates.count()); index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible()) {
        await candidate.click({ timeout: 2_000 });
        opened = true;
        break;
      }
    }

    if (!opened) {
      const moreButton = page.locator('button[aria-label^="Еще разделы:"]:visible').first();
      if (await moreButton.count()) {
        await moreButton.click({ timeout: 2_000 });
        const drawerButton = page
          .locator('.mobile-nav-drawer-item:visible')
          .filter({ hasText: route.section })
          .first();
        if (await drawerButton.count()) {
          await drawerButton.click({ timeout: 2_000 });
          opened = true;
        }
      }
    }

    if (!opened) {
      throw new Error(`Section "${route.section}" is not reachable for role "${route.role}"`);
    }
    await page.waitForTimeout(250);
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  });
}

async function collectMetrics(page, route) {
  return page.evaluate(
    ({ currentRole, primarySelectors, forbiddenTerms }) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const examples = [];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 2 &&
          rect.height > 2 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < viewportHeight &&
          rect.left < viewportWidth &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        );
      }

      function isInsideHorizontalScroller(element) {
        let current = element.parentElement;
        while (current && current !== document.body) {
          const style = window.getComputedStyle(current);
          if (
            ['auto', 'scroll'].includes(style.overflowX) &&
            current.scrollWidth > current.clientWidth + 1
          ) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      }

      const visibleElements = Array.from(document.body.querySelectorAll('*')).filter(isVisible);
      let junk = 0;
      let chipLike = 0;
      let cardLike = 0;
      let borderCount = 0;
      let shadowCount = 0;
      let gradientCount = 0;
      let tinyText = 0;
      let overflowCount = 0;

      for (const element of visibleElements) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const className = typeof element.className === 'string' ? element.className : '';
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();

        if (
          (rect.left < -2 || rect.right > viewportWidth + 2) &&
          !isInsideHorizontalScroller(element)
        ) {
          overflowCount += 1;
        }

        if (text && Number.parseFloat(style.fontSize) < 13) {
          tinyText += 1;
        }

        if (
          (Number.parseFloat(style.borderTopWidth) > 0 ||
            Number.parseFloat(style.borderLeftWidth) > 0) &&
          style.borderTopStyle !== 'none'
        ) {
          borderCount += 1;
        }

        if (style.boxShadow && style.boxShadow !== 'none') {
          shadowCount += 1;
        }

        if ((style.backgroundImage || '').includes('gradient')) {
          gradientCount += 1;
        }

        const hasJunkClass = /(overview|summary|metric|kpi|tile|chip|pill|badge|tag|card)/i.test(
          className,
        );
        if (hasJunkClass) {
          junk += 1;
          if (examples.length < 8) {
            examples.push({
              className: className.split(/\s+/).slice(0, 4).join('.'),
              text: text.slice(0, 90),
            });
          }
        }
        if (/(chip|pill|badge|tag)/i.test(className)) chipLike += 1;
        if (/(card|tile|panel|surface)/i.test(className)) cardLike += 1;
      }

      const bodyAndAttributes = [
        document.body.innerText,
        ...Array.from(document.querySelectorAll('[title], [aria-label]')).map((element) =>
          [element.getAttribute('title'), element.getAttribute('aria-label')]
            .filter(Boolean)
            .join('\n'),
        ),
      ]
        .join('\n')
        .toLowerCase();

      const forbiddenHits = forbiddenTerms.filter((term) =>
        bodyAndAttributes.includes(term.toLowerCase()),
      );
      const primaryVisible = (primarySelectors[currentRole] ?? []).some((selector) => {
        const candidate = document.querySelector(selector);
        return candidate ? isVisible(candidate) : false;
      });

      return {
        visibleCount: visibleElements.length,
        junk,
        chipLike,
        cardLike,
        borderCount,
        shadowCount,
        gradientCount,
        tinyText,
        overflowCount,
        forbiddenHits,
        primaryVisible,
        examples,
        title: (document.querySelector('h1,h2')?.textContent ?? '').trim(),
      };
    },
    {
      currentRole: route.role,
      primarySelectors: visualNoisePrimarySelectors,
      forbiddenTerms: forbiddenVisibleTerms,
    },
  );
}

const server = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    VITE_LIVE_CONTOURS: '',
    VITE_REQUIRE_AUTH: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const logs = [];
server.stdout.on('data', (chunk) => logs.push(String(chunk)));
server.stderr.on('data', (chunk) => logs.push(String(chunk)));

const report = {
  baseUrl,
  generatedAt: new Date().toISOString(),
  hardLimits,
  routes: [],
  failures: [],
};

try {
  await waitForServer(server, logs);
  await mkdir(reportDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  for (const viewport of viewports) {
    for (const route of routes) {
      await openRoute(page, route, viewport);
      const metrics = await collectMetrics(page, route);
      const noiseScore = Number(score(metrics).toFixed(1));
      const entry = {
        viewport: viewport.name,
        ...route,
        section: route.section || '(default)',
        noiseScore,
        ...metrics,
      };
      report.routes.push(entry);

      if (metrics.overflowCount > hardLimits.maxOverflow) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: overflow ${metrics.overflowCount}`,
        );
      }
      if (metrics.junk > hardLimits.maxJunk) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: junk ${metrics.junk}`,
        );
      }
      if (metrics.chipLike > hardLimits.maxChipLike) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: chip-like ${metrics.chipLike}`,
        );
      }
      if (metrics.cardLike > hardLimits.maxCardLike) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: card-like ${metrics.cardLike}`,
        );
      }
      if (metrics.tinyText > hardLimits.maxTinyText) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: tiny text ${metrics.tinyText}`,
        );
      }
      if (metrics.gradientCount > hardLimits.maxGradient) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: gradients ${metrics.gradientCount}`,
        );
      }
      if (noiseScore > hardLimits.maxNoiseScore) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: noise score ${noiseScore}`,
        );
      }
      if (metrics.forbiddenHits.length > 0) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: forbidden terms ${metrics.forbiddenHits.join(', ')}`,
        );
      }
      if (!metrics.primaryVisible) {
        report.failures.push(
          `${viewport.name} ${route.role}/${entry.section}: no first-viewport primary surface`,
        );
      }
    }
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}

report.summary = {
  checked: report.routes.length,
  worstScore: Math.max(...report.routes.map((item) => item.noiseScore)),
  worstJunk: Math.max(...report.routes.map((item) => item.junk)),
  worstChipLike: Math.max(...report.routes.map((item) => item.chipLike)),
  worstCardLike: Math.max(...report.routes.map((item) => item.cardLike)),
  worstTinyText: Math.max(...report.routes.map((item) => item.tinyText)),
  worstOverflow: Math.max(...report.routes.map((item) => item.overflowCount)),
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log('Visual noise audit');
console.log(`- checked routes: ${report.summary.checked}`);
console.log(`- worst score: ${report.summary.worstScore}/${hardLimits.maxNoiseScore}`);
console.log(
  `- worst junk/chip/card: ${report.summary.worstJunk}/${report.summary.worstChipLike}/${report.summary.worstCardLike}`,
);
console.log(`- worst tiny text: ${report.summary.worstTinyText}/${hardLimits.maxTinyText}`);
console.log(`- worst overflow: ${report.summary.worstOverflow}/${hardLimits.maxOverflow}`);
console.log(`- report: ${path.relative(process.cwd(), reportPath)}`);

if (report.failures.length > 0) {
  console.error('\nVisual noise audit failed:');
  for (const failure of report.failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}
