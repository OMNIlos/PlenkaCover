import type { ActionDescriptor, Fact, OperatorRollLine, OperatorShift, OperatorWorkbench, OrderRollGroup, ProblemCase, WorkListItem, WorkObject } from '../types';
import { qrDisplayLabel } from '../qrDisplay';
import type {
  OperatorOrderHubGroup,
  OperatorOrderRuntime,
  OperatorOrderStatus,
  OperatorQueueDirection,
  OperatorRollHubRow,
  OperatorRollHubSortDirection,
  OperatorRollHubSortKey,
  OperatorRuntimeState,
} from './types';

const operatorOrderStatuses = new Set<OperatorOrderStatus>([
  'assigned',
  'spool_weight',
  'roll_scale_activation',
  'roll_weight',
  'qr_print',
  'qr_check',
  'handover',
  'deferred',
  'defect',
  'warehouse',
]);

const operatorRollWeightNumber = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
});

function selectedRollStatus(
  roll: OperatorRollLine,
  fallback: OperatorOrderStatus,
): OperatorOrderStatus {
  return operatorOrderStatuses.has(roll.status as OperatorOrderStatus)
    ? (roll.status as OperatorOrderStatus)
    : fallback;
}

export function operatorStatusLabel(status: OperatorOrderStatus) {
  const labels: Record<OperatorOrderStatus, string> = {
    assigned: 'Новый',
    spool_weight: 'В работе',
    roll_scale_activation: 'Сигнал веса',
    roll_weight: 'В работе',
    qr_print: 'Печать QR',
    qr_check: 'Сканировать QR',
    handover: 'Ждет передачу',
    deferred: 'Отложен',
    defect: 'Брак',
    warehouse: 'Передано на склад',
  };
  return labels[status];
}

export function operatorStepForStatus(status: OperatorOrderStatus) {
  const labels: Record<OperatorOrderStatus, string> = {
    assigned: 'Примите заказ',
    spool_weight: 'Зафиксируйте вес шпули',
    roll_scale_activation: 'Зафиксируйте вес рулона',
    roll_weight: 'Зафиксируйте вес рулона',
    qr_print: 'Напечатайте QR',
    qr_check: 'Сканируйте QR',
    handover: 'Передайте рулон на склад',
    deferred: 'Возобновите заказ',
    defect: 'Брак зафиксирован',
    warehouse: 'Операторская часть закрыта',
  };
  return labels[status];
}

export function operatorStepShortLabel(status: OperatorOrderStatus) {
  const labels: Record<OperatorOrderStatus, string> = {
    assigned: 'Принять',
    spool_weight: 'Шпуля',
    roll_scale_activation: 'Вес',
    roll_weight: 'Рулон',
    qr_print: 'Печать QR',
    qr_check: 'QR',
    handover: 'Склад',
    deferred: 'Возобновить',
    defect: 'Брак',
    warehouse: 'Склад',
  };
  return labels[status];
}

export function operatorOrderOpenLabel(status: OperatorOrderStatus) {
  if (status === 'assigned') return 'Перейти к заказу';
  if (status === 'deferred') return 'Возобновить';
  if (status === 'defect') return 'Открыть историю';
  if (status === 'warehouse') return 'К следующему';
  return 'Продолжить';
}

export function operatorInstructionForStatus(status: OperatorOrderStatus) {
  const labels: Record<OperatorOrderStatus, string> = {
    assigned: 'Примите заказ',
    spool_weight: 'Зафиксируйте вес шпули',
    roll_scale_activation: 'Зафиксируйте вес рулона',
    roll_weight: 'Зафиксируйте вес рулона',
    qr_print: 'Напечатайте QR',
    qr_check: 'Сканируйте QR',
    handover: 'Передайте рулон на склад',
    deferred: 'Возобновите заказ',
    defect: 'Новая попытка уже создана',
    warehouse: 'Операторская часть закрыта',
  };
  return labels[status];
}

export function operatorShiftStatusLabel(status: OperatorShift['status']) {
  const labels: Record<OperatorShift['status'], string> = {
    scheduled: 'Смена запланирована',
    start_missing: 'Нужен старт',
    active: 'Смена открыта',
    bag_missing: 'Нужен Big-Bag',
    close_pending: 'Сдача смены',
    closed: 'Смена закрыта',
  };
  return labels[status];
}

export function operatorShiftSeverity(status: OperatorShift['status']): WorkObject['severity'] {
  if (status === 'scheduled' || status === 'active' || status === 'closed') return 'info';
  return status === 'start_missing' || status === 'bag_missing'
    ? 'critical'
    : 'warning';
}

export function operatorShiftDateTimeLabel(value: string | undefined) {
  if (!value) return 'Время не указано';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Время не указано';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function operatorShiftBlockerText(shift: OperatorShift) {
  if (shift.status === 'scheduled') return 'Смена ещё не началась';
  if (shift.status === 'start_missing') return 'Нет стартового веса Big-bag';
  if (shift.status === 'bag_missing') return 'Нет активного Big-Bag';
  if (shift.status === 'close_pending') return 'Смена сдается';
  if (shift.status === 'closed') return 'Смена закрыта';
  return undefined;
}

export function operatorShiftRecoveryText(shift: OperatorShift) {
  if (shift.status === 'scheduled') {
    return `Старт по плану: ${operatorShiftDateTimeLabel(shift.plannedStartAt)}`;
  }
  if (shift.status === 'start_missing') return 'Откройте раздел Смена и зафиксируйте стартовый вес';
  if (shift.status === 'bag_missing') {
    return 'Подключите следующий Big-Bag или сдайте смену';
  }
  if (shift.status === 'close_pending') return 'Зафиксируйте финальный вес Big-bag и закройте смену';
  if (shift.status === 'closed') return 'Откройте новую смену перед производственными действиями';
  return undefined;
}

export function parseManualKg(value: string | undefined) {
  if (!value) return null;
  const normalized = value.replace(',', '.').trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number(parsed.toFixed(1));
}

export function actionWeightValue(actionId: string, prefix: string) {
  if (!actionId.startsWith(prefix)) return null;
  return parseManualKg(actionId.slice(prefix.length));
}

export function operatorCurrentRoll(order: OperatorOrderRuntime) {
  return order.rolls.find(
    (roll) =>
      Boolean(order.currentDispatchItemId) &&
      roll.dispatchItemId === order.currentDispatchItemId,
  )
    ?? order.rolls.find(
      (roll) => roll.sequenceNumber === order.currentRoll && roll.status !== 'defect',
    )
    ?? order.rolls.find((roll) => roll.sequenceNumber === order.currentRoll)
    ?? order.rolls.find((roll) => roll.warehouseState !== 'sent' && roll.warehouseState !== 'received' && roll.warehouseState !== 'delivered')
    ?? order.rolls[order.rolls.length - 1];
}

export function isOperatorCurrentRoll(
  order: OperatorOrderRuntime,
  roll: OperatorRollLine,
) {
  const current = operatorCurrentRoll(order);
  return Boolean(
    current &&
      (current.dispatchItemId && roll.dispatchItemId
        ? current.dispatchItemId === roll.dispatchItemId
        : current.id === roll.id),
  );
}

export function canOperatorReweigh(order: OperatorOrderRuntime) {
  if (order.status !== 'qr_print') return false;
  const roll = operatorCurrentRoll(order);
  const netKg = roll?.actualNetKg ?? roll?.netKg;
  return Boolean(
    roll &&
      roll.labelState === 'not_printed' &&
      Number.isFinite(netKg) &&
      netKg !== undefined &&
      netKg > 0,
  );
}

