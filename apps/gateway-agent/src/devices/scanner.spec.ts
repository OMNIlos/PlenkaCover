import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HidScanner } from './scanner';

describe('HidScanner', () => {
  it('stays offline when an older physical-post config has no HID path', () => {
    expect(new HidScanner(null).status()).toBe('offline');
  });

  it('reports an existing character device as ready', () => {
    expect(new HidScanner('/dev/null').status()).toBe('ready');
  });

  it('reports missing and regular files as offline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hid-scanner-'));
    const regularFile = path.join(dir, 'event-kbd');
    fs.writeFileSync(regularFile, 'not a device');
    try {
      expect(new HidScanner('/__missing_hid_scanner__').status()).toBe('offline');
      expect(new HidScanner(regularFile).status()).toBe('offline');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
