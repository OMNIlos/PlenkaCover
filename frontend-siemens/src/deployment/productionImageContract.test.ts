import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BUILDER_IMAGE =
  'public.ecr.aws/docker/library/node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';
const RUNTIME_IMAGE =
  'public.ecr.aws/docker/library/caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648';
const DOCKERIGNORE_ALLOWLIST = [
  '**',
  '!package.json',
  '!package-lock.json',
  '!tsconfig.json',
  '!vite.config.ts',
  '!index.html',
  '!Caddyfile',
  '!public/',
  '!public/**',
  '!src/',
  '!src/**',
];
const DOCKERIGNORE_FINAL_DENYLIST = [
  '**/.env*',
  '**/*.map',
  '**/qa/**',
  '**/output/**',
  '**/screenshots/**',
  '**/*screenshot*',
  '**/*.pem',
  '**/*.key',
  '**/*credential*',
  '**/*secret*',
];

function activeLines(source: string): string[] {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function dockerfileViolations(source: string): string[] {
  const issues: string[] = [];
  const fromLines = activeLines(source).filter((line) => /^FROM\s/iu.test(line));
  const expectedBuilder = `FROM ${BUILDER_IMAGE} AS builder`;
  const expectedRuntime = `FROM ${RUNTIME_IMAGE} AS runtime`;

  const syntaxDirective = source.match(/^# syntax=(.+)$/mu)?.[1];
  if (syntaxDirective && !/@sha256:[a-f0-9]{64}$/u.test(syntaxDirective)) {
    issues.push('Dockerfile frontend must be absent or pinned by digest');
  }

  if (fromLines[0] !== expectedBuilder) issues.push('builder image must be immutable and pinned');
  if (fromLines[1] !== expectedRuntime) issues.push('runtime image must be immutable and pinned');

  const nodeVersion = fromLines[0]?.match(/node:(\d+)\.(\d+)\.(\d+)/u);
  if (
    !nodeVersion ||
    Number(nodeVersion[1]) < 22 ||
    (Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) < 19)
  ) {
    issues.push('builder Node must be at least 22.19');
  }

  if (!/^RUN npm ci$/mu.test(source)) issues.push('dependencies must use npm ci');
  if (!/^RUN npm run build(?:\s|$)/mu.test(source)) issues.push('production build is missing');
  if (!/^COPY --from=builder \/app\/dist \/srv$/mu.test(source)) {
    issues.push('runtime must contain only the built site at /srv');
  }
  if (!/find dist -type f -name ['"]\*\.map['"]/u.test(source)) {
    issues.push('build must fail when source maps are emitted');
  }
  if (/^\s*(?:ARG|ENV)\s/imu.test(source)) {
    issues.push('build and runtime arguments are forbidden');
  }
  if (/^COPY\s+\.\s/imu.test(source)) issues.push('whole source context must not be copied');

  const runtimeStage = source.split(expectedRuntime)[1] ?? '';
  const runtimeTransfers = activeLines(runtimeStage).filter((line) =>
    /^(?:COPY|ADD)\s/iu.test(line),
  );
  const expectedRuntimeTransfers = [
    'COPY Caddyfile /etc/caddy/Caddyfile',
    'COPY --from=builder /app/dist /srv',
  ];
  if (
    runtimeTransfers.length !== expectedRuntimeTransfers.length ||
    runtimeTransfers.some((line, index) => line !== expectedRuntimeTransfers[index])
  ) {
    issues.push('runtime COPY and ADD instructions must match the audited allowlist exactly');
  }
  if (!/^HEALTHCHECK[^\n]*\bwget\b[^\n]*127\.0\.0\.1:8080\/healthz$/mu.test(source)) {
    issues.push('runtime must expose a wget-compatible healthcheck');
  }

  return issues;
}

function dockerignoreViolations(source: string): string[] {
  const lines = activeLines(source);
  const expected = [...DOCKERIGNORE_ALLOWLIST, ...DOCKERIGNORE_FINAL_DENYLIST];
  const issues: string[] = [];

  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    issues.push('Docker context must use the audited source-only allowlist');
  }

  const finalAllowIndex = lines.reduce(
    (lastIndex, line, index) => (line.startsWith('!') ? index : lastIndex),
    -1,
  );
  if (
    DOCKERIGNORE_FINAL_DENYLIST.some((rule) => {
      const ruleIndex = lines.indexOf(rule);
      return ruleIndex <= finalAllowIndex;
    })
  ) {
    issues.push(
      'Docker context must deny nested secret, source-map, and QA artifacts after allow rules',
    );
  }

  return issues;
}

function caddyfileViolations(source: string): string[] {
  const issues: string[] = [];
  if (!/^\s*auto_https off\s*$/mu.test(source)) issues.push('standalone TLS must be disabled');
  if (!/^:8080\s*\{/mu.test(source)) issues.push('standalone listener must use port 8080');
  if (!/root \* \/srv/u.test(source)) issues.push('static root must be /srv');
  if (!/try_files \{path\} \/index\.html/u.test(source)) issues.push('SPA fallback is missing');
  if (!/handle \/api\/\*/u.test(source) || !/respond[^\n]*503/u.test(source)) {
    issues.push('standalone image must fail closed for /api');
  }
  if (
    !/@sourceMaps path \*\.map/u.test(source) ||
    !/handle @sourceMaps \{\s*respond 404/su.test(source)
  ) {
    issues.push('SPA fallback must not answer source-map requests');
  }
  if (/\breverse_proxy\b|\btls\b|\bacme\b/iu.test(source)) {
    issues.push('standalone image must not claim VPS TLS or API routing');
  }
  if (/localhost|https?:\/\/(?!127\.0\.0\.1(?::\d+)?\/healthz)/iu.test(source)) {
    issues.push('absolute service origins are forbidden');
  }
  return issues;
}

function apiClientViolations(source: string): string[] {
  const directRelativeFetch = /\bfetch\(path,\s*\{/u.test(source);
  const configurableOrAbsoluteOrigin =
    /https?:\/\/|\blocalhost\b|\b(?:VITE_|API_(?:BASE|ORIGIN))/iu.test(source);

  return directRelativeFetch && !configurableOrAbsoluteOrigin
    ? []
    : ['browser API client must call same-origin relative paths directly'];
}

function authBuildViolations(authGate: string, roleLock: string, packageJson: string): string[] {
  const issues: string[] = [];
  if (!/AUTH_REQUIRED\s*=\s*import\.meta\.env\.PROD\s*\|\|/u.test(authGate)) {
    issues.push('production auth must be fail closed');
  }
  const roleGateStart = roleLock.indexOf('export function DemoRoleSwitcherGate');
  const roleGate = roleGateStart >= 0 ? roleLock.slice(roleGateStart) : '';
  const roleGateReturns = roleGate.match(/\breturn\b/gu) ?? [];
  if (
    roleGateReturns.length !== 1 ||
    !/return authRequired \? null : <>\{children\}<\/>;/u.test(roleGate)
  ) {
    issues.push('production role switcher must be absent');
  }
  if (/VITE_REQUIRE_AUTH\s*=\s*off/u.test(packageJson)) {
    issues.push('default production build must not disable auth');
  }
  return issues;
}

function cleanBuildViolations(packageJson: string, tsconfig: string): string[] {
  const packageConfig = JSON.parse(packageJson) as {
    devDependencies?: Record<string, string>;
  };
  const typesNode = packageConfig.devDependencies?.['@types/node'];
  const compilerOptions = (
    JSON.parse(tsconfig) as { compilerOptions?: { target?: string; lib?: string[] } }
  ).compilerOptions;
  const issues: string[] = [];

  if (!typesNode || !/^22\.\d+\.\d+$/u.test(typesNode)) {
    issues.push('clean build must pin Node type declarations');
  }
  if (compilerOptions?.target !== 'ES2022' || !compilerOptions.lib?.includes('ES2022')) {
    issues.push('compiler must model the ES2022 APIs used by the application');
  }
  return issues;
}

function readRequiredFile(relativePath: string): string {
  const file = new URL(`../../${relativePath}`, import.meta.url);
  expect(existsSync(file), `${relativePath} must exist`).toBe(true);
  return readFileSync(file, 'utf8');
}

function readJavaScriptTree(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readJavaScriptTree(path);
      return entry.name.endsWith('.js') ? readFileSync(path, 'utf8') : '';
    })
    .join('\n');
}

describe('production frontend image contract', () => {
  it('ships the immutable, source-only, same-origin image surface', () => {
    const dockerfile = readRequiredFile('Dockerfile');
    const dockerignore = readRequiredFile('.dockerignore');
    const caddyfile = readRequiredFile('Caddyfile');
    const apiClient = readRequiredFile('src/api/client.ts');
    const authGate = readRequiredFile('src/components/auth/AuthGate.tsx');
    const roleLock = readRequiredFile('src/components/auth/roleLock.tsx');
    const packageJson = readRequiredFile('package.json');
    const tsconfig = readRequiredFile('tsconfig.json');

    expect(dockerfileViolations(dockerfile)).toEqual([]);
    expect(dockerignoreViolations(dockerignore)).toEqual([]);
    expect(caddyfileViolations(caddyfile)).toEqual([]);
    expect(apiClientViolations(apiClient)).toEqual([]);
    expect(authBuildViolations(authGate, roleLock, packageJson)).toEqual([]);
    expect(cleanBuildViolations(packageJson, tsconfig)).toEqual([]);
  });

  it('rejects mutable or obsolete base images and missing runtime assets', () => {
    const valid = `FROM ${BUILDER_IMAGE} AS builder\nRUN npm ci\nRUN npm run build && test -z "$(find dist -type f -name '*.map' -print -quit)"\nFROM ${RUNTIME_IMAGE} AS runtime\nCOPY Caddyfile /etc/caddy/Caddyfile\nCOPY --from=builder /app/dist /srv\nHEALTHCHECK CMD wget --quiet --spider http://127.0.0.1:8080/healthz`;

    expect(dockerfileViolations(valid)).toEqual([]);
    expect(dockerfileViolations(valid.replace(/@sha256:[a-f0-9]+/u, ''))).toContain(
      'builder image must be immutable and pinned',
    );
    expect(dockerfileViolations(valid.replace('node:22.23.1', 'node:20.18.0'))).toContain(
      'builder Node must be at least 22.19',
    );
    expect(dockerfileViolations(valid.replace('/app/dist /srv', '/app/dist /site'))).toContain(
      'runtime must contain only the built site at /srv',
    );
    expect(dockerfileViolations(valid.replace(/^HEALTHCHECK.*$/mu, ''))).toContain(
      'runtime must expose a wget-compatible healthcheck',
    );
  });

  it('rejects Docker contexts that admit secrets, source maps, or QA artifacts', () => {
    const unsafe = `${DOCKERIGNORE_ALLOWLIST.join('\n')}\n!.env\n!output/**\n!qa/**/*.png`;
    expect(dockerignoreViolations(unsafe)).toContain(
      'Docker context must use the audited source-only allowlist',
    );
  });

  it('rejects nested public secret and QA fixtures admitted after source allow rules', () => {
    const safe = [...DOCKERIGNORE_ALLOWLIST, ...DOCKERIGNORE_FINAL_DENYLIST].join('\n');
    const fixtures = [
      { path: 'public/.env.production', denyRule: '**/.env*' },
      { path: 'public/qa/review-screenshot.png', denyRule: '**/qa/**' },
    ];

    for (const fixture of fixtures) {
      const unsafe = safe
        .split('\n')
        .filter((line) => line !== fixture.denyRule)
        .join('\n');

      expect(dockerignoreViolations(unsafe), fixture.path).toContain(
        'Docker context must deny nested secret, source-map, and QA artifacts after allow rules',
      );
    }
  });

  it('rejects any extra runtime COPY or ADD even when the required dist copy remains', () => {
    const valid = `FROM ${BUILDER_IMAGE} AS builder\nRUN npm ci\nRUN npm run build && test -z "$(find dist -type f -name '*.map' -print -quit)"\nFROM ${RUNTIME_IMAGE} AS runtime\nCOPY Caddyfile /etc/caddy/Caddyfile\nCOPY --from=builder /app/dist /srv\nHEALTHCHECK CMD wget --quiet --spider http://127.0.0.1:8080/healthz`;
    const copyLeak = `${valid}\nCOPY --from=builder /app /leaked-app`;
    const addLeak = `${valid}\nADD qa-output /srv/qa-output`;

    expect(dockerfileViolations(valid)).toEqual([]);
    expect(dockerfileViolations(copyLeak)).toContain(
      'runtime COPY and ADD instructions must match the audited allowlist exactly',
    );
    expect(dockerfileViolations(addLeak)).toContain(
      'runtime COPY and ADD instructions must match the audited allowlist exactly',
    );
  });

  it('rejects an absolute backend origin in the browser API client', () => {
    const client = readRequiredFile('src/api/client.ts');
    const unsafe = client.replace('fetch(path, {', 'fetch(`https://backend.example${path}`, {');

    expect(unsafe).not.toBe(client);
    expect(apiClientViolations(unsafe)).toContain(
      'browser API client must call same-origin relative paths directly',
    );
  });

  it('rejects a production role-switch branch hidden before the safe-looking return', () => {
    const authGate = readRequiredFile('src/components/auth/AuthGate.tsx');
    const roleLock = readRequiredFile('src/components/auth/roleLock.tsx');
    const unsafe = roleLock.replace(
      '  return authRequired ? null : <>{children}</>;',
      '  if (authRequired) return <>{children}</>;\n  return authRequired ? null : <>{children}</>;',
    );

    expect(unsafe).not.toBe(roleLock);
    expect(authBuildViolations(authGate, unsafe, '{}')).toContain(
      'production role switcher must be absent',
    );
  });

  it('rejects a mutable Dockerfile frontend directive', () => {
    const dockerfile = readRequiredFile('Dockerfile');

    expect(dockerfile).not.toMatch(/^# syntax=docker\/dockerfile:1$/mu);
  });

  it('documents multi-platform digest deployment and mirrors production capabilities locally', () => {
    const runbook = readRequiredFile('docs/vps-frontend-release.md');

    expect(runbook).toMatch(
      /docker buildx build[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/u,
    );
    expect(runbook).toMatch(/docker buildx imagetools inspect/u);
    expect(runbook).toMatch(/PLENKA_WEB_IMAGE[^\n]*@\$\{WEB_DIGEST\}/u);
    expect(runbook).toMatch(/--cap-drop ALL/u);
    expect(runbook).toMatch(/--cap-add NET_BIND_SERVICE/u);
    expect(runbook).toMatch(/--security-opt no-new-privileges:true/u);
  });

  it('compiles production auth fail-closed and keeps the emitted API client same-origin', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url));
    const outDir = mkdtempSync(join(tmpdir(), 'plenka-production-contract-'));
    const previousAuthFlag = process.env.VITE_REQUIRE_AUTH;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.VITE_REQUIRE_AUTH = 'off';
    process.env.NODE_ENV = 'production';

    try {
      const viteModule = 'vite';
      const { build } = await import(viteModule);
      await build({
        root,
        logLevel: 'silent',
        build: { emptyOutDir: true, minify: false, outDir, sourcemap: false },
      });
      const bundle = readJavaScriptTree(outDir);

      expect(bundle).toMatch(/function AuthGate\(\{ children, authRequired = true \}\)/u);
      expect(bundle).toMatch(
        /function DemoRoleSwitcherGate\(\{ authRequired, children \}\)\s*\{\s*return authRequired \? null :/u,
      );
      expect(bundle).toMatch(/DemoRoleSwitcherGate,\s*\{\s*authRequired: true,/u);
      expect(bundle).toMatch(/await fetch\(path,\s*\{/u);
      expect(bundle).not.toMatch(/VITE_REQUIRE_AUTH|API_PROXY_TARGET|localhost:3000/u);
    } finally {
      if (previousAuthFlag === undefined) delete process.env.VITE_REQUIRE_AUTH;
      else process.env.VITE_REQUIRE_AUTH = previousAuthFlag;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      rmSync(outDir, { force: true, recursive: true });
    }
  }, 30_000);

  it('rejects absolute backend origins, secret arguments, and unsafe auth defaults', () => {
    const unsafeDockerfile = `FROM ${BUILDER_IMAGE} AS builder\nARG API_TOKEN\nENV API_BASE_URL=https://backend.example\nFROM ${RUNTIME_IMAGE} AS runtime`;
    const unsafeCaddyfile = ':8080 { reverse_proxy https://backend.example }';
    const unsafeAuthGate = 'const AUTH_REQUIRED = import.meta.env.VITE_REQUIRE_AUTH === "on";';
    const unsafeRoleLock = 'return children;';

    expect(dockerfileViolations(unsafeDockerfile)).toContain(
      'build and runtime arguments are forbidden',
    );
    expect(caddyfileViolations(unsafeCaddyfile)).toContain(
      'standalone image must not claim VPS TLS or API routing',
    );
    expect(authBuildViolations(unsafeAuthGate, unsafeRoleLock, '{}')).toEqual([
      'production auth must be fail closed',
      'production role switcher must be absent',
    ]);
  });

  it('rejects build metadata that only succeeds with contaminating parent dependencies', () => {
    expect(cleanBuildViolations('{"devDependencies":{}}', '{"compilerOptions":{}}')).toEqual([
      'clean build must pin Node type declarations',
      'compiler must model the ES2022 APIs used by the application',
    ]);
  });
});
