import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));

function atLeast(version, minimum) {
  const current = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index];
  }
  return true;
}

function patchedBraceExpansion(version) {
  const major = Number(version.split('.')[0]);
  if (major === 1) return atLeast(version, '1.1.18');
  if (major === 2) return atLeast(version, '2.1.4');
  if (major >= 5) return major > 5 || atLeast(version, '5.0.9');
  return false;
}

function installedLockPackages(name) {
  return Object.entries(lock.packages ?? {}).filter(
    ([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
  );
}

test('ExcelJS uses a uuid release with the buffer bounds fix', () => {
  assert.equal(rootPackage.overrides?.exceljs?.uuid, '11.1.1');
  const installed = lock.packages?.['node_modules/uuid']?.version;
  assert.equal(typeof installed, 'string');
  assert.equal(atLeast(installed, '11.1.1'), true, `unsafe uuid version in lockfile: ${installed}`);
});

test('every brace-expansion branch uses a release with bounded expansion', () => {
  const installed = installedLockPackages('brace-expansion');
  assert.notEqual(installed.length, 0, 'brace-expansion is missing from the lockfile');
  for (const [path, dependency] of installed) {
    assert.equal(typeof dependency.version, 'string');
    assert.equal(
      patchedBraceExpansion(dependency.version),
      true,
      `unsafe brace-expansion version in lockfile at ${path}: ${dependency.version}`,
    );
  }
});

test('build-time URI and YAML parsers use patched releases', () => {
  assert.equal(rootPackage.overrides?.['fast-uri'], '3.1.5');
  assert.equal(rootPackage.overrides?.['js-yaml'], '4.3.2');
  assert.equal(rootPackage.overrides?.['@istanbuljs/load-nyc-config@1.1.0']?.['js-yaml'], '3.15.2');

  for (const [name, minimum] of [
    ['fast-uri', '3.1.5'],
    ['js-yaml', '3.15.2'],
  ]) {
    const installed = installedLockPackages(name);
    assert.notEqual(installed.length, 0, `${name} is missing from the lockfile`);
    for (const [path, dependency] of installed) {
      assert.equal(typeof dependency.version, 'string');
      assert.equal(
        atLeast(
          dependency.version,
          name === 'js-yaml' && dependency.version.startsWith('4.') ? '4.3.2' : minimum,
        ),
        true,
        `unsafe ${name} version in lockfile at ${path}: ${dependency.version}`,
      );
    }
  }
});

test('multipart parsing uses a release with bounded field names and upload cleanup', () => {
  const installed = installedLockPackages('multer');
  assert.notEqual(installed.length, 0, 'multer is missing from the lockfile');
  for (const [path, dependency] of installed) {
    assert.equal(
      atLeast(dependency.version, '2.3.0'),
      true,
      `unsafe multer version in lockfile at ${path}: ${dependency.version}`,
    );
  }
});

test('Prisma config uses bounded recursive merging', () => {
  assert.equal(rootPackage.overrides?.['deepmerge-ts'], '8.0.0');
  const installed = installedLockPackages('deepmerge-ts');
  assert.notEqual(installed.length, 0, 'deepmerge-ts is missing from the lockfile');
  for (const [path, dependency] of installed) {
    assert.equal(typeof dependency.version, 'string');
    assert.equal(
      atLeast(dependency.version, '8.0.0'),
      true,
      `unsafe deepmerge-ts version in lockfile at ${path}: ${dependency.version}`,
    );
  }
});

test('HTTP query parsing uses a release without the array-limit and isBuffer DoS flaws', () => {
  assert.equal(rootPackage.overrides?.qs, '6.16.0');
  const installed = installedLockPackages('qs');
  assert.notEqual(installed.length, 0, 'qs is missing from the lockfile');
  for (const [path, dependency] of installed) {
    assert.equal(typeof dependency.version, 'string');
    assert.equal(
      atLeast(dependency.version, '6.16.0'),
      true,
      `unsafe qs version in lockfile at ${path}: ${dependency.version}`,
    );
  }
});
