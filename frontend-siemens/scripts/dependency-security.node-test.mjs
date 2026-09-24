import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const minimumSecureVersions = {
  'brace-expansion': '5.0.9',
  nanoid: '3.3.18',
  postcss: '8.5.25',
};

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

test('security overrides and lockfile keep audited transitive dependencies patched', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url)));

  for (const [dependency, minimumVersion] of Object.entries(minimumSecureVersions)) {
    assert.equal(
      packageJson.overrides?.[dependency],
      minimumVersion,
      `${dependency} must be pinned to the reviewed secure version`,
    );
    const lockedVersion = packageLock.packages?.[`node_modules/${dependency}`]?.version;
    assert.ok(lockedVersion, `${dependency} must be present in package-lock.json`);
    assert.ok(
      compareVersions(lockedVersion, minimumVersion) >= 0,
      `${dependency}@${lockedVersion} is below secure minimum ${minimumVersion}`,
    );
  }
});
