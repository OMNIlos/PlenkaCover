import { useEffect, useMemo, useRef, useState } from 'react';

import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import {
  createStockProductionTemplate,
  fetchStockProductionTemplates,
  updateStockProductionTemplate,
  type StockProductionTemplate,
  type StockProductionTemplatePositionWriteInput,
  type StockProductionTemplateWriteInput,
} from '../../api/stockProductionTemplates';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';

export type TemplateDirectoryMode = 'counterparty' | 'stock';

export function TemplateDirectoryModeTabs({
  mode,
  onChange,
}: {
  mode: TemplateDirectoryMode;
  onChange: (mode: TemplateDirectoryMode) => void;
}) {
  return (
    <div className="template-directory-mode-tabs" role="tablist" aria-label="Тип каталога шаблонов">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'counterparty'}
        className={mode === 'counterparty' ? 'is-active' : ''}
        onClick={() => onChange('counterparty')}
      >
        Клиентские шаблоны
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'stock'}
        className={mode === 'stock' ? 'is-active' : ''}
        onClick={() => onChange('stock')}
      >
        Шаблоны на запас
      </button>
    </div>
  );
}

type PositionDraft = {
  id: string;
  rollCount: string;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm: string;
  plannedLengthM: string;
  materialSelector: string;
  plannedWeightKg: string;
  spoolType: string;
  birka: string;
  manualBirka: string;
  comment: string;
  recipeParameters: Array<{ label: string; value: string }>;
};

type TemplateDraft = {
  templateId: string | null;
  expectedVersion: number | null;
  name: string;
  description: string;
  positions: PositionDraft[];
};

type SaveNotice = { tone: 'success' | 'critical'; message: string } | null;

function emptyPosition(id: string): PositionDraft {
  return {
    id,
    rollCount: '1',
    filmType: '',
    actualThickness: '',
    accountingThickness: '',
    widthMm: '',
    plannedLengthM: '',
    materialSelector: '',
    plannedWeightKg: '',
    spoolType: '',
    birka: '',
    manualBirka: '',
    comment: '',
    recipeParameters: [],
  };
}

function materialSelectorForPosition(
  position: StockProductionTemplate['positions'][number],
): string {
  const materialId = position.baseRawMaterialDefinitionId?.trim();
  const recipeId = position.recipeDefinitionVersionId?.trim();
  if (materialId && !recipeId) return `material:${materialId}`;
  if (recipeId && !materialId) return `recipe:${recipeId}`;
  return '';
}

function draftPosition(
  position: StockProductionTemplate['positions'][number],
  id: string,
): PositionDraft {
  return {
    id,
    rollCount: String(position.rollCount),
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    widthMm: position.widthMm == null ? '' : String(position.widthMm),
    plannedLengthM: position.plannedLengthM == null ? '' : String(position.plannedLengthM),
    materialSelector: materialSelectorForPosition(position),
    plannedWeightKg:
      position.plannedWeightKg === null || position.plannedWeightKg === undefined
        ? ''
        : String(position.plannedWeightKg),
    spoolType: position.spoolType ?? '',
    birka: position.birka ?? '',
    manualBirka: position.manualBirka ?? '',
    comment: position.comment ?? '',
    recipeParameters: position.recipeParameters?.map((parameter) => ({ ...parameter })) ?? [],
  };
}

function selectorIsAvailable(
  selector: string,
  materials: readonly RawMaterialCatalogItem[],
  recipes: readonly RecipeCatalogItem[],
): boolean {
  if (selector.startsWith('material:')) {
    const id = selector.slice('material:'.length);
    return materials.some((material) => material.id === id);
  }
  if (selector.startsWith('recipe:')) {
    const id = selector.slice('recipe:'.length);
    return recipes.some((recipe) => recipe.version.id === id);
  }
  return false;
}