export function canOperatorRecoverInvalidHandoverWeight(order: OperatorOrderRuntime) {
  if (order.status !== 'handover') return false;
  const roll = operatorCurrentRoll(order);
  const netKg = roll?.actualNetKg ?? roll?.netKg;
  return Boolean(
    roll &&
      roll.labelState === 'verified' &&
      roll.warehouseState === 'not_ready' &&
      typeof netKg === 'number' &&
      Number.isFinite(netKg) &&
      netKg <= 0,
  );
}

export function operatorGroupForRoll(order: OperatorOrderRuntime, roll: OperatorRollLine | undefined) {
  return order.rollGroups.find((group) => group.id === roll?.groupId) ?? order.rollGroups[0];
}

export function operatorRollGroupLabel(group: OrderRollGroup | undefined) {
  if (!group) return 'Группа';
  return group.appliesFromRollSequence
    ? `${group.title} · с рулона ${group.appliesFromRollSequence}`
    : group.title;
}

export function operatorRollQrWarehouseLabel(roll: OperatorRollLine) {
  if (roll.labelState === 'delivery_unknown') return 'результат печати неизвестен';
  if (roll.warehouseState === 'sent') return 'передан на склад';
  if (roll.warehouseState === 'received') return 'принят складом';
  if (roll.warehouseState === 'delivered') return 'выдан';
  if (roll.labelState === 'verified') return 'QR готов';
  if (roll.labelState === 'submitted') return 'задание печати отправлено';
  if (roll.labelState === 'printed') return 'legacy-печать ждет скан';
  if (roll.labelState === 'applied') return 'ждет QR';
  if (roll.labelState === 'not_printed') return 'этикетка не напечатана';
  return roll.labelState;
}

export function operatorRollPlanKg(order: OperatorOrderRuntime) {
  return operatorCurrentRoll(order)?.plannedNetKg ?? order.rollPlanKg;
}

export function operatorRollFactValue(value: number | undefined, fallback = '-') {
  return typeof value === 'number' ? `${value.toFixed(1)} кг` : fallback;
}

export function operatorCompletedNetKg(order: OperatorOrderRuntime) {
  return Number(order.rolls.reduce((sum, roll) => sum + (roll.actualNetKg ?? roll.netKg ?? 0), 0).toFixed(1));
}

export function operatorToleranceLabel(roll?: OperatorRollLine) {
  if (!roll || roll.toleranceState === 'pending') return 'Ждет факт';
  if (roll.toleranceState === 'within') return 'В допуске';
  if (roll.toleranceState === 'warning') return 'Проверить';
  return 'Блокер';
}

export function operatorRollStatusSeverity(roll?: OperatorRollLine): WorkObject['severity'] {
  if (roll?.labelState === 'delivery_unknown') return 'critical';
  if (roll?.status === 'defect') return 'critical';
  if (!roll || roll.toleranceState === 'pending') return 'warning';
  if (roll.toleranceState === 'blocked') return 'critical';
  if (roll.toleranceState === 'warning') return 'warning';
  return 'info';
}

export function operatorStageSignalForOrder(order: OperatorOrderRuntime, shift: OperatorShift): OperatorWorkbench['stageSignal'] {
  const currentRoll = operatorCurrentRoll(order);
  const currentGroup = operatorGroupForRoll(order, currentRoll);
  const rollLabel = currentRoll
    ? `R-${currentRoll.sequenceNumber}`
    : `Рулон ${order.rollProgress.current}`;

  if (shift.status !== 'active' && order.status !== 'warehouse') {
    return {
      kind: 'shift',
      title: 'Смена',
      value: operatorShiftStatusLabel(shift.status),
      severity: operatorShiftSeverity(shift.status),
      facts: [
        { label: 'Big-bag', value: shift.bigBagId },
        { label: 'Старт', value: shift.startKg ? `${shift.startKg} кг` : 'не введен', severity: shift.startKg ? 'info' : 'critical' },
        { label: 'Остаток', value: `${shift.expectedEndKg} кг` },
      ],
    };
  }

  if (currentRoll?.labelState === 'delivery_unknown') {
    return {
      kind: 'qr', title: 'Печать QR', value: 'Результат печати неизвестен',
      severity: 'critical', facts: [],
    };
  }

  if (order.status === 'assigned') {
    return {
      kind: 'order',
      title: 'Готовность',
      value: 'Заказ не принят',
      severity: 'info',
      facts: [
        { label: 'Станок', value: order.workplace },
        {
          label: 'Рулон',
          value: `${order.rollProgress.current} из ${order.rollProgress.total}`,
        },
        { label: 'План', value: `${currentGroup?.plannedNetKg ?? order.rollPlanKg} кг` },
      ],
    };
  }

  if (order.status === 'spool_weight') {
    const standardSpool = currentRoll?.spoolWeightPolicy === 'standard_700g';
    const activated = Boolean(currentRoll?.spoolScaleActivated);
    return {
      kind: 'scale',
      title: standardSpool ? 'Шпуля' : 'Весы · шпуля',
      value: standardSpool
        ? '0,7 кг'
        : currentRoll?.spoolKg
          ? operatorRollFactValue(currentRoll.spoolKg)
          : 'Стабильный сигнал',
      severity: standardSpool || currentRoll?.spoolKg || activated ? 'info' : 'warning',
      facts: [
        { label: 'Рулон', value: rollLabel },
        { label: 'Источник', value: standardSpool ? 'норма тонкой шпули' : 'сигнал весов' },
        { label: 'Состояние', value: standardSpool ? 'готово к фиксации' : activated ? 'сигнал готов' : 'ожидает фиксации', severity: standardSpool || activated ? 'info' : 'warning' },
        { label: 'Записано', value: operatorRollFactValue(currentRoll?.spoolKg) },
      ],
    };
  }

  if (order.status === 'roll_weight') {
    const spoolKg = currentRoll?.spoolKg ?? order.spoolKg;
    const activated = Boolean(currentRoll?.rollScaleActivated);
    return {
      kind: 'scale',
      title: 'Весы · рулон',
      value: currentRoll?.grossKg ? operatorRollFactValue(currentRoll.grossKg) : 'Стабильный сигнал',
      severity: currentRoll?.netKg || activated ? 'info' : 'warning',
      facts: [
        { label: 'Шпуля', value: operatorRollFactValue(spoolKg) },
        { label: 'Нетто план', value: `${currentGroup?.plannedNetKg ?? order.rollPlanKg} кг` },
        { label: 'Состояние', value: activated ? 'сигнал готов' : 'ожидает фиксации', severity: activated ? 'info' : 'warning' },
        { label: 'Записано', value: operatorRollFactValue(currentRoll?.netKg) },
      ],
    };
  }

  if (order.status === 'roll_scale_activation') {
    return {
      kind: 'scale',
      title: 'Весы · рулон',
      value: 'Стабильный сигнал',
      severity: 'warning',
      facts: [
        { label: 'Рулон', value: rollLabel },
        { label: 'Источник', value: 'сигнал весов' },
        { label: 'Факт веса', value: 'не записан', severity: 'warning' },
      ],
    };
  }

  if (order.status === 'qr_check') {
    return {
      kind: 'qr',
      title: 'QR',
      value: qrDisplayLabel(currentRoll?.qrCode) ?? currentRoll?.id ?? order.orderId,
      severity: 'warning',
      facts: [
        {
          label: 'Этикетка',
          value:
            currentRoll?.labelState === 'verified'
              ? 'проверена сканом'
              : 'задание отправлено; физический выход не подтвержден',
        },
        { label: 'Нетто', value: operatorRollFactValue(currentRoll?.netKg ?? order.rollNetKg) },
        { label: 'Последний скан', value: currentRoll?.labelState === 'verified' ? 'готово' : 'ждет' },
      ],
    };
  }

  if (order.status === 'qr_print') {
    return {
      kind: 'qr',
      title: 'Печать QR',
      value: qrDisplayLabel(currentRoll?.qrCode) ?? `QR-${currentRoll?.id ?? order.orderId}`,
      severity: 'warning',
      facts: [
        { label: 'Этикетка', value: 'не напечатана', severity: 'warning' },
        { label: 'Нетто', value: operatorRollFactValue(currentRoll?.netKg ?? order.rollNetKg) },
        { label: 'Действие', value: 'Скан QR' },
      ],
    };
  }

  if (order.status === 'handover' || order.status === 'warehouse') {
    return {
      kind: 'handover',
      title: 'Склад',
      value: order.status === 'warehouse' ? 'Передано' : 'Готово к передаче',
      severity: 'info',
      facts: [
        { label: 'Рулон', value: currentRoll?.id ?? rollLabel },
        { label: 'QR', value: currentRoll?.labelState === 'verified' ? 'отсканирован' : 'ждет' },
        { label: 'Следующий', value: 'Склад' },
      ],
    };
  }

  return {
    kind: 'order',
    title: 'Отложен',
    value: `${order.rollProgress.completed} из ${order.rollProgress.total}`,
    severity: 'warning',
    facts: [
      { label: 'Продолжить с', value: rollLabel },
      {
        label: 'Осталось',
        value: `${Math.max(order.rollProgress.total - order.rollProgress.completed, 0)} рул.`,
      },
      { label: 'Станок', value: order.workplace },
    ],
  };
}

