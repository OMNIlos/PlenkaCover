import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesEntry = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const baseTokenStyles = readFileSync(new URL('./00-tokens-base.css', import.meta.url), 'utf8');
const recipeStylesUrl = new URL('./24-recipe-editor.css', import.meta.url);
const recipeStyles = existsSync(recipeStylesUrl)
  ? readFileSync(recipeStylesUrl, 'utf8')
  : '';

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

function collectCssRules(source: string): Array<{ selector: string; body: string }> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const rules: Array<{ selector: string; body: string }> = [];
  let cursor = 0;

  while (cursor < withoutComments.length) {
    while (/[\s;]/u.test(withoutComments[cursor] ?? '')) cursor += 1;
    const openingBrace = withoutComments.indexOf('{', cursor);
    if (openingBrace < 0) break;
    const selector = withoutComments.slice(cursor, openingBrace).trim();
    let depth = 0;
    let closingBrace = -1;

    for (let index = openingBrace; index < withoutComments.length; index += 1) {
      if (withoutComments[index] === '{') depth += 1;
      if (withoutComments[index] !== '}') continue;
      depth -= 1;
      if (depth === 0) {
        closingBrace = index;
        break;
      }
    }

    if (closingBrace < 0) break;
    const body = withoutComments.slice(openingBrace + 1, closingBrace);
    if (selector.startsWith('@')) {
      rules.push(...collectCssRules(body));
    } else {
      rules.push({ selector: selector.replace(/\s+/gu, ' '), body });
    }
    cursor = closingBrace + 1;
  }

  return rules;
}

function normalizedBlock(source: string, selector: string) {
  return collectCssRules(source)
    .find((rule) => rule.selector === selector)
    ?.body.replace(/\s+/gu, ' ');
}

describe('recipe editor responsive stylesheet contract', () => {
  it('loads after dialog styles and before broad workbench overrides', () => {
    const dialogIndex = stylesEntry.indexOf(
      "@import './styles/23-action-confirmation-dialog.css';",
    );
    const recipeIndex = stylesEntry.indexOf("@import './styles/24-recipe-editor.css';");
    const workbenchIndex = stylesEntry.indexOf("@import './styles/30-office-workbenches.css';");

    expect(dialogIndex).toBeGreaterThanOrEqual(0);
    expect(recipeIndex).toBeGreaterThan(dialogIndex);
    expect(workbenchIndex).toBeGreaterThan(recipeIndex);
  });

  it('bounds the modal to the workstation viewport with fixed header and footer tracks', () => {
    const modalBlock = normalizedBlock(recipeStyles, '.plenki-modal.recipe-editor');

    expect(modalBlock).toBeDefined();
    expect(modalBlock).toContain('width: min(760px, calc(100vw - 32px));');
    expect(modalBlock).toContain('max-height: calc(100vh - 32px);');
    expect(modalBlock).toContain('grid-template-rows: auto minmax(0, 1fr) auto;');
    expect(modalBlock).toContain('overflow: hidden;');
  });

  it('uses only the recipe body as a vertical scroll root', () => {
    const bodyBlock = normalizedBlock(recipeStyles, '.recipe-editor-body');
    const scrollRules = collectCssRules(recipeStyles).filter((rule) =>
      /\boverflow(?:-[xy])?\s*:\s*(?:auto|scroll)\b/u.test(rule.body),
    );

    expect(bodyBlock).toBeDefined();
    expect(bodyBlock).toContain('min-height: 0;');
    expect(bodyBlock).toContain('overflow-y: auto;');
    expect(bodyBlock).toContain('overflow-x: hidden;');
    expect(scrollRules).toHaveLength(1);
    expect(scrollRules[0]?.selector).toBe('.recipe-editor-body');
  });

  it('keeps actions and long ingredient controls bounded without motion declarations', () => {
    const headActions = normalizedBlock(
      recipeStyles,
      '.recipe-editor-header .plenki-modal-head-actions',
    );
    const ingredient = normalizedBlock(recipeStyles, '.recipe-editor-ingredient');
    const ingredientLabel = normalizedBlock(
      recipeStyles,
      '.recipe-editor-ingredient > label',
    );
    const ingredientControls = normalizedBlock(
      recipeStyles,
      '.recipe-editor-ingredient :where(input, select)',
    );

    expect(headActions).toContain('display: flex;');
    expect(headActions).toContain('flex-wrap: wrap;');
    expect(headActions).toContain('min-width: 0;');
    expect(ingredient).toContain(
      'grid-template-columns: minmax(0, 1fr) minmax(72px, 96px) 36px;',
    );
    expect(ingredient).toContain('min-width: 0;');
    expect(ingredientLabel).toContain('min-width: 0;');
    expect(ingredientLabel).toContain('overflow-wrap: anywhere;');
    expect(ingredientControls).toContain('width: 100%;');
    expect(ingredientControls).toContain('min-width: 0;');
    expect(ingredientControls).toContain('max-width: 100%;');
    expect(recipeStyles).not.toMatch(/\b(?:transition|animation)(?:-[\w-]+)?\s*:/u);
    expect(recipeStyles).not.toMatch(/\bposition\s*:\s*sticky\b/u);
  });

  it('uses only tokens declared by the shared base theme', () => {
    const declaredTokens = new Set(
      Array.from(baseTokenStyles.matchAll(/(--[\w-]+)\s*:/gu), (match) => match[1]),
    );
    const recipeTokens = new Set(
      Array.from(recipeStyles.matchAll(/var\((--[\w-]+)/gu), (match) => match[1]),
    );

    expect([...recipeTokens].filter((token) => !declaredTokens.has(token))).toEqual([]);
  });

  it('stacks ingredient rows at 640px without introducing page-level selectors', () => {
    const narrowBlock = extractCssBlock(recipeStyles, '@media (max-width: 640px)');
    const narrowIngredient = normalizedBlock(
      narrowBlock ?? '',
      '.recipe-editor-ingredient',
    );
    const forbiddenRootSelector =
      /(^|[\s>+~,])(?:html|body|#root|\.app-shell|\.page-shell)(?=$|[\s>+~,.:[#])/u;

    expect(narrowBlock).toBeDefined();
    expect(narrowIngredient).toContain('grid-template-columns: minmax(0, 1fr);');
    for (const rule of collectCssRules(recipeStyles)) {
      expect(rule.selector).not.toMatch(forbiddenRootSelector);
      if (/\boverflow(?:-[xy])?\s*:/u.test(rule.body)) {
        expect(rule.selector).toContain('recipe-editor');
      }
    }
  });
});
