import { useEffect, useMemo, useState } from 'react';

import { factValueFromObject } from '../../domain/displayContracts';
import { productionOperators, type ProductionOperator } from '../../domain/operators';
import {
  assignedProductionOperatorCount,
  operatorWorkloadsFromDispatch,
  productionPriorityRank,
  productionRollDispatchStatusLabel,
  productionRollIsWarehouseLifecycle,
  productionRollMeterage,
  productionRollOrderNumber,
  productionRollPlannedWeightTotal,
  productionRollSpecificationLabel,
  sortProductionRolls,
} from '../../domain/rollWork';
import type {
  ProductionPriority,
  ProductionRollDispatchItem,
  WorkObject,
} from '../../domain/types';
import {
  PlenkiBulkBar,
  PlenkiDataTable,
  PlenkiMetricStrip,
  PlenkiToolbar,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';
import { SiemensIcon } from '../shell/SiemensIcon';
import {
  ProductionDispatchPanel,
  type ProductionRollDraftChange,
  type ProductionRollImmediateMutation,
} from './productionDispatchPanel';

export type ProductionOrdersHubView = 'orders' | 'rolls' | 'archive' | 'summary';
export type ProductionOrdersHubMode = 'order-selection' | 'all-rolls';

type ProductionOrderSortKey =
  | 'order'
  | 'customer'
  | 'status'
  | 'priority'
  | 'rolls'
  | 'owner'
  | 'blocker'
  | 'updated';
type SortDirection = 'asc' | 'desc';
type ProductionOrderFilter = 'all' | 'blocked' | 'critical' | 'unassigned';
type ProductionArchiveRangePreset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';
type ProductionArchiveDateRange = {
  preset: ProductionArchiveRangePreset;
  from: string;
  to: string;
};
type ProductionArchiveLoadState = {
  key: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: ProductionRollDispatchItem[];
};
type ProductionArchiveRequestOptions = { signal?: AbortSignal };

export function shortProductionOrderId(id: string) {
  return id.length > 8 ? `…${id.slice(-6)}` : id;
}

export function pluralizeOrderNoun(count: number) {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'заказ-нарядов';
  if (mod10 === 1) return 'заказ-наряд';
  if (mod10 >= 2 && mod10 <= 4) return 'заказ-наряда';
  return 'заказ-нарядов';
}

/** ISO-время из API → компактный вид «14.07, 17:32» (сортировка остается по ISO). */
export function formatProductionTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const day = parts.day;
  const month = parts.month;
  const hours = parts.hour;
  const minutes = parts.minute;
  return `${day}.${month}, ${hours}:${minutes}`;
}

export function productionMoscowDateKey(date: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

type ProductionOrderRow = {
  object: WorkObject;
  id: string;
  title: string;
  customer: string;
  status: string;
  priority: ProductionPriority;
  priorityLabel: string;
  rollCount: number;
  assignedCount: number;
  blockedCount: number;
  owner: string;
  machines: string;
  blocker: string;
  updated: string;
  rolls: ProductionRollDispatchItem[];
  approveActionId?: string;
  approveActionLabel?: string;
};

type ArchivedProductionOrder = {
  id: string;
  customer: string;
  status: string;
  priority: ProductionPriority;
  completedAt: string;
  owner: string;
  audit: string;
  rolls: Array<{
    id: string;
    orderLineId: string;
    machine: string;
    operator: string;
    specification?: string;
    kg: number | null;
    status: string;
  }>;
};

const hubViewsByMode: Record<
  ProductionOrdersHubMode,
  Array<{ id: ProductionOrdersHubView; label: string }>
> = {
  'order-selection': [
    { id: 'orders', label: 'Заказы' },
    { id: 'rolls', label: 'Рулоны' },
  ],
  'all-rolls': [
    { id: 'rolls', label: 'Рулоны' },
    { id: 'archive', label: 'Архив' },
    { id: 'summary', label: 'Сводка' },
  ],
};

export function productionHubViewsForMode(mode: ProductionOrdersHubMode) {
  return hubViewsByMode[mode];
}

export function productionRollsForHub(
  mode: ProductionOrdersHubMode,
  rolls: ProductionRollDispatchItem[],
  selectedOrderIds: string[],
) {
  if (mode === 'all-rolls') return rolls;
  const selected = new Set(selectedOrderIds);
  return rolls.filter((roll) => selected.has(roll.orderId));
}

export function productionOrderAllowsAssignment(order: WorkObject | undefined) {
  if (!order || order.warehouseCoverageWorkflowVersion !== 2) return true;
  return (
    order.coverage?.state === 'production_required' &&
    typeof order.productionOrderId === 'string' &&
    order.productionOrderId.length > 0
  );
}

const orderColumns: Array<{ key: ProductionOrderSortKey; label: string }> = [
  { key: 'order', label: 'Заказ' },
  { key: 'customer', label: 'Клиент' },
  { key: 'status', label: 'Статус' },
  { key: 'priority', label: 'Приоритет' },
  { key: 'rolls', label: 'Рулоны' },
  { key: 'owner', label: 'Оператор / станок' },
  { key: 'blocker', label: 'Блокер' },
  { key: 'updated', label: 'Время' },
];

const orderFilterLabels: Record<ProductionOrderFilter, string> = {
  all: 'Все',
  blocked: 'Проблемы',
  critical: 'Критичные',
  unassigned: 'Без назначения',
};
const productionArchiveRangePresets: Array<{ id: ProductionArchiveRangePreset; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
];
const demoArchivedOrders: ArchivedProductionOrder[] = [
  {
    id: 'ЗН-2606-004',
    customer: 'ФлексПак',
    status: 'Закрыто',
    priority: 'обычный',
    completedAt: '2026-06-18',
    owner: 'Сергей Волков',
    audit: 'Закрыто без отклонений, склад принял 3 рулона',
    rolls: [
      {
        id: 'R-2606-004-01',
        orderLineId: 'POS-004-01',
        machine: 'Экструдер E-04',
        operator: 'Сергей Волков',
        kg: 39.1,
        status: 'закрыт',
      },
      {
        id: 'R-2606-004-02',
        orderLineId: 'POS-004-01',
        machine: 'Экструдер E-04',
        operator: 'Сергей Волков',
        kg: 39.4,
        status: 'закрыт',
      },
      {
        id: 'R-2606-004-03',
        orderLineId: 'POS-004-02',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 36.2,
        status: 'закрыт',
      },
    ],
  },
  {
    id: 'ЗН-2606-007',
    customer: 'ПакетПром',
    status: 'Передано на склад',
    priority: 'срочно',
    completedAt: '2026-06-27',
    owner: 'Илья Ковалев',
    audit: 'Передано на склад двумя палетами, QR проверены',
    rolls: [
      {
        id: 'R-2606-007-01',
        orderLineId: 'POS-007-01',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 35.8,
        status: 'принят складом',
      },
      {
        id: 'R-2606-007-02',
        orderLineId: 'POS-007-01',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 36.0,
        status: 'принят складом',
      },
    ],
  },
  {
    id: 'ЗН-2606-009',
    customer: 'Клиент 009',
    status: 'Передано на склад',
    priority: 'обычный',
    completedAt: '2026-07-03',
    owner: 'Сергей Волков',
    audit: 'Склад принял 4 рулона, палета закрыта',
    rolls: [
      {
        id: 'R-2606-009-01',
        orderLineId: 'POS-009-01',
        machine: 'Экструдер E-04',
        operator: 'Сергей Волков',
        kg: 38.4,
        status: 'принят складом',
      },
      {
        id: 'R-2606-009-02',
        orderLineId: 'POS-009-01',
        machine: 'Экструдер E-04',
        operator: 'Сергей Волков',
        kg: 38.1,
        status: 'принят складом',
      },
      {
        id: 'R-2606-009-03',
        orderLineId: 'POS-009-02',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 36.9,
        status: 'принят складом',
      },
      {
        id: 'R-2606-009-04',
        orderLineId: 'POS-009-02',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 37.2,
        status: 'принят складом',
      },
    ],
  },
  {
    id: 'ЗН-2606-011',
    customer: 'Клиент 011',
    status: 'Закрыто',
    priority: 'срочно',
    completedAt: '2026-07-04',
    owner: 'Илья Ковалев',
    audit: 'Отклонений по весу нет, QR проверены',
    rolls: [
      {
        id: 'R-2606-011-01',
        orderLineId: 'POS-011-01',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 35.0,
        status: 'закрыт',
      },
      {
        id: 'R-2606-011-02',
        orderLineId: 'POS-011-01',
        machine: 'Экструдер E-02',
        operator: 'Илья Ковалев',
        kg: 35.3,
        status: 'закрыт',
      },
    ],
  },
  {
    id: 'ЗН-2606-012',
    customer: 'УралПак',
    status: 'Передано на склад',
    priority: 'критично',
    completedAt: '2026-07-06',
    owner: 'Сергей Волков',
    audit: 'Срочная партия закрыта, 1 рулон принят складом',
    rolls: [
      {
        id: 'R-2606-012-01',
        orderLineId: 'POS-012-01',
        machine: 'Экструдер E-04',
        operator: 'Сергей Волков',
        kg: 41.2,
        status: 'принят складом',
      },
    ],
  },
];

function productionArchiveReferenceDate(useLiveData: boolean) {
  if (useLiveData) return productionArchiveDateFromIso(productionMoscowDateKey(new Date()));
  const latestDemoDate = demoArchivedOrders
    .map((order) => order.completedAt)
    .sort()
    .at(-1);
  return latestDemoDate
    ? productionArchiveDateFromIso(latestDemoDate)
    : productionArchiveDateFromIso(productionMoscowDateKey(new Date()));
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter((value) => value && value !== 'Не назначен')));
}