export function operatorNextRollSequence(order: OperatorOrderRuntime, currentSequence: number) {
  return order.rolls
    .filter((roll) => roll.sequenceNumber > currentSequence)
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0]?.sequenceNumber;
}

export function operatorFilterTags(order: OperatorOrderRuntime) {
  const tags = [OPERATOR_ROLLS_SECTION, 'Мои рулоны', 'Мои заказы'];
  if (order.status === 'assigned') tags.push('Ожидают', 'Требуют действия');
  if (['spool_weight', 'roll_scale_activation', 'roll_weight', 'qr_print', 'qr_check', 'handover'].includes(order.status)) tags.push('В работе', 'Требуют действия');
  if (order.status === 'deferred') tags.push('Отложены', 'Требуют действия');
  if (order.status === 'warehouse') tags.push('Переданы на склад', 'Завершены');
  return tags;
}

export function operatorFacts(order: OperatorOrderRuntime): Fact[] {
  const currentRoll = operatorCurrentRoll(order);
  const currentGroup = operatorGroupForRoll(order, currentRoll);
  return [
    { label: 'Заказ', value: order.orderId, scope: 'operator' },
    { label: 'Шаблон', value: order.templateName, scope: 'operator' },
    { label: 'Тип', value: order.filmType, scope: 'operator' },
    {
      label: 'Рулоны',
      value: `${order.rollProgress.completed} из ${order.rollProgress.total}`,
      scope: 'operator',
    },
    {
      label: 'Текущий рулон',
      value: `${order.rollProgress.current} из ${order.rollProgress.total}`,
      scope: 'operator',
    },
    { label: 'Текущий шаг', value: operatorStepForStatus(order.status), scope: 'operator' },
    { label: 'Реальная толщина', value: currentGroup?.micron ?? order.realMicron, scope: 'operator' },
    { label: 'Размер', value: currentGroup?.sizeMeters ?? order.sizeMeters, scope: 'operator' },
    { label: 'План рулона', value: `${currentRoll?.plannedNetKg ?? order.rollPlanKg} кг`, scope: 'operator' },
    { label: 'Допуск', value: `±${currentGroup?.tolerancePercent ?? 2}%`, scope: 'operator' },
  ];
}

export function operatorOrderSummary(order: OperatorOrderRuntime) {
  const progress = `${order.rollProgress.completed} из ${order.rollProgress.total} рулонов`;
  if (order.status === 'warehouse') return `${progress} · передано на склад`;
  if (order.status === 'deferred') return `${progress} · отложен`;
  if (order.status === 'assigned') return `${progress} · ожидает принятия`;
  return `${progress} · ${operatorStepForStatus(order.status)}`;
}

export function operatorOrderSeverity(order: OperatorOrderRuntime): WorkObject['severity'] {
  if (order.status === 'deferred' || order.status === 'roll_scale_activation' || order.status === 'qr_print' || order.status === 'qr_check') return 'warning';
  return 'info';
}

export function operatorBlockerForCard(runtime: OperatorRuntimeState, order: OperatorOrderRuntime) {
  const balanceProblems = operatorBalanceProblems(runtime, order.id);
  if (balanceProblems.length > 0) return balanceProblems[0].title;
  if (runtime.shift.status !== 'active' && order.status !== 'warehouse') {
    return operatorShiftBlockerText(runtime.shift) ?? 'Смена не открыта';
  }
  if (order.problemCount > 0) return 'Есть открытая проблема';
  return undefined;
}

export function operatorPersonalQueueBlockedReason(
  runtime: OperatorRuntimeState,
  order: OperatorOrderRuntime | undefined,
  index: number,
  direction: OperatorQueueDirection
) {
  if (!order || index < 0) return 'Заказ не найден в Моих заказах';
  if (order.status === 'warehouse') return 'Переданные на склад строки не переставляются';

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0) return 'Заказ уже первый в Моих заказах';
  if (targetIndex >= runtime.orders.length) return 'Заказ уже последний в Моих заказах';
  if (runtime.orders[targetIndex]?.status === 'warehouse') return 'Переданные на склад строки остаются после активных задач';

  return null;
}

export function operatorBalanceProblems(runtime: OperatorRuntimeState, objectId: string): ProblemCase[] {
  const reportedProblems = runtime.reportedProblems?.[objectId] ?? [];
  const deviation = runtime.shift.deviationPercent ?? 0;
  if (runtime.shift.status !== 'closed' || Math.abs(deviation) <= 2 || runtime.balanceProblemOrderId !== objectId) return reportedProblems;
  return [
    {
      id: 'p-operator-bigbag-balance',
      objectId,
      type: 'weight_deviation',
      entityKind: 'weight_device',
      entityId: runtime.shift.id,
      createdByRole: 'operator',
      targetRole: 'production',
      sourceActionId: 'operator-shift-balance',
      stage: 'Big-bag',
      title: 'Отклонение расхода Big-bag',
      severity: 'critical',
      ownerRole: 'Зав. производства',
      due: 'после смены',
      reason: `Финальный вес отличается от расчетного остатка на ${deviation}%, baseline допуска 2%.`,
      recovery: 'Разобрать расход смены с зав. производства и директором',
      status: 'open',
    },
    ...reportedProblems,
  ];
}

export function operatorNextWorkOrderId(runtime: OperatorRuntimeState, currentOrderId: string) {
  const currentIndex = runtime.orders.findIndex((order) => order.id === currentOrderId);
  const orderedCandidates = currentIndex >= 0
    ? [...runtime.orders.slice(currentIndex + 1), ...runtime.orders.slice(0, currentIndex)]
    : runtime.orders;

  return orderedCandidates.find((order) => order.status !== 'warehouse')?.id ?? null;
}