function positionIsValid(
  position: PositionDraft,
  materials: readonly RawMaterialCatalogItem[],
  recipes: readonly RecipeCatalogItem[],
): boolean {
  const rollCount = Number(position.rollCount);
  const widthMm = Number(position.widthMm.trim().replace(',', '.'));
  const plannedLengthM = Number(position.plannedLengthM.trim().replace(',', '.'));
  const plannedWeight = position.plannedWeightKg ? Number(position.plannedWeightKg) : null;
  return (
    Number.isInteger(rollCount) &&
    rollCount >= 1 &&
    position.filmType.trim().length > 0 &&
    position.actualThickness.trim().length > 0 &&
    position.accountingThickness.trim().length > 0 &&
    Number.isFinite(widthMm) &&
    widthMm > 0 &&
    Number.isFinite(plannedLengthM) &&
    plannedLengthM > 0 &&
    selectorIsAvailable(position.materialSelector, materials, recipes) &&
    (plannedWeight === null || (Number.isFinite(plannedWeight) && plannedWeight > 0))
  );
}

function writePosition(position: PositionDraft): StockProductionTemplatePositionWriteInput {
  const selector = position.materialSelector.startsWith('material:')
    ? {
        baseRawMaterialDefinitionId: position.materialSelector.slice('material:'.length),
      }
    : {
        recipeDefinitionVersionId: position.materialSelector.slice('recipe:'.length),
      };
  return {
    rollCount: Number(position.rollCount),
    filmType: position.filmType.trim(),
    actualThickness: position.actualThickness.trim(),
    accountingThickness: position.accountingThickness.trim(),
    widthMm: Number(position.widthMm.trim().replace(',', '.')),
    plannedLengthM: Number(position.plannedLengthM.trim().replace(',', '.')),
    ...selector,
    ...(position.plannedWeightKg ? { plannedWeightKg: Number(position.plannedWeightKg) } : {}),
    ...(position.spoolType.trim() ? { spoolType: position.spoolType.trim() } : {}),
    ...(position.birka.trim() ? { birka: position.birka.trim() } : {}),
    ...(position.manualBirka.trim() ? { manualBirka: position.manualBirka.trim() } : {}),
    ...(position.comment.trim() ? { comment: position.comment.trim() } : {}),
    recipeParameters: position.recipeParameters.map((parameter) => ({ ...parameter })),
  };
}

