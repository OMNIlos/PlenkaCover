import { roleConfigs, workObjects } from './demoData';
import {
  factValueFromObject,
  financeDisplayContractFromObject,
  type FinanceSourceState,
} from './displayContracts';
import type {
  ActionDescriptor,
  ActionIntent,
  ActionLevel,
  InvoiceLifecycleStatus,
  OrderStageBadge,
  PaymentLifecycleStatus,
  Role,
  Severity,
  SyncJournalStatus,
  WorkListItem,
  WorkObject,
  WorkQueueBucket,
} from './types';
import { filterFacts, visibleObject } from './visibility';
import { businessClockAt } from './runtime/businessClock';
import { isWarehouseScanSection, warehouseObjectMatchesScanSection } from './warehouseScan';
import { paymentStageConditionLabel } from './financePaymentPolicy';
import { normalizeFinanceSection } from './financeSections';

export type WorkObjectsByRole = Record<Role, WorkObject[]>;

export function getRoleConfig(role: Role) {
  const config = roleConfigs.find((item) => item.id === role);
  if (!config) throw new Error(`Unknown role ${role}`);
  return config;
}

function warehouseObjectBelongsInQueue(object: WorkObject) {
  if (object.kind !== 'warehouseJob' || object.workbench?.type !== 'warehouse') return true;

  const blockedBeforeHandover =
    object.workbench.mode === 'receiving' &&
    object.workbench.expected === 0 &&
    object.nextOwner !== 'Склад' &&
    (object.statusLabel.toLowerCase().includes('ждет') ||
      object.workbench.blockingReason?.toLowerCase().includes('не переданы') ||
      object.actions.some((action) =>
        action.disabledReason?.toLowerCase().includes('не переданы'),
      ));

  return !blockedBeforeHandover;
}

function productionObjectBelongsInQueue(object: WorkObject) {
  const objectLabel = `${object.id} ${object.title}`.toLowerCase();
  if (object.filterTags?.includes('Штрафы')) return false;
  if (objectLabel.includes('pen-') || object.title.trim().startsWith('Штраф')) return false;
  return object.kind === 'productionOrder';
}

function productionObjectBelongsToSection(
  object: WorkObject,
  section: string,
  primarySection: string,
) {
  if (
    section === primarySection ||
    section === 'Заказ-наряды' ||
    section === 'Очередь заказ-нарядов'
  )
    return true;
  if (section === 'Все рулоны' || section === 'Операторы / загрузка')
    return Boolean(object.productionRollDispatchItems?.length);
  return object.filterTags?.includes(section) ?? object.statusLabel === section;
}

function warehouseObjectBelongsToSection(
  object: WorkObject,
  section: string,
  primarySection: string,
) {
  if (isWarehouseScanSection(section)) {
    return warehouseObjectMatchesScanSection(object, section);
  }
  if (section === primarySection)
    return object.filterTags?.includes(section) ?? object.statusLabel === section;
  return object.filterTags?.includes(section) ?? object.statusLabel === section;
}

function listSummaryForObject(role: Role, object: WorkObject) {
  if (role === 'commercial') return commercialListSummary(object);
  const sectionFact = object.sections[0]?.facts.find((fact) => {
    const value = fact.value.trim();
    return value.length > 0 && value !== '0';
  });
  return sectionFact?.value ?? object.nextOwner;
}

function objectsForRoleQueue(role: Role, objectsByRole: WorkObjectsByRole) {
  const objects = objectsByRole[role];
  if (role === 'production') return objects.filter(productionObjectBelongsInQueue);
  if (role === 'warehouse') return objects.filter(warehouseObjectBelongsInQueue);
  return objects;
}

const completedStatusLabels = new Set([
  'Готово',
  'Закрыто',
  'Передано',
  'Передано на склад',
  'Выдано',
  'Оплачено',
]);

function statusIsCompletedForRole(role: Role, statusLabel: string) {
  if (role === 'commercial' && statusLabel === 'Передано') return false;
  return completedStatusLabels.has(statusLabel);
}

function extractIsoDate(...values: Array<string | undefined>) {
  for (const value of values) {
    const match = value?.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (match) return match[1];
  }
  return undefined;
}

function objectHasOpenProblem(object: WorkObject) {
  return (
    object.problems.some((problem) => problem.status === 'open') ||
    Boolean(object.productionProblems?.some((problem) => problem.status !== 'resolved'))
  );
}

function objectHasDisabledAction(object: WorkObject) {
  return object.actions.some((action) => {
    if (action.level !== 'disabled') return false;
    const text =
      `${action.label} ${action.disabledReason ?? ''} ${action.recoveryAction ?? ''}`.toLowerCase();
    const isClosedReadOnlyState =
      text.includes('уже ') ||
      text.includes('истори') ||
      text.includes('закрыт') ||
      text.includes('подтвержден') ||
      text.includes('принято') ||
      text.includes('согласован');
    return !isClosedReadOnlyState;
  });
}

function genericObjectDateKey(object: WorkObject) {
  const factDate = extractIsoDate(
    ...object.facts.map((fact) => fact.value),
    ...object.sections.flatMap((section) => section.facts.map((fact) => fact.value)),
    object.paymentIndicator?.lastUpdatedAt,
    object.paymentSchedule?.dueDateLabel,
    object.audit[0]?.detail,
    object.audit[0]?.newValue,
  );
  return factDate;
}

function archiveReasonForObject(role: Role, object: WorkObject) {
  if (role === 'finance') {
    const item = getFinanceCommandItem(object);
    if (item.paymentStatus === 'paid') return 'оплата закрыта';
  }
  if (object.filterTags?.includes('Закрытые')) return 'закрытая операция';
  if (object.filterTags?.includes('Переданы на склад')) return 'передано на склад';
  if (object.filterTags?.includes('Готов к счету')) return 'передано в финансовый контур';
  if (completedStatusLabels.has(object.statusLabel)) return object.statusLabel.toLowerCase();
  return 'завершено';
}

export function getWorkQueueMeta(
  role: Role,
  object: WorkObject,
  now?: Date,
): Pick<
  WorkListItem,
  'queueBucket' | 'dateKey' | 'archiveReason' | 'completedAt' | 'lastActionAt'
