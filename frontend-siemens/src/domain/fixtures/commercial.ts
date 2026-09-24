import type {
  ActionDescriptor,
  CommercialOrderPosition,
  CommercialOrderRequest,
  CommercialPaymentIndicator,
  CommercialProductionProgress,
  CounterpartyBillingSnapshot,
  MaterialShortageBlocker,
  ProblemCase,
  ProductionProblem,
  QRActionPanelContext,
  RecipeSnapshot,
  WarehouseCoverProposal,
  WorkObject,
} from '../types';
import {
  importedInvoiceSnapshots,
  paymentSnapshotByOrder,
  reserveRollSnapshotsByOrder,
  shipmentSnapshotByOrder,
} from '../adapters/mockOneC';
import { importedFactAudit } from '../adapters/sourceAudit';
import { projectPaymentSnapshot, projectReserveRollSnapshot, projectShipmentSnapshot } from '../adapters/sourceProjection';
import { counterparties } from '../templates';
import { rawMaterialStocks } from '../inventoryContracts';

function recipe(positionId: string, createdBy = 'Коммерция'): RecipeSnapshot {
  return {
    id: `${positionId}-recipe-v1`,
    positionId,
    recipeOwnerRole: 'commercial',
    parameters: [
      { label: 'Пленка', value: 'Рукав' },
      { label: 'Температура', value: 'по шаблону УралПак' },
      { label: 'Сырье', value: 'ПВД 15803-020' },
      { label: 'Состав', value: '98% основное сырье / 2% добавка' },
    ],
    source: createdBy === 'Зав. производства' ? 'production_lead_form' : 'commercial_form',
    createdBy,
    createdAt: '10:18',
    version: 'v1',
  };
}

function position(input: {
  id: string;
  draftId: string;
  rollCount: number;
  filmType: string;
  actualThickness: string;
  accountingThickness: string;
  rawMaterialLabel: string;
  spoolType: string;
  birka: string;
  manualBirka?: string;
  comment?: string;
  warehouseCoverStatus: CommercialOrderPosition['warehouseCoverStatus'];
  createdBy?: string;
}): CommercialOrderPosition {
  const plannedWeightKg = input.actualThickness === '80 мкм' ? 41.2 : 34.5;
  const totalRecipeQty = Number((plannedWeightKg * input.rollCount).toFixed(1));
  const primaryQty = Number((totalRecipeQty * 0.98).toFixed(1));
  const additiveQty = Number((totalRecipeQty - primaryQty).toFixed(1));
  const primaryMaterialId = input.rawMaterialLabel.includes('10803') ? 'ПВД-10803-020' : 'ПВД-15803-020';
  return {
    ...input,
    plannedWeightKg,
    rawMaterialId: input.rawMaterialLabel.includes('10803') ? 'rm-pvd-10803' : 'rm-pvd-15803',
    rawMaterials: [
      {
        rawMaterialId: primaryMaterialId,
        label: input.rawMaterialLabel,
        materialKind: 'raw_material',
        nominalQty: primaryQty,
        unit: 'кг',
        recipeSharePct: 98,
        costReferenceId: input.rawMaterialLabel.includes('10803') ? 'MCR-PVD-10803' : 'MCR-PVD-15803',
        accountingSource: 'order_entry',
      },
      {
        rawMaterialId: 'ADD-COLOR-BLUE-01',
        label: 'Добавка · краситель синий 01',
        materialKind: 'additive',
        nominalQty: additiveQty,
        unit: 'кг',
        recipeSharePct: 2,
        costReferenceId: 'MCR-ADD-COLOR-BLUE-01',
        accountingSource: 'order_entry',
      },
    ],
    recipeSnapshot: recipe(input.id, input.createdBy),
  };
}

function payment(orderId: string, paymentStatus: CommercialPaymentIndicator['paymentStatus']): CommercialPaymentIndicator {
  const snapshot = paymentSnapshotByOrder(orderId);
  if (snapshot) return projectPaymentSnapshot(snapshot);
  const severity = paymentStatus === 'просрочка'
    ? 'critical'
    : paymentStatus === 'оплачен'
      ? 'info'
      : 'warning';
  return {
    orderId,
    paymentStatus,
    label: paymentStatus.charAt(0).toUpperCase() + paymentStatus.slice(1),
    severity,
    lastUpdatedAt: '10:24',
    source: 'mock_1C',
    syncedAt: 'обновлено 08:40',
  };
}

function commercialPaymentSource(indicator: CommercialPaymentIndicator) {
  return `обновлено${indicator.lastUpdatedAt ? ` · ${indicator.lastUpdatedAt}` : ''}`;
}

function qr(orderId: string, positionId: string): QRActionPanelContext {
  return {
    qrCode: `QR-${orderId}-${positionId}-01`,
    rollId: `${positionId}-ROLL-01`,
    orderId,
    positionId,
    currentRole: 'commercial',
    allowedActions: ['comment', 'attach', 'request_status_change'],
    blockedActions: ['delete_roll', 'silent_reprint', 'request_reprint'],
    state: 'actions_available',
  };
}