function writeInput(draft: TemplateDraft): StockProductionTemplateWriteInput {
  return {
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    positions: draft.positions.map(writePosition),
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return 'не использовался';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function upsertTemplate(
  current: StockProductionTemplate[],
  saved: StockProductionTemplate,
): StockProductionTemplate[] {
  const exists = current.some((template) => template.id === saved.id);
  const next = exists
    ? current.map((template) => (template.id === saved.id ? saved : template))
    : [saved, ...current];
  return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function StockProductionTemplateDirectory({
  materials,
  recipes,
  materialCatalogStatus,
  materialCatalogError,
  onRetryMaterialCatalog,
  mode = 'stock',
  onModeChange,
  readOnly = false,
}: {
  materials: readonly RawMaterialCatalogItem[];
  recipes: readonly RecipeCatalogItem[];
  materialCatalogStatus: MaterialRecipeCatalogStatus;
  materialCatalogError: string | null;
  onRetryMaterialCatalog: () => void | Promise<void>;
  mode?: TemplateDirectoryMode;
  onModeChange?: (mode: TemplateDirectoryMode) => void;
  readOnly?: boolean;
}) {
  const nextPositionNumber = useRef(1);
  const requestGeneration = useRef(0);
  const [templates, setTemplates] = useState<StockProductionTemplate[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<TemplateDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SaveNotice>(null);

  function nextPositionId() {
    const id = `stock-template-position-${nextPositionNumber.current}`;
    nextPositionNumber.current += 1;
    return id;
  }

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const controller = new AbortController();
    setTemplates([]);
    setLoadState('loading');
    void fetchStockProductionTemplates({ signal: controller.signal })
      .then((items) => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setTemplates(items);
        setLoadState('ready');
      })
      .catch(() => {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        setTemplates([]);
        setLoadState('error');
      });
    return () => {
      controller.abort();
    };
  }, [reloadGeneration]);

  useEffect(() => {
    if (readOnly) setEditor(null);
  }, [readOnly]);

  const filteredTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru-RU');
    if (!normalized) return templates;
    return templates.filter((template) => {
      const values = [
        template.name,
        template.description ?? '',
        ...template.positions.flatMap((position) => [
          position.filmType,
          position.actualThickness,
          position.accountingThickness,
        ]),
      ];
      return values.some((value) => value.toLocaleLowerCase('ru-RU').includes(normalized));
    });
  }, [query, templates]);

  const saveDisabled =
    readOnly ||
    !editor ||
    saving ||
    materialCatalogStatus !== 'ready' ||
    editor.name.trim().length === 0 ||
    editor.positions.length === 0 ||
    editor.positions.some((position) => !positionIsValid(position, materials, recipes));

  function openCreate() {
    if (readOnly) return;
    setNotice(null);
    setEditor({
      templateId: null,
      expectedVersion: null,
      name: '',
      description: '',
      positions: [emptyPosition(nextPositionId())],
    });
  }

  function openEdit(template: StockProductionTemplate) {
    if (readOnly) return;
    setNotice(null);
    setEditor({
      templateId: template.id,
      expectedVersion: template.version,
      name: template.name,
      description: template.description ?? '',
      positions: template.positions.map((position) => draftPosition(position, nextPositionId())),
    });
  }

  function updatePosition(
    positionId: string,
    field: Exclude<keyof PositionDraft, 'id' | 'recipeParameters'>,
    value: string,
  ) {
    setEditor((current) =>
      current
        ? {
            ...current,
            positions: current.positions.map((position) =>
              position.id === positionId ? { ...position, [field]: value } : position,
            ),
          }
        : current,
    );
  }

  function addPosition() {
    setEditor((current) =>
      current
        ? { ...current, positions: [...current.positions, emptyPosition(nextPositionId())] }
        : current,
    );
  }

  function duplicatePosition(positionId: string) {
    setEditor((current) => {
      if (!current) return current;
      const source = current.positions.find((position) => position.id === positionId);
      if (!source) return current;
      return {
        ...current,
        positions: [
          ...current.positions,
          {
            ...source,
            id: nextPositionId(),
            recipeParameters: source.recipeParameters.map((parameter) => ({ ...parameter })),
          },
        ],
      };
    });
  }

  function deletePosition(positionId: string) {
    setEditor((current) =>
      current && current.positions.length > 1
        ? {
            ...current,
            positions: current.positions.filter((position) => position.id !== positionId),
          }
        : current,
    );
  }

  async function saveTemplate() {
    if (readOnly || !editor || saveDisabled) return;
    setSaving(true);
    setNotice(null);
    try {
      const input = writeInput(editor);
      const saved =
        editor.templateId && editor.expectedVersion
          ? await updateStockProductionTemplate(editor.templateId, {
              ...input,
              expectedVersion: editor.expectedVersion,
            })
          : await createStockProductionTemplate(input);
      setTemplates((current) => upsertTemplate(current, saved));
      setEditor(null);
      setNotice({
        tone: 'success',
        message: editor.templateId ? 'Шаблон обновлён.' : 'Шаблон создан.',
      });
    } catch (error) {
      setNotice({
        tone: 'critical',
        message: error instanceof Error ? error.message : 'Не удалось сохранить шаблон.',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="stock-template-directory" aria-label="Шаблоны производства на запас">
      {onModeChange ? <TemplateDirectoryModeTabs mode={mode} onChange={onModeChange} /> : null}
      <header className="stock-template-directory-header">
        <div>
          <span className="eyebrow">Зав. производства</span>
          <h2>Шаблоны на запас</h2>
          <p>Общий каталог для повторяемого заполнения производственных позиций.</p>
        </div>
        {!readOnly ? (
          <button className="create-intake-button" type="button" onClick={openCreate}>
            Добавить шаблон на запас
          </button>
        ) : null}
      </header>

      {readOnly ? (
        <div className="stock-template-read-only" role="status">
          <strong>Каталог доступен только для просмотра</strong>
          <span>Создание и изменение шаблонов недоступны.</span>
        </div>
      ) : null}

      {notice ? (
        <div
          className={`stock-template-notice tone-${notice.tone}`}
          role={notice.tone === 'critical' ? 'alert' : 'status'}
        >
          {notice.message}
        </div>
      ) : null}

      <div className="stock-template-directory-toolbar">
        <label>
          <span>Поиск шаблона</span>
          <input
            aria-label="Поиск шаблонов на запас"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Название, плёнка или толщина"
          />
        </label>
        <span>{filteredTemplates.length} шабл.</span>
        <button type="button" onClick={() => setReloadGeneration((value) => value + 1)}>
          Обновить каталог
        </button>
      </div>

      {loadState === 'loading' ? (
        <div className="stock-template-load-state" role="status">
          Загружаем шаблоны…
        </div>
      ) : null}
      {loadState === 'error' ? (
        <div className="stock-template-load-state is-error" role="alert">
          <span>Не удалось загрузить каталог шаблонов.</span>
          <button type="button" onClick={() => setReloadGeneration((value) => value + 1)}>
            Повторить
          </button>
        </div>
      ) : null}

      <div className="stock-template-directory-grid">
        <section className="stock-template-card-list" aria-label="Список шаблонов на запас">
          {loadState === 'ready' && filteredTemplates.length === 0 ? (
            <div className="stock-template-empty" role="status">
              {query.trim()
                ? 'Шаблоны не найдены. Измените поисковый запрос.'
                : readOnly
                  ? 'Шаблонов пока нет.'
                  : 'Шаблонов пока нет. Создайте первый шаблон на запас.'}
            </div>
          ) : null}
          {loadState === 'ready'
            ? filteredTemplates.map((template) => (
                <article key={template.id} className="stock-template-card">
                  <div className="stock-template-card-heading">
                    <div>
                      <h3>{template.name}</h3>
                      {template.description ? <p>{template.description}</p> : null}
                    </div>
                    <span className="stock-template-version">v{template.version}</span>
                  </div>
                  <div className="stock-template-card-metrics">
                    <span>
                      <strong>{template.positions.length}</strong>
                      <small>позиций</small>
                    </span>
                    <span>
                      <strong>{template.usageCount}</strong>
                      <small>применений</small>
                    </span>
                    <span>
                      <strong>{formatDateTime(template.updatedAt)}</strong>
                      <small>изменён</small>
                    </span>
                    <span>
                      <strong>{formatDateTime(template.lastUsedAt)}</strong>
                      <small>использован</small>
                    </span>
                  </div>
                  {!readOnly ? (
                    <button type="button" onClick={() => openEdit(template)}>
                      Редактировать
                    </button>
                  ) : null}
                </article>
              ))
            : null}
        </section>
      </div>

      {editor && !readOnly ? (
        <PlenkiModal
          className="stock-template-editor-modal"
          headerClassName="stock-template-editor-header"
          bodyClassName="stock-template-editor-body"
          footerClassName="stock-template-editor-actions"
          eyebrow={editor.templateId ? `Версия ${editor.expectedVersion}` : 'Новый шаблон'}
          title={
            editor.templateId ? 'Редактирование шаблона на запас' : 'Создание шаблона на запас'
          }
          onClose={() => setEditor(null)}
          footer={
            <>
              <button type="button" onClick={addPosition}>
                Добавить тип рулона
              </button>
              <button
                className="create-intake-button"
                type="button"
                disabled={saveDisabled}
                onClick={saveTemplate}
              >
                {saving ? 'Сохраняем…' : 'Сохранить шаблон'}
              </button>
            </>
          }
        >
          <div className="stock-template-main-fields">
            <label>
              <span>Название</span>
              <input
                autoFocus
                aria-label="Название шаблона на запас"
                value={editor.name}
                onChange={(event) =>
                  setEditor((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </label>
            <label>
              <span>Описание</span>
              <textarea
                aria-label="Описание шаблона на запас"
                value={editor.description}
                onChange={(event) =>
                  setEditor((current) =>
                    current ? { ...current, description: event.target.value } : current,
                  )
                }
              />
            </label>
          </div>

          {materialCatalogStatus === 'error' ? (
            <div className="stock-template-catalog-warning" role="alert">
              <span>
                {materialCatalogError ?? 'Не удалось загрузить каталог сырья и рецептур.'}
              </span>
              <button type="button" onClick={() => void onRetryMaterialCatalog()}>
                Обновить каталог
              </button>
            </div>
          ) : null}

          <div className="stock-template-position-list">
            {editor.positions.map((position, index) => {
              const number = index + 1;
              const selectorAvailable = selectorIsAvailable(
                position.materialSelector,
                materials,
                recipes,
              );
              return (
                <fieldset key={position.id} className="stock-template-position">
                  <legend>Тип рулона {number}</legend>
                  <div className="stock-template-position-actions">
                    <button
                      type="button"
                      aria-label={`Дублировать позицию ${number}`}
                      onClick={() => duplicatePosition(position.id)}
                    >
                      Дублировать тип
                    </button>
                    <button
                      type="button"
                      aria-label={`Удалить позицию ${number}`}
                      disabled={editor.positions.length === 1}
                      onClick={() => deletePosition(position.id)}
                    >
                      Удалить тип
                    </button>
                  </div>
                  <div className="stock-template-position-fields">
                    <label>
                      <span>Рулоны</span>
                      <input
                        aria-label={`Количество рулонов, позиция ${number}`}
                        inputMode="numeric"
                        value={position.rollCount}
                        onChange={(event) =>
                          updatePosition(position.id, 'rollCount', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Тип плёнки</span>
                      <input
                        aria-label={`Тип плёнки, позиция ${number}`}
                        value={position.filmType}
                        onChange={(event) =>
                          updatePosition(position.id, 'filmType', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Фактическая толщина</span>
                      <input
                        aria-label={`Фактическая толщина, позиция ${number}`}
                        value={position.actualThickness}
                        onChange={(event) =>
                          updatePosition(position.id, 'actualThickness', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Бухгалтерская толщина</span>
                      <input
                        aria-label={`Бухгалтерская толщина, позиция ${number}`}
                        value={position.accountingThickness}
                        onChange={(event) =>
                          updatePosition(position.id, 'accountingThickness', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Ширина, мм</span>
                      <input
                        aria-label={`Ширина, мм, позиция ${number}`}
                        inputMode="decimal"
                        value={position.widthMm}
                        onChange={(event) =>
                          updatePosition(position.id, 'widthMm', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Метраж, м</span>
                      <input
                        aria-label={`Метраж, м, позиция ${number}`}
                        inputMode="decimal"
                        value={position.plannedLengthM}
                        onChange={(event) =>
                          updatePosition(position.id, 'plannedLengthM', event.target.value)
                        }
                      />
                    </label>
                    <label className="stock-template-material-field">
                      <span>Материал или рецептура</span>
                      <select
                        aria-label={`Материал, позиция ${number}`}
                        value={position.materialSelector}
                        onChange={(event) =>
                          updatePosition(position.id, 'materialSelector', event.target.value)
                        }
                      >
                        <option value="">Выберите материал</option>
                        {!selectorAvailable && position.materialSelector ? (
                          <option value={position.materialSelector}>
                            Недоступно — выберите заново
                          </option>
                        ) : null}
                        <optgroup label="Базовое сырьё">
                          {materials.map((material) => (
                            <option key={material.id} value={`material:${material.id}`}>
                              {material.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Рецептуры">
                          {recipes.map((recipe) => (
                            <option key={recipe.version.id} value={`recipe:${recipe.version.id}`}>
                              {recipe.name} · v{recipe.version.version}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                      {!selectorAvailable && position.materialSelector ? (
                        <small>Материал недоступен. Выберите актуальный вариант.</small>
                      ) : null}
                    </label>
                    <label>
                      <span>Плановый вес, кг</span>
                      <input
                        aria-label={`Плановый вес, позиция ${number}`}
                        inputMode="decimal"
                        value={position.plannedWeightKg}
                        onChange={(event) =>
                          updatePosition(position.id, 'plannedWeightKg', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Шпуля</span>
                      <input
                        aria-label={`Шпуля, позиция ${number}`}
                        value={position.spoolType}
                        onChange={(event) =>
                          updatePosition(position.id, 'spoolType', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Бирка</span>
                      <input
                        aria-label={`Бирка, позиция ${number}`}
                        value={position.birka}
                        onChange={(event) =>
                          updatePosition(position.id, 'birka', event.target.value)
                        }
                      />
                    </label>
                    <label>
                      <span>Ручная бирка</span>
                      <input
                        aria-label={`Ручная бирка, позиция ${number}`}
                        value={position.manualBirka}
                        onChange={(event) =>
                          updatePosition(position.id, 'manualBirka', event.target.value)
                        }
                      />
                    </label>
                    <label className="stock-template-comment-field">
                      <span>Комментарий</span>
                      <textarea
                        aria-label={`Комментарий, позиция ${number}`}
                        value={position.comment}
                        onChange={(event) =>
                          updatePosition(position.id, 'comment', event.target.value)
                        }
                      />
                    </label>
                  </div>
                </fieldset>
              );
            })}
          </div>
        </PlenkiModal>
      ) : null}
    </article>
  );
}
