import { auditEntry, stampNow, updateFactList } from './prototypeRuntime';
import { rawMaterialStocks as defaultRawMaterialStocks } from './inventoryContracts';
import { runtimeId } from './runtimeId';
import type { InventoryMutation, InventoryMutationKind, RawMaterialStock, WarehouseInventoryCategory, WarehouseInventoryOverride, WarehouseStockMutationDraft, WorkObject } from './types';

export function warehouseRecheckTaskIdFromAction(actionId: string) {
  return actionId.slice('warehouse-cover-recheck-complete:'.length);
}

export function completeWarehouseRecheckTask(object: WorkObject, actionId: string): WorkObject {
  return {
    ...object,
    statusLabel: 'Перепроверка завершена',
    severity: 'info',
    filterTags: Array.from(new Set([...(object.filterTags ?? []).filter((tag) => tag !== 'Требуют действия' && tag !== 'С проблемами'), 'Запасы / резерв', 'Закрытые'])),
    facts: updateFactList(object.facts, { Результат: 'Покрытие перепроверено; итог возвращен коммерции' }, 'warehouse'),
    actions: object.actions.map((item) => item.id === actionId
      ? {
          ...item,
          label: 'Перепроверка завершена',
          level: 'disabled' as const,
          enabled: false,
          disabledReason: 'Итог уже возвращен коммерции',
          recoveryOwner: 'Коммерция',
          recoveryAction: 'Открыть результат перепроверки',
        }
      : item),
    problems: object.problems.map((problem) => ({ ...problem, status: 'resolved' as const })),
    audit: [
      auditEntry(object.id, 'Склад', 'audit:warehouse_recheck_resolved', 'Склад перепроверил остатки и вернул итог коммерции; производство не получало raw dispute.'),
      ...object.audit,
    ],
  };
}

export function applyCommercialWarehouseRecheckResult(object: WorkObject, taskId: string): WorkObject {
  return {
    ...object,
    severity: 'warning',
    facts: updateFactList(
      object.facts,
      {
        Склад: 'Перепроверка завершена',
        Производство: 'Ждет финальное решение коммерции',
      },
      'commercial'
    ),
    actions: object.actions.map((item) => item.id === 'commercial-open-warehouse-resolution' || item.id === 'commercial-reject-warehouse-cover'
      ? {
          ...item,
          label: item.id === 'commercial-open-warehouse-resolution' ? 'Открыть результат перепроверки' : item.label,
          level: item.id === 'commercial-open-warehouse-resolution' ? 'recommended' as const : item.level,
          enabled: true,
          disabledReason: undefined,
          recoveryOwner: undefined,
          recoveryAction: undefined,
        }
      : item),
    orderResolutionCases: object.orderResolutionCases?.map((resolutionCase) =>
      resolutionCase.warehouseCoverResolution?.warehouseRecheckTaskId === taskId
        ? {
            ...resolutionCase,
            status: 'resolved' as const,
            ownerRole: 'commercial' as const,
            nextOwnerRole: 'commercial' as const,
            resolvedAt: stampNow(),
          }
        : resolutionCase
    ),
    audit: [
      auditEntry(object.id, 'Склад', 'notification:warehouse_recheck_resolved', 'Склад вернул итог перепроверки покрытия; коммерция снова владелец решения.'),
      ...object.audit,
    ],
  };
}

export function recordWarehouseReserveOpened(object: WorkObject, targetId: string): WorkObject {
  return {
    ...object,
    audit: [
      auditEntry(object.id, 'Склад', 'audit:warehouse_reserve_opened', `Показан резерв: ${targetId}.`),
      ...object.audit,
    ],
  };
}

export function recordWarehouseReserveReleased(object: WorkObject, targetId: string): WorkObject {
  return {
    ...object,
    audit: [
      auditEntry(object.id, 'Склад', 'audit:warehouse_reserve_released', `Рулоны освобождены из резерва: ${targetId}.`),
      ...object.audit,
    ],
  };
}

export type WarehouseStockMutationResult = {
  object: WorkObject;
  applied: boolean;
  title: string;
  detail: string;
  tone: 'success' | 'warning';
};

function cloneDefaultStocks() {
  return defaultRawMaterialStocks.map((stock) => ({ ...stock }));
}

function runtimeStocks(object: WorkObject) {
  return (object.rawMaterialStocks ?? cloneDefaultStocks()).map((stock) => ({ ...stock }));
}

function sameMaterial(left: string, right: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
  return normalize(left) === normalize(right);
}