export const OPERATOR_ROLLS_SECTION = 'Рулоны и заказы';

export function normalizeOperatorSection(section: string) {
  if (section === 'Мои рулоны' || section === 'Мои заказы') return OPERATOR_ROLLS_SECTION;
  return section;
}

function isOperatorRollArchived(roll: OperatorRollLine) {
  return roll.warehouseState === 'sent' || roll.warehouseState === 'received' || roll.warehouseState === 'delivered';
}

function operatorRollDateKey(value: string | undefined) {
  return value?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
}

function operatorRollPriorityRank(priority: string) {
  if (priority === 'критично') return 0;
  if (priority === 'срочно') return 1;
  return 2;
}

function operatorRollWeightLabel(roll: OperatorRollLine) {
  const fact = roll.actualNetKg ?? roll.netKg;
  return fact ? `${fact} / ${roll.plannedNetKg} кг` : `план ${roll.plannedNetKg} кг`;
}

function operatorRollPlannedWeightLabel(plannedNetKg: number) {
  return Number.isFinite(plannedNetKg) && plannedNetKg > 0
    ? `${operatorRollWeightNumber.format(plannedNetKg)} кг`
    : 'не указан';
}

function operatorRollHubBlocker(runtime: OperatorRuntimeState, order: OperatorOrderRuntime, roll: OperatorRollLine) {
  if (roll.status === 'defect') return 'Брак: создана новая попытка';
  if (roll.labelState === 'delivery_unknown') return 'Печать требует сверки';
  const balanceProblems = operatorBalanceProblems(runtime, order.id);
  if (runtime.shift.status !== 'active' && !isOperatorRollArchived(roll)) return operatorShiftBlockerText(runtime.shift) ?? 'Смена не открыта';
  if (balanceProblems.length > 0) return balanceProblems[0].title;
  if (order.problemCount > 0) return 'Есть проблема';
  if (roll.toleranceState === 'blocked') return 'Вес вне допуска';
  if (roll.toleranceState === 'warning') return 'Проверить вес';
  return 'Нет';
}

function operatorRollHubSeverity(runtime: OperatorRuntimeState, order: OperatorOrderRuntime, roll: OperatorRollLine): OperatorRollHubRow['severity'] {
  if (roll.status === 'defect') return 'critical';
  if (roll.labelState === 'delivery_unknown') return 'critical';
  if (runtime.shift.status !== 'active' && !isOperatorRollArchived(roll)) return 'critical';
  if (operatorBalanceProblems(runtime, order.id).length > 0 || roll.toleranceState === 'blocked') return 'critical';
  if (order.status === 'deferred' || roll.toleranceState === 'warning' || ['qr_print', 'qr_check', 'roll_scale_activation'].includes(order.status)) return 'warning';
  return 'info';
}

export function operatorRollHubRows(runtime: OperatorRuntimeState): OperatorRollHubRow[] {
  return runtime.orders.flatMap((order) =>
    order.rolls.map((roll, index) => {
      const group = operatorGroupForRoll(order, roll);
      const archived = isOperatorRollArchived(roll);
      const current = isOperatorCurrentRoll(order, roll) && order.status !== 'warehouse';
      const orderCode = roll.orderNumber ?? order.orderId;
      const handoverAt = archived ? roll.sentToWarehouseAt : undefined;
      const updatedAt = handoverAt ?? roll.updatedAt ?? order.lastEventAt;
      const parameters = [group?.micron ?? order.realMicron, group?.sizeMeters ?? order.sizeMeters, group?.filmType ?? order.filmType]
        .filter(Boolean)
        .join(' · ');

      return {
        id: roll.id,
        orderId: order.id,
        orderCode,
        orderTitle: order.title,
        customerAlias: order.customerAlias,
        roll,
        queueRank: roll.queueRank ?? (index + 1) * 100,
        rollProgress: order.rollProgress,
        priority: roll.priority ?? 'обычный',
        status:
          roll.status === 'defect'
            ? 'Брак'
            : archived
              ? 'Передан'
              : current
                ? operatorStatusLabel(order.status)
                : operatorRollQrWarehouseLabel(roll),
        step: archived ? 'Закрыт' : operatorRollActionLabel(order, roll),
        machine: roll.machineLabel ?? order.workplace,
        parameters,
        recipe: group?.recipe.trim() || 'Рецептура не указана',
        plannedWeight: operatorRollPlannedWeightLabel(roll.plannedNetKg),
        weight: operatorRollWeightLabel(roll),
        qrWarehouse: operatorRollQrWarehouseLabel(roll),
        blocker: operatorRollHubBlocker(runtime, order, roll),
        updated: updatedAt,
        dateKey: operatorRollDateKey(updatedAt),
        handoverAt,
        isCurrent: current,
        isArchived: archived,
        severity: operatorRollHubSeverity(runtime, order, roll),
      };
    })
  );
}

function compareOperatorRollHubRows(left: OperatorRollHubRow, right: OperatorRollHubRow, key: OperatorRollHubSortKey) {
  if (key === 'roll') return left.id.localeCompare(right.id, 'ru') || left.roll.sequenceNumber - right.roll.sequenceNumber;
  if (key === 'order') return left.orderCode.localeCompare(right.orderCode, 'ru') || left.roll.sequenceNumber - right.roll.sequenceNumber;
  if (key === 'priority') return operatorRollPriorityRank(left.priority) - operatorRollPriorityRank(right.priority);
  if (key === 'status') return left.status.localeCompare(right.status, 'ru');
  if (key === 'step') return left.step.localeCompare(right.step, 'ru');
  if (key === 'machine') return left.machine.localeCompare(right.machine, 'ru');
  if (key === 'parameters') return left.parameters.localeCompare(right.parameters, 'ru');
  if (key === 'weight') return left.roll.plannedNetKg - right.roll.plannedNetKg;
  if (key === 'qr') return left.qrWarehouse.localeCompare(right.qrWarehouse, 'ru');
  if (key === 'blocker') return left.blocker.localeCompare(right.blocker, 'ru');
  if (key === 'updated') return (left.handoverAt ?? left.updated).localeCompare(right.handoverAt ?? right.updated, 'ru');
  return left.queueRank - right.queueRank;
}

export function sortOperatorRollHubRows(rows: OperatorRollHubRow[], key: OperatorRollHubSortKey = 'queue', direction: OperatorRollHubSortDirection = 'asc') {
  const directionFactor = direction === 'desc' ? -1 : 1;
  return [...rows].sort((left, right) => {
    const primary = compareOperatorRollHubRows(left, right, key);
    if (primary !== 0) return primary * directionFactor;
    return left.queueRank - right.queueRank
      || operatorRollPriorityRank(left.priority) - operatorRollPriorityRank(right.priority)
      || left.orderCode.localeCompare(right.orderCode, 'ru')
      || left.roll.sequenceNumber - right.roll.sequenceNumber;
  });
}

