import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

async function availableNonDefaultPort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          reject(new Error('Could not allocate a phase3 smoke port'));
          return;
        }
        server.close((error) => {
          if (error) reject(error);
          else resolve(address.port);
        });
      });
    });
    if (port !== 5193) return port;
  }
}

it('owns a unique fixture Vite port and keeps CI enabled for its child', async () => {
  const probeDirectory = await mkdtemp(path.join(tmpdir(), 'phase3-vite-env-'));
  const probePath = path.join(probeDirectory, 'require-child-ci.mjs');
  const port = await availableNonDefaultPort();
  const artifactDirectory = path.resolve(
    'qa-screenshots/phase3-demo-2026-06-11',
    'runs',
    `port-${port}`,
  );
  const reportPath = path.join(artifactDirectory, 'phase3-demo-smoke-report.json');
  await writeFile(
    probePath,
    [
      "const entry = process.argv[1] ?? '';",
      'const isViteCli = /[/\\\\](?:\\.bin[/\\\\]vite|vite[/\\\\]bin[/\\\\]vite\\.js)$/u.test(entry);',
      "if (isViteCli && process.env.CI !== 'true') {",
      "  process.stderr.write('fixture Vite child is missing CI=true\\\\n');",
      '  process.exit(86);',
      '}',
      'if (isViteCli) {',
      "  const portIndex = process.argv.indexOf('--port');",
      '  const actualPort = portIndex === -1 ? undefined : process.argv[portIndex + 1];',
      '  if (actualPort !== process.env.PHASE3_DEMO_SMOKE_PORT) {',
      '    process.stderr.write(`fixture Vite child ignored caller port: ${actualPort}\\\\n`);',
      '    process.exit(87);',
      '  }',
      '}',
    ].join('\n'),
    'utf8',
  );

  try {
    const env = {
      ...process.env,
      PHASE3_DEMO_SMOKE_PORT: String(port),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(probePath).href}`]
        .filter(Boolean)
        .join(' '),
    };
    delete env.CI;

    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('scripts/phase3-demo-smoke.mjs')], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output: string[] = [];

      child.stdout.on('data', (chunk) => output.push(String(chunk)));
      child.stderr.on('data', (chunk) => output.push(String(chunk)));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({ code, signal, output: output.join('') });
      });
    });

    expect(result, result.output).toMatchObject({ code: 0, signal: null });
    expect(result.output).toContain('Phase 3 demo smoke passed.');
    expect(result.output).toContain(reportPath);
    await access(reportPath);
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
    await rm(probeDirectory, { recursive: true, force: true });
  }
  // Parent orchestration covers a fresh Vite process plus all six browser scenarios;
  // the child keeps its exact per-assertion UI timeouts unchanged.
}, 60_000);
