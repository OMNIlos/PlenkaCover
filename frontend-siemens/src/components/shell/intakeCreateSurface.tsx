import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import {
  counterparties,
  counterpartyTemplates,
  counterpartyTemplateVersions,
  templateDisplayName,
  templatesForCounterparty,
} from '../../domain/templates';
import { applyTemplateToIntakeDraft } from '../../domain/intakeTemplates';
import {
  isCommercialMaterialSelectionAvailable,
} from '../../domain/materialRecipeCatalog';
import {
  counterpartyTypeLabel,
  intakeCounterpartyLabel,
  intakeDraftIsComplete,
  intakeHasRequiredPositionFields,
  intakeIncompletePositionReason,
} from '../../domain/prototypeRuntime';
import type { IntakeDraftForm, IntakeDraftPosition, IntakeSubmitMode } from '../../domain/prototypeRuntime';
import type {
  Counterparty,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateVersion,
  CounterpartyType,
  RequestCreatorRole,
} from '../../domain/types';
import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import type { StockProductionTemplate } from '../../api/stockProductionTemplates';
import { applyStockProductionTemplate } from '../../domain/stockProductionTemplates';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import type { CommercialRequestType } from '../../features/commercial/contracts';
import { CounterpartySearchPicker } from './CounterpartySearchPicker';
import { trapFocusWithin } from './focusTrap';
import { hasEffectiveCapability } from '../../domain/accessPolicy';
import { IntakePositionsEditor } from './IntakePositionsEditor';

const NO_TEMPLATE_VALUE = '__new_template__';
const EMPTY_POSITION_IDS: ReadonlySet<string> = new Set();