export function operatorRollHubGroups(rows: OperatorRollHubRow[]): OperatorOrderHubGroup[] {
  const groups = new Map<string, OperatorOrderHubGroup>();

  rows.forEach((row) => {
    const existing = groups.get(row.orderId);
    if (existing) {
      existing.rows.push(row);
      existing.activeRolls += row.isArchived ? 0 : 1;
      existing.archivedRolls += row.isArchived ? 1 : 0;
      existing.blockedRolls += row.blocker !== 'Нет' ? 1 : 0;
      return;
    }

    groups.set(row.orderId, {
      id: row.orderId,
      orderCode: row.orderCode,
      title: row.orderTitle,
      customerAlias: row.customerAlias,
      status: row.status,
      priority: row.priority,
      updated: row.updated,
      progress: `${row.rollProgress.completed}/${row.rollProgress.total} рул.`,
      activeRolls: row.isArchived ? 0 : 1,
      archivedRolls: row.isArchived ? 1 : 0,
      blockedRolls: row.blocker !== 'Нет' ? 1 : 0,
      rows: [row],
    });
  });

  return Array.from(groups.values()).map((group) => {
    const progress = group.rows[0]?.rollProgress;
    return {
      ...group,
      progress: `${progress?.completed ?? 0}/${progress?.total ?? 0} рул.`,
    };
  });
}

function operatorRollFilterTags(order: OperatorOrderRuntime, roll: OperatorRollLine) {
  const tags = [OPERATOR_ROLLS_SECTION, 'Мои рулоны', 'Мои заказы'];
  if (roll.status === 'defect') {
    tags.push('С проблемами');
    return tags;
  }
  if (order.status === 'assigned') tags.push('Ожидают', 'Требуют действия');
  if (['spool_weight', 'roll_scale_activation', 'roll_weight', 'qr_print', 'qr_check', 'handover'].includes(order.status)) tags.push('В работе', 'Требуют действия');
  if (order.status === 'deferred') tags.push('Отложены');
  if (isOperatorRollArchived(roll)) tags.push('Переданы на склад', 'Завершены');
  if (
    roll.toleranceState === 'blocked' ||
    roll.toleranceState === 'warning'
  ) {
    tags.push('С проблемами');
  }
  return tags;
}

function operatorRollActionLabel(order: OperatorOrderRuntime, roll: OperatorRollLine) {
  if (roll.warehouseState === 'sent' || roll.warehouseState === 'received' || roll.warehouseState === 'delivered') return 'Закрыт';
  if (roll.status === 'defect') return 'Неизменяемый факт';
  if (!isOperatorCurrentRoll(order, roll)) return 'По очереди';
  return operatorStepShortLabel(order.status);
}

function operatorRollListItems(runtime: OperatorRuntimeState, filter: string): WorkListItem[] {
  return runtime.orders
    .flatMap((order) => order.rolls.map((roll) => ({ order, roll, group: operatorGroupForRoll(order, roll) })))
    .filter(({ order, roll }) => {
      const isArchived = roll.warehouseState === 'sent' || roll.warehouseState === 'received' || roll.warehouseState === 'delivered';
      const tags = operatorRollFilterTags(order, roll);
      if (filter === 'Все') return !isArchived;
      if (filter === 'Архив' || filter === 'Завершены') return isArchived;
      if (filter === 'Требуют действия') return tags.includes('Требуют действия') && !isArchived;
      if (filter === 'Заблокированы') return runtime.shift.status !== 'active' || roll.toleranceState === 'blocked' || roll.labelState === 'delivery_unknown';
      if (filter === 'С проблемами') return roll.status === 'defect' || order.problemCount > 0 || roll.toleranceState === 'blocked' || roll.toleranceState === 'warning' || operatorBalanceProblems(runtime, order.id).length > 0;
      return tags.includes(filter);
    })
    .sort((left, right) => (left.roll.queueRank ?? 9999) - (right.roll.queueRank ?? 9999)
      || left.order.orderId.localeCompare(right.order.orderId, 'ru')
      || left.roll.sequenceNumber - right.roll.sequenceNumber)
    .map(({ order, roll, group }, index) => {
      const isArchived = roll.warehouseState === 'sent' || roll.warehouseState === 'received' || roll.warehouseState === 'delivered';
      const isCurrent = isOperatorCurrentRoll(order, roll) && order.status !== 'warehouse';
      const completedAt = isArchived ? roll.sentToWarehouseAt : undefined;
      const balanceProblems = operatorBalanceProblems(runtime, order.id);
      const orderNumber = roll.orderNumber ?? order.orderId;
      const progressValue =
        order.rollProgress.total > 0
          ? order.rollProgress.completed / order.rollProgress.total
          : 0;
      const severity = balanceProblems.length > 0 ? 'critical' : runtime.shift.status === 'closed' && !isArchived ? 'warning' : operatorRollStatusSeverity(roll);
      const blocker = runtime.shift.status !== 'active' && !isArchived
        ? operatorShiftBlockerText(runtime.shift)
        : order.problemCount > 0 || balanceProblems.length > 0
          ? 'Есть проблема'
          : undefined;

      return {
        id: roll.id,
        kind: 'operatorTask' as const,
        title: roll.id,
        summary: `Заказ ${orderNumber} · ${roll.machineLabel ?? order.workplace} · ${roll.estimatedMinutes ?? '—'} мин`,
        statusLabel: isArchived ? 'Передан' : isCurrent ? operatorStatusLabel(order.status) : operatorRollQrWarehouseLabel(roll),
        severity,
        nextOwner: isArchived ? 'Склад' : 'Оператор',
        lastEventAt: order.lastEventAt,
        problemCount: order.problemCount + balanceProblems.length,
        roleFields: [
          { label: 'Порядок', value: `#${roll.queueRank ?? index + 1}`, scope: 'operator' },
          { label: 'Заказ', value: orderNumber, scope: 'operator' },
          { label: 'Рулон', value: roll.id, scope: 'operator' },
          { label: 'Станок', value: roll.machineLabel ?? order.workplace, scope: 'operator' },
        ],
        dateKey: operatorRollDateKey(completedAt),
        filterTags: operatorRollFilterTags(order, roll),
        queueBucket: isArchived ? 'completed' as const : runtime.shift.status !== 'active' ? 'blocked' as const : order.status === 'deferred' ? 'scheduled' as const : 'active' as const,
        archiveReason: isArchived ? 'передано на склад' : undefined,
        completedAt,
        lastActionAt: completedAt ?? order.lastEventAt,
        operatorCard: {
          orderCode: orderNumber,
          customerAlias: '',
          templateName: roll.id,
          filmType: group?.filmType ?? order.filmType,
          micron: group?.micron ?? order.realMicron,
          size: group?.sizeMeters ?? order.cardSizeMeters,
          kgPerRoll: `${roll.plannedNetKg} кг`,
          recipe: `${group?.title ?? 'Группа'} · ${operatorToleranceLabel(roll)}`,
          currentRollLabel: roll.id,
          currentRollMicron: group?.micron ?? order.realMicron,
          currentRollSize: group?.sizeMeters ?? order.sizeMeters,
          currentRollPlanKg: `${roll.plannedNetKg} кг`,
          currentRollTolerance: `±${group?.tolerancePercent ?? 2}%`,
          currentRollRecipe: roll.recipeVersion,
          groupCount: order.rollGroups.length,
          actionLabel: operatorRollActionLabel(order, roll),
          progressLabel: `${order.rollProgress.completed}/${order.rollProgress.total} рулона`,
          progressValue,
          stepLabel: operatorRollActionLabel(order, roll),
          isMuted: isArchived,
          blocker,
        },
      };
    });
}

