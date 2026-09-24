import { useState } from 'react';

import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import {
  applyCommercialMaterialSelector,
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
  commercialMaterialSelectorValueForPosition,
  encodeBaseMaterialSelectorValue,
  encodeRecipeSelectorValue,
  isCommercialMaterialSelectionAvailable,
} from '../../domain/materialRecipeCatalog';
import {
  createIntakeDraftPosition,
  intakePositionLineSummary,
  type IntakeDraftPosition,
} from '../../domain/prototypeRuntime';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';

const MAX_POSITIONS = 100;
const EMPTY_POSITION_IDS: ReadonlySet<string> = new Set();

export function IntakePositionsEditor({
  positions,
  onChange,
  ariaLabel = 'Позиции заявки',
  materials = [],
  recipes = [],
  materialCatalogStatus = 'idle',
  materialCatalogError = null,
  onRetryMaterialCatalog = () => undefined,
  onCreateRecipe,
  onMaterialSelectionConfirmed = () => undefined,
  materialSelectionInvalidPositionIds = EMPTY_POSITION_IDS,
}: {
  positions: IntakeDraftPosition[];
  onChange: (positions: IntakeDraftPosition[]) => void;
  ariaLabel?: string;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  materialCatalogStatus?: MaterialRecipeCatalogStatus;
  materialCatalogError?: string | null;
  onRetryMaterialCatalog?: () => void;
  onCreateRecipe?: (positionId: string) => void;
  onMaterialSelectionConfirmed?: (positionId: string) => void;
  materialSelectionInvalidPositionIds?: ReadonlySet<string>;
}) {
  const [materialSearchByPosition, setMaterialSearchByPosition] = useState<
    Record<string, string>
  >({});
  const catalogReady = materialCatalogStatus === 'ready';
  const unavailableMaterialSelectionIds = new Set(
    catalogReady
      ? positions
          .filter(
            (position) =>
              (position.baseRawMaterialDefinitionId || position.recipeDefinitionVersionId) &&
              !isCommercialMaterialSelectionAvailable(position, materials, recipes),
          )
          .map((position) => position.id)
      : [],
  );
  const atLimit = positions.length >= MAX_POSITIONS;
  const updatePosition = <K extends keyof IntakeDraftPosition>(
    positionId: string,
    field: K,
    value: IntakeDraftPosition[K],
  ) =>
    onChange(
      positions.map((position) =>
        position.id === positionId ? { ...position, [field]: value } : position,
      ),
    );
  const updateMaterial = (positionId: string, value: string) => {
    onChange(
      positions.map((position) =>
        position.id === positionId
          ? applyCommercialMaterialSelector(position, value, materials, recipes)
          : position,
      ),
    );
    onMaterialSelectionConfirmed(positionId);
  };
  const addPosition = () => {
    if (atLimit) return;
    onChange([...positions, createIntakeDraftPosition(positions.length + 1)]);
  };
  const duplicatePosition = (position: IntakeDraftPosition) => {
    if (atLimit) return;
    const materialSelectionNeedsReset =
      materialSelectionInvalidPositionIds.has(position.id) ||
      (catalogReady &&
        (position.baseRawMaterialDefinitionId || position.recipeDefinitionVersionId) &&
        !isCommercialMaterialSelectionAvailable(position, materials, recipes));
    onChange([
      ...positions,
      {
        ...position,
        id: `pos-copy-${Date.now()}-${positions.length + 1}`,
        rollCount: position.rollCount || '1',
        ...(materialSelectionNeedsReset
          ? {
              rawMaterial: '',
              rawMaterialId: '',
              baseRawMaterialDefinitionId: '',
              recipeDefinitionVersionId: '',
            }
          : {}),
      },
    ]);
  };
  const removePosition = (positionId: string) => {
    if (positions.length <= 1) return;
    onChange(positions.filter((position) => position.id !== positionId));
  };
  const materialIsVisible = (
    position: IntakeDraftPosition,
    optionName: string,
    optionValue: string,
  ) => {
    const query = (materialSearchByPosition[position.id] ?? '')
      .trim()
      .normalize('NFKC')
      .toLocaleLowerCase('ru-RU');
    return (
      !query ||
      optionName.normalize('NFKC').toLocaleLowerCase('ru-RU').includes(query) ||
      commercialMaterialSelectorValueForPosition(position) === optionValue
    );
  };

  return (
    <section className="intake-positions-editor" aria-label={ariaLabel}>
      <div className="intake-positions-header">
        <div>
          <span className="eyebrow">{ariaLabel}</span>
          <h3>
            {positions.length} поз. ·{' '}
            {positions.reduce(
              (total, position) => total + Math.max(0, Number(position.rollCount) || 0),
              0,
            )}{' '}
            рул. всего
          </h3>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={atLimit}
          title={atLimit ? 'В одном шаблоне или заявке допускается не более 100 позиций' : ''}
          onClick={addPosition}
        >
          Добавить позицию
        </button>
      </div>
      {materialCatalogStatus === 'error' ? (
        <div className="intake-material-catalog-error" role="alert">
          <strong>Не удалось загрузить сырьё и рецептуры</strong>
          {materialCatalogError ? <span>{materialCatalogError}</span> : null}
          <button type="button" onClick={onRetryMaterialCatalog}>
            Повторить загрузку
          </button>
        </div>
      ) : null}
      <div className="intake-position-list">
        {positions.map((position, index) => (
          <article key={position.id} className="intake-position-card">
            <header className="intake-position-card-header">
              <div>
                <h4>Позиция {index + 1}</h4>
                <p>{intakePositionLineSummary(position, index)}</p>
              </div>
              <div className="intake-position-actions">
                {onCreateRecipe ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onCreateRecipe(position.id)}
                  >
                    Создать рецептуру
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={atLimit}
                  onClick={() => duplicatePosition(position)}
                >
                  Дублировать
                </button>
                <button
                  type="button"
                  disabled={positions.length <= 1}
                  title={
                    positions.length <= 1
                      ? 'Должна остаться хотя бы одна позиция'
                      : 'Удалить позицию'
                  }
                  onClick={() => removePosition(position.id)}
                >
                  Удалить
                </button>
              </div>
            </header>
            <div className="intake-position-grid">
              <label>
                <span>Количество рулонов</span>
                <input
                  aria-label={`Количество рулонов, позиция ${index + 1}`}
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  value={position.rollCount}
                  onChange={(event) =>
                    updatePosition(position.id, 'rollCount', event.target.value)
                  }
                />
              </label>
              <label>
                <span>Фактическая толщина</span>
                <input
                  aria-label={`Фактическая толщина, позиция ${index + 1}`}
                  maxLength={50}
                  value={position.actualThickness}
                  placeholder="80 мкм"
                  onChange={(event) =>
                    updatePosition(position.id, 'actualThickness', event.target.value)
                  }
                />
              </label>
              <label>
                <span>Бухгалтерская толщина</span>
                <input
                  aria-label={`Бухгалтерская толщина, позиция ${index + 1}`}
                  maxLength={50}
                  value={position.accountingThickness}
                  placeholder="78 мкм"
                  onChange={(event) =>
                    updatePosition(position.id, 'accountingThickness', event.target.value)
                  }
                />
              </label>
              <label>
                <span>Ширина, мм</span>
                <input
                  aria-label={`Ширина, мм, позиция ${index + 1}`}
                  type="number"
                  min="0.001"
                  max="100000"
                  step="0.001"
                  value={position.widthMm}
                  onChange={(event) => updatePosition(position.id, 'widthMm', event.target.value)}
                />
              </label>
              <label>
                <span>Метраж, м</span>
                <input
                  aria-label={`Метраж, м, позиция ${index + 1}`}
                  type="number"
                  min="0.001"
                  max="10000000"
                  step="0.001"
                  value={position.plannedLengthM}
                  onChange={(event) =>
                    updatePosition(position.id, 'plannedLengthM', event.target.value)
                  }
                />
              </label>
              <label>
                <span>Тип пленки</span>
                <select
                  aria-label={`Тип пленки, позиция ${index + 1}`}
                  value={position.filmType}
                  onChange={(event) => updatePosition(position.id, 'filmType', event.target.value)}
                >
                  {!position.filmType ? <option value="">Выберите тип</option> : null}
                  {COMMERCIAL_FILM_TYPES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Вес</span>
                <input
                  aria-label={`Вес, позиция ${index + 1}`}
                  type="number"
                  min="0.001"
                  max="100000"
                  step="0.001"
                  value={position.plannedWeightKg}
                  onChange={(event) =>
                    updatePosition(position.id, 'plannedWeightKg', event.target.value)
                  }
                />
              </label>
              <label>
                <span>Бирка</span>
                <select
                  aria-label={`Бирка, позиция ${index + 1}`}
                  value={position.birka}
                  onChange={(event) => updatePosition(position.id, 'birka', event.target.value)}
                >
                  {!position.birka ? <option value="">Выберите бирку</option> : null}
                  {COMMERCIAL_BIRKA_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Ручная бирка</span>
                <input
                  aria-label={`Ручная бирка, позиция ${index + 1}`}
                  maxLength={200}
                  value={position.manualBirka}
                  placeholder="Если справочника мало"
                  onChange={(event) =>
                    updatePosition(position.id, 'manualBirka', event.target.value)
                  }
                />
              </label>
              <div className="intake-material-selector">
                <label htmlFor={`intake-material-selector-${position.id}`}>
                  <span>Рецептуры</span>
                </label>
                <input
                  type="search"
                  aria-label={`Поиск рецептур, позиция ${index + 1}`}
                  placeholder="Поиск продукта или рецептуры"
                  value={materialSearchByPosition[position.id] ?? ''}
                  disabled={
                    materialCatalogStatus === 'loading' || materialCatalogStatus === 'refreshing'
                  }
                  onChange={(event) =>
                    setMaterialSearchByPosition((current) => ({
                      ...current,
                      [position.id]: event.target.value,
                    }))
                  }
                />
                <select
                  id={`intake-material-selector-${position.id}`}
                  aria-label={`Рецептуры, позиция ${index + 1}`}
                  value={
                    materialSelectionInvalidPositionIds.has(position.id) ||
                    unavailableMaterialSelectionIds.has(position.id)
                      ? ''
                      : commercialMaterialSelectorValueForPosition(position)
                  }
                  disabled={
                    materialCatalogStatus === 'loading' || materialCatalogStatus === 'refreshing'
                  }
                  onChange={(event) => updateMaterial(position.id, event.target.value)}
                >
                  <option value="" disabled>
                    Выберите продукт или рецептуру
                  </option>
                  <optgroup label="Базовые продукты">
                    {materials
                      .filter((material) =>
                        materialIsVisible(
                          position,
                          material.name,
                          encodeBaseMaterialSelectorValue(material.id),
                        ),
                      )
                      .map((material) => (
                        <option
                          key={material.id}
                          value={encodeBaseMaterialSelectorValue(material.id)}
                        >
                          {material.name}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="Сохранённые рецептуры">
                    {recipes
                      .filter((recipe) =>
                        materialIsVisible(
                          position,
                          recipe.name,
                          encodeRecipeSelectorValue(recipe.version.id),
                        ),
                      )
                      .map((recipe) => (
                        <option
                          key={recipe.version.id}
                          value={encodeRecipeSelectorValue(recipe.version.id)}
                        >
                          {recipe.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </div>
              <label>
                <span>Шпуля</span>
                <select
                  aria-label={`Шпуля, позиция ${index + 1}`}
                  value={position.spoolType}
                  onChange={(event) => updatePosition(position.id, 'spoolType', event.target.value)}
                >
                  {!position.spoolType ? <option value="">Выберите шпулю</option> : null}
                  {COMMERCIAL_SPOOL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="intake-position-comment">
                <span>Комментарий позиции</span>
                <textarea
                  aria-label={`Комментарий, позиция ${index + 1}`}
                  maxLength={1000}
                  value={position.comment}
                  rows={2}
                  onChange={(event) => updatePosition(position.id, 'comment', event.target.value)}
                />
              </label>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
