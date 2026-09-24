import { useReducer, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import type {
  CreateRecipeCatalogCommand,
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import { PlenkiModal } from '../../components/plenki-ui/PlenkiPrimitives';
import type { MaterialRecipeCatalogStatus } from './useMaterialRecipeCatalog';
import {
  createRecipeDraft,
  percentTextToBasisPoints,
  recipeEditorReducer,
  toCreateRecipeCommand,
  validateRecipeDraft,
  type RecipeEditorErrors,
  type RecipeEditorRowErrors,
} from './recipeEditorState';

export type RecipeEditorModalProps = {
  materials: readonly RawMaterialCatalogItem[];
  catalogStatus: MaterialRecipeCatalogStatus;
  catalogError: string | null;
  onRetryCatalog(): void;
  onSave(
    input: Omit<CreateRecipeCatalogCommand, 'clientRequestId'>,
  ): Promise<RecipeCatalogItem>;
  onCreated(recipe: RecipeCatalogItem): void;
  onClose(): void;
};

export type RecipeSaveErrorPresentation = {
  field: 'name' | 'material' | 'form';
  message: string;
};

export function recipeSaveErrorPresentation(
  error: unknown,
): RecipeSaveErrorPresentation {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'RECIPE_NAME_CONFLICT':
        return {
          field: 'name',
          message: 'Рецептура с таким названием уже существует.',
        };
      case 'RAW_MATERIAL_NAME_CONFLICT':
        return {
          field: 'form',
          message: 'Каталог сырья изменился. Обновите его и повторите сохранение.',
        };
      case 'RAW_MATERIAL_DEFINITION_UNAVAILABLE':
      case 'RECIPE_COMPONENT_STALE':
        return {
          field: 'material',
          message: 'Сырье больше недоступно. Обновите каталог и выберите другое.',
        };
      case 'RECIPE_CATALOG_CONFLICT':
        return {
          field: 'form',
          message: 'Каталог изменился. Проверьте состав и повторите сохранение.',
        };
      case 'INVALID_RECIPE_CATALOG_REQUEST':
        return {
          field: 'form',
          message: 'Проверьте название, сырье и сумму долей.',
        };
    }
  }
  return {
    field: 'form',
    message: 'Не удалось сохранить рецептуру. Проверьте соединение и повторите.',
  };
}

function mergeRowError(
  clientError: RecipeEditorRowErrors | undefined,
  serverError: RecipeSaveErrorPresentation | null,
): RecipeEditorRowErrors {
  return {
    ...clientError,
    ...(serverError?.field === 'material'
      ? { material: serverError.message }
      : {}),
  };
}

function rowErrorId(rowId: string, field: keyof RecipeEditorRowErrors): string {
  return `recipe-editor-${rowId}-${field}-error`;
}

function totalPercentText(
  values: readonly { sharePercentText: string }[],
): string {
  const total = values.reduce(
    (sum, row) => sum + (percentTextToBasisPoints(row.sharePercentText) ?? 0),
    0,
  );
  const whole = Math.floor(total / 100);
  const decimal = String(total % 100).padStart(2, '0').replace(/0+$/u, '');
  return decimal ? `${whole},${decimal}` : String(whole);
}

