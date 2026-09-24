import type {
  InventoryReconciliation,
  MaterialCostReference,
  InventoryMovement,
  OrderRawMaterial,
  RawMaterialStock,
  TapeConsumptionCorrection,
  TapeConsumptionNorm,
  WarehouseRollOwnership,
  WarehouseTask,
  WorkObject,
} from './types';
import {
  actualRawMaterialStockSnapshots,
  importedRawMaterialReferenceSnapshots,
  manualSecondaryStockSnapshots,
} from './adapters/mockOneC';
import {
  projectActualRawMaterialStock,
  projectRawMaterialReferenceSnapshot,
  projectSecondaryRawMaterial,
} from './adapters/sourceProjection';

export function warehouseRollOwnershipLabel(ownership: WarehouseRollOwnership) {
  const labels: Record<WarehouseRollOwnership, string> = {
    customer_owned: 'Под клиента',
    free_reserve: 'Свободный резерв',
    reserved_for_order: 'Зарезервирован под заказ',
    shipped: 'Отгружен',
  };
  return labels[ownership];
}

export const orderRawMaterialReferences: OrderRawMaterial[] = importedRawMaterialReferenceSnapshots.map(projectRawMaterialReferenceSnapshot);

export const rawMaterialStocks: RawMaterialStock[] = [
  ...actualRawMaterialStockSnapshots.map((snapshot) => projectActualRawMaterialStock(
    snapshot,
    importedRawMaterialReferenceSnapshots.find((reference) => reference.rawMaterialId === snapshot.rawMaterialId)
  )),
  ...manualSecondaryStockSnapshots.map(projectSecondaryRawMaterial),
  {
    id: 'RAW-ADD-COLOR-BLUE-01',
    rawMaterialId: 'ADD-COLOR-BLUE-01',
    label: 'Добавка · краситель синий 01',
    materialKind: 'additive',
    qty: 42,
    actualQty: 42,
    unit: 'кг',
    packageQty: 'мешки по 10 кг',
    source: 'manual_platform',
    sourceOfTruthStatus: 'ручная корректировка',
    updatedAt: '2026-07-02 11:20',
  },
];