export function operatorListItems(runtime: OperatorRuntimeState, filter: string, section: string): WorkListItem[] {
  const normalizedSection = normalizeOperatorSection(section);
  if (section === 'Переданы на склад') return operatorRollListItems(runtime, 'Завершены');
  if (normalizedSection === OPERATOR_ROLLS_SECTION) return operatorRollListItems(runtime, filter);

  return runtime.orders
    .filter((order) => operatorFilterTags(order).includes(normalizedSection))
    .filter((order) => {
      const isArchived = order.status === 'warehouse';
      if (filter === 'Все') return !isArchived;
      if (filter === 'Архив' || filter === 'Завершены') return isArchived;
      if (filter === 'Требуют действия') return order.status !== 'warehouse' && operatorActionsForOrder(order, runtime.shift, runtime).some((action) => action.enabled && action.level === 'recommended');
      if (filter === 'Заблокированы') return order.status !== 'warehouse' && (runtime.shift.status !== 'active' || operatorCurrentRoll(order)?.labelState === 'delivery_unknown');
      if (filter === 'С проблемами') return order.problemCount > 0 || operatorBalanceProblems(runtime, order.id).length > 0;
      return operatorFilterTags(order).includes(filter);
    })
    .map((order, index) => {
      const currentRoll = operatorCurrentRoll(order);
      const currentGroup = operatorGroupForRoll(order, currentRoll);
      const isArchived = order.status === 'warehouse';
      return {
        id: order.id,
        kind: 'operatorTask',
        title: order.title,
        summary: operatorOrderSummary(order),
        statusLabel: operatorStatusLabel(order.status),
        severity: operatorBalanceProblems(runtime, order.id).length > 0 ? 'critical' : runtime.shift.status === 'closed' && order.status !== 'warehouse' ? 'warning' : operatorOrderSeverity(order),
        nextOwner: operatorBalanceProblems(runtime, order.id).length > 0 ? 'Зав. производства' : order.status === 'warehouse' ? 'Склад' : 'Оператор',
        lastEventAt: order.lastEventAt,
        problemCount: order.problemCount + operatorBalanceProblems(runtime, order.id).length,
        roleFields: [{ label: 'Порядок', value: `#${index + 1}`, scope: 'operator' }, ...operatorFacts(order)],
        dateKey: operatorRollDateKey(order.lastEventAt),
        filterTags: operatorFilterTags(order),
        queueBucket: isArchived ? 'completed' : runtime.shift.status !== 'active' ? 'blocked' : order.status === 'deferred' ? 'scheduled' : 'active',
        archiveReason: isArchived ? 'передано на склад' : undefined,
        completedAt: isArchived ? order.lastEventAt : undefined,
        lastActionAt: order.lastEventAt,
        operatorCard: {
          orderCode: order.orderId,
          customerAlias: '',
          templateName: order.templateName,
          filmType: currentGroup?.filmType ?? order.filmType,
          micron: currentGroup?.micron ?? order.realMicron,
          size: currentGroup?.sizeMeters ?? order.cardSizeMeters,
          kgPerRoll: `${currentRoll?.plannedNetKg ?? order.rollPlanKg} кг`,
          recipe: `Рулон ${order.rollProgress.current} · ${operatorToleranceLabel(currentRoll)}`,
          currentRollLabel: `Рулон ${order.rollProgress.current} из ${order.rollProgress.total}`,
          currentRollMicron: currentGroup?.micron ?? order.realMicron,
          currentRollSize: currentGroup?.sizeMeters ?? order.sizeMeters,
          currentRollPlanKg: `${currentRoll?.plannedNetKg ?? order.rollPlanKg} кг`,
          currentRollTolerance: `±${currentGroup?.tolerancePercent ?? 2}%`,
          currentRollRecipe: currentRoll?.recipeVersion ?? currentGroup?.recipeVersion ?? '-',
          groupCount: order.rollGroups.length,
          actionLabel: operatorOrderOpenLabel(order.status),
          progressLabel: `${order.rollProgress.completed}/${order.rollProgress.total} рулона`,
          progressValue:
            order.rollProgress.total > 0
              ? order.rollProgress.completed / order.rollProgress.total
              : 0,
          stepLabel: operatorStepShortLabel(order.status),
          isMuted: order.status === 'warehouse',
          blocker: operatorBlockerForCard(runtime, order),
        },
      };
    });
}

