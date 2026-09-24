import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stockStyles = readFileSync(new URL('./108-stock-production.css', import.meta.url), 'utf8');

describe('warehouse finished-stock header', () => {
  it('keeps the age heading on one line in a track wide enough for the label', () => {
    expect(stockStyles).toMatch(
      /\.warehouse-finished-stock-row\s*\{[^}]*grid-template-columns:[^;]*minmax\(88px,[^)]+\)/u,
    );
    expect(stockStyles).toMatch(
      /\.warehouse-finished-stock-cell-age\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/u,
    );
  });
});
