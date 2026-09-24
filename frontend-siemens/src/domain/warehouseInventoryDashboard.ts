import { commercialWorkObjects } from './fixtures/commercial';
import {
  inventoryReconciliations,
  rawMaterialStocks,
  reservePreparationTask,
  secondaryRawMaterialMovements,
  tapeConsumptionCorrections,
  tapeConsumptionNorms,
  warehouseRollOwnershipLabel,
} from './inventoryContracts';
import { visibleAuditActionLabel, warehouseSourceLabel } from './displayContracts';
import { counterpartyAlias } from './templates';
import type {
  ActionDescriptor,
  CommercialOrderPosition,
  RawMaterialStock,
  RollStickerStatus,
  Severity,
  WarehouseCoverFreeRoll,
  WarehouseCoverProposal,
  WarehouseInventoryCategory,
  WarehouseInventoryOverride,
  WarehouseRollOwnership,
  WorkObject,
} from './types';
export type { WarehouseInventoryCategory } from './types';

export type WarehouseInventorySummary = {
  id: string;
  label: string;
  value: string;
  detail: string;
  severity: Severity;
};

export type WarehouseInventoryRow = {
  id: string;
  category: WarehouseInventoryCategory;
  rawMaterialId?: string;
  orderId?: string;
  positionId?: string;
  customerLabel?: string;
  ownership?: WarehouseRollOwnership;
  productDescription?: string;
  materialDescription?: string;
  printState?: RollStickerStatus;
  title: string;
  subtitle: string;
  characteristic?: string;
  characteristicDetail?: string;
  primaryQty: string;
  secondaryQty: string;
  unit?: string;
  actualQty?: number;
  reservedQty?: number;
  availableQty?: number;
  status: string;
  source: string;
  severity: Severity;
  details: Array<{ label: string; value: string }>;
  actions: ActionDescriptor[];
};

export type WarehouseInventoryMovementRow = WarehouseInventoryRow & {
  movementKind: 'receiving' | 'secondary_transfer' | 'correction' | 'audit';
};

export type WarehouseInventoryDashboard = {
  summaries: WarehouseInventorySummary[];
  categories: Array<{
    id: WarehouseInventoryCategory;
    label: string;
    rows: WarehouseInventoryRow[];
  }>;
};

export type WarehouseInventorySortColumn =
  | 'object'
  | 'characteristic'
  | 'primaryQty'
  | 'secondaryQty'
  | 'status'
  | 'source';
export type WarehouseInventorySortDirection = 'none' | 'asc' | 'desc';
export type WarehouseInventorySortState = {
  column: WarehouseInventorySortColumn;
  direction: WarehouseInventorySortDirection;
};

export type WarehouseInventoryQuickFilter = {
  id: string;
  label: string;
  count: number;
};

export type WarehouseRollPrintAction = {
  rollId: string;
  isReprint: boolean;
};

export const warehouseInventoryDefaultSortState: WarehouseInventorySortState = {
  column: 'object',
  direction: 'none',
};

export function parseWarehouseRollPrintAction(actionId: string): WarehouseRollPrintAction | null {
  const printPrefix = 'warehouse-print-roll-label:';
  const reprintPrefix = 'warehouse-reprint-roll-label:';
  if (actionId.startsWith(reprintPrefix)) {
    const rollId = actionId.slice(reprintPrefix.length);
    return rollId ? { rollId, isReprint: true } : null;
  }
  if (actionId.startsWith(printPrefix)) {
    const rollId = actionId.slice(printPrefix.length);
    return rollId ? { rollId, isReprint: false } : null;
  }
  return null;
}