> {
  const effectiveNow = now ?? new Date();
  const todayIso = businessClockAt(effectiveNow).dateIso;
  const lastActionAt = object.audit[0]?.time;
  const baseDateKey = genericObjectDateKey(object);
  const hasOpenProblem = objectHasOpenProblem(object);
  const isBlocked =
    object.severity === 'critical' || hasOpenProblem || objectHasDisabledAction(object);

  if (role === 'finance' && object.kind === 'financeOrder') {
    const item = getFinanceCommandItem(object, effectiveNow);
    const dateKey = item.dueDateIso ?? baseDateKey;
    if (item.paymentStatus === 'paid') {
      return {
        queueBucket: 'completed',
        dateKey,
        archiveReason: archiveReasonForObject(role, object),
        completedAt: lastActionAt,
        lastActionAt,
      };
    }
    if (item.exceptionKind !== 'none' || item.sourceState === 'source_error' || isBlocked) {
      return { queueBucket: 'blocked', dateKey, lastActionAt };
    }
    if (dateKey && dateKey >= todayIso) return { queueBucket: 'scheduled', dateKey, lastActionAt };
    return { queueBucket: 'active', dateKey, lastActionAt };
  }

  const completedByRole =
    statusIsCompletedForRole(role, object.statusLabel) ||
    object.filterTags?.includes('Закрытые') ||
    object.filterTags?.includes('Завершены') ||
    (role === 'production' &&
      (object.filterTags?.includes('Готов к счету') || object.statusLabel === 'Готов к счету')) ||
    (role === 'warehouse' && object.filterTags?.includes('Закрытые'));

  if (
    role === 'admin' &&
    ['Готово', 'Источник в норме', '1С отвечает', '1С проверена'].includes(object.statusLabel) &&
    (object.filterTags?.includes('Устройства') || object.filterTags?.includes('Источники'))
  ) {
    return { queueBucket: 'active', dateKey: baseDateKey, lastActionAt };
  }

  if (completedByRole) {
    return {
      queueBucket: 'completed',
      dateKey: baseDateKey,
      archiveReason: archiveReasonForObject(role, object),
      completedAt: lastActionAt,
      lastActionAt,
    };
  }
  if (isBlocked) return { queueBucket: 'blocked', dateKey: baseDateKey, lastActionAt };
  if (baseDateKey && baseDateKey >= todayIso)
    return { queueBucket: 'scheduled', dateKey: baseDateKey, lastActionAt };
  return { queueBucket: 'active', dateKey: baseDateKey, lastActionAt };
}

function queueBucketMatchesFilter(filter: string, bucket: WorkQueueBucket) {
  if (filter === 'Архив' || filter === 'Завершены')
    return bucket === 'completed' || bucket === 'archived';
  if (filter === 'Все')
    return bucket === 'active' || bucket === 'scheduled' || bucket === 'blocked';
  return bucket !== 'completed' && bucket !== 'archived';
}

function commercialProductionProgressLabel(
  object: WorkObject,
  fallback = 'Производство стартовало',
) {
  const progress = object.commercialProductionProgress;
  if (!progress) return fallback;
  return `${progress.completedRolls}/${progress.totalRolls} рул.; текущий ${progress.currentRollNumber}`;
}

export function getCommercialOrderStage(object: WorkObject): OrderStageBadge | undefined {
  const order = object.commercialOrder;
  if (!order) return undefined;

  const proposals = object.warehouseCoverProposals ?? [];
  const missingQty = proposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
  const hasPendingWarehouseProposal = proposals.some((proposal) => !proposal.confirmedAt);
  const hasConfirmedPartialCover = proposals.some(
    (proposal) => proposal.confirmedAt && proposal.missingQty > 0,
  );
  const openProductionProblem = object.productionProblems?.find(
    (problem) => problem.status !== 'resolved',
  );
  const productionStarted =
    order.productionStatus === 'in_production' ||
    order.productionStatus === 'ready' ||
    Boolean(object.commercialProductionProgress) ||
    Boolean(openProductionProblem);
  const markedInWork =
    object.filterTags?.includes('В работе') && !object.filterTags?.includes('Входящие заявки');
  const transferred =
    object.statusLabel === 'Передано' ||
    object.filterTags?.includes('Передано') ||
    object.filterTags?.includes('Передано в заказ-наряд');

  if (order.status === 'draft' || object.statusLabel === 'Черновик') {
    return {
      label: 'Черновик',
      bucket: 'Черновики',
      detail: 'Не передано',
      severity: 'warning',
    };
  }

  if (openProductionProblem) {
    const completed =
      openProductionProblem.completedRolls ??
      object.commercialProductionProgress?.completedRolls ??
      0;
    const total =
      openProductionProblem.totalRolls ?? object.commercialProductionProgress?.totalRolls ?? '?';
    const current =
      openProductionProblem.currentRollNumber ??
      object.commercialProductionProgress?.currentRollNumber ??
      '?';
    return {
      label: 'Проблема',
      bucket: 'В работе',
      detail: `${completed}/${total} рул.; текущий ${current}`,
      severity: openProductionProblem.severity,
    };
  }

  if (productionStarted) {
    return {
      label: 'В работе',
      bucket: 'В работе',
      detail: commercialProductionProgressLabel(object),
      severity: 'info',
    };
  }

  if (markedInWork) {
    return {
      label: 'В работе',
      bucket: 'В работе',
      detail: 'Бухгалтерия подтвердила оплату',
      severity: 'info',
    };
  }

  if (
    object.statusLabel === 'В бухгалтерии' ||
    object.filterTags?.includes('Направлено в бухгалтерию')
  ) {
    return {
      label: 'В бухгалтерии',
      bucket: 'Входящие заявки',
      detail: 'У бухгалтерии',
      severity: 'info',
    };
  }

  if (transferred) {
    return {
      label: 'Передано',
      bucket: 'В работе',
      detail: 'У зав. производства',
      severity: 'info',
    };
  }

  if (hasPendingWarehouseProposal) {
    return {
      label: 'Склад',
      bucket: 'Входящие заявки',
      detail: missingQty > 0 ? `${missingQty} рул. нужно произвести` : 'Нужно подтвердить покрытие',
      severity: missingQty > 0 ? 'warning' : 'info',
    };
  }

  if (hasConfirmedPartialCover) {
    return {
      label: 'Остаток в производство',
      bucket: 'Входящие заявки',
      detail: `${missingQty} рул. в производство`,
      severity: 'warning',
    };
  }

  if (order.shipmentStatus === 'отгружено') {
    return {
      label: 'Отгружено',
      bucket: 'Входящие заявки',
      detail: 'Выдача закрыта',
      severity: 'info',
    };
  }

  if (order.shipmentStatus === 'частично отгружено') {
    return {
      label: 'К отгрузке',
      bucket: 'Входящие заявки',
      detail: 'Проверить выдачу',
      severity: 'info',
    };
  }

  return {
    label: 'Оформление',
    bucket: 'Входящие заявки',
    detail: 'Коммерция ведет заявку',
    severity: 'info',
  };
}

export function commercialObjectBelongsToSection(object: WorkObject, section: string) {
  const stage = getCommercialOrderStage(object);
  if (!stage) return object.filterTags?.includes(section) ?? object.statusLabel === section;
  return stage.bucket === section;
}

