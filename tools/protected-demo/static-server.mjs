import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const frontendDir = path.resolve(process.env.FRONTEND_DIR ?? path.join(root, 'frontend'));
const apiProxyUrl = new URL(process.env.API_PROXY_URL ?? 'http://localhost:3000');
const port = Number(process.env.FRONTEND_PORT ?? 5173);

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function staticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const requested = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(frontendDir, requested === '/' ? 'index.html' : requested);
  if (!file.startsWith(frontendDir)) return path.join(frontendDir, 'index.html');
  if (existsSync(file) && statSync(file).isFile()) return file;
  return path.join(frontendDir, 'index.html');
}

async function proxy(req, res) {
  const upstream = new URL(req.url ?? '/', apiProxyUrl);
  const headers = { ...req.headers };
  delete headers.host;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const response = await fetch(upstream, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

const server = http.createServer((req, res) => {
  void (async () => {
    try {
      if ((req.url ?? '').startsWith('/api')) {
        await proxy(req, res);
        return;
      }
      const file = staticPath(req.url ?? '/');
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'content-type': types.get(ext) ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`frontend server error: ${String(err)}`);
    }
  })();
});

server.listen(port, () => {
  console.log(`Frontend listening on http://localhost:${port} (proxy: ${apiProxyUrl})`);
});
