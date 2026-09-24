import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('./67-operator-payroll.css', import.meta.url), 'utf8');

function extractCssBlock(source: string, prelude: string) {
  const start = source.indexOf(prelude);
  if (start < 0) return undefined;
  const openingBrace = source.indexOf('{', start + prelude.length);
  if (openingBrace < 0) return undefined;

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }

  return undefined;
}

describe('operator payroll responsive layout contract', () => {
  it('uses readable, tabular headline sums', () => {
    const headlineValue = extractCssBlock(styles, '.operator-payroll-headlines dd');

    expect(headlineValue).toMatch(/font-size:\s*clamp\(34px,\s*4\.5vw,\s*48px\);/u);
    expect(headlineValue).toMatch(/font-variant-numeric:\s*tabular-nums;/u);
  });

  it('uses readable, tabular dates', () => {
    const dateInput = extractCssBlock(styles, '.operator-payroll-range input');

    expect(dateInput).toMatch(/font-size:\s*clamp\(18px,\s*1\.6vw,\s*20px\);/u);
    expect(dateInput).toMatch(/font-weight:\s*600;/u);
    expect(dateInput).toMatch(/font-variant-numeric:\s*tabular-nums;/u);
  });

  it('keeps preset button geometry stable when active', () => {
    const presetButton = extractCssBlock(styles, '.operator-payroll-presets button');
    const activePreset = extractCssBlock(styles, '.operator-payroll-presets button.is-active');

    expect(presetButton).toMatch(/min-height:\s*44px;/u);
    expect(presetButton).toMatch(/border:\s*1px solid transparent;/u);
    expect(activePreset).toMatch(/color:/u);
    expect(activePreset).toMatch(/background:/u);
    expect(activePreset).toMatch(/border-color:/u);
    expect(activePreset).not.toMatch(
      /(?:^|[;\s])(?:border(?!-color)[a-z-]*|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|(?:min-|max-)?(?:width|height)|font-size|line-height)\s*:/u,
    );

    const activeProperties = [...(activePreset ?? '').matchAll(/^\s*([a-z-]+)\s*:/gmu)]
      .map((match) => match[1])
      .sort();
    expect(activeProperties).toEqual(['background', 'border-color', 'color']);
  });

  it('keeps the retry button border visible', () => {
    const retryButton = extractCssBlock(styles, '.operator-payroll-error button');

    expect(retryButton).toMatch(/border:\s*1px solid var\(--border-strong\);/u);
  });

  it('stacks headline sums and period controls at the mobile breakpoint', () => {
    const mobileStyles = extractCssBlock(styles, '@media (max-width: 620px)');

    expect(mobileStyles).toMatch(
      /\.operator-payroll-headlines\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(mobileStyles).toMatch(
      /\.operator-payroll-summary\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
    expect(mobileStyles).toMatch(
      /\.operator-payroll-presets,[\s\S]*?\.operator-payroll-range\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/u,
    );
    expect(mobileStyles).toMatch(
      /\.operator-payroll-presets button,[\s\S]*?\.operator-payroll-range label\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/u,
    );
  });
});