const positiveScenarioIds: Partial<Record<Role, string[]>> = {
  commercial: ['З-2606-021', 'З-2606-019'],
  production: ['ЗН-2606-014'],
  finance: ['FIN-2606-014'],
  director: ['DIR-2606-004'],
  warehouse: ['WH-2606-042', 'WH-INV-RAW', 'WH-2606-047'],
  admin: ['ADM-DEVICE-SCALE-A-01', 'ADM-DEVICE-1c-payment-status'],
};

const problemFirstSections = new Set([
  'Заблокированы',
  'С проблемами',
  'Ошибки QR',
  'Исключения',
  'Проблемы / история',
  'Штрафы',
  'Сверка источников',
]);

export type DisplayOrderMode = 'positiveFirst' | 'exceptionFirst';
export type FinanceCommandSortMode = DisplayOrderMode;

export function displayOrderModeForSection(section?: string, filter = 'Все'): DisplayOrderMode {
  if (filter !== 'Все' && (filter === 'Заблокированы' || filter === 'С проблемами'))
    return 'exceptionFirst';
  return section && problemFirstSections.has(section) ? 'exceptionFirst' : 'positiveFirst';
}

function shouldPromotePositiveScenario(section?: string, filter = 'Все') {
  return displayOrderModeForSection(section, filter) === 'positiveFirst';
}

function positiveScenarioRank(role: Role, object: WorkObject, section?: string, filter = 'Все') {
  if (!shouldPromotePositiveScenario(section, filter)) return 0;
  const explicitRank = positiveScenarioIds[role]?.indexOf(object.id) ?? -1;
  if (explicitRank >= 0) return -100 + explicitRank;
  const hasOpenProblem = objectHasOpenProblem(object);
  const hasBlockingSeverity = object.severity === 'critical';
  const hasSystemErrorLabel = /ошибка|просроч|чужой qr|офлайн|заблок/i.test(
    `${object.statusLabel} ${object.title}`,
  );
  if (!hasOpenProblem && !hasBlockingSeverity && !hasSystemErrorLabel) return -10;
  return 0;
}

function sortPositiveFirst(role: Role, objects: WorkObject[], section?: string, filter = 'Все') {
  if (role === 'admin' && section === 'Проблемы / история') {
    return [...objects].sort((left, right) => {
      if (left.id === 'ADM-HISTORY-01') return -1;
      if (right.id === 'ADM-HISTORY-01') return 1;
      const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
      return (
        rank[left.severity] - rank[right.severity] ||
        (objectHasOpenProblem(left) === objectHasOpenProblem(right)
          ? 0
          : objectHasOpenProblem(left)
            ? -1
            : 1)
      );
    });
  }
  if (displayOrderModeForSection(section, filter) === 'exceptionFirst') {
    const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
    return [...objects].sort(
      (left, right) =>
        rank[left.severity] - rank[right.severity] ||
        (objectHasOpenProblem(left) === objectHasOpenProblem(right)
          ? 0
          : objectHasOpenProblem(left)
            ? -1
            : 1),
    );
  }
  return [...objects].sort(
    (left, right) =>
      positiveScenarioRank(role, left, section, filter) -
      positiveScenarioRank(role, right, section, filter),
  );
}

function commercialListSummary(object: WorkObject) {
  const positions = object.commercialOrder?.positions ?? [];
  if (positions.length === 0) return object.sections[0]?.facts[0]?.value ?? object.nextOwner;

  const totalRolls = positions.reduce((sum, position) => sum + position.rollCount, 0);
  const first = positions[0];
  const firstSpecs = [first.filmType, first.actualThickness, first.rawMaterialLabel]
    .filter(Boolean)
    .join(', ');
  const suffix = positions.length > 1 ? ` · ${positions.length} поз.` : '';
  return `${totalRolls} рул. · ${firstSpecs}${suffix}`;
}

export function getObjectsForRole(role: Role, objectsByRole: WorkObjectsByRole = workObjects) {
  return sortPositiveFirst(role, objectsForRoleQueue(role, objectsByRole)).map((object) =>
    visibleObject(role, object),
  );
}

export function getListItems(
  role: Role,
  filter: string,
  section?: string,
  objectsByRole: WorkObjectsByRole = workObjects,
  now = new Date(),
): WorkListItem[] {
  const primarySection = getRoleConfig(role).nav[0];
  const objects = objectsForRoleQueue(role, objectsByRole);
  const sectionFiltered = objects.filter((object) => {
    if (!section) return true;
    if (role === 'commercial') return commercialObjectBelongsToSection(object, section);
    if (role === 'finance') return financeObjectBelongsToSection(object, section, now);
    if (role === 'admin')
      return object.filterTags?.includes(section) ?? object.statusLabel === section;
    if (role === 'production')
      return productionObjectBelongsToSection(object, section, primarySection);
    if (role === 'warehouse')
      return warehouseObjectBelongsToSection(object, section, primarySection);
    if (section === primarySection) return true;
    return object.filterTags?.includes(section) ?? object.statusLabel === section;
  });
  const filtered = sectionFiltered.filter((object) => {
    const queueMeta = getWorkQueueMeta(role, object, now);
    if (!queueBucketMatchesFilter(filter, queueMeta.queueBucket)) return false;
    if (filter === 'Все') return true;
    if (filter === 'Требуют действия' && role === 'finance')
      return financeObjectNeedsPaymentAction(object);
    if (filter === 'Требуют действия')
      return object.actions.some(
        (action) => action.enabled && ['recommended', 'peer'].includes(action.level),
      );
    if (filter === 'Заблокированы') return queueMeta.queueBucket === 'blocked';
    if (filter === 'С проблемами') {
      return objectHasOpenProblem(object);
    }
    if (filter === 'Архив' || filter === 'Завершены') return true;
    return object.filterTags?.includes(filter) ?? true;
  });

  return sortPositiveFirst(role, filtered, section, filter).map((object) => {
    const orderStage = role === 'commercial' ? getCommercialOrderStage(object) : undefined;
    const queueMeta = getWorkQueueMeta(role, object, now);
    return {
      id: object.id,
      kind: object.kind,
      title: object.title,
      summary: listSummaryForObject(role, object),
      statusLabel: object.statusLabel,
      orderStage,
      severity: object.severity,
      nextOwner: object.nextOwner,
      lastEventAt: object.audit[0]?.time ?? '--:--',
      problemCount:
        object.problems.filter((problem) => problem.status === 'open').length +
        (object.productionProblems?.filter((problem) => problem.status !== 'resolved').length ?? 0),
      roleFields: filterFacts(role, object.facts).slice(0, role === 'admin' ? 2 : 3),
      filterTags: object.filterTags ?? [],
      ...queueMeta,
      newness: object.newness,
    };
  });
}