function archivedOrdersFromDispatch(
  rollDispatchItems: ProductionRollDispatchItem[],
): ArchivedProductionOrder[] {
  const byOrder = new Map<string, ProductionRollDispatchItem[]>();
  for (const roll of rollDispatchItems) {
    if (roll.status !== 'warehouse_pending') continue;
    byOrder.set(roll.orderId, [...(byOrder.get(roll.orderId) ?? []), roll]);
  }

  return Array.from(byOrder.entries())
    .map(([orderId, rolls]): ArchivedProductionOrder | null => {
      const completedAt = rolls
        .map((roll) => roll.completedAt ?? '')
        .filter(Boolean)
        .sort()
        .at(-1);
      if (!completedAt) return null;
      const priority =
        [...rolls].sort(
          (left, right) =>
            productionPriorityRank(left.priority) - productionPriorityRank(right.priority),
        )[0]?.priority ?? 'обычный';
      const completedDateKey = productionArchiveDateKey(completedAt);
      if (!completedDateKey) return null;
      return {
        id: rolls[0]?.orderNumber ?? orderId,
        customer: rolls[0]?.customerAlias ?? 'Контрагент',
        status: 'Есть завершённые рулоны',
        priority,
        completedAt: completedDateKey,
        owner: uniqueValues(rolls.map((roll) => roll.operatorLabel)).join(', ') || 'Не назначен',
        audit: `Подтверждено завершение ${rolls.length} рул.; статус всего заказ-наряда этим срезом не определяется.`,
        rolls: rolls.map((roll, rollIndex) => ({
          id: roll.rollId,
          // Живой orderLineId — это cuid позиции; в архиве показываем номер рулона.
          orderLineId: `#${rollIndex + 1}`,
          machine: roll.machineLabel,
          operator: roll.operatorLabel,
          specification: productionRollSpecificationLabel(roll),
          kg: roll.actualNetKg ?? null,
          status: 'завершённый рулон',
        })),
      };
    })
    .filter((order): order is ArchivedProductionOrder => order !== null)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function priorityFromRows(
  object: WorkObject,
  rolls: ProductionRollDispatchItem[],
): ProductionPriority {
  const factPriority = factValueFromObject(object, 'Приоритет');
  if (factPriority === 'критично' || factPriority === 'срочно' || factPriority === 'обычный')
    return factPriority;
  return (
    [...rolls].sort(
      (left, right) =>
        productionPriorityRank(left.priority) - productionPriorityRank(right.priority),
    )[0]?.priority ?? 'обычный'
  );
}

function blockerLabel(object: WorkObject) {
  const productionProblem = object.productionProblems?.find(
    (problem) => problem.status !== 'resolved',
  );
  const problem = object.problems.find((item) => item.status === 'open');
  return (
    productionProblem?.reason ??
    productionProblem?.comment ??
    problem?.reason ??
    problem?.title ??
    'Нет'
  );
}

function orderUpdatedAt(object: WorkObject, rolls: ProductionRollDispatchItem[]) {
  const timestamps = rolls
    .map((item) => item.updatedAt ?? item.assignedAt ?? '')
    .filter(Boolean)
    .sort();
  return timestamps[timestamps.length - 1] ?? object.audit[0]?.time ?? '';
}

function orderRowFromObject(object: WorkObject): ProductionOrderRow {
  const rolls = sortProductionRolls(object.productionRollDispatchItems ?? [], 'manual');
  const priority = priorityFromRows(object, rolls);
  const operators = uniqueValues(rolls.map((item) => item.operatorLabel));
  const machines = uniqueValues(rolls.map((item) => item.machineLabel));
  const approveAction = object.actions.find(
    (action) =>
      action.enabled &&
      (action.id === 'approve' ||
        action.id === 'approve-order' ||
        action.id.startsWith('production-technical-approve-cover:')),
  );
  const blockedCount = rolls.filter(
    (item) => item.status === 'blocked' || !item.operatorId || !item.machineId,
  ).length;

  return {
    object,
    id: object.id,
    title: object.title,
    customer:
      factValueFromObject(object, 'Заказчик') ??
      factValueFromObject(object, 'Контрагент') ??
      rolls[0]?.customerAlias ??
      'Клиент',
    status: object.statusLabel,
    priority,
    priorityLabel: priority,
    rollCount: rolls.length,
    assignedCount: rolls.filter((item) => item.operatorId).length,
    blockedCount,
    owner:
      operators.length > 0
        ? operators.join(', ')
        : (factValueFromObject(object, 'Ответственный') ?? 'Не назначен'),
    machines:
      machines.length > 0
        ? machines.join(', ')
        : (factValueFromObject(object, 'Станок') ??
          factValueFromObject(object, 'Рабочее место') ??
          'Не назначен'),
    blocker: blockerLabel(object),
    updated: orderUpdatedAt(object, rolls),
    rolls,
    approveActionId: approveAction?.id,
    approveActionLabel: approveAction?.label,
  };
}

function compareOrderRows(
  left: ProductionOrderRow,
  right: ProductionOrderRow,
  key: ProductionOrderSortKey,
) {
  if (key === 'customer') return left.customer.localeCompare(right.customer, 'ru');
  if (key === 'status') return left.status.localeCompare(right.status, 'ru');
  if (key === 'priority')
    return productionPriorityRank(left.priority) - productionPriorityRank(right.priority);
  if (key === 'rolls')
    return left.rollCount - right.rollCount || left.blockedCount - right.blockedCount;
  if (key === 'owner')
    return `${left.owner} ${left.machines}`.localeCompare(`${right.owner} ${right.machines}`, 'ru');
  if (key === 'blocker') return left.blocker.localeCompare(right.blocker, 'ru');
  if (key === 'updated') return left.updated.localeCompare(right.updated, 'ru');
  return left.id.localeCompare(right.id, 'ru');
}

function sortOrderRows(
  rows: ProductionOrderRow[],
  key: ProductionOrderSortKey,
  direction: SortDirection,
) {
  const directionFactor = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const primary = compareOrderRows(left, right, key);
    if (primary !== 0) return primary * directionFactor;
    return left.id.localeCompare(right.id, 'ru');
  });
}

