import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const port = 5194;
const baseUrl = `http://127.0.0.1:${port}`;
const reportDir = path.resolve('qa-screenshots/button-contrast-2026-06-14');
const reportPath = path.join(reportDir, 'button-contrast-report.json');
const viteBin = path.resolve('node_modules/.bin/vite');
const minContrast = 4.5;

const roles = ['commercial', 'production', 'finance', 'director', 'operator', 'warehouse', 'admin'];
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function waitForServer(server, serverLogs) {
  const deadline = Date.now() + 25_000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (server.exitCode !== null || server.signalCode !== null) {
        reject(new Error(`Vite preview server exited before it was ready.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }

      try {
        const response = await fetch(`${baseUrl}/?role=operator`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch {
        // Retry until reachable.
      }

      if (Date.now() > deadline) {
        reject(new Error(`Vite preview server did not start in time.\n${serverLogs.join('\n').slice(-2000)}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function collectButtonSamples(page, role, viewportName, state, targetIndex = null) {
  return page.evaluate(
    ({ role, viewportName, minContrast, state, targetIndex }) => {
      function parseColor(value) {
        const match = String(value).match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const raw = match[1].replace(/\s*\/\s*/, ', ').split(/,\s*|\s+/).filter(Boolean);
        const [r, g, b] = raw.map((part) => Number.parseFloat(part));
        const a = Number.parseFloat(raw[3] ?? '1');
        if (![r, g, b].every(Number.isFinite)) return null;
        return { r, g, b, a: Number.isFinite(a) ? a : 1 };
      }

      function blend(top, bottom) {
        const a = top.a + bottom.a * (1 - top.a);
        if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
        return {
          r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
          g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
          b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
          a,
        };
      }

      function effectiveBackground(element) {
        const chain = [];
        let node = element;
        while (node && node instanceof HTMLElement) {
          chain.push(node);
          node = node.parentElement;
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (const item of chain.reverse()) {
          const color = parseColor(getComputedStyle(item).backgroundColor);
          if (color && color.a > 0) out = blend(color, out);
        }
        return out;
      }

      function rel(color) {
        const channels = [color.r, color.g, color.b].map((part) => {
          const value = part / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }

      function ratio(fg, bg) {
        const a = rel(fg);
        const b = rel(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      function labelFor(button) {
        return (
          button.innerText ||
          button.getAttribute('aria-label') ||
          button.getAttribute('title') ||
          button.className ||
          button.tagName
        )
          .toString()
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 110);
      }

      function sampleText(button) {
        const textTargets = Array.from(button.querySelectorAll('span, strong, small, b, em')).filter(
          (node) => isVisible(node) && node.textContent?.trim()
        );
        const targets = textTargets.length > 0 ? textTargets : button.textContent?.trim() ? [button] : [];
        return targets.map((target) => {
          const style = getComputedStyle(target);
          const fg = parseColor(style.color);
          const bg = effectiveBackground(target);
          const contrast = fg && bg ? ratio(fg, bg) : 0;
          return {
            text: String(target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            color: style.color,
            background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
            contrast: Number(contrast.toFixed(2)),
            ok: contrast >= minContrast,
          };
        });
      }

      function cssVar(scope, name) {
        return getComputedStyle(scope).getPropertyValue(name).trim();
      }

      function colorFromVar(scope, name) {
        const probe = document.createElement('div');
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        probe.style.width = '1px';
        probe.style.height = '1px';
        probe.style.color = `var(${name})`;
        probe.style.backgroundColor = `var(${name})`;
        scope.appendChild(probe);
        const style = getComputedStyle(probe);
        const color = parseColor(style.color) || parseColor(style.backgroundColor);
        probe.remove();
        return color;
      }

      const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);
      const sampleButtons = targetIndex === null ? buttons : buttons[targetIndex] ? [buttons[targetIndex]] : [];
      const buttonSamples = buttons.flatMap((button, index) =>
        targetIndex !== null && index !== targetIndex ? [] : sampleText(button).map((sample) => ({
          type: 'visible-button',
          state,
          role,
          viewport: viewportName,
          index,
          label: labelFor(button),
          className: String(button.getAttribute('class') ?? ''),
          disabled: button.disabled || button.classList.contains('is-disabled') || button.getAttribute('aria-disabled') === 'true',
          ...sample,
        }))
      );

      return {
        role,
        viewport: viewportName,
        buttonCount: buttons.length,
        samples: sampleButtons.length > 0 || targetIndex === null ? buttonSamples : [],
      };
    },
    { role, viewportName, minContrast, state, targetIndex }
  );
}

async function collectTokenSamples(page, role, viewportName) {
  return page.evaluate(
    ({ role, viewportName, minContrast }) => {
      function parseColor(value) {
        const match = String(value).match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const raw = match[1].replace(/\s*\/\s*/, ', ').split(/,\s*|\s+/).filter(Boolean);
        const [r, g, b] = raw.map((part) => Number.parseFloat(part));
        const a = Number.parseFloat(raw[3] ?? '1');
        if (![r, g, b].every(Number.isFinite)) return null;
        return { r, g, b, a: Number.isFinite(a) ? a : 1 };
      }

      function rel(color) {
        const channels = [color.r, color.g, color.b].map((part) => {
          const value = part / 255;
          return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      }

      function ratio(fg, bg) {
        const a = rel(fg);
        const b = rel(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }

      function cssVar(scope, name) {
        return getComputedStyle(scope).getPropertyValue(name).trim();
      }

      function colorFromVar(scope, name) {
        const probe = document.createElement('div');
        probe.style.position = 'fixed';
        probe.style.left = '-9999px';
        probe.style.width = '1px';
        probe.style.height = '1px';
        probe.style.color = `var(${name})`;
        probe.style.backgroundColor = `var(${name})`;
        scope.appendChild(probe);
        const style = getComputedStyle(probe);
        const color = parseColor(style.color) || parseColor(style.backgroundColor);
        probe.remove();
        return color;
      }

      const tokenScopes = [
        { name: 'dark-root', element: document.documentElement },
        { name: 'commercial-light', element: document.querySelector('.commercial-workbench') },
      ].filter((entry) => entry.element);
      const tokenRows = [];
      const variants = [
        ['recommended', '--action-recommended-bg', '--action-recommended-text', '--action-recommended-hover-bg', '--action-recommended-active-bg'],
        ['peer', '--action-peer-bg', '--action-peer-text', '--action-peer-hover-bg', '--action-peer-active-bg'],
        ['secondary', '--action-secondary-bg', '--action-secondary-text', '--action-secondary-hover-bg', '--action-secondary-active-bg'],
        ['destructive', '--action-destructive-bg', '--action-destructive-text', '--action-destructive-hover-bg', '--action-destructive-active-bg'],
        ['disabled', '--action-disabled-bg', '--action-disabled-text', '--action-disabled-bg', '--action-disabled-bg'],
      ];

      for (const scope of tokenScopes) {
        for (const [variant, bgVar, textVar, hoverVar, activeVar] of variants) {
          const text = colorFromVar(scope.element, textVar);
          for (const [state, stateVar] of [
            ['normal', bgVar],
            ['hover', hoverVar],
            ['active', activeVar],
          ]) {
            const bg = colorFromVar(scope.element, stateVar);
            const contrast = text && bg ? ratio(text, bg) : 0;
            tokenRows.push({
              type: 'token-state',
              role,
              viewport: viewportName,
              scope: scope.name,
              variant,
              state,
              text: `${variant}/${state}`,
              rawText: cssVar(scope.element, textVar),
              rawBackground: cssVar(scope.element, stateVar),
              contrast: Number(contrast.toFixed(2)),
              ok: contrast >= minContrast,
            });
          }
        }
      }

      return {
        role,
        viewport: viewportName,
        buttonCount: 0,
        samples: tokenRows,
      };
    },
    { role, viewportName, minContrast }
  );
}

async function collectContrast(page, role, viewportName) {
  const normal = await collectButtonSamples(page, role, viewportName, 'normal');
  const samples = [...normal.samples];

  for (let index = 0; index < normal.buttonCount; index += 1) {
    const locator = page.locator('button').nth(index);
    try {
      if (!(await locator.isVisible())) continue;
      await locator.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await locator.hover({ timeout: 1500, force: true });
      await page.waitForTimeout(10);
      samples.push(...(await collectButtonSamples(page, role, viewportName, 'hover', index)).samples);

      const box = await locator.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(10);
        samples.push(...(await collectButtonSamples(page, role, viewportName, 'active', index)).samples);
        await page.mouse.move(0, 0);
        await page.mouse.up();
      }
    } catch (error) {
      samples.push({
        type: 'interaction-skipped',
        state: 'hover-active',
        role,
        viewport: viewportName,
        index,
        text: String(error).slice(0, 160),
        contrast: minContrast,
        ok: true,
      });
    }
  }

  const tokens = await collectTokenSamples(page, role, viewportName);
  return {
    role,
    viewport: viewportName,
    buttonCount: normal.buttonCount,
    samples: [...samples, ...tokens.samples],
  };
}

async function waitForAuditableUi(page, role, viewportName) {
  try {
    await page.waitForFunction(
      () => {
        const root = document.querySelector('#root');
        const rootStyle = getComputedStyle(document.documentElement);
        return Boolean(
          root?.children.length &&
          document.querySelector('button') &&
          rootStyle.getPropertyValue('--action-recommended-bg').trim() &&
          rootStyle.getPropertyValue('--action-recommended-text').trim()
        );
      },
      undefined,
      { timeout: 8_000 }
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      bodyText: document.body.innerText.trim().slice(0, 300),
      buttonCount: document.querySelectorAll('button').length,
      rootChildCount: document.querySelector('#root')?.children.length ?? 0,
      actionRecommendedBg: getComputedStyle(document.documentElement).getPropertyValue('--action-recommended-bg').trim(),
      actionRecommendedText: getComputedStyle(document.documentElement).getPropertyValue('--action-recommended-text').trim(),
    }));
    throw new Error(
      `Button contrast audit could not reach ready UI for ${role}/${viewportName}: ${JSON.stringify(diagnostics)}\n${error}`
    );
  }
}

await mkdir(reportDir, { recursive: true });

const serverLogs = [];
const server = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

server.stdout.on('data', (chunk) => serverLogs.push(String(chunk)));
server.stderr.on('data', (chunk) => serverLogs.push(String(chunk)));

let browser;
const results = [];

try {
  await waitForServer(server, serverLogs);
  browser = await chromium.launch();

  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport });
    for (const role of roles) {
      await page.goto(`${baseUrl}/?role=${role}`, { waitUntil: 'domcontentloaded' });
      await waitForAuditableUi(page, role, viewport.name);
      results.push(await collectContrast(page, role, viewport.name));
    }
    await page.close();
  }

  const failures = results.flatMap((result) => result.samples.filter((sample) => !sample.ok));
  const report = {
    baseUrl,
    minContrast,
    roles,
    viewports,
    failureCount: failures.length,
    failures: failures.slice(0, 80),
    results,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    console.error(`Button contrast audit failed: ${failures.length} samples below ${minContrast}:1`);
    for (const failure of failures.slice(0, 16)) {
      console.error(
        `- ${failure.role}/${failure.viewport}/${failure.type}${failure.state ? `/${failure.state}` : ''}: ${failure.contrast}:1 "${failure.text || failure.label}" on ${failure.background ?? failure.rawBackground}`
      );
    }
    process.exitCode = 1;
  } else {
    const buttonCount = results.reduce((sum, item) => sum + item.buttonCount, 0);
    const sampleCount = results.reduce((sum, item) => sum + item.samples.length, 0);
    console.log(`Button contrast audit passed: ${buttonCount} visible buttons and ${sampleCount} text/state samples checked.`);
    console.log(`Report: ${reportPath}`);
  }
} finally {
  await browser?.close();
  server.kill();
}