type CounterpartySheetDraft = {
  type: CounterpartyType;
  name: string;
  inn: string;
  kpp: string;
  ogrn: string;
  legalAddress: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

const counterpartyTypeOptions: Array<{ value: CounterpartyType; label: string }> = [
  { value: 'legal_entity', label: 'Юридическое лицо' },
  { value: 'individual_entrepreneur', label: 'ИП' },
  { value: 'individual', label: 'Физическое лицо' },
];

function counterpartySheetDraftFromValue(value: IntakeDraftForm): CounterpartySheetDraft {
  return {
    type: value.newCounterpartyType,
    name: value.newCounterpartyName,
    inn: value.newCounterpartyInn,
    kpp: value.newCounterpartyKpp,
    ogrn: value.newCounterpartyOgrn,
    legalAddress: value.newCounterpartyLegalAddress,
    contactName: value.newCounterpartyContactName,
    contactPhone: value.newCounterpartyContactPhone,
    contactEmail: value.newCounterpartyContactEmail,
  };
}

export function IntakeCreateSurface({
  value,
  onChange,
  onClose,
  onSubmit,
  creatorRole = 'commercial',
  draftOnly = false,
  counterpartyCatalog = counterparties,
  templateCatalog = counterpartyTemplates,
  templateVersions = counterpartyTemplateVersions,
  templateDraftPositions = {},
  templateCatalogWarning = null,
  templateCatalogRetrying = false,
  onRetryTemplateCatalog = () => undefined,
  onCounterpartySearch,
  counterpartySearchLoading = false,
  counterpartySearchHasMore = false,
  onLoadMoreCounterparties,
  allowCounterpartyCreate = true,
  stockTemplates = [],
  stockTemplateCatalogStatus = 'ready',
  materials = [],
  recipes = [],
  materialCatalogStatus = 'idle',
  materialCatalogError = null,
  onRetryMaterialCatalog = () => undefined,
  onCreateRecipe = () => undefined,
  effectiveCapabilities,
  onMaterialSelectionConfirmed = () => undefined,
  materialSelectionInvalidPositionIds = EMPTY_POSITION_IDS,
  submitting = false,
  requestType = 'client_order',
}: {
  value: IntakeDraftForm;
  onChange: (value: IntakeDraftForm) => void;
  onClose: () => void;
  onSubmit: (mode: IntakeSubmitMode) => void;
  creatorRole?: RequestCreatorRole;
  draftOnly?: boolean;
  counterpartyCatalog?: Counterparty[];
  templateCatalog?: CounterpartyOrderTemplate[];
  templateVersions?: CounterpartyOrderTemplateVersion[];
  templateDraftPositions?: Record<string, IntakeDraftPosition[]>;
  templateCatalogWarning?: string | null;
  templateCatalogRetrying?: boolean;
  onRetryTemplateCatalog?: () => void;
  onCounterpartySearch?: (query: string) => void;
  counterpartySearchLoading?: boolean;
  counterpartySearchHasMore?: boolean;
  onLoadMoreCounterparties?: () => void;
  allowCounterpartyCreate?: boolean;
  stockTemplates?: readonly StockProductionTemplate[];
  stockTemplateCatalogStatus?: 'loading' | 'ready' | 'error';
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  materialCatalogStatus?: MaterialRecipeCatalogStatus;
  materialCatalogError?: string | null;
  onRetryMaterialCatalog?: () => void;
  onCreateRecipe?: (positionId: string) => void;
  effectiveCapabilities?: readonly string[];
  onMaterialSelectionConfirmed?: (positionId: string) => void;
  materialSelectionInvalidPositionIds?: ReadonlySet<string>;
  submitting?: boolean;
  requestType?: CommercialRequestType;
}) {
  const isStockMode = requestType === 'stock_reserve';
  const canCreateRecipe = hasEffectiveCapability(
    effectiveCapabilities,
    'recipe_catalog:create',
  );
  const counterpartyLabelId = useId();
  const counterpartySheetRef = useRef<HTMLElement | null>(null);
  const [isCounterpartySheetOpen, setIsCounterpartySheetOpen] = useState(false);
  const [counterpartySheetDraft, setCounterpartySheetDraft] = useState<CounterpartySheetDraft>(() => counterpartySheetDraftFromValue(value));
  const updateField = <K extends keyof IntakeDraftForm>(field: K, nextValue: IntakeDraftForm[K]) => onChange({ ...value, [field]: nextValue });
  const updateCounterpartySheetDraft = <K extends keyof CounterpartySheetDraft>(field: K, nextValue: CounterpartySheetDraft[K]) =>
    setCounterpartySheetDraft((current) => ({ ...current, [field]: nextValue }));
  const openCounterpartySheet = () => {
    setCounterpartySheetDraft(counterpartySheetDraftFromValue(value));
    setIsCounterpartySheetOpen(true);
  };
  const saveCounterpartySheet = () => {
    const nextName = counterpartySheetDraft.name.trim();
    if (!nextName) return;
    onChange({
      ...value,
      counterparty: '__new__',
      counterpartyId: undefined,
      counterpartyQuickCreateSaved: true,
      newCounterpartyType: counterpartySheetDraft.type,
      newCounterpartyName: nextName,
      newCounterpartyInn: counterpartySheetDraft.inn.trim(),
      newCounterpartyKpp: counterpartySheetDraft.kpp.trim(),
      newCounterpartyOgrn: counterpartySheetDraft.ogrn.trim(),
      newCounterpartyLegalAddress: counterpartySheetDraft.legalAddress.trim(),
      newCounterpartyContactName: counterpartySheetDraft.contactName.trim(),
      newCounterpartyContactPhone: counterpartySheetDraft.contactPhone.trim(),
      newCounterpartyContactEmail: counterpartySheetDraft.contactEmail.trim(),
      templateId: undefined,
      templateVersionId: undefined,
      template: 'Ручной ввод параметров',
    });
    setIsCounterpartySheetOpen(false);
  };
  const updateCounterparty = (nextCounterpartyId: string) => {
    if (nextCounterpartyId === '__create__') {
      openCounterpartySheet();
      return;
    }
    const nextCounterpartyItem = counterpartyCatalog.find(
      (counterparty) => counterparty.id === nextCounterpartyId,
    );
    if (!nextCounterpartyItem) return;
    const nextTemplate = nextCounterpartyItem
      ? templatesForCounterparty(nextCounterpartyItem.id, templateCatalog)[0]
      : undefined;
    const nextValue: IntakeDraftForm = {
      ...value,
      counterparty: nextCounterpartyItem.legalName,
      counterpartyId: nextCounterpartyItem.id,
      counterpartyQuickCreateSaved: false,
      templateId: nextTemplate?.id,
      templateVersionId: undefined,
      template: nextTemplate
        ? templateDisplayName(nextTemplate, templateVersions)
        : 'Ручной ввод параметров',
    };
    onChange(
      nextTemplate
        ? applyTemplateToIntakeDraft(
            nextValue,
            nextTemplate,
            templateVersions,
            templateDraftPositions[nextTemplate.id],
            materialCatalogStatus === 'ready' ? { materials, recipes } : undefined,
          )
        : nextValue,
    );
  };
  const updateTemplate = (templateId: string) => {
    if (templateId === NO_TEMPLATE_VALUE) {
      onChange({
        ...value,
        templateId: undefined,
        templateVersionId: undefined,
        template: 'Ручной ввод параметров',
      });
      return;
    }
    const selectedTemplate = templateCatalog.find((template) => template.id === templateId);
    if (!selectedTemplate) return;
    const applied = applyTemplateToIntakeDraft(
      value,
      selectedTemplate,
      templateVersions,
      templateDraftPositions[templateId],
      materialCatalogStatus === 'ready' ? { materials, recipes } : undefined,
    );
    onChange(applied);
  };
  const handleStockTemplateChange = (templateId: string) => {
    if (!templateId) {
      onChange({ ...value, stockProductionTemplateId: undefined });
      return;
    }
    const selectedTemplate = stockTemplates.find((template) => template.id === templateId);
    if (!selectedTemplate) return;
    onChange(applyStockProductionTemplate(value, selectedTemplate));
  };
  const selectedCounterparty = counterpartyCatalog.find(
    (counterparty) =>
      counterparty.id === value.counterpartyId || counterparty.legalName === value.counterparty,
  );
  const templates = selectedCounterparty
    ? templatesForCounterparty(selectedCounterparty.id, templateCatalog)
    : [];
  const selectedTemplateValue =
    value.templateId && templates.some((template) => template.id === value.templateId)
      ? value.templateId
      : NO_TEMPLATE_VALUE;
  const legalSummary = selectedCounterparty
    ? `ИНН ${selectedCounterparty.inn ?? '[нужен факт]'} · карточка контрагента · реквизиты сверяются отдельно`
    : value.counterparty === '__new__' && value.counterpartyQuickCreateSaved
      ? `${counterpartyTypeLabel(value.newCounterpartyType)} · ИНН ${value.newCounterpartyInn || '[нужен факт]'} · ручной ввод · не синхронизировано`
      : null;
  const hasStaleMaterialSelection = value.positions.some((position) =>
    materialSelectionInvalidPositionIds.has(position.id),
  );
  const materialCatalogReady = materialCatalogStatus === 'ready';
  const unavailableMaterialSelectionIds = new Set(
    materialCatalogReady
      ? value.positions
          .filter(
            (position) =>
              (position.baseRawMaterialDefinitionId ||
                position.recipeDefinitionVersionId) &&
              !isCommercialMaterialSelectionAvailable(
                position,
                materials,
                recipes,
              ),
          )
          .map((position) => position.id)
      : [],
  );
  const hasUnavailableMaterialSelection =
    unavailableMaterialSelectionIds.size > 0;
  const complete =
    materialCatalogReady &&
    (isStockMode ? intakeHasRequiredPositionFields(value) : intakeDraftIsComplete(value)) &&
    !hasStaleMaterialSelection &&
    !hasUnavailableMaterialSelection;
  const disabledReason = !materialCatalogReady
    ? materialCatalogStatus === 'error'
      ? 'Каталог сырья и рецептур недоступен. Повторите загрузку.'
      : 'Дождитесь загрузки каталога сырья и рецептур.'
    : hasStaleMaterialSelection
      ? 'Каталог изменился. Повторно выберите сырьё или рецептуру.'
      : hasUnavailableMaterialSelection
        ? 'Выбранное сырьё или рецептура больше недоступны. Сделайте новый выбор.'
        : !isStockMode && !intakeCounterpartyLabel(value)
          ? 'Не выбран контрагент'
          : !intakeHasRequiredPositionFields(value)
            ? intakeIncompletePositionReason(value) ||
              'Заполните обязательные параметры позиции'
            : '';
  const isProductionLead = creatorRole === 'production_lead';
  const primarySubmitMode: IntakeSubmitMode = draftOnly ? 'draft' : 'order';
  const primarySubmitLabel = draftOnly
    ? 'Создать черновик'
    : isStockMode
      ? 'Произвести на запас'
      : 'Создать заявку';
  const primarySubmitTitle = draftOnly
    ? 'Сохранить во вкладке Черновики'
    : disabledReason ||
      (isStockMode
        ? 'Передать на производство для складского запаса'
        : 'Передать зав. производства');
  const counterpartySheetCanSave = counterpartySheetDraft.name.trim().length > 0;
  useEffect(() => {
    if (!isCounterpartySheetOpen) return;
    const animationFrame = window.requestAnimationFrame(() => {
      counterpartySheetRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isCounterpartySheetOpen]);

  const handleSurfaceKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !isCounterpartySheetOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setIsCounterpartySheetOpen(false);
  };
  const handleCounterpartySheetKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    trapFocusWithin(event);
  };

  return (
      <article className="intake-create-surface" aria-label={isStockMode ? 'Произвести на запас' : 'Создать заявку'} onKeyDownCapture={handleSurfaceKeyDownCapture}>
        <header className="intake-create-header">
          <div>
            <span className="eyebrow">{isStockMode ? 'Коммерция · На запас' : isProductionLead ? 'Зав. производства' : 'Коммерция'}</span>
            <h2 id="intake-modal-title" title={isStockMode ? 'Позиции для производства без клиента и платёжного контура.' : isProductionLead ? 'Заявка требует подтверждения коммерции; рецептура остается в зоне коммерции.' : 'Контрагент и позиции с разными характеристиками.'}>{isStockMode ? 'Произвести на запас' : 'Создать заявку'}</h2>
          </div>
          <button className="drawer-close-button" type="button" disabled={submitting} onClick={onClose} aria-label="Закрыть форму">
            Закрыть
          </button>
        </header>

        <fieldset className="intake-form" disabled={submitting}>
          {!isStockMode && <div className="intake-counterparty-field">
            <span id={counterpartyLabelId}>Контрагент</span>
            <CounterpartySearchPicker
              items={counterpartyCatalog}
              value={
                value.counterparty === '__new__'
                  ? '__new__'
                  : selectedCounterparty?.id ?? value.counterpartyId ?? ''
              }
              labelledBy={counterpartyLabelId}
              selectedLabel={
                value.counterparty === '__new__'
                  ? `Новый: ${value.newCounterpartyName || 'без названия'}`
                  : selectedCounterparty?.legalName || value.counterparty
              }
              onChange={updateCounterparty}
              onSearch={onCounterpartySearch}
              loading={counterpartySearchLoading}
              hasMore={counterpartySearchHasMore}
              onLoadMore={onLoadMoreCounterparties}
              onCreate={allowCounterpartyCreate ? openCounterpartySheet : undefined}
            />
          </div>}
          {!isStockMode && legalSummary ? (
            <div className="intake-form-wide intake-helper-note">
              <ix-icon name="table-settings" size="16" />
              <span>{legalSummary}</span>
            </div>
          ) : null}
          {!isStockMode && value.counterparty === '__new__' && value.counterpartyQuickCreateSaved && (
            <section className="intake-form-wide counterparty-snapshot-card" aria-label="Реквизиты нового контрагента">
              <div>
                <span className="eyebrow">Реквизиты заявки</span>
                <strong>{value.newCounterpartyName}</strong>
                <small>{counterpartyTypeLabel(value.newCounterpartyType)} · ИНН {value.newCounterpartyInn || '[нужен факт]'}</small>
              </div>
              <button type="button" className="secondary-button" onClick={openCounterpartySheet}>Изменить</button>
            </section>
          )}
          {!isStockMode && templateCatalogWarning ? (
            <div className="intake-form-wide intake-material-catalog-error" role="alert">
              <strong>Шаблоны временно недоступны</strong>
              <span>{templateCatalogWarning}</span>
              <button
                type="button"
                disabled={templateCatalogRetrying}
                onClick={onRetryTemplateCatalog}
              >
                {templateCatalogRetrying
                  ? 'Загрузка шаблонов…'
                  : 'Повторить загрузку шаблонов'}
              </button>
            </div>
          ) : null}
          {!isStockMode && <label>
            <span>Шаблон</span>
            <select
              value={selectedTemplateValue}
              disabled={!intakeCounterpartyLabel(value)}
              onChange={(event) => updateTemplate(event.target.value)}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {templateDisplayName(template, templateVersions)}
                </option>
              ))}
              <option value={NO_TEMPLATE_VALUE}>Без шаблона</option>
            </select>
          </label>}
          {isStockMode && (
            <label className="intake-form-wide stock-template-selector">
              <span>Шаблон производства на запас</span>
              <select
                value={value.stockProductionTemplateId ?? ''}
                disabled={stockTemplateCatalogStatus === 'loading'}
                onChange={(event) => handleStockTemplateChange(event.target.value)}
              >
                <option value="">Без шаблона</option>
                {stockTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · v{template.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          <IntakePositionsEditor
            positions={value.positions}
            onChange={(positions) => onChange({ ...value, positions })}
            materials={materials}
            recipes={recipes}
            materialCatalogStatus={materialCatalogStatus}
            materialCatalogError={materialCatalogError}
            onRetryMaterialCatalog={onRetryMaterialCatalog}
            onCreateRecipe={canCreateRecipe ? onCreateRecipe : undefined}
            onMaterialSelectionConfirmed={onMaterialSelectionConfirmed}
            materialSelectionInvalidPositionIds={materialSelectionInvalidPositionIds}
          />
          {!isStockMode && <label className="intake-form-wide intake-checkbox-row">
            <input type="checkbox" checked={value.saveAsTemplate} onChange={(event) => updateField('saveAsTemplate', event.target.checked)} />
            <span>Сохранить набор позиций как шаблон контрагента</span>
          </label>}
          <label className="intake-form-wide">
            <span>Комментарий</span>
            <textarea value={value.comment} rows={3} onChange={(event) => updateField('comment', event.target.value)} />
          </label>
          {!isStockMode && (
            <label className="intake-form-wide">
              <span>Комментарий для бухгалтерии / ориентир цены</span>
              <textarea
                value={value.commercialFinanceNote ?? ''}
                rows={3}
                maxLength={2000}
                placeholder="Например: 1200 за 20 рулонов"
                onChange={(event) => updateField('commercialFinanceNote', event.target.value)}
              />
              <small>
                Свободный комментарий. Сумму счёта бухгалтерия укажет вручную.
              </small>
            </label>
          )}
        </fieldset>

        {!isStockMode && isCounterpartySheetOpen && (
          <div className="counterparty-quick-sheet-backdrop" role="presentation">
            <aside
              ref={counterpartySheetRef}
              className="counterparty-quick-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Быстро создать контрагента"
              tabIndex={-1}
              onKeyDown={handleCounterpartySheetKeyDown}
            >
              <header className="counterparty-quick-sheet-header">
                <div>
                  <span className="eyebrow">Контрагент из заявки</span>
                  <h3 title="Минимальные реквизиты для текущей заявки. Расширенная карточка и синхронизация настраиваются отдельно.">Быстро создать клиента</h3>
                </div>
                <button type="button" className="drawer-close-button" onClick={() => setIsCounterpartySheetOpen(false)} aria-label="Закрыть создание контрагента">
                  Закрыть
                </button>
              </header>

              <div className="counterparty-quick-form">
                <label>
                  <span>Тип</span>
                  <select value={counterpartySheetDraft.type} onChange={(event) => updateCounterpartySheetDraft('type', event.target.value as CounterpartyType)}>
                    {counterpartyTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Название</span>
                  <input value={counterpartySheetDraft.name} onChange={(event) => updateCounterpartySheetDraft('name', event.target.value)} placeholder="ООО Покупатель" />
                </label>
                <label>
                  <span>ИНН</span>
                  <input value={counterpartySheetDraft.inn} onChange={(event) => updateCounterpartySheetDraft('inn', event.target.value)} placeholder="[нужен факт]" />
                </label>
                <label>
                  <span>КПП</span>
                  <input value={counterpartySheetDraft.kpp} onChange={(event) => updateCounterpartySheetDraft('kpp', event.target.value)} placeholder="[нужен факт]" />
                </label>
                <label>
                  <span>ОГРН</span>
                  <input value={counterpartySheetDraft.ogrn} onChange={(event) => updateCounterpartySheetDraft('ogrn', event.target.value)} placeholder="[нужен факт]" />
                </label>
                <label className="counterparty-quick-wide">
                  <span>Юридический адрес</span>
                  <input value={counterpartySheetDraft.legalAddress} onChange={(event) => updateCounterpartySheetDraft('legalAddress', event.target.value)} placeholder="[нужен факт]" />
                </label>
                <label>
                  <span>Контакт</span>
                  <input value={counterpartySheetDraft.contactName} onChange={(event) => updateCounterpartySheetDraft('contactName', event.target.value)} placeholder="Имя" />
                </label>
                <label>
                  <span>Телефон</span>
                  <input value={counterpartySheetDraft.contactPhone} onChange={(event) => updateCounterpartySheetDraft('contactPhone', event.target.value)} placeholder="+7..." />
                </label>
                <label className="counterparty-quick-wide">
                  <span>Email</span>
                  <input value={counterpartySheetDraft.contactEmail} onChange={(event) => updateCounterpartySheetDraft('contactEmail', event.target.value)} placeholder="client@example.com" />
                </label>
              </div>

              <footer className="counterparty-quick-actions">
                <button type="button" className="secondary-button" onClick={() => setIsCounterpartySheetOpen(false)}>Отмена</button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!counterpartySheetCanSave}
                  title={counterpartySheetCanSave ? 'Подставить клиента в заявку' : 'Введите название контрагента'}
                  onClick={saveCounterpartySheet}
                >
                  Сохранить и подставить
                </button>
              </footer>
            </aside>
          </div>
        )}

        <div className="drawer-actions">
          <section className={`intake-create-summary ${complete ? 'state-ready' : 'state-blocked'}`} aria-label="Проверка заявки">
            <div className="intake-create-summary-item">
              <span>{isStockMode ? 'Режим' : 'Контрагент'}</span>
              <strong>{isStockMode ? 'На запас' : intakeCounterpartyLabel(value) || 'Не выбран'}</strong>
            </div>
            <div className="intake-create-summary-item">
              <span>Кто продолжит</span>
              <strong>{draftOnly ? 'Черновики' : isStockMode ? 'Зав. производства' : isProductionLead ? 'Коммерция владеет рецептурой' : 'Зав. производства'}</strong>
            </div>
            {!complete && (
              <div
                className="intake-create-summary-warning"
                role="status"
                title={disabledReason}
              >
                <ix-icon name="warning" size="16" />
                <span>{disabledReason}</span>
              </div>
            )}
          </section>
          {!draftOnly && !isStockMode && !isProductionLead && <button type="button" className="secondary-button" disabled={submitting} onClick={() => onSubmit('draft')}>
            Сохранить черновик
          </button>}
          <button type="button" className="primary-button" disabled={!complete || submitting} title={primarySubmitTitle} onClick={() => onSubmit(primarySubmitMode)}>
            {submitting ? 'Сохранение…' : primarySubmitLabel}
          </button>
        </div>
      </article>
  );
}