export const materialCostReferences: MaterialCostReference[] = [
  {
    id: 'MCR-PVD-15803',
    materialId: 'ПВД-15803-020',
    label: 'ПВД 15803-020',
    materialKind: 'raw_material',
    basis: 'material_price_reference',
    unitPriceRub: 147.5,
    valueLabel: '147,50 ₽/кг',
    currency: 'RUB',
    source: '1C_snapshot',
    sourceLabel: 'бухгалтерская стоимость · учётный снимок',
    status: 'accounting_reference',
    effectiveAt: '2026-06-30',
    updatedAt: '2026-07-01 09:40',
    updatedBy: 'Бухгалтерия',
    approvedBy: 'Директор',
    reason: 'Цена конкретного сырья для рублевого эквивалента; источник — бухгалтерский учётный снимок.',
    auditTrail: [
      {
        id: 'a-mcr-15803-imported',
        actorLabel: 'Бухгалтерия',
        actionLabel: 'audit:material_cost_reference_updated',
        oldValue: 'нет цены',
        newValue: '147,50 ₽/кг',
        reason: 'Импортирован бухгалтерский учётный снимок',
        time: '09:40',
      },
      {
        id: 'a-mcr-15803-approved',
        actorLabel: 'Директор',
        actionLabel: 'audit:material_cost_reference_approved',
        newValue: '147,50 ₽/кг',
        reason: 'Разрешено использовать в управленческих рублевых графиках',
        time: '09:45',
      },
    ],
  },
  {
    id: 'MCR-PVD-10803',
    materialId: 'ПВД-10803-020',
    label: 'ПВД 10803-020',
    materialKind: 'raw_material',
    basis: 'material_price_reference',
    unitPriceRub: 151,
    valueLabel: '151,00 ₽/кг',
    currency: 'RUB',
    source: 'manual_platform',
    sourceLabel: 'ручной override до учётной сверки',
    status: 'manual_override',
    effectiveAt: '2026-07-01',
    updatedAt: '2026-07-01 10:05',
    updatedBy: 'Бухгалтерия',
    approvedBy: 'Директор',
    reason: 'Учётный снимок не покрывает текущую партию; бухгалтерия задала ручную цену с причиной.',
    auditTrail: [
      {
        id: 'a-mcr-10803-updated',
        actorLabel: 'Бухгалтерия',
        actionLabel: 'audit:material_cost_reference_updated',
        oldValue: 'нет цены',
        newValue: '151,00 ₽/кг',
        reason: 'Ручная цена до учётной сверки',
        time: '10:05',
      },
      {
        id: 'a-mcr-10803-approved',
        actorLabel: 'Директор',
        actionLabel: 'audit:material_cost_reference_approved',
        newValue: '151,00 ₽/кг',
        reason: 'Emergency override разрешен для dashboard',
        time: '10:08',
      },
    ],
  },
  {
    id: 'MCR-SECONDARY-01',
    materialId: 'ВТОР-РЕГРАН-01',
    label: 'Вторичка · регранулят 01',
    materialKind: 'raw_material',
    basis: 'unknown',
    valueLabel: 'нет цены',
    currency: 'RUB',
    source: 'discovery_pending',
    sourceLabel: 'стоимость не задана',
    status: 'source_missing',
    effectiveAt: 'не задано',
    updatedAt: '2026-07-01 10:10',
    updatedBy: 'Бухгалтерия',
    reason: 'Для вторичного сырья источник цены и дата действия еще не подтверждены.',
    auditTrail: [
      {
        id: 'a-mcr-secondary-open',
        actorLabel: 'Бухгалтерия',
        actionLabel: 'audit:material_cost_reference_updated',
        newValue: 'нет цены',
        reason: 'Ожидает ручной цены или учётного снимка',
        time: '10:10',
      },
    ],
  },
  {
    id: 'MCR-ADD-COLOR-BLUE-01',
    materialId: 'ADD-COLOR-BLUE-01',
    label: 'Добавка · краситель синий 01',
    materialKind: 'additive',
    basis: 'material_price_reference',
    unitPriceRub: 186,
    valueLabel: '186,00 ₽/кг',
    currency: 'RUB',
    source: 'manual_platform',
    sourceLabel: 'ручная цена добавки до учётной сверки',
    status: 'manual_override',
    effectiveAt: '2026-07-02',
    updatedAt: '2026-07-02 11:20',
    updatedBy: 'Бухгалтерия',
    approvedBy: 'Директор',
    reason: 'Добавка должна считаться отдельной строкой рецептуры, а не прятаться в цене основного сырья.',
    auditTrail: [
      {
        id: 'a-mcr-add-blue-updated',
        actorLabel: 'Бухгалтерия',
        actionLabel: 'audit:material_cost_reference_updated',
        oldValue: 'нет цены',
        newValue: '186,00 ₽/кг',
        reason: 'Ручная цена добавки до учётной сверки',
        time: '11:20',
      },
      {
        id: 'a-mcr-add-blue-approved',
        actorLabel: 'Директор',
        actionLabel: 'audit:material_cost_reference_approved',
        newValue: '186,00 ₽/кг',
        reason: 'Разрешено использовать для управленческого рублевого эквивалента',
        time: '11:24',
      },
    ],
  },
];

export const inventoryReconciliations: InventoryReconciliation[] = actualRawMaterialStockSnapshots.map((snapshot) => {
  const reference = importedRawMaterialReferenceSnapshots.find((item) => item.rawMaterialId === snapshot.rawMaterialId);
  const nominalQty = reference?.nominalQty ?? snapshot.actualQty;
  const hasConflict = nominalQty !== snapshot.actualQty;
  return {
    id: `REC-${snapshot.rawMaterialId}`,
    rawMaterialId: snapshot.rawMaterialId,
    actualQty: snapshot.actualQty,
    nominalQty,
    unit: snapshot.unit,
    overrideAllowed: true,
    status: hasConflict ? 'inventory_source_conflict' : 'aligned',
    auditEvent: 'audit:inventory_fact_overrode_accounting_snapshot',
    problemEvent: hasConflict ? 'problem:inventory_source_conflict' : undefined,
    sourceSnapshotId: reference?.meta.snapshotId,
  };
});

export const secondaryRawMaterialMovements: InventoryMovement[] = [
  {
    id: 'MOV-SEC-2606-001',
    materialKind: 'secondary',
    rawMaterialId: 'ВТОР-РЕГРАН-01',
    qty: 120,
    unit: 'кг',
    fromWorkshop: 'Цех 1',
    toWorkshop: 'Цех 2',
    status: 'requires_second_signature',
    signatures: [
      { role: 'production_lead', signerId: 'prod-lead-1', signerLabel: 'Зав. производства Цех 1', signedAt: '10:20' },
      { role: 'production_lead', signerId: 'prod-lead-2', signerLabel: 'Зав. производства Цех 2' },
    ],
    createdAt: '10:18',
  },
  {
    id: 'MOV-SEC-2606-002',
    materialKind: 'secondary',
    rawMaterialId: 'ВТОР-РЕГРАН-01',
    qty: 80,
    unit: 'кг',
    fromWorkshop: 'Цех 2',
    toWorkshop: 'Цех 1',
    status: 'signed',
    signatures: [
      { role: 'production_lead', signerId: 'prod-lead-2', signerLabel: 'Зав. производства Цех 2', signedAt: '09:48' },
      { role: 'production_lead', signerId: 'prod-lead-1', signerLabel: 'Зав. производства Цех 1', signedAt: '09:55' },
    ],
    createdAt: '09:44',
  },
  {
    id: 'MOV-SEC-2606-003',
    materialKind: 'secondary',
    rawMaterialId: 'ВТОР-РЕГРАН-02',
    qty: 45,
    unit: 'кг',
    fromWorkshop: 'Цех 3',
    toWorkshop: 'Цех 1',
    status: 'rejected',
    signatures: [
      { role: 'production_lead', signerId: 'prod-lead-3', signerLabel: 'Зав. производства Цех 3', signedAt: '09:10' },
      { role: 'production_lead', signerId: 'prod-lead-1', signerLabel: 'Зав. производства Цех 1' },
    ],
    createdAt: '09:05',
  },
];

