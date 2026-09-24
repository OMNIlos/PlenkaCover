import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const port = 4187;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = resolve(
  process.env.COMMERCIAL_PIPELINE_QA_OUTPUT ?? '/tmp/plenka-commercial-pipeline-qa',
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
  await waitForServer(`${baseUrl}/qa/commercial-pipeline.html`);
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const cases = [
      { name: '1366x768', width: 1366, height: 768, zoom: 1 },
      { name: '1024x768', width: 1024, height: 768, zoom: 1 },
      { name: '1024x768-125pct', width: 1024, height: 768, zoom: 1.25 },
      { name: '390x844', width: 390, height: 844, zoom: 1 },
    ];
    for (const viewport of cases) {
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
      });
      await page.goto(`${baseUrl}/qa/commercial-pipeline.html`, {
        waitUntil: 'networkidle',
      });
      if (viewport.zoom !== 1) {
        await page.evaluate((zoom) => {
          document.documentElement.style.zoom = String(zoom);
        }, viewport.zoom);
      }
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        overview: [...document.querySelectorAll('.commercial-order-overview')].map(
          (element) => element.scrollWidth - element.clientWidth,
        ),
        pipeline: [...document.querySelectorAll('.commercial-pipeline')].map(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      }));
      if (
        overflow.document > 1 ||
        overflow.overview.some((value) => value > 1) ||
        overflow.pipeline.some((value) => value > 1)
      ) {
        throw new Error(`${viewport.name}: horizontal overflow ${JSON.stringify(overflow)}`);
      }
      await page.screenshot({
        path: resolve(outputDir, `${viewport.name}.png`),
        fullPage: true,
      });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`Commercial pipeline viewports passed: ${outputDir}\n`);
} finally {
  server.kill('SIGTERM');
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
