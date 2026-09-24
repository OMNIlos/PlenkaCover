import type { OperatorRollReweighResult, OperatorRollStepBackResult } from '../types';
import type { OperatorOrderRuntime, OperatorQueueDirection, OperatorRuntimeState } from './types';
import { operatorShiftDefectBags, parseOperatorDefectBagPrintAction, parseOperatorDefectBagWeighAction, withOperatorDefectBag } from '../defectBagLabels';
import {
  actionWeightValue,
  isOperatorCurrentRoll,
  operatorCurrentRoll,
  operatorNextRollSequence,
  operatorPersonalQueueBlockedReason,
  operatorRollPlanKg,
} from './selectors';

export function applyOperatorReweighResult(
  runtime: OperatorRuntimeState,
  result: OperatorRollReweighResult,
): OperatorRuntimeState {
  return {
    ...runtime,
    orders: runtime.orders.map((order) => {
      if (!order.rolls.some((roll) => roll.id === result.rollCode)) return order;
      return {
        ...order,
        rollNetKg: result.currentWeight.netKg,
        rolls: order.rolls.map((roll) =>
          roll.id === result.rollCode
            ? {
                ...roll,
                grossKg: result.currentWeight.grossKg,
                netKg: result.currentWeight.netKg,
                actualNetKg: result.currentWeight.netKg,
                updatedAt: nextRefreshAt(roll.updatedAt),
                toleranceState:
                  result.currentWeight.toleranceOk == null
                    ? 'pending'
                    : result.currentWeight.toleranceOk
                      ? 'within'
                      : 'blocked',
              }
            : roll,
        ),
      };
    }),
  };
}

function nextRefreshAt(previous: string | undefined) {
  const previousMs = previous ? Date.parse(previous) : Number.NaN;
  const now = Date.now();
  return new Date(Number.isFinite(previousMs) ? Math.max(now, previousMs + 1) : now).toISOString();
}

export function applyOperatorStepBackResult(
  runtime: OperatorRuntimeState,
  result: OperatorRollStepBackResult,
): OperatorRuntimeState {
  return {
    ...runtime,
    orders: runtime.orders.map((order) => {
      if (!order.rolls.some((roll) => roll.id === result.rollCode)) return order;
      return {
        ...order,
        status: result.step,
        state: 'in_progress',
        spoolKg: result.step === 'spool_weight' ? undefined : order.spoolKg,
        rollNetKg: undefined,
        rolls: order.rolls.map((roll) =>
          roll.id === result.rollCode
            ? {
                ...roll,
                status: result.step,
                spoolKg: result.step === 'spool_weight' ? undefined : roll.spoolKg,
                grossKg: undefined,
                netKg: undefined,
                actualNetKg: undefined,
                toleranceState: 'pending',
                spoolScaleActivated:
                  result.step === 'spool_weight' &&
                  roll.spoolWeightPolicy !== 'standard_700g',
                rollScaleActivated: result.step === 'roll_weight',
              }
            : roll,
        ),
      };
    }),
  };
}

export function reconcileOperatorRuntimeRefresh(
  current: OperatorRuntimeState,
  incoming: OperatorRuntimeState,
): OperatorRuntimeState {
  const keepLocalCloseStep =
    current.shift.status === 'close_pending' &&
    (incoming.shift.status === 'active' || incoming.shift.status === 'bag_missing') &&
    current.shift.id === incoming.shift.id;

  if (!keepLocalCloseStep) return incoming;

  return {
    ...incoming,
    shift: {
      ...incoming.shift,
      status: 'close_pending',
    },
  };
}