export const tapeConsumptionNorms: TapeConsumptionNorm[] = [
  {
    id: 'TAPE-NORM-DRAFT-01',
    label: 'Базовая черновая норма',
    productType: 'рулон пленки',
    qtyPerRoll: 1.5,
    unit: 'м/рулон',
    status: 'draft',
    templateEditable: true,
    manualValueAllowed: true,
    updatedAt: '10:00',
  },
  {
    id: 'TAPE-NORM-DRAFT-02',
    label: 'Широкий рулон',
    productType: 'надбавка',
    qtyPerRoll: 0.5,
    unit: 'м/рулон',
    status: 'draft',
    templateEditable: true,
    manualValueAllowed: true,
    updatedAt: '10:00',
  },
  {
    id: 'TAPE-NORM-DRAFT-03',
    label: 'Тяжелый рулон',
    productType: 'надбавка',
    qtyPerRoll: 0.5,
    unit: 'м/рулон',
    status: 'draft',
    templateEditable: true,
    manualValueAllowed: true,
    updatedAt: '10:00',
  },
  {
    id: 'TAPE-NORM-DRAFT-04',
    label: 'Упаковка палета',
    productType: 'палет',
    qtyPerRoll: 4,
    unit: 'м/палет',
    status: 'draft',
    templateEditable: true,
    manualValueAllowed: true,
    updatedAt: '10:00',
  },
  {
    id: 'TAPE-NORM-DRAFT-05',
    label: 'Переупаковка / брак',
    productType: 'операция',
    qtyPerRoll: 1,
    unit: 'м/операция',
    status: 'draft',
    templateEditable: true,
    manualValueAllowed: true,
    updatedAt: '10:00',
  },
];

export const tapeConsumptionCorrections: TapeConsumptionCorrection[] = [
  {
    id: 'TAPE-CORR-2606-001',
    normId: 'TAPE-NORM-DRAFT-01',
    reason: 'Фактический перерасход на упаковке партии A-17',
    oldValue: '1.2 м/рулон',
    newValue: '1.6 м/рулон',
    approvedByRole: 'commercial_director',
    createdAt: '10:30',
  },
];

export const reservePreparationTask: WarehouseTask = {
  id: 'WHT-RESERVE-2606-001',
  type: 'prepare_reserved_rolls_for_order',
  orderId: 'З-2606-019',
  rollIds: ['WHR-Z-2606-019-RESERVE-01'],
  qty: 1,
  status: 'in_work',
  createdAt: '10:22',
};