export function getSelectedObject(
  role: Role,
  selectedId: string | null,
  objectsByRole: WorkObjectsByRole = workObjects,
): WorkObject | null {
  const objects = getObjectsForRole(role, objectsByRole);
  if (!selectedId) return null;
  return objects.find((object) => object.id === selectedId) ?? null;
}

export function getDefaultSelection(
  role: Role,
  objectsByRole: WorkObjectsByRole = workObjects,
  section?: string,
  filter = 'Все',
): string | null {
  const activeSection = section ?? getRoleConfig(role).nav[0];
  const listItems = getListItems(role, filter, activeSection, objectsByRole);
  if (listItems.length === 0) return null;
  const preferredIds = positiveScenarioIds[role] ?? [];
  return (
    preferredIds.find((id) => listItems.some((item) => item.id === id)) ?? listItems[0]?.id ?? null
  );
}

export function actionGroups(actions: ActionDescriptor[]) {
  return {
    primary: actions.filter((action) => action.level === 'recommended'),
    peer: actions.filter((action) => action.level === 'peer'),
    secondary: actions.filter((action) => action.level === 'secondary'),
    destructive: actions.filter((action) => action.level === 'destructive'),
    disabled: actions.filter((action) => action.level === 'disabled'),
  };
}

export function commonFilters() {
  return ['Все', 'Требуют действия', 'Заблокированы', 'С проблемами', 'Архив'];
}

export function queueFiltersForRole(role: Role) {
  if (role === 'finance') return ['Все', 'Требуют действия', 'С проблемами', 'Архив'];
  return commonFilters();
}

/**
 * «Действия» у бухгалтерии — заказы в обработке, где счет уже выставлялся
 * и требуется повторное действие по оплате (проверка/очередной платеж).
 */
export function financeObjectNeedsPaymentAction(object: WorkObject) {
  const item = getFinanceCommandItem(object);
  return (
    item.invoiceStatus !== 'waiting_invoice' &&
    item.paymentStatus !== 'paid' &&
    item.paymentStatus !== 'not_expected'
  );
}

export type CommercialNextStep = {
  actionId: string;
  label: string;
  level: ActionLevel;
  owner: string;
  affectedBlock: string;
  severity: Severity;
  actionIntent?: ActionIntent;
  disabledReason?: string;
  nextStep?: string;
};

export type FinanceNextStep = {
  stateLabel: string;
  now: string;
  why: string;
  after: string;
  owner: string;
  primaryAction: ActionDescriptor;
  secondaryActions: ActionDescriptor[];
  timeline: Array<{
    label: string;
    value: string;
    state: 'done' | 'active' | 'warning' | 'blocked';
  }>;
};

export type FinanceCommandMode =
  | 'overview'
  | 'invoices'
  | 'payments'
  | 'installments'
  | 'source_reconciliation'
  | 'exceptions'
  | 'history';

export type FinanceExceptionKind =
  | 'none'
  | 'overdue'
  | 'source_error'
  | 'delivery_blocked'
  | 'unmatched_payment'
  | 'billing_blocker'
  | 'partial_payment';

export type FinanceEvidenceTimeline = Array<{
  label: string;
  value: string;
  state: 'done' | 'active' | 'warning' | 'blocked';
}>;

export type FinanceCommandItem = {
  id: string;
  title: string;
  orderNumber: string;
  customer: string;
  invoiceStatus: InvoiceLifecycleStatus;
  invoiceLabel: string;
  paymentStatus: PaymentLifecycleStatus;
  paymentLabel: string;
  shipmentLabel: string;
  paymentShipmentLabel: string;
  paymentKindLabel: string;
  amount: string;
  paid: string;
  remaining: string;
  dueLabel: string;
  dueDateIso?: string;
  createdAtIso?: string;
  monthKey?: string;
  sourceFreshness: string;
  sourceLabel: string;
  sourceStatus: SyncJournalStatus;
  mode: FinanceCommandMode;
  priority: number;
  amountRisk: string;
  dueBucket: string;
  sourceState: FinanceSourceState;
  exceptionKind: FinanceExceptionKind;
  recommendedAction: string;
  severity: Severity;
  auditEvidence: string;
};

export type FinanceCalendarEventKind =
  | 'due_today'
  | 'overdue'
  | 'installment'
  | 'invoice'
  | 'source_error'
  | 'paid'
  | 'payment';

export type FinanceCalendarEvent = {
  id: string;
  objectId: string;
  day?: number;
  dateLabel: string;
  title: string;
  customer: string;
  amountLabel: string;
  kind: FinanceCalendarEventKind;
  sourceState: FinanceSourceState;
  severity: Severity;
  recommendedAction: string;
  dateIso?: string;
  monthKey?: string;
  dateKind: 'actual' | 'unavailable';
  percentageLabel?: string;
};

export type FinancePaymentCondition = {
  id: string;
  objectId: string;
  title: string;
  customer: string;
  amountLabel: string;
  conditionLabel: string;
  dateKind: 'condition';
  percentageLabel?: string;
};

function financeViewPaymentsAction(object: WorkObject): ActionDescriptor {
  return {
    id: `finance-view-payments:${object.id}`,
    label: 'Показать выплаты',
    level: 'recommended',
    enabled: true,
  };
}

function isUnsupportedFinanceAction(action: ActionDescriptor) {
  const text = `${action.id} ${action.label}`.toLowerCase();
  return (
    text.includes('finance-history') ||
    text.includes('открыть истори') ||
    text.includes('finance-retry-sync') ||
    text.includes('повторить проверку источника')
  );
}

