import { Injectable } from '@nestjs/common';
import type { ScanParseResult, ScannerAdapter } from './scanner.adapter';

/**
 * Deterministic mock scanner (ТЗ §11.8 mock-first). A HID scanner is a keyboard wedge,
 * so this seam validates the exact browser buffer only; it never decodes or normalizes it.
 * The database maps the opaque token to a roll after the format check.
 */
@Injectable()
export class MockScannerAdapter implements ScannerAdapter {
  parse(payload: string): ScanParseResult {
    if (typeof payload !== 'string' || !/^prt_[0-9a-f]{64}$/u.test(payload)) {
      return { token: null, valid: false };
    }
    return { token: payload, valid: true };
  }
}