function rowSearchText(row: WarehouseInventoryRow) {
  return [
    row.title,
    row.subtitle,
    row.status,
    row.source,
    row.primaryQty,
    row.secondaryQty,
    row.characteristic,
    row.characteristicDetail,
    ...row.details.flatMap((detail) => [detail.label, detail.value]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function rowMatchesSearch(row: WarehouseInventoryRow, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return rowSearchText(row).includes(normalizedQuery);
}

function rowTypeLabel(row: WarehouseInventoryRow) {
  if (row.category === 'consumables') return row.subtitle;
  return row.characteristic ?? row.subtitle;
}

function rowMatchesSummary(summaryId: string | null, row: WarehouseInventoryRow) {
  if (!summaryId || summaryId === 'raw-total') return true;
  const normalized =
    `${row.title} ${row.subtitle} ${row.status} ${row.source} ${row.primaryQty} ${row.secondaryQty} ${row.details.map((detail) => detail.value).join(' ')}`.toLowerCase();
  if (summaryId === 'conflicts') return row.severity !== 'info' || normalized.includes('расхожд');
  if (summaryId === 'reserved-rolls')
    return Boolean(row.reservedQty && row.reservedQty > 0) || normalized.includes('резерв');
  if (summaryId === 'open-tasks')
    return (
      row.severity !== 'info' ||
      normalized.includes('задач') ||
      normalized.includes('ждет') ||
      normalized.includes('чернов')
    );
  return true;
}

function rowMatchesQuickFilter(row: WarehouseInventoryRow, filterId: string) {
  if (filterId === 'all') return true;
  if (filterId === 'attention') return row.severity !== 'info';
  if (filterId === 'ownership:free_reserve')
    return row.category === 'rolls' && row.ownership === 'free_reserve';
  if (filterId === 'ok') return row.severity === 'info';
  if (filterId.startsWith('status:')) return row.status === filterId.slice('status:'.length);
  if (filterId.startsWith('type:')) return rowTypeLabel(row) === filterId.slice('type:'.length);
  return true;
}

function buildQuickFilters(
  definitionRows: WarehouseInventoryRow[],
  countRows: WarehouseInventoryRow[],
): WarehouseInventoryQuickFilter[] {
  const hasFreeReserve = definitionRows.some(
    (row) => row.category === 'rolls' && row.ownership === 'free_reserve',
  );
  const freeReserveCount = countRows.filter(
    (row) => row.category === 'rolls' && row.ownership === 'free_reserve',
  ).length;
  const baseFilters = [
    { id: 'all', label: 'Все', count: countRows.length },
    {
      id: 'attention',
      label: 'Внимание',
      count: countRows.filter((row) => row.severity !== 'info').length,
    },
    ...(hasFreeReserve
      ? [{ id: 'ownership:free_reserve', label: 'Без заказчика', count: freeReserveCount }]
      : []),
    { id: 'ok', label: 'Норма', count: countRows.filter((row) => row.severity === 'info').length },
  ];
  const typeFilters = Array.from(new Set(definitionRows.map(rowTypeLabel).filter(Boolean)))
    .slice(0, 3)
    .map((label) => ({
      id: `type:${label}`,
      label,
      count: countRows.filter((row) => rowTypeLabel(row) === label).length,
    }));
  const statusFilters = Array.from(new Set(definitionRows.map((row) => row.status).filter(Boolean)))
    .filter((label) => !typeFilters.some((filter) => filter.label === label))
    .slice(0, 3)
    .map((label) => ({
      id: `status:${label}`,
      label,
      count: countRows.filter((row) => row.status === label).length,
    }));

  return [...baseFilters, ...typeFilters, ...statusFilters];
}

function numericValue(value: string) {
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function sortValue(row: WarehouseInventoryRow, column: WarehouseInventorySortColumn) {
  if (column === 'object') return `${row.title} ${row.subtitle}`;
  if (column === 'characteristic')
    return `${row.characteristic ?? ''} ${row.characteristicDetail ?? ''}`;
  if (column === 'primaryQty') return row.primaryQty;
  if (column === 'secondaryQty') return row.secondaryQty;
  if (column === 'status') return row.status;
  return row.source;
}

function compareSortValues(left: string, right: string) {
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right, 'ru', { numeric: true, sensitivity: 'base' });
}

function sortRows(rows: WarehouseInventoryRow[], sortState: WarehouseInventorySortState) {
  if (sortState.direction === 'none') return rows;
  const direction = sortState.direction === 'asc' ? 1 : -1;
  return [...rows].sort(
    (left, right) =>
      compareSortValues(sortValue(left, sortState.column), sortValue(right, sortState.column)) *
      direction,
  );
}

export function nextWarehouseInventorySortState(
  current: WarehouseInventorySortState,
  column: WarehouseInventorySortColumn,
): WarehouseInventorySortState {
  if (current.column !== column) return { column, direction: 'asc' };
  if (current.direction === 'none') return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return { column, direction: 'none' };
}

export function warehouseInventoryAriaSortValue(
  sortState: WarehouseInventorySortState,
  column: WarehouseInventorySortColumn,
) {
  if (sortState.column !== column || sortState.direction === 'none') return 'none';
  return sortState.direction === 'asc' ? 'ascending' : 'descending';
}

export function buildWarehouseInventoryTableProjection(
  rows: WarehouseInventoryRow[],
  state: {
    searchQuery: string;
    quickFilterId: string;
    summaryId: string | null;
    sortState: WarehouseInventorySortState;
  },
) {
  const searchedRows = rows.filter((row) => rowMatchesSearch(row, state.searchQuery));
  const quickFilters = buildQuickFilters(rows, searchedRows);
  const visibleRows = sortRows(
    searchedRows
      .filter((row) => rowMatchesSummary(state.summaryId, row))
      .filter((row) => rowMatchesQuickFilter(row, state.quickFilterId)),
    state.sortState,
  );

  return { searchedRows, quickFilters, visibleRows };
}

function sourceLabel(source: string) {
  if (source === '1C' || source === 'mock' || source === 'mock_1C') return 'учётный снимок';
  if (source === 'warehouse_fact' || source === 'warehouse_runtime') return 'факт склада';
  if (source === 'manual_platform') return 'ручной учет склада';
  return 'данные';
}

function rawMaterialKindLabel(kind: RawMaterialStock['materialKind']) {
  if (kind === 'primary') return 'Первичное сырье';
  if (kind === 'secondary') return 'Вторичное сырье';
  if (kind === 'additive') return 'Добавка';
  return 'Категория не указана';
}

function customerLabelFromObject(object: WorkObject) {
  const sourceValue =
    object.commercialOrder?.counterpartyId ??
    object.commercialOrder?.billingSnapshot?.label ??
    object.facts.find((fact) => fact.label === 'Контрагент')?.value ??
    object.title.split('·')[1]?.trim();
  return counterpartyAlias(sourceValue) ?? `Клиент ${object.commercialOrder?.id ?? object.id}`;
}

function productDescriptionFromPosition(
  position: CommercialOrderPosition | undefined,
  fallback: string,
) {
  if (!position) return fallback;
  return [position.filmType, position.actualThickness, position.spoolType]
    .filter(Boolean)
    .join(', ');
}

function materialDescriptionFromPosition(position: CommercialOrderPosition | undefined) {
  if (!position) return 'не указан';
  if (position.rawMaterials?.length) {
    return position.rawMaterials
      .slice(0, 2)
      .map((material) => `${material.label}: ${material.nominalQty} ${material.unit}`)
      .join('; ');
  }
  return position.rawMaterialLabel || position.rawMaterialId || 'не указан';
}

function printActionForRoll(roll: WarehouseCoverProposal['matchedRolls'][number]) {
  if (roll.warehouseUiStatus === 'shipped') {
    return {
      id: `warehouse-print-roll-label-disabled:${roll.id}`,
      label: 'Печать QR',
      level: 'disabled' as const,
      enabled: false,
      disabledReason: 'Рулон уже отгружен',
      recoveryOwner: 'Склад',
      recoveryAction: 'Открыть историю рулона',
    };
  }
  if (roll.stickerStatus === 'submitted') {
    return {
      id: `warehouse-print-roll-label-disabled:${roll.id}`,
      label: 'Задание отправлено',
      level: 'disabled' as const,
      enabled: false,
      disabledReason: 'Физический выход еще не подтвержден сканом',
      recoveryOwner: 'Администратор',
      recoveryAction: 'Проверить принтер и выполнить reconciliation с причиной',
    };
  }
  if (
    roll.stickerStatus === 'verified' ||
    roll.stickerStatus === 'applied' ||
    roll.stickerStatus === 'printed'
  ) {
    return {
      id: `warehouse-reprint-roll-label:${roll.id}`,
      label: 'Повтор QR',
      level: 'secondary' as const,
      enabled: true,
      confirmation: 'Нужна причина повторной печати QR',
      helpText: 'Создает новую запись печати этикетки; старый QR остается в истории.',
    };
  }
  return {
    id: `warehouse-print-roll-label:${roll.id}`,
    label: 'Печать QR',
    level: 'peer' as const,
    enabled: true,
    helpText: 'Запросить печать этикетки по выбранному рулону.',
  };
}

function statusSeverity(status: string): Severity {
  const normalized = status.toLowerCase();
  if (
    normalized.includes('расхождение') ||
    normalized.includes('ждет') ||
    normalized.includes('draft') ||
    normalized.includes('чернов')
  )
    return 'warning';
  if (normalized.includes('отклон')) return 'critical';
  return 'info';
}

function signedMovementQty(status: string, qty: number, unit: string) {
  return status === 'signed' ? `+${qty} ${unit}` : 'Не меняется';
}

function tapeNormActionLabel(norm: (typeof tapeConsumptionNorms)[number]) {
  if (norm.id === 'TAPE-NORM-DRAFT-01') return 'Запросить корректировку скотча';
  if (norm.productType === 'надбавка') return `Изменить надбавку: ${norm.label}`;
  if (norm.productType === 'палет') return 'Изменить норму упаковки палета';
  if (norm.productType === 'операция') return 'Изменить норму операции';
  return 'Изменить базовую норму';
}

function tapeNormActionHelp(norm: (typeof tapeConsumptionNorms)[number]) {
  return `Записать причину изменения для "${norm.label}". Норма остается черновой до клиентских замеров.`;
}

function tapeNormCharacteristic(norm: (typeof tapeConsumptionNorms)[number]) {
  if (norm.id === 'TAPE-NORM-DRAFT-01') {
    return { primary: 'рукав · 70 мкм', detail: '1000 м x 1.1 м · скотч ПП' };
  }
  if (norm.id === 'TAPE-NORM-DRAFT-02') {
    return { primary: 'рукав · 70 мкм', detail: 'ширина от 1.2 м · скотч ПП' };
  }
  if (norm.id === 'TAPE-NORM-DRAFT-03') {
    return { primary: 'рукав · 90 мкм', detail: 'вес от 40 кг · скотч ПП' };
  }
  if (norm.id === 'TAPE-NORM-DRAFT-04') {
    return { primary: 'палета 1200 x 800', detail: 'стрейч + этикетка' };
  }
  if (norm.id === 'TAPE-NORM-DRAFT-05') {
    return { primary: 'брак / переупаковка', detail: 'ручная операция' };
  }
  return { primary: norm.productType || 'не указана', detail: norm.unit || 'параметры не указаны' };
}

function warehouseHistoryDetail(value: string) {
  return value
    .replace(/\baudit:[\w:-]+\b/g, 'событие склада')
    .replace(/\bproblem:[\w:-]+\b/g, 'проблема записана')
    .replace(/\bnotification:[\w:-]+\b/g, 'уведомление отправлено')
    .replace(/\bmock_?1C\b/gi, 'учётный снимок')
    .replace(/\baudit\/source layer\b/gi, 'история склада')
    .replace(/\bprototype[- ]контуре\b/gi, 'рабочем разделе')
    .replace(/\bprototype\/mock\b/gi, 'рабочем разделе')
    .replace(/\bконтуре\b/gi, 'разделе');
}

function movementStatusLabel(status: string) {
  if (status === 'requires_second_signature') return 'Ждет второй подписи';
  if (status === 'signed') return 'Подписано';
  if (status === 'rejected') return 'Отклонено';
  return 'Черновик';
}

function allWarehouseCoverProposals() {
  return commercialWorkObjects.flatMap((object) =>
    (object.warehouseCoverProposals ?? []).map((proposal) => ({ object, proposal })),
  );
}

function currentRawMaterialStocks(inventoryObject?: WorkObject): RawMaterialStock[] {
  return (inventoryObject?.rawMaterialStocks ?? rawMaterialStocks).map((stock) => ({ ...stock }));
}

function reservedQtyForStock(inventoryObject: WorkObject | undefined, materialId: string) {
  const mutations = (inventoryObject?.inventoryMutations ?? []).filter(
    (mutation) => mutation.materialId === materialId && !mutation.blocked,
  );
  const reserved = mutations
    .filter((mutation) => mutation.kind === 'reserve')
    .reduce((sum, mutation) => sum + Math.abs(mutation.deltaQty), 0);
  const released = mutations
    .filter((mutation) => mutation.kind === 'release_reserve')
    .reduce((sum, mutation) => sum + Math.abs(mutation.deltaQty), 0);
  return Math.max(0, reserved - released);
}

function overridePrimaryQty(row: WarehouseInventoryOverride) {
  return `${row.actualQty} ${row.unit}`;
}

function overrideRow(
  row: WarehouseInventoryOverride,
  base?: WarehouseInventoryRow,
): WarehouseInventoryRow {
  const rollOwnership: WarehouseRollOwnership | undefined =
    row.category === 'rolls'
      ? row.linkedOrderId
        ? 'reserved_for_order'
        : 'free_reserve'
      : undefined;
  return {
    id: row.id,
    category: row.category,
    rawMaterialId: row.category === 'raw' ? row.id : undefined,
    orderId: row.category === 'rolls' ? row.linkedOrderId : undefined,
    customerLabel:
      row.category === 'rolls'
        ? row.linkedOrderId
          ? (base?.customerLabel ?? 'Клиент не указан')
          : 'Без заказчика'
        : undefined,
    ownership: rollOwnership,
    title: row.title,
    subtitle: row.subtitle,
    characteristic: row.characteristic ?? base?.characteristic,
    characteristicDetail: row.characteristicDetail ?? base?.characteristicDetail,
    primaryQty: overridePrimaryQty(row),
    secondaryQty:
      row.category === 'rolls' && typeof row.weightKg === 'number'
        ? `${row.weightKg} кг`
        : (row.secondaryQty ?? base?.secondaryQty ?? 'ручное'),
    unit: row.unit,
    actualQty: row.actualQty,
    reservedQty: base?.reservedQty,
    availableQty: base?.availableQty,
    status:
      row.category === 'rolls' && rollOwnership === 'free_reserve'
        ? warehouseRollOwnershipLabel('free_reserve')
        : row.status,
    source: sourceLabel(row.source),
    severity: row.severity ?? 'warning',
    details: [
      { label: 'На складе', value: overridePrimaryQty(row) },
      ...(row.category === 'rolls' && typeof row.weightKg === 'number'
        ? [{ label: 'Вес', value: `${row.weightKg} кг` }]
        : []),
      {
        label: 'По учету / эффект',
        value:
          row.category === 'rolls' && typeof row.weightKg === 'number'
            ? `${row.weightKg} кг`
            : (row.secondaryQty ?? base?.secondaryQty ?? 'Нет учета'),
      },
      { label: 'Причина', value: row.reason },
      { label: 'Документ', value: row.documentRef || 'Не указан' },
      {
        label: 'Заказ',
        value: row.linkedOrderId || (row.category === 'rolls' ? 'Не назначен' : 'Не указан'),
      },
      { label: 'Упаковка', value: row.packageQty || 'Не указана' },
      { label: 'Склад', value: row.warehouseZone || 'Основной склад' },
      { label: 'Обновлено', value: row.updatedAt },
      ...(row.comment ? [{ label: 'Комментарий', value: row.comment }] : []),
    ],
    actions: base?.actions ?? [],
  };
}

function applyWarehouseOverrides(
  rows: WarehouseInventoryRow[],
  category: WarehouseInventoryCategory,
  inventoryObject?: WorkObject,
) {
  const overrides = (inventoryObject?.warehouseInventoryOverrides ?? []).filter(
    (row) => row.category === category,
  );
  if (overrides.length === 0) return rows;
  const overrideById = new Map(overrides.map((row) => [row.id, row]));
  const merged = rows.map((row) => {
    const override = overrideById.get(row.id);
    if (!override) return row;
    overrideById.delete(row.id);
    return overrideRow(override, row);
  });
  return [...Array.from(overrideById.values()).map((row) => overrideRow(row)), ...merged];
}

function rollRows(): WarehouseInventoryRow[] {
  return allWarehouseCoverProposals().flatMap(({ object, proposal }) =>
    proposal.matchedRolls.map((roll) => {
      const position = object.commercialOrder?.positions.find(
        (item) => item.id === proposal.positionId,
      );
      const productDescription = productDescriptionFromPosition(position, roll.label);
      const materialDescription = materialDescriptionFromPosition(position);
      const printAction = printActionForRoll(roll);
      const isFreeReserve = roll.ownership === 'free_reserve';
      const orderLabel = isFreeReserve ? undefined : object.id;
      const customerLabel = isFreeReserve ? 'Без заказчика' : customerLabelFromObject(object);
      const stickerLabel =
        roll.stickerStatus === 'verified'
          ? 'Проверен'
          : roll.stickerStatus === 'applied'
            ? 'Приклеен'
            : roll.stickerStatus === 'submitted'
              ? 'Задание отправлено'
              : roll.stickerStatus === 'printed'
                ? 'Legacy: ждет скан'
                : roll.stickerStatus === 'error'
                  ? 'Ошибка QR'
                  : 'Нет стикера';
      const warehouseLabel =
        roll.warehouseUiStatus === 'shipped'
          ? 'Отгружен'
          : isFreeReserve
            ? warehouseRollOwnershipLabel('free_reserve')
            : roll.warehouseUiStatus === 'in_stock'
              ? 'На складе'
              : roll.warehouseUiStatus === 'sent'
                ? 'Передан'
                : roll.warehouseUiStatus === 'error'
                  ? 'Ошибка склада'
                  : warehouseRollOwnershipLabel(roll.ownership);

      return {
        id: `${proposal.id}:${roll.id}`,
        category: 'rolls' as const,
        orderId: orderLabel,
        positionId: isFreeReserve ? undefined : proposal.positionId,
        customerLabel,
        ownership: roll.ownership,
        productDescription,
        materialDescription,
        printState: roll.stickerStatus,
        title: roll.id,
        subtitle: roll.label,
        characteristic: productDescription,
        characteristicDetail: materialDescription,
        primaryQty: roll.plannedNetKg
          ? `${roll.qty} рул. · ${roll.plannedNetKg} кг`
          : `${roll.qty} рул.`,
        secondaryQty: `${stickerLabel} · ${warehouseLabel}`,
        status: warehouseLabel,
        source: 'склад',
        severity: roll.ownership === 'free_reserve' ? 'info' : 'warning',
        details: [
          { label: 'Компания', value: customerLabel },
          { label: 'Заказ', value: orderLabel ?? 'Не назначен' },
          { label: 'Позиция', value: isFreeReserve ? 'Не назначена' : proposal.positionId },
          ...(isFreeReserve
            ? [{ label: 'Источник резерва', value: 'Свободный складской остаток' }]
            : []),
          { label: 'Товар', value: productDescription },
          { label: 'Материал', value: materialDescription },
          { label: 'Кг', value: roll.plannedNetKg ? `${roll.plannedNetKg} кг` : 'нужен вес' },
          { label: 'Количество', value: `${roll.qty} рул.` },
          { label: 'Стикер', value: stickerLabel },
          { label: 'Склад', value: warehouseLabel },
          { label: 'На складе', value: `${proposal.coverQty} рул.` },
          { label: 'Не хватает', value: `${proposal.missingQty} рул.` },
          {
            label: 'Решение',
            value: proposal.confirmedAt
              ? `Подтверждено ${proposal.confirmedAt}`
              : 'Требует подтверждения',
          },
        ],
        actions: [
          printAction,
          ...(isFreeReserve
            ? []
            : [
                {
                  id: `warehouse-release-reserve:${roll.id}`,
                  label: 'Снять резерв с заказа',
                  level: 'secondary' as const,
                  enabled: roll.ownership === 'reserved_for_order',
                  confirmation: 'Нужна причина снятия резерва',
                },
              ]),
        ],
      };
    }),
  );
}

function liveRollRows(rolls: WarehouseCoverFreeRoll[]): WarehouseInventoryRow[] {
  return rolls.map((roll) => ({
    id: roll.id,
    category: 'rolls',
    ownership: 'free_reserve',
    title: roll.rollCode,
    subtitle: 'Без заказчика',
    characteristic:
      [roll.facts.filmType, roll.facts.actualThickness].filter(Boolean).join(' · ') ||
      'Характеристики не указаны',
    primaryQty: '1 шт',
    secondaryQty:
      roll.facts.plannedWeightKg === null ? 'Вес не указан' : `${roll.facts.plannedWeightKg} кг`,
    status: warehouseRollOwnershipLabel('free_reserve'),
    source: 'Данные склада',
    severity: 'info',
    details: [
      { label: 'Бирка', value: roll.facts.birka ?? 'Не указана' },
      { label: 'Шпуля', value: roll.facts.spoolType ?? 'Не указана' },
    ],
    actions: [],
  }));
}

function rawRows(inventoryObject?: WorkObject): WarehouseInventoryRow[] {
  return currentRawMaterialStocks(inventoryObject).map((stock) => {
    const reconciliation = inventoryReconciliations.find(
      (item) => item.rawMaterialId === stock.rawMaterialId,
    );
    const conflict = stock.sourceOfTruthStatus === 'расхождение с 1С';
    const reservedQty = reservedQtyForStock(inventoryObject, stock.rawMaterialId);
    const availableQty = Math.max(0, stock.actualQty - reservedQty);

    return {
      id: stock.id,
      category: 'raw',
      rawMaterialId: stock.rawMaterialId,
      title: stock.label,
      subtitle: rawMaterialKindLabel(stock.materialKind),
      primaryQty: `${stock.actualQty} ${stock.unit}`,
      secondaryQty:
        reservedQty > 0
          ? `резерв ${reservedQty} ${stock.unit}`
          : stock.referenceQty
            ? `${stock.referenceQty} ${stock.unit}`
            : 'Нет учета',
      unit: stock.unit,
      actualQty: stock.actualQty,
      reservedQty,
      availableQty,
      status: conflict ? 'расхождение с учётом' : stock.sourceOfTruthStatus,
      source: sourceLabel(stock.source),
      severity:
        conflict || stock.sourceOfTruthStatus === 'ручная корректировка' ? 'warning' : 'info',
      details: [
        { label: 'На складе', value: `${stock.actualQty} ${stock.unit}` },
        { label: 'В резерве', value: `${reservedQty} ${stock.unit}` },
        { label: 'Доступно', value: `${availableQty} ${stock.unit}` },
        {
          label: 'По учету',
          value: stock.referenceQty ? `${stock.referenceQty} ${stock.unit}` : 'Нет учета',
        },
        {
          label: 'Правило',
          value: conflict
            ? 'Факт склада используется, учетный снимок не блокирует выдачу'
            : 'Сверено с учетным снимком',
        },
        { label: 'Упаковка', value: stock.packageQty ?? 'Не указана' },
        { label: 'Обновлено', value: stock.updatedAt },
        { label: 'Действие', value: conflict ? 'Есть расхождение, проверьте историю' : 'Сверено' },
        {
          label: 'История',
          value: reconciliation?.auditEvent
            ? visibleAuditActionLabel(reconciliation.auditEvent)
            : 'Нет события сверки',
        },
      ],
      actions: [],
    };
  });
}

function reserveRows(): WarehouseInventoryRow[] {
  const coverRows = allWarehouseCoverProposals().map(({ object, proposal }) => ({
    id: proposal.id,
    category: 'reserve' as const,
    title: object.id,
    subtitle:
      proposal.coverType === 'full' ? 'Полное складское покрытие' : 'Частичное складское покрытие',
    primaryQty: `${proposal.reserveQty ?? proposal.coverQty} рул.`,
    secondaryQty: proposal.productionQty
      ? `${proposal.productionQty} в производство`
      : 'Производство не требуется',
    status: proposal.confirmedAt ? 'Подтверждено' : 'Требует подтверждения',
    source: warehouseSourceLabel('WarehouseCoverProposal'),
    severity: proposal.confirmedAt ? ('info' as const) : ('warning' as const),
    details: [
      { label: 'Позиция', value: proposal.positionId },
      { label: 'Найдено складом', value: `${proposal.coverQty} рул.` },
      { label: 'Недостача', value: `${proposal.missingQty} рул.` },
      { label: 'Рулоны', value: proposal.matchedRolls.map((roll) => roll.id).join(', ') || 'Нет' },
    ],
    actions: [
      {
        id: `warehouse-open-reserve:${proposal.id}`,
        label: 'Открыть состав резерва',
        level: 'secondary' as const,
        enabled: true,
        actionIntent: 'inspect' as const,
      },
      {
        id: `warehouse-release-reserve:${proposal.id}`,
        label: 'Снять резерв с заказа',
        level: 'secondary' as const,
        enabled: Boolean(proposal.confirmedAt),
        confirmation: 'Нужна причина снятия резерва',
      },
    ],
  }));

  return [
    {
      id: reservePreparationTask.id,
      category: 'reserve',
      title: `Подготовить резерв ${reservePreparationTask.orderId}`,
      subtitle: reservePreparationTask.rollIds.join(', '),
      primaryQty: `${reservePreparationTask.qty} рул.`,
      secondaryQty:
        reservePreparationTask.status === 'in_work' ? 'В работе' : reservePreparationTask.status,
      status: 'Задача склада',
      source: 'склад',
      severity: 'warning',
      details: [
        { label: 'Заказ', value: reservePreparationTask.orderId },
        { label: 'Рулоны', value: reservePreparationTask.rollIds.join(', ') },
        { label: 'Создано', value: reservePreparationTask.createdAt },
      ],
      actions: [
        {
          id: `warehouse-open-reserve-task:${reservePreparationTask.id}`,
          label: 'Открыть состав резерва',
          level: 'secondary',
          enabled: true,
          actionIntent: 'inspect' as const,
        },
      ],
    },
    ...coverRows,
  ];
}

function consumableRows(): WarehouseInventoryRow[] {
  return [
    ...tapeConsumptionNorms.map((norm) => {
      const characteristic = tapeNormCharacteristic(norm);

      return {
        id: norm.id,
        category: 'consumables' as const,
        title: norm.label,
        subtitle: norm.productType,
        characteristic: characteristic.primary,
        characteristicDetail: characteristic.detail,
        primaryQty: `${norm.qtyPerRoll} ${norm.unit}`,
        secondaryQty: norm.unit || 'единица не указана',
        status: norm.status === 'draft' ? 'Черновая норма' : 'Утверждено',
        source: norm.status === 'draft' ? 'черновая норма склада' : 'утвержденная норма склада',
        severity: 'info' as const,
        details: [
          { label: 'Тип', value: norm.productType },
          { label: 'Характеристика', value: `${characteristic.primary}; ${characteristic.detail}` },
          { label: 'Единица', value: norm.unit || 'единица не указана' },
          { label: 'Ручное значение', value: norm.manualValueAllowed ? 'Можно' : 'Нельзя' },
          { label: 'Обновлено', value: norm.updatedAt },
          {
            label: 'Данные',
            value:
              norm.status === 'draft'
                ? 'черновая норма до замера и утверждения'
                : 'утвержденная складская норма',
          },
        ],
        actions: [
          {
            id: `warehouse-correct-tape:${norm.id}`,
            label: tapeNormActionLabel(norm),
            level: 'secondary' as const,
            enabled: true,
            confirmation: 'Нужна причина изменения нормы',
            helpText: tapeNormActionHelp(norm),
          },
        ],
      };
    }),
    ...tapeConsumptionCorrections.map((correction) => ({
      id: correction.id,
      category: 'consumables' as const,
      title: 'Корректировка перерасхода',
      subtitle: correction.reason,
      characteristic: 'партия A-17',
      characteristicDetail: 'упаковка · факт перерасхода',
      primaryQty: correction.newValue,
      secondaryQty: correction.oldValue,
      status: 'Корректировка',
      source: correction.approvedByRole === 'commercial_director' ? 'Олег' : 'Директор',
      severity: 'info' as const,
      details: [
        { label: 'Характеристика', value: 'партия A-17; упаковка · факт перерасхода' },
        { label: 'Было', value: correction.oldValue },
        { label: 'Стало', value: correction.newValue },
        { label: 'Причина', value: correction.reason },
        {
          label: 'Кто',
          value: correction.approvedByRole === 'commercial_director' ? 'Олег' : 'Директор',
        },
        { label: 'Время', value: correction.createdAt },
      ],
      actions: [],
    })),
  ];
}

function movementRows(inventoryObject?: WorkObject): WarehouseInventoryMovementRow[] {
  const secondaryRows: WarehouseInventoryMovementRow[] = secondaryRawMaterialMovements.map(
    (movement) => ({
      id: movement.id,
      category: 'movements',
      movementKind: 'secondary_transfer',
      title: `${movement.fromWorkshop} -> ${movement.toWorkshop}`,
      subtitle: movement.rawMaterialId,
      primaryQty: `${movement.qty} ${movement.unit}`,
      secondaryQty: signedMovementQty(movement.status, movement.qty, movement.unit),
      status: movementStatusLabel(movement.status),
      source: 'ручное перемещение вторички',
      severity: statusSeverity(movement.status),
      details: [
        {
          label: 'Подписи',
          value: movement.signatures
            .map((item) => `${item.signerLabel}: ${item.signedAt ? 'подписано' : 'не подписано'}`)
            .join('; '),
        },
        {
          label: 'Условие',
          value:
            movement.status === 'signed' ? 'две подписи есть' : 'учитывается после двух подписей',
        },
        {
          label: 'Владелец подписи',
          value:
            movement.status === 'requires_second_signature'
              ? 'Зав. производства'
              : 'Подписи завершены',
        },
        { label: 'Создано', value: movement.createdAt },
        { label: 'Эффект', value: signedMovementQty(movement.status, movement.qty, movement.unit) },
      ],
      actions:
        movement.status === 'requires_second_signature'
          ? [
              {
                id: `warehouse-secondary-transfer-awaits-production:${movement.id}`,
                label: 'Ждет подпись производства',
                level: 'disabled' as const,
                enabled: false,
                disabledReason: 'Склад не подписывает перемещение за зав. производства',
                recoveryOwner: 'Зав. производства',
                recoveryAction: 'Подписать перемещение в производственном контуре',
              },
            ]
          : [],
    }),
  );

  const auditRows: WarehouseInventoryMovementRow[] = (inventoryObject?.audit ?? []).map(
    (event) => ({
      id: event.id,
      category: 'movements',
      movementKind: event.actionLabel.includes('material_received')
        ? 'receiving'
        : event.actionLabel.includes('corrected')
          ? 'correction'
          : 'audit',
      title: visibleAuditActionLabel(event.actionLabel),
      subtitle: warehouseHistoryDetail(event.detail),
      primaryQty: event.newValue ?? event.time,
      secondaryQty: event.oldValue ?? event.actorLabel,
      status: event.actionLabel.startsWith('problem:') ? 'Проблема' : 'История',
      source: warehouseSourceLabel(event.sourceSnapshot ?? 'audit/source layer'),
      severity: event.actionLabel.startsWith('problem:') ? 'warning' : 'info',
      details: [
        { label: 'Кто', value: event.actorLabel },
        { label: 'Когда', value: event.time },
        { label: 'Деталь', value: warehouseHistoryDetail(event.detail) },
        { label: 'Было', value: event.oldValue ?? 'Нет' },
        { label: 'Стало', value: event.newValue ?? 'Нет' },
      ],
      actions: [],
    }),
  );

  return [...secondaryRows, ...auditRows];
}

export function buildWarehouseInventoryDashboard(
  inventoryObject?: WorkObject,
  liveFreeRolls: WarehouseCoverFreeRoll[] = [],
): WarehouseInventoryDashboard {
  const liveInventory = inventoryObject?.id === 'warehouse-live-inventory';
  const raw = applyWarehouseOverrides(rawRows(inventoryObject), 'raw', inventoryObject);
  const rolls = liveInventory
    ? liveRollRows(liveFreeRolls)
    : applyWarehouseOverrides(rollRows(), 'rolls', inventoryObject);
  const reserve = liveInventory
    ? []
    : applyWarehouseOverrides(reserveRows(), 'reserve', inventoryObject);
  const consumables = liveInventory
    ? []
    : applyWarehouseOverrides(consumableRows(), 'consumables', inventoryObject);
  const movements = liveInventory
    ? []
    : applyWarehouseOverrides(movementRows(inventoryObject), 'movements', inventoryObject);
  const conflicts = raw.filter((row) => row.status.includes('расхождение')).length;
  const reservedRolls = rolls.filter(
    (row) => row.status === warehouseRollOwnershipLabel('reserved_for_order'),
  ).length;
  const openTasks = reserve.filter((row) => row.severity === 'warning').length;
  const totalRawKg = currentRawMaterialStocks(inventoryObject).reduce(
    (sum, stock) => sum + (stock.unit === 'кг' ? stock.actualQty : 0),
    0,
  );

  return {
    summaries: [
      {
        id: 'raw-total',
        label: 'Факт сырья',
        value: `${totalRawKg} кг`,
        detail: `${raw.length} позиции`,
        severity: conflicts > 0 ? 'warning' : 'info',
      },
      {
        id: 'conflicts',
        label: 'Расхождения',
        value: String(conflicts),
        detail: conflicts > 0 ? 'нужно проверить' : 'нет',
        severity: conflicts > 0 ? 'warning' : 'info',
      },
      {
        id: 'reserved-rolls',
        label: 'Резерв рулонов',
        value: String(reservedRolls),
        detail: `${rolls.length} рул. на складе`,
        severity: reservedRolls > 0 ? 'warning' : 'info',
      },
      {
        id: 'open-tasks',
        label: 'Открытые задачи',
        value: String(openTasks),
        detail: 'резерв, подписи, нормы',
        severity: openTasks > 0 ? 'warning' : 'info',
      },
    ],
    categories: [
      { id: 'raw', label: 'Сырье', rows: raw },
      { id: 'rolls', label: 'Готовые рулоны', rows: rolls },
      { id: 'reserve', label: 'Резерв', rows: reserve },
      { id: 'consumables', label: 'Расходники', rows: consumables },
      { id: 'movements', label: 'Движения', rows: movements },
    ],
  };
}