function formatQty(value: number, unit: string) {
  return `${Number(value.toFixed(1)).toLocaleString('ru-RU')} ${unit}`;
}

function mutationLabel(kind: InventoryMutationKind) {
  const labels: Record<InventoryMutationKind, string> = {
    create: 'Новая позиция сырья',
    edit: 'Правка позиции сырья',
    receive: 'Приемка сырья',
    write_off: 'Списание сырья',
    reserve: 'Резерв сырья',
    release_reserve: 'Снятие резерва',
    correction: 'Инвентаризационная корректировка',
  };
  return labels[kind];
}

function categoryLabel(category: WarehouseInventoryCategory) {
  const labels: Record<WarehouseInventoryCategory, string> = {
    raw: 'сырье',
    rolls: 'рулон',
    reserve: 'резерв',
    consumables: 'расходник',
    movements: 'движение',
  };
  return labels[category];
}

function categoryStatus(category: WarehouseInventoryCategory, kind: InventoryMutationKind) {
  if (kind === 'receive') return category === 'movements' ? 'Движение записано' : 'Приход записан';
  if (kind === 'create') return 'Ручная позиция';
  return 'Ручная корректировка';
}

function genericAuditLabel(kind: InventoryMutationKind) {
  if (kind === 'create') return 'audit:warehouse_inventory_position_created';
  if (kind === 'edit') return 'audit:warehouse_inventory_position_updated';
  return 'audit:warehouse_inventory_position_updated';
}

function auditLabel(kind: InventoryMutationKind) {
  const labels: Record<InventoryMutationKind, string> = {
    create: 'audit:raw_material_position_created',
    edit: 'audit:raw_material_position_updated',
    receive: 'audit:material_received',
    write_off: 'audit:raw_material_usage_recorded',
    reserve: 'audit:raw_material_reserved_for_order',
    release_reserve: 'audit:raw_material_reserve_released',
    correction: 'audit:raw_material_stock_adjusted',
  };
  return labels[kind];
}

function currentReservedQty(object: WorkObject, materialId: string) {
  const mutations = (object.inventoryMutations ?? [])
    .filter((mutation) => sameMaterial(mutation.materialId, materialId) && !mutation.blocked);
  const reserved = mutations
    .filter((mutation) => mutation.kind === 'reserve')
    .reduce((sum, mutation) => sum + Math.abs(mutation.deltaQty), 0);
  const released = mutations
    .filter((mutation) => mutation.kind === 'release_reserve')
    .reduce((sum, mutation) => sum + Math.abs(mutation.deltaQty), 0);
  return Math.max(0, reserved - released);
}

function blockedMutationResult(object: WorkObject, stock: RawMaterialStock | undefined, draft: WarehouseStockMutationDraft, reason: string, recovery: string): WarehouseStockMutationResult {
  const materialLabel = stock?.label ?? draft.materialId;
  const mutation: InventoryMutation = {
    id: runtimeId('INV-BLOCK'),
    materialId: stock?.rawMaterialId ?? draft.materialId,
    materialLabel,
    kind: draft.kind,
    oldQty: stock?.actualQty ?? 0,
    deltaQty: 0,
    newQty: stock?.actualQty ?? 0,
    unit: stock?.unit ?? 'кг',
    reason,
    actorRole: 'warehouse',
    actorLabel: 'Склад',
    createdAt: stampNow(),
    source: 'manual_platform',
    linkedOrderId: draft.linkedOrderId,
    blocked: true,
    recovery,
  };
  const problem = {
    id: runtimeId(`p-${object.id}-inventory`),
    objectId: object.id,
    stage: object.statusLabel,
    title: 'Изменение остатка заблокировано',
    severity: 'warning' as const,
    ownerRole: 'Склад',
    due: 'до изменения остатка',
    reason,
    recovery,
    status: 'open' as const,
  };

  return {
    object: {
      ...object,
      severity: object.severity === 'critical' ? object.severity : 'warning',
      filterTags: Array.from(new Set([...(object.filterTags ?? []), 'С проблемами'])),
      inventoryMutations: [mutation, ...(object.inventoryMutations ?? [])],
      problems: [problem, ...object.problems],
      audit: [
        {
          ...auditEntry(object.id, 'Склад', 'problem:inventory_mutation_blocked', `${reason} Восстановление: ${recovery}.`),
          reason,
          oldValue: formatQty(mutation.oldQty, mutation.unit),
          newValue: formatQty(mutation.newQty, mutation.unit),
          sourceSnapshot: mutation.materialId,
          scope: 'warehouse' as const,
        },
        ...object.audit,
      ],
    },
    applied: false,
    title: 'Остаток не изменен',
    detail: recovery,
    tone: 'warning',
  };
}

