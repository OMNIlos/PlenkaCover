import { useState, type FormEvent } from 'react';
import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import {
  COMMERCIAL_PLANNED_WEIGHT_ERROR,
  parseCommercialPlannedWeightKg,
} from '../../domain/commercialPlannedWeight';
import type { CommercialOrderPositionContract } from './contracts';
import { formatCommercialQuantity } from './commercialPresentation';

const DEFAULT_AMENDMENT_REASON = 'Параметры заявки изменены коммерцией';

export type CommercialPositionUpdateCommand = {
  expectedVersion: number;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  widthMm: number;
  plannedLengthM: number;
  baseRawMaterialDefinitionId?: string | null;
  recipeDefinitionVersionId?: string | null;
  plannedWeightKg?: number;
  spoolType: string;
  birka: string;
  manualBirka: string;
  comment: string;
};

type CommercialPositionCreateFields = Omit<
  CommercialPositionUpdateCommand,
  'expectedVersion' | 'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
>;

export type CommercialPositionCreateCommand = CommercialPositionCreateFields &
  (
    | {
        baseRawMaterialDefinitionId: string;
        recipeDefinitionVersionId?: never;
      }
    | {
        recipeDefinitionVersionId: string;
        baseRawMaterialDefinitionId?: never;
      }
  );

export type CommercialOrderPositionsProps = {
  positions: CommercialOrderPositionContract[];
  editable: boolean;
  amendable?: boolean;
  lockReason?: 'invoice_issued' | null;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  onUpdate?: (positionId: string, command: CommercialPositionUpdateCommand) => Promise<boolean>;
  onAmend?: (
    positionId: string,
    command: CommercialPositionUpdateCommand,
    reason: string,
  ) => Promise<boolean>;
  onAdd?: (command: CommercialPositionCreateCommand, reason: string) => Promise<boolean>;
};

