import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

function runInterfaceInvariants() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/interface-invariants.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, INTERFACE_INVARIANTS_CONTRACT_ONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, 2_000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
}

test('interface contract mode validates static invariants without starting the browser suite', async () => {
  const result = await runInterfaceInvariants();
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    result.output,
  );
  assert.match(result.output, /Interface invariant contract checks passed/u);
});
