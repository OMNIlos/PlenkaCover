import { useEffect, useMemo, useRef, useState } from 'react';

import {
  operatorById as demoOperatorById,
  operatorDefaultMachineLabel,
  operatorWorkloadLabel,
  productionOperators,
  type ProductionOperator,
} from '../../domain/operators';
import {
  operatorWorkloadsFromDispatch,
  productionRollDispatchStatusLabel,
  productionRollLineLabel,
  productionRollOrderLabel,
  productionRollOrderNumber,
  productionRollPlannedWeightTotal,
  productionRollSpecificationLabel,
  sortProductionRolls,
  type ProductionRollSort,
  type ProductionRollSortMode,
} from '../../domain/rollWork';
import type { ProductionRollDispatchItem } from '../../domain/types';
import { SiemensIcon } from '../shell/SiemensIcon';
import {
  dirtyStringDraftBaselineValue,
  dirtyStringDraftValue,
  reconcileDirtyStringDrafts,
  resetDirtyStringDraft,
  setDirtyStringDraft,
  settleDirtyStringMutation,
  type DirtyStringDrafts,
} from './productionAssignmentDrafts';

const productionPriorityOptions = [
  {
    value: 'критично',
    label: 'Критично',
    queue: 1,
    detail: 'Ставить первым, требует контроля',
    tone: 'critical',
  },
  { value: 'срочно', label: 'Срочно', queue: 2, detail: 'Выше обычных заказов', tone: 'warning' },
  { value: 'обычный', label: 'Обычный', queue: 3, detail: 'Плановая очередь', tone: 'normal' },
] as const;

const defaultProductionMachineOptions = [
  { value: '', label: 'Назначьте станок' },
  { value: 'E-01', label: 'Экструдер E-01' },
  { value: 'E-02', label: 'Экструдер E-02' },
  { value: 'E-03', label: 'Экструдер E-03' },
  { value: 'E-04', label: 'Экструдер E-04' },
  { value: 'E-06', label: 'Экструдер E-06' },
] as const;

const rollDispatchColumns: Array<{ key: ProductionRollSortMode; label: string }> = [
  { key: 'manual', label: 'Порядок' },
  { key: 'roll', label: 'Рулон' },
  { key: 'order', label: 'Заказ' },
  { key: 'parameters', label: 'Параметры' },
  { key: 'operator', label: 'Оператор' },
  { key: 'machine', label: 'Станок' },
  { key: 'priority', label: 'Приоритет' },
];

const ROLL_DISPATCH_PAGE_SIZE = 100;

export type ProductionRollDraftChange = {
  rollDispatchItemId: string;
  operatorId: string;
  machineId: string;
  priority: string;
};

export type ProductionRollImmediateMutation = void | Promise<boolean>;

const REASSIGNABLE_ROLL_STATUSES = new Set<ProductionRollDispatchItem['status']>([
  'queued',
  'assigned',
  'blocked',
]);

function canReassignProductionRoll(item: ProductionRollDispatchItem) {
  return REASSIGNABLE_ROLL_STATUSES.has(item.status);
}

function productionMachineAssignmentLabel(
  item: ProductionRollDispatchItem,
  draftMachineId: string,
) {
  if (!draftMachineId) return 'назначьте станок для рулона';
  if (draftMachineId !== item.machineId) return 'изменение станка не записано';
  if (item.machineAssignmentSource === 'shift_default')
    return `По умолчанию · ${item.defaultMachineLabelSnapshot ?? item.machineLabel}`;
  if (item.machineAssignmentSource === 'manual_override' || item.manualMachineOverride)
    return item.machineOverrideReason ?? 'переопределено в строке рулона';
  const assignedAt = item.machineAssignedAt ? ` · ${item.machineAssignedAt}` : '';
  return `${item.machineAssignedBy || 'Зав. производства'}${assignedAt}`;
}

function assignedRollOperatorsSummary(rollDispatchItems: ProductionRollDispatchItem[]) {
  const assignedOperatorIds = new Set(
    rollDispatchItems.map((item) => item.operatorId).filter(Boolean),
  );
  const blockedCount = rollDispatchItems.filter(
    (item) => item.status === 'blocked' || !item.operatorId || !item.machineId,
  ).length;
  if (assignedOperatorIds.size === 0) return 'Не назначены';
  return blockedCount > 0
    ? `${assignedOperatorIds.size} исполн. · ${blockedCount} блок.`
    : `${assignedOperatorIds.size} исполн.`;
}

function rollPrioritySummary(rollDispatchItems: ProductionRollDispatchItem[], fallback: string) {
  const criticalCount = rollDispatchItems.filter((item) => item.priority === 'критично').length;
  const urgentCount = rollDispatchItems.filter((item) => item.priority === 'срочно').length;
  if (criticalCount > 0) return `${criticalCount} крит.`;
  if (urgentCount > 0) return `${urgentCount} срочн.`;
  return fallback;
}

function workloadStateLabel(
  state: ReturnType<typeof operatorWorkloadsFromDispatch>[number]['loadState'],
) {
  const labels: Record<
    ReturnType<typeof operatorWorkloadsFromDispatch>[number]['loadState'],
    string
  > = {
    available: 'можно назначать',
    near_limit: 'почти заполнен',
    overloaded: 'перегруз',
    blocked: 'недоступен',
  };
  return labels[state];
}

function formatMinutes(value: number) {
  if (value <= 0) return '0 мин';
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (hours === 0) return `${minutes} мин`;
  return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
}

type OperatorDetailView = 'orders' | 'queue';