export function reduceOperatorRuntime(runtime: OperatorRuntimeState, selectedOrderOrRollId: string, actionId: string): OperatorRuntimeState {
  const directOrder = runtime.orders.find((order) => order.id === selectedOrderOrRollId);
  const rollOrder = directOrder ? undefined : runtime.orders.find((order) => order.rolls.some((roll) => roll.id === selectedOrderOrRollId));
  const selectedRoll = rollOrder?.rolls.find((roll) => roll.id === selectedOrderOrRollId);
  const selectedOrderId = directOrder?.id ?? rollOrder?.id ?? selectedOrderOrRollId;
  if (selectedRoll && rollOrder) {
    runtime = {
      ...runtime,
      orders: runtime.orders.map((order) =>
        order.id === rollOrder.id
          ? {
              ...order,
              currentRoll: selectedRoll.sequenceNumber,
              currentDispatchItemId: selectedRoll.dispatchItemId,
            }
          : order,
      ),
    };
  }

  const stamp = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
  const now = new Date();
  const dateStamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const handoverStamp = `${dateStamp} ${stamp}`;
  const auditFor = (targetId: string, actionLabel: string, detail: string, actorLabel = 'Оператор') => ({
    id: `a-${targetId}-${Date.now()}`,
    objectId: targetId,
    time: stamp,
    actorLabel,
    actionLabel,
    detail,
  });
  const withAudit = (next: OperatorRuntimeState, targetId: string, actionLabel: string, detail: string) => ({
    ...next,
    audit: {
      ...next.audit,
      [targetId]: [auditFor(targetId, actionLabel, detail), ...(next.audit[targetId] ?? [])],
    },
  });
  const updateOrder = (updater: (order: OperatorOrderRuntime) => OperatorOrderRuntime) => ({
    ...runtime,
    orders: runtime.orders.map((order) => order.id === selectedOrderId ? updater(order) : order),
  });
  const queueMove = actionId.match(/^operator-queue-(up|down):(.+)$/);

  if (queueMove) {
    const direction = queueMove[1] as OperatorQueueDirection;
    const targetId = queueMove[2];
    const currentIndex = runtime.orders.findIndex((order) => order.id === targetId);
    const targetOrder = runtime.orders[currentIndex];
    const blockedReason = operatorPersonalQueueBlockedReason(runtime, targetOrder, currentIndex, direction);

    if (blockedReason) {
      return withAudit(runtime, targetId, 'порядок моих заказов не изменен', blockedReason);
    }

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    const orders = [...runtime.orders];
    [orders[currentIndex], orders[targetIndex]] = [orders[targetIndex], orders[currentIndex]];

    return withAudit(
      { ...runtime, orders },
      targetId,
      'порядок моих заказов изменен',
      `${targetOrder.title} перемещен ${direction === 'up' ? 'выше' : 'ниже'} в личной очереди оператора. Общая очередь не менялась.`
    );
  }

  const startBigBagKg = actionWeightValue(actionId, 'operator-start-bigbag:');
  if (startBigBagKg !== null) {
    return withAudit({
      ...runtime,
      shift: {
        ...runtime.shift,
        status: 'active',
        startKg: startBigBagKg,
        enteredBy: runtime.shift.operatorName,
        enteredAt: stamp,
      },
    }, runtime.shift.id, 'вес Big-bag зафиксирован', `Стартовый вес ${startBigBagKg} кг введен вручную после физического взвешивания.`);
  }
  if (actionId === 'operator-close-shift-request') {
    return withAudit({
      ...runtime,
      shift: { ...runtime.shift, status: 'close_pending' },
    }, runtime.shift.id, 'сдача смены начата', 'Оператор перешел к финальному взвешиванию Big-bag.');
  }
  if (actionId === 'operator-close-shift-cancel') {
    if (runtime.shift.status !== 'close_pending') return runtime;
    const hasTrackedBags = runtime.shift.bags !== undefined;
    const trackedBags = runtime.shift.bags ?? [];
    const restoredStatus: OperatorRuntimeState['shift']['status'] =
      trackedBags.length === 0 || trackedBags.some((bag) => bag.active) ? 'active' : 'bag_missing';
    const restoredShift = { ...runtime.shift, status: restoredStatus };
    const next = { ...runtime, shift: restoredShift };
    if (!hasTrackedBags) {
      delete restoredShift.endKg;
      delete restoredShift.actualUsageKg;
      delete restoredShift.deviationPercent;
      delete next.balanceProblemOrderId;
    }
    return next;
  }
  const defectBagWeight = parseOperatorDefectBagWeighAction(actionId);
  if (defectBagWeight) {
    const bagId = `defect-${runtime.shift.id}-${defectBagWeight.draftId ?? operatorShiftDefectBags(runtime.shift).length + 1}`;
    if (operatorShiftDefectBags(runtime.shift).some((bag) => bag.id === bagId)) return runtime;
    const recordedDefectKg = Number(
      runtime.orders
        .flatMap((order) => order.rolls)
        .filter((roll) => roll.status === 'defect')
        .reduce((sum, roll) => sum + (roll.actualNetKg ?? roll.netKg ?? 0), 0)
        .toFixed(1),
    );
    return withAudit({
      ...runtime,
      shift: withOperatorDefectBag(runtime.shift, {
          id: bagId,
          code: `BR-${runtime.shift.id}-${operatorShiftDefectBags(runtime.shift).length + 1}`,
          status: 'weighed',
          defectType: defectBagWeight.defectType,
          weightKg: defectBagWeight.weightKg,
          recordedDefectKg,
          differenceKg: Number((defectBagWeight.weightKg - recordedDefectKg).toFixed(3)),
          labelState: 'not_printed',
          weighedAt: now.toISOString(),
      }),
    }, runtime.shift.id, 'вес мешка брака введён', `${defectBagWeight.weightKg} кг введено оператором вручную.`);
  }
  const print = parseOperatorDefectBagPrintAction(actionId);
  if (print) {
    const bags = operatorShiftDefectBags(runtime.shift);
    const bag = print.defectBagId ? bags.find(({ id }) => id === print.defectBagId) : bags.length === 1 ? bags[0] : undefined;
    if (!bag || bag.weightKg === 0) return runtime;
    return withAudit({
      ...runtime,
      shift: withOperatorDefectBag(runtime.shift, {
          ...bag,
          status: 'ready_for_warehouse',
          labelState: 'submitted',
      }),
    }, runtime.shift.id, 'QR мешка брака напечатан', 'Мешок брака готов к передаче на склад.');
  }
  const endBigBagKg = actionWeightValue(actionId, 'operator-end-bigbag:');
  if (endBigBagKg !== null) {
    const endKg = endBigBagKg;
    const startKg = runtime.shift.startKg ?? endKg;
    const actualUsageKg = startKg - endKg;
    const expectedEndKg = runtime.shift.expectedEndKg;
    const deviationPercent = Number.isFinite(expectedEndKg) && expectedEndKg > 0
      ? Number(((endKg - expectedEndKg) / expectedEndKg * 100).toFixed(1))
      : 0;
    return withAudit({
      ...runtime,
      balanceProblemOrderId: Math.abs(deviationPercent) > 2 ? selectedOrderId : undefined,
      shift: {
        ...runtime.shift,
        status: 'close_pending',
        endKg,
        actualUsageKg,
        deviationPercent,
        enteredBy: runtime.shift.operatorName,
        enteredAt: stamp,
      },
    }, runtime.shift.id, 'вес Big-bag зафиксирован', `Финальный вес ${endKg} кг, отклонение ${deviationPercent}%.`);
  }
  if (actionId === 'operator-close-shift') {
    const bags = operatorShiftDefectBags(runtime.shift);
    if (bags.length === 0 || bags.some((bag) => bag.weightKg > 0 && bag.status === 'weighed')) return runtime;
    return withAudit({
      ...runtime,
      shift: { ...runtime.shift, status: 'closed' },
    }, runtime.shift.id, 'смена закрыта', 'Финальный вес Big-bag зафиксирован, расход смены рассчитан.');
  }
  if (actionId === 'operator-accept-order') {
    const next = updateOrder((order) => ({ ...order, status: 'spool_weight', state: 'in_progress', lastEventAt: stamp }));
    return withAudit(next, selectedOrderId, 'заказ принят', 'Открыт шаг фиксации веса шпули.');
  }
  if (actionId === 'operator-activate-spool-scale') {
    const next = updateOrder((order) => ({
      ...order,
      status: 'spool_weight',
      lastEventAt: stamp,
      rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: 'весы шпули активированы', spoolScaleActivated: true } : roll),
    }));
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(next, selectedOrderId, 'audit:weight_capture_requested', `Сигнал весов подготовлен для шпули ${roll?.id ?? 'текущего рулона'}, факт веса еще не записан.`);
  }
  if (actionId === 'operator-spool-weight') {
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    const next = updateOrder((order) => ({
      ...order,
      status: 'roll_weight',
      spoolKg: 1.8,
      lastEventAt: stamp,
      rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: 'шпуля зафиксирована', spoolKg: 1.8, spoolScaleActivated: true } : roll),
    }));
    return withAudit(next, selectedOrderId, 'вес шпули зафиксирован', `Шпуля 1.8 кг получена по стабильному сигналу весов для ${roll?.id ?? 'текущего рулона'}.`);
  }
  if (actionId === 'operator-activate-scale') {
    const next = updateOrder((order) => ({
      ...order,
      status: 'roll_weight',
      lastEventAt: stamp,
      rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: 'весы рулона активированы', rollScaleActivated: true } : roll),
    }));
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(next, selectedOrderId, 'audit:weight_capture_requested', `Сигнал весов подготовлен для ${roll?.id ?? 'текущего рулона'}, факт веса еще не записан.`);
  }
  if (actionId === 'operator-roll-weight') {
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    const next = updateOrder((order) => ({
      ...order,
      status: 'qr_print',
      rollNetKg: operatorRollPlanKg(order),
      lastEventAt: stamp,
      rolls: order.rolls.map((roll) => {
        if (!isOperatorCurrentRoll(order, roll)) return roll;
        const actualNetKg = roll.plannedNetKg;
        const grossKg = Number((actualNetKg + (roll.spoolKg ?? 1.8)).toFixed(1));
        return {
          ...roll,
          status: 'вес зафиксирован',
          rollScaleActivated: true,
          grossKg,
          actualNetKg,
          netKg: actualNetKg,
          deviationPercent: 0,
          toleranceState: 'within',
          labelState: 'not_printed',
        };
      }),
    }));
    return withAudit(next, selectedOrderId, 'audit:weight_captured', `Нетто получено по стабильному сигналу весов для ${roll?.id ?? 'текущего рулона'}.`);
  }
  if (actionId === 'operator-reweigh-roll') {
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(
      runtime,
      selectedOrderId,
      'перевзвешивание рулона запрошено',
      `Повторный сигнал весов запрошен для ${roll?.id ?? 'текущего рулона'} до печати QR.`,
    );
  }
  if (actionId === 'operator-print-qr') {
    const next = updateOrder((order) => ({
      ...order,
      status: 'qr_check',
      lastEventAt: stamp,
      rolls: order.rolls.map((roll) =>
        isOperatorCurrentRoll(order, roll)
          ? { ...roll, status: 'задание печати отправлено', labelState: 'submitted' }
          : roll,
      ),
    }));
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(
      next,
      selectedOrderId,
      'audit:label_print_requested',
      `Задание этикетки ${roll?.id ?? 'текущего рулона'} передано принтеру; физический выход подтвердит скан.`,
    );
  }
  if (actionId === 'operator-verify-qr') {
    const next = updateOrder((order) => {
      const completedRolls = Math.min(
        order.rollProgress.completed + 1,
        order.rollProgress.total,
      );
      return {
        ...order,
        status: 'handover',
        completedRolls,
        rollProgress: { ...order.rollProgress, completed: completedRolls },
        lastEventAt: stamp,
        rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: 'QR отсканирован', labelState: 'verified', warehouseState: 'ready_for_handover' } : roll),
      };
    });
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    const verified = withAudit(
      next,
      selectedOrderId,
      'QR отсканирован',
      `Этикетка ${roll?.id ?? 'текущего рулона'} отсканирована; начата автоматическая передача на склад.`,
    );
    return reduceOperatorRuntime(verified, selectedOrderId, 'operator-handover');
  }
  if (actionId === 'operator-handover') {
    const next = updateOrder((order) => {
      const handedOverSequence = order.currentRoll;
      const handedOverRoll = operatorCurrentRoll(order);
      const nextRollSequence = operatorNextRollSequence(order, handedOverSequence);
      const nextRoll = nextRollSequence
        ? order.rolls.find(
            (roll) =>
              roll.sequenceNumber === nextRollSequence &&
              roll.status !== 'defect' &&
              roll.warehouseState !== 'sent' &&
              roll.warehouseState !== 'received' &&
              roll.warehouseState !== 'delivered',
          )
        : undefined;
      const orderDone =
        !nextRollSequence || order.rollProgress.completed >= order.rollProgress.total;
      return {
        ...order,
        status: orderDone ? 'warehouse' : 'spool_weight',
        state: orderDone ? 'warehouse' : 'in_progress',
        currentRoll: nextRollSequence ?? handedOverSequence,
        currentDispatchItemId:
          nextRoll?.dispatchItemId ?? handedOverRoll?.dispatchItemId,
        rollProgress: {
          ...order.rollProgress,
          current: nextRollSequence ?? handedOverSequence,
        },
        deferredRolls: orderDone
          ? 0
          : Math.max(order.rollProgress.total - order.rollProgress.completed, 0),
        lastEventAt: stamp,
        rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: 'передан на склад', warehouseState: 'sent', sentToWarehouseAt: handoverStamp } : roll),
      };
    });
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(next, selectedOrderId, 'передано на склад', `${roll?.id ?? 'Рулон'} передан в складскую приемку по QR; следующий рулон сохранен в заказе.`);
  }
  if (actionId === 'operator-defer-order') {
    const next = updateOrder((order) => ({
      ...order,
      status: 'deferred',
      state: 'deferred',
      deferredRolls: Math.max(order.rollProgress.total - order.rollProgress.completed, 0),
      rolls: order.rolls.map((roll) => isOperatorCurrentRoll(order, roll) ? { ...roll, status: `отложен: рулон ${roll.sequenceNumber}` } : roll),
      lastEventAt: stamp,
    }));
    const selected = runtime.orders.find((order) => order.id === selectedOrderId);
    const roll = selected ? operatorCurrentRoll(selected) : undefined;
    return withAudit(next, selectedOrderId, 'заказ отложен', `Незавершенный заказ сохранен на ${roll?.id ?? 'текущем рулоне'}, оператор может взять другой заказ.`);
  }
  if (actionId === 'operator-resume-order') {
    const next = updateOrder((order) => ({
      ...order,
      status: 'spool_weight',
      state: 'in_progress',
      lastEventAt: stamp,
    }));
    return withAudit(next, selectedOrderId, 'заказ возобновлен', 'Оператор вернулся к незавершенному заказу.');
  }
  return runtime;
}

export function shouldPlayOperatorSuccessSound(actionId: string) {
  if (
    actionId.startsWith('operator-start-bigbag:') ||
    actionId.startsWith('operator-end-bigbag:') ||
    actionId.startsWith('operator-weigh-defect-bag:') ||
    parseOperatorDefectBagPrintAction(actionId)
  ) return true;
  return [
    'operator-close-shift-request',
    'operator-print-defect-bag',
    'operator-reprint-defect-bag',
    'operator-close-shift',
    'operator-accept-order',
    'operator-activate-spool-scale',
    'operator-spool-weight',
    'operator-activate-scale',
    'operator-roll-weight',
    'operator-reweigh-roll',
    'operator-print-qr',
    'operator-verify-qr',
    'operator-handover',
    'operator-defer-order',
    'operator-resume-order',
  ].includes(actionId);
}