export function operatorActionsForOrder(order: OperatorOrderRuntime, shift: OperatorShift, runtime?: OperatorRuntimeState): ActionDescriptor[] {
  const currentRoll = operatorCurrentRoll(order);
  const base: ActionDescriptor[] = (() => {
    if (currentRoll?.labelState === 'delivery_unknown') return [{
      id: 'operator-print-unknown', label: 'Печать требует сверки', level: 'disabled', enabled: false,
      disabledReason: 'Результат печати неизвестен', recoveryOwner: 'Администратор',
      recoveryAction: 'Сверить этикетку',
    }];
    if (order.status === 'assigned') return [
      { id: 'operator-accept-order', label: 'Примите заказ', level: 'recommended', enabled: true },
    ];
    if (order.status === 'spool_weight') return [
      currentRoll?.spoolWeightPolicy === 'standard_700g'
        ? { id: 'operator-spool-weight', label: 'Зафиксировать 0,7 кг', level: 'recommended', enabled: true, helpText: 'Для тонкой шпули применяется производственный норматив 0,7 кг.' }
        : { id: 'operator-spool-weight', label: 'Зафиксировать вес шпули', level: 'recommended', enabled: true, helpText: 'Фиксация по стабильному сигналу весов; ручной ввод веса не используется.' },
      { id: 'operator-defer-order', label: 'Отложить заказ...', level: 'secondary', enabled: true },
    ];
    if (order.status === 'roll_weight') return [
      { id: 'operator-roll-weight', label: 'Зафиксировать вес рулона', level: 'recommended', enabled: true, helpText: 'Фиксация по стабильному сигналу весов; ручной ввод веса не используется.' },
      {
        id: 'operator-step-back-spool-weight',
        label: 'Назад к весу шпули',
        level: 'secondary',
        enabled: true,
        confirmation:
          'Вернуться к весу шпули? Зафиксированный вес шпули останется в истории. Шпулю нужно взвесить заново.',
        helpText: 'Предыдущее измерение сохранится в истории.',
      },
      { id: 'operator-defect', label: 'Взвесить брак', level: 'secondary', enabled: true, confirmation: 'Откроется форма брака; масса будет получена со стабильных весов поста.' },
      { id: 'operator-defer-order', label: 'Отложить заказ...', level: 'secondary', enabled: true },
    ];
    if (order.status === 'roll_scale_activation') return [
      { id: 'operator-roll-weight', label: 'Зафиксировать вес рулона', level: 'recommended', enabled: true, helpText: 'Весы дают стабильный сигнал; оператор фиксирует его в строке рулона.' },
      { id: 'operator-defect', label: 'Взвесить брак', level: 'secondary', enabled: true, confirmation: 'Откроется форма брака; масса будет получена со стабильных весов поста.' },
      { id: 'operator-defer-order', label: 'Отложить заказ...', level: 'secondary', enabled: true },
    ];
    if (order.status === 'qr_print') return [
      { id: 'operator-print-qr', label: 'Напечатайте QR', level: 'recommended', enabled: true },
      ...(canOperatorReweigh(order)
        ? [
            {
              id: 'operator-step-back-roll-weight',
              label: 'Назад к весу рулона',
              level: 'secondary' as const,
              enabled: true,
              confirmation:
                'Вернуться к весу рулона? Зафиксированный вес рулона останется в истории. Рулон нужно взвесить заново.',
              helpText: 'Предыдущее измерение сохранится в истории.',
            },
            {
              id: 'operator-reweigh-roll',
              label: 'Перевзвесить рулон',
              level: 'secondary' as const,
              enabled: true,
              helpText: 'Повторно получить стабильный вес до отправки задания печати.',
            },
          ]
        : []),
      { id: 'operator-reprint-label-disabled', label: 'Печать повторно...', level: 'disabled', enabled: false, disabledReason: 'QR еще не напечатан', recoveryOwner: 'Оператор', recoveryAction: 'Напечатать QR' },
      { id: 'operator-defer-order', label: 'Отложить заказ...', level: 'secondary', enabled: true },
    ];
    if (order.status === 'qr_check') return [
      { id: 'operator-verify-qr', label: 'Сканируйте QR', level: 'recommended', enabled: true },
      { id: 'operator-reprint-label', label: 'Печать повторно...', level: 'secondary', enabled: true },
      { id: 'operator-defer-order', label: 'Отложить заказ...', level: 'secondary', enabled: true },
    ];
    if (order.status === 'handover') {
      return [
        canOperatorRecoverInvalidHandoverWeight(order)
          ? {
              id: 'operator-reweigh-roll',
              label: 'Перевзвесить',
              level: 'recommended',
              enabled: true,
              helpText:
                'Получите новый стабильный вес на весах поста. Подтверждённая QR-метка сохранится.',
            }
          : {
              id: 'operator-verify-qr',
              label: 'Повторите сканирование QR',
              level: 'recommended',
              enabled: true,
              helpText: 'Резервное восстановление, если автоматическая передача прервалась.',
            },
        {
          id: 'operator-history',
          label: 'Открыть историю заказа',
          level: 'secondary',
          enabled: true,
        },
      ];
    }
    if (order.status === 'deferred') return [
      { id: 'operator-resume-order', label: 'Возобновите заказ', level: 'recommended', enabled: true },
      { id: 'operator-history', label: 'Открыть историю заказа', level: 'secondary', enabled: true },
    ];
    const nextOrderId = runtime ? operatorNextWorkOrderId(runtime, order.id) : null;
    return nextOrderId
      ? [{ id: `operator-next-order:${nextOrderId}`, label: 'Перейти к следующему заказу', level: 'recommended', enabled: true, actionIntent: 'navigate' as const }]
      : [{
          id: 'operator-next-order',
          label: 'Следующих заказов нет',
          level: 'disabled',
          enabled: false,
          disabledReason: 'В личной очереди нет следующего незавершенного заказа',
          recoveryOwner: 'Зав. производства',
          recoveryAction: 'Назначить следующий заказ оператору',
        }];
  })();

  const problemAction: ActionDescriptor = {
    id: 'operator-problem',
    label: 'Проблема',
    level: 'secondary',
    enabled: true,
    confirmation: 'Откроется форма с причиной и связанным рулоном.',
  };
  const shouldExposeProblemAction = order.status !== 'warehouse';
  const actions = !shouldExposeProblemAction || base.some((action) => action.id === 'operator-problem')
    ? base
    : [...base, problemAction];

  if (shift.status === 'active') return actions;
  return actions.map((action) => {
    if (action.enabled && action.id.startsWith('operator-next-order')) return action;
    if (action.id === 'operator-problem') return action;
    if (shift.status === 'closed' && action.id === 'operator-history') return action;
    return {
      ...action,
      level: 'disabled',
      enabled: false,
      disabledReason: shift.status === 'close_pending' ? 'Смена сдается' : shift.status === 'closed' ? 'Смена закрыта' : 'Нет стартового веса Big-bag',
      recoveryOwner: 'Оператор',
      recoveryAction: shift.status === 'close_pending' ? 'Зафиксировать финальный вес Big-bag и закрыть смену' : shift.status === 'closed' ? 'Открыть новую смену' : 'Зафиксировать стартовый вес Big-bag',
    };
  });
}

