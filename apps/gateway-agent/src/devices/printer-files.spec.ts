import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrinterProfile } from '../label';
import { CupsZplPrinter } from './printer';

jest.mock('node:child_process', () => ({ exec: jest.fn(), execFile: jest.fn() }));

const PROFILE: PrinterProfile = { dpi: 203, maxWidthDots: 864 };
let labelDir: string;

beforeEach(() => {
  labelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cups-zpl-cleanup-'));
});

afterEach(() => {
  fs.rmSync(labelDir, { recursive: true, force: true });
});

it('removes only a bounded batch of stale crash leftovers and keeps fresh or unrelated files', () => {
  const stale = Array.from({ length: 40 }, () => path.join(labelDir, `label-${randomUUID()}.zpl`));
  const fresh = path.join(labelDir, `label-${randomUUID()}.zpl`);
  const unrelated = path.join(labelDir, 'operator-note.txt');
  const old = new Date(Date.now() - 60 * 60 * 1000);

  for (const file of stale) {
    fs.writeFileSync(file, 'sensitive-label');
    fs.utimesSync(file, old, old);
  }
  fs.writeFileSync(fresh, 'in-flight-label');
  fs.writeFileSync(unrelated, 'keep');
  fs.utimesSync(unrelated, old, old);

  new CupsZplPrinter('TLP4', labelDir, PROFILE);

  expect(stale.filter((file) => fs.existsSync(file))).toHaveLength(8);
  expect(fs.existsSync(fresh)).toBe(true);
  expect(fs.existsSync(unrelated)).toBe(true);
});
