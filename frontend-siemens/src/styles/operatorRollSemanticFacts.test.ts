import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const operatorStyles = readFileSync(
  new URL('./51-operator-workbench.css', import.meta.url),
  'utf8',
);

describe('operator roll semantic facts', () => {
  it('wraps between parameter entities but never inside a value and unit', () => {
    expect(operatorStyles).toMatch(
      /\.operator-roll-product-summary dl\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(operatorStyles).toMatch(
      /\.operator-roll-product-summary dd\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow-wrap:\s*normal;[^}]*word-break:\s*normal;/u,
    );
  });

  it('keeps the recipe on its own row and wraps only between whole ingredients', () => {
    expect(operatorStyles).toMatch(
      /\.operator-roll-product-summary dl > div\[data-parameter='recipe'\]\s*\{[^}]*flex-basis:\s*100%;[^}]*min-width:\s*0;/u,
    );
    expect(operatorStyles).toMatch(
      /\.operator-roll-recipe-composition\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(operatorStyles).toMatch(
      /\.operator-roll-recipe-composition > span\s*\{[^}]*white-space:\s*nowrap;/u,
    );
  });
});