export function operatorWorkbenchForOrder(order: OperatorOrderRuntime, shift: OperatorShift): OperatorWorkbench {
  const shiftBlocksOrder = shift.status !== 'active';
  const currentRoll = operatorCurrentRoll(order);
  const printUnknown = currentRoll?.labelState === 'delivery_unknown';
  const currentGroup = operatorGroupForRoll(order, currentRoll);
  const plannedCurrentKg = currentRoll?.plannedNetKg ?? order.rollPlanKg;
  const spoolScaleReady = Boolean(currentRoll?.spoolScaleActivated || currentRoll?.spoolKg);
  const rollScaleReady = Boolean(currentRoll?.rollScaleActivated || currentRoll?.actualNetKg || currentRoll?.netKg);
  const currentScaleReady = order.status === 'spool_weight' ? spoolScaleReady : rollScaleReady;
  const blockingReason = shiftBlocksOrder && order.status !== 'warehouse' ? operatorShiftBlockerText(shift) : printUnknown ? 'Результат печати неизвестен' : undefined;
  const recovery = shiftBlocksOrder ? operatorShiftRecoveryText(shift) : printUnknown ? 'Нужна сверка этикетки администратором.' : undefined;
  const stageSignal = operatorStageSignalForOrder(order, shift);
  const deviceStatus = printUnknown ? [{ label: 'Принтер', value: 'Результат неизвестен', severity: 'critical' as const }] : order.status === 'spool_weight' || order.status === 'roll_scale_activation' || order.status === 'roll_weight'
    ? [{
        label: 'Весы',
        value: shiftBlocksOrder ? 'Заблокированы' : order.status === 'spool_weight' ? spoolScaleReady ? 'Сигнал записан' : 'Стабильный сигнал' : rollScaleReady ? 'Сигнал записан' : 'Стабильный сигнал',
        severity: shiftBlocksOrder ? 'critical' as const : order.status === 'spool_weight' ? spoolScaleReady ? 'info' as const : 'warning' as const : rollScaleReady ? 'info' as const : 'warning' as const,
      }]
    : order.status === 'qr_print'
      ? [
          { label: 'Принтер', value: shiftBlocksOrder ? 'Заблокирован' : 'Готов к печати', severity: shiftBlocksOrder ? 'critical' as const : 'warning' as const },
          { label: 'Сканер', value: 'Ждет печать QR', severity: 'warning' as const },
        ]
    : order.status === 'qr_check'
      ? [
          { label: 'Сканер', value: shiftBlocksOrder ? 'Заблокирован' : 'Готов', severity: shiftBlocksOrder ? 'critical' as const : 'info' as const },
          { label: 'Принтер', value: 'Задание отправлено', severity: 'info' as const },
        ]
      : order.status === 'handover' || order.status === 'warehouse'
        ? [{ label: 'Сканер склада', value: order.status === 'warehouse' ? 'Принято' : 'Ждет QR', severity: 'info' as const }]
        : [{ label: 'Станок', value: order.workplace, severity: 'info' as const }];

  return {
    type: 'operator',
    orderCode: order.orderId,
    customerAlias: undefined,
    instruction: shiftBlocksOrder
      ? 'Сначала закройте действие по смене.'
      : printUnknown ? 'Нужна сверка этикетки администратором.' : order.status === 'warehouse'
        ? 'Операторская часть закрыта.'
        : operatorInstructionForStatus(order.status),
    step: printUnknown ? 'Сверка печати' : operatorStepForStatus(order.status),
    machine: currentRoll?.machineLabel ?? order.workplace,
    rollProgress: order.rollProgress,
    currentRoll,
    currentRollGroup: currentGroup,
    rollLines: order.rolls,
    rollGroups: order.rollGroups,
    stageSignal,
    blockingReason,
    recovery,
    nextEffect: order.status === 'warehouse'
      ? 'Склад видит приемку по переданным рулонам.'
      : order.status === 'handover'
        ? 'После передачи откроется следующий рулон этого заказа или складская приемка.'
        : 'После успешного действия обновится выбранный рулон.',
    steps: [
      { label: 'Принять', value: order.status === 'assigned' ? 'Текущий шаг' : 'Готово', severity: order.status === 'assigned' ? 'warning' : 'info' },
      { label: 'Шпуля', value: currentRoll?.spoolKg ? `${currentRoll.spoolKg} кг` : order.status === 'spool_weight' ? 'Текущий шаг' : 'Ждет', severity: currentRoll?.spoolKg ? 'info' : 'warning' },
      { label: 'Сигнал веса', value: currentScaleReady ? 'Записан' : order.status === 'spool_weight' || order.status === 'roll_weight' || order.status === 'roll_scale_activation' ? 'Ждет фиксации' : 'Ждет', severity: currentScaleReady ? 'info' : 'warning' },
      { label: 'Вес', value: currentRoll?.actualNetKg ? `${currentRoll.actualNetKg} кг` : currentRoll?.netKg ? `${currentRoll.netKg} кг` : order.status === 'roll_weight' ? 'Текущий шаг' : 'Ждет', severity: currentRoll?.actualNetKg || currentRoll?.netKg ? operatorRollStatusSeverity(currentRoll) : 'warning' },
      { label: 'Печать QR', value: order.status === 'qr_print' ? 'Текущий шаг' : currentRoll?.labelState === 'verified' || order.status === 'handover' || order.status === 'warehouse' ? 'Подтверждено сканом' : currentRoll?.labelState === 'submitted' || order.status === 'qr_check' ? 'Задание отправлено' : 'Ждет', severity: order.status === 'qr_print' || order.status === 'qr_check' ? 'warning' : 'info' },
      { label: 'Скан QR', value: order.status === 'qr_check' ? 'Текущий шаг' : order.status === 'handover' || order.status === 'warehouse' ? 'Отсканирован' : 'Ждет', severity: order.status === 'qr_check' ? 'warning' : 'info' },
      { label: 'Склад', value: order.status === 'warehouse' ? 'Передано' : order.status === 'handover' ? 'Текущий шаг' : 'Ждет передачи', severity: order.status === 'warehouse' ? 'info' : 'warning' },
    ],
    deviceStatus,
    metrics: [
      {
        label: 'План/допуск',
        value: String(plannedCurrentKg),
        unit: `кг · ${operatorToleranceLabel(currentRoll)}`,
        severity: operatorRollStatusSeverity(currentRoll),
      },
    ],
    labelLifecycle: printUnknown ? {
      current: 'delivery_unknown', lastPrintJob: 'Результат неизвестен',
      lastScan: 'Не подтверждён', steps: [],
    } : ['qr_print', 'qr_check', 'handover', 'warehouse'].includes(order.status)
      ? {
          current: order.status === 'qr_print' ? 'not_printed' : order.status === 'qr_check' ? 'submitted' : 'verified',
          lastPrintJob: `PRINT-${currentRoll?.id ?? order.orderId}-01`,
          lastScan: order.status === 'qr_print' ? 'Задание еще не отправлено' : order.status === 'qr_check' ? 'Ожидает фактический скан' : 'QR подтвержден сканом',
          reprintReason: 'Повтор печати доступен только с причиной.',
          voidedLabel: 'Нет аннулированных этикеток',
          damagedRecovery: 'Если QR поврежден, нужен ручной поиск рулона и причина повторной печати.',
          steps: [
            { state: 'print_requested', label: 'Печать', value: order.status === 'qr_print' ? 'Текущий шаг' : 'Запрошена', severity: order.status === 'qr_print' ? 'warning' : 'info' },
            { state: 'submitted', label: 'Задание отправлено', value: order.status === 'qr_print' ? 'Ждет отправки' : order.status === 'qr_check' ? 'Ожидает фактический скан' : 'Подтверждено сканом', severity: order.status === 'qr_print' || order.status === 'qr_check' ? 'warning' : 'info' },
            { state: 'verified', label: 'Отсканирована', value: order.status === 'qr_check' ? 'Ждет фактический скан' : 'Готово', severity: order.status === 'qr_check' ? 'warning' : 'info' },
          ],
        }
      : undefined,
  };
}

export function operatorObjectFromRuntime(order: OperatorOrderRuntime, runtime: OperatorRuntimeState): WorkObject {
  const balanceProblems = operatorBalanceProblems(runtime, order.id);
  const currentRoll = operatorCurrentRoll(order);
  const currentGroup = operatorGroupForRoll(order, currentRoll);
  return {
    id: order.id,
    kind: 'operatorTask',
    title: order.title,
    statusLabel: operatorStatusLabel(order.status),
    nextOwner: balanceProblems.length > 0 ? 'Зав. производства' : order.status === 'warehouse' ? 'Склад' : 'Оператор',
    severity: balanceProblems.length > 0 ? 'critical' : operatorOrderSeverity(order),
    filterTags: operatorFilterTags(order),
    facts: operatorFacts(order),
    sections: [
      {
        id: 'operator-order-parameters',
        title: 'Детали заказа',
        facts: [
          { label: 'Реальная толщина', value: order.realMicron },
          {
            label: 'Текущий рулон',
            value: `${order.rollProgress.current} из ${order.rollProgress.total}`,
          },
          { label: 'Размер', value: currentGroup?.sizeMeters ?? order.sizeMeters },
          { label: 'Количество', value: `${order.rollProgress.total} рулонов` },
          { label: 'План рулона', value: `${currentRoll?.plannedNetKg ?? order.rollPlanKg} кг` },
          { label: 'Допуск', value: `±${currentGroup?.tolerancePercent ?? 2}%` },
        ],
      },
      {
        id: 'operator-rolls',
        title: 'Рулоны и этикетки',
        facts: order.rolls.map((roll) => ({
          label: `Рулон ${roll.sequenceNumber}`,
          value: `${roll.id} · ${roll.status}${roll.spoolKg ? ` · шпуля ${roll.spoolKg} кг` : ''}${roll.actualNetKg ? ` · нетто ${roll.actualNetKg} кг` : roll.netKg ? ` · нетто ${roll.netKg} кг` : ''} · ${operatorToleranceLabel(roll)}`,
        })),
      },
    ],
    actions: operatorActionsForOrder(order, runtime.shift, runtime),
    problems: balanceProblems,
    audit: [...(runtime.audit[order.id] ?? []), ...(runtime.audit[runtime.shift.id] ?? [])],
    workbench: operatorWorkbenchForOrder(order, runtime.shift),
  };
}

export function getOperatorSelectedObject(runtime: OperatorRuntimeState, selectedId: string | null) {
  const selectedOrder = selectedId ? runtime.orders.find((order) => order.id === selectedId) : null;
  if (selectedOrder) return operatorObjectFromRuntime(selectedOrder, runtime);
  const orderByRoll = selectedId ? runtime.orders.find((order) => order.rolls.some((roll) => roll.id === selectedId)) : null;
  const selectedRoll = orderByRoll?.rolls.find((roll) => roll.id === selectedId);
  return orderByRoll && selectedRoll
      ? operatorObjectFromRuntime(
        {
          ...orderByRoll,
          status: selectedRollStatus(selectedRoll, orderByRoll.status),
          currentRoll: selectedRoll.sequenceNumber,
          currentDispatchItemId: selectedRoll.dispatchItemId,
        },
        runtime,
      )
    : null;
}
