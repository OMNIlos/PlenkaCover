import * as fs from 'node:fs';

export type ScannerStatus = 'ready' | 'offline';

export interface ScannerDevice {
  /** Receiver presence only; a physical PASS still requires a browser scan followed by Enter. */
  status(): ScannerStatus;
}

/**
 * The scanner remains a browser-owned HID keyboard wedge. The agent only verifies that the
 * configured Linux input receiver exists; `ready` means receiver presence only, never a physical
 * scan PASS. The browser still owns the actual scan plus Enter confirmation.
 */
export class HidScanner implements ScannerDevice {
  constructor(private readonly devicePath: string | null) {}

  status(): ScannerStatus {
    if (!this.devicePath) return 'offline';
    try {
      return fs.statSync(this.devicePath).isCharacterDevice() ? 'ready' : 'offline';
    } catch {
      return 'offline';
    }
  }
}