function matchesOrderFilter(row: ProductionOrderRow, filter: ProductionOrderFilter) {
  if (filter === 'blocked') return row.blockedCount > 0 || row.blocker !== 'Нет';
  if (filter === 'critical') return row.priority === 'критично' || row.priority === 'срочно';
  if (filter === 'unassigned') return row.assignedCount < row.rollCount;
  return true;
}

function matchesOrderSearch(row: ProductionOrderRow, query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return [
    row.id,
    row.title,
    row.customer,
    row.status,
    row.priorityLabel,
    row.owner,
    row.machines,
    row.blocker,
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}

function sortAria(
  isActive: boolean,
  direction: SortDirection,
): 'none' | 'ascending' | 'descending' {
  if (!isActive) return 'none';
  return direction === 'asc' ? 'ascending' : 'descending';
}

function extractProductionDateKey(value?: string) {
  return value?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function productionRollDateKey(item: ProductionRollDispatchItem) {
  return (
    extractProductionDateKey(item.updatedAt) ??
    extractProductionDateKey(item.assignedAt) ??
    extractProductionDateKey(item.machineAssignedAt)
  );
}

function dateKeyInProductionRange(dateKey: string | null, range: ProductionArchiveDateRange) {
  return dateKey !== null && dateKey >= range.from && dateKey <= range.to;
}

function formatProductionKg(value: number | undefined) {
  if (value === undefined) return 'План не указан';
  const rounded = Number(value.toFixed(1));
  return `${rounded} кг`;
}

export function ProductionOrdersHubSurface({
  orders,
  rollDispatchItems,
  initialView = 'orders',
  onUpdateRollOperator,
  onUpdateRollMachine,
  onUpdateRollPriority,
  onBulkAssign,
  onSaveSelected,
  onMoveRollQueue,
  onApproveOrder,
  operators = productionOperators,
  machineOptions,
  lockMachineToOperator = false,
  useLiveData = false,
  commercialActionsState = 'ready',
  onRetryCommercialActions,
  onFetchArchive,
  onOpenProblems,
  onCreateRequest,
  mode = 'order-selection',
}: {
  orders: WorkObject[];
  rollDispatchItems: ProductionRollDispatchItem[];
  initialView?: ProductionOrdersHubView;
  onUpdateRollOperator?: (
    rollDispatchItemId: string,
    operatorId: string,
  ) => ProductionRollImmediateMutation;
  onUpdateRollMachine?: (
    rollDispatchItemId: string,
    machineId: string,
  ) => ProductionRollImmediateMutation;
  onUpdateRollPriority?: (
    rollDispatchItemId: string,
    priority: string,
  ) => ProductionRollImmediateMutation;
  onBulkAssign?: (rollDispatchItemIds: string[], operatorId: string, priority: string) => void;
  onSaveSelected?: (changes: ProductionRollDraftChange[]) => void;
  onMoveRollQueue?: (rollDispatchItemId: string, direction: 'up' | 'down') => void;
  onApproveOrder?: (orderId: string, actionId: string) => void;
  operators?: ProductionOperator[];
  machineOptions?: readonly { value: string; label: string }[];
  lockMachineToOperator?: boolean;
  useLiveData?: boolean;
  commercialActionsState?: 'ready' | 'loading' | 'error';
  onRetryCommercialActions?: () => void;
  /** Live-архив: подгрузка выполненных рулонов (scope=archive) за период. */
  onFetchArchive?: (
    dateFrom: string,
    dateTo: string,
    options?: ProductionArchiveRequestOptions,
  ) => Promise<ProductionRollDispatchItem[]>;
  /** Клик по стат-окну «Проблемы» открывает одноимённую секцию nav-bar. */
  onOpenProblems?: () => void;
  /** Открывает server-backed создание заявки от имени зав. производства. */
  onCreateRequest?: (trigger: HTMLElement) => void;
  mode?: ProductionOrdersHubMode;
}) {
  const [view, setView] = useState<ProductionOrdersHubView>(initialView);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [expandedArchiveId, setExpandedArchiveId] = useState<string | null>(null);
  const [orderSort, setOrderSort] = useState<{
    key: ProductionOrderSortKey;
    direction: SortDirection;
  }>({ key: 'updated', direction: 'desc' });
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  const [orderFilter, setOrderFilter] = useState<ProductionOrderFilter>('all');
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [archiveReferenceDate] = useState(() => productionArchiveReferenceDate(useLiveData));
  const [summaryRange, setSummaryRange] = useState<ProductionArchiveDateRange>(() =>
    productionArchiveRangeForPreset('today', archiveReferenceDate),
  );
  const [summaryCalendarOpen, setSummaryCalendarOpen] = useState(false);
  const [archiveRange, setArchiveRange] = useState<ProductionArchiveDateRange>(() =>
    productionArchiveRangeForPreset('month', archiveReferenceDate),
  );
  const [archiveCalendarOpen, setArchiveCalendarOpen] = useState(false);
  const hubViews = productionHubViewsForMode(mode);

  function retryArchive() {
    setArchiveRetryGeneration((current) => current + 1);
  }

  function currentArchiveReferenceDate() {
    return useLiveData
      ? productionArchiveDateFromIso(productionMoscowDateKey(new Date()))
      : archiveReferenceDate;
  }

  useEffect(() => {
    setView(hubViews.some((item) => item.id === initialView) ? initialView : hubViews[0].id);
  }, [initialView, mode]);

  useEffect(() => {
    setExpandedOrderId((current) =>
      current && orders.some((order) => order.id === current) ? current : null,
    );
    setSelectedOrderIds((current) =>
      current.filter((id) => orders.some((order) => order.id === id)),
    );
  }, [orders]);

  const activeOrders = useMemo(
    () =>
      useLiveData
        ? orders.filter((order) => {
            const rolls = order.productionRollDispatchItems ?? [];
            return rolls.length === 0 || rolls.some((roll) => roll.status !== 'warehouse_pending');
          })
        : orders,
    [orders, useLiveData],
  );
  const orderRows = useMemo(
    () => sortOrderRows(activeOrders.map(orderRowFromObject), orderSort.key, orderSort.direction),
    [activeOrders, orderSort],
  );
  const visibleOrderRows = useMemo(
    () =>
      orderRows.filter(
        (row) => matchesOrderFilter(row, orderFilter) && matchesOrderSearch(row, orderSearchQuery),
      ),
    [orderFilter, orderRows, orderSearchQuery],
  );
  const sortedRolls = useMemo(
    () => sortProductionRolls(rollDispatchItems, 'manual'),
    [rollDispatchItems],
  );
  // Live-архив приходит отдельным запросом (scope=archive): в активной выдаче
  // выполненных рулонов нет, поэтому строить архив из rollDispatchItems нельзя.
  const [liveArchiveState, setLiveArchiveState] = useState<ProductionArchiveLoadState>({
    key: null,
    status: 'idle',
    items: [],
  });
  const [archiveRetryGeneration, setArchiveRetryGeneration] = useState(0);
  const requestedArchiveRange = view === 'summary' ? summaryRange : archiveRange;
  const requestedArchiveKey = `${requestedArchiveRange.from}:${requestedArchiveRange.to}`;
  useEffect(() => {
    if (!onFetchArchive || !useLiveData) return;
    if (view !== 'archive' && view !== 'summary') return;
    const range = view === 'archive' ? archiveRange : summaryRange;
    const key = `${range.from}:${range.to}`;
    const controller = new AbortController();
    let cancelled = false;
    setLiveArchiveState({ key, status: 'loading', items: [] });
    onFetchArchive(range.from, range.to, { signal: controller.signal })
      .then((items) => {
        if (!cancelled) setLiveArchiveState({ key, status: 'ready', items });
      })
      .catch(() => {
        if (!cancelled && !controller.signal.aborted) {
          setLiveArchiveState({ key, status: 'error', items: [] });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [onFetchArchive, useLiveData, view, archiveRange, summaryRange, archiveRetryGeneration]);
  const archiveLoadStatus = !useLiveData
    ? 'ready'
    : !onFetchArchive
      ? 'error'
      : liveArchiveState.key === requestedArchiveKey
        ? liveArchiveState.status
        : 'loading';
  const archivedOrders = useMemo(
    () =>
      useLiveData
        ? archivedOrdersFromDispatch(
            liveArchiveState.key === requestedArchiveKey && liveArchiveState.status === 'ready'
              ? liveArchiveState.items
              : [],
          )
        : demoArchivedOrders,
    [liveArchiveState, requestedArchiveKey, useLiveData],
  );
  useEffect(() => {
    setExpandedArchiveId((current) =>
      current && archivedOrders.some((order) => order.id === current) ? current : null,
    );
  }, [archivedOrders]);
  const activeSortedRolls = useMemo(
    () => sortedRolls.filter((item) => !productionRollIsWarehouseLifecycle(item.status)),
    [sortedRolls],
  );
  const visibleRolls = useMemo(
    () => productionRollsForHub(mode, activeSortedRolls, selectedOrderIds),
    [activeSortedRolls, mode, selectedOrderIds],
  );
  const activeOrderById = useMemo(
    () => new Map(activeOrders.map((order) => [order.id, order] as const)),
    [activeOrders],
  );
  const assignableVisibleRolls = useMemo(
    () =>
      visibleRolls.filter((roll) =>
        productionOrderAllowsAssignment(activeOrderById.get(roll.orderId)),
      ),
    [activeOrderById, visibleRolls],
  );
  const activeRollCount = activeSortedRolls.filter(
    (item) => item.status === 'queued' || item.status === 'assigned' || item.status === 'in_work',
  ).length;
  const blockedRollCount = activeSortedRolls.filter(
    (item) => item.status === 'blocked' || !item.operatorId || !item.machineId,
  ).length;
  const assignedOperatorCount = assignedProductionOperatorCount(activeSortedRolls);
  const totalWeight = productionRollPlannedWeightTotal(activeSortedRolls);
  const totalMeters = activeSortedRolls.reduce(
    (sum, item) => sum + productionRollMeterage(item),
    0,
  );
  const visibleArchivedOrders = useMemo(
    () =>
      archivedOrders.filter(
        (order) => order.completedAt >= archiveRange.from && order.completedAt <= archiveRange.to,
      ),
    [archiveRange, archivedOrders],
  );
  const archiveRollCount = visibleArchivedOrders.reduce(
    (sum, order) => sum + order.rolls.length,
    0,
  );
  const summaryRolls = useMemo(
    () =>
      activeSortedRolls.filter((item) =>
        dateKeyInProductionRange(productionRollDateKey(item), summaryRange),
      ),
    [activeSortedRolls, summaryRange],
  );
  const summaryOrderRows = useMemo(
    () =>
      orderRows.filter((row) =>
        row.rolls.length === 0
          ? dateKeyInProductionRange(extractProductionDateKey(row.updated), summaryRange)
          : row.rolls.some((roll) =>
              dateKeyInProductionRange(productionRollDateKey(roll), summaryRange),
            ),
      ),
    [orderRows, summaryRange],
  );
  const summaryArchiveOrders = useMemo(
    () =>
      archivedOrders.filter((order) => dateKeyInProductionRange(order.completedAt, summaryRange)),
    [archivedOrders, summaryRange],
  );
  const summaryCompletedRollCount = summaryArchiveOrders.reduce(
    (sum, order) => sum + order.rolls.length,
    0,
  );
  const summaryCompletedRolls = summaryArchiveOrders.flatMap((order) => order.rolls);
  const summaryCompletedActualWeights = summaryCompletedRolls.flatMap((roll) =>
    roll.kg === null ? [] : [roll.kg],
  );
  const summaryCompletedWeight = summaryCompletedActualWeights.reduce(
    (sum, actualKg) => sum + actualKg,
    0,
  );
  const summaryMissingActualWeightCount =
    summaryCompletedRollCount - summaryCompletedActualWeights.length;
  const summaryQueueRollCount = summaryRolls.filter(
    (item) => item.status === 'queued' || item.status === 'assigned' || item.status === 'in_work',
  ).length;
  const summaryUnassignedRollCount = summaryRolls.filter(
    (item) => !item.operatorId || !item.machineId,
  ).length;
  const summaryBlockedRollCount = summaryRolls.filter(
    (item) => item.status === 'blocked' || !item.operatorId || !item.machineId,
  ).length;
  const summaryCriticalRollCount = summaryRolls.filter(
    (item) => item.priority === 'критично' || item.priority === 'срочно',
  ).length;
  const summaryPlanWeight = productionRollPlannedWeightTotal(summaryRolls);
  const summaryPlanMeters = summaryRolls.reduce(
    (sum, item) => sum + productionRollMeterage(item),
    0,
  );
  const summaryWorkloads = useMemo(
    () => operatorWorkloadsFromDispatch(summaryRolls, operators),
    [operators, summaryRolls],
  );
  const summaryAvailableOperatorCount = summaryWorkloads.filter(
    (item) => item.loadState !== 'blocked',
  ).length;
  const summaryAssignedOperatorCount = assignedProductionOperatorCount(summaryRolls);
  const summaryTimedWorkloads = summaryWorkloads.filter((item) => item.capacityKnown);
  const summaryEstimatedMinutes = summaryTimedWorkloads.reduce(
    (sum, item) => sum + item.estimatedMinutesTotal,
    0,
  );
  const summaryCapacityMinutes = summaryTimedWorkloads.reduce(
    (sum, item) => sum + item.remainingShiftMinutes,
    0,
  );
  const summaryLoadPct =
    summaryTimedWorkloads.length > 0 && summaryCapacityMinutes > 0
      ? Math.round((summaryEstimatedMinutes / summaryCapacityMinutes) * 100)
      : null;
  const summaryOverloadedOperatorCount = summaryWorkloads.filter(
    (item) => item.loadState === 'overloaded' || item.loadState === 'near_limit',
  ).length;
  const summaryFreeMinutes = summaryTimedWorkloads.reduce(
    (sum, item) => sum + item.availableCapacityMinutes,
    0,
  );
  const summaryOperatorRows = summaryWorkloads
    .filter(
      (item) =>
        item.assignedRollCount > 0 ||
        item.loadState === 'near_limit' ||
        item.loadState === 'overloaded',
    )
    .sort((left, right) => right.estimatedMinutesTotal - left.estimatedMinutesTotal);

  function openSummaryTarget(filter: ProductionOrderFilter) {
    if (mode === 'order-selection') {
      setOrderFilter(filter);
      setView('orders');
      return;
    }
    setView('rolls');
  }

  const summaryActionRows = [
    {
      id: 'unassigned',
      label: 'Назначить',
      value: `${summaryUnassignedRollCount} рул.`,
      detail:
        summaryUnassignedRollCount > 0 ? 'оператор или станок пустой' : 'нет пустых назначений',
      tone: summaryUnassignedRollCount > 0 ? 'warning' : 'success',
      action: () => openSummaryTarget('unassigned'),
    },
    {
      id: 'blocked',
      label: 'Разобрать',
      value: `${summaryBlockedRollCount} блок.`,
      detail: summaryBlockedRollCount > 0 ? 'мешает запуску' : 'блокеров нет',
      tone: summaryBlockedRollCount > 0 ? 'warning' : 'success',
      action: () => openSummaryTarget('blocked'),
    },
    {
      id: 'critical',
      label: 'Приоритет',
      value: `${summaryCriticalRollCount} срочн.`,
      detail: summaryCriticalRollCount > 0 ? 'держать сверху' : 'обычная очередь',
      tone: summaryCriticalRollCount > 0 ? 'critical' : 'info',
      action: () => openSummaryTarget('critical'),
    },
  ];

  useEffect(() => {
    setExpandedArchiveId((current) => {
      if (current && visibleArchivedOrders.some((order) => order.id === current)) return current;
      return visibleArchivedOrders[0]?.id ?? null;
    });
  }, [visibleArchivedOrders]);

  function toggleOrderSort(key: ProductionOrderSortKey) {
    setOrderSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  }

  function toggleSelectedOrder(id: string) {
    setSelectedOrderIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  const productionOrderTableColumns: Array<PlenkiDataTableColumn<ProductionOrderRow>> = [
    {
      id: 'select',
      header: <span aria-label="Выбор заказ-наряда" />,
      dataLabel: 'Выбор',
      width: '54px',
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Выбрать ${row.title}`}
          checked={selectedOrderIds.includes(row.id)}
          onClick={(event) => event.stopPropagation()}
          onChange={() => toggleSelectedOrder(row.id)}
        />
      ),
    },
    ...orderColumns.map(
      (column): PlenkiDataTableColumn<ProductionOrderRow> => ({
        id: column.key,
        header: column.label,
        dataLabel: column.label,
        sortable: true,
        sortDirection: orderSort.key === column.key ? orderSort.direction : 'none',
        onSort: () => toggleOrderSort(column.key),
        ariaLabel: `Сортировать заказ-наряды: ${column.label}`,
        render: (row) => {
          if (column.key === 'order') {
            const expanded = expandedOrderId === row.id;
            return (
              <>
                <button
                  type="button"
                  className="production-order-disclosure"
                  onClick={(event) => {
                    event.stopPropagation();
                    setExpandedOrderId(expanded ? null : row.id);
                  }}
                  aria-expanded={expanded}
                  aria-controls={`production-order-rolls-${row.id}`}
                >
                  <span className="production-order-disclosure-mark" aria-hidden="true">
                    {expanded ? 'v' : '>'}
                  </span>
                  <strong>{row.title}</strong>
                </button>
              </>
            );
          }
          if (column.key === 'customer')
            return (
              <strong>
                {row.customer === 'На запас' ? (
                  <span className="commercial-stock-badge">На запас</span>
                ) : (
                  row.customer
                )}
              </strong>
            );
          if (column.key === 'status')
            return (
              <>
                <strong>{row.status}</strong>
                {row.approveActionId ? (
                  <button
                    type="button"
                    className="compact-action-button action-recommended production-order-approve-inline"
                    onClick={(event) => {
                      event.stopPropagation();
                      onApproveOrder?.(row.id, row.approveActionId ?? 'approve-order');
                    }}
                  >
                    {row.approveActionLabel ?? 'Согласовать'}
                  </button>
                ) : null}
              </>
            );
          if (column.key === 'priority') return <strong>{row.priorityLabel}</strong>;
          if (column.key === 'rolls') return <strong>{row.rollCount}</strong>;
          if (column.key === 'owner')
            return (
              <>
                <strong>{row.owner}</strong>
                <small>{row.machines}</small>
              </>
            );
          if (column.key === 'blocker') return <strong>{row.blocker}</strong>;
          return (
            <strong>{row.updated ? formatProductionTimestamp(row.updated) : 'нет данных'}</strong>
          );
        },
      }),
    ),
  ];

  return (
    <section
      className="surface production-workbench production-orders-hub severity-info"
      aria-label={mode === 'order-selection' ? 'Заказ-наряды и их рулоны' : 'Все рулоны'}
    >
      <header className="production-workbench-header production-orders-hub-header">
        <div>
          <span className="eyebrow">Зав. производства</span>
          <h3>{mode === 'order-selection' ? 'Заказ-наряды' : 'Все рулоны'}</h3>
        </div>
        {mode === 'order-selection' && onCreateRequest ? (
          <button
            className="create-intake-button action-keyboard-anchor"
            type="button"
            onClick={(event) => onCreateRequest(event.currentTarget)}
          >
            Создать заявку
          </button>
        ) : null}
      </header>

      <nav className="production-orders-hub-tabs" aria-label="Вид страницы заказ-нарядов">
        {hubViews.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? 'is-active' : ''}
            onClick={() => setView(item.id)}
            aria-pressed={view === item.id}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {view !== 'summary' ? (
        <PlenkiMetricStrip
          metrics={[
            {
              id: 'orders',
              label: 'Заказы',
              value: orderRows.length,
              caption: `${visibleOrderRows.length} в таблице`,
              tone: 'info',
            },
            {
              id: 'rolls',
              label: 'Рулоны',
              value: activeSortedRolls.length,
              caption: `${activeRollCount} в очереди`,
              tone: 'info',
            },
            {
              id: 'blocked',
              label: 'Проблемы',
              value: blockedRollCount,
              caption: onOpenProblems ? 'открыть проблемы' : 'нет назначения',
              tone: blockedRollCount > 0 ? 'warning' : 'success',
              onClick: onOpenProblems,
              actionLabel: onOpenProblems ? 'Открыть раздел «Проблемы»' : undefined,
            },
            {
              id: 'operators',
              label: 'Операторы',
              value: assignedOperatorCount,
              caption: 'с назначениями',
              tone: 'success',
            },
            {
              id: 'plan',
              label: 'План',
              value: formatProductionKg(totalWeight),
              caption: `${totalMeters} м`,
              tone: 'muted',
            },
          ]}
        />
      ) : null}

      {view === 'orders' && (
        <section className="production-orders-table-panel" aria-label="Все заказ-наряды">
          {useLiveData && commercialActionsState !== 'ready' ? (
            <div
              className="production-route-blocked"
              role={commercialActionsState === 'loading' ? 'status' : 'alert'}
              data-production-commercial-actions-error
            >
              <strong>
                {commercialActionsState === 'loading'
                  ? 'Загружаем действия по согласованию'
                  : 'Действия по согласованию недоступны'}
              </strong>
              <small>
                Заказ-наряды показаны; согласование{' '}
                {commercialActionsState === 'loading' ? 'обновляется' : 'недоступно'}.
              </small>
              {commercialActionsState === 'error' && onRetryCommercialActions ? (
                <button type="button" className="action-peer" onClick={onRetryCommercialActions}>
                  Повторить
                </button>
              ) : null}
            </div>
          ) : null}
          <PlenkiToolbar
            searchValue={orderSearchQuery}
            searchPlaceholder="Поиск по заказу, клиенту, оператору"
            onSearchChange={setOrderSearchQuery}
            filters={(Object.keys(orderFilterLabels) as ProductionOrderFilter[]).map((id) => ({
              id,
              label: orderFilterLabels[id],
              count: orderRows.filter((row) => matchesOrderFilter(row, id)).length,
              active: orderFilter === id,
              onClick: () => setOrderFilter(id),
            }))}
            meta={
              <span>
                {visibleOrderRows.length} из {orderRows.length}
              </span>
            }
          />
          <PlenkiDataTable
            caption="Таблица заказ-нарядов"
            columns={productionOrderTableColumns}
            rows={visibleOrderRows}
            getRowKey={(row) => row.id}
            getRowClassName={(row) => `severity-${row.blockedCount > 0 ? 'warning' : 'info'}`}
            isRowSelected={(row) => selectedOrderIds.includes(row.id)}
            renderExpandedRow={(row) =>
              expandedOrderId === row.id ? (
                <div
                  id={`production-order-rolls-${row.id}`}
                  className="production-order-expanded"
                  role="region"
                  aria-label={`Рулоны ${row.id}`}
                >
                  <table className="plenki-nested-table" aria-label={`Рулоны заказа ${row.id}`}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Рулон</th>
                        <th>Параметры</th>
                        <th>Оператор</th>
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {row.rolls.map((roll, index) => (
                        <tr key={roll.id} className={`status-${roll.status}`}>
                          <td>
                            <strong>{index + 1}</strong>
                            <small>{roll.rollId}</small>
                          </td>
                          <td>
                            <strong>{productionRollOrderNumber(roll)}</strong>
                            <small>{roll.orderLineId}</small>
                          </td>
                          <td>
                            <strong>{productionRollSpecificationLabel(roll)}</strong>
                          </td>
                          <td>
                            <strong>{roll.operatorLabel || 'Не назначен'}</strong>
                            <small>{roll.machineLabel || 'Станок не выбран'}</small>
                          </td>
                          <td>
                            <strong>
                              {roll.status === 'blocked'
                                ? (roll.blocker ?? 'Блокер')
                                : productionRollDispatchStatusLabel(roll.status)}
                            </strong>
                            <small>{roll.priority}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null
            }
          />
          <PlenkiBulkBar
            count={selectedOrderIds.length}
            label={pluralizeOrderNoun(selectedOrderIds.length)}
            onClear={() => setSelectedOrderIds([])}
            actions={
              <>
                <button
                  type="button"
                  className="action-recommended"
                  onClick={() => setView('rolls')}
                >
                  Открыть рулоны
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedOrderId(selectedOrderIds[0] ?? null)}
                >
                  Предосмотр
                </button>
              </>
            }
          />
        </section>
      )}

      {view === 'rolls' &&
        (mode === 'order-selection' && selectedOrderIds.length === 0 ? (
          <div className="production-archive-empty" role="status">
            <strong>Выберите заказ-наряд</strong>
            <small>
              Вернитесь во вкладку «Заказы», отметьте нужные строки и нажмите «Открыть рулоны».
            </small>
            <button type="button" className="action-peer" onClick={() => setView('orders')}>
              К заказам
            </button>
          </div>
        ) : (
          <div className="production-route-workspace">
            {assignableVisibleRolls.length > 0 ? (
              <div data-action="assign-operator">
                <ProductionDispatchPanel
                  // «Заказ-наряды»: назначение пишется сразу при выборе в строке (ТЗ);
                  // «Все рулоны»: черновик + чекбокс + «Записать».
                  viewMode={mode === 'all-rolls' ? 'rolls' : 'order'}
                  selectedOperatorId={
                    assignableVisibleRolls.find((item) => item.operatorId)?.operatorId ?? ''
                  }
                  selectedPriority={
                    assignableVisibleRolls.find((item) => item.priority)?.priority ?? 'обычный'
                  }
                  rollDispatchItems={assignableVisibleRolls}
                  onUpdateRollOperator={onUpdateRollOperator}
                  onUpdateRollMachine={onUpdateRollMachine}
                  onUpdateRollPriority={onUpdateRollPriority}
                  onBulkAssign={onBulkAssign}
                  onSaveSelected={onSaveSelected}
                  onMoveRollQueue={onMoveRollQueue}
                  operators={operators}
                  machineOptions={machineOptions}
                  lockMachineToOperator={lockMachineToOperator}
                />
              </div>
            ) : (
              <div className="production-route-blocked" role="status">
                <strong>Назначение оператору недоступно</strong>
                <small>Дождитесь зафиксированного маршрута производства.</small>
              </div>
            )}
          </div>
        ))}

      {view === 'archive' && (
        <section className="production-orders-archive" aria-label="Архив заказ-нарядов">
          <header className="management-period-toolbar production-archive-period-toolbar">
            <div>
              <span className="eyebrow">Архив</span>
              <strong>{formatProductionArchiveRange(archiveRange)}</strong>
              <small>
                {archiveLoadStatus === 'ready'
                  ? `${visibleArchivedOrders.length} заказ-нарядов с завершёнными рулонами · ${archiveRollCount} рул.`
                  : archiveLoadStatus === 'error'
                    ? 'Архив недоступен'
                    : 'Загрузка…'}
              </small>
            </div>
            <div className="management-period-controls">
              <div className="management-period-selector" aria-label="Быстрый выбор периода архива">
                {productionArchiveRangePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`management-period-chip ${archiveRange.preset === preset.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      setArchiveRange(
                        productionArchiveRangeForPreset(preset.id, currentArchiveReferenceDate()),
                      );
                      setArchiveCalendarOpen(false);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="management-period-calendar-wrap">
                <button
                  type="button"
                  className={`management-period-calendar-toggle ${archiveRange.preset === 'custom' ? 'is-selected' : ''}`}
                  onClick={() => setArchiveCalendarOpen((open) => !open)}
                >
                  <SiemensIcon name="calendar" size="16" />
                  <span>
                    {archiveRange.from} — {archiveRange.to}
                  </span>
                </button>
                {archiveCalendarOpen ? (
                  <ProductionArchivePeriodCalendar
                    title="Период архива"
                    footnote="Период фильтрует всю историю архива"
                    ariaLabel="Выбор периода архива"
                    range={archiveRange}
                    onPreset={(preset) => {
                      setArchiveRange(
                        productionArchiveRangeForPreset(preset, currentArchiveReferenceDate()),
                      );
                      setArchiveCalendarOpen(false);
                    }}
                    onChange={setArchiveRange}
                    onClose={() => setArchiveCalendarOpen(false)}
                  />
                ) : null}
              </div>
            </div>
          </header>
          {archiveLoadStatus === 'loading' || archiveLoadStatus === 'idle' ? (
            <div className="production-archive-empty" role="status">
              <strong>Загружаем архив</strong>
              <small>Дождитесь завершения загрузки.</small>
            </div>
          ) : null}
          {archiveLoadStatus === 'error' ? (
            <div className="production-archive-empty" role="alert">
              <strong>Архив не загружен</strong>
              <small>Активная очередь сохранена. Повторите запрос архива.</small>
              {onFetchArchive ? (
                <button type="button" className="action-peer" onClick={retryArchive}>
                  Повторить
                </button>
              ) : null}
            </div>
          ) : null}
          {archiveLoadStatus === 'ready' && visibleArchivedOrders.length === 0 ? (
            <div className="production-archive-empty">
              <strong>Заказов за период нет</strong>
              <small>Выберите другой диапазон в календаре.</small>
            </div>
          ) : null}
          {visibleArchivedOrders.map((order) => {
            const expanded = expandedArchiveId === order.id;
            return (
              <article
                key={order.id}
                className={`production-archive-order ${expanded ? 'is-expanded' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedArchiveId(expanded ? null : order.id)}
                  aria-expanded={expanded}
                >
                  <span>
                    <strong>{order.id}</strong>
                    <small>
                      {order.customer} · {order.status}
                    </small>
                  </span>
                  <span>
                    <strong>{order.rolls.length} рул.</strong>
                    <small>{order.completedAt}</small>
                  </span>
                </button>
                {expanded && (
                  <div className="production-archive-expanded">
                    <p>{order.audit}</p>
                    <div
                      className="production-order-rolls-list"
                      role="table"
                      aria-label={`Архивные рулоны ${order.id}`}
                    >
                      {order.rolls.map((roll, index) => (
                        <div key={roll.id} className="production-order-roll-row" role="row">
                          <span role="cell" data-label="Порядок">
                            <strong>{index + 1}</strong>
                            <small>{roll.id}</small>
                          </span>
                          <span role="cell" data-label="Позиция">
                            <strong>{roll.orderLineId}</strong>
                            <small>{roll.status}</small>
                          </span>
                          <span role="cell" data-label="Оператор">
                            <strong>{roll.operator}</strong>
                            <small>{roll.machine}</small>
                          </span>
                          <span role="cell" data-label="Параметры">
                            <strong>{roll.specification ?? 'Параметры не указаны'}</strong>
                          </span>
                          <span role="cell" data-label="Вес">
                            <strong>{roll.kg === null ? 'Факт не указан' : `${roll.kg} кг`}</strong>
                            <small>{order.priority}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {view === 'summary' && (
        <section className="production-orders-summary" aria-label="Сводка заказ-нарядов">
          <header className="management-period-toolbar production-summary-period-toolbar">
            <div>
              <span className="eyebrow">Сводка</span>
              <strong>{formatProductionArchiveRange(summaryRange)}</strong>
              <small>
                {archiveLoadStatus === 'ready'
                  ? `${summaryOrderRows.length} заказов · ${summaryRolls.length + summaryCompletedRollCount} рул.`
                  : `${summaryOrderRows.length} активных заказов · архив ${archiveLoadStatus === 'error' ? 'недоступен' : 'загружается'}`}
              </small>
            </div>
            <div className="management-period-controls">
              <div className="management-period-selector" aria-label="Быстрый выбор периода сводки">
                {productionArchiveRangePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`management-period-chip ${summaryRange.preset === preset.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      setSummaryRange(
                        productionArchiveRangeForPreset(preset.id, currentArchiveReferenceDate()),
                      );
                      setSummaryCalendarOpen(false);
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="management-period-calendar-wrap">
                <button
                  type="button"
                  className={`management-period-calendar-toggle ${summaryRange.preset === 'custom' ? 'is-selected' : ''}`}
                  onClick={() => setSummaryCalendarOpen((open) => !open)}
                >
                  <SiemensIcon name="calendar" size="16" />
                  <span>
                    {summaryRange.from} — {summaryRange.to}
                  </span>
                </button>
                {summaryCalendarOpen ? (
                  <ProductionArchivePeriodCalendar
                    title="Период сводки"
                    footnote="Период фильтрует активные рулоны и закрытый архив"
                    ariaLabel="Выбор периода сводки"
                    range={summaryRange}
                    onPreset={(preset) => {
                      setSummaryRange(
                        productionArchiveRangeForPreset(preset, currentArchiveReferenceDate()),
                      );
                      setSummaryCalendarOpen(false);
                    }}
                    onChange={setSummaryRange}
                    onClose={() => setSummaryCalendarOpen(false)}
                  />
                ) : null}
              </div>
            </div>
          </header>

          {archiveLoadStatus === 'loading' || archiveLoadStatus === 'idle' ? (
            <div className="production-archive-empty" role="status">
              <strong>Загружаем закрытый выпуск</strong>
              <small>Активная очередь остаётся доступной.</small>
            </div>
          ) : null}
          {archiveLoadStatus === 'error' ? (
            <div className="production-archive-empty" role="alert">
              <strong>Архив выпуска не загружен</strong>
              <small>Показаны только подтверждённые активные строки.</small>
              {onFetchArchive ? (
                <button type="button" className="action-peer" onClick={retryArchive}>
                  Повторить
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="production-summary-kpi-grid">
            <button
              type="button"
              className="production-summary-kpi tone-production"
              onClick={() => setView('archive')}
            >
              <span>Факт завершённых рулонов</span>
              <strong>
                {archiveLoadStatus === 'ready'
                  ? summaryCompletedRollCount === 0
                    ? 'Нет завершённых рулонов'
                    : summaryCompletedActualWeights.length === 0
                      ? 'Факт веса не указан'
                      : `${formatProductionKg(summaryCompletedWeight)}${summaryMissingActualWeightCount > 0 ? ' · частичные данные' : ''}`
                  : archiveLoadStatus === 'error'
                    ? 'Архив недоступен'
                    : 'Загрузка…'}
              </strong>
              <small>
                {archiveLoadStatus === 'ready'
                  ? `${summaryCompletedRollCount} завершено · ${summaryQueueRollCount} в очереди${summaryMissingActualWeightCount > 0 ? ` · без факта веса ${summaryMissingActualWeightCount}` : ''}`
                  : `${summaryQueueRollCount} в очереди`}
              </small>
            </button>
            <button
              type="button"
              className="production-summary-kpi tone-info"
              onClick={() => setView('rolls')}
            >
              <span>Очередь</span>
              <strong>{summaryQueueRollCount} рул.</strong>
              <small>
                {formatProductionKg(summaryPlanWeight)} · {summaryPlanMeters} м
              </small>
            </button>
            <button
              type="button"
              className={`production-summary-kpi ${summaryUnassignedRollCount > 0 ? 'tone-warning' : 'tone-success'}`}
              onClick={() => {
                openSummaryTarget('unassigned');
              }}
            >
              <span>Без назначения</span>
              <strong>{summaryUnassignedRollCount}</strong>
              <small>оператор / станок</small>
            </button>
            <button
              type="button"
              className={`production-summary-kpi ${summaryBlockedRollCount > 0 ? 'tone-warning' : 'tone-success'}`}
              onClick={() => {
                openSummaryTarget('blocked');
              }}
            >
              <span>Блокеры</span>
              <strong>{summaryBlockedRollCount}</strong>
              <small>нельзя запускать</small>
            </button>
            <button
              type="button"
              className={`production-summary-kpi ${summaryCriticalRollCount > 0 ? 'tone-critical' : 'tone-info'}`}
              onClick={() => {
                openSummaryTarget('critical');
              }}
            >
              <span>Срочные</span>
              <strong>{summaryCriticalRollCount}</strong>
              <small>критично / срочно</small>
            </button>
            <button
              type="button"
              className={`production-summary-kpi ${summaryOverloadedOperatorCount > 0 ? 'tone-warning' : 'tone-info'}`}
              onClick={() => setView('rolls')}
            >
              <span>Загрузка</span>
              <strong>{summaryLoadPct === null ? 'По очереди' : `${summaryLoadPct}%`}</strong>
              <small>
                {summaryAssignedOperatorCount}/{summaryAvailableOperatorCount} операторов ·{' '}
                {summaryLoadPct === null ? 'без лимита времени' : `${summaryFreeMinutes} мин`}
              </small>
            </button>
          </div>

          <div className="production-summary-workgrid">
            <section
              className="production-summary-priority-list"
              aria-label="Что сделать по периоду"
            >
              <header>
                <span className="eyebrow">Фокус</span>
                <strong>Что делать</strong>
              </header>
              {summaryActionRows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`production-summary-action tone-${row.tone}`}
                  onClick={row.action}
                >
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                  <small>{row.detail}</small>
                </button>
              ))}
            </section>
            <section className="production-summary-operator-load" aria-label="Загрузка операторов">
              <header>
                <span className="eyebrow">Операторы</span>
                <strong>Загрузка</strong>
              </header>
              {summaryOperatorRows.length === 0 ? (
                <div className="production-summary-empty">
                  <strong>Назначений нет</strong>
                  <small>Выберите другой период или откройте рулоны.</small>
                </div>
              ) : (
                <div className="production-summary-operator-table">
                  {summaryOperatorRows.map((operator) => (
                    <div
                      key={operator.operatorId}
                      className={`production-summary-operator-row state-${operator.loadState}`}
                    >
                      <span>
                        <strong>{operator.operatorLabel}</strong>
                        <small>{operator.defaultMachineLabel ?? 'Станок не задан'}</small>
                      </span>
                      <span>
                        <strong>{operator.assignedRollCount} рул.</strong>
                        <small>{formatProductionKg(operator.plannedWeightKg)}</small>
                      </span>
                      <span>
                        <strong>
                          {operator.capacityKnown
                            ? `${operator.estimatedMinutesTotal} мин`
                            : 'По очереди'}
                        </strong>
                        <small>
                          {operator.capacityKnown
                            ? `${operator.availableCapacityMinutes} мин свободно`
                            : 'без лимита времени'}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>
      )}
    </section>
  );
}

function ProductionArchivePeriodCalendar({
  title,
  footnote,
  ariaLabel,
  range,
  onPreset,
  onChange,
  onClose,
}: {
  title: string;
  footnote: string;
  ariaLabel: string;
  range: ProductionArchiveDateRange;
  onPreset: (preset: ProductionArchiveRangePreset) => void;
  onChange: (range: ProductionArchiveDateRange) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="management-period-calendar production-archive-calendar"
      role="dialog"
      aria-label={ariaLabel}
    >
      <div className="management-period-calendar-head">
        <div>
          <strong>{title}</strong>
          <span>{formatProductionArchiveRange(range)}</span>
        </div>
        <button type="button" aria-label="Закрыть календарь" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="management-period-calendar-body">
        <div className="management-period-calendar-presets">
          {productionArchiveRangePresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={range.preset === preset.id ? 'is-selected' : ''}
              onClick={() => onPreset(preset.id)}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            className={range.preset === 'custom' ? 'is-selected' : ''}
            onClick={() => onChange({ ...range, preset: 'custom' })}
          >
            Диапазон
          </button>
        </div>
        <div className="management-period-calendar-main">
          <div className="management-period-date-fields">
            <label>
              <span>Начало</span>
              <input
                type="date"
                value={range.from}
                onChange={(event) =>
                  onChange(
                    normalizeProductionArchiveRange({
                      ...range,
                      preset: 'custom',
                      from: event.target.value,
                    }),
                  )
                }
              />
            </label>
            <label>
              <span>Конец</span>
              <input
                type="date"
                value={range.to}
                onChange={(event) =>
                  onChange(
                    normalizeProductionArchiveRange({
                      ...range,
                      preset: 'custom',
                      to: event.target.value,
                    }),
                  )
                }
              />
            </label>
          </div>
          <div className="management-period-months">
            {productionArchiveCalendarMonthsForRange(range).map((month) => (
              <ProductionArchiveCalendarMonth
                key={`${month.year}-${month.month}`}
                month={month.month}
                year={month.year}
                title={month.title}
                range={range}
                onSelect={(day) => onChange(selectProductionArchiveCalendarDay(range, day))}
              />
            ))}
          </div>
          <div className="management-period-calendar-foot">
            <span>{footnote}</span>
            <button type="button" onClick={onClose}>
              Применить
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProductionArchiveCalendarMonth({
  month,
  year,
  title,
  range,
  onSelect,
}: {
  month: number;
  year: number;
  title: string;
  range: ProductionArchiveDateRange;
  onSelect: (day: string) => void;
}) {
  const days = buildProductionArchiveMonthDays(year, month);

  return (
    <div className="management-period-month">
      <strong>{title}</strong>
      <div className="management-period-weekdays">
        {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="management-period-days">
        {days.map((day, index) =>
          day ? (
            <button
              key={day}
              type="button"
              className={[
                isProductionArchiveRangeEdge(range, day) ? 'is-edge' : '',
                isProductionArchiveRangeInner(range, day) ? 'is-range' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(day)}
            >
              {Number(day.slice(-2))}
            </button>
          ) : (
            <span key={`blank-${index}`} />
          ),
        )}
      </div>
    </div>
  );
}

function productionArchiveIso(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function productionArchiveDateFromIso(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function productionArchiveDateKey(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : productionMoscowDateKey(date);
}

function productionArchiveRangeForPreset(
  preset: ProductionArchiveRangePreset,
  referenceDate: Date,
): ProductionArchiveDateRange {
  const todayDateKey = productionArchiveIso(referenceDate);
  if (preset === 'today') {
    return { preset, from: todayDateKey, to: todayDateKey };
  }
  if (preset === 'yesterday') {
    const yesterday = new Date(referenceDate);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayDateKey = productionArchiveIso(yesterday);
    return { preset, from: yesterdayDateKey, to: yesterdayDateKey };
  }
  if (preset === 'week') {
    const weekStart = new Date(referenceDate);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);
    return { preset, from: productionArchiveIso(weekStart), to: todayDateKey };
  }
  const monthStart = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1),
  );
  return { preset, from: productionArchiveIso(monthStart), to: todayDateKey };
}

function productionArchiveMonthTitle(date: Date) {
  const title = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(date);
  return `${title[0]?.toLocaleUpperCase('ru-RU')}${title.slice(1)}`;
}

function productionArchiveCalendarMonthsForRange(range: ProductionArchiveDateRange) {
  const from = productionArchiveDateFromIso(range.from);
  const to = productionArchiveDateFromIso(range.to);
  const fromMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const toMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const firstMonth =
    productionArchiveIso(fromMonth) === productionArchiveIso(toMonth)
      ? new Date(Date.UTC(toMonth.getUTCFullYear(), toMonth.getUTCMonth() - 1, 1))
      : fromMonth;
  return [firstMonth, toMonth].map((date) => ({
    month: date.getUTCMonth(),
    year: date.getUTCFullYear(),
    title: productionArchiveMonthTitle(date),
  }));
}

function normalizeProductionArchiveRange(
  range: ProductionArchiveDateRange,
): ProductionArchiveDateRange {
  if (range.from <= range.to) return range;
  return { ...range, from: range.to, to: range.from };
}

function formatProductionArchiveRange(range: ProductionArchiveDateRange) {
  if (range.from === range.to) return formatProductionArchiveShortDate(range.from);
  return `${formatProductionArchiveShortDate(range.from)} — ${formatProductionArchiveShortDate(range.to)}`;
}

function formatProductionArchiveShortDate(value: string) {
  const date = productionArchiveDateFromIso(value);
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(date);
}

function buildProductionArchiveMonthDays(year: number, month: number) {
  const firstDay = new Date(Date.UTC(year, month, 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const mondayOffset = (firstDay.getUTCDay() + 6) % 7;
  const days: Array<string | null> = Array.from({ length: mondayOffset }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(productionArchiveIso(new Date(Date.UTC(year, month, day))));
  }
  return days;
}

function isProductionArchiveRangeEdge(range: ProductionArchiveDateRange, day: string) {
  return day === range.from || day === range.to;
}

function isProductionArchiveRangeInner(range: ProductionArchiveDateRange, day: string) {
  return day > range.from && day < range.to;
}

function selectProductionArchiveCalendarDay(
  range: ProductionArchiveDateRange,
  day: string,
): ProductionArchiveDateRange {
  if (range.preset !== 'custom' || range.from === range.to) {
    return { preset: 'custom', from: day, to: day };
  }
  if (day < range.from) return { preset: 'custom', from: day, to: range.from };
  return { preset: 'custom', from: range.from, to: day };
}