export function getFinanceNextStep(object: WorkObject, businessNow?: Date): FinanceNextStep {
  const contract = financeDisplayContractFromObject(object, businessNow);
  const invoiceStatus = contract.invoiceStatus;
  const paymentStatus = contract.paymentStatus;
  const sourceIssue =
    contract.sourceState === 'source_error' ||
    invoiceStatus === 'sync_error' ||
    paymentStatus === 'sync_error';
  const overdue = paymentStatus === 'overdue' || invoiceStatus === 'overdue';
  const dueToday =
    paymentStatus === 'payment_due_today' ||
    invoiceStatus === 'payment_due_today' ||
    object.paymentSchedule?.status === 'due_today';
  const paid = paymentStatus === 'paid';
  const partial = paymentStatus === 'partial';
  const installmentRunning =
    paymentStatus === 'installment_running' || invoiceStatus === 'installment_running';
  const waitingInvoice = invoiceStatus === 'waiting_invoice';
  const invoiceSent = invoiceStatus === 'issued';
  const deliveryBlocked =
    paymentStatus === 'waiting_delivery' || invoiceStatus === 'waiting_delivery';
  const visibleActions = paid
    ? [
        object.actions.find((action) => action.id.startsWith('finance-view-payments:')) ??
          financeViewPaymentsAction(object),
      ]
    : object.actions.filter((action) => !isUnsupportedFinanceAction(action));
  const enabledActions = visibleActions.filter((action) => action.enabled);
  const primaryAction =
    enabledActions.find((action) => ['recommended', 'peer'].includes(action.level)) ??
    enabledActions[0] ??
    financeViewPaymentsAction(object);
  const secondaryActions = visibleActions.filter(
    (action) => action.id !== primaryAction.id && action.level !== 'disabled',
  );

  let stateLabel = object.statusLabel;
  let now = 'Проверить финансовую строку';
  let why = 'Есть финансовое состояние, которое нужно подтвердить.';
  let after = 'Действие запишется в историю финансового объекта.';

  if (sourceIssue) {
    stateLabel = 'ошибка источника';
    now = 'Передать ошибку на ручную проверку';
    why = 'Финансовая строка требует ручного подтверждения перед оплатой.';
    after = 'Будет создана адресная проблема без запуска автоматического обмена.';
  } else if (overdue) {
    stateLabel = 'просрочка';
    now = 'Разобрать просрочку оплаты';
    why = 'Плановая дата оплаты прошла, остаток еще открыт.';
    after =
      'Поступление будет проверено, ручное изменение оплаты запишется отдельно или просрочка уйдет в проблему с владельцем.';
  } else if (dueToday && invoiceSent) {
    stateLabel = 'к оплате';
    now = 'Проверить поступление по графику';
    why = 'Счет к оплате уже отправлен, сегодня дата планового платежа.';
    after =
      'Проверка поступления запишется в историю; оплату закрывает только отдельное ручное обновление.';
  } else if (dueToday) {
    stateLabel = 'к оплате';
    now = 'Выставить счет к оплате';
    why = 'Сегодня дата планового платежа по графику.';
    after = 'Бухгалтерия увидит передачу, а отправка останется ручной зоной до настройки.';
  } else if (paid) {
    stateLabel = 'оплачен';
    now = 'Посмотреть выплаты';
    why = 'Сумма закрыта, остаток по строке равен нулю.';
    after = 'Откроется журнал выплат без изменения финансового состояния.';
  } else if (partial) {
    stateLabel = 'частично оплачен';
    now = 'Проверить поступление по остатку';
    why = 'Часть суммы уже оплачена, остаток остается открытым.';
    after =
      'Строка останется частичной или изменится только после отдельного ручного обновления оплаты.';
  } else if (installmentRunning) {
    stateLabel = 'рассрочка';
    now = 'Проверить поступление по графику';
    why = 'Срок рассрочки идет, остаток остается открытым до платежа.';
    after =
      'Проверка поступления запишется в историю; изменение оплаты выполняется отдельным ручным действием.';
  } else if (deliveryBlocked) {
    stateLabel = 'ждет выдачу';
    now = 'Дождаться закрытой выдачи';
    why = 'Рассрочка стартует после складской выдачи.';
    after = 'После выдачи появится график платежа и дата оплаты.';
  } else if (waitingInvoice) {
    stateLabel = 'счет не создан';
    if (contract.searchText.includes('наличн') || object.statusLabel === 'Ручная операция') {
      now = 'Сверить наличную операцию';
      why = 'Наличная операция требует ручной бухгалтерской сверки.';
      after = 'Результат сверки запишется в историю без обещания автоматического обмена.';
    } else {
      now = 'Выставить счет';
      why = 'Заказ-наряд согласован и готов к финансовому действию.';
      after = 'Ручная передача уйдет бухгалтерии; автоматическая отправка не обещается.';
    }
  } else if (invoiceSent) {
    stateLabel = 'счет отправлен';
    now = 'Проверить поступление по счету';
    why = 'Счет уже отправлен, оплата еще не закрыта.';
    after = 'После оплаты строка перейдет в оплаченные или частичные.';
  }

  const invoiceDone = invoiceSent || paid || partial || overdue || dueToday;
  const paymentValue = contract.paymentLabel;
  const shipmentValue = contract.shipmentDateLabel;
  const installmentValue = contract.installmentLabel;

  return {
    stateLabel,
    now,
    why,
    after,
    owner: object.nextOwner,
    primaryAction,
    secondaryActions,
    timeline: [
      {
        label: 'заказ-наряд',
        value: factValueFromObject(object, 'Заказ-наряд') ?? 'согласован',
        state: 'done',
      },
      {
        label: 'счет',
        value: contract.invoiceLabel || stateLabel,
        state: sourceIssue ? 'blocked' : invoiceDone ? 'done' : 'active',
      },
      {
        label: 'выдача',
        value: shipmentValue,
        state: deliveryBlocked
          ? 'warning'
          : shipmentValue.includes('нет данных')
            ? 'active'
            : 'done',
      },
      {
        label: 'оплата',
        value: paymentValue,
        state:
          overdue || sourceIssue
            ? 'blocked'
            : partial || dueToday
              ? 'warning'
              : paid
                ? 'done'
                : 'active',
      },
      {
        label: 'рассрочка',
        value: installmentValue,
        state: overdue ? 'blocked' : paid ? 'done' : partial || dueToday ? 'warning' : 'active',
      },
    ],
  };
}

function financeCommandMode(
  contract: ReturnType<typeof financeDisplayContractFromObject>,
): FinanceCommandMode {
  const combinedStatus = contract.searchText;
  const sourceState = contract.sourceState;
  if (sourceState === 'source_error' || sourceState === 'manual_check')
    return 'source_reconciliation';
  if (contract.paymentStatus === 'overdue' || combinedStatus.includes('проблем'))
    return 'exceptions';
  if (
    contract.paymentStatus === 'installment_running' ||
    contract.paymentStatus === 'payment_due_today'
  )
    return 'installments';
  if (
    contract.paymentStatus === 'paid' ||
    contract.paymentStatus === 'partial' ||
    contract.paymentStatus === 'unpaid'
  )
    return 'payments';
  if (
    contract.invoiceStatus === 'waiting_invoice' ||
    contract.invoiceStatus === 'issued' ||
    contract.invoiceStatus === 'payment_due_today'
  )
    return 'invoices';
  return 'overview';
}

function financeExceptionKind(
  contract: ReturnType<typeof financeDisplayContractFromObject>,
): FinanceExceptionKind {
  const combinedStatus = contract.searchText;
  if (contract.paymentStatus === 'overdue') return 'overdue';
  if (contract.paymentStatus === 'partial') return 'partial_payment';
  if (contract.invoiceStatus === 'waiting_invoice') return 'billing_blocker';
  if (contract.sourceState === 'source_error') return 'source_error';
  if (
    contract.paymentStatus === 'waiting_delivery' ||
    contract.invoiceStatus === 'waiting_delivery'
  )
    return 'delivery_blocked';
  if (combinedStatus.includes('ждет выдачу') || combinedStatus.includes('выдача еще не закрыта'))
    return 'delivery_blocked';
  if (combinedStatus.includes('неразнес')) return 'unmatched_payment';
  if (combinedStatus.includes('не выставлен') || combinedStatus.includes('счет не создан'))
    return 'billing_blocker';
  if (combinedStatus.includes('частич')) return 'partial_payment';
  return 'none';
}

