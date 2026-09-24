import { spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const distDirectory = path.resolve('dist');
const assetsDirectory = path.join(distDirectory, 'assets');
const indexPath = path.join(distDirectory, 'index.html');
const evidenceDirectory = await mkdtemp(
  path.join(tmpdir(), 'plenka-bundle-freshness-'),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseModuleEntry(indexHtml) {
  const scriptTags = indexHtml.match(/<script\b[^>]*>/giu) ?? [];
  const moduleEntries = scriptTags
    .filter((tag) => /\btype\s*=\s*(['"])module\1/iu.test(tag))
    .map((tag) => /\bsrc\s*=\s*(['"])([^'"]+)\1/iu.exec(tag)?.[2])
    .filter(Boolean);
  assert(
    moduleEntries.length === 1,
    `Expected one production module entry, found ${moduleEntries.length}.`,
  );
  const entry = new URL(moduleEntries[0], 'http://bundle.local');
  assert(entry.origin === 'http://bundle.local', 'Module entry must be same-origin.');
  assert(
    entry.pathname.startsWith('/assets/'),
    `Module entry is outside /assets: ${entry.pathname}`,
  );
  assert(!entry.search && !entry.hash, 'Module entry must be an exact hashed asset URL.');
  return entry.pathname;
}

function resolveAssetPath(assetUrl) {
  assert(assetUrl.startsWith('/assets/'), `Not an asset URL: ${assetUrl}`);
  const decodedPath = decodeURIComponent(assetUrl);
  const resolved = path.resolve(distDirectory, `.${decodedPath}`);
  assert(
    resolved.startsWith(`${assetsDirectory}${path.sep}`),
    `Asset escaped dist/assets: ${assetUrl}`,
  );
  return resolved;
}

async function readExistingEntry() {
  try {
    return parseModuleEntry(await readFile(indexPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function signalProcessTree(child, signal) {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

async function runBuild() {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawn(npmBin, ['run', 'build'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  const record = (chunk, destination) => {
    const text = String(chunk);
    output.push(text);
    if (output.length > 160) output.shift();
    destination.write(text);
  };
  child.stdout.on('data', (chunk) => record(chunk, process.stdout));
  child.stderr.on('data', (chunk) => record(chunk, process.stderr));

  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const waitBounded = async (milliseconds) => {
    let timeout;
    try {
      return await Promise.race([
        exitPromise,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve(null), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    let result = await waitBounded(180_000);
    if (!result) {
      signalProcessTree(child, 'SIGTERM');
      result = await waitBounded(2_500);
      if (!result) {
        signalProcessTree(child, 'SIGKILL');
        result = await waitBounded(2_500);
      }
      assert(result, 'Timed-out production build did not exit after SIGKILL.');
      throw new Error(
        `Production build exceeded the 180s deadline and was terminated.\n` +
          output.join('').slice(-6_000),
      );
    }
    assert(
      result.code === 0,
      `Production build failed (${result.code ?? result.signal}).\n` +
        output.join('').slice(-6_000),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      signalProcessTree(child, 'SIGTERM');
      let result = await waitBounded(2_500);
      if (!result) {
        signalProcessTree(child, 'SIGKILL');
        result = await waitBounded(2_500);
      }
      assert(result, 'Production build process could not be cleaned up.');
    }
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function syntheticAbsentEntry(currentEntry) {
  const filename = path.posix.basename(currentEntry);
  const extension = path.posix.extname(filename);
  const stem = filename.slice(0, -extension.length);
  const prefix = stem.includes('-') ? stem.slice(0, stem.indexOf('-')) : 'index';
  return `/assets/${prefix}-${randomUUID().replaceAll('-', '').slice(0, 8)}${extension}`;
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.svg':
      return 'image/svg+xml';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

async function sendFile(response, filePath, method) {
  const fileStat = await stat(filePath);
  assert(fileStat.isFile(), `Static target is not a file: ${filePath}`);
  const body = await readFile(filePath);
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': contentType(filePath),
  });
  response.end(method === 'HEAD' ? undefined : body);
}

function startStrictStaticServer() {
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        response.writeHead(405, {
          allow: 'GET, HEAD',
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('Method Not Allowed');
        return;
      }
      const rawUrl = request.url ?? '/';
      let rawPathname;
      try {
        rawPathname = decodeURIComponent(rawUrl.split(/[?#]/u, 1)[0]);
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Bad Request');
        return;
      }
      if (rawPathname.split('/').includes('..')) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Bad Request');
        return;
      }
      const requestUrl = new URL(rawUrl, 'http://bundle.local');
      let pathname;
      try {
        pathname = decodeURIComponent(requestUrl.pathname);
      } catch {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Bad Request');
        return;
      }

      if (pathname.startsWith('/assets/')) {
        const assetPath = resolveAssetPath(pathname);
        if (!(await fileExists(assetPath))) {
          response.writeHead(404, {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
          });
          response.end('Asset Not Found');
          return;
        }
        await sendFile(response, assetPath, method);
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        await sendFile(response, indexPath, method);
        return;
      }

      response.writeHead(404, {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      });
      response.end('Not Found');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Static server error: ${String(error)}`);
    }
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'Static server did not bind.');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  const closed = new Promise((resolve) => server.close(resolve));
  const completed = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_500)),
  ]);
  if (completed) return;
  server.closeAllConnections();
  const forced = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_500)),
  ]);
  assert(forced, 'Strict static server did not close within the deadline.');
}

async function observeEntry(page, navigation, currentEntry, mode) {
  const requestedAssets = [];
  const collectRequest = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/assets/')) requestedAssets.push(pathname);
  };
  page.on('request', collectRequest);
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === currentEntry,
  );
  await navigation();
  const response = await responsePromise;
  assert(response.status() === 200, `${mode}: current entry did not return HTTP 200.`);
  assert(
    requestedAssets.includes(currentEntry),
    `${mode}: browser did not request the exact current entry.`,
  );
  page.off('request', collectRequest);
  return { requestedAssets, response };
}

const preBuildEntry = await readExistingEntry();
await runBuild();

const indexHtml = await readFile(indexPath, 'utf8');
const currentEntry = parseModuleEntry(indexHtml);
const currentEntryPath = resolveAssetPath(currentEntry);
const currentEntryStat = await stat(currentEntryPath);
assert(currentEntryStat.isFile(), 'Current module entry is not a regular file.');
const currentBundle = await readFile(currentEntryPath);
assert(
  currentBundle.includes(Buffer.from('/api/recipe-catalog')),
  'Current production entry does not contain /api/recipe-catalog.',
);

let staleEntry;
let staleEvidence;
if (preBuildEntry && preBuildEntry !== currentEntry) {
  staleEntry = preBuildEntry;
  staleEvidence = 'recorded-pre-build-entry';
  assert(
    !(await fileExists(resolveAssetPath(staleEntry))),
    `Changed pre-build entry still exists after the clean build: ${staleEntry}`,
  );
} else {
  do {
    staleEntry = syntheticAbsentEntry(currentEntry);
  } while (
    staleEntry === currentEntry ||
    (await fileExists(resolveAssetPath(staleEntry)))
  );
  staleEvidence = 'synthetic-same-shape-absent-entry-hash-unchanged';
}

const staticServer = startStrictStaticServer();
const baseUrl = await listen(staticServer);
let browser;
const observedRequests = [];

try {
  browser = await chromium.launch({ headless: true });

  const initialContext = await browser.newContext();
  const initialPage = await initialContext.newPage();
  const initial = await observeEntry(
    initialPage,
    () => initialPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' }),
    currentEntry,
    'initial context',
  );
  observedRequests.push(...initial.requestedAssets);
  const browserBundle = await initial.response.body();
  assert(
    browserBundle.equals(currentBundle),
    'Browser did not receive the exact current bundle bytes.',
  );
  await initialContext.close();

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  const freshToken = randomUUID();
  const fresh = await observeEntry(
    freshPage,
    () =>
      freshPage.goto(`${baseUrl}/?fresh=${freshToken}`, {
        waitUntil: 'domcontentloaded',
      }),
    currentEntry,
    'fresh context',
  );
  observedRequests.push(...fresh.requestedAssets);
  const reloaded = await observeEntry(
    freshPage,
    () => freshPage.reload({ waitUntil: 'domcontentloaded' }),
    currentEntry,
    'fresh context reload',
  );
  observedRequests.push(...reloaded.requestedAssets);
  await freshContext.close();

  assert(
    !observedRequests.includes(staleEntry),
    `Browser requested stale entry ${staleEntry}.`,
  );
  const staleResponse = await fetch(`${baseUrl}${staleEntry}`, {
    cache: 'no-store',
    redirect: 'manual',
  });
  const staleBody = await staleResponse.text();
  assert(staleResponse.status === 404, 'Absent asset did not return strict HTTP 404.');
  assert(
    !staleResponse.headers.get('content-type')?.includes('text/html'),
    'Absent asset returned an HTML SPA fallback.',
  );
  assert(!/<!doctype\s+html/iu.test(staleBody), 'Absent asset body is HTML.');

  const report = {
    baseUrl,
    currentEntry,
    currentEntryBytes: currentBundle.length,
    observedCurrentEntryRequests: observedRequests.filter(
      (entry) => entry === currentEntry,
    ).length,
    preBuildEntry,
    staleEntry,
    staleEvidence,
    staleStatus: staleResponse.status,
  };
  await writeFile(
    path.join(evidenceDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `Fresh bundle checks passed for ${currentEntry}; ${staleEvidence} returned 404. ` +
      `Evidence: ${evidenceDirectory}`,
  );
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    await closeServer(staticServer);
  }
}
