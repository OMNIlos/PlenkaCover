import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import type { RawMaterialCatalogItem, RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import {
  fetchStockProductionTemplates,
  type StockProductionTemplate,
} from '../../api/stockProductionTemplates';
import { IntakeCreateSurface } from '../../components/shell/intakeCreateSurface';
import {
  COMMERCIAL_ORDER_CATALOG_STALE_MESSAGE,
  isCommercialOrderCatalogStaleCode,
} from '../../domain/materialRecipeCatalog';
import type {
  IntakeDraftForm,
  IntakeDraftPosition,
  IntakeSubmitMode,
} from '../../domain/prototypeRuntime';
import type {
  Counterparty,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateField,
  CounterpartyOrderTemplateVersion,
  RequestCreatorRole,
} from '../../domain/types';
import type { MaterialRecipeCatalogStatus } from '../recipes/useMaterialRecipeCatalog';
import type { CommercialRequestType, CommercialTemplatePositionContract } from './contracts';
import {
  createCommercialOrderFromIntake,
  fetchCommercialTemplates,
  searchCommercialCounterparties,
  type CommercialCounterpartyContract,
  type CommercialCreateOrderResult,
  type CommercialIntakeTemplateContract,
} from './api';

export type CommercialIntakeState = {
  form: IntakeDraftForm;
  clientRequestId: string;
  status: 'idle' | 'submitting' | 'error';
  error: string | null;
};

export type CommercialIntakeAction =
  | { type: 'form_changed'; form: IntakeDraftForm }
  | { type: 'submission_started' }
  | { type: 'submission_failed'; message: string }
  | { type: 'submission_succeeded'; nextClientRequestId: string };

const COUNTERPARTY_SEARCH_DEBOUNCE_MS = 250;

export function createEmptyCommercialIntakeDraft(): IntakeDraftForm {
  return {
    counterparty: '',
    counterpartyId: undefined,
    counterpartyQuickCreateSaved: false,
    newCounterpartyType: 'legal_entity',
    newCounterpartyName: '',
    newCounterpartyInn: '',
    newCounterpartyKpp: '',
    newCounterpartyOgrn: '',
    newCounterpartyLegalAddress: '',
    newCounterpartyContactName: '',
    newCounterpartyContactPhone: '',
    newCounterpartyContactEmail: '',
    templateId: undefined,
    template: '',
    positions: [
      {
        id: 'commercial-position-1',
        rollCount: '1',
        micronPreset: 'manual',
        micronCustom: '',
        actualThickness: '',
        accountingThickness: '',
        filmType: '',
        widthMm: '',
        plannedLengthM: '',
        plannedWeightKg: '',
        birka: '',
        manualBirka: '',
        comment: '',
        rawMaterial: '',
        rawMaterialId: '',
        baseRawMaterialDefinitionId: '',
        recipeDefinitionVersionId: '',
        spoolType: '',
      },
    ],
    comment: '',
    commercialFinanceNote: '',
    saveAsTemplate: false,
    assignedOperatorId: '',
    priority: 'обычный',
  };
}

export function createCommercialIntakeState(
  form: IntakeDraftForm,
  clientRequestId = createClientRequestId(),
): CommercialIntakeState {
  return { form, clientRequestId, status: 'idle', error: null };
}

export function commercialIntakeReducer(
  state: CommercialIntakeState,
  action: CommercialIntakeAction,
): CommercialIntakeState {
  if (action.type === 'form_changed') {
    return state.status === 'submitting'
      ? state
      : { ...state, form: action.form, error: null, status: 'idle' };
  }
  if (action.type === 'submission_started') {
    return { ...state, status: 'submitting', error: null };
  }
  if (action.type === 'submission_failed') {
    return { ...state, status: 'error', error: action.message };
  }
  return {
    ...state,
    clientRequestId: action.nextClientRequestId,
    status: 'idle',
    error: null,
  };
}

export function CommercialIntakeForm({
  value,
  onChange,
  onClose,
  onCreated,
  onSubmittingChange,
  creatorRole = 'commercial',
  draftOnly = false,
  materials = [],
  recipes = [],
  materialCatalogStatus = 'idle',
  materialCatalogError = null,
  onReloadMaterialCatalog = async () => undefined,
  onCreateRecipe = () => undefined,
  effectiveCapabilities,
  requestType = 'client_order',
}: {
  value: IntakeDraftForm;
  onChange: (form: IntakeDraftForm) => void;
  onClose: () => void;
  onCreated: (order: CommercialCreateOrderResult, mode: 'draft' | 'submit') => void;
  onSubmittingChange?: (submitting: boolean) => void;
  creatorRole?: RequestCreatorRole;
  draftOnly?: boolean;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  materialCatalogStatus?: MaterialRecipeCatalogStatus;
  materialCatalogError?: string | null;
  onReloadMaterialCatalog?: () => Promise<void>;
  onCreateRecipe?: (positionId: string) => void;
  effectiveCapabilities?: readonly string[];
  requestType?: CommercialRequestType;
}) {
  const [state, dispatch] = useReducer(commercialIntakeReducer, value, (initialForm) =>
    createCommercialIntakeState(initialForm),
  );
  const [counterparties, setCounterparties] = useState<CommercialCounterpartyContract[]>([]);
  const [templates, setTemplates] = useState<CommercialIntakeTemplateContract[]>([]);
  const [stockTemplates, setStockTemplates] = useState<StockProductionTemplate[]>([]);
  const [stockCatalogStatus, setStockCatalogStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [stockCatalogError, setStockCatalogError] = useState<string | null>(null);
  const [stockCatalogRevision, setStockCatalogRevision] = useState(0);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogInitialized, setCatalogInitialized] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [counterpartyQuery, setCounterpartyQuery] = useState('');
  const [counterpartyNextCursor, setCounterpartyNextCursor] = useState<string | null>(null);
  const [templateCatalogStatus, setTemplateCatalogStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [templateCatalogError, setTemplateCatalogError] = useState<string | null>(null);
  const [templateCatalogRevision, setTemplateCatalogRevision] = useState(0);
  const [materialSelectionInvalidPositionIds, setMaterialSelectionInvalidPositionIds] = useState<
    Set<string>
  >(() => new Set());
  const submissionPendingRef = useRef(false);
  const previousExternalFormRef = useRef(value);
  const counterpartyRequestRef = useRef(0);
  const counterpartyAbortRef = useRef<AbortController | null>(null);
  const selectedCounterpartyIdRef = useRef(state.form.counterpartyId);
  selectedCounterpartyIdRef.current = state.form.counterpartyId;

  useEffect(() => {
    const previous = previousExternalFormRef.current;
    setMaterialSelectionInvalidPositionIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const position of value.positions) {
        const prior = previous.positions.find((item) => item.id === position.id);
        if (
          prior &&
          (prior.baseRawMaterialDefinitionId !== position.baseRawMaterialDefinitionId ||
            prior.recipeDefinitionVersionId !== position.recipeDefinitionVersionId)
        ) {
          next.delete(position.id);
        }
      }
      return next;
    });
    previousExternalFormRef.current = value;
    dispatch({ type: 'form_changed', form: value });
  }, [value]);

  useEffect(() => {
    const controller = new AbortController();
    counterpartyAbortRef.current?.abort();
    counterpartyAbortRef.current = controller;
    const requestId = ++counterpartyRequestRef.current;
    if (requestType === 'stock_reserve') {
      setCounterparties([]);
      setTemplates([]);
      setCounterpartyNextCursor(null);
      setCatalogInitialized(false);
      setCatalogStatus('ready');
      setCatalogError(null);
      return () => {
        controller.abort();
      };
    }
    setCatalogStatus('loading');
    setCatalogError(null);
    const load = () => {
      void searchCommercialCounterparties(
        { q: counterpartyQuery, limit: 20 },
        { signal: controller.signal },
      )
        .then((page) => {
          if (requestId !== counterpartyRequestRef.current || controller.signal.aborted) return;
          setCounterparties((current) =>
            mergeCounterpartyPages(current, page.items, selectedCounterpartyIdRef.current, false),
          );
          setCounterpartyNextCursor(page.nextCursor);
          setCatalogInitialized(true);
          setCatalogStatus('ready');
        })
        .catch((error: unknown) => {
          if (requestId !== counterpartyRequestRef.current || controller.signal.aborted) return;
          setCatalogStatus('error');
          setCatalogError(errorMessage(error));
        });
    };
    const debounce = counterpartyQuery
      ? globalThis.setTimeout(load, COUNTERPARTY_SEARCH_DEBOUNCE_MS)
      : null;
    if (debounce === null) load();
    return () => {
      if (debounce !== null) globalThis.clearTimeout(debounce);
      controller.abort();
    };
  }, [catalogRevision, counterpartyQuery, requestType]);

  useEffect(
    () => () => {
      counterpartyAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    let active = true;
    if (requestType !== 'stock_reserve') {
      setStockTemplates([]);
      setStockCatalogStatus('ready');
      setStockCatalogError(null);
      return () => {
        active = false;
      };
    }
    setStockCatalogStatus('loading');
    setStockCatalogError(null);
    fetchStockProductionTemplates()
      .then((items) => {
        if (!active) return;
        setStockTemplates(items);
        setStockCatalogStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStockTemplates([]);
        setStockCatalogStatus('error');
        setStockCatalogError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [requestType, stockCatalogRevision]);

  const selectedCounterparty = counterparties.find(
    (counterparty) =>
      counterparty.id === state.form.counterpartyId ||
      counterparty.id === state.form.counterparty ||
      counterparty.displayName === state.form.counterparty ||
      counterparty.legalName === state.form.counterparty,
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (requestType === 'stock_reserve') {
      setTemplates([]);
      setTemplateCatalogStatus('idle');
      setTemplateCatalogError(null);
      return () => {
        active = false;
        controller.abort();
      };
    }
    if (!selectedCounterparty) {
      setTemplates([]);
      setTemplateCatalogStatus('idle');
      setTemplateCatalogError(null);
      return () => {
        active = false;
        controller.abort();
      };
    }
    setTemplates([]);
    setTemplateCatalogStatus('loading');
    setTemplateCatalogError(null);
    fetchCommercialTemplates(selectedCounterparty.id, { signal: controller.signal })
      .then((items) => {
        if (!active || controller.signal.aborted) return;
        setTemplates(items);
        setTemplateCatalogStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setTemplates([]);
        setTemplateCatalogStatus('error');
        setTemplateCatalogError(errorMessage(error));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedCounterparty?.id, catalogRevision, templateCatalogRevision, requestType]);

  const surfaceCatalog = useMemo(() => mapCounterparties(counterparties), [counterparties]);
  const surfaceTemplates = useMemo(() => mapTemplates(templates), [templates]);
  const templatePositions = useMemo(() => mapTemplatePositions(templates), [templates]);
  const effectiveForm =
    requestType === 'stock_reserve' && stockCatalogStatus === 'error'
      ? { ...state.form, stockProductionTemplateId: undefined }
      : state.form;

  const updateForm = (form: IntakeDraftForm) => {
    setMaterialSelectionInvalidPositionIds((current) => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const position of form.positions) {
        const previous = state.form.positions.find((item) => item.id === position.id);
        if (
          previous &&
          (previous.baseRawMaterialDefinitionId !== position.baseRawMaterialDefinitionId ||
            previous.recipeDefinitionVersionId !== position.recipeDefinitionVersionId)
        ) {
          next.delete(position.id);
        }
      }
      return next;
    });
    dispatch({ type: 'form_changed', form });
    onChange(form);
  };

  const loadMoreCounterparties = () => {
    if (!counterpartyNextCursor || catalogStatus === 'loading') return;
    const controller = new AbortController();
    counterpartyAbortRef.current?.abort();
    counterpartyAbortRef.current = controller;
    const requestId = ++counterpartyRequestRef.current;
    setCatalogStatus('loading');
    setCatalogError(null);
    void searchCommercialCounterparties(
      { q: counterpartyQuery, cursor: counterpartyNextCursor, limit: 20 },
      { signal: controller.signal },
    )
      .then((page) => {
        if (requestId !== counterpartyRequestRef.current || controller.signal.aborted) return;
        setCounterparties((current) =>
          mergeCounterpartyPages(current, page.items, selectedCounterpartyIdRef.current, true),
        );
        setCounterpartyNextCursor(page.nextCursor);
        setCatalogStatus('ready');
      })
      .catch((error: unknown) => {
        if (requestId !== counterpartyRequestRef.current || controller.signal.aborted) return;
        setCatalogStatus('error');
        setCatalogError(errorMessage(error));
      });
  };

  const submit = async (requestedMode: IntakeSubmitMode) => {
    if (submissionPendingRef.current) return;
    submissionPendingRef.current = true;
    onSubmittingChange?.(true);
    const mode = draftOnly || requestedMode === 'draft' ? 'draft' : 'submit';
    dispatch({ type: 'submission_started' });
    try {
      const order = await createCommercialOrderFromIntake({
        form: effectiveForm,
        counterparties,
        templates,
        stockTemplates,
        creatorRole,
        mode,
        clientRequestId: state.clientRequestId,
        requestType,
      });
      dispatch({ type: 'submission_succeeded', nextClientRequestId: createClientRequestId() });
      setMaterialSelectionInvalidPositionIds(new Set());
      onCreated(order, mode);
    } catch (error) {
      if (error instanceof ApiError && isCommercialOrderCatalogStaleCode(error.code)) {
        await onReloadMaterialCatalog();
        setMaterialSelectionInvalidPositionIds(
          new Set(state.form.positions.map((position) => position.id)),
        );
        dispatch({
          type: 'submission_failed',
          message: COMMERCIAL_ORDER_CATALOG_STALE_MESSAGE,
        });
      } else {
        dispatch({ type: 'submission_failed', message: errorMessage(error) });
      }
    } finally {
      submissionPendingRef.current = false;
      onSubmittingChange?.(false);
    }
  };

  const catalogContent =
    requestType === 'client_order' && catalogStatus === 'loading' && !catalogInitialized ? (
      <p aria-live="polite">Загрузка справочника контрагентов…</p>
    ) : requestType === 'client_order' &&
      catalogStatus === 'error' &&
      !catalogInitialized ? (
      <section role="alert" aria-label="Справочник контрагентов недоступен">
        <strong>Не удалось загрузить справочник контрагентов</strong>
        {catalogError && <p>{catalogError}</p>}
        <button type="button" onClick={() => setCatalogRevision((current) => current + 1)}>
          Повторить
        </button>
      </section>
    ) : (
      <>
        {requestType === 'client_order' && templateCatalogStatus === 'loading' ? (
          <p aria-live="polite">Загрузка шаблонов контрагента…</p>
        ) : null}
        {requestType === 'client_order' && templateCatalogStatus === 'error' ? (
          <section role="alert" aria-label="Шаблоны контрагента недоступны">
            <strong>Шаблоны контрагента временно недоступны</strong>
            <p>Заявку можно заполнить вручную без шаблона.</p>
            {templateCatalogError && <p>{templateCatalogError}</p>}
            <button
              type="button"
              onClick={() => setTemplateCatalogRevision((current) => current + 1)}
            >
              Повторить
            </button>
          </section>
        ) : null}
        {requestType === 'stock_reserve' && stockCatalogStatus === 'loading' && (
          <p aria-live="polite">Загрузка шаблонов производства на запас…</p>
        )}
        {requestType === 'stock_reserve' && stockCatalogStatus === 'error' && (
          <section
            className="stock-template-catalog-warning"
            role="alert"
            aria-label="Каталог шаблонов производства на запас недоступен"
          >
            <strong>Не удалось загрузить шаблоны производства на запас</strong>
            {stockCatalogError && <p>{stockCatalogError}</p>}
            <button type="button" onClick={() => setStockCatalogRevision((current) => current + 1)}>
              Повторить
            </button>
          </section>
        )}
        {catalogError && <p role="alert">Поиск контрагентов временно недоступен: {catalogError}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        <IntakeCreateSurface
          value={effectiveForm}
          onChange={updateForm}
          onClose={onClose}
          onSubmit={submit}
          creatorRole={creatorRole}
          draftOnly={draftOnly}
          counterpartyCatalog={surfaceCatalog}
          templateCatalog={surfaceTemplates.templates}
          templateVersions={surfaceTemplates.versions}
          templateDraftPositions={templatePositions}
          onCounterpartySearch={(query) => {
            setCounterpartyNextCursor(null);
            setCounterpartyQuery(query);
          }}
          counterpartySearchLoading={catalogStatus === 'loading'}
          counterpartySearchHasMore={counterpartyNextCursor !== null}
          onLoadMoreCounterparties={loadMoreCounterparties}
          stockTemplates={stockTemplates}
          stockTemplateCatalogStatus={stockCatalogStatus}
          materials={materials}
          recipes={recipes}
          materialCatalogStatus={materialCatalogStatus}
          materialCatalogError={materialCatalogError}
          onRetryMaterialCatalog={() => void onReloadMaterialCatalog()}
          onCreateRecipe={onCreateRecipe}
          effectiveCapabilities={effectiveCapabilities}
          onMaterialSelectionConfirmed={(positionId) =>
            setMaterialSelectionInvalidPositionIds((current) => {
              const next = new Set(current);
              next.delete(positionId);
              return next;
            })
          }
          materialSelectionInvalidPositionIds={materialSelectionInvalidPositionIds}
          submitting={state.status === 'submitting'}
          requestType={requestType}
        />
      </>
    );

  return (
    <section
      className="commercial-live-intake"
      data-intake-sequence="counterparty-positions-review"
      aria-busy={state.status === 'submitting'}
    >
      {catalogContent}
    </section>
  );
}

export function createClientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function mapCounterparties(items: CommercialCounterpartyContract[]): Counterparty[] {
  return items.map((item) => ({
    id: item.id,
    legalName: item.displayName,
    alias: item.legalName || item.displayName,
    inn: item.inn || undefined,
    source: item.billingSource === 'one_c' ? '1C' : 'manual',
    syncStatus: item.syncStatus === 'synced' ? 'synced' : 'not_synced',
    visibilityPolicy: 'Данные доступны коммерческой роли',
    templateIds: [],
    installmentTermsSource: 'Не передано в коммерческий приём заказа',
  }));
}

function mergeCounterpartyPages(
  current: CommercialCounterpartyContract[],
  incoming: CommercialCounterpartyContract[],
  selectedId: string | undefined,
  append: boolean,
): CommercialCounterpartyContract[] {
  const pinned = selectedId ? current.find((item) => item.id === selectedId) : undefined;
  const merged = [...(pinned ? [pinned] : []), ...(append ? current : []), ...incoming];
  return [...new Map(merged.map((item) => [item.id, item])).values()];
}

function mapTemplates(items: CommercialIntakeTemplateContract[]): {
  templates: CounterpartyOrderTemplate[];
  versions: CounterpartyOrderTemplateVersion[];
} {
  return {
    templates: items.map((item) => ({
      id: item.id,
      counterpartyId: item.counterpartyId,
      name: item.name,
      activeVersionId: item.activeVersionId,
      status: item.status === 'archived' ? 'archived' : 'active',
      ownerRole: 'Зав. производства',
      usageCount: item.usageCount ?? 0,
      lastUsedAt: item.lastUsedAt ?? 'Ещё не применялся',
      updatedAt: item.updatedAt ?? item.createdAt ?? '',
    })),
    versions: items.flatMap((item) =>
      item.versions.map((version) => ({
        id: version.id,
        templateId: item.id,
        version: `v${version.version}`,
        fields: templateFields(version.positions),
        reason: 'Зафиксированная версия шаблона',
        createdBy: 'Зав. производства',
        createdAt: version.createdAt,
        affectsProduction: true,
        affectsMoney: false,
      })),
    ),
  };
}

function templateFields(
  positions: CommercialTemplatePositionContract[],
): CounterpartyOrderTemplateField[] {
  if (positions.length > 1) {
    return [templateField('Количество позиций', String(positions.length))];
  }
  const position = positions[0];
  if (!position) return [];
  return [
    templateField('Позиции', `${position.rollCount} шт.`),
    templateField('Тип пленки', position.filmType),
    templateField('Толщина', position.actualThickness),
    templateField(
      'Рулоны',
      `${position.rollCount} шт.${position.plannedWeightKg ? ` по ${position.plannedWeightKg} кг` : ''}`,
    ),
    ...(position.rawMaterialId ? [templateField('Сырье', position.rawMaterialId)] : []),
    ...(position.spoolType ? [templateField('Шпуля', position.spoolType)] : []),
  ];
}

function templateField(label: string, value: string): CounterpartyOrderTemplateField {
  return { label, value, kind: 'production', required: true };
}

function mapTemplatePositions(
  templates: CommercialIntakeTemplateContract[],
): Record<string, IntakeDraftPosition[]> {
  return Object.fromEntries(
    templates.map((template) => {
      const active = template.versions.find((version) => version.id === template.activeVersionId);
      return [
        template.id,
        (active?.positions ?? template.positions).map((position, index) =>
          intakePositionFromTemplate(template.id, position, index),
        ),
      ];
    }),
  );
}

function intakePositionFromTemplate(
  templateId: string,
  position: CommercialTemplatePositionContract,
  index: number,
): IntakeDraftPosition {
  const rawMaterial = recipeValue(position, 'Сырье') || recipeValue(position, 'Сырьё');
  const micron = position.actualThickness.match(/\d+(?:[.,]\d+)?/)?.[0] ?? '';
  return {
    id: `${templateId}-position-${index + 1}`,
    rollCount: String(position.rollCount),
    micronPreset: micron || 'manual',
    micronCustom: micron,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    filmType: position.filmType,
    widthMm: position.widthMm == null ? '' : String(position.widthMm),
    plannedLengthM: position.plannedLengthM == null ? '' : String(position.plannedLengthM),
    plannedWeightKg:
      position.plannedWeightKg === null || position.plannedWeightKg === undefined
        ? ''
        : String(position.plannedWeightKg),
    birka: position.birka ?? '',
    manualBirka: position.manualBirka ?? '',
    comment: position.comment ?? '',
    rawMaterial: rawMaterial || position.rawMaterialId || '',
    rawMaterialId: position.rawMaterialId ?? '',
    baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId ?? '',
    recipeDefinitionVersionId: position.recipeDefinitionVersionId ?? '',
    spoolType: position.spoolType ?? '',
  };
}

function recipeValue(position: CommercialTemplatePositionContract, label: string) {
  return position.recipeParameters?.find(
    (parameter) => parameter.label.toLocaleLowerCase('ru-RU') === label.toLocaleLowerCase('ru-RU'),
  )?.value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Не удалось сохранить заявку.';
}
