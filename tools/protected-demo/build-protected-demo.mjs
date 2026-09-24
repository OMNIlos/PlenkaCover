import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'release/protected-demo');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const localBin = (name) =>
  path.join(root, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);

function run(cmd, args, cwd = root) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  copyFileSync(src, dest);
}

function copyDir(src, dest, options = {}) {
  if (!existsSync(src)) return false;
  const { skip = () => false } = options;
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    if (skip(source, entry)) continue;
    if (entry.isDirectory()) copyDir(source, target, options);
    else if (entry.isFile()) copyFile(source, target);
  }
  return true;
}

function listFiles(dir, predicate = () => true) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(file, predicate));
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out;
}

function totalBytes(dir) {
  return listFiles(dir).reduce((sum, file) => sum + statSync(file).size, 0);
}

function removeMapsAndTypes(dir) {
  for (const file of listFiles(
    dir,
    (f) => f.endsWith('.map') || f.endsWith('.d.ts') || f.endsWith('.tsbuildinfo'),
  )) {
    rmSync(file);
  }
}

function obfuscateJs(dir) {
  const files = listFiles(dir, (f) => f.endsWith('.js'));
  for (const file of files) {
    const code = readFileSync(file, 'utf8');
    const result = JavaScriptObfuscator.obfuscate(code, {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false,
      rotateStringArray: true,
      selfDefending: false,
      sourceMap: false,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.35,
      target: 'node',
    });
    writeFileSync(file, result.getObfuscatedCode());
  }
  return files.length;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function packageJson() {
  const rootPkg = readJson(path.join(root, 'package.json'));
  const apiPkg = readJson(path.join(root, 'apps/api/package.json'));
  const agentPkg = readJson(path.join(root, 'apps/gateway-agent/package.json'));
  const dependencies = {
    ...apiPkg.dependencies,
    '@plenka/contracts': 'file:packages/contracts',
    prisma: apiPkg.devDependencies.prisma,
  };
  const optionalDependencies = {
    ...(agentPkg.optionalDependencies ?? {}),
  };

  return {
    name: 'plenka-protected-demo',
    version: rootPkg.version,
    private: true,
    description:
      'Protected local demo package for Plenka Cover: obfuscated backend + Windows gateway agent.',
    engines: { node: '>=20' },
    scripts: {
      postinstall: 'prisma generate --schema apps/api/prisma/schema.prisma',
      'db:generate': 'prisma generate --schema apps/api/prisma/schema.prisma',
      'db:deploy': 'prisma migrate deploy --schema apps/api/prisma/schema.prisma',
      'db:seed': 'node apps/api/prisma/seed.js',
      'start:api': 'node apps/api/dist/main.js',
      'start:agent': 'node apps/gateway-agent/dist/main.js',
      'start:web': 'node tools/static-server.mjs',
    },
    dependencies,
    optionalDependencies,
    overrides: {
      // @nestjs/platform-express pulls multer transitively. Pin the patched upload parser
      // even though this API does not expose file-upload routes in the protected demo.
      multer: '2.2.0',
    },
  };
}

function apiEnvExample() {
  return `# Plenka Cover protected local demo.
# Copy is created by scripts/install.ps1 as .env. Edit values before a client demo.

DATABASE_URL="postgresql://plenka:plenka@localhost:5433/plenka?schema=public"

PORT=3000
APP_ENV=development
NODE_ENV=production
PUBLIC_ORIGIN=http://localhost:5173

# Real login/session auth is used because the development x-role shortcut stays off. Seed accounts:
# operator / warehouse / commercial / production / finance / director / admin
# all use SEED_PASSWORD.
AUTH_DEV_XROLE=off
SESSION_TTL=43200
SEED_PASSWORD=plenka-dev

# Physical-device demo goes through the Windows gateway agent.
DEVICE_GATEWAY_SCALE=on
DEVICE_GATEWAY_PRINTER=on
GATEWAY_SIMULATOR=off
GATEWAY_COMMAND_TIMEOUT_MS=5000

# Mock 1C stays mock-first for the demo.
ONEC_LIVE=false
ONEC_WRITE=false
`;
}

function agentEnvExample() {
  return `# Windows post agent config. Copy is created by scripts/install.ps1 as apps/gateway-agent/.env.

GATEWAY_API_URL=http://localhost:3000/api
GATEWAY_AGENT_TOKEN=agent-post-1
GATEWAY_POST_CODE=POST-1

GATEWAY_SCALE_DEVICE_ID=dev-scale-1
GATEWAY_PRINTER_DEVICE_ID=dev-printer-1
GATEWAY_SCANNER_DEVICE_ID=dev-scanner-1

GATEWAY_POLL_INTERVAL_MS=1000
GATEWAY_HEARTBEAT_INTERVAL_MS=5000

# Physical scale default: MASSA-K Protocol 100.
# USB virtual COM: terminal setup is not required.
# RS-232: terminal mode 1C, 57600 baud, 8-N-1.
# No-hardware alternative: set SCALE_MODE=simulated.
SCALE_MODE=massa-k-protocol-100
SCALE_SERIAL_PORT=COM3
SCALE_SERIAL_BAUD=57600
SCALE_READ_TIMEOUT_MS=1500
SCALE_SIMULATED_OFFLINE=off

# Printer: simulated | tcp9100 | windows-command
PRINTER_MODE=simulated
PRINTER_TCP_HOST=192.168.1.50
PRINTER_TCP_PORT=9100
PRINTER_WINDOWS_COMMAND=
PRINTER_SIMULATED_FAIL=off

GATEWAY_BUFFER_DIR=.gateway-buffer
`;
}

function buildSeed() {
  const seedOut = path.join(outDir, 'apps/api/prisma/seed.js');
  ensureDir(path.dirname(seedOut));
  run(localBin('esbuild'), [
    'apps/api/prisma/seed.ts',
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    '--external:@prisma/client',
    `--outfile=${seedOut}`,
  ]);
  return seedOut;
}

function copyFrontendIfAvailable() {
  const frontendDist = path.join(root, 'Plenki/frontend-siemens/dist');
  const index = path.join(frontendDist, 'index.html');
  if (!existsSync(index)) return false;
  copyDir(frontendDist, path.join(outDir, 'frontend'));
  return true;
}

function safeRelative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function main() {
  console.log('Building source workspaces...');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);

  rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  console.log('Copying runtime artifacts...');
  copyDir(path.join(root, 'apps/api/dist'), path.join(outDir, 'apps/api/dist'));
  copyDir(path.join(root, 'apps/gateway-agent/dist'), path.join(outDir, 'apps/gateway-agent/dist'));
  copyDir(path.join(root, 'packages/contracts/dist'), path.join(outDir, 'packages/contracts/dist'));
  copyFile(
    path.join(root, 'packages/contracts/package.json'),
    path.join(outDir, 'packages/contracts/package.json'),
  );

  copyDir(
    path.join(root, 'apps/api/prisma/migrations'),
    path.join(outDir, 'apps/api/prisma/migrations'),
  );
  copyFile(
    path.join(root, 'apps/api/prisma/schema.prisma'),
    path.join(outDir, 'apps/api/prisma/schema.prisma'),
  );
  const seedOut = buildSeed();

  copyFile(path.join(root, 'docker-compose.yml'), path.join(outDir, 'docker-compose.yml'));
  copyFile(
    path.join(root, 'tools/protected-demo/README.customer.md'),
    path.join(outDir, 'README.md'),
  );
  copyFile(
    path.join(root, 'tools/protected-demo/static-server.mjs'),
    path.join(outDir, 'tools/static-server.mjs'),
  );
  copyFile(
    path.join(root, 'tools/protected-demo/hardware-preflight.mjs'),
    path.join(outDir, 'tools/hardware-preflight.mjs'),
  );
  copyDir(path.join(root, 'tools/protected-demo/windows'), path.join(outDir, 'scripts'));

  writeFileSync(path.join(outDir, '.env.example'), apiEnvExample());
  ensureDir(path.join(outDir, 'apps/gateway-agent'));
  writeFileSync(path.join(outDir, 'apps/gateway-agent/.env.example'), agentEnvExample());
  writeJson(path.join(outDir, 'package.json'), packageJson());

  console.log('Locking runtime dependencies...');
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--omit=dev'],
    outDir,
  );

  removeMapsAndTypes(path.join(outDir, 'apps'));
  removeMapsAndTypes(path.join(outDir, 'packages'));

  console.log('Obfuscating application JavaScript...');
  const obfuscatedCount =
    obfuscateJs(path.join(outDir, 'apps/api/dist')) +
    obfuscateJs(path.join(outDir, 'apps/gateway-agent/dist')) +
    obfuscateJs(path.dirname(seedOut));

  const frontendIncluded = copyFrontendIfAvailable();
  const manifest = {
    builtAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    baselineBranch: execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    obfuscatedJsFiles: obfuscatedCount,
    frontendIncluded,
    excluded: ['src/', 'test/', 'docs/superpowers/', 'Plenki/frontend-siemens/src/'],
    output: safeRelative(outDir),
    bytes: totalBytes(outDir),
  };
  writeJson(path.join(outDir, 'protected-demo-manifest.json'), manifest);

  console.log(`Protected demo package written to ${safeRelative(outDir)}`);
  if (!frontendIncluded) {
    console.log('Frontend dist was not found; package will start API + agent only.');
  }
}

main();