export function applyWarehouseStockMutation(object: WorkObject, draft: WarehouseStockMutationDraft): WarehouseStockMutationResult {
  const reason = draft.reason.trim();
  const qty = Number(draft.qty);
  const weightKg = Number(draft.weightKg);
  const materialId = (draft.materialId || draft.label || '').trim();
  const label = (draft.label || draft.materialId).trim();
  const unit = (draft.unit || 'кг').trim();
  const stocks = runtimeStocks(object);
  const stock = stocks.find((item) => sameMaterial(item.rawMaterialId, materialId) || sameMaterial(item.id, materialId) || sameMaterial(item.label, materialId));

  if (draft.kind === 'create') {
    if (!label || !materialId) {
      return blockedMutationResult(object, undefined, draft, 'Название сырья обязательно.', 'Заполнить материал или марку сырья.');
    }
    if (stock) {
      return blockedMutationResult(object, stock, draft, `Похоже, позиция ${stock.label} уже есть на складе.`, 'Использовать существующую строку или создать отдельную позицию с другой маркой.');
    }
    if (!reason) {
      return blockedMutationResult(object, undefined, draft, 'Причина создания позиции обязательна.', 'Записать основание ручного добавления сырья.');
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return blockedMutationResult(object, undefined, draft, 'Количество должно быть больше нуля.', 'Ввести фактическое количество новой складской позиции.');
    }
    if (!unit) {
      return blockedMutationResult(object, undefined, draft, 'Единица измерения обязательна.', 'Выбрать кг, т, мешки, биг-бег или штуки.');
    }
    const nextStock: RawMaterialStock = {
      id: runtimeId('RAW-MANUAL'),
      rawMaterialId: materialId,
      label,
      materialKind: draft.materialKind ?? 'primary',
      qty,
      actualQty: qty,
      unit,
      packageQty: draft.packageQty?.trim() || undefined,
      source: 'manual_platform',
      sourceOfTruthStatus: 'ручная корректировка',
      updatedAt: stampNow(),
      warehouseZone: draft.warehouseZone?.trim() || 'Основной склад сырья',
      updatedByRole: 'warehouse',
    };
    const mutation: InventoryMutation = {
      id: runtimeId('INV'),
      materialId: nextStock.rawMaterialId,
      materialLabel: nextStock.label,
      kind: draft.kind,
      oldQty: 0,
      deltaQty: qty,
      newQty: qty,
      unit: nextStock.unit,
      reason,
      actorRole: 'warehouse',
      actorLabel: 'Склад',
      createdAt: stampNow(),
      source: 'manual_platform',
      linkedOrderId: draft.linkedOrderId?.trim() || undefined,
    };
    return {
      object: {
        ...object,
        rawMaterialStocks: [nextStock, ...stocks],
        inventoryMutations: [mutation, ...(object.inventoryMutations ?? [])],
        facts: updateFactList(
          object.facts,
          {
            'Фактическое сырье': `${nextStock.label}: ${formatQty(qty, nextStock.unit)} · ручной учет склада`,
            'Последняя корректировка': `${mutationLabel(draft.kind)} · ${nextStock.label}`,
          },
          'warehouse'
        ),
        audit: [
          {
            ...auditEntry(nextStock.rawMaterialId, 'Склад', auditLabel(draft.kind), `${mutationLabel(draft.kind)}: ${formatQty(qty, nextStock.unit)}. Причина: ${reason}.`),
            reason,
            oldValue: 'нет позиции',
            newValue: `${nextStock.label}: ${formatQty(qty, nextStock.unit)}`,
            sourceSnapshot: nextStock.rawMaterialId,
            scope: 'warehouse' as const,
          },
          ...object.audit,
        ],
      },
      applied: true,
      title: 'Позиция создана',
      detail: `${nextStock.label}: ${formatQty(qty, nextStock.unit)}.`,
      tone: 'success',
    };
  }

  if (!stock) {
    return blockedMutationResult(object, undefined, draft, `Материал ${materialId} не найден в складской витрине.`, 'Выбрать строку сырья из текущего списка или создать новую позицию.');
  }
  if (!reason) {
    return blockedMutationResult(object, stock, draft, 'Причина изменения остатка обязательна.', 'Записать причину пересчета, приемки, списания или резерва.');
  }
  if (!Number.isFinite(qty) || (draft.kind === 'correction' || draft.kind === 'edit' ? qty < 0 : qty <= 0)) {
    const zeroAllowed = draft.kind === 'correction' || draft.kind === 'edit';
    return blockedMutationResult(
      object,
      stock,
      draft,
      zeroAllowed ? 'Количество не может быть отрицательным.' : 'Количество должно быть больше нуля.',
      zeroAllowed ? 'Ввести ноль или положительное новое значение остатка.' : 'Ввести положительное количество.'
    );
  }

  const reservedQty = currentReservedQty(object, stock.rawMaterialId);
  const availableQty = Math.max(0, stock.actualQty - reservedQty);
  if ((draft.kind === 'write_off' || draft.kind === 'reserve') && qty > availableQty) {
    return blockedMutationResult(
      object,
      stock,
      draft,
      `${mutationLabel(draft.kind)} больше доступного остатка: нужно ${formatQty(qty, stock.unit)}, доступно ${formatQty(availableQty, stock.unit)}.`,
      'Уменьшить количество, принять сырье или оформить дефицит.'
    );
  }
  if (draft.kind === 'release_reserve' && qty > reservedQty) {
    return blockedMutationResult(
      object,
      stock,
      draft,
      `Нельзя снять больше резерва, чем закреплено: запрос ${formatQty(qty, stock.unit)}, резерв ${formatQty(reservedQty, stock.unit)}.`,
      'Проверить заказ или выбрать меньшее количество для снятия резерва.'
    );
  }

  const oldQty = stock.actualQty;
  const deltaQty = draft.kind === 'receive'
    ? qty
    : draft.kind === 'write_off'
      ? -qty
      : draft.kind === 'correction' || draft.kind === 'edit'
        ? qty - oldQty
        : 0;
  const newQty = draft.kind === 'correction' || draft.kind === 'edit' ? qty : oldQty + deltaQty;
  const nextSource: RawMaterialStock['source'] = draft.kind === 'receive' ? 'warehouse_fact' : 'manual_platform';
  const hasReferenceConflict = stock.referenceQty !== undefined && stock.referenceQty !== newQty;
  const nextStatus: RawMaterialStock['sourceOfTruthStatus'] = hasReferenceConflict
    ? 'расхождение с 1С'
    : draft.kind === 'correction' || draft.kind === 'edit'
      ? 'ручная корректировка'
      : 'актуально';
  const nextStock: RawMaterialStock = {
    ...stock,
    rawMaterialId: draft.kind === 'edit' ? materialId || stock.rawMaterialId : stock.rawMaterialId,
    label: draft.kind === 'edit' ? label || stock.label : stock.label,
    materialKind: draft.kind === 'edit' ? draft.materialKind ?? stock.materialKind : stock.materialKind,
    qty: newQty,
    actualQty: newQty,
    unit: draft.kind === 'edit' ? unit || stock.unit : stock.unit,
    packageQty: draft.kind === 'edit' ? draft.packageQty?.trim() || undefined : stock.packageQty,
    warehouseZone: draft.kind === 'edit' ? draft.warehouseZone?.trim() || stock.warehouseZone : stock.warehouseZone,
    source: nextSource,
    sourceOfTruthStatus: nextStatus,
    updatedAt: stampNow(),
    updatedByRole: 'warehouse',
  };
  const mutation: InventoryMutation = {
    id: runtimeId('INV'),
    materialId: nextStock.rawMaterialId,
    materialLabel: nextStock.label,
    kind: draft.kind,
    oldQty,
    deltaQty: draft.kind === 'reserve' || draft.kind === 'release_reserve' ? qty : deltaQty,
    newQty,
    unit: nextStock.unit,
    reason,
    actorRole: 'warehouse',
    actorLabel: 'Склад',
    createdAt: stampNow(),
    source: nextSource === 'warehouse_fact' ? 'warehouse_fact' : 'manual_platform',
    linkedOrderId: draft.linkedOrderId?.trim() || undefined,
  };
  const nextStocks = stocks.map((item) => item.id === stock.id ? nextStock : item);
  const eventLabel = auditLabel(draft.kind);
  const operationDetail = draft.kind === 'reserve'
    ? `Зарезервировано ${formatQty(qty, stock.unit)}.`
    : draft.kind === 'release_reserve'
      ? `Снят резерв ${formatQty(qty, stock.unit)}.`
      : draft.kind === 'edit'
        ? `${mutationLabel(draft.kind)}: ${stock.label}, ${formatQty(oldQty, stock.unit)} -> ${nextStock.label}, ${formatQty(newQty, nextStock.unit)}.`
        : `${mutationLabel(draft.kind)}: ${formatQty(oldQty, stock.unit)} -> ${formatQty(newQty, stock.unit)}.`;

  return {
    object: {
      ...object,
      rawMaterialStocks: nextStocks,
      inventoryMutations: [mutation, ...(object.inventoryMutations ?? [])],
      facts: updateFactList(
        object.facts,
        {
          'Фактическое сырье': `${nextStock.label}: ${formatQty(newQty, nextStock.unit)} · ${nextSource === 'warehouse_fact' ? 'складской факт' : 'ручной учет склада'}`,
          'Последняя приемка': draft.kind === 'receive' ? `${nextStock.label}: +${formatQty(qty, nextStock.unit)}` : object.facts.find((fact) => fact.label === 'Последняя приемка')?.value ?? 'Нет',
          'Последняя корректировка': `${mutationLabel(draft.kind)} · ${nextStock.label}`,
        },
        'warehouse'
      ),
      audit: [
        {
          ...auditEntry(nextStock.rawMaterialId, 'Склад', eventLabel, `${operationDetail} Причина: ${reason}.`),
          reason,
          oldValue: formatQty(oldQty, stock.unit),
          newValue: draft.kind === 'reserve'
            ? `резерв +${formatQty(qty, stock.unit)}`
            : draft.kind === 'release_reserve'
              ? `резерв -${formatQty(qty, stock.unit)}`
              : draft.kind === 'write_off'
                ? `-${formatQty(qty, stock.unit)}`
                : draft.kind === 'edit'
                  ? `${nextStock.label}: ${formatQty(newQty, nextStock.unit)}`
                  : formatQty(newQty, stock.unit),
          sourceSnapshot: stock.referenceSnapshotId ?? nextStock.rawMaterialId,
          scope: 'warehouse' as const,
        },
        ...(hasReferenceConflict ? [{
          ...auditEntry(stock.rawMaterialId, 'Склад', 'audit:inventory_fact_overrode_accounting_snapshot', `Складской факт ${formatQty(newQty, stock.unit)} отличается от учетного снимка ${formatQty(stock.referenceQty ?? 0, stock.unit)}; факт склада оставлен рабочим.`),
          oldValue: stock.referenceQty !== undefined ? formatQty(stock.referenceQty, stock.unit) : undefined,
          newValue: formatQty(newQty, stock.unit),
          sourceSnapshot: stock.referenceSnapshotId ?? stock.rawMaterialId,
          scope: 'warehouse' as const,
        }] : []),
        ...object.audit,
      ],
    },
    applied: true,
    title: draft.kind === 'edit' ? 'Позиция обновлена' : `${mutationLabel(draft.kind)} записана`,
    detail: `${nextStock.label}: ${draft.kind === 'reserve' || draft.kind === 'release_reserve' ? formatQty(qty, stock.unit) : `${formatQty(oldQty, stock.unit)} -> ${formatQty(newQty, nextStock.unit)}`}.`,
    tone: 'success',
  };
}