export function createReservePreparationWorkObject(order: WorkObject, confirmedAt: string): WorkObject | null {
  const proposals = order.warehouseCoverProposals ?? [];
  const reserveQty = proposals.reduce((sum, proposal) => sum + (proposal.reserveQty ?? proposal.coverQty), 0);
  const productionQty = proposals.reduce((sum, proposal) => sum + (proposal.productionQty ?? proposal.missingQty), 0);
  const matchedRolls = proposals.flatMap((proposal) => proposal.matchedRolls);
  if (reserveQty <= 0 || matchedRolls.length === 0) return null;
  const taskId = `WHT-${order.id.replace(/^З-/, '')}`;

  return {
    id: taskId,
    kind: 'warehouseJob',
    title: `Подготовить резерв ${order.id}`,
    statusLabel: 'Подготовить резерв',
    nextOwner: 'Склад',
    severity: productionQty > 0 ? 'warning' : 'info',
    filterTags: ['Запасы / резерв', 'Требуют действия'],
    facts: [
      { label: 'Заказ', value: order.id, scope: 'warehouse' },
      { label: 'Резерв', value: `${reserveQty} рул. подготовить`, scope: 'warehouse' },
      { label: 'Производство', value: productionQty > 0 ? `${productionQty} рул. к выпуску` : 'Не требуется после склада', scope: 'warehouse' },
      { label: 'Принадлежность', value: 'Зарезервирован под заказ', scope: 'warehouse' },
      { label: 'Статус задачи', value: 'В работе', scope: 'warehouse' },
    ],
    sections: [
      {
        id: `${taskId}-rolls`,
        title: 'Рулоны из свободного резерва',
        facts: matchedRolls.flatMap((roll) => [
          { label: roll.id, value: `${roll.qty} рул. · ${roll.label}`, scope: 'warehouse' as const },
          { label: `${roll.id} принадлежность`, value: warehouseRollOwnershipLabel('reserved_for_order'), scope: 'warehouse' as const },
        ]),
      },
      {
        id: `${taskId}-production`,
        title: 'Корректировка производства',
        facts: [
          { label: 'К выпуску', value: productionQty > 0 ? `${productionQty} рул.` : '0 рул.', scope: 'warehouse' },
          { label: 'Причина', value: 'Часть заказа закрыта складским резервом', scope: 'warehouse' },
          { label: 'Подтвердил', value: `Коммерция · ${confirmedAt}`, scope: 'warehouse' },
        ],
      },
    ],
    actions: [
      { id: `warehouse-complete-reserve-task:${taskId}`, label: 'Резерв подготовлен', level: 'recommended', enabled: true },
      { id: `warehouse-open-reserve-history:${taskId}`, label: 'Открыть историю', level: 'secondary', enabled: true },
    ],
    problems: [],
    audit: [
      { id: `a-${taskId}-reserved`, objectId: taskId, time: confirmedAt, actorLabel: 'Склад', actionLabel: 'audit:roll_reserved_for_order', detail: `${reserveQty} рул. переведены из свободного резерва под ${order.id}.`, scope: 'warehouse' },
    ],
  };
}

export function createWarehouseCoverRecheckWorkObject(order: WorkObject, reason: string, createdAt: string): WorkObject | null {
  const proposals = order.warehouseCoverProposals ?? [];
  if (proposals.length === 0) return null;
  const taskId = `WH-RECHECK-${order.id}`;
  const requestedQty = order.commercialOrder?.positions.reduce((sum, position) => sum + position.rollCount, 0) ?? 0;
  const coveredQty = proposals.reduce((sum, proposal) => sum + proposal.coverQty, 0);
  const missingQty = proposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);

  return {
    id: taskId,
    kind: 'warehouseJob',
    title: `Перепроверить покрытие ${order.id}`,
    statusLabel: 'Перепроверка покрытия',
    nextOwner: 'Склад',
    severity: 'warning',
    filterTags: ['Запасы / резерв', 'Требуют действия', 'С проблемами'],
    facts: [
      { label: 'Заказ', value: order.id, scope: 'warehouse' },
      { label: 'Запрошено', value: `${requestedQty} рул.`, scope: 'warehouse' },
      { label: 'Склад предложил', value: `${coveredQty} рул.`, scope: 'warehouse' },
      { label: 'Недостача', value: `${missingQty} рул.`, scope: 'warehouse' },
      { label: 'Причина', value: reason, scope: 'warehouse' },
    ],
    sections: [
      {
        id: `${taskId}-proposals`,
        title: 'Что перепроверить',
        facts: proposals.flatMap((proposal, index) => [
          { label: `Позиция ${index + 1}`, value: `${proposal.coverQty} из ${proposal.coverQty + proposal.missingQty} рул.`, scope: 'warehouse' as const },
          { label: `Резерв ${index + 1}`, value: proposal.matchedRolls.map((roll) => `${roll.id}: ${roll.label}`).join('; ') || 'Нет рулонов', scope: 'warehouse' as const },
        ]),
      },
    ],
    actions: [
      { id: `warehouse-cover-recheck-complete:${taskId}`, label: 'Перепроверка выполнена', level: 'recommended', enabled: true },
      { id: `warehouse-cover-recheck-problem:${taskId}`, label: 'Создать проблему...', level: 'secondary', enabled: true, confirmation: 'Нужна причина расхождения' },
    ],
    problems: [
      {
        id: `${taskId}-problem`,
        objectId: taskId,
        stage: 'Складское покрытие',
        title: 'Коммерция спорит с покрытием',
        severity: 'warning',
        ownerRole: 'Склад',
        due: 'до передачи производственной части',
        reason,
        recovery: 'Перепроверить остатки и вернуть уточненное покрытие коммерции',
        status: 'open',
      },
    ],
    audit: [
      { id: `a-${taskId}-requested`, objectId: taskId, time: createdAt, actorLabel: 'Коммерция', actionLabel: 'notification:warehouse_recheck_requested', detail: `Коммерция запросила перепроверку складского покрытия. Причина: ${reason}.`, scope: 'warehouse' },
    ],
  };
}
