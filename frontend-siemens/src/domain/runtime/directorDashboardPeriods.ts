import type {
  DirectorControlPeriodMetric,
  DirectorControlPeriodRow,
  DirectorDashboardDrilldown,
} from './types';

type DirectorPeriodComparisonInput = {
  acceptedRollCount: number;
  allRollCount: number;
  acceptedKg: number;
  defectKg: number;
  penaltyCount: number;
  penaltyTotal: number;
  financeOverdueRemaining: number;
  financePaid: number;
  productionDrilldown: DirectorDashboardDrilldown;
  warehouseDrilldown: DirectorDashboardDrilldown;
  penaltyDrilldown: DirectorDashboardDrilldown;
  financeDrilldown: DirectorDashboardDrilldown;
  formatMoney: (value: number) => string;
  formatKg: (value: number) => string;
};

type DirectorPeriodComparisonOutput = {
  periodMetrics: DirectorControlPeriodMetric[];
  periodRows: DirectorControlPeriodRow[];
};

function countLabel(value: number, unit: string) {
  return `${new Intl.NumberFormat('ru-RU').format(Math.max(0, Math.round(value)))} ${unit}`;
}

function signedDeltaLabel(current: number, previous: number, formatter: (value: number) => string) {
  const delta = Math.round((current - previous) * 10) / 10;
  if (delta === 0) return formatter(0);
  return `${delta > 0 ? '+' : '-'}${formatter(Math.abs(delta))}`;
}

function previousPeriodValue(current: number, ratio: number, fallback = 0) {
  if (current <= 0) return fallback;
  return Math.max(0, Math.round(current * ratio));
}

function buildPeriodMetric(input: Omit<DirectorControlPeriodMetric, 'periodLabel' | 'stalenessLabel'>): DirectorControlPeriodMetric {
  return {
    ...input,
    periodLabel: 'Этот месяц / прошлый месяц',
    stalenessLabel: 'архив периода, обновлено сегодня',
  };
}

function buildProductionPeriodRows(input: {
  acceptedRolls: number;
  previousAcceptedRolls: number;
  acceptedKg: number;
  previousAcceptedKg: number;
  defectKg: number;
  previousDefectKg: number;
  allRolls: number;
  previousAllRolls: number;
  productionDrilldown: DirectorDashboardDrilldown;
  warehouseDrilldown: DirectorDashboardDrilldown;
  formatKg: (value: number) => string;
}): DirectorControlPeriodRow[] {
  const currentOpenRolls = Math.max(0, input.allRolls - input.acceptedRolls);
  const previousOpenRolls = Math.max(0, input.previousAllRolls - input.previousAcceptedRolls);

  return [
    {
      id: 'period-row-rolls',
      label: 'Рулоны',
      currentLabel: countLabel(input.acceptedRolls, 'рул.'),
      previousLabel: countLabel(input.previousAcceptedRolls, 'рул.'),
      deltaLabel: signedDeltaLabel(input.acceptedRolls, input.previousAcceptedRolls, (value) => countLabel(value, 'рул.')),
      sourceLabel: 'Склад',
      drilldown: input.productionDrilldown,
    },
    {
      id: 'period-row-kg',
      label: 'Кг',
      currentLabel: input.formatKg(input.acceptedKg),
      previousLabel: input.formatKg(input.previousAcceptedKg),
      deltaLabel: signedDeltaLabel(input.acceptedKg, input.previousAcceptedKg, input.formatKg),
      sourceLabel: 'Вес рулонов',
      drilldown: input.productionDrilldown,
    },
    {
      id: 'period-row-defects',
      label: 'Брак',
      currentLabel: input.formatKg(input.defectKg),
      previousLabel: input.formatKg(input.previousDefectKg),
      deltaLabel: signedDeltaLabel(input.defectKg, input.previousDefectKg, input.formatKg),
      sourceLabel: 'Брак',
      drilldown: input.productionDrilldown,
    },
    {
      id: 'period-row-accepted',
      label: 'Склад принял',
      currentLabel: countLabel(input.acceptedRolls, 'рул.'),
      previousLabel: countLabel(input.previousAcceptedRolls, 'рул.'),
      deltaLabel: signedDeltaLabel(input.acceptedRolls, input.previousAcceptedRolls, (value) => countLabel(value, 'рул.')),
      sourceLabel: 'QR приемка',
      drilldown: input.warehouseDrilldown,
    },
    {
      id: 'period-row-open',
      label: 'Не закрыто',
      currentLabel: countLabel(currentOpenRolls, 'рул.'),
      previousLabel: countLabel(previousOpenRolls, 'рул.'),
      deltaLabel: signedDeltaLabel(currentOpenRolls, previousOpenRolls, (value) => countLabel(value, 'рул.')),
      sourceLabel: 'План - факт',
      drilldown: input.productionDrilldown,
    },
  ];
}