function billingSnapshot(counterpartyLabel: string, orderId: string, createdBy: string): CounterpartyBillingSnapshot {
  const counterparty = counterparties.find((item) => item.legalName === counterpartyLabel);

  return {
    id: `billing-${orderId}`,
    counterpartyId: counterparty?.id,
    label: counterpartyLabel,
    type: 'legal_entity',
    inn: counterparty?.inn,
    kpp: counterparty?.kpp,
    ogrn: counterparty?.ogrn,
    legalAddress: counterparty?.legalAddress ?? 'Адрес требует сверки',
    source: counterparty ? 'mock_1C_snapshot' : 'manual_order_entry',
    syncStatus: counterparty ? 'needs_1C_discovery' : 'manual_not_synced',
    createdBy,
    createdAt: '10:18',
  };
}

function billingSourceLabel(source: CounterpartyBillingSnapshot['source']) {
  if (source === 'manual_order_entry') return 'ручной ввод';
  if (source === 'mock_1C_snapshot') return 'снимок карточки контрагента';
  return 'карточка контрагента';
}

function cover(input: {
  id: string;
  position: CommercialOrderPosition;
  coverType: WarehouseCoverProposal['coverType'];
  coverQty: number;
  confirmedAt?: string;
}): WarehouseCoverProposal {
  const reserveRolls = reserveRollSnapshotsByOrder(input.position.draftId)
    .filter((snapshot) => {
      const label = snapshot.label.toLocaleLowerCase('ru-RU');
      return label.includes(input.position.filmType.toLocaleLowerCase('ru-RU'))
        && label.includes(input.position.actualThickness.toLocaleLowerCase('ru-RU'));
    })
    .map(projectReserveRollSnapshot);
  const reserveRollQty = reserveRolls.reduce((sum, roll) => sum + roll.qty, 0);
  const generatedReserveRolls = input.coverQty > reserveRollQty
    ? [{
        id: `${input.id}-ROLL-A`,
        ownership: input.coverType === 'full' ? 'reserved_for_order' as const : 'free_reserve' as const,
        qty: input.coverQty - reserveRollQty,
        label: `${input.position.filmType}, ${input.position.actualThickness}, ${input.position.spoolType}`,
      }]
    : [];
  return {
    id: input.id,
    positionId: input.position.id,
    matchedRolls: [...reserveRolls, ...generatedReserveRolls],
    coverType: input.coverType,
    coverQty: input.coverQty,
    missingQty: Math.max(0, input.position.rollCount - input.coverQty),
    reserveQty: input.coverQty,
    productionQty: Math.max(0, input.position.rollCount - input.coverQty),
    decision: input.confirmedAt ? 'confirmed' : 'pending',
    warehouseCoverStatus: input.confirmedAt
      ? input.coverType === 'full' ? 'full_confirmed' : 'partial_confirmed'
      : input.coverType === 'full' ? 'full_proposed' : 'partial_proposed',
    requiresConfirmation: true,
    confirmedBy: input.confirmedAt ? 'Коммерция' : undefined,
    confirmedAt: input.confirmedAt,
  };
}

function materialShortageBlocker(input: {
  id: string;
  commercialOrderId: string;
  position: CommercialOrderPosition;
  productionOrderId: string;
  usableReserveQty: number;
}): MaterialShortageBlocker {
  const stock = rawMaterialStocks.find((item) => item.label === input.position.rawMaterialLabel) ?? rawMaterialStocks[0];
  const plannedWeightKg = input.position.plannedWeightKg ?? 0;
  const requiredQty = input.position.rawMaterials?.reduce((sum, material) => sum + material.nominalQty, 0) ?? Math.round(plannedWeightKg * input.position.rollCount);
  const factQty = stock?.actualQty ?? 0;
  const shortageQty = Math.max(0, requiredQty - factQty - input.usableReserveQty);

  return {
    id: input.id,
    subtype: 'ProductionProblem',
    orderId: input.productionOrderId,
    commercialOrderId: input.commercialOrderId,
    positionId: input.position.id,
    productionOrderId: input.productionOrderId,
    rawMaterialStockId: stock?.id ?? 'RAW-unknown',
    rawMaterialId: stock?.rawMaterialId ?? input.position.rawMaterialLabel,
    label: input.position.rawMaterialLabel,
    requiredQty,
    factQty,
    usableReserveQty: input.usableReserveQty,
    shortageQty,
    unit: stock?.unit ?? 'кг',
    blocks: `Передача ${input.position.rollCount} рул. в ${input.productionOrderId}`,
    ownerRole: 'production_lead',
    source: 'warehouse_fact',
    createdAt: '11:12',
  };
}

