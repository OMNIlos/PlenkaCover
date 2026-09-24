import type { Severity } from '../types';
import type {
  DashboardHealthSignal,
  DashboardMetricCatalogEntry,
  DashboardSecondaryMetric,
  DashboardSituation,
  DirectorControlReport,
  DirectorDashboardDrilldown,
  DirectorDashboardMetric,
  DirectorDashboardProjection,
  FinanceOrderRuntime,
  ProblemCaseRuntime,
  ProductionRuntimeState,
} from './types';
import { buildQualityDefectStatsProjection } from './qualityStats';
import { buildDirectorControlPeriodComparison } from './directorDashboardPeriods';

function severityRank(severity: Severity) {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function dashboardSeverity(count: number, criticalCount = 0): Severity {
  if (criticalCount > 0) return 'critical';
  if (count > 0) return 'warning';
  return 'info';
}

function dashboardDrilldown(
  section: DirectorDashboardDrilldown['section'],
  view: DirectorDashboardDrilldown['view'],
  filter: DirectorDashboardDrilldown['filter'],
  targetObjectId?: string
): DirectorDashboardDrilldown {
  return { section, view, filter, targetObjectId };
}

function problemDrilldown(problem: ProblemCaseRuntime): DirectorDashboardDrilldown {
  if (problem.scope === 'finance') return dashboardDrilldown('Финансы', 'orders', 'money', problem.objectId);
  if (problem.scope === 'warehouse') return dashboardDrilldown('Склад', 'orders', 'warehouse', problem.objectId);
  if (problem.scope === 'material') return dashboardDrilldown('Сырье', 'orders', 'risk', problem.objectId);
  return dashboardDrilldown('Требуют решения', 'decisions', 'risk', problem.objectId);
}

function dashboardScopeFromProblem(problem: ProblemCaseRuntime): DashboardSituation['scope'] {
  if (problem.scope === 'finance') return 'finance';
  if (problem.scope === 'warehouse') return 'warehouse';
  if (problem.scope === 'material') return 'material';
  if (problem.scope === 'operator') return 'production';
  return 'risk';
}

function dashboardActionLabel(scope: DashboardSituation['scope']) {
  if (scope === 'finance') return 'К финансам';
  if (scope === 'warehouse') return 'К складу';
  if (scope === 'material') return 'К сырью';
  if (scope === 'production') return 'К производству';
  if (scope === 'penalty') return 'К штрафам';
  return 'К решению';
}

function dashboardScopeLabel(scope: DashboardSituation['scope']) {
  if (scope === 'finance') return 'финансовый снимок';
  if (scope === 'warehouse') return 'складской факт';
  if (scope === 'material') return 'складской факт / учетный снимок';
  if (scope === 'penalty') return 'контур ответственности';
  return 'данные платформы';
}

function dashboardStalenessLabel(scope: DashboardSituation['scope']) {
  if (scope === 'finance') return 'ручной снимок сегодня';
  if (scope === 'warehouse') return 'последний складской скан';
  if (scope === 'material') return 'остаток обновлен сегодня, цена требует сверки';
  if (scope === 'penalty') return 'снимок ответственности сегодня';
  return 'события платформы сегодня';
}

function dashboardBasisLabel(scope: DashboardSituation['scope']) {
  if (scope === 'finance') return 'счет, оплата, ручная сверка';
  if (scope === 'warehouse') return 'ожидаемые рулоны / принятые рулоны';
  if (scope === 'material') return 'плановый расход, складской факт, резерв, справочник цен';
  if (scope === 'penalty') return 'назначенные штрафы с историей';
  return 'проблемы, решения и события';
}

function dashboardEffectiveAtLabel(scope: DashboardSituation['scope']) {
  if (scope === 'material') return 'остаток: сейчас; дата действия цены не подтверждена';
  if (scope === 'finance') return 'снимок оплаты: сегодня';
  return 'данные сейчас';
}

function dashboardSourceEventIds(runtime: ProductionRuntimeState, objectId: string) {
  return runtime.events.filter((event) => event.objectId === objectId).map((event) => event.id);
}

function dashboardEventEvidence(runtime: ProductionRuntimeState, objectId: string) {
  const event = runtime.events.find((item) => item.objectId === objectId);
  return event ? `${event.label}: ${event.detail}` : undefined;
}

function financeProblemMatchesOrder(problem: ProblemCaseRuntime, order: FinanceOrderRuntime) {
  const runtimeAlias = order.id.replace('FIN-RUNTIME-', 'FIN-');
  return problem.scope === 'finance' && (problem.objectId === order.id || problem.objectId === runtimeAlias || problem.objectId === order.orderId);
}

function numericAmount(label?: string) {
  const normalized = label?.replace(/[^\d-]/g, '') ?? '';
  return Number.parseInt(normalized, 10) || 0;
}

function moneyLabel(value: number) {
  return `${new Intl.NumberFormat('ru-RU').format(Math.round(value))} ₽`;
}

function kgLabel(value: number) {
  const rounded = Number(value.toFixed(1));
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(rounded)} кг`;
}

function completionPercent(fact: number, plan: number) {
  if (plan <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((fact / plan) * 100)));
}

function financeStatusLabel(order: FinanceOrderRuntime) {
  if (order.status === 'waiting_invoice') return 'счет не выставлен';
  if (order.status === 'waiting_payment') return 'ждет оплату';
  if (order.status === 'installment_running') return 'рассрочка';
  return 'просрочка';
}

function financeRiskLabel(order: FinanceOrderRuntime) {
  if (order.status === 'overdue') return 'деньги просрочены';
  if (order.status === 'waiting_invoice') return 'нет счета';
  if (order.status === 'installment_running') return 'контроль графика';
  return 'ожидается платеж';
}

function financeDueRank(order: FinanceOrderRuntime) {
  if (order.status === 'overdue') return 0;
  if (order.status === 'waiting_invoice') return 1;
  if (order.status === 'waiting_payment') return 2;
  return 3;
}

function buildDirectorControlReport(
  runtime: ProductionRuntimeState,
  defectStats: ReturnType<typeof buildQualityDefectStatsProjection>,
): DirectorControlReport {
  const financeTotal = runtime.financeOrders.reduce((sum, order) => sum + numericAmount(order.amountLabel), 0);
  const financePaid = runtime.financeOrders.reduce((sum, order) => sum + numericAmount(order.amountPaidLabel), 0);
  const financeRemaining = runtime.financeOrders.reduce((sum, order) => sum + numericAmount(order.amountRemainingLabel ?? order.amountLabel), 0);
  const financeOverdueRemaining = runtime.financeOrders
    .filter((order) => order.status === 'overdue')
    .reduce((sum, order) => sum + numericAmount(order.amountRemainingLabel ?? order.amountLabel), 0);
  const invoiceBacklog = runtime.financeOrders
    .filter((order) => order.status === 'waiting_invoice')
    .reduce((sum, order) => sum + numericAmount(order.amountRemainingLabel ?? order.amountLabel), 0);
  const penaltyTotal = runtime.penalties
    .filter((penalty) => penalty.status !== 'cancelled')
    .reduce((sum, penalty) => sum + numericAmount(penalty.amountLabel), 0);
  const penaltyCount = runtime.penalties.filter((penalty) => penalty.status !== 'cancelled').length;

  const allRolls = runtime.warehouseAcceptances.flatMap((acceptance) => acceptance.rolls);
  const acceptedRolls = allRolls.filter((roll) => roll.status === 'accepted' || roll.status === 'delivered');
  const expectedKg = allRolls.reduce((sum, roll) => sum + roll.plannedNetKg, 0);
  const acceptedKg = acceptedRolls.reduce((sum, roll) => sum + (roll.controlWeightKg ?? roll.plannedNetKg), 0);
  const missingKg = Math.max(0, expectedKg - acceptedKg);
  const reportingDays = Math.max(1, new Set(runtime.warehouseAcceptances.map((acceptance) => acceptance.createdAt || 'сегодня')).size);
  const monthAverageKg = acceptedKg / reportingDays;
  const defectKg = defectStats.summary.totalWeightKg;
  const moneyCompletion = completionPercent(financePaid, financeTotal);
  const outputCompletion = completionPercent(acceptedKg, expectedKg);
  const invoiceBacklogOrder = runtime.financeOrders.find((order) => order.status === 'waiting_invoice');
  const paymentAttentionOrder = runtime.financeOrders.find((order) => ['waiting_payment', 'installment_running'].includes(order.status))
    ?? runtime.financeOrders.find((order) => order.status === 'overdue')
    ?? runtime.financeOrders[0];
  const overdueOrder = runtime.financeOrders.find((order) => order.status === 'overdue');
  const productionTargetId = runtime.orders.find((order) => order.operatorTaskId)?.id ?? runtime.orders[0]?.id;
  const warehouseAcceptanceTargetId = runtime.warehouseAcceptances[0]?.id;
  const penaltyTargetId = runtime.penalties.find((penalty) => penalty.status !== 'cancelled')?.penaltyId ?? runtime.penalties[0]?.penaltyId;
  const productionDrilldown = dashboardDrilldown('Производство', 'orders', 'risk', productionTargetId);
  const warehouseDrilldown = dashboardDrilldown('Склад', 'orders', 'warehouse', warehouseAcceptanceTargetId);
  const penaltyDrilldown = dashboardDrilldown('Штрафы', 'decisions', 'risk', penaltyTargetId);
  const financeDrilldown = dashboardDrilldown('Финансы', 'orders', 'money', paymentAttentionOrder?.id);
  const acceptedRollCount = acceptedRolls.length;
  const { periodMetrics, periodRows } = buildDirectorControlPeriodComparison({
    acceptedRollCount,
    allRollCount: allRolls.length,
    acceptedKg,
    defectKg,
    penaltyCount,
    penaltyTotal,
    financeOverdueRemaining,
    financePaid,
    productionDrilldown,
    warehouseDrilldown,
    penaltyDrilldown,
    financeDrilldown,
    formatMoney: moneyLabel,
    formatKg: kgLabel,
  });

  return {
    periodLabel: 'Этот месяц',
    sourceLabel: 'финансовые строки + складская приемка + штрафы периода',
    denominatorLabel: 'Счета, оплаты, рулоны, брак и назначенные штрафы.',
    selectedPeriod: 'current_month',
    comparisonPeriod: 'previous_month',
    availablePeriods: [
      { id: 'today', label: 'Сегодня', rangeLabel: 'текущий день' },
      { id: 'yesterday', label: 'Вчера', rangeLabel: 'предыдущий день' },
      { id: 'current_week', label: 'Неделя', rangeLabel: '7 дней к дате' },
      { id: 'current_month', label: 'Месяц', rangeLabel: 'месяц к дате' },
    ],
    kpis: [
      {
        id: 'finance-plan',
        label: 'План счетов',
        value: moneyLabel(financeTotal),
        caption: invoiceBacklog > 0 ? `Без счета: ${moneyLabel(invoiceBacklog)}` : 'Счета готовы',
        tone: invoiceBacklog > 0 ? 'risk' : 'money',
        actionLabel: 'К счетам',
        drilldown: dashboardDrilldown('Финансы', 'orders', 'money', invoiceBacklogOrder?.id ?? runtime.financeOrders[0]?.id),
      },
      {
        id: 'finance-paid',
        label: 'Оплачено',
        value: moneyLabel(financePaid),
        caption: financeRemaining > 0 ? `К получению: ${moneyLabel(financeRemaining)}` : 'Закрыто',
        tone: financePaid > 0 ? 'money' : 'neutral',
        actionLabel: 'К оплатам',
        drilldown: dashboardDrilldown('Финансы', 'orders', 'money', paymentAttentionOrder?.id),
      },
      {
        id: 'finance-overdue',
        label: 'Просрочено',
        value: moneyLabel(financeOverdueRemaining),
        caption: financeOverdueRemaining > 0 ? 'К разбору' : 'Нет',
        tone: financeOverdueRemaining > 0 ? 'risk' : 'money',
        actionLabel: 'Разобрать',
        drilldown: dashboardDrilldown('Финансы', 'orders', 'money', overdueOrder?.id ?? runtime.financeOrders[0]?.id),
      },
      {
        id: 'output-today',
        label: 'Выработка',
        value: kgLabel(acceptedKg),
        caption: `${outputCompletion}% плана`,
        tone: outputCompletion >= 70 ? 'production' : 'risk',
        actionLabel: 'К производству',
        drilldown: productionDrilldown,
      },
      {
        id: 'output-month-average',
        label: 'Средняя',
        value: `${kgLabel(monthAverageKg)}/день`,
        caption: 'По приемке склада',
        tone: 'production',
        actionLabel: 'К приемке',
        drilldown: warehouseDrilldown,
      },
      {
        id: 'period-penalties',
        label: 'Штрафы',
        value: moneyLabel(penaltyTotal),
        caption: penaltyCount > 0 ? `${penaltyCount} назначено` : 'Нет',
        tone: penaltyTotal > 0 ? 'risk' : 'neutral',
        actionLabel: 'К штрафам',
        drilldown: penaltyDrilldown,
      },
    ],
    periodMetrics,
    periodRows,
    financeRows: runtime.financeOrders.map((order) => ({
      id: order.id,
      orderId: order.orderId,
      customerLabel: order.counterpartyLabel ?? 'клиент не указан',
      amountLabel: order.amountLabel ?? moneyLabel(0),
      paidLabel: order.amountPaidLabel ?? moneyLabel(0),
      remainingLabel: order.amountRemainingLabel ?? order.amountLabel ?? moneyLabel(0),
      dueLabel: order.dueDateLabel ?? (order.status === 'waiting_invoice' ? 'счет не выставлен' : 'срок в источнике'),
      statusLabel: financeStatusLabel(order),
      sourceLabel: order.source === 'production_approval' ? 'заказ-наряд' : 'оплаты',
      riskLabel: financeRiskLabel(order),
      severity: order.status === 'overdue' ? 'critical' : order.status === 'waiting_invoice' ? 'warning' : 'info',
      amountValue: numericAmount(order.amountLabel),
      remainingValue: numericAmount(order.amountRemainingLabel ?? order.amountLabel),
      dueRank: financeDueRank(order),
    })),
    productionRows: [
      {
        id: 'output-kg',
        label: 'Готовая продукция',
        factLabel: kgLabel(acceptedKg),
        planLabel: kgLabel(expectedKg),
        varianceLabel: missingKg > 0 ? `не хватает ${kgLabel(missingKg)}` : 'план закрыт',
        sourceLabel: 'складская приемка',
      },
      {
        id: 'rolls',
        label: 'Рулоны',
        factLabel: `${acceptedRolls.length}`,
        planLabel: `${allRolls.length}`,
        varianceLabel: `${Math.max(0, allRolls.length - acceptedRolls.length)} не закрыто`,
        sourceLabel: 'QR рулонов',
      },
      {
        id: 'defects',
        label: 'Брак и потери',
        factLabel: kgLabel(defectKg),
        planLabel: '0 кг',
        varianceLabel: defectKg > 0 ? 'есть потери' : 'потерь нет',
        sourceLabel: 'события качества',
      },
    ],
  };
}

function openProblemSituations(runtime: ProductionRuntimeState): DashboardSituation[] {
  return runtime.problems
    .filter((problem) => {
      if (problem.status !== 'open') return false;
      if (problem.scope !== 'finance') return true;
      return !runtime.financeOrders.some((order) => order.status === 'overdue' && financeProblemMatchesOrder(problem, order));
    })
    .map((problem) => {
      const scope = dashboardScopeFromProblem(problem);
      const eventEvidence = dashboardEventEvidence(runtime, problem.objectId);
      return {
        id: `situation.problem.${problem.id}`,
        title: problem.title,
        detail: problem.reason,
        objectId: problem.objectId,
        scope,
        severity: problem.severity,
        ownerRole: problem.ownerRole,
        dueLabel: problem.reason.toLowerCase().includes('просроч') ? 'просрочено' : 'до следующего шага',
        recovery: problem.recovery,
        primaryActionLabel: dashboardActionLabel(scope),
        evidence: [problem.reason, problem.recovery, eventEvidence].filter(Boolean) as string[],
        sourceLabel: dashboardScopeLabel(scope),
        denominatorLabel: 'Открытая проблема',
        stalenessLabel: dashboardStalenessLabel(scope),
        basisLabel: dashboardBasisLabel(scope),
        effectiveAtLabel: dashboardEffectiveAtLabel(scope),
        auditCompletenessLabel: eventEvidence ? 'история найдена' : 'история требует дополнения',
        allowedActionIds: ['open-contour', 'assign-owner', 'return-to-owner'],
        requiresReason: true,
        drilldown: problemDrilldown(problem),
        sourceEventIds: dashboardSourceEventIds(runtime, problem.objectId),
        relatedProblemIds: [problem.id],
      };
    });
}

function financeOrderSituations(runtime: ProductionRuntimeState): DashboardSituation[] {
  return runtime.financeOrders
    .filter((order) => order.status === 'overdue')
    .map((order) => {
      const relatedProblems = runtime.problems.filter((problem) => problem.status === 'open' && financeProblemMatchesOrder(problem, order));
      return {
        id: `situation.finance.${order.id}`,
        title: 'Просрочка оплаты',
        detail: `${order.counterpartyLabel ?? order.orderId}: ${order.amountRemainingLabel ?? order.amountLabel ?? 'сумма требует проверки'}.`,
        objectId: order.id,
        scope: 'finance',
        severity: 'critical',
        ownerRole: 'Бухгалтерия',
        dueLabel: order.dueDateLabel ?? 'просрочено',
        recovery: relatedProblems[0]?.recovery ?? 'Назначить разбор с бухгалтерией и открыть подтверждения.',
        primaryActionLabel: 'К финансам',
        evidence: [
          `Заказ: ${order.orderId}`,
          `Остаток: ${order.amountRemainingLabel ?? order.amountLabel ?? 'нет данных'}`,
          `Просрочка: ${order.dueDateLabel ?? 'просрочено'}`,
          relatedProblems[0]?.reason,
        ].filter(Boolean) as string[],
        sourceLabel: 'финансовый снимок',
        denominatorLabel: 'Просроченная оплата',
        stalenessLabel: 'ручной снимок сегодня',
        basisLabel: 'счет, остаток, срок оплаты',
        effectiveAtLabel: 'снимок оплаты: сегодня',
        auditCompletenessLabel: relatedProblems.length > 0 ? 'есть проблема и история' : 'нет связанной проблемы',
        allowedActionIds: ['director-finance-override-request', 'director-finance-override-return'],
        requiresReason: true,
        drilldown: dashboardDrilldown('Финансы', 'orders', 'money', relatedProblems[0]?.objectId ?? order.id),
        sourceEventIds: dashboardSourceEventIds(runtime, order.id),
        relatedProblemIds: relatedProblems.map((problem) => problem.id),
      };
    });
}

function warehouseExceptionSituations(runtime: ProductionRuntimeState): DashboardSituation[] {
  return runtime.warehouseAcceptances
    .filter((acceptance) =>
      acceptance.missingRollIds.length > 0 ||
      acceptance.excessPayloads.length > 0 ||
      acceptance.rolls.some((roll) => roll.status === 'blocked_weight') ||
      acceptance.status === 'partial' ||
      acceptance.status === 'scan_error'
    )
    .map((acceptance) => {
      const blockedWeightCount = acceptance.rolls.filter((roll) => roll.status === 'blocked_weight').length;
      const detailParts = [
        acceptance.missingRollIds.length > 0 ? `не хватает ${acceptance.missingRollIds.join(', ')}` : '',
        acceptance.excessPayloads.length > 0 ? `лишние сканы: ${acceptance.excessPayloads.length}` : '',
        blockedWeightCount > 0 ? `вес вне допуска: ${blockedWeightCount}` : '',
      ].filter(Boolean);
      return {
        id: `situation.warehouse.${acceptance.id}`,
        title: acceptance.status === 'scan_error' ? 'Ошибка приемки' : 'Частичная приемка',
        detail: detailParts.join('. ') || acceptance.scanResult || 'Складская приемка требует решения.',
        objectId: acceptance.id,
        scope: 'warehouse',
        severity: blockedWeightCount > 0 || acceptance.missingRollIds.length > 0 ? 'critical' : 'warning',
        ownerRole: 'Склад',
        dueLabel: 'до закрытия выдачи',
        recovery: 'Разобрать сканы, подтвердить частично или вернуть.',
        primaryActionLabel: 'К складу',
        evidence: [
          `Ожидается: ${acceptance.expectedRollIds.length}`,
          `Принято: ${acceptance.acceptedRollIds.length}`,
          `Последний скан: ${acceptance.scanResult ?? acceptance.lastScan}`,
        ],
        sourceLabel: 'складской факт',
        denominatorLabel: 'Ожидаемые / принятые рулоны',
        stalenessLabel: 'последний складской скан',
        basisLabel: 'счетчик ожидалось / просканировано и контрольный вес',
        effectiveAtLabel: 'текущая приемка',
        auditCompletenessLabel: 'складская история видна',
        allowedActionIds: ['director-warehouse-override-confirm', 'director-warehouse-override-return'],
        requiresReason: true,
        drilldown: dashboardDrilldown('Склад', 'orders', 'warehouse', acceptance.id),
        sourceEventIds: dashboardSourceEventIds(runtime, acceptance.id),
      };
    });
}

function directorDecisionSituations(runtime: ProductionRuntimeState): DashboardSituation[] {
  return runtime.directorDecisions
    .filter((decision) => decision.status === 'open')
    .map((decision) => ({
      id: `situation.decision.${decision.id}`,
      title: decision.summary,
      detail: decision.evidence,
      objectId: decision.objectId,
      scope: decision.scope,
      severity: decision.severity,
      ownerRole: decision.ownerRole,
      dueLabel: 'ждет решения',
      recovery: 'Подтвердить или вернуть владельцу.',
      primaryActionLabel: 'К решению',
      evidence: [decision.evidence],
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Открытое решение директора',
      stalenessLabel: dashboardStalenessLabel(decision.scope),
      basisLabel: dashboardBasisLabel(decision.scope),
      effectiveAtLabel: dashboardEffectiveAtLabel(decision.scope),
      auditCompletenessLabel: 'ожидает решения директора',
      allowedActionIds: ['approve', 'return', 'assign-owner'],
      requiresReason: true,
      drilldown: dashboardDrilldown('Требуют решения', 'decisions', decision.scope === 'finance' ? 'money' : decision.scope === 'warehouse' ? 'warehouse' : 'risk', decision.objectId),
      sourceEventIds: dashboardSourceEventIds(runtime, decision.objectId),
    }));
}

function dedupeDashboardSituations(situations: DashboardSituation[]) {
  const byScopeAndObject = new Map<string, DashboardSituation>();
  for (const situation of situations) {
    const key = `${situation.scope}:${situation.objectId}`;
    const existing = byScopeAndObject.get(key);
    if (!existing || severityRank(situation.severity) < severityRank(existing.severity)) {
      byScopeAndObject.set(key, situation);
    }
  }
  return Array.from(byScopeAndObject.values());
}

function sortDashboardSituations(situations: DashboardSituation[]) {
  const dueRank = (situation: DashboardSituation) => {
    const due = situation.dueLabel.toLowerCase();
    if (due.includes('просроч')) return 0;
    if (due.includes('закрыт') || due.includes('следующ')) return 1;
    if (due.includes('ждет')) return 2;
    return 3;
  };
  const scopeRank: Record<DashboardSituation['scope'], number> = {
    finance: 0,
    warehouse: 1,
    material: 2,
    production: 3,
    penalty: 4,
    risk: 5,
  };

  return [...situations].sort((left, right) =>
    severityRank(left.severity) - severityRank(right.severity)
    || dueRank(left) - dueRank(right)
    || scopeRank[left.scope] - scopeRank[right.scope]
    || left.id.localeCompare(right.id, 'ru')
  );
}

const directorDashboardMetricCatalog: Record<string, DashboardMetricCatalogEntry> = {
  money: {
    id: 'money',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'финансовый снимок',
    denominatorLabel: 'Счета и оплаты',
    ownerRole: 'Бухгалтерия',
    drilldownSection: 'Финансы',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent', 'runtimeProblem'],
  },
  overdue: {
    id: 'overdue',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'финансовый снимок',
    denominatorLabel: 'Просроченные оплаты',
    ownerRole: 'Бухгалтерия',
    drilldownSection: 'Финансы',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent', 'runtimeProblem'],
  },
  production: {
    id: 'production',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'данные платформы',
    denominatorLabel: 'Заказы, решения, открытые проблемы',
    ownerRole: 'Зав. производства',
    drilldownSection: 'Производство',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent', 'runtimeProblem', 'runtimeDecision'],
  },
  'finished-goods-warehouse': {
    id: 'finished-goods-warehouse',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'складской факт',
    denominatorLabel: 'Ожидаемые / принятые рулоны',
    ownerRole: 'Склад',
    drilldownSection: 'Склад',
    allowedFirstLayer: false,
    sourceEventFamilies: ['ProblemEvent', 'runtimeProblem'],
  },
  'raw-materials': {
    id: 'raw-materials',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'складской факт / учетный снимок',
    denominatorLabel: 'Фактический остаток и справочник цен с учетом источника',
    ownerRole: 'Склад',
    drilldownSection: 'Сырье',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent', 'runtimeProblem'],
  },
  defects: {
    id: 'defects',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'данные платформы',
    denominatorLabel: 'Брак и связанные проблемы',
    ownerRole: 'Зав. производства',
    drilldownSection: 'Производство',
    allowedFirstLayer: false,
    sourceEventFamilies: ['MasterKpiEvent', 'runtimeProblem'],
  },
  penalties: {
    id: 'penalties',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'контур ответственности',
    denominatorLabel: 'Назначенные штрафы',
    ownerRole: 'Директор',
    drilldownSection: 'Штрафы',
    allowedFirstLayer: false,
    sourceEventFamilies: ['AuditEvent'],
  },
  'operator-workload': {
    id: 'operator-workload',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'данные платформы',
    denominatorLabel: 'Назначенные задачи операторов',
    ownerRole: 'Зав. производства',
    drilldownSection: 'Производство',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent'],
  },
  'order-completion': {
    id: 'order-completion',
    role: 'director',
    tier: 'secondary',
    sourceLabel: 'данные платформы',
    denominatorLabel: 'Заказы платформы',
    ownerRole: 'Зав. производства',
    drilldownSection: 'Производство',
    allowedFirstLayer: false,
    sourceEventFamilies: ['OperationalEvent'],
  },
};

function directorDashboardMetric(input: Omit<DirectorDashboardMetric, 'periodLabel' | 'sourceLabel' | 'denominatorLabel'> & Partial<Pick<DirectorDashboardMetric, 'periodLabel' | 'sourceLabel' | 'denominatorLabel'>>): DashboardSecondaryMetric {
  const catalogEntry = directorDashboardMetricCatalog[input.id];
  if (!catalogEntry) {
    throw new Error(`Director dashboard metric ${input.id} has no catalog entry`);
  }
  return {
    ...input,
    tier: 'secondary',
    catalogId: catalogEntry.id,
    ownerRole: catalogEntry.ownerRole,
    sourceEventFamilies: catalogEntry.sourceEventFamilies,
    periodLabel: input.periodLabel ?? 'Сейчас',
    sourceLabel: input.sourceLabel ?? catalogEntry.sourceLabel,
    denominatorLabel: input.denominatorLabel ?? catalogEntry.denominatorLabel,
  };
}

export function buildDirectorDashboardProjection(runtime: ProductionRuntimeState): DirectorDashboardProjection {
  const defectStats = buildQualityDefectStatsProjection(runtime);
  const openProblems = runtime.problems.filter((problem) => problem.status === 'open');
  const criticalProblems = openProblems.filter((problem) => problem.severity === 'critical');
  const productionProblemCount = openProblems.filter((problem) => ['operator', 'director'].includes(problem.scope)).length;
  const materialProblemCount = openProblems.filter((problem) => problem.scope === 'material').length;
  const warehouseProblemCount = openProblems.filter((problem) => problem.scope === 'warehouse').length;
  const financeProblemCount = openProblems.filter((problem) => problem.scope === 'finance').length;
  const productionWaiting = runtime.orders.filter((order) => order.status === 'waiting_order' || order.blockingReasons.length > 0).length;
  const productionDecisionCount = runtime.directorDecisions.filter((decision) => decision.status === 'open' && ['production', 'risk'].includes(decision.scope)).length;
  const financeWaitingInvoice = runtime.financeOrders.filter((order) => order.status === 'waiting_invoice').length;
  const financePaymentAttention = runtime.financeOrders.filter((order) => ['waiting_payment', 'installment_running', 'overdue'].includes(order.status)).length;
  const financeOverdue = runtime.financeOrders.filter((order) => order.status === 'overdue').length + financeProblemCount;
  const warehouseExpected = runtime.warehouseAcceptances.reduce((sum, acceptance) => sum + acceptance.expectedRollIds.length, 0);
  const warehouseAccepted = runtime.warehouseAcceptances.reduce((sum, acceptance) => sum + acceptance.acceptedRollIds.length, 0);
  const warehouseMissing = runtime.warehouseAcceptances.reduce((sum, acceptance) => sum + acceptance.missingRollIds.length, 0);
  const warehouseBlockedWeight = runtime.warehouseAcceptances.reduce((sum, acceptance) => sum + acceptance.rolls.filter((roll) => roll.status === 'blocked_weight').length, 0);
  const firstProductionProblem = openProblems.find((problem) => ['operator', 'director'].includes(problem.scope));
  const firstMaterialProblem = openProblems.find((problem) => problem.scope === 'material');
  const firstFinanceProblem = openProblems.find((problem) => problem.scope === 'finance');
  const firstWarehouseProblem = openProblems.find((problem) => problem.scope === 'warehouse');

  const completedOrders = runtime.orders.filter((order) => order.status === 'operator_task_ready' || order.status === 'approved').length;
  const activeOperatorTasks = runtime.orders.filter((order) => order.operatorTaskId).length;
  const defectCount = defectStats.summary.totalCount;
  const penaltyCount = runtime.penalties.filter((penalty) => penalty.status !== 'cancelled').length;
  const rawMaterialAttention = materialProblemCount;
  const controlReport = buildDirectorControlReport(runtime, defectStats);

  const secondaryMetrics: DashboardSecondaryMetric[] = [
    directorDashboardMetric({
      id: 'money',
      title: 'Деньги',
      value: String(financeWaitingInvoice + financePaymentAttention),
      detail: `Счет: ${financeWaitingInvoice}. Оплата/рассрочка: ${financePaymentAttention}.`,
      tone: 'money',
      severity: dashboardSeverity(financeWaitingInvoice + financePaymentAttention, financeOverdue),
      actionLabel: 'К финансам',
      drilldown: dashboardDrilldown('Финансы', 'orders', 'money', firstFinanceProblem?.objectId ?? runtime.financeOrders[0]?.id),
      sourceLabel: 'финансовый снимок',
      denominatorLabel: 'Счета и оплаты',
    }),
    directorDashboardMetric({
      id: 'overdue',
      title: 'Просрочки',
      value: String(financeOverdue),
      detail: `Платежи и проблемы: ${financeOverdue}.`,
      tone: 'risk',
      severity: dashboardSeverity(financeOverdue, financeOverdue),
      actionLabel: 'К просрочкам',
      drilldown: dashboardDrilldown('Финансы', 'orders', 'money', firstFinanceProblem?.objectId ?? runtime.financeOrders.find((order) => order.status === 'overdue')?.id),
      sourceLabel: 'финансовый снимок',
      denominatorLabel: 'Просроченные оплаты',
    }),
    directorDashboardMetric({
      id: 'production',
      title: 'Производство',
      value: String(productionWaiting + productionDecisionCount + productionProblemCount),
      detail: `Заказы: ${runtime.orders.length}. Риски: ${productionProblemCount}.`,
      tone: 'production',
      severity: dashboardSeverity(productionWaiting + productionDecisionCount + productionProblemCount, productionProblemCount),
      actionLabel: 'К производству',
      drilldown: dashboardDrilldown('Производство', 'orders', 'risk', firstProductionProblem?.objectId),
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Заказы, решения, открытые проблемы',
    }),
    directorDashboardMetric({
      id: 'finished-goods-warehouse',
      title: 'Склад ГП',
      value: `${warehouseAccepted}/${warehouseExpected}`,
      detail: `Недостача: ${warehouseMissing}. Блок веса: ${warehouseBlockedWeight}.`,
      tone: 'warehouse',
      severity: dashboardSeverity(warehouseProblemCount + warehouseMissing + warehouseBlockedWeight, warehouseProblemCount + warehouseBlockedWeight),
      actionLabel: 'К складу',
      drilldown: dashboardDrilldown('Склад', 'orders', 'warehouse', firstWarehouseProblem?.objectId ?? runtime.warehouseAcceptances[0]?.id),
      sourceLabel: 'склад',
      denominatorLabel: 'Ожидаемые / принятые рулоны',
    }),
    directorDashboardMetric({
      id: 'raw-materials',
      title: 'Сырье',
      value: String(rawMaterialAttention),
      detail: rawMaterialAttention > 0 ? `Открытые вопросы: ${rawMaterialAttention}.` : 'Открытых вопросов нет.',
      tone: 'warehouse',
      severity: rawMaterialAttention > 0 ? 'warning' : 'info',
      actionLabel: 'К сырью',
      drilldown: dashboardDrilldown('Сырье', 'orders', 'risk', firstMaterialProblem?.objectId ?? 'WH-INV-RAW'),
      sourceLabel: 'складской факт / учетный снимок',
      denominatorLabel: 'Фактический остаток, учет и справочник цен с учетом источника',
    }),
    directorDashboardMetric({
      id: 'defects',
      title: 'Брак',
      value: String(defectCount),
      detail: `Оператор: ${defectStats.summary.operatorCount}. Склад: ${defectStats.summary.warehouseCount}. Вес: ${defectStats.summary.totalWeightKg > 0 ? `${Number(defectStats.summary.totalWeightKg.toFixed(1))} кг` : 'нет данных'}.`,
      tone: 'risk',
      severity: dashboardSeverity(defectCount, defectCount),
      actionLabel: 'К браку',
      drilldown: dashboardDrilldown('Производство', 'orders', 'risk', defectStats.summary.latestObjectId ?? firstProductionProblem?.objectId),
      sourceLabel: 'события качества и складской факт брака',
      denominatorLabel: 'Записи брака оператора и склада',
    }),
    directorDashboardMetric({
      id: 'penalties',
      title: 'Штрафы',
      value: String(penaltyCount),
      detail: 'Назначены, адресаты уведомлены.',
      tone: 'risk',
      severity: 'info',
      actionLabel: 'К штрафам',
      drilldown: dashboardDrilldown('Штрафы', 'decisions', 'risk', runtime.penalties[0]?.penaltyId),
      sourceLabel: 'контур ответственности',
      denominatorLabel: 'Назначенные штрафы',
    }),
    directorDashboardMetric({
      id: 'operator-workload',
      title: 'Загрузка операторов',
      value: String(activeOperatorTasks),
      detail: `Назначенные задачи: ${activeOperatorTasks}.`,
      tone: 'production',
      severity: activeOperatorTasks > 3 ? 'warning' : 'info',
      actionLabel: 'К производству',
      drilldown: dashboardDrilldown('Производство', 'orders', 'risk', runtime.orders.find((order) => order.operatorTaskId)?.id),
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Назначенные задачи операторов',
    }),
    directorDashboardMetric({
      id: 'order-completion',
      title: 'Выполнение заказов',
      value: `${completedOrders}/${runtime.orders.length}`,
      detail: `Готовы или утверждены: ${completedOrders}.`,
      tone: 'production',
      severity: runtime.orders.length > 0 && completedOrders < runtime.orders.length ? 'warning' : 'info',
      actionLabel: 'К заказам',
      drilldown: dashboardDrilldown('Производство', 'orders', 'risk', runtime.orders[0]?.id),
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Заказы платформы',
    }),
  ];
  const situations = sortDashboardSituations(dedupeDashboardSituations([
    ...openProblemSituations(runtime),
    ...financeOrderSituations(runtime),
    ...warehouseExceptionSituations(runtime),
    ...directorDecisionSituations(runtime),
  ]));
  const healthSignals: DashboardHealthSignal[] = [
    {
      id: 'health-finance',
      title: 'Финансы',
      value: String(financeWaitingInvoice + financePaymentAttention),
      detail: `Просрочка/проблемы: ${financeOverdue}.`,
      scope: 'finance',
      severity: dashboardSeverity(financeWaitingInvoice + financePaymentAttention, financeOverdue),
      ownerRole: 'Бухгалтерия',
      sourceLabel: 'финансовый снимок',
      denominatorLabel: 'Счета и оплаты',
      stalenessLabel: 'ручной снимок сегодня',
      basisLabel: 'счет, оплата, срок и история источника',
      effectiveAtLabel: 'снимок оплаты: сегодня',
      drilldown: dashboardDrilldown('Финансы', 'orders', 'money', firstFinanceProblem?.objectId ?? runtime.financeOrders[0]?.id),
    },
    {
      id: 'health-production',
      title: 'Производство',
      value: String(productionWaiting + productionDecisionCount + productionProblemCount),
      detail: `Блокеры: ${productionProblemCount}. Решения: ${productionDecisionCount}.`,
      scope: 'production',
      severity: dashboardSeverity(productionWaiting + productionDecisionCount + productionProblemCount, productionProblemCount),
      ownerRole: 'Зав. производства',
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Заказы, решения, открытые проблемы',
      stalenessLabel: 'события платформы сегодня',
      basisLabel: 'заказы, решения и открытые проблемы',
      effectiveAtLabel: 'данные сейчас',
      drilldown: dashboardDrilldown('Производство', 'orders', 'risk', firstProductionProblem?.objectId),
    },
    {
      id: 'health-warehouse',
      title: 'Склад',
      value: String(warehouseProblemCount + warehouseMissing + warehouseBlockedWeight),
      detail: `Принято: ${warehouseAccepted}/${warehouseExpected}. Недостача: ${warehouseMissing}.`,
      scope: 'warehouse',
      severity: dashboardSeverity(warehouseProblemCount + warehouseMissing + warehouseBlockedWeight, warehouseProblemCount + warehouseBlockedWeight),
      ownerRole: 'Склад',
      sourceLabel: 'складской факт',
      denominatorLabel: 'Ожидаемые / принятые рулоны',
      stalenessLabel: 'последний складской скан',
      basisLabel: 'ожидалось / просканировано, недостача, контрольный вес',
      effectiveAtLabel: 'текущая приемка',
      drilldown: dashboardDrilldown('Склад', 'orders', 'warehouse', firstWarehouseProblem?.objectId ?? runtime.warehouseAcceptances[0]?.id),
    },
    {
      id: 'health-material',
      title: 'Сырье',
      value: String(rawMaterialAttention),
      detail: rawMaterialAttention > 0 ? `Дефициты/цены: ${rawMaterialAttention}.` : 'Открытых дефицитов нет.',
      scope: 'material',
      severity: rawMaterialAttention > 0 ? 'warning' : 'info',
      ownerRole: 'Склад + зав. производства',
      sourceLabel: 'складской факт / учетный снимок',
      denominatorLabel: 'План / факт / резерв / справочник цен',
      stalenessLabel: 'остаток обновлен сегодня, цена требует сверки',
      basisLabel: 'плановый расход и складской факт',
      effectiveAtLabel: 'остаток: сейчас; дата действия цены не подтверждена',
      drilldown: dashboardDrilldown('Сырье', 'orders', 'risk', firstMaterialProblem?.objectId ?? 'WH-INV-RAW'),
    },
    {
      id: 'health-penalties',
      title: 'Штрафы',
      value: String(penaltyCount),
      detail: 'Только назначенные штрафы и история ответственности.',
      scope: 'penalty',
      severity: 'info',
      ownerRole: 'Директор',
      sourceLabel: 'контур ответственности',
      denominatorLabel: 'Назначенные штрафы и история',
      stalenessLabel: 'снимок ответственности сегодня',
      basisLabel: 'назначенные штрафы, сотрудник, причина, сумма',
      effectiveAtLabel: 'текущий период штрафов',
      drilldown: dashboardDrilldown('Штрафы', 'decisions', 'risk', runtime.penalties[0]?.penaltyId),
    },
    {
      id: 'health-risk',
      title: 'QR / риски',
      value: String(criticalProblems.length),
      detail: `Критичные проблемы: ${criticalProblems.length}.`,
      scope: 'risk',
      severity: dashboardSeverity(criticalProblems.length, criticalProblems.length),
      ownerRole: 'Директор',
      sourceLabel: 'данные платформы',
      denominatorLabel: 'Открытые критичные проблемы',
      stalenessLabel: 'события платформы сегодня',
      basisLabel: 'проблемы, решения и QR-контекст',
      effectiveAtLabel: 'данные сейчас',
      drilldown: dashboardDrilldown('Требуют решения', 'decisions', 'risk', situations[0]?.objectId),
    },
  ];

  return {
    situations,
    healthSignals,
    secondaryMetrics,
    controlReport,
    selectedSituationId: situations[0]?.id,
    evidence: {
      periodLabel: 'Сейчас',
      sourceLabel: 'Данные: заказы, склад, финансы, проблемы',
      denominatorLabel: 'SLA не считаем',
    },
  };
}