export function RecipeEditorModal({
  materials,
  catalogStatus,
  catalogError,
  onRetryCatalog,
  onSave,
  onCreated,
  onClose,
}: RecipeEditorModalProps) {
  const [draft, dispatch] = useReducer(recipeEditorReducer, undefined, createRecipeDraft);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] =
    useState<RecipeSaveErrorPresentation | null>(null);
  const savingRef = useRef(false);
  const seenMaterialsRef = useRef(new Map<string, RawMaterialCatalogItem>());

  for (const material of materials) {
    seenMaterialsRef.current.set(material.id, material);
  }

  const validation = validateRecipeDraft(draft, materials);
  const clientErrors: RecipeEditorErrors =
    attempted && !validation.valid ? validation.errors : {};
  const availableIds = new Set(materials.map((material) => material.id));

  function mutate(action: Parameters<typeof recipeEditorReducer>[1]) {
    if (savingRef.current) return;
    setServerError(null);
    dispatch(action);
  }

  function requestClose() {
    if (!savingRef.current) onClose();
  }

  async function submit() {
    if (savingRef.current) return;
    setAttempted(true);
    setServerError(null);
    const result = validateRecipeDraft(draft, materials);
    if (!result.valid) return;

    savingRef.current = true;
    setSaving(true);
    try {
      const recipe = await onSave(toCreateRecipeCommand(draft, materials));
      onCreated(recipe);
      onClose();
    } catch (error) {
      setServerError(recipeSaveErrorPresentation(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const catalogFailed = catalogStatus === 'error' && catalogError !== null;
  const catalogMessage =
    materials.length === 0
      ? 'Каталог сырья недоступен.'
      : 'Не удалось обновить каталог сырья.';

  return (
    <PlenkiModal
      title="Рецептура"
      className="recipe-editor"
      headerClassName="recipe-editor-header"
      bodyClassName="recipe-editor-body"
      footerClassName="recipe-editor-footer"
      onClose={requestClose}
      footer={
        <>
          <button type="button" disabled={saving} onClick={requestClose}>
            Отмена
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving}
            aria-busy={saving || undefined}
            onClick={() => void submit()}
          >
            {saving ? 'Сохранение…' : 'Сохранить рецептуру'}
          </button>
        </>
      }
    >
      <label className="recipe-editor-name">
        <span>Название рецептуры</span>
        <input
          autoFocus
          type="text"
          value={draft.name}
          maxLength={120}
          disabled={saving}
          aria-invalid={Boolean(clientErrors.name || serverError?.field === 'name')}
          aria-describedby={
            clientErrors.name || serverError?.field === 'name'
              ? 'recipe-editor-name-error'
              : undefined
          }
          onChange={(event) =>
            mutate({ type: 'set_name', value: event.currentTarget.value })
          }
        />
        {clientErrors.name || serverError?.field === 'name' ? (
          <small id="recipe-editor-name-error" role="alert">
            {serverError?.field === 'name'
              ? serverError.message
              : clientErrors.name}
          </small>
        ) : null}
      </label>

      {catalogStatus === 'loading' && materials.length === 0 ? (
        <p role="status">Загружаем каталог сырья…</p>
      ) : null}
      {catalogFailed ? (
        <div className="recipe-editor-catalog-error" role="alert">
          <span>{catalogMessage}</span>
          <button type="button" disabled={saving} onClick={onRetryCatalog}>
            Повторить
          </button>
        </div>
      ) : null}

      {clientErrors.ingredientCount ? (
        <p role="alert">{clientErrors.ingredientCount}</p>
      ) : null}

      <div className="recipe-editor-ingredients">
        {draft.ingredients.map((row, index) => {
          const isActive = row.id === draft.activeIngredientId;
          const selectedMaterial =
            row.rawMaterialDefinitionId
              ? seenMaterialsRef.current.get(row.rawMaterialDefinitionId)
              : undefined;
          const isStale =
            row.rawMaterialDefinitionId.length > 0 &&
            !availableIds.has(row.rawMaterialDefinitionId);
          const staleError: RecipeEditorRowErrors | undefined = isStale
            ? { material: 'Выбранное сырье больше недоступно.' }
            : undefined;
          const rowErrors = mergeRowError(
            attempted ? clientErrors.rows?.[row.id] : staleError,
            serverError,
          );
          const materialError = rowErrors.material;
          const shareError = rowErrors.share;

          return (
            <div
              key={row.id}
              className={`recipe-editor-ingredient ${isActive ? 'is-active' : ''}`.trim()}
              data-ingredient-id={row.id}
              data-active={isActive || undefined}
              onClick={() => mutate({ type: 'activate', ingredientId: row.id })}
              onFocus={() => mutate({ type: 'activate', ingredientId: row.id })}
            >
              <label>
                <span>Сырье</span>
                <select
                  value={row.rawMaterialDefinitionId}
                  disabled={
                    saving ||
                    (catalogStatus === 'loading' && materials.length === 0)
                  }
                  aria-invalid={Boolean(materialError)}
                  aria-describedby={
                    materialError ? rowErrorId(row.id, 'material') : undefined
                  }
                  onChange={(event) =>
                    mutate({
                      type: 'select_existing',
                      ingredientId: row.id,
                      rawMaterialDefinitionId: event.currentTarget.value,
                    })
                  }
                >
                  <option value="" disabled>
                    Выберите сырье
                  </option>
                  {isStale ? (
                    <option value={row.rawMaterialDefinitionId} disabled>
                      {selectedMaterial?.name ?? row.rawMaterialDefinitionId}{' '}
                      (недоступно)
                    </option>
                  ) : null}
                  {materials.map((material) => (
                    <option key={material.id} value={material.id}>
                      {material.name}
                    </option>
                  ))}
                </select>
                {materialError ? (
                  <small id={rowErrorId(row.id, 'material')} role="alert">
                    {materialError}
                  </small>
                ) : null}
              </label>

              <label>
                <span>%</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={row.sharePercentText}
                  disabled={saving}
                  aria-invalid={Boolean(shareError)}
                  aria-describedby={
                    shareError ? rowErrorId(row.id, 'share') : undefined
                  }
                  onChange={(event) =>
                    mutate({
                      type: 'set_share',
                      ingredientId: row.id,
                      value: event.currentTarget.value,
                    })
                  }
                />
                {shareError ? (
                  <small id={rowErrorId(row.id, 'share')} role="alert">
                    {shareError}
                  </small>
                ) : null}
              </label>

              <button
                type="button"
                className="plenki-icon-button"
                aria-label={`Удалить компонент ${index + 1}`}
                disabled={saving || draft.ingredients.length === 1}
                onClick={() => mutate({ type: 'remove', ingredientId: row.id })}
              >
                <ix-icon name="trashcan" size="16" />
                <span className="sr-only">Удалить компонент {index + 1}</span>
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        className="secondary-button recipe-editor-add-product"
        disabled={saving || draft.ingredients.length >= 50}
        onClick={() => mutate({ type: 'add_existing' })}
      >
        Добавить продукт +
      </button>

      <div className="recipe-editor-total" aria-live="polite">
        <span>Итого: {totalPercentText(draft.ingredients)}%</span>
        {clientErrors.total ? <small role="alert">{clientErrors.total}</small> : null}
      </div>

      {serverError?.field === 'form' ? (
        <p className="recipe-editor-submit-error" role="alert">
          {serverError.message}
        </p>
      ) : null}
    </PlenkiModal>
  );
}