function financePriority(
  mode: FinanceCommandMode,
  exceptionKind: FinanceExceptionKind,
  severity: Severity,
) {
  if (severity === 'critical' || exceptionKind === 'overdue') return 0;
  if (exceptionKind === 'source_error') return 1;
  if (mode === 'installments') return 2;
  if (exceptionKind === 'billing_blocker') return 3;
  if (exceptionKind === 'partial_payment') return 4;
  if (mode === 'payments') return 5;
  return 8;
}

function financePositivePriority(item: FinanceCommandItem) {
  if (item.id === 'FIN-2606-014') return -100;
  if (
    item.severity === 'critical' ||
    item.exceptionKind === 'overdue' ||
    item.sourceState === 'source_error'
  )
    return 40;
  if (item.mode === 'invoices' || item.exceptionKind === 'billing_blocker') return 0;
  if (item.mode === 'payments' || item.exceptionKind === 'partial_payment') return 1;
  if (item.mode === 'installments') return 2;
  if (item.mode === 'overview' || item.exceptionKind === 'none') return 3;
  if (item.mode === 'source_reconciliation') return 30;
  if (item.mode === 'exceptions') return 35;
  return 20;
}

function sortFinanceCommandItems(items: FinanceCommandItem[], sortMode: FinanceCommandSortMode) {
  const compareDueDate = (left: FinanceCommandItem, right: FinanceCommandItem) =>
    (left.dueDateIso ?? '9999-12-31').localeCompare(right.dueDateIso ?? '9999-12-31');
  const compareCreatedAt = (left: FinanceCommandItem, right: FinanceCommandItem) =>
    (right.createdAtIso ?? '').localeCompare(left.createdAtIso ?? '');
  if (sortMode === 'exceptionFirst') {
    return [...items].sort(
      (left, right) =>
        left.priority - right.priority ||
        compareDueDate(left, right) ||
        left.id.localeCompare(right.id),
    );
  }
  return [...items].sort(
    (left, right) =>
      financePositivePriority(left) - financePositivePriority(right) ||
      left.priority - right.priority ||
      compareDueDate(left, right) ||
      compareCreatedAt(left, right) ||
      left.id.localeCompare(right.id),
  );
}

function financeDueBucket(contract: ReturnType<typeof financeDisplayContractFromObject>) {
  return contract.dueDateLabel;
}

function financePaymentShipmentRelation(
  contract: ReturnType<typeof financeDisplayContractFromObject>,
) {
  const shipment = contract.shipmentDateLabel;
  const hasShipment = shipment !== 'нет данных';

  if (
    contract.paymentStatus === 'waiting_delivery' ||
    contract.invoiceStatus === 'waiting_delivery'
  ) {
    return 'оплата после выдачи';
  }
  if (!hasShipment && contract.paymentStatus === 'paid') return 'оплата есть, выдача не закрыта';
  if (!hasShipment) return 'выдача не закрыта';
  if (contract.paymentStatus === 'paid') return 'выдача и оплата закрыты';
  if (contract.paymentStatus === 'partial') return 'выдача есть, остаток открыт';
  if (contract.paymentStatus === 'overdue') return 'выдача есть, просрочка';
  if (
    contract.paymentStatus === 'installment_running' ||
    contract.paymentStatus === 'payment_due_today'
  )
    return 'выдача запустила график';
  return 'связь требует сверки';
}

export function getFinanceCommandItem(object: WorkObject, now?: Date): FinanceCommandItem {
  const contract = financeDisplayContractFromObject(object, now);
  const mode = financeCommandMode(contract);
  const exceptionKind = financeExceptionKind(contract);
  const nextStep = getFinanceNextStep(object, now);
  const dueBucket = financeDueBucket(contract);
  const monthKey = contract.dueDateIso?.slice(0, 7);

  return {
    id: object.id,
    title: object.title,
    orderNumber: contract.orderNumber,
    customer: contract.customer,
    invoiceStatus: contract.invoiceStatus,
    invoiceLabel: contract.invoiceLabel,
    paymentStatus: contract.paymentStatus,
    paymentLabel: contract.paymentLabel,
    shipmentLabel: contract.shipmentDateLabel,
    paymentShipmentLabel: financePaymentShipmentRelation(contract),
    paymentKindLabel: contract.paymentKindLabel,
    amount: contract.amountLabel,
    paid: contract.amountPaidLabel,
    remaining: contract.amountRemainingLabel,
    dueLabel: contract.dueDateLabel,
    dueDateIso: contract.dueDateIso,
    createdAtIso: object.financeCreatedAt,
    monthKey,
    sourceFreshness: contract.sourceFreshnessLabel,
    sourceLabel: contract.sourceLabel,
    sourceStatus: contract.sourceStatus,
    mode,
    priority: financePriority(mode, exceptionKind, object.severity),
    amountRisk:
      exceptionKind === 'overdue' || exceptionKind === 'partial_payment'
        ? contract.amountRemainingLabel
        : contract.amountLabel,
    dueBucket,
    sourceState: contract.sourceState,
    exceptionKind,
    recommendedAction: nextStep.primaryAction.label,
    severity: object.severity,
    auditEvidence: contract.auditEvidenceLabel,
  };
}

export function getFinanceCommandItems(
  objects: WorkObject[],
  sortMode: FinanceCommandSortMode = 'positiveFirst',
  now?: Date,
) {
  const effectiveNow = now ?? new Date();
  const items = objects
    .filter((object) => object.kind === 'financeOrder')
    .map((object) => getFinanceCommandItem(object, effectiveNow));
  return sortFinanceCommandItems(items, sortMode);
}

export function getFinanceCommandCounters(objects: WorkObject[], now?: Date) {
  const items = getFinanceCommandItems(objects, 'positiveFirst', now);
  const count = (predicate: (item: FinanceCommandItem) => boolean) =>
    items.filter(predicate).length;
  return [
    {
      id: 'waiting-invoice',
      label: 'Ждут счета',
      value: count(
        (item) =>
          item.exceptionKind === 'billing_blocker' || item.invoiceStatus === 'waiting_invoice',
      ),
    },
    {
      id: 'due-today',
      label: 'Оплата сегодня',
      value: count((item) => item.dueBucket === 'сегодня'),
    },
    { id: 'overdue', label: 'Просрочка', value: count((item) => item.exceptionKind === 'overdue') },
    {
      id: 'source-error',
      label: 'Ошибка источника',
      value: count((item) => item.sourceState === 'source_error'),
    },
    {
      id: 'unmatched',
      label: 'Неразнесенные оплаты',
      value: count((item) => item.exceptionKind === 'unmatched_payment'),
    },
    {
      id: 'installments',
      label: 'Рассрочка',
      value: count(
        (item) => item.mode === 'installments' || item.paymentStatus === 'installment_running',
      ),
    },
  ];
}

