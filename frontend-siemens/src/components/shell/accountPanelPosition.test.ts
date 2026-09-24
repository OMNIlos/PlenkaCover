import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles/54-admin.css', import.meta.url), 'utf8');
const primitiveCss = readFileSync(
  new URL('../../styles/03-plenki-vella-primitives.css', import.meta.url),
  'utf8',
);

function zIndex(source: string, selector: string) {
  const block = source.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';
  return Number(block.match(/z-index:\s*(\d+)/u)?.[1] ?? Number.NaN);
}

describe('account panel position', () => {
  it('keeps account and notification panels on the shared measured chrome offset', () => {
    expect(css).toMatch(
      /\.floating-panel\s*\{[^}]*top:\s*calc\(var\(--app-chrome-height\) \+ 8px\);/u,
    );
    expect(css).toMatch(
      /\.floating-panel\s*\{[^}]*max-height:\s*calc\(100dvh - var\(--app-chrome-height\) - 16px\);/u,
    );
    expect(css).not.toMatch(/\.account-panel\s*\{[^}]*\btop:/u);
    expect(css).not.toMatch(/\.notification-panel\s*\{[^}]*\btop:/u);
  });

  it('keeps notification pagination compact with the panel as the only scroll container', () => {
    expect(css).toMatch(
      /\.notification-pagination\s*\{[^}]*display:\s*flex;[^}]*position:\s*static;/u,
    );
    expect(css).toMatch(/\.notification-pagination\s+button\s*\{[^}]*min-height:\s*36px;/u);
    expect(css).not.toMatch(/\.notification-list\s*\{[^}]*overflow(?:-y)?:\s*(?:auto|scroll);/u);
    expect(css).not.toMatch(/\.notification-pagination\s*\{[^}]*(?:animation|transition)/iu);
  });

  it('keeps the complete notification panel above fixed production bulk actions', () => {
    expect(zIndex(css, '.floating-panel')).toBeGreaterThan(
      zIndex(primitiveCss, '.plenki-bulk-bar'),
    );
    expect(css).toMatch(/\.floating-panel\s*\{[^}]*pointer-events:\s*auto;/u);
    expect(css).toMatch(/\.floating-panel\s*\{[^}]*overflow:\s*auto;/u);
  });
});
