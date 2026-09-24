import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@siemens/ix/dist/siemens-ix/siemens-ix.css';
import { defineCustomElements as defineIxIconCustomElements } from '@siemens/ix-icons/loader';

import { PlenkiModal } from '../../src/components/plenki-ui/PlenkiPrimitives';
import { RecipeEditorModal } from '../../src/features/recipes/RecipeEditorModal';
import { registerPlenkaIcons } from '../../src/icons/registerIcons';
import '../../src/styles.css';

registerPlenkaIcons();
defineIxIconCustomElements();

const longMaterialName =
  'Полиэтилен первичный для длинного производственного наименования ' +
  'с обязательной проверкой переноса внутри узкой строки каталога сырья';

const materials = Array.from({ length: 50 }, (_, index) => ({
  id: `raw-material-${index + 1}`,
  name: index === 0 ? longMaterialName : `Сырье каталога ${index + 1}`,
  kind: index % 2 === 0 ? 'base' : 'custom',
}));

const harnessState = {
  created: [],
  saveCalls: [],
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function projectCommand(command) {
  return {
    name: command.name,
    ingredients: command.ingredients.map((ingredient) => ({
      rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId ?? null,
      newMaterialName: null,
      shareBasisPoints: ingredient.shareBasisPoints,
    })),
  };
}

function createdRecipe(command) {
  return {
    id: 'recipe-harness-created',
    name: command.name,
    version: {
      id: 'recipe-version-harness-created',
      version: 1,
      ingredients: command.ingredients.map((ingredient, index) => ({
        rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
        name:
          materials.find((material) => material.id === ingredient.rawMaterialDefinitionId)?.name ??
          `Сырье ${index + 1}`,
        shareBasisPoints: ingredient.shareBasisPoints,
      })),
    },
  };
}

window.recipeEditorHarness = {
  materials: materials.map((material) => ({ ...material })),
  snapshot() {
    return {
      created: harnessState.created.map((recipe) => ({ ...recipe })),
      saveCalls: harnessState.saveCalls.map((command) => ({
        ...command,
        ingredients: command.ingredients.map((ingredient) => ({ ...ingredient })),
      })),
      outerOpen: document.querySelector('[aria-label="Внешний диалог"]') !== null,
      recipeOpen: document.querySelector('[aria-label="Рецептура"]') !== null,
      activeTestId: document.activeElement?.getAttribute('data-testid') ?? null,
    };
  },
};

function RecipeEditorHarness() {
  const [outerOpen, setOuterOpen] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);

  async function saveRecipe(command) {
    const projected = projectCommand(command);
    harnessState.saveCalls.push(projected);
    await wait(350);
    if (harnessState.saveCalls.length === 1) {
      throw new Error('Harness intentionally rejects the first save.');
    }
    return createdRecipe(command);
  }

  return (
    <main>
      <button type="button" data-testid="outer-trigger" onClick={() => setOuterOpen(true)}>
        Открыть внешний диалог
      </button>

      {outerOpen ? (
        <PlenkiModal
          title="Внешний диалог"
          onClose={() => setOuterOpen(false)}
          footer={
            <button type="button" data-testid="outer-footer-action">
              Внешнее действие
            </button>
          }
        >
          <p>Проверка настоящего вложенного жизненного цикла диалогов.</p>
          <button type="button" data-testid="recipe-trigger" onClick={() => setRecipeOpen(true)}>
            Открыть редактор рецептуры
          </button>

          {recipeOpen ? (
            <RecipeEditorModal
              materials={materials}
              catalogStatus="ready"
              catalogError={null}
              onRetryCatalog={() => {}}
              onSave={saveRecipe}
              onCreated={(recipe) => harnessState.created.push(recipe)}
              onClose={() => setRecipeOpen(false)}
            />
          ) : null}
        </PlenkiModal>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')).render(<RecipeEditorHarness />);