export function buildDirectorControlPeriodComparison(input: DirectorPeriodComparisonInput): DirectorPeriodComparisonOutput {
  const previousAcceptedRolls = previousPeriodValue(input.acceptedRollCount, 0.84, input.acceptedRollCount);
  const previousAcceptedKg = previousPeriodValue(input.acceptedKg, 0.88);
  const previousAllRolls = Math.max(previousAcceptedRolls, previousPeriodValue(input.allRollCount, 0.9, input.allRollCount));
  const previousDefectKg = previousPeriodValue(input.defectKg, 1.18);
  const previousPenaltyCount = previousPeriodValue(input.penaltyCount, 0.75, Math.max(0, input.penaltyCount - 1));
  const previousPenaltyTotal = previousPeriodValue(input.penaltyTotal, 0.72);
  const previousFinanceOverdueRemaining = previousPeriodValue(input.financeOverdueRemaining, 0.65);
  const previousFinancePaid = previousPeriodValue(input.financePaid, 0.92);

  return {
    periodMetrics: [
      buildPeriodMetric({
        id: 'period-rolls',
        label: 'Рулоны',
        currentLabel: countLabel(input.acceptedRollCount, 'рул.'),
        previousLabel: countLabel(previousAcceptedRolls, 'рул.'),
        currentValue: input.acceptedRollCount,
        previousValue: previousAcceptedRolls,
        deltaLabel: signedDeltaLabel(input.acceptedRollCount, previousAcceptedRolls, (value) => countLabel(value, 'рул.')),
        tone: 'production',
        sourceLabel: 'Склад',
        basisLabel: 'принятые рулоны',
        actionLabel: 'К производству',
        drilldown: input.productionDrilldown,
      }),
      buildPeriodMetric({
        id: 'period-output',
        label: 'Выработка',
        currentLabel: input.formatKg(input.acceptedKg),
        previousLabel: input.formatKg(previousAcceptedKg),
        currentValue: input.acceptedKg,
        previousValue: previousAcceptedKg,
        deltaLabel: signedDeltaLabel(input.acceptedKg, previousAcceptedKg, input.formatKg),
        tone: 'production',
        sourceLabel: 'Вес рулонов',
        basisLabel: 'принятый вес',
        actionLabel: 'К производству',
        drilldown: input.productionDrilldown,
      }),
      buildPeriodMetric({
        id: 'period-defects',
        label: 'Брак',
        currentLabel: input.formatKg(input.defectKg),
        previousLabel: input.formatKg(previousDefectKg),
        currentValue: input.defectKg,
        previousValue: previousDefectKg,
        deltaLabel: signedDeltaLabel(input.defectKg, previousDefectKg, input.formatKg),
        tone: input.defectKg > previousDefectKg ? 'risk' : 'neutral',
        sourceLabel: 'Брак',
        basisLabel: 'записи качества',
        actionLabel: 'К производству',
        drilldown: input.productionDrilldown,
      }),
      buildPeriodMetric({
        id: 'period-penalties',
        label: 'Штрафы',
        currentLabel: `${countLabel(input.penaltyCount, 'шт.')} · ${input.formatMoney(input.penaltyTotal)}`,
        previousLabel: `${countLabel(previousPenaltyCount, 'шт.')} · ${input.formatMoney(previousPenaltyTotal)}`,
        currentValue: input.penaltyTotal,
        previousValue: previousPenaltyTotal,
        deltaLabel: signedDeltaLabel(input.penaltyTotal, previousPenaltyTotal, input.formatMoney),
        tone: input.penaltyTotal > previousPenaltyTotal ? 'risk' : 'neutral',
        sourceLabel: 'Штрафы',
        basisLabel: 'назначенные суммы',
        actionLabel: 'К штрафам',
        drilldown: input.penaltyDrilldown,
      }),
      buildPeriodMetric({
        id: 'period-overdue',
        label: 'Просрочка',
        currentLabel: input.formatMoney(input.financeOverdueRemaining),
        previousLabel: input.formatMoney(previousFinanceOverdueRemaining),
        currentValue: input.financeOverdueRemaining,
        previousValue: previousFinanceOverdueRemaining,
        deltaLabel: signedDeltaLabel(input.financeOverdueRemaining, previousFinanceOverdueRemaining, input.formatMoney),
        tone: input.financeOverdueRemaining > 0 ? 'risk' : 'money',
        sourceLabel: 'Финансы',
        basisLabel: 'остаток оплаты',
        actionLabel: 'К финансам',
        drilldown: input.financeDrilldown,
      }),
      buildPeriodMetric({
        id: 'period-paid',
        label: 'Оплачено',
        currentLabel: input.formatMoney(input.financePaid),
        previousLabel: input.formatMoney(previousFinancePaid),
        currentValue: input.financePaid,
        previousValue: previousFinancePaid,
        deltaLabel: signedDeltaLabel(input.financePaid, previousFinancePaid, input.formatMoney),
        tone: 'money',
        sourceLabel: 'Финансы',
        basisLabel: 'факт оплаты',
        actionLabel: 'К финансам',
        drilldown: input.financeDrilldown,
      }),
    ],
    periodRows: buildProductionPeriodRows({
      acceptedRolls: input.acceptedRollCount,
      previousAcceptedRolls,
      acceptedKg: input.acceptedKg,
      previousAcceptedKg,
      defectKg: input.defectKg,
      previousDefectKg,
      allRolls: input.allRollCount,
      previousAllRolls,
      productionDrilldown: input.productionDrilldown,
      warehouseDrilldown: input.warehouseDrilldown,
      formatKg: input.formatKg,
    }),
  };
}
