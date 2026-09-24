import type {
  PenaltyAnalyticsProjection,
  PenaltyOperatorStats,
  PenaltyReasonSummary,
  PenaltyRuntime,
} from './types';

function amountValue(label: string) {
  const normalized = label.replace(/[^\d]/g, '');
  return Number(normalized || 0);
}

function amountLabel(value: number) {
  return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
}

function reasonBucket(reason: string) {
  const normalized = reason.toLowerCase();
  if (normalized.includes('недовес') || normalized.includes('вес')) return 'Вес / допуск';
  if (normalized.includes('qr') || normalized.includes('этикет')) return 'QR / этикетка';
  if (normalized.includes('срок') || normalized.includes('задерж')) return 'Срок / задержка';
  if (normalized.includes('брак')) return 'Брак';
  if (normalized.includes('инструкц') || normalized.includes('режим')) return 'Инструкция / режим';
  return 'Прочее';
}

function latestTime(penalties: PenaltyRuntime[]) {
  return penalties[0]?.updatedAt ?? penalties[0]?.createdAt ?? 'нет';
}

function penaltyTimestamp(penalty: PenaltyRuntime) {
  return Date.parse(penalty.updatedAt ?? penalty.createdAt) || 0;
}

function buildOperatorStats(penalties: PenaltyRuntime[]): PenaltyOperatorStats[] {
  const operatorPenalties = penalties.filter((penalty) => penalty.targetRole === 'operator');
  const employees = new Map<string, string>();
  for (const penalty of operatorPenalties) {
    employees.set(penalty.employeeId, penalty.employeeName);
  }

  return [...employees.entries()].map(([employeeId, employeeName]) => {
    const rows = operatorPenalties
      .filter((penalty) => penalty.employeeId === employeeId)
      .sort((a, b) => penaltyTimestamp(b) - penaltyTimestamp(a));
    const activeRows = rows.filter((penalty) => penalty.status !== 'cancelled');
    const totalAmount = rows.reduce((sum, penalty) => sum + amountValue(penalty.amountLabel), 0);
    const latest = rows[0];
    const auditComplete = rows.filter((penalty) => penalty.history.some((item) => item.actionLabel === 'audit:penalty_created')).length;

    return {
      operatorId: employeeId,
      operatorName: employeeName,
      workplace: 'Не указано',
      shift: 'Не указана',
      totalCount: rows.length,
      activeCount: activeRows.length,
      closedCount: rows.length - activeRows.length,
      totalAmountLabel: amountLabel(totalAmount),
      lastReason: latest?.reason ?? 'Штрафов нет',
      lastScopeObjectId: latest?.scopeObjectId ?? 'нет связанного объекта',
      latestAt: latestTime(rows),
      penaltiesPerTenShiftsLabel: rows.length === 0 ? 'нет записей' : `${rows.length} по журналу`,
      penaltiesPerHundredRollsLabel: rows.length === 0 ? 'нет записей' : `${activeRows.length} активн. из ${rows.length}`,
      trend: 'stable' as const,
      auditCompletenessLabel: rows.length === 0 ? 'нет штрафов' : `${auditComplete}/${rows.length} с историей`,
      penaltyIds: rows.map((penalty) => penalty.penaltyId),
    };
  }).sort((a, b) => b.totalCount - a.totalCount || amountValue(b.totalAmountLabel) - amountValue(a.totalAmountLabel));
}

function buildReasonSummary(penalties: PenaltyRuntime[]): PenaltyReasonSummary[] {
  const operatorPenalties = penalties.filter((penalty) => penalty.targetRole === 'operator');
  const total = Math.max(1, operatorPenalties.length);
  const byReason = new Map<string, { count: number; amount: number }>();

  operatorPenalties.forEach((penalty) => {
    const key = reasonBucket(penalty.reason);
    const current = byReason.get(key) ?? { count: 0, amount: 0 };
    byReason.set(key, { count: current.count + 1, amount: current.amount + amountValue(penalty.amountLabel) });
  });

  return Array.from(byReason.entries())
    .map(([reason, value]) => ({
      reason,
      count: value.count,
      amountLabel: amountLabel(value.amount),
      shareLabel: `${Math.round((value.count / total) * 100)}%`,
    }))
    .sort((a, b) => b.count - a.count);
}

export function buildPenaltyAnalyticsProjection(penalties: PenaltyRuntime[]): PenaltyAnalyticsProjection {
  const operatorStats = buildOperatorStats(penalties);
  const operatorPenalties = penalties.filter((penalty) => penalty.targetRole === 'operator');
  const activeRows = operatorPenalties.filter((penalty) => penalty.status !== 'cancelled');
  const closedRows = operatorPenalties.length - activeRows.length;
  const totalAmount = operatorPenalties.reduce((sum, penalty) => sum + amountValue(penalty.amountLabel), 0);
  const reasonSummary = buildReasonSummary(penalties);
  const selected = operatorStats.find((operator) => operator.totalCount > 0) ?? operatorStats[0];

  return {
    summary: {
      periodLabel: 'Текущий журнал штрафов',
      totalCount: operatorPenalties.length,
      activeCount: activeRows.length,
      closedCount: closedRows,
      totalAmountLabel: amountLabel(totalAmount),
      topReasonLabel: reasonSummary[0]?.reason ?? 'нет штрафов',
      operatorCount: operatorStats.filter((operator) => operator.totalCount > 0).length,
      sourceLabel: 'журнал действий',
      denominatorLabel: 'назначенные штрафы и аудит; без нормирования на смены/рулоны',
    },
    operatorStats,
    reasonSummary,
    selectedOperatorId: selected?.operatorId,
  };
}