export function applyWarehouseInventoryMutation(object: WorkObject, draft: WarehouseStockMutationDraft): WarehouseStockMutationResult {
  const category = draft.category ?? 'raw';
  if (category === 'raw') return applyWarehouseStockMutation(object, draft);

  const reason = draft.reason.trim();
  const qty = Number(draft.qty);
  const weightKg = Number(draft.weightKg);
  const label = (draft.label || draft.materialId).trim();
  const rowId = (draft.materialId || label).trim();
  const overrides = object.warehouseInventoryOverrides ?? [];
  const existing = overrides.find((row) => row.id === rowId);
  const unit = (existing?.unit || draft.unit || 'шт').trim();

  if (!label || !rowId) {
    return blockedMutationResult(object, undefined, draft, 'Название позиции обязательно.', 'Заполнить позицию склада.');
  }
  if (!reason) {
    return blockedMutationResult(object, undefined, draft, 'Причина изменения обязательна.', 'Записать основание ручного изменения.');
  }
  if (!Number.isFinite(qty) || (draft.kind === 'edit' || draft.kind === 'correction' ? qty < 0 : qty <= 0)) {
    const zeroAllowed = draft.kind === 'edit' || draft.kind === 'correction';
    return blockedMutationResult(
      object,
      undefined,
      draft,
      zeroAllowed ? 'Количество не может быть отрицательным.' : 'Количество должно быть больше нуля.',
      zeroAllowed ? 'Ввести ноль или положительное значение.' : 'Ввести положительное количество.'
    );
  }
  if (category === 'rolls' && (!Number.isInteger(qty) || !Number.isFinite(weightKg) || weightKg <= 0)) {
    return blockedMutationResult(object, undefined, draft, 'Укажите целое количество рулонов и вес больше нуля.', 'Проверить количество рулонов и вес в кг.');
  }
  if (draft.kind === 'create' && existing) {
    return blockedMutationResult(object, undefined, draft, `Позиция ${existing.title} уже есть на складе.`, 'Использовать правку существующей строки.');
  }

  const oldQty = existing?.actualQty ?? 0;
  const nextQty = draft.kind === 'receive' ? oldQty + qty : qty;
  const nextWeightKg = category === 'rolls'
    ? draft.kind === 'receive' ? (existing?.weightKg ?? 0) + weightKg : weightKg
    : existing?.weightKg;
  const source: WarehouseInventoryOverride['source'] = draft.kind === 'receive' ? 'warehouse_fact' : 'manual_platform';
  const nextOverride: WarehouseInventoryOverride = {
    id: existing?.id ?? rowId,
    category,
    title: label,
    subtitle: draft.subtitle?.trim() || existing?.subtitle || categoryLabel(category),
    characteristic: draft.characteristic?.trim() || existing?.characteristic,
    characteristicDetail: draft.characteristicDetail?.trim() || existing?.characteristicDetail,
    actualQty: nextQty,
    weightKg: nextWeightKg,
    unit,
    secondaryQty: category === 'rolls' ? `${nextWeightKg} кг` : draft.kind === 'receive' && existing ? existing.secondaryQty : draft.packageQty?.trim() || existing?.secondaryQty,
    status: categoryStatus(category, draft.kind),
    source,
    severity: draft.kind === 'receive' ? 'info' : 'warning',
    packageQty: draft.packageQty?.trim() || existing?.packageQty,
    warehouseZone: draft.warehouseZone?.trim() || existing?.warehouseZone || 'Основной склад',
    linkedOrderId: draft.linkedOrderId?.trim() || existing?.linkedOrderId,
    documentRef: draft.documentRef?.trim() || existing?.documentRef,
    comment: draft.comment?.trim() || existing?.comment,
    reason,
    updatedAt: stampNow(),
    updatedByRole: 'warehouse',
  };
  const mutation: InventoryMutation = {
    id: runtimeId('INV'),
    materialId: nextOverride.id,
    materialLabel: nextOverride.title,
    kind: draft.kind,
    oldQty,
    deltaQty: draft.kind === 'receive' ? qty : nextQty - oldQty,
    newQty: nextQty,
    unit,
    reason,
    actorRole: 'warehouse',
    actorLabel: 'Склад',
    createdAt: stampNow(),
    source,
    linkedOrderId: draft.linkedOrderId?.trim() || undefined,
  };
  const nextOverrides = existing
    ? overrides.map((row) => row.id === existing.id ? nextOverride : row)
    : [nextOverride, ...overrides];
  const title = draft.kind === 'create'
    ? 'Позиция создана'
    : draft.kind === 'edit' || draft.kind === 'correction'
      ? 'Позиция обновлена'
      : 'Операция записана';

  return {
    object: {
      ...object,
      warehouseInventoryOverrides: nextOverrides,
      inventoryMutations: [mutation, ...(object.inventoryMutations ?? [])],
      facts: updateFactList(
        object.facts,
        {
          'Последняя корректировка': `${mutationLabel(draft.kind)} · ${nextOverride.title}`,
        },
        'warehouse'
      ),
      audit: [
        {
          ...auditEntry(nextOverride.id, 'Склад', genericAuditLabel(draft.kind), `${mutationLabel(draft.kind)}: ${nextOverride.title}, ${oldQty} ${unit} -> ${nextQty} ${unit}. Причина: ${reason}.`),
          reason,
          oldValue: `${oldQty} ${unit}`,
          newValue: `${nextQty} ${unit}`,
          sourceSnapshot: nextOverride.id,
          scope: 'warehouse' as const,
        },
        ...object.audit,
      ],
    },
    applied: true,
    title,
    detail: `${nextOverride.title}: ${oldQty} ${unit} -> ${nextQty} ${unit}.`,
    tone: 'success',
  };
}