function commercialActionsForObject(input: {
  statusLabel?: string;
  positions: CommercialOrderPosition[];
  proposals: WarehouseCoverProposal[];
  productionStatus: CommercialOrderRequest['productionStatus'];
  productionProblems?: ProductionProblem[];
}): ActionDescriptor[] {
  const isDraft = input.statusLabel === 'Черновик';
  const complete = input.positions.length > 0 && input.positions.every((position) => position.recipeSnapshot.parameters.length > 0);
  const pendingWarehouseProposal = input.proposals.some((proposal) => !proposal.confirmedAt);
  const missingQty = input.proposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
  const productionStarted = input.productionStatus === 'in_production' || input.productionStatus === 'ready';
  const hasOpenProductionProblem = input.productionProblems?.some((problem) => problem.status !== 'resolved') ?? false;

  if (isDraft) {
    return complete
      ? [
          { id: 'commercial-promote-draft', label: 'Оформить заявку', level: 'recommended', enabled: true },
          { id: 'commercial-edit-params', label: 'Изменить параметры', level: 'peer', enabled: true, helpText: 'До старта производства правка сохраняет новую версию параметров.' },
          { id: 'commercial-add-position', label: 'Добавить позицию', level: 'secondary', enabled: true },
          {
            id: 'commercial-duplicate-position',
            label: 'Дублировать позицию',
            level: 'secondary',
            enabled: input.positions.length > 0,
            disabledReason: input.positions.length > 0 ? undefined : 'Нет позиции для дублирования',
            recoveryOwner: 'Коммерция',
            recoveryAction: 'Добавить позицию или выбрать существующую',
          },
          { id: 'commercial-save-draft', label: 'Сохранить черновик', level: 'secondary', enabled: true },
        ]
      : [
          { id: 'commercial-edit-params', label: 'Заполнить параметры', level: 'recommended', enabled: true },
          { id: 'commercial-add-position', label: 'Добавить позицию', level: 'secondary', enabled: true },
          { id: 'commercial-save-draft', label: 'Сохранить черновик', level: 'secondary', enabled: true },
          {
            id: 'commercial-promote-draft',
            label: 'Оформить заявку',
            level: 'disabled',
            enabled: false,
            disabledReason: 'Не заполнены обязательные параметры позиции',
            recoveryOwner: 'Коммерция',
            recoveryAction: 'Заполнить параметры и проверить карточку',
          },
        ];
  }

  if (productionStarted) {
    return [
      ...(hasOpenProductionProblem
        ? [
            { id: 'commercial-open-production-problem', label: 'Разобрать проблему производства', level: 'recommended' as const, enabled: true },
            { id: 'commercial-request-correction', label: 'Изменить позицию по проблеме...', level: 'peer' as const, enabled: true, confirmation: 'Нужна причина и рулон, с которого действует изменение' },
            { id: 'commercial-open-production', label: 'Статус производства', level: 'secondary' as const, enabled: true },
          ]
        : [
            { id: 'commercial-open-production', label: 'Статус производства', level: 'recommended' as const, enabled: true, actionIntent: 'inspect' as const },
            { id: 'commercial-request-correction', label: 'Запросить изменение параметров...', level: 'peer' as const, enabled: true, confirmation: 'Нужна причина изменения; прямое редактирование уже закрыто' },
          ]),
      { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
      {
        id: 'commercial-edit-params',
        label: 'Изменить параметры напрямую',
        level: 'disabled',
        enabled: false,
        disabledReason: 'Производство уже стартовало',
        recoveryOwner: 'Зав. производства',
        recoveryAction: 'Запросить изменение с причиной',
      },
    ];
  }

  if (pendingWarehouseProposal) {
    if (missingQty > 0) {
      return [
        { id: 'commercial-transfer-selected', label: 'Направить в бухгалтерию', level: 'recommended', enabled: true },
        { id: 'commercial-open-production', label: 'Показать недостачу для выпуска', level: 'recommended', enabled: true, helpText: 'Недостающие рулоны идут в заказ-наряд после решения коммерции.' },
        { id: 'commercial-edit-params', label: 'Изменить параметры', level: 'peer', enabled: true, helpText: 'Производство еще не стартовало; правка сохраняет прежнее и новое значение.' },
        { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
      ];
    }

    return [
      { id: 'commercial-transfer-selected', label: 'Направить в бухгалтерию', level: 'recommended', enabled: true },
      { id: 'commercial-edit-params', label: 'Изменить параметры', level: 'secondary', enabled: true, helpText: 'Производство еще не стартовало; правка сохраняет прежнее и новое значение.' },
      { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
    ];
  }

  return [
    {
      id: 'commercial-open-production',
      label: missingQty > 0 ? 'Показать недостачу для выпуска' : 'Статус производства',
      level: 'recommended' as const,
      enabled: true,
      helpText: missingQty > 0 ? 'Недостающие рулоны идут в заказ-наряд; складской gate остается ручной проверкой.' : undefined,
    },
    { id: 'commercial-edit-params', label: 'Изменить параметры', level: 'peer', enabled: true, helpText: 'Производство еще не стартовало; правка сохраняет прежнее и новое значение.' },
    { id: 'commercial-open-payment-shipment', label: 'Показать оплату и отгрузку', level: 'secondary', enabled: true, actionIntent: 'navigate' as const },
  ];
}

function commercialObject(input: {
  id: string;
  counterparty: string;
  statusLabel?: string;
  creatorRole?: CommercialOrderRequest['creatorRole'];
  createdBy?: string;
  paymentStatus: CommercialPaymentIndicator['paymentStatus'];
  shipmentStatus: CommercialOrderRequest['shipmentStatus'];
  assignedOperatorId?: string;
  priority?: CommercialOrderRequest['priority'];
  createdOnBehalfOfRole?: CommercialOrderRequest['createdOnBehalfOfRole'];
  createdOnBehalfOfUserId?: string;
  commercialDelegationConfirmed?: boolean;
  commercialConfirmationPolicy?: CommercialOrderRequest['commercialConfirmationPolicy'];
  commercialConfirmationReason?: string;
  productionStatus?: CommercialOrderRequest['productionStatus'];
  productionProblems?: ProductionProblem[];
  productionProgress?: CommercialProductionProgress;
  materialShortageBlockers?: MaterialShortageBlocker[];
  positions: CommercialOrderPosition[];
  proposals: WarehouseCoverProposal[];
  auditExtra?: WorkObject['audit'];
}): WorkObject {
  const coverStatus = input.proposals.some((item) => item.coverType === 'partial')
    ? input.proposals.some((item) => item.confirmedAt) ? 'partial_confirmed' : 'partial_proposed'
    : input.proposals.some((item) => item.confirmedAt) ? 'full_confirmed' : 'full_proposed';
  const missingQty = input.proposals.reduce((sum, item) => sum + item.missingQty, 0);
  const indicator = payment(input.id, input.paymentStatus);
  const paymentSnapshot = paymentSnapshotByOrder(input.id);
  const invoiceSnapshot = importedInvoiceSnapshots.find((snapshot) => snapshot.orderId === input.id);
  const shipmentSnapshot = shipmentSnapshotByOrder(input.id);
  const shipmentStatus = shipmentSnapshot ? projectShipmentSnapshot(shipmentSnapshot) : input.shipmentStatus;
  const counterpartySnapshot = billingSnapshot(input.counterparty, input.id, input.createdBy ?? 'Коммерция');
  const commercialConfirmationPolicy = input.commercialConfirmationPolicy
    ?? (input.creatorRole === 'production_lead' ? 'required' : undefined);
  const requiresCommercialRecipeConfirmation = commercialConfirmationPolicy === 'required';
  const activeProductionProblems = (input.productionProblems ?? []).filter((problem) => problem.status !== 'resolved');
  const activeMaterialShortages = (input.materialShortageBlockers ?? []).filter((blocker) => blocker.shortageQty > 0);
  const isDraft = input.statusLabel === 'Черновик';
  const productionStarted =
    input.productionStatus === 'in_production'
    || input.productionStatus === 'ready'
    || Boolean(input.productionProgress)
    || activeProductionProblems.length > 0;
  const visibleStatus = input.statusLabel ?? (productionStarted ? 'В работе' : 'Оформляется');
  const stageTags = isDraft
    ? ['Входящие заявки', 'Черновики', 'Черновик']
    : productionStarted
      ? ['В работе', visibleStatus]
      : ['Входящие заявки', visibleStatus];
  const nextOwner = isDraft || activeProductionProblems.length > 0
    ? 'Коммерция'
    : productionStarted
      ? 'Зав. производства'
      : 'Коммерция';
  const order: CommercialOrderRequest = {
    id: input.id,
    createdBy: input.createdBy ?? 'Коммерция',
    creatorRole: input.creatorRole ?? 'commercial',
    counterpartyId: counterpartySnapshot.counterpartyId,
    billingSnapshot: counterpartySnapshot,
    requestType: 'клиентский заказ',
    status: isDraft ? 'draft' : 'in_work',
    productionStatus: input.productionStatus ?? (missingQty > 0 ? 'needs_production' : 'not_started'),
    warehouseCoverStatus: coverStatus,
    paymentStatus: input.paymentStatus,
    shipmentStatus,
    createdAt: '10:18',
    submittedAt: isDraft ? undefined : '10:22',
    assignedOperatorId: input.assignedOperatorId,
    priority: input.priority,
    createdOnBehalfOfRole: input.createdOnBehalfOfRole,
    createdOnBehalfOfUserId: input.createdOnBehalfOfUserId,
    commercialDelegationConfirmed: input.commercialDelegationConfirmed,
    commercialConfirmationPolicy,
    commercialConfirmationReason: input.commercialConfirmationReason,
    requiresCommercialRecipeConfirmation,
    positions: input.positions,
  };
  const problemCases: ProblemCase[] = activeProductionProblems.map((problem) => ({
    id: `${problem.id}-commercial-case`,
    objectId: input.id,
    stage: 'Производство',
    title: 'Проблема из производства',
    severity: problem.severity,
    ownerRole: 'Коммерция',
    due: 'до продолжения текущего рулона',
    reason: problem.comment,
    recovery: 'Разобрать проблему, изменить позицию/рецепт и уведомить оператора',
    status: 'open',
  }));
  const materialShortageCases: ProblemCase[] = activeMaterialShortages.map((blocker) => ({
    id: `${blocker.id}-case`,
    objectId: input.id,
    stage: 'Сырье',
    title: 'Нехватка сырья',
    severity: 'warning',
    ownerRole: 'Зав. производства',
    due: 'до передачи в заказ-наряд',
    reason: `${blocker.label}: не хватает ${blocker.shortageQty} ${blocker.unit}.`,
    recovery: 'Разобрать нехватку сырья: изменить позицию, подтвердить резерв или открыть производственную проблему.',
    status: 'open',
  }));

  return {
    id: input.id,
    kind: 'intake',
    title: `Заявка ${input.id} · ${input.counterparty}`,
    statusLabel: visibleStatus,
    nextOwner,
    severity: indicator.severity,
    filterTags: Array.from(new Set([...stageTags, indicator.label])),
    facts: [
      { label: 'creatorRole', value: order.creatorRole, scope: 'rawDiagnostics' },
      ...(order.createdOnBehalfOfRole ? [{ label: 'createdOnBehalfOfRole', value: order.createdOnBehalfOfRole, scope: 'rawDiagnostics' as const }] : []),
      ...(order.commercialConfirmationPolicy ? [{ label: 'commercialConfirmationPolicy', value: order.commercialConfirmationPolicy, scope: 'rawDiagnostics' as const }] : []),
      { label: 'recipeOwnerRole', value: 'commercial', scope: 'rawDiagnostics' },
      { label: 'warehouseCoverStatus', value: order.warehouseCoverStatus, scope: 'rawDiagnostics' },
      { label: 'paymentStatus', value: order.paymentStatus, scope: 'rawDiagnostics' },
      { label: 'shipmentStatus', value: order.shipmentStatus, scope: 'rawDiagnostics' },
      { label: 'Контрагент', value: input.counterparty, scope: 'commercial' },
      { label: 'Тип контрагента', value: 'Юридическое лицо', scope: 'legal' },
      { label: 'ИНН', value: counterpartySnapshot.inn ?? '[нужен факт]', scope: 'legal' },
      { label: 'КПП', value: counterpartySnapshot.kpp ?? '[нужен факт]', scope: 'legal' },
      { label: 'ОГРН', value: counterpartySnapshot.ogrn ?? '[нужен факт]', scope: 'legal' },
      { label: 'Юр. адрес', value: counterpartySnapshot.legalAddress ?? '[нужен факт]', scope: 'legal' },
      { label: 'Источник реквизитов', value: counterpartySnapshot.source === 'manual_order_entry' ? 'ручной ввод · нужна сверка' : 'карточка контрагента · нужна сверка', scope: 'legal' },
      { label: 'Статус реквизитов', value: counterpartySnapshot.syncStatus, scope: 'rawDiagnostics' },
      { label: 'Снимок реквизитов', value: counterpartySnapshot.id, scope: 'rawDiagnostics' },
      { label: 'Позиции', value: `${input.positions.length} поз., ${input.positions.reduce((sum, item) => sum + item.rollCount, 0)} рул.`, scope: 'commercial' },
      { label: 'Всего рулонов', value: String(input.positions.reduce((sum, item) => sum + item.rollCount, 0)), scope: 'commercial' },
      { label: 'Характеристики', value: 'Разные характеристики по позициям', scope: 'commercial' },
      { label: 'Сырье', value: Array.from(new Set(input.positions.map((item) => item.rawMaterialLabel))).join(', '), scope: 'commercial' },
      { label: 'Шаблон', value: `${input.counterparty} · коммерческий шаблон`, scope: 'commercial' },
      { label: 'Комментарий', value: 'Phase 2 commercial-first карточка.', scope: 'commercial' },
      { label: 'Производство', value: missingQty > 0 ? `${missingQty} рул. в производство` : 'Не требуется после склада', scope: 'commercial' },
      ...(input.productionProgress
        ? [{ label: 'Прогресс производства', value: `${input.productionProgress.completedRolls}/${input.productionProgress.totalRolls} рул.; текущий ${input.productionProgress.currentRollNumber}`, scope: 'commercial' as const }]
        : []),
      { label: 'Склад', value: missingQty > 0 ? 'Частично есть на складе' : 'Закрыто складом', scope: 'commercial' },
      { label: 'Оплата', value: indicator.label, scope: 'commercial' },
      { label: 'Источник оплаты', value: commercialPaymentSource(indicator), scope: 'commercial' },
      { label: 'Отгрузка', value: order.shipmentStatus, scope: 'commercial' },
      ...(input.assignedOperatorId ? [{ label: 'assignedOperatorId', value: input.assignedOperatorId, scope: 'rawDiagnostics' as const }] : []),
      ...(input.priority ? [{ label: 'priority', value: input.priority, scope: 'rawDiagnostics' as const }] : []),
    ],
    sections: [
      {
        id: `${input.id}-indicators`,
        title: 'Индикаторы заявки',
        facts: [
          { label: 'Производство', value: missingQty > 0 ? `${missingQty} рул. уйдет в производство` : 'Закрыто складским предложением', scope: 'commercial' },
          ...(input.productionProgress
            ? [{ label: 'Активный прогресс', value: `${input.productionProgress.completedRolls} готово, рулон ${input.productionProgress.currentRollNumber} из ${input.productionProgress.totalRolls}`, scope: 'commercial' as const }]
            : []),
          { label: 'Склад', value: missingQty > 0 ? 'Частично есть на складе' : 'Закрыто складом', scope: 'commercial' },
          { label: 'Оплата', value: indicator.label, scope: 'commercial' },
          { label: 'Источник оплаты', value: commercialPaymentSource(indicator), scope: 'commercial' },
          { label: 'Отгрузка', value: order.shipmentStatus, scope: 'commercial' },
        ],
      },
      {
        id: `${input.id}-reserve-hardening`,
        title: 'Подтверждение резерва',
        facts: [
          { label: 'Запрошено', value: `${input.positions.reduce((sum, item) => sum + item.rollCount, 0)} рул.`, scope: 'commercial' },
          { label: 'Резерв', value: `${input.proposals.reduce((sum, item) => sum + (item.reserveQty ?? item.coverQty), 0)} рул.`, scope: 'commercial' },
          { label: 'Производство', value: `${missingQty} рул.`, scope: 'commercial' },
          { label: 'Владелец подтверждения', value: input.proposals.some((item) => item.confirmedAt) ? 'Коммерция' : 'Коммерция подтверждает перед складской задачей', scope: 'commercial' },
          { label: 'Время подтверждения', value: input.proposals.find((item) => item.confirmedAt)?.confirmedAt ?? 'Не подтверждено', scope: 'commercial' },
          { label: 'Статус задачи склада', value: input.proposals.some((item) => item.confirmedAt) ? 'В работе' : 'Откроется после подтверждения', scope: 'commercial' },
        ],
      },
      {
        id: `${input.id}-client`,
        title: 'Заявка клиента',
        facts: [
          { label: 'Контрагент', value: input.counterparty, scope: 'commercial' },
          { label: 'ИНН', value: counterpartySnapshot.inn ?? '[нужен факт]', scope: 'legal' },
          { label: 'КПП', value: counterpartySnapshot.kpp ?? '[нужен факт]', scope: 'legal' },
          { label: 'Юр. адрес', value: counterpartySnapshot.legalAddress ?? '[нужен факт]', scope: 'legal' },
          { label: 'Источник реквизитов', value: billingSourceLabel(counterpartySnapshot.source), scope: 'legal' },
          { label: 'Позиции', value: `${input.positions.length} позиций`, scope: 'commercial' },
          { label: 'Комментарий', value: 'Комментарий хранится рядом с карточкой, не заменяет structured fields.', scope: 'commercial' },
        ],
      },
      ...input.positions.map((item, index) => ({
        id: `${item.id}-full-card`,
        title: `Позиция ${index + 1}`,
        facts: [
          { label: 'Бирка', value: [item.birka, item.manualBirka].filter(Boolean).join(' / '), scope: 'commercial' as const },
          { label: 'Фактическая толщина', value: item.actualThickness, scope: 'commercial' as const },
          { label: 'Бухгалтерская толщина', value: item.accountingThickness, scope: 'commercial' as const },
          { label: 'Шпуля', value: item.spoolType, scope: 'commercial' as const },
          { label: 'Сырье', value: item.rawMaterialLabel, scope: 'commercial' as const },
          { label: 'Плановое сырье', value: item.rawMaterials?.map((material) => `${material.label}: ${material.nominalQty} ${material.unit}`).join('; ') ?? 'Не задано', scope: 'commercial' as const },
          { label: 'Комментарий позиции', value: item.comment ?? 'Без комментария', scope: 'commercial' as const },
        ],
      })),
    ],
    actions: commercialActionsForObject({
      statusLabel: input.statusLabel,
      positions: input.positions,
      proposals: input.proposals,
      productionStatus: order.productionStatus,
      productionProblems: input.productionProblems,
    }),
    problems: [...problemCases, ...materialShortageCases],
    audit: [
      { id: `a-${input.id}-created`, objectId: input.id, time: '10:18', actorLabel: input.createdBy ?? 'Коммерция', actionLabel: input.creatorRole === 'production_lead' ? 'audit:production_lead_request_created' : 'audit:commercial_order_draft_created', detail: input.creatorRole === 'production_lead' ? 'Зав. производства создал заявку с оператором и приоритетом; рецептуру ведет коммерция.' : 'Коммерческая заявка создана с несколькими позициями.' },
      { id: `a-${input.id}-counterparty-snapshot`, objectId: input.id, time: '10:18', actorLabel: input.createdBy ?? 'Коммерция', actionLabel: 'audit:counterparty_billing_snapshot_set', detail: `Снимок реквизитов закреплен за заявкой: ${input.counterparty}.`, sourceSnapshot: counterpartySnapshot.id, newValue: billingSourceLabel(counterpartySnapshot.source) },
      { id: `a-${input.id}-counterparty-attached`, objectId: input.id, time: '10:18', actorLabel: input.createdBy ?? 'Коммерция', actionLabel: 'audit:counterparty_attached_to_order', detail: `${input.counterparty} подставлен в заявку ${input.id}.`, sourceSnapshot: counterpartySnapshot.id, newValue: input.counterparty },
      { id: `a-${input.id}-recipe`, objectId: input.id, time: '10:19', actorLabel: 'Коммерция', actionLabel: 'audit:commercial_recipe_snapshot_set', detail: 'Снимок рецептуры сохранен по каждой позиции.' },
      { id: `a-${input.id}-cover`, objectId: input.id, time: '10:20', actorLabel: 'Система', actionLabel: input.proposals.some((item) => item.confirmedAt) ? 'audit:warehouse_cover_confirmed' : 'audit:warehouse_cover_proposed', detail: missingQty > 0 ? `Покрыта часть; ${missingQty} рул. идет в производство.` : 'Покрытие складом закрывает заявку.' },
      ...activeMaterialShortages.map((blocker) => ({
        id: `a-${blocker.id}`,
        objectId: input.id,
        time: blocker.createdAt,
        actorLabel: 'Склад',
        actionLabel: 'problem:material_shortage_blocker_created',
        detail: `${blocker.label}: требуется ${blocker.requiredQty} ${blocker.unit}, факт ${blocker.factQty} ${blocker.unit}, usable reserve ${blocker.usableReserveQty} ${blocker.unit}, не хватает ${blocker.shortageQty} ${blocker.unit}.`,
        sourceSnapshot: blocker.rawMaterialStockId,
        scope: 'warehouse' as const,
      })),
      ...(paymentSnapshot ? [importedFactAudit({
        objectId: input.id,
        actionLabel: 'audit:payment_status_imported',
        detail: `Статус оплаты: ${indicator.label}.`,
        meta: paymentSnapshot.meta,
        newValue: input.paymentStatus,
        scope: 'commercial',
      })] : []),
      ...(invoiceSnapshot ? [importedFactAudit({
        objectId: input.id,
        actionLabel: 'audit:invoice_status_imported',
        detail: `Счет ${invoiceSnapshot.invoiceId}: ${invoiceSnapshot.invoiceStatus}.`,
        meta: invoiceSnapshot.meta,
        newValue: invoiceSnapshot.invoiceStatus,
        scope: 'commercial',
      })] : []),
      ...(shipmentSnapshot?.completedAt ? [importedFactAudit({
        objectId: input.id,
        actionLabel: 'audit:shipment_completed',
        detail: `Отгрузка закрыта складом: ${shipmentSnapshot.completedAt.slice(0, 10)}.`,
        meta: shipmentSnapshot.meta,
        newValue: shipmentSnapshot.shipmentStatus,
        scope: 'commercial',
      })] : []),
      ...(input.auditExtra ?? []),
    ],
    commercialOrder: order,
    warehouseCoverProposals: input.proposals,
    materialShortageBlockers: input.materialShortageBlockers,
    productionProblems: input.productionProblems,
    commercialProductionProgress: input.productionProgress,
    paymentIndicator: indicator,
    qrActionPanelContext: qr(input.id, input.positions[0]?.id ?? input.id),
  };
}

const order019Positions = [
  position({
    id: 'З-2606-019-POS-1',
    draftId: 'З-2606-019',
    rollCount: 3,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    rawMaterialLabel: 'ПВД 15803-020',
    spoolType: 'Шпуля 76 мм',
    birka: 'Гост',
    comment: 'Основная позиция, частично закрывается складом.',
    warehouseCoverStatus: 'partial_proposed',
  }),
  position({
    id: 'З-2606-019-POS-2',
    draftId: 'З-2606-019',
    rollCount: 2,
    filmType: 'Полурукав',
    actualThickness: '60 мкм',
    accountingThickness: '58 мкм',
    rawMaterialLabel: 'ПВД 10803-020',
    spoolType: 'Шпуля 152 мм',
    birka: '(i)',
    manualBirka: 'Маркировка клиента A-17',
    comment: 'Вторая позиция со своей биркой и шпулей.',
    warehouseCoverStatus: 'full_proposed',
  }),
];

const order017Positions = [
  position({
    id: 'З-2606-017-POS-1',
    draftId: 'З-2606-017',
    rollCount: 1,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '78 мкм',
    rawMaterialLabel: 'ПВД 15803-020',
    spoolType: 'Шпуля 76 мм',
    birka: 'Гост',
    warehouseCoverStatus: 'not_checked',
  }),
];

const order018Positions = [
  position({
    id: 'З-2606-018-POS-1',
    draftId: 'З-2606-018',
    rollCount: 2,
    filmType: 'Рукав',
    actualThickness: '70 мкм',
    accountingThickness: '68 мкм',
    rawMaterialLabel: 'ПВД 10803-020',
    spoolType: 'Шпуля усиленная',
    birka: 'ТУ',
    comment: 'Заявка создана зав. производства, рецепт подтверждает коммерция.',
    warehouseCoverStatus: 'partial_confirmed',
    createdBy: 'Зав. производства',
  }),
];

const order020Positions = [
  position({
    id: 'З-2606-020-POS-1',
    draftId: 'З-2606-020',
    rollCount: 1,
    filmType: 'Полотно',
    actualThickness: '40 мкм',
    accountingThickness: '40 мкм',
    rawMaterialLabel: 'ПВД 15803-020',
    spoolType: 'Шпуля клиента',
    birka: 'Промо',
    warehouseCoverStatus: 'full_confirmed',
  }),
];

const order018ProductionProblem: ProductionProblem = {
  id: 'PP-2606-018-ROLL-03',
  orderId: 'ЗН-2606-018',
  commercialOrderId: 'З-2606-018',
  positionId: 'З-2606-018-POS-1',
  rollId: 'ROLL-2606-018-03',
  reportedByRole: 'production_lead',
  reportedByUserId: 'production-lead-fil',
  targetRole: 'commercial',
  ownerRole: 'Коммерция',
  comment: 'Оператор дошел до рулона 3: текущая рецептура не совпадает с фактической толщиной, нужно решение коммерции.',
  reason: 'Текущая рецептура не совпадает с фактической толщиной на активном рулоне.',
    recovery: 'Коммерция задает изменение и рулон применения; зав. производства решает текущий рулон.',
  severity: 'warning',
  status: 'open',
  completedRolls: 2,
  currentRollNumber: 3,
  totalRolls: 5,
  createdAt: '11:14',
};

const order018ProductionProgress: CommercialProductionProgress = {
  orderId: 'ЗН-2606-018',
  completedRolls: 2,
  currentRollNumber: 3,
  totalRolls: 5,
  activeProblemIds: [order018ProductionProblem.id],
  updatedAt: '11:14',
  source: 'mock',
};

const order018MaterialShortage = materialShortageBlocker({
  id: 'MSB-2606-018-POS-1',
  commercialOrderId: 'З-2606-018',
  position: order018Positions[0],
  productionOrderId: 'ЗН-2606-018',
  usableReserveQty: 0,
});

export const commercialWorkObjects: WorkObject[] = [
  commercialObject({
    id: 'З-2606-021',
    counterparty: 'ВекторПак',
    paymentStatus: 'не оплачен',
    shipmentStatus: 'не отгружено',
    positions: order020Positions,
    proposals: [cover({ id: 'COVER-2606-021-1', position: order020Positions[0], coverType: 'full', coverQty: 1 })],
  }),
  commercialObject({
    id: 'З-2606-019',
    counterparty: 'УралПак',
    paymentStatus: 'частично оплачен',
    shipmentStatus: 'частично отгружено',
    positions: order019Positions,
    proposals: [
      cover({ id: 'COVER-2606-019-1', position: order019Positions[0], coverType: 'partial', coverQty: 2 }),
      cover({ id: 'COVER-2606-019-2', position: order019Positions[1], coverType: 'full', coverQty: 2 }),
    ],
    auditExtra: [
      { id: 'a-2606-019-inventory-conflict', objectId: 'З-2606-019', time: '10:21', actorLabel: 'Система', actionLabel: 'problem:inventory_source_conflict', detail: 'Событие разбора сохранено для последующей складской проверки.', scope: 'rawDiagnostics' },
      { id: 'a-2606-019-inventory-override', objectId: 'З-2606-019', time: '10:22', actorLabel: 'Склад', actionLabel: 'audit:inventory_fact_overrode_accounting_snapshot', detail: 'Фактический складской остаток использован поверх учета; количество к производству не блокируется.', scope: 'rawDiagnostics' },
    ],
  }),
  commercialObject({
    id: 'З-2606-017',
    counterparty: 'УралПак',
    statusLabel: 'Черновик',
    paymentStatus: 'не оплачен',
    shipmentStatus: 'не отгружено',
    positions: order017Positions,
    proposals: [cover({ id: 'COVER-2606-017-1', position: order017Positions[0], coverType: 'partial', coverQty: 0 })],
  }),
  commercialObject({
    id: 'З-2606-018',
    counterparty: 'ПакетПром',
    creatorRole: 'production_lead',
    createdBy: 'Зав. производства',
    paymentStatus: 'просрочка',
    shipmentStatus: 'не отгружено',
    assignedOperatorId: 'operator-line-a',
    priority: 'критично',
    createdOnBehalfOfRole: 'commercial',
    createdOnBehalfOfUserId: 'commercial-oleg',
    commercialDelegationConfirmed: true,
    commercialConfirmationPolicy: 'bypassed_by_delegation',
    commercialConfirmationReason: 'Заявка создана зав. производства по явному поручению коммерции; повторное подтверждение рецептуры не требуется.',
    productionStatus: 'in_production',
    productionProblems: [order018ProductionProblem],
    productionProgress: order018ProductionProgress,
    materialShortageBlockers: [order018MaterialShortage],
    positions: order018Positions,
    proposals: [cover({ id: 'COVER-2606-018-1', position: order018Positions[0], coverType: 'partial', coverQty: 1, confirmedAt: '10:34' })],
  }),
  commercialObject({
    id: 'З-2606-020',
    counterparty: 'ВекторПак',
    paymentStatus: 'оплачен',
    shipmentStatus: 'отгружено',
    positions: order020Positions,
    proposals: [cover({ id: 'COVER-2606-020-1', position: order020Positions[0], coverType: 'full', coverQty: 1, confirmedAt: '09:58' })],
  }),
];