function operatorOrderDetailGroups(rolls: ProductionRollDispatchItem[]) {
  const groups = new Map<string, ProductionRollDispatchItem[]>();
  for (const roll of rolls) {
    const existing = groups.get(roll.orderId) ?? [];
    existing.push(roll);
    groups.set(roll.orderId, existing);
  }

  return Array.from(groups.entries())
    .map(([orderId, orderRolls]) => {
      const sortedOrderRolls = sortProductionRolls(orderRolls, 'manual');
      const firstRoll = sortedOrderRolls[0];
      const blockers = sortedOrderRolls.filter(
        (roll) => roll.status === 'blocked' || !roll.machineId || !roll.operatorId,
      );
      return {
        orderId,
        orderNumber: productionRollOrderNumber(firstRoll),
        customerAlias: firstRoll.customerAlias,
        rollCount: sortedOrderRolls.length,
        plannedWeightKg: productionRollPlannedWeightTotal(sortedOrderRolls),
        estimatedMinutesTotal: sortedOrderRolls.reduce(
          (sum, roll) => sum + (roll.estimatedMinutes ?? 0),
          0,
        ),
        nextRoll: firstRoll,
        blockers,
      };
    })
    .sort((left, right) => left.nextRoll.sequenceNumber - right.nextRoll.sequenceNumber);
}

