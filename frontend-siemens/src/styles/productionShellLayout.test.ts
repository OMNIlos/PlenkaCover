import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const shellStyles = readFileSync(new URL('./01-shell-navigation.css', import.meta.url), 'utf8');
const commercialStyles = readFileSync(
  new URL('./31-commercial-golden-slice.css', import.meta.url),
  'utf8',
);
const panelStyles = readFileSync(new URL('./54-admin.css', import.meta.url), 'utf8');
const responsiveStyles = readFileSync(
  new URL('./90-responsive-motion.css', import.meta.url),
  'utf8',
);
const tokenStyles = readFileSync(new URL('./00-tokens-base.css', import.meta.url), 'utf8');
const listStyles = readFileSync(new URL('./02-list-detail.css', import.meta.url), 'utf8');
const operatorStyles = readFileSync(
  new URL('./51-operator-workbench.css', import.meta.url),
  'utf8',
);

function cssBlock(source: string, selector: string) {
  const start = source.indexOf(selector);
  if (start < 0) return '';
  const open = source.indexOf('{', start + selector.length);
  if (open < 0) return '';
  const close = source.indexOf('}', open + 1);
  return close < 0 ? '' : source.slice(open + 1, close);
}

describe('production viewport shell', () => {
  it('does not reserve a Siemens menu gutter when this application has no menu', () => {
    expect(shellStyles).toMatch(
      /ix-application:not\(:has\(ix-menu, \[slot=['"]application-sidebar['"]\]\)\)\s*\{[^}]*--ix-application-menu-margin-left:\s*var\(--ix-application-menu-safe-area-left,\s*0rem\);/u,
    );
    expect(cssBlock(shellStyles, '.app-shell > *')).toMatch(/min-width:\s*0;/u);
  });

  it('uses one auth-aware chrome offset instead of reserving an invisible footer', () => {
    expect(appSource).toContain("data-auth-required={AUTH_REQUIRED ? 'true' : 'false'}");
    expect(shellStyles).toContain('--app-chrome-height');
    expect(cssBlock(shellStyles, '.app-shell')).toMatch(
      /min-height:\s*calc\(100dvh - var\(--app-chrome-height\)\);/u,
    );
    expect(commercialStyles).toMatch(/height:\s*calc\(100dvh - var\(--app-chrome-height\)\);/u);
    expect(commercialStyles).not.toMatch(/100dvh\s*-\s*(?:150|190)px/u);
    expect(shellStyles).toContain('--app-chrome-height: 104px');
    expect(shellStyles).toContain('--app-chrome-height: 171px');
    expect(shellStyles).toContain('--app-chrome-height: 150px');
  });

  it('anchors account and notification panels directly below the real navbar', () => {
    expect(cssBlock(panelStyles, '.floating-panel')).toMatch(
      /top:\s*calc\(var\(--app-chrome-height\) \+ 8px\);/u,
    );
    expect(cssBlock(panelStyles, '.floating-panel')).toMatch(
      /max-height:\s*calc\(100dvh - var\(--app-chrome-height\) - 16px\);/u,
    );
    expect(responsiveStyles).not.toMatch(/\.floating-panel\s*\{[^}]*top:\s*118px;/u);
  });

  it('does not add a second viewport height to the compact finance shell', () => {
    expect(cssBlock(responsiveStyles, '.app-shell[data-active-role="finance"]')).toMatch(
      /min-height:\s*calc\(100dvh - var\(--app-chrome-height\)\);/u,
    );
    expect(responsiveStyles).not.toContain('padding-bottom: 116px');
    expect(responsiveStyles).toContain('padding-bottom: env(safe-area-inset-bottom, 0px)');
  });

  it('removes press scaling and long transform animation from factory controls', () => {
    expect(cssBlock(tokenStyles, 'button')).not.toMatch(/transform/u);
    expect(cssBlock(tokenStyles, 'button:active:not(:disabled)')).toMatch(/transform:\s*none;/u);
  });

  it('does not repeat delayed scroll jumps after selecting production data', () => {
    expect(appSource).not.toContain('window.setTimeout(scrollOperatorWorkbench, 160)');
    expect(appSource).not.toContain('window.setTimeout(scrollFinanceWorkbench, 160)');
  });

  it('keeps production status feedback immediate and non-pulsing', () => {
    expect(cssBlock(operatorStyles, '.scale-dial-needle')).toMatch(/transition:\s*none;/u);
    expect(cssBlock(listStyles, '.queue-row.is-new-animated')).toMatch(/animation:\s*none;/u);
    expect(cssBlock(responsiveStyles, '.app-shell .action-tile')).not.toMatch(/transform|filter/u);
    expect(responsiveStyles).toMatch(
      /\.app-shell\s+:is\([^)]*\.production-operator-card[^)]*\):active\s*\{[^}]*transform:\s*none;/u,
    );
  });
});