function financeCalendarKind(item: FinanceCommandItem): FinanceCalendarEventKind {
  if (item.sourceState === 'source_error') return 'source_error';
  if (item.exceptionKind === 'overdue') return 'overdue';
  if (item.dueBucket === 'сегодня') return 'due_today';
  if (item.mode === 'installments') return 'installment';
  if (item.mode === 'invoices' || item.exceptionKind === 'billing_blocker') return 'invoice';
  if (item.paymentStatus === 'paid') return 'paid';
  return 'payment';
}

function financeCalendarDay(item: FinanceCommandItem) {
  if (item.dueDateIso) return Number(item.dueDateIso.slice(8, 10));
  return undefined;
}

function financeCalendarDateLabel(item: FinanceCommandItem) {
  if (item.exceptionKind === 'overdue') return 'Просрочено';
  if (item.dueBucket === 'сегодня') return 'Сегодня';
  if (item.dueBucket === 'не назначен') return 'Без даты';
  return item.dueBucket;
}

export function getFinanceCalendarEvents(
  objects: WorkObject[],
  now?: Date,
): FinanceCalendarEvent[] {
  const effectiveNow = now ?? new Date();
  const todayIso = businessClockAt(effectiveNow).dateIso;
  const commandsById = new Map(
    getFinanceCommandItems(objects, 'exceptionFirst', effectiveNow).map((item) => [item.id, item]),
  );
  const events = objects.flatMap((object) => {
    const command = commandsById.get(object.id);
    if (!command) return [];
    if (!object.paymentSchedules?.length) {
      return [financeCommandCalendarEvent(command)];
    }
    return object.paymentSchedules
      .filter((schedule) => Boolean(schedule.dueDateIso))
      .map((schedule, index) =>
        financeScheduleCalendarEvent(command, schedule, schedule.sequence ?? index + 1, todayIso),
      );
  });

  return events.sort(
    (left, right) =>
      (left.dateIso ?? '9999-12-31').localeCompare(right.dateIso ?? '9999-12-31') ||
      left.objectId.localeCompare(right.objectId) ||
      left.id.localeCompare(right.id),
  );
}

export function getFinancePaymentConditions(
  objects: WorkObject[],
  now?: Date,
): FinancePaymentCondition[] {
  const effectiveNow = now ?? new Date();
  const commandsById = new Map(
    getFinanceCommandItems(objects, 'exceptionFirst', effectiveNow).map((item) => [item.id, item]),
  );
  return objects
    .flatMap((object) => {
      const command = commandsById.get(object.id);
      if (!command) return [];
      return (object.paymentSchedules ?? []).flatMap((schedule, index) => {
        if (
          schedule.dueDateIso ||
          schedule.dateKind !== 'condition' ||
          schedule.trigger !== 'full_shipment' ||
          !Number.isSafeInteger(schedule.offsetDays)
        ) {
          return [];
        }
        return [
          {
            id: `finance-condition:${object.id}:${schedule.id}`,
            objectId: object.id,
            title: `Платеж ${schedule.sequence ?? index + 1} · ${command.orderNumber}`,
            customer: command.customer,
            amountLabel: schedule.amountLabel,
            conditionLabel: paymentStageConditionLabel('full_shipment', schedule.offsetDays!),
            dateKind: 'condition' as const,
            sequence: schedule.sequence ?? index + 1,
            percentageLabel:
              schedule.percentageBasisPoints === undefined
                ? undefined
                : `${(schedule.percentageBasisPoints / 100).toFixed(2).replace('.', ',')}%`,
          },
        ];
      });
    })
    .sort(
      (left, right) =>
        left.objectId.localeCompare(right.objectId) ||
        left.sequence - right.sequence ||
        left.id.localeCompare(right.id),
    )
    .map(({ sequence: _sequence, ...condition }) => condition);
}

function financeCommandCalendarEvent(item: FinanceCommandItem): FinanceCalendarEvent {
  return {
    id: `finance-calendar:${item.id}`,
    objectId: item.id,
    day: financeCalendarDay(item),
    dateLabel: financeCalendarDateLabel(item),
    title: item.orderNumber,
    customer: item.customer,
    amountLabel: item.amountRisk,
    kind: financeCalendarKind(item),
    sourceState: item.sourceState,
    severity: item.severity,
    recommendedAction: item.recommendedAction,
    dateIso: item.dueDateIso,
    monthKey: item.monthKey,
    dateKind: item.dueDateIso ? 'actual' : 'unavailable',
  };
}

function financeScheduleCalendarEvent(
  item: FinanceCommandItem,
  schedule: NonNullable<WorkObject['paymentSchedules']>[number],
  sequence: number,
  todayIso: string,
): FinanceCalendarEvent {
  const dateIso = schedule.dueDateIso!;
  const kind: FinanceCalendarEventKind =
    schedule.status === 'paid'
      ? 'paid'
      : schedule.dueDateIso && schedule.dueDateIso < todayIso
        ? 'overdue'
        : schedule.dueDateIso === todayIso
          ? 'due_today'
          : 'installment';
  return {
    id: `finance-calendar:${item.id}:${schedule.id}`,
    objectId: item.id,
    day: Number(dateIso.slice(8, 10)),
    dateLabel: schedule.dueDateLabel,
    title: `Платеж ${sequence} · ${item.orderNumber}`,
    customer: item.customer,
    amountLabel: schedule.amountLabel,
    kind,
    sourceState: 'schedule',
    severity: kind === 'overdue' ? 'critical' : 'info',
    recommendedAction:
      kind === 'paid'
        ? 'платеж получен'
        : kind === 'overdue'
          ? 'разобрать просрочку'
          : 'проверить оплату',
    dateIso,
    monthKey: dateIso.slice(0, 7),
    dateKind: 'actual',
    percentageLabel:
      schedule.percentageBasisPoints === undefined
        ? undefined
        : `${(schedule.percentageBasisPoints / 100).toFixed(2).replace('.', ',')}%`,
  };
}

export function countActionableFinanceOrders(events: FinanceCalendarEvent[]): number {
  return new Set(events.filter((event) => event.kind !== 'paid').map((event) => event.objectId))
    .size;
}