export function ProductionDispatchPanel({
  viewMode = 'order',
  selectedOperatorId,
  selectedPriority,
  rollDispatchItems = [],
  onAssignOperator,
  onUpdatePriority,
  onUpdateRollOperator,
  onUpdateRollMachine,
  onUpdateRollPriority,
  onBulkAssign,
  onSaveSelected,
  onMoveRollQueue,
  operators = productionOperators,
  machineOptions = defaultProductionMachineOptions,
  lockMachineToOperator = false,
}: {
  viewMode?: 'order' | 'rolls';
  selectedOperatorId: string;
  selectedPriority: string;
  rollDispatchItems?: ProductionRollDispatchItem[];
  onAssignOperator?: (operatorId: string) => void;
  onUpdatePriority?: (priority: string) => void;
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
  operators?: ProductionOperator[];
  machineOptions?: readonly { value: string; label: string }[];
  lockMachineToOperator?: boolean;
}) {
  const [draftOperatorId, setDraftOperatorId] = useState(selectedOperatorId);
  const [draftPriority, setDraftPriority] = useState(selectedPriority);
  const [draftOperatorByRollId, setDraftOperatorByRollId] = useState<DirtyStringDrafts>({});
  const [draftMachineByRollId, setDraftMachineByRollId] = useState<DirtyStringDrafts>({});
  const [draftPriorityByRollId, setDraftPriorityByRollId] = useState<DirtyStringDrafts>({});
  const pendingImmediateRollIdsRef = useRef(new Set<string>());
  const [pendingImmediateRollIds, setPendingImmediateRollIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [rollSort, setRollSort] = useState<ProductionRollSort>({ key: 'manual', direction: 'asc' });
  const [rollPage, setRollPage] = useState(0);
  const [selectedRollIds, setSelectedRollIds] = useState<string[]>([]);
  const [bulkOperatorId, setBulkOperatorId] = useState(selectedOperatorId);
  const [bulkPriority, setBulkPriority] = useState(selectedPriority);
  const rollDispatchItemsRef = useRef(rollDispatchItems);
  rollDispatchItemsRef.current = rollDispatchItems;
  const operatorById = (operatorId: string | undefined) =>
    operators.find((operator) => operator.id === operatorId);
  const currentOperator = operatorById(draftOperatorId);
  const currentPriority =
    productionPriorityOptions.find((item) => item.value === draftPriority) ??
    productionPriorityOptions[2];
  const availableOperators = operators.filter((operator) => operator.status !== 'blocked');
  const hasRollDispatch = rollDispatchItems.length > 0;
  const sortedRollDispatchItems = useMemo(
    () => sortProductionRolls(rollDispatchItems, rollSort),
    [rollDispatchItems, rollSort],
  );
  const rollPageCount = Math.max(
    1,
    Math.ceil(sortedRollDispatchItems.length / ROLL_DISPATCH_PAGE_SIZE),
  );
  const resolvedRollPage = viewMode === 'rolls' ? Math.min(rollPage, rollPageCount - 1) : 0;
  const rollPageStart = resolvedRollPage * ROLL_DISPATCH_PAGE_SIZE;
  const visibleRollDispatchItems =
    viewMode === 'rolls'
      ? sortedRollDispatchItems.slice(rollPageStart, rollPageStart + ROLL_DISPATCH_PAGE_SIZE)
      : sortedRollDispatchItems;
  const reassignableRollIds = useMemo(
    () =>
      new Set(
        rollDispatchItems.filter(canReassignProductionRoll).map((item) => item.id),
      ),
    [rollDispatchItems],
  );
  const reassignableVisibleRollIds = visibleRollDispatchItems
    .map((item) => item.id)
    .filter((id) => reassignableRollIds.has(id));
  const selectedRollSet = useMemo(() => new Set(selectedRollIds), [selectedRollIds]);
  const hasDraftOperator = Boolean(currentOperator);
  const hasDispatchChanges =
    !hasRollDispatch &&
    (draftOperatorId !== selectedOperatorId || draftPriority !== selectedPriority);
  const canCommitDispatch = hasDraftOperator && hasDispatchChanges;
  const commitLabel = !hasDraftOperator
    ? 'Выберите оператора'
    : hasDispatchChanges
      ? 'Записать назначение'
      : 'Назначение записано';
  const commitTitle = !hasDraftOperator
    ? 'Выбери оператора перед записью назначения'
    : hasDispatchChanges
      ? 'Записать выбранного оператора и приоритет'
      : 'Доступно после изменения оператора или приоритета';
  const commitIcon = !hasDraftOperator
    ? 'user-management-settings-filled'
    : canCommitDispatch
      ? 'tasks-open'
      : 'check';
  const selectionLabel =
    selectedRollIds.length > 0 ? `${selectedRollIds.length} выбрано` : 'нет выбранных';
  const hasSelectedImmediateMutationPending = selectedRollIds.some((id) =>
    pendingImmediateRollIds.has(id),
  );
  const canBulkAssign =
    !hasSelectedImmediateMutationPending &&
    selectedRollIds.length > 0 &&
    selectedRollIds.every((id) =>
      Boolean(
        reassignableRollIds.has(id) &&
          (dirtyStringDraftValue(draftOperatorByRollId, id, '') || bulkOperatorId),
      ),
    );

  useEffect(() => {
    setDraftOperatorId(selectedOperatorId);
  }, [selectedOperatorId]);

  useEffect(() => {
    setDraftPriority(selectedPriority);
  }, [selectedPriority]);

  useEffect(() => {
    setBulkOperatorId(selectedOperatorId);
  }, [selectedOperatorId]);

  useEffect(() => {
    setBulkPriority(selectedPriority);
  }, [selectedPriority]);

  useEffect(() => {
    setDraftOperatorByRollId((current) =>
      reconcileDirtyStringDrafts(
        current,
        Object.fromEntries(rollDispatchItems.map((item) => [item.id, item.operatorId])),
      ),
    );
    setDraftMachineByRollId((current) =>
      reconcileDirtyStringDrafts(
        current,
        Object.fromEntries(rollDispatchItems.map((item) => [item.id, item.machineId])),
      ),
    );
    setDraftPriorityByRollId((current) =>
      reconcileDirtyStringDrafts(
        current,
        Object.fromEntries(rollDispatchItems.map((item) => [item.id, item.priority])),
      ),
    );
    setSelectedRollIds((current) =>
      current.filter((id) => reassignableRollIds.has(id)),
    );
  }, [reassignableRollIds, rollDispatchItems]);

  useEffect(() => {
    setRollPage((current) => (viewMode === 'rolls' ? Math.min(current, rollPageCount - 1) : 0));
  }, [rollPageCount, viewMode]);

  function setImmediateRollPending(rollId: string, pending: boolean) {
    const next = new Set(pendingImmediateRollIdsRef.current);
    if (pending) next.add(rollId);
    else next.delete(rollId);
    pendingImmediateRollIdsRef.current = next;
    setPendingImmediateRollIds(next);
  }

  function runImmediateMutation(
    rollId: string,
    mutate: () => ProductionRollImmediateMutation,
    settle: (accepted: boolean) => void,
  ) {
    if (pendingImmediateRollIdsRef.current.has(rollId)) return;
    setImmediateRollPending(rollId, true);

    let result: ProductionRollImmediateMutation;
    try {
      result = mutate();
    } catch {
      settle(false);
      setImmediateRollPending(rollId, false);
      return;
    }
    if (!result) {
      setImmediateRollPending(rollId, false);
      return;
    }
    void result
      .then(settle, () => settle(false))
      .finally(() => setImmediateRollPending(rollId, false));
  }

  function latestRollDispatchItem(rollId: string) {
    return rollDispatchItemsRef.current.find((item) => item.id === rollId);
  }

  function updateRollOperator(item: ProductionRollDispatchItem, operatorId: string) {
    if (viewMode === 'order' && pendingImmediateRollIdsRef.current.has(item.id)) return;
    const baselineOperatorId = dirtyStringDraftBaselineValue(
      draftOperatorByRollId,
      item.id,
      item.operatorId,
    );
    if (viewMode === 'order' && (!operatorId || operatorId === baselineOperatorId)) {
      setDraftOperatorByRollId((current) =>
        resetDirtyStringDraft(current, item.id, item.operatorId),
      );
      setDraftMachineByRollId((current) => resetDirtyStringDraft(current, item.id, item.machineId));
      return;
    }
    setDraftOperatorByRollId((current) => setDirtyStringDraft(current, item.id, operatorId));
    const operator = operatorById(operatorId);
    if (operator?.defaultMachineId) {
      setDraftMachineByRollId((current) =>
        setDirtyStringDraft(current, item.id, operator.defaultMachineId),
      );
    }
    if (viewMode === 'order' && operatorId && operatorId !== baselineOperatorId) {
      runImmediateMutation(
        item.id,
        () => onUpdateRollOperator?.(item.id, operatorId),
        (accepted) => {
          const latestItem = latestRollDispatchItem(item.id);
          if (!latestItem) return;
          setDraftOperatorByRollId((current) =>
            settleDirtyStringMutation(current, item.id, accepted, latestItem.operatorId),
          );
          setDraftMachineByRollId((current) =>
            settleDirtyStringMutation(current, item.id, accepted, latestItem.machineId),
          );
        },
      );
    }
  }

  function toggleRollSelection(item: ProductionRollDispatchItem) {
    if (!canReassignProductionRoll(item) || pendingImmediateRollIdsRef.current.has(item.id)) return;
    setSelectedRollIds((current) =>
      current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
    );
  }

  function toggleAllVisibleRolls() {
    if (selectedRollIds.some((id) => pendingImmediateRollIdsRef.current.has(id))) return;
    const visibleIds = reassignableVisibleRollIds.filter(
      (id) => !pendingImmediateRollIdsRef.current.has(id),
    );
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRollSet.has(id));
    const visibleIdSet = new Set(visibleIds);
    setSelectedRollIds((current) =>
      allSelected
        ? current.filter((id) => !visibleIdSet.has(id))
        : Array.from(new Set([...current, ...visibleIds])),
    );
  }

  function commitBulkAssign() {
    if (!canBulkAssign || selectedRollIds.some((id) => pendingImmediateRollIdsRef.current.has(id)))
      return;
    if (onSaveSelected) {
      onSaveSelected(
        selectedRollIds.map((id) => {
          const operatorId = dirtyStringDraftValue(draftOperatorByRollId, id, '') || bulkOperatorId;
          const operator = operatorById(operatorId);
          return {
            rollDispatchItemId: id,
            operatorId,
            machineId:
              dirtyStringDraftValue(draftMachineByRollId, id, '') ||
              operator?.defaultMachineId ||
              '',
            priority: dirtyStringDraftValue(draftPriorityByRollId, id, bulkPriority),
          };
        }),
      );
    } else {
      onBulkAssign?.(selectedRollIds, bulkOperatorId, bulkPriority);
    }
    setSelectedRollIds([]);
  }

  function updateBulkOperator(operatorId: string) {
    if (hasSelectedImmediateMutationPending) return;
    setBulkOperatorId(operatorId);
    const operator = operatorById(operatorId);
    setDraftOperatorByRollId((current) =>
      selectedRollIds.reduce((next, id) => setDirtyStringDraft(next, id, operatorId), current),
    );
    if (operator?.defaultMachineId) {
      setDraftMachineByRollId((current) =>
        selectedRollIds.reduce(
          (next, id) => setDirtyStringDraft(next, id, operator.defaultMachineId),
          current,
        ),
      );
    }
  }

  function updateBulkPriority(priority: string) {
    if (hasSelectedImmediateMutationPending) return;
    setBulkPriority(priority);
    setDraftPriorityByRollId((current) =>
      selectedRollIds.reduce((next, id) => setDirtyStringDraft(next, id, priority), current),
    );
  }

  function commitDispatch() {
    if (!canCommitDispatch) return;
    if (draftOperatorId !== selectedOperatorId) onAssignOperator?.(draftOperatorId);
    if (draftPriority !== selectedPriority) onUpdatePriority?.(draftPriority);
  }

  function updateRollMachine(item: ProductionRollDispatchItem, machineId: string) {
    if (viewMode === 'order' && pendingImmediateRollIdsRef.current.has(item.id)) return;
    const baselineMachineId = dirtyStringDraftBaselineValue(
      draftMachineByRollId,
      item.id,
      item.machineId,
    );
    if (viewMode === 'order' && machineId === baselineMachineId) {
      setDraftMachineByRollId((current) => resetDirtyStringDraft(current, item.id, item.machineId));
      return;
    }
    setDraftMachineByRollId((current) => setDirtyStringDraft(current, item.id, machineId));
    if (viewMode === 'order' && machineId && machineId !== baselineMachineId) {
      runImmediateMutation(
        item.id,
        () => onUpdateRollMachine?.(item.id, machineId),
        (accepted) => {
          const latestItem = latestRollDispatchItem(item.id);
          if (!latestItem) return;
          setDraftMachineByRollId((current) =>
            settleDirtyStringMutation(current, item.id, accepted, latestItem.machineId),
          );
        },
      );
    }
  }

  function updateRollPriority(item: ProductionRollDispatchItem, priority: string) {
    if (viewMode === 'order' && pendingImmediateRollIdsRef.current.has(item.id)) return;
    const baselinePriority = dirtyStringDraftBaselineValue(
      draftPriorityByRollId,
      item.id,
      item.priority,
    );
    if (viewMode === 'order' && priority === baselinePriority) {
      setDraftPriorityByRollId((current) => resetDirtyStringDraft(current, item.id, item.priority));
      return;
    }
    setDraftPriorityByRollId((current) => setDirtyStringDraft(current, item.id, priority));
    if (viewMode === 'order' && priority && priority !== baselinePriority) {
      runImmediateMutation(
        item.id,
        () => onUpdateRollPriority?.(item.id, priority),
        (accepted) => {
          const latestItem = latestRollDispatchItem(item.id);
          if (!latestItem) return;
          setDraftPriorityByRollId((current) =>
            settleDirtyStringMutation(current, item.id, accepted, latestItem.priority),
          );
        },
      );
    }
  }

  function toggleRollSort(key: ProductionRollSortMode) {
    setRollSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  }

  function rollSortAria(key: ProductionRollSortMode) {
    if (rollSort.key !== key) return 'none';
    return rollSort.direction === 'asc' ? 'ascending' : 'descending';
  }

  function rollSortLabel(column: { key: ProductionRollSortMode; label: string }) {
    if (rollSort.key !== column.key) return `Сортировать по колонке ${column.label}`;
    return rollSort.direction === 'asc'
      ? `${column.label}: по возрастанию. Нажмите для обратного порядка`
      : `${column.label}: по убыванию. Нажмите для прямого порядка`;
  }

  return (
    <div
      className="production-dispatch-grid production-dispatch-strip"
      aria-label="Главные действия завпроизводства"
    >
      {!hasRollDispatch && (
        <section className="production-dispatch-card production-dispatch-operator-picker">
          <div className="production-dispatch-card-head">
            <div>
              <span className="eyebrow">Назначение</span>
              <h4>
                <ix-icon name="user-management-settings-filled" size="16" />
                Выбрать исполнителя
              </h4>
            </div>
            <span className="production-state-badge severity-info">
              {availableOperators.length} доступны
            </span>
          </div>
          <div className="production-operator-list">
            {availableOperators.map((operator) => (
              <button
                key={operator.id}
                type="button"
                className={`production-operator-card ${draftOperatorId === operator.id ? 'is-selected' : ''} ${draftOperatorId === operator.id && selectedOperatorId !== operator.id ? 'is-draft' : ''}`}
                onClick={() => setDraftOperatorId(operator.id)}
                aria-pressed={draftOperatorId === operator.id}
              >
                <span className="operator-avatar" aria-hidden="true">
                  <SiemensIcon name="user-management-settings-filled" size="16" />
                </span>
                <span>
                  <strong>{operator.name}</strong>
                  <small>
                    {operator.workplace} · {operator.skill}
                  </small>
                </span>
                <em>{operatorWorkloadLabel(operator)}</em>
              </button>
            ))}
          </div>
        </section>
      )}

      {!hasRollDispatch && (
        <section className="production-dispatch-card production-dispatch-priority-picker">
          <div className="production-dispatch-card-head">
            <div>
              <span className="eyebrow">Приоритет</span>
              <h4>
                <ix-icon name="reorder" size="16" />
                Место в очереди операторов
              </h4>
            </div>
            <div className="production-dispatch-card-head-actions">
              <span className={`production-priority-pill priority-${currentPriority.tone}`}>
                #{currentPriority.queue} · {currentPriority.label}
              </span>
              <button
                type="button"
                className={`compact-action-button ${canCommitDispatch ? 'action-recommended' : 'action-disabled'} production-dispatch-submit`}
                onClick={commitDispatch}
                disabled={!canCommitDispatch}
                title={commitTitle}
              >
                <SiemensIcon name={commitIcon} size="16" />
                <span>{commitLabel}</span>
              </button>
            </div>
          </div>
          <div className="production-priority-options">
            {productionPriorityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`production-priority-option priority-${option.tone} ${draftPriority === option.value ? 'is-selected' : ''} ${draftPriority === option.value && selectedPriority !== option.value ? 'is-draft' : ''}`}
                onClick={() => setDraftPriority(option.value)}
                aria-pressed={draftPriority === option.value}
              >
                <strong>{option.label}</strong>
                <span>Очередь #{option.queue}</span>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {hasRollDispatch && (
        <section
          className="production-dispatch-card production-roll-dispatch-card"
          aria-label="Распределение по рулонам"
        >
          <div className="production-dispatch-card-head">
            <div>
              <span className="eyebrow">
                {viewMode === 'rolls' ? 'Общая очередь' : 'По рулонам'}
              </span>
            </div>
            <span className="production-state-badge severity-info">
              {rollDispatchItems.length} строк
            </span>
          </div>
          {selectedRollIds.length > 0 && (
            <div
              className="production-roll-selection-bar"
              aria-label="Действия с выбранными рулонами"
            >
              <strong>{selectionLabel}</strong>
              <label>
                <span>Оператор</span>
                <select
                  value={bulkOperatorId}
                  onChange={(event) => updateBulkOperator(event.target.value)}
                  disabled={hasSelectedImmediateMutationPending}
                >
                  <option value="">Не выбран</option>
                  {operators.map((operator) => (
                    <option
                      key={operator.id}
                      value={operator.id}
                      disabled={operator.status === 'blocked'}
                    >
                      {operator.name}
                      {operator.status === 'blocked' ? ' · нет станка' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Приоритет</span>
                <select
                  value={bulkPriority}
                  onChange={(event) => updateBulkPriority(event.target.value)}
                  disabled={hasSelectedImmediateMutationPending}
                >
                  {productionPriorityOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`compact-action-button ${canBulkAssign ? 'action-peer' : 'action-disabled'}`}
                disabled={!canBulkAssign}
                onClick={commitBulkAssign}
                title={
                  hasSelectedImmediateMutationPending
                    ? 'Дождитесь записи выбранного рулона'
                    : canBulkAssign
                      ? 'Записать назначение для выбранных рулонов'
                      : 'Выберите оператора'
                }
              >
                <SiemensIcon name="user-management-settings-filled" size="16" />
                <span>Записать</span>
              </button>
            </div>
          )}
          <div
            className="production-roll-dispatch-table"
            role="table"
            aria-label="Рулоны, оператор и станок"
          >
            <div className="production-roll-dispatch-row is-head" role="row">
              <span role="columnheader">
                <input
                  type="checkbox"
                  checked={
                    reassignableVisibleRollIds.length > 0 &&
                    reassignableVisibleRollIds.every((id) => selectedRollSet.has(id))
                  }
                  onChange={toggleAllVisibleRolls}
                  aria-label="Выбрать все рулоны"
                  title="Выбрать все оставшиеся рулоны"
                  disabled={
                    hasSelectedImmediateMutationPending || reassignableVisibleRollIds.length === 0
                  }
                />
              </span>
              {rollDispatchColumns.map((column) => (
                <span key={column.key} role="columnheader" aria-sort={rollSortAria(column.key)}>
                  <button
                    type="button"
                    className={`production-roll-sort-button ${rollSort.key === column.key ? 'is-active' : ''}`}
                    onClick={() => toggleRollSort(column.key)}
                    aria-label={rollSortLabel(column)}
                  >
                    <span>{column.label}</span>
                    <small aria-hidden="true">
                      {rollSort.key === column.key
                        ? rollSort.direction === 'asc'
                          ? '↑'
                          : '↓'
                        : '↕'}
                    </small>
                  </button>
                </span>
              ))}
            </div>
            {visibleRollDispatchItems.map((item, index) => {
              const draftOperatorIdForRoll = dirtyStringDraftValue(
                draftOperatorByRollId,
                item.id,
                item.operatorId,
              );
              const draftMachineId = dirtyStringDraftValue(
                draftMachineByRollId,
                item.id,
                item.machineId,
              );
              const draftPriorityForRoll = dirtyStringDraftValue(
                draftPriorityByRollId,
                item.id,
                item.priority,
              );
              const draftOperatorForRoll = operatorById(draftOperatorIdForRoll);
              const isSelected = selectedRollSet.has(item.id);
              const canReassign = canReassignProductionRoll(item);
              const immediateMutationPending =
                viewMode === 'order' && pendingImmediateRollIds.has(item.id);

              return (
                <div
                  key={item.id}
                  className={`production-roll-dispatch-row status-${item.status} ${isSelected ? 'is-selected' : ''}`}
                  role="row"
                  aria-busy={immediateMutationPending}
                >
                  <span role="cell" data-label="Выбор">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRollSelection(item)}
                      aria-label={`Выбрать рулон ${item.rollId}`}
                      disabled={!canReassign || immediateMutationPending}
                    />
                  </span>
                  <span role="cell" data-label="Порядок">
                    <strong>{rollPageStart + index + 1}</strong>
                    <span
                      className="production-roll-order-buttons"
                      aria-label={`Порядок рулона ${item.rollId}`}
                    >
                      <button
                        type="button"
                        onClick={() => onMoveRollQueue?.(item.id, 'up')}
                        aria-label={`Поднять рулон ${item.rollId}`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => onMoveRollQueue?.(item.id, 'down')}
                        aria-label={`Опустить рулон ${item.rollId}`}
                      >
                        ↓
                      </button>
                    </span>
                  </span>
                  <span role="cell" data-label="Рулон">
                    <strong>#{item.sequenceNumber}</strong>
                    <small>{item.rollId}</small>
                  </span>
                  <span role="cell" data-label="Заказ">
                    <strong>{productionRollOrderLabel(item)}</strong>
                    <small>
                      {item.customerAlias === 'На запас' ? (
                        <span className="commercial-stock-badge">На запас</span>
                      ) : (
                        item.customerAlias || 'Контрагент не указан'
                      )}
                      {productionRollLineLabel(item) ? ` · ${productionRollLineLabel(item)}` : ''}
                    </small>
                  </span>
                  <span role="cell" data-label="Параметры">
                    <strong>{productionRollSpecificationLabel(item)}</strong>
                  </span>
                  <span role="cell" data-label="Оператор">
                    <select
                      aria-label={`Оператор для рулона ${item.rollId}`}
                      value={draftOperatorIdForRoll}
                      onChange={(event) => updateRollOperator(item, event.target.value)}
                      disabled={!canReassign || immediateMutationPending}
                    >
                      <option value="">Не назначен</option>
                      {operators.map((operator) => (
                        <option
                          key={operator.id}
                          value={operator.id}
                          disabled={operator.status === 'blocked'}
                        >
                          {operator.name}
                          {operator.status === 'blocked' ? ' · нет станка' : ''}
                        </option>
                      ))}
                    </select>
                    <small>
                      {draftOperatorForRoll?.workplace || item.operatorId || 'нужен исполнитель'}
                    </small>
                  </span>
                  <span role="cell" data-label="Станок">
                    <select
                      aria-label={`Станок для рулона ${item.rollId}`}
                      value={draftMachineId}
                      onChange={(event) => updateRollMachine(item, event.target.value)}
                      disabled={lockMachineToOperator || !canReassign || immediateMutationPending}
                      title={
                        lockMachineToOperator
                          ? 'Станок определяется назначением оператора на смену'
                          : undefined
                      }
                    >
                      {machineOptions.map((option) => (
                        <option key={option.value || 'empty'} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <small>{productionMachineAssignmentLabel(item, draftMachineId)}</small>
                  </span>
                  <span role="cell" data-label="Приоритет">
                    <select
                      aria-label={`Приоритет для рулона ${item.rollId}`}
                      value={draftPriorityForRoll}
                      onChange={(event) => updateRollPriority(item, event.target.value)}
                      disabled={!canReassign || immediateMutationPending}
                    >
                      {productionPriorityOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <small>очередь рулона</small>
                  </span>
                </div>
              );
            })}
          </div>
          {viewMode === 'rolls' && rollPageCount > 1 ? (
            <nav className="production-roll-dispatch-pagination" aria-label="Страницы рулонов">
              <button
                type="button"
                aria-label="Предыдущая страница рулонов"
                disabled={resolvedRollPage === 0}
                onClick={() => setRollPage((current) => Math.max(0, current - 1))}
              >
                Назад
              </button>
              <span>
                Страница {resolvedRollPage + 1} из {rollPageCount}
              </span>
              <button
                type="button"
                aria-label="Следующая страница рулонов"
                disabled={resolvedRollPage === rollPageCount - 1}
                onClick={() => setRollPage((current) => Math.min(rollPageCount - 1, current + 1))}
              >
                Далее
              </button>
            </nav>
          ) : null}
        </section>
      )}
    </div>
  );
}

export function ProductionOperatorLoadSurface({
  rollDispatchItems,
  operators = productionOperators,
}: {
  rollDispatchItems: ProductionRollDispatchItem[];
  /** Live-режим: реальные операторы смены вместо demo-каталога. */
  operators?: ProductionOperator[];
}) {
  const [expandedOperatorIds, setExpandedOperatorIds] = useState<string[]>([]);
  const [operatorDetailView, setOperatorDetailView] = useState<OperatorDetailView>('orders');
  const sortedRolls = useMemo(
    () => sortProductionRolls(rollDispatchItems, 'manual'),
    [rollDispatchItems],
  );
  const workloadRows = useMemo(
    () => operatorWorkloadsFromDispatch(sortedRolls, operators),
    [operators, sortedRolls],
  );
  const assignedRollsForSummary = sortedRolls.filter((item) => item.operatorId);
  const assignedRollCount = assignedRollsForSummary.length;
  const assignedWeightKg = productionRollPlannedWeightTotal(assignedRollsForSummary);
  const overloadedCount = workloadRows.filter(
    (workload) => workload.loadState === 'overloaded' || workload.loadState === 'blocked',
  ).length;
  const assignedLoadSummary =
    assignedRollCount > 0
      ? `${assignedRollCount} рул. · ${assignedWeightKg === undefined ? 'план не указан' : `${assignedWeightKg} кг`}`
      : 'нет назначений';

  useEffect(() => {
    setExpandedOperatorIds((current) => {
      const validOperatorIds = new Set(workloadRows.map((workload) => workload.operatorId));
      const retainedOperatorIds = current.filter((operatorId) => validOperatorIds.has(operatorId));
      return retainedOperatorIds.length === current.length ? current : retainedOperatorIds;
    });
  }, [workloadRows]);

  function toggleOperatorDetails(operatorId: string) {
    setExpandedOperatorIds((current) =>
      current.includes(operatorId)
        ? current.filter((currentOperatorId) => currentOperatorId !== operatorId)
        : [...current, operatorId],
    );
  }

  return (
    <section
      className="surface production-workbench production-operator-load-surface severity-info"
      aria-label="Операторы и загрузка смены"
    >
      <header className="production-workbench-header">
        <div>
          <span className="eyebrow">Зав. производства</span>
          <h3>Операторы / загрузка</h3>
        </div>
        <span
          className={`production-state-badge severity-${overloadedCount > 0 ? 'warning' : 'info'}`}
        >
          {overloadedCount > 0 ? `${overloadedCount} перегруз` : `${workloadRows.length} исполн.`}
        </span>
      </header>

      <section
        className="production-dispatch-card production-operator-load-card"
        aria-label="Загрузка операторов смены"
      >
        <div className="production-dispatch-card-head">
          <div>
            <span className="eyebrow">Смена</span>
            <small className="production-operator-load-head-note">{assignedLoadSummary}</small>
          </div>
          <span className="production-state-badge severity-info">
            {workloadRows.length} исполн.
          </span>
        </div>
        <div
          className="production-operator-load-table"
          role="table"
          aria-label="Операторы и назначенные рулоны"
        >
          <div className="production-operator-load-row is-head" role="row">
            <span role="columnheader">Оператор</span>
            <span role="columnheader">Станок</span>
            <span role="columnheader">Рулоны</span>
            <span role="columnheader">Вес</span>
            <span role="columnheader">План</span>
            <span role="columnheader">Можно еще</span>
          </div>
          {workloadRows.map((workload) => {
            const operator =
              operators.find((item) => item.id === workload.operatorId) ??
              demoOperatorById(workload.operatorId);
            const assignedRolls = sortedRolls.filter(
              (item) => item.operatorId === workload.operatorId,
            );
            const isExpanded = expandedOperatorIds.includes(workload.operatorId);
            const stateTone =
              workload.loadState === 'overloaded' || workload.loadState === 'blocked'
                ? 'critical'
                : workload.loadState === 'near_limit'
                  ? 'warning'
                  : 'info';
            const visibleRolls = assignedRolls
              .slice(0, 4)
              .map((item) => `${item.rollId} · ${item.orderId}`)
              .join('\n');
            const hiddenRollCount = Math.max(0, assignedRolls.length - 4);
            const orderGroups = operatorOrderDetailGroups(assignedRolls);
            const detailId = `operator-load-detail-${encodeURIComponent(workload.operatorId)}`;
            const capacityTitle = workload.capacityKnown
              ? `Можно еще = floor(${workload.availableCapacityMinutes} мин / ${workload.averageRollMinutes} мин)`
              : 'Индивидуальная смена без временного лимита';
            return (
              <div key={workload.operatorId} className="production-operator-load-block">
                <div
                  className={`production-operator-load-row state-${workload.loadState}${isExpanded ? ' is-expanded' : ''}`}
                  role="row"
                >
                  <span role="cell" data-label="Оператор">
                    <button
                      type="button"
                      className="production-operator-load-disclosure"
                      aria-expanded={isExpanded}
                      aria-controls={detailId}
                      aria-label={`${isExpanded ? 'Скрыть' : 'Показать'} загрузку: ${workload.operatorLabel}`}
                      onClick={() => toggleOperatorDetails(workload.operatorId)}
                    >
                      <span className="production-operator-load-caret" aria-hidden="true">
                        {isExpanded ? '-' : '+'}
                      </span>
                      <strong>{workload.operatorLabel}</strong>
                    </button>
                    <small>{operator?.shift ?? 'смена'}</small>
                  </span>
                  <span role="cell" data-label="Станок">
                    <strong>
                      {workload.defaultMachineLabel ?? operatorDefaultMachineLabel(operator)}
                    </strong>
                    <small>По умолчанию</small>
                  </span>
                  <span role="cell" data-label="Рулоны">
                    <strong>{workload.assignedRollCount}</strong>
                    <small className="production-operator-load-roll-list">
                      {visibleRolls
                        ? `${visibleRolls}${hiddenRollCount > 0 ? `\n+${hiddenRollCount}` : ''}`
                        : 'нет назначений'}
                    </small>
                  </span>
                  <span role="cell" data-label="Вес">
                    <strong>
                      {workload.plannedWeightKg === undefined
                        ? 'План не указан'
                        : `${workload.plannedWeightKg} кг`}
                    </strong>
                    <small>{workload.plannedMeterageMeters} м</small>
                  </span>
                  <span role="cell" data-label="План">
                    <strong>
                      {workload.capacityKnown
                        ? formatMinutes(workload.estimatedMinutesTotal)
                        : `${workload.assignedRollCount} рул.`}
                    </strong>
                    <small>
                      {workload.capacityKnown
                        ? `остаток ${formatMinutes(workload.availableCapacityMinutes)}`
                        : 'без лимита времени'}
                    </small>
                  </span>
                  <span role="cell" data-label="Можно еще" title={capacityTitle}>
                    <strong className={`production-workload-pill severity-${stateTone}`}>
                      {workload.capacityKnown
                        ? `${Math.max(0, workload.canAcceptRollCount)} рул.`
                        : 'По очереди'}
                    </strong>
                    <small>
                      {workload.capacityKnown
                        ? workloadStateLabel(workload.loadState)
                        : 'по текущей очереди'}
                    </small>
                  </span>
                </div>
                {isExpanded && (
                  <div id={detailId} className="production-operator-load-detail" role="row">
                    <div className="production-operator-load-detail-inner" role="cell">
                      <header className="production-operator-load-detail-head">
                        <div
                          className="production-operator-load-capacity-strip"
                          aria-label={`Расчет емкости ${workload.operatorLabel}`}
                        >
                          {workload.capacityKnown ? (
                            <>
                              <span>
                                <strong>{formatMinutes(workload.availableCapacityMinutes)}</strong>
                                <small>свободно</small>
                              </span>
                              <span>
                                <strong>{workload.averageRollMinutes} мин</strong>
                                <small>на рулон</small>
                              </span>
                              <span title={capacityTitle}>
                                <strong>{Math.max(0, workload.canAcceptRollCount)} рул.</strong>
                                <small>можно еще</small>
                              </span>
                              {workload.overCapacityMinutes > 0 && (
                                <span className="severity-critical">
                                  <strong>{formatMinutes(workload.overCapacityMinutes)}</strong>
                                  <small>перегруз</small>
                                </span>
                              )}
                            </>
                          ) : (
                            <span>
                              <strong>{workload.assignedRollCount} рул.</strong>
                              <small>очередь без расчёта времени</small>
                            </span>
                          )}
                        </div>
                        <div
                          className="production-operator-load-view-toggle"
                          role="tablist"
                          aria-label="Вид назначений оператора"
                        >
                          <button
                            type="button"
                            role="tab"
                            className={operatorDetailView === 'orders' ? 'is-active' : ''}
                            aria-selected={operatorDetailView === 'orders'}
                            onClick={() => setOperatorDetailView('orders')}
                          >
                            По заказам
                          </button>
                          <button
                            type="button"
                            role="tab"
                            className={operatorDetailView === 'queue' ? 'is-active' : ''}
                            aria-selected={operatorDetailView === 'queue'}
                            onClick={() => setOperatorDetailView('queue')}
                          >
                            По очереди
                          </button>
                        </div>
                      </header>

                      {assignedRolls.length === 0 ? (
                        <div className="production-operator-load-empty">Назначений нет</div>
                      ) : operatorDetailView === 'orders' ? (
                        <div
                          className="production-operator-load-detail-table is-orders"
                          role="table"
                          aria-label={`Заказы ${workload.operatorLabel}`}
                        >
                          <div className="production-operator-load-detail-row is-head" role="row">
                            <span role="columnheader">Заказ</span>
                            <span role="columnheader">Рулоны</span>
                            <span role="columnheader">Вес</span>
                            <span role="columnheader">План</span>
                            <span role="columnheader">Блокеры</span>
                          </div>
                          {orderGroups.map((group) => (
                            <div
                              key={group.orderId}
                              className="production-operator-load-detail-row"
                              role="row"
                            >
                              <span role="cell" data-label="Заказ">
                                <strong>{group.orderNumber}</strong>
                                <small>{group.customerAlias}</small>
                              </span>
                              <span role="cell" data-label="Рулоны">
                                <strong>{group.rollCount} рул.</strong>
                                <small>ближайший {group.nextRoll.rollId}</small>
                              </span>
                              <span role="cell" data-label="Вес">
                                <strong>
                                  {group.plannedWeightKg === undefined
                                    ? 'План не указан'
                                    : `${group.plannedWeightKg} кг`}
                                </strong>
                              </span>
                              <span role="cell" data-label="План">
                                <strong>{formatMinutes(group.estimatedMinutesTotal)}</strong>
                              </span>
                              <span role="cell" data-label="Блокеры">
                                <strong>
                                  {group.blockers.length > 0
                                    ? `${group.blockers.length} блок.`
                                    : 'нет'}
                                </strong>
                                {group.blockers.length > 0 && (
                                  <small>
                                    {group.blockers
                                      .map((roll) => roll.blocker ?? roll.rollId)
                                      .join(', ')}
                                  </small>
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div
                          className="production-operator-load-detail-table is-queue"
                          role="table"
                          aria-label={`Очередь ${workload.operatorLabel}`}
                        >
                          <div className="production-operator-load-detail-row is-head" role="row">
                            <span role="columnheader">#</span>
                            <span role="columnheader">Рулон</span>
                            <span role="columnheader">Заказ</span>
                            <span role="columnheader">Станок</span>
                            <span role="columnheader">Приоритет</span>
                            <span role="columnheader">Статус</span>
                            <span role="columnheader">Вес</span>
                            <span role="columnheader">План</span>
                          </div>
                          {assignedRolls.map((roll, index) => (
                            <div
                              key={roll.id}
                              className="production-operator-load-detail-row"
                              role="row"
                            >
                              <span role="cell" data-label="#">
                                <strong>{index + 1}</strong>
                              </span>
                              <span role="cell" data-label="Рулон">
                                <strong>{roll.rollId}</strong>
                              </span>
                              <span role="cell" data-label="Заказ">
                                <strong>{productionRollOrderNumber(roll)}</strong>
                                <small>{roll.customerAlias}</small>
                              </span>
                              <span role="cell" data-label="Станок">
                                <strong>{roll.machineLabel}</strong>
                              </span>
                              <span role="cell" data-label="Приоритет">
                                <strong>{roll.priority}</strong>
                              </span>
                              <span role="cell" data-label="Статус">
                                <strong>{productionRollDispatchStatusLabel(roll.status)}</strong>
                              </span>
                              <span role="cell" data-label="Вес">
                                <strong>
                                  {roll.plannedNetKg === undefined
                                    ? 'План не указан'
                                    : `${roll.plannedNetKg} кг`}
                                </strong>
                              </span>
                              <span role="cell" data-label="План">
                                <strong>{formatMinutes(roll.estimatedMinutes ?? 0)}</strong>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}
