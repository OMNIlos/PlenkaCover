import { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildWarehouseInventoryDashboard,
  buildWarehouseInventoryTableProjection,
  nextWarehouseInventorySortState,
  warehouseInventoryAriaSortValue,
  warehouseInventoryDefaultSortState,
  type WarehouseInventoryCategory,
  type WarehouseInventoryRow,
  type WarehouseInventorySortColumn,
  type WarehouseInventorySortState,
} from '../../domain/warehouseInventoryDashboard';
import type {
  InventoryMutationKind,
  RawMaterialStock,
  WarehouseCoverFreeRoll,
  WarehouseCoverTask,
  WarehouseStockMutationDraft,
  WorkObject,
} from '../../domain/types';
import { selectedWarehouseInventoryRow } from '../../domain/warehouseInventorySelection';
import {
  PlenkiDataTable,
  PlenkiModal,
  PlenkiToolbar,
  TablePager,
  useResponsiveTablePageSize,
  useTablePagination,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';
import { usePlenkiTableState } from '../plenki-ui/usePlenkiTableState';
import { createOperationKey } from '../../api/idempotentOperation';
import { hasEffectiveCapability } from '../../domain/accessPolicy';
import { RecipeEditorModal } from '../../features/recipes/RecipeEditorModal';
import type { MaterialRecipeCatalog } from '../../features/recipes/useMaterialRecipeCatalog';
import { ActionPanel } from '../shell/ActionPanel';
import { actionIcon } from '../shell/actionPresentation';
import {
  WarehouseCoverTasksPanel,
  type WarehouseCoverProposalCommand,
} from './WarehouseCoverTasksPanel';
import {
  WarehouseBigBagCreateModal,
  type WarehouseBigBagCreateCommand,
} from './WarehouseBigBagCreateModal';
import { WarehouseBigBagManagementPanel } from './WarehouseBigBagManagementPanel';
import { WarehouseQrInspectionPanel } from './WarehouseQrInspectionPanel';
import { isLiveContour } from '../../api/liveContours';
import {
  WarehouseAccountingMovementsPanel,
  WarehouseAccountingStockPanel,
} from './WarehouseAccountingPanels';
import { resolveWarehouseSection } from '../../domain/warehouseSections';
import { WarehouseStockWorkspace } from './WarehouseStockWorkspace';
import { SharedBigBagRegister } from '../../features/raw-materials/SharedBigBagRegister';
import { WarehouseSpoolPriceForm } from '../../features/warehouse/WarehouseSpoolPriceForm';

function categoryIcon(category: WarehouseInventoryCategory) {
  const icons: Record<WarehouseInventoryCategory, string> = {
    raw: 'capacity-check',
    rolls: 'box-closed',
    reserve: 'tasks-open',
    consumables: 'box-closed',
    movements: 'history-list',
  };
  return icons[category];
}
function rowStatusClass(row: WarehouseInventoryRow) {
  return `severity-${row.severity}`;
}

function warehouseSectionSearchParams(): URLSearchParams {
  return typeof window === 'undefined'
    ? new URLSearchParams()
    : new URLSearchParams(window.location.search);
}

function resolveActiveWarehouseSection(activeSection: string) {
  const params = warehouseSectionSearchParams();
  const requestedSection = params.get('section');
  if (!requestedSection) return resolveWarehouseSection(activeSection, params);

  const requested = resolveWarehouseSection(requestedSection, params);
  const active = resolveWarehouseSection(activeSection);
  return requested.section === active.section ? requested : active;
}

function numberFromQty(value: string) {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function unitFromQty(value: string) {
  const match = value.trim().match(/-?\d+(?:[,.]\d+)?\s*(.*)$/);
  return match?.[1]?.trim() || 'шт';
}

function editLabelForCategory(category: WarehouseInventoryCategory) {
  if (category === 'raw') return 'Факт склада';
  if (category === 'rolls' || category === 'reserve') return 'Резерв, рул.';
  if (category === 'consumables') return 'Норма';
  return 'Количество';
}

function detailLimitForCategory(category: WarehouseInventoryCategory) {
  if (category === 'rolls') return 12;
  if (category === 'raw') return 9;
  if (category === 'reserve') return 10;
  if (category === 'movements') return 9;
  return 7;
}

function categoryActionLabels(category: WarehouseInventoryCategory) {
  const labels: Record<
    WarehouseInventoryCategory,
    {
      receive: string;
      create: string;
      rowReceive: string;
      createTitle: string;
      receiveTitle: string;
      sourceCreate: string;
      sourceReceive: string;
    }
  > = {
    raw: {
      receive: '+ Приход сырья',
      create: '+ Новый материал',
      rowReceive: 'Приход',
      createTitle: 'Новый материал',
      receiveTitle: 'Приход сырья',
      sourceCreate: 'Данные: ручной учет склада',
      sourceReceive: 'Данные: факт склада',
    },
    rolls: {
      receive: '+ Приход рулонов',
      create: '+ Новый рулон',
      rowReceive: 'Приход',
      createTitle: 'Новый рулон',
      receiveTitle: 'Приход рулонов',
      sourceCreate: 'Данные: ручной учет склада',
      sourceReceive: 'Данные: факт склада',
    },
    reserve: {
      receive: '+ Операция резерва',
      create: '+ Новый резерв',
      rowReceive: 'Операция',
      createTitle: 'Новый резерв',
      receiveTitle: 'Операция резерва',
      sourceCreate: 'Данные: ручной учет склада',
      sourceReceive: 'Данные: факт склада',
    },
    consumables: {
      receive: '+ Приход расходника',
      create: '+ Новый расходник',
      rowReceive: 'Приход',
      createTitle: 'Новый расходник',
      receiveTitle: 'Приход расходника',
      sourceCreate: 'Данные: ручной учет склада',
      sourceReceive: 'Данные: факт склада',
    },
    movements: {
      receive: '+ Новое движение',
      create: '+ Новая запись',
      rowReceive: 'Движение',
      createTitle: 'Новая запись',
      receiveTitle: 'Новое движение',
      sourceCreate: 'Данные: ручной учет склада',
      sourceReceive: 'Данные: факт склада',
    },
  };
  return labels[category];
}

const stockMutationLabels: Record<InventoryMutationKind, string> = {
  create: 'Новый материал',
  edit: 'Правка позиции',
  receive: 'Принять',
  write_off: 'Списать',
  reserve: 'Зарезервировать',
  release_reserve: 'Снять резерв',
  correction: 'Новый факт',
};

function stockMutationHelp(kind: InventoryMutationKind) {
  if (kind === 'create') return 'Создает новую складскую позицию с ручным учетом.';
  if (kind === 'edit') return 'Обновляет складскую карточку с причиной и историей.';
  if (kind === 'correction') return 'Новое фактическое количество после инвентаризации.';
  if (kind === 'reserve')
    return 'Количество уйдет из доступного остатка, но не спишется со склада.';
  if (kind === 'release_reserve') return 'Количество вернется в доступный остаток.';
  if (kind === 'write_off') return 'Количество спишется из факта склада.';
  return 'Количество добавится к факту склада через приемку.';
}

const quickStockMutationOptions: InventoryMutationKind[] = [
  'receive',
  'write_off',
  'reserve',
  'release_reserve',
  'correction',
];

type WarehouseMaterialDialogMode = 'create' | 'receive';

type WarehouseMaterialFormDraft = {
  materialId: string;
  label: string;
  materialKind: RawMaterialStock['materialKind'];
  qty: string;
  weightKg: string;
  unit: string;
  packageQty: string;
  warehouseZone: string;
  linkedOrderId: string;
  documentRef: string;
  reason: string;
  comment: string;
};

const RAW_RECEIPT_MIN_QTY = 0.001;
const RAW_RECEIPT_MAX_QTY = 1_000_000;
const RAW_RECEIPT_MAX_REASON_LENGTH = 500;

type WarehouseRawMaterialReceiptDraft = Pick<
  WarehouseMaterialFormDraft,
  'qty' | 'reason' | 'documentRef' | 'comment'
>;

export function composeWarehouseRawMaterialReceiptReason(
  draft: Pick<WarehouseRawMaterialReceiptDraft, 'reason' | 'documentRef' | 'comment'>,
) {
  return [
    draft.reason.trim(),
    draft.documentRef.trim() ? `Документ: ${draft.documentRef.trim()}` : '',
    draft.comment.trim() ? `Комментарий: ${draft.comment.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function warehouseRawMaterialReceiptValidationError(
  draft: WarehouseRawMaterialReceiptDraft,
) {
  const normalizedQty = draft.qty.trim().replace(',', '.');
  const qty = Number(normalizedQty);
  if (
    !/^\d+(?:\.\d{1,3})?$/u.test(normalizedQty) ||
    !Number.isFinite(qty) ||
    qty < RAW_RECEIPT_MIN_QTY ||
    qty > RAW_RECEIPT_MAX_QTY
  ) {
    return 'Количество: от 0,001 до 1 000 000, не более трёх знаков после запятой.';
  }
  if (!draft.reason.trim()) return 'Укажите причину прихода.';
  if (composeWarehouseRawMaterialReceiptReason(draft).length > RAW_RECEIPT_MAX_REASON_LENGTH) {
    return 'Причина, документ и комментарий вместе не должны превышать 500 знаков.';
  }
  return null;
}

export function shouldShowWarehouseRawMaterialReceiptValidation(error: string | null, qty: string) {
  return Boolean(error) && Boolean(qty.trim()) && error !== 'Укажите причину прихода.';
}

const materialKindLabels: Record<RawMaterialStock['materialKind'], string> = {
  primary: 'Первичное',
  secondary: 'Вторичное',
  additive: 'Добавка',
  unclassified: 'Не классифицировано',
};

const materialKindOptions: RawMaterialStock['materialKind'][] = [
  'primary',
  'secondary',
  'additive',
  'unclassified',
];
const unitOptions = ['кг', 'т', 'меш.', 'биг-бег', 'шт'];

function materialKindFromRow(row?: WarehouseInventoryRow): RawMaterialStock['materialKind'] {
  const text = `${row?.subtitle ?? ''} ${row?.title ?? ''}`.toLowerCase();
  if (text.includes('втор')) return 'secondary';
  if (text.includes('добав')) return 'additive';
  if (text.includes('не указана') || text.includes('не классифицирован')) return 'unclassified';
  return 'primary';
}

function materialIdFromLabel(label: string) {
  return label
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Zа-яА-ЯёЁ0-9-]+/g, '')
    .toUpperCase();
}

function defaultUnitForCategory(category?: WarehouseInventoryCategory) {
  return category === 'raw' ? 'кг' : 'шт';
}

function createMaterialDraft(
  mode: WarehouseMaterialDialogMode,
  row?: WarehouseInventoryRow,
  category?: WarehouseInventoryCategory,
): WarehouseMaterialFormDraft {
  const sourceRow = mode === 'create' ? undefined : row;
  const label = sourceRow?.title ?? '';
  const materialId = sourceRow?.rawMaterialId ?? sourceRow?.id ?? sourceRow?.title ?? '';
  return {
    materialId,
    label,
    materialKind: materialKindFromRow(row),
    qty: mode === 'create' ? '' : '',
    weightKg: sourceRow?.category === 'rolls' ? numberFromQty(sourceRow.secondaryQty ?? '') : '',
    unit:
      sourceRow?.unit ??
      (sourceRow?.primaryQty
        ? unitFromQty(sourceRow.primaryQty)
        : defaultUnitForCategory(category)),
    packageQty:
      sourceRow?.details.find((detail) => detail.label === 'Упаковка')?.value === 'Не указана'
        ? ''
        : (sourceRow?.details.find((detail) => detail.label === 'Упаковка')?.value ?? ''),
    warehouseZone: 'Основной склад сырья',
    linkedOrderId: '',
    documentRef: '',
    reason: '',
    comment: '',
  };
}

function createRowEditDraft(row: WarehouseInventoryRow): WarehouseMaterialFormDraft {
  return {
    materialId: row.rawMaterialId ?? row.id,
    label: row.title,
    materialKind: materialKindFromRow(row),
    qty: String(row.actualQty ?? numberFromQty(row.primaryQty)),
    weightKg: row.category === 'rolls' ? numberFromQty(row.secondaryQty ?? '') : '',
    unit: row.unit ?? unitFromQty(row.primaryQty),
    packageQty:
      row.details.find((detail) => detail.label === 'Упаковка')?.value === 'Не указана'
        ? ''
        : (row.details.find((detail) => detail.label === 'Упаковка')?.value ?? ''),
    warehouseZone: 'Основной склад сырья',
    linkedOrderId: '',
    documentRef: '',
    reason: '',
    comment: '',
  };
}

function parseDraftQty(value: string) {
  return Number(value.replace(',', '.'));
}

export type WarehouseRawMaterialAdjustmentInput = {
  materialId: string;
  actualQty: number;
  reason: string;
};

export type WarehouseRawMaterialReceiptInput = {
  materialId: string;
  operationKey: string;
  receivedQty: number;
  reason: string;
};

export type WarehouseMaterialRecipeCatalog = Pick<
  MaterialRecipeCatalog,
  'materials' | 'recipes' | 'status' | 'error' | 'reload' | 'createRecipe'
>;

type WarehouseRawMaterialAdjustmentResult =
  | { success: true; error: null }
  | { success: false; error: string };

export async function runWarehouseRawMaterialAdjustment(
  adjust: (input: WarehouseRawMaterialAdjustmentInput) => Promise<boolean>,
  input: WarehouseRawMaterialAdjustmentInput,
): Promise<WarehouseRawMaterialAdjustmentResult> {
  try {
    const success = await adjust(input);
    return success
      ? { success: true, error: null }
      : { success: false, error: 'Остаток не изменён. Повторите попытку.' };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().replace(/[.!?]+$/u, '') : '';
    return {
      success: false,
      error: message ? `${message}. Повторите попытку.` : 'Остаток не изменён. Повторите попытку.',
    };
  }
}

export async function runWarehouseRawMaterialReceipt(
  receive: (input: WarehouseRawMaterialReceiptInput) => Promise<boolean>,
  input: WarehouseRawMaterialReceiptInput,
): Promise<WarehouseRawMaterialAdjustmentResult> {
  try {
    const success = await receive(input);
    return success
      ? { success: true, error: null }
      : { success: false, error: 'Приход не записан. Повторите попытку.' };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().replace(/[.!?]+$/u, '') : '';
    return {
      success: false,
      error: message ? `${message}. Повторите попытку.` : 'Приход не записан. Повторите попытку.',
    };
  }
}

export function WarehouseInventoryDashboard({
  object,
  activeSection,
  onAction,
  onStockMutation,
  onAdjustRawMaterial,
  onReceiveRawMaterial,
  onCreateBigBag,
  coverTasks = [],
  coverFreeRolls = [],
  selectedWarehouseObjectId,
  onSelectWarehouseObject,
  onCoverPropose,
  onCoverRefresh,
  coverageRefreshGeneration,
  onOneCStockPush,
  oneCStockPushBusy = false,
  materialRecipeCatalog,
  effectiveCapabilities,
  finishedStockEnabled = isLiveContour('warehouse'),
}: {
  object: WorkObject;
  activeSection?: string;
  onAction?: (actionId: string) => void;
  onStockMutation?: (draft: WarehouseStockMutationDraft) => void;
  onAdjustRawMaterial?: (input: WarehouseRawMaterialAdjustmentInput) => Promise<boolean>;
  onReceiveRawMaterial?: (input: WarehouseRawMaterialReceiptInput) => Promise<boolean>;
  onCreateBigBag?: (input: WarehouseBigBagCreateCommand) => Promise<boolean>;
  coverTasks?: WarehouseCoverTask[];
  coverFreeRolls?: WarehouseCoverFreeRoll[];
  selectedWarehouseObjectId?: string | null;
  onSelectWarehouseObject?: (objectId: string) => void;
  onCoverPropose?: (
    orderId: string,
    input: Omit<WarehouseCoverProposalCommand, 'orderId'>,
  ) => Promise<unknown>;
  onCoverRefresh?: () => Promise<unknown> | unknown;
  coverageRefreshGeneration?: number;
  onOneCStockPush?: () => void;
  oneCStockPushBusy?: boolean;
  materialRecipeCatalog?: WarehouseMaterialRecipeCatalog;
  effectiveCapabilities?: readonly string[];
  finishedStockEnabled?: boolean;
}) {
  const dashboard = useMemo(
    () => buildWarehouseInventoryDashboard(object, coverFreeRolls),
    [coverFreeRolls, object],
  );
  const activeSectionResolution = resolveActiveWarehouseSection(activeSection ?? '');
  const activeCategoryId = activeSectionResolution.categoryId ?? 'raw';
  const activeCategory =
    dashboard.categories.find((category) => category.id === activeCategoryId) ??
    dashboard.categories[0];
  const [selectedRowIdByCategory, setSelectedRowIdByCategory] = useState<
    Partial<Record<WarehouseInventoryCategory, string>>
  >({});
  const responsivePageSize = useResponsiveTablePageSize();
  const tableDefaults = useMemo(
    () => ({
      view: 'all',
      query: '',
      filters: {},
      sort: { column: warehouseInventoryDefaultSortState.column, direction: 'none' as const },
      page: 1,
      pageSize: responsivePageSize,
    }),
    [responsivePageSize],
  );
  const quickFilterCatalog = useMemo(
    () =>
      buildWarehouseInventoryTableProjection(activeCategory.rows, {
        searchQuery: '',
        quickFilterId: 'all',
        summaryId: null,
        sortState: warehouseInventoryDefaultSortState,
      }).quickFilters,
    [activeCategory.rows],
  );
  const tableContract = useMemo(
    () => ({
      views: quickFilterCatalog.map((item) => item.id),
      filters: {},
      sortColumns: ['object', 'characteristic', 'primaryQty', 'secondaryQty', 'status', 'source'],
      pageSizes: responsivePageSize <= 10 ? [10, 25] : [10, 25, 50],
    }),
    [quickFilterCatalog, responsivePageSize],
  );
  const {
    state: tableState,
    change: changeTableState,
    reset: resetTableState,
  } = usePlenkiTableState({
    scope: `warehouse-${activeCategory.id}`,
    defaults: tableDefaults,
    contract: tableContract,
  });
  const searchQuery = tableState.query;
  const quickFilterId = tableState.view;
  const sortState: WarehouseInventorySortState = {
    column: tableState.sort.column as WarehouseInventorySortColumn,
    direction: tableState.sort.direction,
  };
  const tablePage = tableState.page;
  const pageSize = tableState.pageSize;
  const setSearchQuery = (query: string) => changeTableState({ type: 'query', query });
  const setQuickFilterId = (view: string) => changeTableState({ type: 'view', view });
  const setSortState = (
    updater:
      | WarehouseInventorySortState
      | ((current: WarehouseInventorySortState) => WarehouseInventorySortState),
  ) => {
    const next = typeof updater === 'function' ? updater(sortState) : updater;
    changeTableState({ type: 'sort', sort: { column: next.column, direction: next.direction } });
  };
  const setTablePage = (page: number | ((current: number) => number)) => {
    const next = typeof page === 'function' ? page(tablePage) : page;
    changeTableState({ type: 'page', page: next });
  };
  const setPageSize = (nextPageSize: number) =>
    changeTableState({ type: 'pageSize', pageSize: nextPageSize });
  const [manualQtyDrafts, setManualQtyDrafts] = useState<Record<string, string>>({});
  const [mutationKind, setMutationKind] = useState<InventoryMutationKind>('receive');
  const [mutationReason, setMutationReason] = useState('');
  const [linkedOrderId, setLinkedOrderId] = useState('');
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [rowEditDrafts, setRowEditDrafts] = useState<Record<string, WarehouseMaterialFormDraft>>(
    {},
  );
  const [materialDialogMode, setMaterialDialogMode] = useState<WarehouseMaterialDialogMode | null>(
    null,
  );
  const [materialDialogDraft, setMaterialDialogDraft] = useState<WarehouseMaterialFormDraft>(() =>
    createMaterialDraft('receive'),
  );
  const [recipeEditorOpen, setRecipeEditorOpen] = useState(false);
  const [bigBagCreateOpen, setBigBagCreateOpen] = useState(false);
  const [bigBagRefreshRevision, setBigBagRefreshRevision] = useState(0);
  const [reserveCompositionOpenId, setReserveCompositionOpenId] = useState<string | null>(null);
  const [adjustmentBusy, setAdjustmentBusy] = useState(false);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const adjustmentInFlightRef = useRef(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const receiptInFlightRef = useRef(false);
  const receiptOperationKeyRef = useRef<string | null>(null);
  const resolvedStockView =
    activeSectionResolution.inventoryView === 'processed' ? 'processed' : 'current';
  const [stockView, setStockView] = useState<'current' | 'processed'>(resolvedStockView);
  const skipStockViewUrlSyncRef = useRef(true);
  const isConsumables = activeCategory.id === 'consumables';
  const isRaw = activeCategory.id === 'raw';
  const isRolls = activeCategory.id === 'rolls';
  const isLiveInventory = object.id === 'warehouse-live-inventory';
  const showStockWorkspace = activeSectionResolution.inventoryView !== null;
  const isEditableInventory = !isLiveInventory && Boolean(onStockMutation);
  const canCreateMaterialRecipe =
    isLiveInventory &&
    isRaw &&
    Boolean(materialRecipeCatalog) &&
    hasEffectiveCapability(effectiveCapabilities, 'recipe_catalog:create');
  const canCreateBigBag =
    isLiveInventory &&
    isRaw &&
    Boolean(onCreateBigBag) &&
    Boolean(materialRecipeCatalog) &&
    hasEffectiveCapability(effectiveCapabilities, 'bigbag:create');
  const canManageSpoolReceipt =
    isLiveInventory &&
    isRaw &&
    hasEffectiveCapability(effectiveCapabilities, 'spool_price:manage') &&
    hasEffectiveCapability(effectiveCapabilities, 'spool_stock:receive') &&
    hasEffectiveCapability(effectiveCapabilities, 'spool_stock:read');
  const canCreateReserveRoll =
    isLiveInventory &&
    Boolean(materialRecipeCatalog) &&
    hasEffectiveCapability(effectiveCapabilities, 'reserve_roll:create');
  const canManageBigBags =
    isLiveInventory &&
    isRaw &&
    hasEffectiveCapability(effectiveCapabilities, 'warehouse_task:read') &&
    hasEffectiveCapability(effectiveCapabilities, 'bigbag:move') &&
    hasEffectiveCapability(effectiveCapabilities, 'bigbag:print');
  const canInspectQr =
    isLiveInventory && isRaw && hasEffectiveCapability(effectiveCapabilities, 'warehouse:scan');
  const canOfferLiveRawCorrection = isLiveInventory && isRaw && Boolean(onAdjustRawMaterial);
  const showInventoryTableHead =
    !isRaw ||
    canCreateBigBag ||
    canCreateMaterialRecipe ||
    isEditableInventory ||
    Boolean(isRaw && onOneCStockPush);
  const actionLabels = categoryActionLabels(activeCategory.id);
  const availableUnitOptions =
    activeCategory.id === 'rolls' || activeCategory.id === 'reserve' ? ['шт'] : unitOptions;
  const tableProjection = useMemo(
    () =>
      buildWarehouseInventoryTableProjection(activeCategory.rows, {
        searchQuery,
        quickFilterId,
        summaryId: null,
        sortState,
      }),
    [activeCategory.rows, quickFilterId, searchQuery, sortState],
  );
  const { quickFilters, visibleRows } = tableProjection;
  const {
    pageCount,
    safePage,
    startIndex,
    endIndex,
    pageRows: pagedRows,
  } = useTablePagination(visibleRows, tablePage, pageSize);
  const selectedRow = selectedWarehouseInventoryRow(
    visibleRows,
    selectedRowIdByCategory[activeCategory.id],
  );
  const selectedDetails = (selectedRow?.details ?? []).slice(
    0,
    detailLimitForCategory(activeCategory.id),
  );
  const canCorrectLiveRaw = canOfferLiveRawCorrection && Boolean(selectedRow?.rawMaterialId);
  const effectiveMutationKind: InventoryMutationKind = isLiveInventory
    ? 'correction'
    : mutationKind;
  const selectedManualQty = selectedRow
    ? (manualQtyDrafts[selectedRow.id] ??
      (effectiveMutationKind === 'correction' ? numberFromQty(selectedRow.primaryQty) : ''))
    : '';
  const parsedQty = Number(selectedManualQty.replace(',', '.'));
  const hasExplicitManualQty = selectedManualQty.trim().length > 0;
  const hasTableControls = Boolean(
    searchQuery.trim() ||
    quickFilterId !== 'all' ||
    sortState.direction !== 'none' ||
    tablePage !== 1 ||
    pageSize !== tableDefaults.pageSize,
  );
  const canSubmitStockMutation = Boolean(
    isEditableInventory &&
    onStockMutation &&
    selectedRow?.category === 'raw' &&
    selectedRow.rawMaterialId &&
    Number.isFinite(parsedQty) &&
    parsedQty > 0 &&
    mutationReason.trim(),
  );
  const canSubmitLiveAdjustment = Boolean(
    canCorrectLiveRaw &&
    !adjustmentBusy &&
    hasExplicitManualQty &&
    Number.isFinite(parsedQty) &&
    parsedQty >= 0 &&
    mutationReason.trim(),
  );

  useEffect(() => {
    setSelectedRowIdByCategory((current) => {
      if (!current[activeCategory.id]) return current;
      const next = { ...current };
      delete next[activeCategory.id];
      return next;
    });
    setEditingRowId(null);
    receiptOperationKeyRef.current = null;
    setMaterialDialogMode(null);
    setReserveCompositionOpenId(null);
  }, [activeCategory.id, activeSection]);

  useEffect(() => {
    if (!canCreateMaterialRecipe) setRecipeEditorOpen(false);
  }, [canCreateMaterialRecipe]);

  useEffect(() => {
    setTablePage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  function selectRow(row: WarehouseInventoryRow) {
    setAdjustmentError(null);
    setSelectedRowIdByCategory((current) => ({ ...current, [row.category]: row.id }));
  }

  function clearSelectedRow() {
    setSelectedRowIdByCategory((current) => {
      const next = { ...current };
      delete next[activeCategory.id];
      return next;
    });
    setEditingRowId(null);
    receiptOperationKeyRef.current = null;
    setMaterialDialogMode(null);
    setReserveCompositionOpenId(null);
    setMutationReason('');
    setLinkedOrderId('');
    setAdjustmentError(null);
  }

  function handleInventoryAction(actionId: string) {
    if (
      actionId.startsWith('warehouse-open-reserve:') ||
      actionId.startsWith('warehouse-open-reserve-task:')
    ) {
      const targetId = actionId.slice(actionId.indexOf(':') + 1);
      const targetRow = activeCategory.rows.find((row) => row.id === targetId);
      if (targetRow) selectRow(targetRow);
      setReserveCompositionOpenId(targetId);
    }
    onAction?.(actionId);
  }

  function resetTableControls() {
    resetTableState();
  }

  function renderSortHeader(column: WarehouseInventorySortColumn, label: string) {
    const isActive = sortState.column === column && sortState.direction !== 'none';
    const indicator = isActive ? (sortState.direction === 'asc' ? '↑' : '↓') : '↕';
    return (
      <span
        role="columnheader"
        aria-sort={
          warehouseInventoryAriaSortValue(sortState, column) as 'none' | 'ascending' | 'descending'
        }
      >
        <button
          type="button"
          className={`warehouse-sort-button ${isActive ? 'is-active' : ''}`}
          onClick={() =>
            setSortState((current) => nextWarehouseInventorySortState(current, column))
          }
          aria-label={`Сортировать: ${label}`}
        >
          <span>{label}</span>
          <small aria-hidden="true">{indicator}</small>
        </button>
      </span>
    );
  }

  function submitStockMutation() {
    if (!selectedRow?.rawMaterialId || !canSubmitStockMutation) return;
    onStockMutation?.({
      materialId: selectedRow.rawMaterialId,
      kind: mutationKind,
      qty: parsedQty,
      reason: mutationReason,
      linkedOrderId,
    });
    setMutationReason('');
    if (mutationKind !== 'correction' && selectedRow) {
      setManualQtyDrafts((current) => ({ ...current, [selectedRow.id]: '' }));
    }
  }

  async function submitLiveRawMaterialAdjustment() {
    if (adjustmentInFlightRef.current || adjustmentBusy) return;
    if (!selectedRow?.rawMaterialId || !onAdjustRawMaterial || !canSubmitLiveAdjustment) {
      return;
    }

    const selectedRowId = selectedRow.id;
    adjustmentInFlightRef.current = true;
    setAdjustmentBusy(true);
    setAdjustmentError(null);
    const result = await runWarehouseRawMaterialAdjustment(onAdjustRawMaterial, {
      materialId: selectedRow.rawMaterialId,
      actualQty: parsedQty,
      reason: mutationReason.trim(),
    });
    adjustmentInFlightRef.current = false;
    setAdjustmentBusy(false);

    if (!result.success) {
      setAdjustmentError(result.error);
      return;
    }

    setMutationReason('');
    setManualQtyDrafts((current) => {
      const next = { ...current };
      delete next[selectedRowId];
      return next;
    });
  }

  function updateRowEditDraft<K extends keyof WarehouseMaterialFormDraft>(
    rowId: string,
    field: K,
    value: WarehouseMaterialFormDraft[K],
  ) {
    setRowEditDrafts((current) => {
      const baseRow =
        visibleRows.find((row) => row.id === rowId) ??
        (selectedRow?.id === rowId ? selectedRow : undefined);
      const baseDraft = current[rowId] ?? (baseRow ? createRowEditDraft(baseRow) : undefined);
      if (!baseDraft) return current;
      return {
        ...current,
        [rowId]: {
          ...baseDraft,
          [field]: value,
        },
      };
    });
  }

  function startRowEdit(row: WarehouseInventoryRow) {
    selectRow(row);
    setEditingRowId(row.id);
    setRowEditDrafts((current) => ({
      ...current,
      [row.id]: current[row.id] ?? createRowEditDraft(row),
    }));
  }

  function cancelRowEdit(rowId: string) {
    setEditingRowId(null);
    setRowEditDrafts((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  }

  function rowDraftInvalid(draft: WarehouseMaterialFormDraft | undefined) {
    if (!draft) return true;
    const qty = parseDraftQty(draft.qty);
    const weightKg = parseDraftQty(draft.weightKg);
    const rollsInvalid =
      activeCategory.id === 'rolls' &&
      (!Number.isInteger(qty) || !Number.isFinite(weightKg) || weightKg <= 0);
    return (
      !draft.label.trim() ||
      !draft.reason.trim() ||
      !Number.isFinite(qty) ||
      qty < 0 ||
      !draft.unit.trim() ||
      rollsInvalid
    );
  }

  function submitRowEdit(row: WarehouseInventoryRow) {
    const draft = rowEditDrafts[row.id];
    if (!draft || rowDraftInvalid(draft)) return;
    onStockMutation?.({
      materialId: row.rawMaterialId ?? draft.materialId,
      category: row.category,
      kind: 'edit',
      qty: parseDraftQty(draft.qty),
      weightKg: row.category === 'rolls' ? parseDraftQty(draft.weightKg) : undefined,
      reason: draft.reason,
      linkedOrderId: draft.linkedOrderId,
      label: draft.label,
      subtitle: row.subtitle,
      characteristic: row.category === 'raw' ? undefined : row.characteristic,
      characteristicDetail: row.category === 'raw' ? undefined : row.characteristicDetail,
      materialKind: draft.materialKind,
      unit: draft.unit,
      packageQty: draft.packageQty,
      warehouseZone: draft.warehouseZone,
      documentRef: draft.documentRef,
      comment: draft.comment,
    });
    cancelRowEdit(row.id);
  }

  function openMaterialDialog(mode: WarehouseMaterialDialogMode, row?: WarehouseInventoryRow) {
    setReceiptError(null);
    receiptOperationKeyRef.current = null;
    if (isLiveInventory && mode === 'receive') {
      try {
        receiptOperationKeyRef.current = createOperationKey();
      } catch (error) {
        setReceiptError(
          error instanceof Error ? error.message : 'Не удалось создать безопасный ключ операции.',
        );
      }
    }
    setMaterialDialogMode(mode);
    setMaterialDialogDraft(createMaterialDraft(mode, row ?? selectedRow, activeCategory.id));
  }

  function closeMaterialDialog() {
    if (receiptBusy) return;
    receiptOperationKeyRef.current = null;
    setReceiptError(null);
    setMaterialDialogMode(null);
  }

  function updateMaterialDialogDraft<K extends keyof WarehouseMaterialFormDraft>(
    field: K,
    value: WarehouseMaterialFormDraft[K],
  ) {
    setMaterialDialogDraft((current) => ({ ...current, [field]: value }));
  }

  function materialDialogInvalid() {
    if (!materialDialogMode) return true;
    const qty = parseDraftQty(materialDialogDraft.qty);
    if (!materialDialogDraft.label.trim()) return true;
    if (!materialDialogDraft.reason.trim()) return true;
    const isLiveReceipt = isLiveInventory && materialDialogMode === 'receive';
    if (isLiveReceipt && !receiptOperationKeyRef.current) return true;
    if (isLiveReceipt && warehouseRawMaterialReceiptValidationError(materialDialogDraft)) {
      return true;
    }
    if (!isLiveReceipt && !materialDialogDraft.unit.trim()) return true;
    const weightKg = parseDraftQty(materialDialogDraft.weightKg);
    if (isRolls && (!Number.isInteger(qty) || !Number.isFinite(weightKg) || weightKg <= 0))
      return true;
    return !Number.isFinite(qty) || qty <= 0;
  }

  async function submitMaterialDialog() {
    if (!materialDialogMode || materialDialogInvalid()) return;
    const isLiveReceipt = isLiveInventory && materialDialogMode === 'receive';
    if (isLiveReceipt) {
      if (receiptInFlightRef.current || receiptBusy) return;
      if (
        !onReceiveRawMaterial ||
        !materialDialogDraft.materialId.trim() ||
        !receiptOperationKeyRef.current
      ) {
        return;
      }

      const reason = composeWarehouseRawMaterialReceiptReason(materialDialogDraft);
      receiptInFlightRef.current = true;
      setReceiptBusy(true);
      setReceiptError(null);
      const result = await runWarehouseRawMaterialReceipt(onReceiveRawMaterial, {
        materialId: materialDialogDraft.materialId.trim(),
        operationKey: receiptOperationKeyRef.current,
        receivedQty: parseDraftQty(materialDialogDraft.qty),
        reason,
      });
      receiptInFlightRef.current = false;
      setReceiptBusy(false);
      if (!result.success) {
        setReceiptError(result.error);
        return;
      }

      receiptOperationKeyRef.current = null;
      setMaterialDialogDraft(createMaterialDraft('receive'));
      setMaterialDialogMode(null);
      return;
    }

    const label = materialDialogDraft.label.trim();
    onStockMutation?.({
      materialId: materialDialogDraft.materialId.trim() || materialIdFromLabel(label),
      category: activeCategory.id,
      kind: materialDialogMode === 'create' ? 'create' : 'receive',
      qty: parseDraftQty(materialDialogDraft.qty),
      weightKg: isRolls ? parseDraftQty(materialDialogDraft.weightKg) : undefined,
      reason: [
        materialDialogDraft.reason.trim(),
        materialDialogDraft.documentRef.trim()
          ? `Документ: ${materialDialogDraft.documentRef.trim()}`
          : '',
        materialDialogDraft.comment.trim()
          ? `Комментарий: ${materialDialogDraft.comment.trim()}`
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      linkedOrderId: materialDialogDraft.linkedOrderId,
      label,
      subtitle: activeCategory.label,
      characteristic: materialDialogDraft.packageQty,
      characteristicDetail: materialDialogDraft.comment,
      materialKind: materialDialogDraft.materialKind,
      unit: materialDialogDraft.unit,
      packageQty: materialDialogDraft.packageQty,
      warehouseZone: materialDialogDraft.warehouseZone,
      documentRef: materialDialogDraft.documentRef,
      comment: materialDialogDraft.comment,
    });
    setMaterialDialogMode(null);
  }

  function sortDirectionFor(column: WarehouseInventorySortColumn): 'asc' | 'desc' | 'none' {
    if (sortState.column !== column || sortState.direction === 'none') return 'none';
    return sortState.direction;
  }

  const warehouseTableColumns: Array<PlenkiDataTableColumn<WarehouseInventoryRow>> = [
    {
      id: 'object',
      header: 'Объект',
      dataLabel: 'Объект',
      sortable: true,
      sortDirection: sortDirectionFor('object'),
      onSort: () => setSortState((current) => nextWarehouseInventorySortState(current, 'object')),
      ariaLabel: 'Сортировать: Объект',
      render: (row) => {
        const isEditing = editingRowId === row.id;
        const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
        return isEditing ? (
          <label
            className="warehouse-inline-field state-manual"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              value={editDraft.label}
              onChange={(event) => updateRowEditDraft(row.id, 'label', event.target.value)}
              aria-label="Материал"
            />
            <small>ручное</small>
          </label>
        ) : (
          <>
            <strong>{row.title}</strong>
            <small>{row.subtitle}</small>
          </>
        );
      },
    },
    ...(isRolls
      ? [
          {
            id: 'characteristic',
            header: 'Товар',
            dataLabel: 'Товар',
            sortable: true,
            sortDirection: sortDirectionFor('characteristic'),
            onSort: () =>
              setSortState((current) => nextWarehouseInventorySortState(current, 'characteristic')),
            ariaLabel: 'Сортировать: Товар',
            width: '22%',
            render: (row: WarehouseInventoryRow) => (
              <>
                <strong>{row.productDescription ?? row.characteristic ?? row.subtitle}</strong>
                <small>
                  {row.materialDescription ?? row.characteristicDetail ?? 'материал не указан'}
                </small>
              </>
            ),
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
          {
            id: 'order',
            header: 'Заказ',
            dataLabel: 'Заказ',
            width: '12%',
            render: (row: WarehouseInventoryRow) => (
              <>
                <strong>{row.orderId ?? 'Не назначен'}</strong>
                <small>
                  {row.positionId ??
                    (row.ownership === 'free_reserve' ? 'свободный остаток' : 'позиция не указана')}
                </small>
              </>
            ),
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
          {
            id: 'customer',
            header: 'Клиент',
            dataLabel: 'Клиент',
            width: '13%',
            render: (row: WarehouseInventoryRow) => (
              <>
                <strong>{row.customerLabel ?? 'не указан'}</strong>
                <small>
                  {row.ownership === 'free_reserve'
                    ? 'без назначенного заказчика'
                    : 'заказный контекст'}
                </small>
              </>
            ),
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : isConsumables
        ? [
            {
              id: 'characteristic',
              header: 'Характеристика',
              dataLabel: 'Характеристика',
              sortable: true,
              sortDirection: sortDirectionFor('characteristic'),
              onSort: () =>
                setSortState((current) =>
                  nextWarehouseInventorySortState(current, 'characteristic'),
                ),
              ariaLabel: 'Сортировать: Характеристика',
              render: (row: WarehouseInventoryRow) => (
                <>
                  <strong>{row.characteristic ?? 'не указана'}</strong>
                  {row.characteristicDetail && <small>{row.characteristicDetail}</small>}
                </>
              ),
            } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
          ]
        : []),
    {
      id: 'primaryQty',
      header: isConsumables ? 'Норма' : 'На складе',
      dataLabel: isConsumables ? 'Норма' : 'На складе',
      sortable: true,
      sortDirection: sortDirectionFor('primaryQty'),
      onSort: () =>
        setSortState((current) => nextWarehouseInventorySortState(current, 'primaryQty')),
      ariaLabel: `Сортировать: ${isConsumables ? 'Норма' : 'На складе'}`,
      render: (row) => {
        const isEditing = editingRowId === row.id;
        const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
        return isEditing ? (
          <label
            className={`warehouse-inline-field ${parseDraftQty(editDraft.qty) < 0 ? 'state-invalid' : 'state-manual'}`}
            onClick={(event) => event.stopPropagation()}
          >
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.1"
              value={editDraft.qty}
              onChange={(event) => updateRowEditDraft(row.id, 'qty', event.target.value)}
              aria-label="Факт склада"
            />
            <small>{editDraft.unit}</small>
          </label>
        ) : (
          <strong>{row.primaryQty}</strong>
        );
      },
    },
    ...(!isRolls
      ? [
          {
            id: 'secondaryQty',
            header: isConsumables ? 'Единица / эффект' : 'По учету / эффект',
            dataLabel: isConsumables ? 'Единица / эффект' : 'По учету / эффект',
            sortable: true,
            sortDirection: sortDirectionFor('secondaryQty'),
            onSort: () =>
              setSortState((current) => nextWarehouseInventorySortState(current, 'secondaryQty')),
            ariaLabel: `Сортировать: ${isConsumables ? 'Единица / эффект' : 'По учету / эффект'}`,
            render: (row) => {
              const isEditing = editingRowId === row.id;
              const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
              return isEditing ? (
                <label
                  className="warehouse-inline-field state-manual"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    value={editDraft.packageQty}
                    onChange={(event) =>
                      updateRowEditDraft(row.id, 'packageQty', event.target.value)
                    }
                    aria-label="Упаковка"
                    placeholder="Упаковка"
                  />
                  <small>упаковка</small>
                </label>
              ) : (
                row.secondaryQty
              );
            },
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : []),
    ...(!isConsumables
      ? [
          {
            id: 'status',
            header: 'Статус',
            dataLabel: 'Статус',
            sortable: true,
            sortDirection: sortDirectionFor('status'),
            onSort: () =>
              setSortState((current) => nextWarehouseInventorySortState(current, 'status')),
            ariaLabel: 'Сортировать: Статус',
            render: (row: WarehouseInventoryRow) => {
              const isEditing = editingRowId === row.id;
              const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
              const invalidEdit = rowDraftInvalid(editDraft);
              return isEditing && isRaw ? (
                <label
                  className="warehouse-inline-field state-manual"
                  onClick={(event) => event.stopPropagation()}
                >
                  <select
                    value={editDraft.materialKind}
                    onChange={(event) =>
                      updateRowEditDraft(
                        row.id,
                        'materialKind',
                        event.target.value as RawMaterialStock['materialKind'],
                      )
                    }
                    aria-label="Тип сырья"
                  >
                    {materialKindOptions.map((kind) => (
                      <option key={kind} value={kind}>
                        {materialKindLabels[kind]}
                      </option>
                    ))}
                  </select>
                  <small>{invalidEdit ? 'ошибка' : 'ручное'}</small>
                </label>
              ) : isEditing && isRolls ? (
                <label
                  className={`warehouse-inline-field ${editDraft.reason.trim() ? 'state-manual' : 'state-invalid'}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    value={editDraft.reason}
                    onChange={(event) => updateRowEditDraft(row.id, 'reason', event.target.value)}
                    aria-label="Причина"
                    placeholder="Причина"
                  />
                  <small>{editDraft.reason.trim() ? 'audit' : 'обязательно'}</small>
                </label>
              ) : (
                <>
                  <strong>{row.status}</strong>
                  {isRolls && <small>{row.secondaryQty}</small>}
                </>
              );
            },
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : []),
    ...(!isRolls
      ? [
          {
            id: 'source',
            header: 'Откуда',
            dataLabel: 'Откуда',
            sortable: true,
            sortDirection: sortDirectionFor('source'),
            onSort: () =>
              setSortState((current) => nextWarehouseInventorySortState(current, 'source')),
            ariaLabel: 'Сортировать: Откуда',
            render: (row) => {
              const isEditing = editingRowId === row.id;
              const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
              return isEditing ? (
                <label
                  className={`warehouse-inline-field ${editDraft.reason.trim() ? 'state-manual' : 'state-invalid'}`}
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    value={editDraft.reason}
                    onChange={(event) => updateRowEditDraft(row.id, 'reason', event.target.value)}
                    aria-label="Причина"
                    placeholder="Причина"
                  />
                  <small>{editDraft.reason.trim() ? 'audit' : 'обязательно'}</small>
                </label>
              ) : (
                row.source
              );
            },
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : []),
    ...(isEditableInventory
      ? [
          {
            id: 'actions',
            header: '',
            dataLabel: 'Действие',
            width: isRolls ? '210px' : '190px',
            render: (row: WarehouseInventoryRow) => {
              const isEditing = editingRowId === row.id;
              const editDraft = rowEditDrafts[row.id] ?? createRowEditDraft(row);
              const invalidEdit = rowDraftInvalid(editDraft);
              const printAction = row.actions.find(
                (action) =>
                  action.id.startsWith('warehouse-print-roll-label') ||
                  action.id.startsWith('warehouse-reprint-roll-label'),
              );
              return (
                <span className="warehouse-row-edit-actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="is-primary"
                        disabled={invalidEdit}
                        onClick={(event) => {
                          event.stopPropagation();
                          submitRowEdit(row);
                        }}
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          cancelRowEdit(row.id);
                        }}
                      >
                        Отмена
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          startRowEdit(row);
                        }}
                      >
                        Правка
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openMaterialDialog('receive', row);
                        }}
                      >
                        {actionLabels.rowReceive}
                      </button>
                      {printAction && (
                        <button
                          type="button"
                          className="warehouse-row-print-action"
                          disabled={!printAction.enabled}
                          title={
                            printAction.enabled
                              ? (printAction.helpText ??
                                printAction.confirmation ??
                                printAction.label)
                              : (printAction.disabledReason ?? printAction.recoveryAction)
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onAction?.(printAction.id);
                          }}
                        >
                          <ix-icon name={actionIcon(printAction)} size="12" />
                          <span>Печать</span>
                        </button>
                      )}
                    </>
                  )}
                </span>
              );
            },
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : []),
    ...(canOfferLiveRawCorrection
      ? [
          {
            id: 'actions',
            header: '',
            dataLabel: 'Действие',
            width: '190px',
            render: (row: WarehouseInventoryRow) =>
              row.rawMaterialId ? (
                <span className="warehouse-row-edit-actions">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      selectRow(row);
                    }}
                  >
                    Корректировать остаток
                  </button>
                </span>
              ) : null,
          } satisfies PlenkiDataTableColumn<WarehouseInventoryRow>,
        ]
      : []),
  ];

  const materialOptions = activeCategory.rows;
  const isLiveReceiptDialog = isLiveInventory && materialDialogMode === 'receive';
  const receiptDraftValidationError = isLiveReceiptDialog
    ? warehouseRawMaterialReceiptValidationError(materialDialogDraft)
    : null;
  const showReceiptDraftValidationError = shouldShowWarehouseRawMaterialReceiptValidation(
    receiptDraftValidationError,
    materialDialogDraft.qty,
  );

  useEffect(() => {
    setStockView(resolvedStockView);
  }, [resolvedStockView]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipStockViewUrlSyncRef.current) {
      skipStockViewUrlSyncRef.current = false;
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.delete('stockBucket');
    params.delete('availability');
    if (stockView === 'processed') params.set('view', 'processed');
    else params.delete('view');
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
    );
  }, [stockView]);

  if (showStockWorkspace) {
    return (
      <section className="warehouse-inventory-cockpit" aria-label="Остатки склада">
        {finishedStockEnabled && onCoverPropose && onCoverRefresh && (
          <WarehouseCoverTasksPanel
            tasks={coverTasks}
            freeRolls={coverFreeRolls}
            selectedObjectId={selectedWarehouseObjectId}
            onSelectObject={onSelectWarehouseObject}
            onPropose={onCoverPropose}
            onRefresh={onCoverRefresh}
            liveCoverageEnabled
            refreshGeneration={coverageRefreshGeneration}
          />
        )}
        {finishedStockEnabled ? (
          <WarehouseStockWorkspace
            view={stockView}
            onViewChange={setStockView}
            canCreate={canCreateReserveRoll}
            materials={materialRecipeCatalog?.materials}
            recipes={materialRecipeCatalog?.recipes}
            catalogStatus={materialRecipeCatalog?.status}
            catalogError={materialRecipeCatalog?.error}
            onReloadCatalog={() => void materialRecipeCatalog?.reload()}
          />
        ) : (
          <section className="warehouse-stock-workspace is-unavailable" aria-label="Все рулоны">
            <h2>Все рулоны временно недоступны</h2>
            <p>Подключите рабочий контур склада и повторите загрузку.</p>
          </section>
        )}
      </section>
    );
  }

  if (isLiveInventory && isConsumables) {
    return (
      <section className="warehouse-inventory-cockpit" aria-label="Расходники склада">
        <WarehouseAccountingStockPanel scope="consumables" />
      </section>
    );
  }

  if (isLiveInventory && activeCategory.id === 'movements') {
    return (
      <section className="warehouse-inventory-cockpit" aria-label="Движения склада">
        <WarehouseAccountingMovementsPanel />
      </section>
    );
  }

  return (
    <section className="warehouse-inventory-cockpit" aria-label="Остатки склада">
      {isLiveInventory && isRaw ? (
        <>
          {canInspectQr ? <WarehouseQrInspectionPanel /> : null}
          <SharedBigBagRegister refreshGeneration={bigBagRefreshRevision} view="current" />
          {canManageSpoolReceipt ? <WarehouseSpoolPriceForm /> : null}
          {canManageBigBags ? (
            <WarehouseBigBagManagementPanel refreshRevision={bigBagRefreshRevision} />
          ) : null}
        </>
      ) : null}
      <div className="warehouse-inventory-layout">
        <div className="warehouse-inventory-main">
          {showInventoryTableHead ? (
            <div className="warehouse-inventory-table-head">
              {isRaw ? null : (
                <span>
                  <ix-icon name={categoryIcon(activeCategory.id)} size="16" />
                  <strong>{activeCategory.label}</strong>
                </span>
              )}
              <div className="warehouse-inventory-table-actions">
                {canCreateBigBag ? (
                  <button
                    type="button"
                    className="action-recommended"
                    onClick={() => setBigBagCreateOpen(true)}
                  >
                    + Создать Big-Bag
                  </button>
                ) : null}
                {canCreateMaterialRecipe ? (
                  <button
                    type="button"
                    className="action-secondary"
                    onClick={() => setRecipeEditorOpen(true)}
                  >
                    Создать рецептуру
                  </button>
                ) : null}
                {isEditableInventory && (
                  <>
                    {!isRaw ? (
                      <button
                        type="button"
                        disabled={!selectedRow}
                        title={selectedRow ? actionLabels.receive : 'Сначала выберите позицию'}
                        onClick={() => openMaterialDialog('receive', selectedRow)}
                      >
                        {actionLabels.receive}
                      </button>
                    ) : null}
                    <button type="button" onClick={() => openMaterialDialog('create')}>
                      {actionLabels.create}
                    </button>
                  </>
                )}
                {isRaw && onOneCStockPush ? (
                  <button
                    type="button"
                    className="action-warning"
                    disabled={oneCStockPushBusy}
                    aria-busy={oneCStockPushBusy}
                    title="Сначала проверяет серверную готовность записи; документ не создаётся без отдельного подтверждения"
                    onClick={onOneCStockPush}
                  >
                    Проверить учёт
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <PlenkiToolbar
            className="warehouse-inventory-toolbar"
            searchValue={searchQuery}
            searchPlaceholder="Поиск"
            onSearchChange={setSearchQuery}
            filters={quickFilters.map((filterItem) => ({
              id: filterItem.id,
              label: filterItem.label,
              count: filterItem.count,
              active: quickFilterId === filterItem.id,
              onClick: () => setQuickFilterId(filterItem.id),
            }))}
            meta={
              <>
                <span>{visibleRows.length} найдено</span>
                <button type="button" disabled={!hasTableControls} onClick={resetTableControls}>
                  Сбросить
                </button>
              </>
            }
          />

          <PlenkiDataTable
            caption={activeCategory.label}
            columns={warehouseTableColumns}
            rows={pagedRows}
            tableClassName={`warehouse-inventory-data-table warehouse-inventory-data-table-${activeCategory.id}`}
            getRowKey={(row) => row.id}
            getRowClassName={(row) =>
              `${rowStatusClass(row)} ${editingRowId === row.id ? 'is-editing' : ''}`
            }
            isRowSelected={(row) => selectedRow?.id === row.id}
            onRowClick={(row) => {
              if (editingRowId !== row.id) selectRow(row);
            }}
            empty={
              <div className="warehouse-inventory-empty warehouse-inventory-table-empty">
                <strong>
                  {isLiveInventory && isRolls
                    ? 'Физические рулоны пока не приняты'
                    : 'Ничего не найдено'}
                </strong>
                <small>
                  {isLiveInventory && isRolls
                    ? 'Рулоны появятся после приемки по QR и подтверждения склада.'
                    : 'Измените поиск или сбросьте фильтры.'}
                </small>
              </div>
            }
          />
          {pageCount > 1 ? (
            <TablePager
              page={safePage}
              pageCount={pageCount}
              total={visibleRows.length}
              startIndex={startIndex}
              endIndex={endIndex}
              onPageChange={setTablePage}
              pageSize={pageSize}
              pageSizeOptions={responsivePageSize <= 10 ? [10, 25] : [10, 25, 50]}
              onPageSizeChange={setPageSize}
            />
          ) : null}
        </div>

        <aside className="warehouse-inventory-detail" aria-label="Детали выбранного остатка">
          {selectedRow ? (
            <>
              <div className="warehouse-inventory-detail-head">
                <button
                  type="button"
                  className="warehouse-inventory-detail-close"
                  aria-label="Закрыть позицию склада"
                  title="Закрыть позицию"
                  onClick={clearSelectedRow}
                >
                  <ix-icon name="close" size="16" />
                </button>
                <span>{activeCategory.label}</span>
                <h3>{selectedRow.title}</h3>
                <p>{selectedRow.subtitle}</p>
                <div className={`warehouse-inventory-status-line ${rowStatusClass(selectedRow)}`}>
                  <strong>{selectedRow.status}</strong>
                  <small>{selectedRow.primaryQty}</small>
                </div>
              </div>
              {selectedRow.actions.length > 0 && (
                <ActionPanel
                  actions={selectedRow.actions}
                  title="Действия"
                  variant="default"
                  embedded
                  className="warehouse-inventory-actions"
                  onAction={handleInventoryAction}
                />
              )}
              {activeCategory.id === 'raw' &&
              selectedRow.rawMaterialId &&
              (isEditableInventory || canCorrectLiveRaw) ? (
                <div
                  className="warehouse-inventory-quick-edit"
                  aria-label="Ручная правка количества"
                >
                  <label>
                    <span>Операция</span>
                    {canCorrectLiveRaw ? (
                      <strong>{stockMutationLabels.correction}</strong>
                    ) : (
                      <select
                        value={mutationKind}
                        onChange={(event) => {
                          setMutationKind(event.target.value as InventoryMutationKind);
                          if (selectedRow)
                            setManualQtyDrafts((current) => ({ ...current, [selectedRow.id]: '' }));
                        }}
                      >
                        {quickStockMutationOptions.map((value) => (
                          <option key={value} value={value}>
                            {stockMutationLabels[value]}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                  <label>
                    <span>
                      {effectiveMutationKind === 'correction'
                        ? editLabelForCategory(activeCategory.id)
                        : `Количество, ${selectedRow.unit ?? ''}`}
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      value={selectedManualQty}
                      disabled={canCorrectLiveRaw && adjustmentBusy}
                      aria-label="Факт склада"
                      onChange={(event) =>
                        selectedRow &&
                        setManualQtyDrafts((current) => ({
                          ...current,
                          [selectedRow.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {(effectiveMutationKind === 'reserve' ||
                    effectiveMutationKind === 'release_reserve') && (
                    <label>
                      <span>Заказ</span>
                      <input
                        value={linkedOrderId}
                        onChange={(event) => setLinkedOrderId(event.target.value)}
                        placeholder="Например: З-2606-019"
                      />
                    </label>
                  )}
                  <label>
                    <span>Причина</span>
                    <textarea
                      value={mutationReason}
                      disabled={canCorrectLiveRaw && adjustmentBusy}
                      onChange={(event) => setMutationReason(event.target.value)}
                      placeholder="Например: пересчет после приемки сырья"
                    />
                  </label>
                  {canCorrectLiveRaw && adjustmentError ? (
                    <div role="alert" className="warehouse-inventory-adjustment-error">
                      {adjustmentError}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className="ix-button action-recommended"
                    disabled={
                      canCorrectLiveRaw ? !canSubmitLiveAdjustment : !canSubmitStockMutation
                    }
                    aria-busy={canCorrectLiveRaw ? adjustmentBusy : undefined}
                    onClick={
                      canCorrectLiveRaw
                        ? () => void submitLiveRawMaterialAdjustment()
                        : submitStockMutation
                    }
                  >
                    {canCorrectLiveRaw && adjustmentBusy ? 'Сохраняем…' : 'Записать изменение'}
                  </button>
                  {isEditableInventory ? (
                    <button
                      type="button"
                      className="ix-button action-secondary"
                      onClick={() => selectedRow && openMaterialDialog('receive', selectedRow)}
                    >
                      Открыть приход
                    </button>
                  ) : null}
                </div>
              ) : isEditableInventory && activeCategory.id !== 'rolls' ? (
                <div
                  className="warehouse-inventory-quick-edit"
                  aria-label="Ручная правка количества"
                >
                  <label>
                    <span>{editLabelForCategory(activeCategory.id)}</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      value={selectedManualQty}
                      onChange={(event) =>
                        selectedRow &&
                        setManualQtyDrafts((current) => ({
                          ...current,
                          [selectedRow.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="ix-button action-recommended"
                    onClick={() => selectedRow && openMaterialDialog('receive', selectedRow)}
                  >
                    {actionLabels.receiveTitle}
                  </button>
                </div>
              ) : null}
              {(activeCategory.id !== 'reserve' || reserveCompositionOpenId === selectedRow.id) && (
                <>
                  {activeCategory.id === 'reserve' && (
                    <button
                      type="button"
                      className="ix-button action-secondary"
                      onClick={() => setReserveCompositionOpenId(null)}
                    >
                      Закрыть состав
                    </button>
                  )}
                  <dl className="warehouse-inventory-detail-list">
                    {selectedDetails.map((detail) => (
                      <div key={`${selectedRow.id}:${detail.label}`}>
                        <dt>{detail.label}</dt>
                        <dd>{detail.value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </>
          ) : (
            <div className="warehouse-inventory-empty">
              <strong>{visibleRows.length > 0 ? 'Выберите позицию' : 'Нет строк'}</strong>
              <span>
                {visibleRows.length > 0
                  ? 'Откройте строку слева, чтобы увидеть детали и действия.'
                  : 'В этой категории пока нет складских остатков.'}
              </span>
            </div>
          )}
        </aside>
      </div>
      {recipeEditorOpen && canCreateMaterialRecipe && materialRecipeCatalog ? (
        <RecipeEditorModal
          materials={materialRecipeCatalog.materials}
          catalogStatus={materialRecipeCatalog.status}
          catalogError={materialRecipeCatalog.error}
          onRetryCatalog={() => void materialRecipeCatalog.reload()}
          onSave={materialRecipeCatalog.createRecipe}
          onCreated={() => undefined}
          onClose={() => setRecipeEditorOpen(false)}
        />
      ) : null}
      {bigBagCreateOpen && canCreateBigBag && onCreateBigBag ? (
        <WarehouseBigBagCreateModal
          onCreate={async (input) => {
            const created = await onCreateBigBag(input);
            if (created) {
              setBigBagRefreshRevision((current) => current + 1);
            }
            return created;
          }}
          onClose={() => setBigBagCreateOpen(false)}
          materials={materialRecipeCatalog?.materials ?? []}
          catalogStatus={materialRecipeCatalog?.status ?? 'loading'}
          catalogError={materialRecipeCatalog?.error ?? null}
          onReloadCatalog={() => void materialRecipeCatalog?.reload()}
        />
      ) : null}
      {materialDialogMode && (
        <PlenkiModal
          eyebrow={
            materialDialogMode === 'create' ? actionLabels.createTitle : actionLabels.receiveTitle
          }
          title={isLiveReceiptDialog ? 'Оприходовать сырьё' : 'Ручная складская запись'}
          onClose={() => {
            closeMaterialDialog();
          }}
          className="warehouse-material-dialog"
          footer={
            <>
              <button
                type="button"
                className="action-secondary"
                disabled={receiptBusy}
                onClick={closeMaterialDialog}
              >
                Отмена
              </button>
              <button
                type="button"
                className="action-recommended"
                disabled={materialDialogInvalid() || receiptBusy}
                aria-busy={isLiveReceiptDialog ? receiptBusy : undefined}
                onClick={() => void submitMaterialDialog()}
              >
                {isLiveReceiptDialog ? (receiptBusy ? 'Оприходуем…' : 'Оприходовать') : 'Записать'}
              </button>
            </>
          }
        >
          <small className="warehouse-material-source-line">
            {materialDialogMode === 'create'
              ? actionLabels.sourceCreate
              : actionLabels.sourceReceive}
          </small>
          <div className="warehouse-material-dialog-grid">
            {!isLiveReceiptDialog ? (
              <>
                <datalist id="warehouse-raw-material-options">
                  {materialOptions.map((row) => (
                    <option key={row.id} value={row.title} />
                  ))}
                </datalist>
                <label>
                  <span>{isRaw ? 'Материал' : 'Позиция'}</span>
                  <input
                    list="warehouse-raw-material-options"
                    value={materialDialogDraft.label}
                    onChange={(event) => updateMaterialDialogDraft('label', event.target.value)}
                  />
                </label>
                {isRaw && (
                  <label>
                    <span>Тип</span>
                    <select
                      value={materialDialogDraft.materialKind}
                      onChange={(event) =>
                        updateMaterialDialogDraft(
                          'materialKind',
                          event.target.value as RawMaterialStock['materialKind'],
                        )
                      }
                    >
                      {materialKindOptions.map((kind) => (
                        <option key={kind} value={kind}>
                          {materialKindLabels[kind]}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <label className="is-wide">
                <span>Материал</span>
                <input value={materialDialogDraft.label} disabled />
              </label>
            )}
            <label>
              <span>
                {isLiveReceiptDialog
                  ? `Приход, ${materialDialogDraft.unit}`
                  : isRolls
                    ? 'Рулоны'
                    : 'Количество'}
              </span>
              <input
                type="number"
                inputMode={isRolls ? 'numeric' : 'decimal'}
                min={isLiveReceiptDialog ? 0.001 : 0}
                max={isLiveReceiptDialog ? 1_000_000 : undefined}
                step={isLiveReceiptDialog ? '0.001' : isRolls ? '1' : '0.1'}
                value={materialDialogDraft.qty}
                disabled={isLiveReceiptDialog && receiptBusy}
                onChange={(event) => updateMaterialDialogDraft('qty', event.target.value)}
              />
            </label>
            {!isLiveReceiptDialog && isRolls && (
              <label>
                <span>Вес, кг</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  value={materialDialogDraft.weightKg}
                  onChange={(event) => updateMaterialDialogDraft('weightKg', event.target.value)}
                />
              </label>
            )}
            {!isLiveReceiptDialog && (
              <>
                <label>
                  <span>Ед.</span>
                  <select
                    value={materialDialogDraft.unit}
                    onChange={(event) => updateMaterialDialogDraft('unit', event.target.value)}
                  >
                    {availableUnitOptions.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Упаковка</span>
                  <input
                    value={materialDialogDraft.packageQty}
                    onChange={(event) =>
                      updateMaterialDialogDraft('packageQty', event.target.value)
                    }
                    placeholder="мешки 25 кг"
                  />
                </label>
                <label>
                  <span>Склад</span>
                  <input
                    value={materialDialogDraft.warehouseZone}
                    onChange={(event) =>
                      updateMaterialDialogDraft('warehouseZone', event.target.value)
                    }
                  />
                </label>
              </>
            )}
            <label>
              <span>Документ</span>
              <input
                value={materialDialogDraft.documentRef}
                disabled={isLiveReceiptDialog && receiptBusy}
                onChange={(event) => updateMaterialDialogDraft('documentRef', event.target.value)}
                placeholder="Накладная или пересчет"
              />
            </label>
            {!isLiveReceiptDialog && (
              <label>
                <span>Заказ</span>
                <input
                  value={materialDialogDraft.linkedOrderId}
                  onChange={(event) =>
                    updateMaterialDialogDraft('linkedOrderId', event.target.value)
                  }
                  placeholder="если есть"
                />
              </label>
            )}
            <label className="is-wide">
              <span>Причина</span>
              <textarea
                value={materialDialogDraft.reason}
                disabled={isLiveReceiptDialog && receiptBusy}
                onChange={(event) => updateMaterialDialogDraft('reason', event.target.value)}
                placeholder="Например: ручная приемка по накладной"
              />
            </label>
            <label className="is-wide">
              <span>Комментарий</span>
              <textarea
                value={materialDialogDraft.comment}
                disabled={isLiveReceiptDialog && receiptBusy}
                onChange={(event) => updateMaterialDialogDraft('comment', event.target.value)}
                placeholder="Внутренний комментарий склада"
              />
            </label>
            {isLiveReceiptDialog && receiptError ? (
              <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
                {receiptError}
              </div>
            ) : null}
            {isLiveReceiptDialog && showReceiptDraftValidationError ? (
              <div role="alert" className="warehouse-inventory-adjustment-error is-wide">
                {receiptDraftValidationError}
              </div>
            ) : null}
          </div>
        </PlenkiModal>
      )}
    </section>
  );
}