export function CommercialOrderPositions({
  positions,
  editable,
  amendable = false,
  lockReason = null,
  materials = [],
  recipes = [],
  onUpdate,
  onAmend,
  onAdd,
}: CommercialOrderPositionsProps) {
  const [editor, setEditor] = useState<{
    positionId: string;
    expectedVersion: number;
    rollCount: string;
    filmType: string;
    actualThickness: string;
    accountingThickness: string;
    widthMm: string;
    plannedLengthM: string;
    materialSelection: string;
    initialMaterialSelection: string;
    plannedWeightKg: string;
    spoolType: string;
    birka: string;
    manualBirka: string;
    comment: string;
    reason: string;
  } | null>(null);
  const [addEditor, setAddEditor] = useState<{
    rollCount: string;
    filmType: string;
    actualThickness: string;
    accountingThickness: string;
    widthMm: string;
    plannedLengthM: string;
    materialSelection: string;
    plannedWeightKg: string;
    spoolType: string;
    birka: string;
    manualBirka: string;
    comment: string;
    reason: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const editStatus =
    editable || amendable
      ? 'Параметры доступны'
      : lockReason === 'invoice_issued'
        ? 'Параметры закрыты после выставления счёта'
        : 'Редактирование заблокировано';

  const materialSelectionFor = (position?: CommercialOrderPositionContract) =>
    typeof position?.baseRawMaterialDefinitionId === 'string'
      ? `base:${position.baseRawMaterialDefinitionId}`
      : typeof position?.recipeDefinitionVersionId === 'string'
        ? `recipe:${position.recipeDefinitionVersionId}`
        : '';

  const openEditor = (position: CommercialOrderPositionContract) => {
    const materialSelection =
      materialSelectionFor(position) ||
      (typeof position.rawMaterialId === 'string' ? `legacy:${position.rawMaterialId}` : '');
    setEditor({
      positionId: position.id,
      expectedVersion: position.version,
      rollCount: String(position.rollCount),
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      widthMm: position.widthMm == null ? '' : String(position.widthMm),
      plannedLengthM: position.plannedLengthM == null ? '' : String(position.plannedLengthM),
      materialSelection,
      initialMaterialSelection: materialSelection,
      plannedWeightKg: position.plannedWeightKg === null ? '' : String(position.plannedWeightKg),
      spoolType: position.spoolType ?? '',
      birka: position.birka ?? '',
      manualBirka: position.manualBirka ?? '',
      comment: position.comment ?? '',
      reason: '',
    });
    setEditorError(null);
  };

  const updateEditor = (field: keyof NonNullable<typeof editor>, value: string) => {
    setEditor((current) => (current ? { ...current, [field]: value } : current));
  };

  const openAddEditor = () => {
    const source = positions[0];
    setAddEditor({
      rollCount: '1',
      filmType: source?.filmType ?? '',
      actualThickness: source?.actualThickness ?? '',
      accountingThickness: source?.accountingThickness ?? '',
      widthMm: source?.widthMm == null ? '' : String(source.widthMm),
      plannedLengthM: source?.plannedLengthM == null ? '' : String(source.plannedLengthM),
      materialSelection: materialSelectionFor(source),
      plannedWeightKg: source?.plannedWeightKg == null ? '' : String(source.plannedWeightKg),
      spoolType: source?.spoolType ?? '',
      birka: source?.birka ?? '',
      manualBirka: source?.manualBirka ?? '',
      comment: source?.comment ?? '',
      reason: '',
    });
    setEditor(null);
    setEditorError(null);
  };

  const updateAddEditor = (field: keyof NonNullable<typeof addEditor>, value: string) => {
    setAddEditor((current) => (current ? { ...current, [field]: value } : current));
  };

  const submitEditor = async (
    event: FormEvent<HTMLFormElement>,
    position: CommercialOrderPositionContract,
  ) => {
    event.preventDefault();
    if (!editor || editor.positionId !== position.id || (!onUpdate && !onAmend) || submitting)
      return;

    const rollCount = Number(editor.rollCount);
    const widthMm = Number(editor.widthMm.trim().replace(',', '.'));
    const plannedLengthM = Number(editor.plannedLengthM.trim().replace(',', '.'));
    const plannedWeightKg = parseCommercialPlannedWeightKg(editor.plannedWeightKg);
    const [materialKind, materialId] = editor.materialSelection.split(':', 2);
    if (!Number.isInteger(rollCount) || rollCount < 1) {
      setEditorError('Количество рулонов должно быть целым числом от 1.');
      return;
    }
    if (
      !editor.filmType.trim() ||
      !editor.actualThickness.trim() ||
      !editor.accountingThickness.trim() ||
      !editor.spoolType.trim() ||
      (!editor.birka.trim() && !editor.manualBirka.trim())
    ) {
      setEditorError('Заполните тип плёнки, обе толщины, шпулю и бирку.');
      return;
    }
    if (
      !Number.isFinite(widthMm) ||
      widthMm <= 0 ||
      !Number.isFinite(plannedLengthM) ||
      plannedLengthM <= 0
    ) {
      setEditorError('Укажите ширину и метраж больше нуля.');
      return;
    }
    const catalogMaterialSelected =
      Boolean(materialId) && (materialKind === 'base' || materialKind === 'recipe');
    const unchangedLegacyMaterial =
      Boolean(materialId) &&
      materialKind === 'legacy' &&
      editor.materialSelection === editor.initialMaterialSelection;
    if (!catalogMaterialSelected && !unchangedLegacyMaterial) {
      setEditorError('Выберите сырьё или сохранённую рецептуру.');
      return;
    }
    if (plannedWeightKg === null) {
      setEditorError(COMMERCIAL_PLANNED_WEIGHT_ERROR);
      return;
    }
    setSubmitting(true);
    setEditorError(null);
    const command: CommercialPositionUpdateCommand = {
      expectedVersion: editor.expectedVersion,
      rollCount,
      filmType: editor.filmType.trim(),
      actualThickness: editor.actualThickness.trim(),
      accountingThickness: editor.accountingThickness.trim(),
      widthMm,
      plannedLengthM,
      ...(editor.materialSelection !== editor.initialMaterialSelection
        ? {
            baseRawMaterialDefinitionId: materialKind === 'base' ? materialId : null,
            recipeDefinitionVersionId: materialKind === 'recipe' ? materialId : null,
          }
        : {}),
      plannedWeightKg,
      spoolType: editor.spoolType.trim(),
      birka: editor.birka.trim(),
      manualBirka: editor.manualBirka.trim(),
      comment: editor.comment.trim(),
    };
    const saved =
      editable && onUpdate
        ? await onUpdate(position.id, command)
        : onAmend
          ? await onAmend(position.id, command, editor.reason.trim() || DEFAULT_AMENDMENT_REASON)
          : false;
    setSubmitting(false);
    if (saved) setEditor(null);
  };

  const submitAddEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!addEditor || !onAdd || submitting) return;
    const rollCount = Number(addEditor.rollCount);
    const widthMm = Number(addEditor.widthMm.trim().replace(',', '.'));
    const plannedLengthM = Number(addEditor.plannedLengthM.trim().replace(',', '.'));
    const plannedWeightKg = parseCommercialPlannedWeightKg(addEditor.plannedWeightKg);
    const [materialKind, materialId] = addEditor.materialSelection.split(':', 2);
    if (!Number.isInteger(rollCount) || rollCount < 1) {
      setEditorError('Количество рулонов должно быть целым числом от 1.');
      return;
    }
    if (
      !addEditor.filmType.trim() ||
      !addEditor.actualThickness.trim() ||
      !addEditor.accountingThickness.trim() ||
      !addEditor.spoolType.trim() ||
      (!addEditor.birka.trim() && !addEditor.manualBirka.trim())
    ) {
      setEditorError('Заполните тип плёнки, обе толщины, шпулю и бирку.');
      return;
    }
    if (
      !Number.isFinite(widthMm) ||
      widthMm <= 0 ||
      !Number.isFinite(plannedLengthM) ||
      plannedLengthM <= 0 ||
      plannedWeightKg === null
    ) {
      setEditorError(
        !Number.isFinite(widthMm) ||
          widthMm <= 0 ||
          !Number.isFinite(plannedLengthM) ||
          plannedLengthM <= 0
          ? 'Укажите ширину и метраж больше нуля.'
          : COMMERCIAL_PLANNED_WEIGHT_ERROR,
      );
      return;
    }
    if (!materialId || (materialKind !== 'base' && materialKind !== 'recipe')) {
      setEditorError('Выберите сырьё или сохранённую рецептуру.');
      return;
    }
    if (!addEditor.reason.trim()) {
      setEditorError('Укажите причину добавления позиции.');
      return;
    }

    const common: CommercialPositionCreateFields = {
      rollCount,
      filmType: addEditor.filmType.trim(),
      actualThickness: addEditor.actualThickness.trim(),
      accountingThickness: addEditor.accountingThickness.trim(),
      widthMm,
      plannedLengthM,
      plannedWeightKg,
      spoolType: addEditor.spoolType.trim(),
      birka: addEditor.birka.trim(),
      manualBirka: addEditor.manualBirka.trim(),
      comment: addEditor.comment.trim(),
    };
    const command: CommercialPositionCreateCommand =
      materialKind === 'base'
        ? { ...common, baseRawMaterialDefinitionId: materialId }
        : { ...common, recipeDefinitionVersionId: materialId };
    setSubmitting(true);
    setEditorError(null);
    const saved = await onAdd(command, addEditor.reason.trim());
    setSubmitting(false);
    if (saved) setAddEditor(null);
  };

  return (
    <section className="commercial-order-positions" aria-labelledby="commercial-positions-title">
      <header>
        <h3 id="commercial-positions-title">Позиции</h3>
        <span>{editStatus}</span>
        {amendable && onAdd && !addEditor && (
          <button type="button" onClick={openAddEditor}>
            Добавить позицию
          </button>
        )}
      </header>
      {addEditor && (
        <form
          className="commercial-position-editor commercial-position-add-editor"
          onSubmit={(event) => void submitAddEditor(event)}
        >
          <h4>Новая позиция</h4>
          <label>
            <span>Количество рулонов</span>
            <input
              aria-label="Новая позиция — количество рулонов"
              type="number"
              min="1"
              value={addEditor.rollCount}
              onChange={(event) => updateAddEditor('rollCount', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Тип плёнки</span>
            <input
              aria-label="Новая позиция — тип плёнки"
              value={addEditor.filmType}
              onChange={(event) => updateAddEditor('filmType', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Фактическая толщина</span>
            <input
              aria-label="Новая позиция — фактическая толщина"
              value={addEditor.actualThickness}
              onChange={(event) => updateAddEditor('actualThickness', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Учётная толщина</span>
            <input
              aria-label="Новая позиция — учётная толщина"
              value={addEditor.accountingThickness}
              onChange={(event) =>
                updateAddEditor('accountingThickness', event.currentTarget.value)
              }
            />
          </label>
          <label>
            <span>Ширина, мм</span>
            <input
              aria-label="Новая позиция — ширина, мм"
              type="number"
              min="0.001"
              max="100000"
              step="0.001"
              value={addEditor.widthMm}
              onChange={(event) => updateAddEditor('widthMm', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Метраж, м</span>
            <input
              aria-label="Новая позиция — метраж, м"
              type="number"
              min="0.001"
              max="10000000"
              step="0.001"
              value={addEditor.plannedLengthM}
              onChange={(event) => updateAddEditor('plannedLengthM', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Сырьё / рецептура</span>
            <select
              aria-label="Новая позиция — сырьё / рецептура"
              value={addEditor.materialSelection}
              onChange={(event) => updateAddEditor('materialSelection', event.currentTarget.value)}
            >
              <option value="">Выберите</option>
              <optgroup label="Сырьё">
                {materials.map((material) => (
                  <option key={material.id} value={`base:${material.id}`}>
                    {material.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Сохранённые рецептуры">
                {recipes.map((recipe) => (
                  <option key={recipe.version.id} value={`recipe:${recipe.version.id}`}>
                    {recipe.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label>
            <span>Плановый вес, кг</span>
            <input
              aria-label="Новая позиция — плановый вес, кг"
              type="text"
              inputMode="decimal"
              min="0.001"
              max="100000"
              step="0.001"
              autoComplete="off"
              value={addEditor.plannedWeightKg}
              onChange={(event) =>
                updateAddEditor('plannedWeightKg', event.currentTarget.value.replace(',', '.'))
              }
            />
          </label>
          <label>
            <span>Шпуля</span>
            <input
              aria-label="Новая позиция — шпуля"
              value={addEditor.spoolType}
              onChange={(event) => updateAddEditor('spoolType', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Стандартная бирка</span>
            <input
              aria-label="Новая позиция — стандартная бирка"
              value={addEditor.birka}
              onChange={(event) => updateAddEditor('birka', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Ручная бирка</span>
            <input
              aria-label="Новая позиция — ручная бирка"
              value={addEditor.manualBirka}
              onChange={(event) => updateAddEditor('manualBirka', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Комментарий</span>
            <textarea
              aria-label="Новая позиция — комментарий"
              value={addEditor.comment}
              onChange={(event) => updateAddEditor('comment', event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Причина добавления</span>
            <textarea
              aria-label="Причина добавления позиции"
              value={addEditor.reason}
              onChange={(event) => updateAddEditor('reason', event.currentTarget.value)}
            />
          </label>
          {editorError && <p role="alert">{editorError}</p>}
          <footer>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setAddEditor(null);
                setEditorError(null);
              }}
            >
              Отмена
            </button>
            <button type="submit" disabled={submitting}>
              {submitting ? 'Добавляем…' : 'Добавить позицию'}
            </button>
          </footer>
        </form>
      )}
      <ol className="commercial-position-list">
        {positions.map((position, index) => (
          <li key={position.id}>
            <header>
              <span>Позиция {index + 1}</span>
              <strong>{position.filmType}</strong>
              <small>{position.rollCount} рул.</small>
              {(editable || amendable) &&
                (onUpdate || onAmend) &&
                editor?.positionId !== position.id && (
                  <button type="button" onClick={() => openEditor(position)}>
                    Изменить параметры
                  </button>
                )}
            </header>
            <dl>
              <div>
                <dt>Фактическая толщина</dt>
                <dd>{position.actualThickness}</dd>
              </div>
              <div>
                <dt>Учётная толщина</dt>
                <dd>{position.accountingThickness}</dd>
              </div>
              <div>
                <dt>Ширина</dt>
                <dd>{formatCommercialQuantity(position.widthMm ?? null, 'мм', 'Не указана')}</dd>
              </div>
              <div>
                <dt>Метраж</dt>
                <dd>
                  {formatCommercialQuantity(position.plannedLengthM ?? null, 'м', 'Не указан')}
                </dd>
              </div>
              <div>
                <dt>Сырьё</dt>
                <dd>
                  {position.recipe?.recipeName ||
                    (position.rawMaterialId ? 'Назначено' : 'Не назначено')}
                </dd>
              </div>
              <div>
                <dt>Плановый вес</dt>
                <dd>{formatCommercialQuantity(position.plannedWeightKg, 'кг', 'Не указан')}</dd>
              </div>
              <div>
                <dt>Шпуля</dt>
                <dd>{position.spoolType || 'Не указана'}</dd>
              </div>
              <div>
                <dt>Стандартная бирка</dt>
                <dd>{position.birka || 'Не указана'}</dd>
              </div>
              <div>
                <dt>Ручная бирка</dt>
                <dd>{position.manualBirka || 'Не указана'}</dd>
              </div>
              <div>
                <dt>Со склада</dt>
                <dd>{position.coveredQty} рул.</dd>
              </div>
              <div>
                <dt>В производство</dt>
                <dd>{position.productionQty} рул.</dd>
              </div>
              <div>
                <dt>Выполнено</dt>
                <dd>{position.fulfilledQty} рул.</dd>
              </div>
            </dl>
            {(editable || amendable) &&
              (onUpdate || onAmend) &&
              editor?.positionId === position.id && (
                <form
                  className="commercial-position-editor"
                  onSubmit={(event) => void submitEditor(event, position)}
                >
                  <label>
                    <span>Количество рулонов</span>
                    <input
                      aria-label="Количество рулонов"
                      type="number"
                      min="1"
                      max="10000"
                      value={editor.rollCount}
                      onChange={(event) => updateEditor('rollCount', event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Тип плёнки</span>
                    <input
                      aria-label="Тип плёнки"
                      value={editor.filmType}
                      onChange={(event) => updateEditor('filmType', event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Фактическая толщина</span>
                    <input
                      aria-label="Фактическая толщина"
                      value={editor.actualThickness}
                      onChange={(event) =>
                        updateEditor('actualThickness', event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    <span>Учётная толщина</span>
                    <input
                      aria-label="Учётная толщина"
                      value={editor.accountingThickness}
                      onChange={(event) =>
                        updateEditor('accountingThickness', event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    <span>Ширина, мм</span>
                    <input
                      aria-label="Ширина, мм"
                      type="number"
                      min="0.001"
                      max="100000"
                      step="0.001"
                      value={editor.widthMm}
                      onChange={(event) => updateEditor('widthMm', event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Метраж, м</span>
                    <input
                      aria-label="Метраж, м"
                      type="number"
                      min="0.001"
                      max="10000000"
                      step="0.001"
                      value={editor.plannedLengthM}
                      onChange={(event) =>
                        updateEditor('plannedLengthM', event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    <span>Сырьё / рецептура</span>
                    <select
                      aria-label="Сырьё / рецептура"
                      value={editor.materialSelection}
                      onChange={(event) =>
                        updateEditor('materialSelection', event.currentTarget.value)
                      }
                    >
                      {editor.initialMaterialSelection.startsWith('legacy:') && (
                        <option value={editor.initialMaterialSelection}>
                          Текущее сырьё — оставить без изменения
                        </option>
                      )}
                      <option value="">Выберите</option>
                      <optgroup label="Сырьё">
                        {materials.map((material) => (
                          <option key={material.id} value={`base:${material.id}`}>
                            {material.name}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Сохранённые рецептуры">
                        {recipes.map((recipe) => (
                          <option key={recipe.version.id} value={`recipe:${recipe.version.id}`}>
                            {recipe.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                  <label>
                    <span>Плановый вес, кг</span>
                    <input
                      aria-label="Плановый вес, кг"
                      type="text"
                      inputMode="decimal"
                      min="0.001"
                      max="100000"
                      step="0.001"
                      autoComplete="off"
                      value={editor.plannedWeightKg}
                      onChange={(event) =>
                        updateEditor('plannedWeightKg', event.currentTarget.value.replace(',', '.'))
                      }
                    />
                  </label>
                  <label>
                    <span>Шпуля</span>
                    <input
                      aria-label="Шпуля"
                      value={editor.spoolType}
                      onChange={(event) => updateEditor('spoolType', event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Бирка</span>
                    <input
                      aria-label="Бирка"
                      value={editor.birka}
                      onChange={(event) => updateEditor('birka', event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    <span>Ручная бирка</span>
                    <input
                      aria-label="Ручная бирка"
                      value={editor.manualBirka}
                      onChange={(event) => updateEditor('manualBirka', event.currentTarget.value)}
                    />
                  </label>
                  <label className="commercial-position-editor-comment">
                    <span>Комментарий (необязательно)</span>
                    <textarea
                      aria-label="Комментарий"
                      value={editor.comment}
                      onChange={(event) => updateEditor('comment', event.currentTarget.value)}
                    />
                  </label>
                  {!editable && amendable && (
                    <label className="commercial-position-editor-comment">
                      <span>Причина изменения (необязательно)</span>
                      <textarea
                        aria-label="Причина изменения"
                        value={editor.reason}
                        onChange={(event) => updateEditor('reason', event.currentTarget.value)}
                      />
                    </label>
                  )}
                  {editorError && <p role="alert">{editorError}</p>}
                  <footer>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => {
                        setEditor(null);
                        setEditorError(null);
                      }}
                    >
                      Отмена
                    </button>
                    <button type="submit" disabled={submitting}>
                      {submitting ? 'Сохраняем…' : 'Сохранить параметры'}
                    </button>
                  </footer>
                </form>
              )}
          </li>
        ))}
      </ol>
    </section>
  );
}