export function financeCalendarFocusMonth(events: FinanceCalendarEvent[]): string | undefined {
  return (
    events.find(
      (event) => event.sourceState === 'schedule' && event.kind !== 'paid' && event.monthKey,
    )?.monthKey ?? events.find((event) => event.kind !== 'paid' && event.monthKey)?.monthKey
  );
}

export function financeObjectBelongsToSection(object: WorkObject, section: string, now?: Date) {
  void now;
  const resolvedSection = normalizeFinanceSection(section);
  if (resolvedSection === 'Счета') return true;
  if (resolvedSection === 'Рассрочка') {
    return Boolean(
      object.paymentPolicy || object.paymentSchedule || object.paymentSchedules?.length,
    );
  }
  if (resolvedSection === 'Просрочки') {
    return object.financeBusinessPayment?.isOverdue === true;
  }
  return false;
}

export function getCommercialNextStep(object: WorkObject): CommercialNextStep {
  const order = object.commercialOrder;
  const positions = order?.positions ?? [];
  const proposals = object.warehouseCoverProposals ?? [];
  const hasCounterparty = object.facts.some(
    (fact) => fact.label === 'Контрагент' && fact.value.trim().length > 0,
  );
  const hasPositions = positions.length > 0;
  const hasRecipe = positions.every((position) => position.recipeSnapshot.parameters.length > 0);
  const hasOpenProblem = object.problems.some((problem) => problem.status === 'open');
  const openProductionProblem = object.productionProblems?.find(
    (problem) => problem.status !== 'resolved',
  );
  const hasPendingWarehouseProposal = proposals.some((proposal) => !proposal.confirmedAt);
  const missingQty = proposals.reduce((sum, proposal) => sum + proposal.missingQty, 0);
  const isDraft = object.statusLabel === 'Черновик' || order?.status === 'draft';
  const productionStarted =
    order?.productionStatus === 'in_production' ||
    order?.productionStatus === 'ready' ||
    Boolean(object.commercialProductionProgress);
  const transferred =
    object.statusLabel === 'Передано' ||
    object.filterTags?.includes('Передано') ||
    object.filterTags?.includes('Передано в заказ-наряд');
  const paymentOverdue =
    order?.paymentStatus === 'просрочка' || object.paymentIndicator?.severity === 'critical';
  const productionHandoffAction = object.actions.find(
    (action) => action.enabled && action.id.startsWith('commercial-send-to-production:'),
  );

  if (isDraft && (!hasCounterparty || !hasPositions || !hasRecipe)) {
    return {
      actionId: 'commercial-edit-params',
      label: 'Заполнить параметры',
      level: 'recommended',
      owner: 'Коммерция',
      affectedBlock: 'Позиции и параметры',
      severity: 'warning',
      disabledReason: !hasCounterparty
        ? 'Не выбран контрагент'
        : !hasPositions
          ? 'Нет позиций'
          : 'Нет recipe snapshot',
      nextStep: 'Заполнить карточку, затем оформить заявку из черновика',
    };
  }

  if (isDraft) {
    return {
      actionId: 'commercial-promote-draft',
      label: 'Оформить заявку',
      level: 'recommended',
      owner: 'Коммерция',
      affectedBlock: 'Готовность заявки',
      severity: paymentOverdue ? 'warning' : 'info',
      nextStep: 'Заявка выйдет из черновиков и появится во входящих у коммерции',
    };
  }

  if (productionHandoffAction) {
    return {
      actionId: productionHandoffAction.id,
      label: productionHandoffAction.label,
      level: 'recommended',
      owner: 'Коммерция',
      affectedBlock: 'Передача в производство',
      severity: 'info',
      nextStep: 'Явно передать оплаченный заказ заведующему производством',
    };
  }

  if (hasPendingWarehouseProposal && !transferred) {
    return {
      actionId: 'commercial-transfer-selected',
      label: 'Направить в бухгалтерию',
      level: 'recommended',
      owner: 'Коммерция',
      affectedBlock: 'Оплата и выдача',
      severity: missingQty > 0 ? 'warning' : 'info',
      nextStep:
        missingQty > 0
          ? `${missingQty} рул. уйдет в производство после бухгалтерии`
          : 'Бухгалтерия проверит оплату перед дальнейшим маршрутом',
    };
  }

  if (
    proposals.length > 0 &&
    !hasPendingWarehouseProposal &&
    missingQty === 0 &&
    !productionStarted &&
    !transferred
  ) {
    return {
      actionId: 'commercial-open-payment-shipment',
      label: 'Показать оплату и отгрузку',
      actionIntent: 'navigate' as const,
      level: 'recommended',
      owner: 'Коммерция',
      affectedBlock: 'Оплата и выдача',
      severity: paymentOverdue ? 'warning' : 'info',
      nextStep: paymentOverdue
        ? 'Склад закрыл заявку; проверь оплату перед обещанием выдачи'
        : 'Склад закрыл заявку; производство не требуется',
    };
  }

  if (productionStarted) {
    if (openProductionProblem) {
      return {
        actionId: 'commercial-open-production-problem',
        label: 'Разобрать проблему производства',
        level: 'recommended',
        owner: 'Коммерция',
        affectedBlock: 'Производство и рецептура',
        severity: openProductionProblem.severity,
        nextStep: `Производство: ${openProductionProblem.completedRolls ?? 0}/${openProductionProblem.totalRolls ?? '?'} рул.; текущий ${openProductionProblem.currentRollNumber ?? '?'}. Укажи изменение и рулон применения.`,
      };
    }

    return {
      actionId: 'commercial-open-production',
      label: 'Статус производства',
      level: 'recommended',
      owner: 'Зав. производства',
      affectedBlock: 'Позиции и параметры',
      severity: hasOpenProblem ? 'warning' : 'info',
      nextStep: 'Параметры меняются только через запрос изменения с причиной',
    };
  }

  if (transferred) {
    return {
      actionId: 'commercial-open-production',
      label: 'Статус производства',
      level: 'recommended',
      owner: 'Зав. производства',
      affectedBlock: 'Переданная заявка',
      severity: hasOpenProblem ? 'warning' : 'info',
      nextStep: 'Заявка уже передана. Изменения оформляются запросом с причиной.',
    };
  }

  return {
    actionId: 'commercial-open-production',
    label: missingQty > 0 ? 'Показать недостачу для выпуска' : 'Статус производства',
    level: 'recommended',
    owner: object.nextOwner,
    affectedBlock: 'Маршрут заказа',
    severity: paymentOverdue ? 'warning' : object.severity,
    nextStep:
      missingQty > 0
        ? 'Недостающий объем уходит дальше только после решения коммерции по складу'
        : paymentOverdue
          ? 'Сверить оплату/отгрузку в контекстном блоке'
          : 'Посмотреть производственный статус заявки',
  };
}
