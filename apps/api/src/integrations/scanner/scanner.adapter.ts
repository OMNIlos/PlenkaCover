/**
 * Scanner device contract (ТЗ §9). Mock-first: real protocols/parsing/failure modes
 * are discovery (ТЗ §11.8, §12.7). The warehouse service depends on this interface only.
 */
export interface ScanParseResult {
  /** Exact opaque label token, without decoding or normalization. */
  token: string | null;
  valid: boolean;
}

export interface ScannerAdapter {
  parse(payload: string): ScanParseResult;
}

/** DI token for the active ScannerAdapter implementation. */
export const SCANNER_ADAPTER = 'SCANNER_ADAPTER';
