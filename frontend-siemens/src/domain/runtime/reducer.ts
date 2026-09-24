import type { OperatorRollLine } from '../types';
import type {
  DeviceMockContract,
  DomainEvent,
  PaymentTriggerRuntime,
  ProblemCaseRuntime,
  ProductionRuntimeState,
  RuntimeAction,
  WarehouseAcceptanceRuntime,
  WarehouseRollRuntime,
} from './types';

function stampNow() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function event(type: string, objectId: string, label: string, detail: string, role: DomainEvent['role'], family: DomainEvent['family'] = 'OperationalEvent'): DomainEvent {
  return {
    id: `ev-${type}-${objectId}-${Date.now()}`,
    family,
    type,
    objectId,
    role,
    label,
    detail,
    createdAt: stampNow(),
  };
}

function appendEvent(state: ProductionRuntimeState, item: DomainEvent): ProductionRuntimeState {
  return { ...state, events: [item, ...state.events] };
}

function normalizeDeviceContract(device: DeviceMockContract): DeviceMockContract {
  return {
    ...device,
    id: device.id.trim(),
    label: device.label?.trim() || undefined,
    workplaceId: device.workplaceId?.trim() || undefined,
    connectionKind: device.connectionKind?.trim() || undefined,
    notes: device.notes?.trim() || undefined,
    sourceSystem:
      device.kind === 'financeSource' ? device.sourceSystem?.trim() || 'Учётный источник' : undefined,
    lastSeenAt: device.lastSeenAt.trim() || 'не проверялось',
    rawPayload: device.rawPayload.trim() || 'empty',
    parsedPayload: device.parsedPayload.trim() || 'Нет результата',
    recovery: device.recovery.trim() || 'Проверить контур и назначить владельца восстановления',
  };
}

function productionIdFromDraft(objectId: string) {
  return objectId.startsWith('ЗН-') ? objectId : `ЗН-${objectId.replace(/^З-/, '')}`;
}

function financeIdFromOrder(orderId: string) {
  return `FIN-${orderId.replace(/^ЗН-/, '')}`;
}

function rollToWarehouseRoll(roll: OperatorRollLine): WarehouseRollRuntime {
  return {
    id: roll.id,
    sequenceNumber: roll.sequenceNumber,
    status: 'wait_scan',
    filmType: 'рукав',
    micron: 'по заказу',
    sizeMeters: 'по заказу',
    plannedNetKg: roll.plannedNetKg,
    tolerancePercent: 2,
    qrCode: roll.qrCode ?? `QR-${roll.id}`,
  };
}

function missingRollIds(rolls: WarehouseRollRuntime[]) {
  return rolls.filter((roll) => roll.status !== 'accepted' && roll.status !== 'delivered').map((roll) => roll.id);
}

function updateAcceptance(
  state: ProductionRuntimeState,
  acceptanceId: string,
  updater: (acceptance: WarehouseAcceptanceRuntime) => WarehouseAcceptanceRuntime
) {
  return {
    ...state,
    warehouseAcceptances: state.warehouseAcceptances.map((acceptance) =>
      acceptance.id === acceptanceId ? updater(acceptance) : acceptance
    ),
  };
}

function runtimeProblem(input: Omit<ProblemCaseRuntime, 'id' | 'createdAt' | 'status'> & { status?: ProblemCaseRuntime['status'] }): ProblemCaseRuntime {
  return {
    ...input,
    id: `pr-${input.objectId}-${Date.now()}`,
    createdAt: stampNow(),
    status: input.status ?? 'open',
  };
}

export function reduceProductionRuntime(state: ProductionRuntimeState, action: RuntimeAction): ProductionRuntimeState {
  if (action.type === 'commercial.intake.delegated') {
    const draft = {
      id: action.objectId,
      sourceObjectId: action.objectId,
      status: action.status ?? 'delegated',
      counterpartyLabel: action.counterpartyLabel ?? 'Контрагент из заявки',
      positionsLabel: action.positionsLabel ?? 'Позиции из заявки',
      createdBy: 'Коммерция',
      delegatedAt: stampNow(),
    };
    const productionOrder = {
      id: productionIdFromDraft(action.objectId),
      sourceDraftId: action.objectId,
      counterpartyLabel: draft.counterpartyLabel,
      status: 'waiting_order' as const,
      ownerRole: 'Зав. производства' as const,
      blockingReasons: ['Ждет оформления заказ-наряда'],
      createdAt: stampNow(),
    };
    return appendEvent(
      {
        ...state,
        commercialDrafts: [draft, ...state.commercialDrafts.filter((item) => item.id !== draft.id)],
        orders: [productionOrder, ...state.orders.filter((item) => item.id !== productionOrder.id)],
      },
      event('commercial.intake.delegated', action.objectId, 'Заявка передана производству', 'Производство получает строку до счета; финансы пока не меняются.', 'commercial')
    );
  }

  if (action.type === 'production.order.approved') {
    const orderId = productionIdFromDraft(action.objectId);
    const financeOrder = {
      id: financeIdFromOrder(orderId),
      orderId,
      status: 'waiting_invoice' as const,
      source: 'production_approval' as const,
      createdAt: stampNow(),
    };
    const updatedOrder = {
      id: orderId,
      sourceDraftId: action.objectId.replace(/^ЗН-/, 'З-'),
      counterpartyLabel: action.counterpartyLabel ?? 'Контрагент из заказ-наряда',
      status: 'operator_task_ready' as const,
      ownerRole: 'Зав. производства' as const,
      assignedOperatorId: 'operator-line-a',
      operatorTaskId: `OP-${orderId}`,
      blockingReasons: [],
      approvedAt: stampNow(),
      createdAt: stampNow(),
    };
    return appendEvent(
      {
        ...state,
        orders: [updatedOrder, ...state.orders.filter((item) => item.id !== orderId)],
        financeOrders: [financeOrder, ...state.financeOrders.filter((item) => item.id !== financeOrder.id)],
      },
      event('production.order.approved', orderId, 'Заказ-наряд согласован', 'Финансы получают строку Ждет счет; операторская задача готова после approval.', 'production')
    );
  }

  if (action.type === 'operator.label.reprinted') {
    const previousJob = state.labelPrintJobs.find((job) => job.rollId === action.roll.id && job.status !== 'voided');
    return appendEvent(
      {
        ...state,
        labelPrintJobs: [
          {
            jobId: `PRINT-${action.roll.id}-${Date.now()}`,
            rollId: action.roll.id,
            printerId: 'PRINTER-LABEL-01',
            status: 'reprinted',
            reason: action.reason,
            replacesJobId: previousJob?.jobId,
            createdAt: stampNow(),
          },
          ...state.labelPrintJobs,
        ],
      },
      event('label.reprint_requested', action.roll.id, 'Этикетка печатается повторно', `Причина: ${action.reason}. Старая этикетка остается в аудите.`, 'operator', 'AuditEvent')
    );
  }

  if (action.type === 'operator.defect.recorded') {
    const hasWeight = typeof action.weightKg === 'number' && action.weightKg > 0;
    const problem = !hasWeight || !action.comment.trim()
      ? runtimeProblem({
          objectId: action.order.id,
          scope: 'operator',
          title: 'Брак не закрыт',
          severity: 'warning',
          ownerRole: 'Оператор',
          reason: !hasWeight ? 'Нет веса брака с весов.' : 'Нет комментария к браку.',
          recovery: 'Зафиксировать вес брака и комментарий',
        })
      : undefined;
    return appendEvent(
      {
        ...state,
        defects: [
          {
            id: `DEF-${action.roll.id}-${Date.now()}`,
            rollId: action.roll.id,
            taskId: action.order.id,
            orderId: action.order.orderId,
            sourceRole: 'operator',
            weightKg: action.weightKg,
            comment: action.comment,
            blocking: Boolean(problem),
            createdAt: stampNow(),
          },
          ...state.defects,
        ],
        problems: problem ? [problem, ...state.problems] : state.problems,
      },
      event('operator.defect.recorded', action.roll.id, 'Брак записан', 'Брак получил отдельную запись, а не только комментарий.', 'operator', hasWeight ? 'MasterKpiEvent' : 'ProblemEvent')
    );
  }

  if (action.type === 'operator.handover') {
    if (action.roll.labelState !== 'verified') {
      const problem = runtimeProblem({
        objectId: action.order.id,
        scope: 'operator',
        title: 'Передача без QR заблокирована',
        severity: 'critical',
        ownerRole: 'Оператор',
        reason: 'Рулон нельзя передать на склад без verified QR.',
        recovery: 'Сканировать QR перед передачей',
      });
      return appendEvent({ ...state, problems: [problem, ...state.problems] }, event('problem.handover_without_qr.created', action.order.id, problem.title, problem.reason, 'operator', 'ProblemEvent'));
    }

    const acceptanceId = `WH-${action.order.id}`;
    const existing = state.warehouseAcceptances.find((acceptance) => acceptance.id === acceptanceId);
    const knownRolls = existing?.rolls ?? [];
    const nextRolls = knownRolls.some((roll) => roll.id === action.roll.id)
      ? knownRolls
      : [...knownRolls, rollToWarehouseRoll(action.roll)];
    const nextAcceptance: WarehouseAcceptanceRuntime = {
      id: acceptanceId,
      orderId: action.order.orderId,
      sourceTaskId: action.order.id,
      handoverId: `HAND-${action.order.id}`,
      status: 'ready_scan',
      expectedRollIds: nextRolls.map((roll) => roll.id),
      scannedRollIds: existing?.scannedRollIds ?? [],
      acceptedRollIds: existing?.acceptedRollIds ?? [],
      missingRollIds: missingRollIds(nextRolls),
      excessPayloads: existing?.excessPayloads ?? [],
      lastScan: existing?.lastScan ?? 'Сканов еще не было',
      scanResult: existing?.scanResult,
      rolls: nextRolls,
      shiftEvidence: action.shift,
      rollGroups: action.order.rollGroups,
      createdAt: existing?.createdAt ?? stampNow(),
    };
    return appendEvent(
      {
        ...state,
        warehouseAcceptances: existing
          ? state.warehouseAcceptances.map((acceptance) => acceptance.id === acceptanceId ? nextAcceptance : acceptance)
          : [nextAcceptance, ...state.warehouseAcceptances],
      },
      event('warehouse.acceptance.created_from_handover', acceptanceId, 'Открыта складская приемка', `${action.roll.id} передан оператором и появился у склада.`, 'operator')
    );
  }

  if (action.type === 'warehouse.scan') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    if (!acceptance) return state;
    const nextRoll = acceptance.rolls.find((roll) => roll.status === 'wait_scan' || roll.status === 'missing');
    if (!nextRoll) {
      const problem = runtimeProblem({
        objectId: acceptance.id,
        scope: 'warehouse',
        title: 'Дубликат QR',
        severity: 'critical',
        ownerRole: 'Склад',
        reason: 'Все ожидаемые рулоны уже были приняты; повторный QR не меняет счетчик.',
        recovery: 'Сканировать другой QR или создать проблему',
      });
      return appendEvent({ ...state, problems: [problem, ...state.problems] }, event('warehouse.qr.duplicate_detected', acceptance.id, problem.title, 'Счетчик склада не изменился.', 'warehouse', 'ProblemEvent'));
    }
    const nextState = updateAcceptance(state, acceptance.id, (current) => {
      const rolls = current.rolls.map((roll) => roll.id === nextRoll.id ? { ...roll, status: 'accepted' as const } : roll);
      const acceptedRollIds = Array.from(new Set([...current.acceptedRollIds, nextRoll.id]));
      return {
        ...current,
        status: acceptedRollIds.length === current.expectedRollIds.length ? 'accepted' : 'ready_scan',
        scannedRollIds: Array.from(new Set([...current.scannedRollIds, nextRoll.id])),
        acceptedRollIds,
        missingRollIds: missingRollIds(rolls),
        lastScan: nextRoll.qrCode,
        scanResult: `Принят ${nextRoll.id}`,
        rolls,
      };
    });
    return appendEvent(nextState, event('warehouse.qr.scanned', acceptance.id, 'QR принят складом', `${nextRoll.id} увеличил счетчик приемки.`, 'warehouse'));
  }

  if (action.type === 'warehouse.scan_duplicate') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    if (!acceptance) return state;
    const problem = runtimeProblem({
      objectId: acceptance.id,
      scope: 'warehouse',
      title: 'Дубликат QR',
      severity: 'critical',
      ownerRole: 'Директор',
      reason: 'Повторный QR не увеличивает счетчик приемки.',
      recovery: 'Проверить рулон вручную или создать решение для зав. производства',
    });
    const nextState = updateAcceptance({ ...state, problems: [problem, ...state.problems] }, acceptance.id, (current) => ({
      ...current,
      status: 'scan_error',
      lastScan: current.acceptedRollIds[0] ? `duplicate:${current.acceptedRollIds[0]}` : 'duplicate:unknown',
      scanResult: 'Дубликат QR: счетчик не изменился',
    }));
    return appendEvent(nextState, event('warehouse.qr.duplicate_detected', acceptance.id, problem.title, 'Счетчик приемки не изменился.', 'warehouse', 'ProblemEvent'));
  }

  if (action.type === 'warehouse.scan_wrong') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    if (!acceptance) return state;
    const payload = action.payload ?? `foreign:${acceptance.id}`;
    const problem = runtimeProblem({
      objectId: acceptance.id,
      scope: 'warehouse',
      title: 'Чужой QR',
      severity: 'critical',
      ownerRole: 'Директор',
      reason: 'QR не относится к ожидаемым рулонам этой приемки.',
      recovery: 'Отложить рулон и найти связанный заказ или создать проблему',
    });
    const nextState = updateAcceptance({ ...state, problems: [problem, ...state.problems] }, acceptance.id, (current) => ({
      ...current,
      status: 'scan_error',
      excessPayloads: Array.from(new Set([payload, ...current.excessPayloads])),
      lastScan: payload,
      scanResult: 'Чужой QR: счетчик не изменился',
    }));
    return appendEvent(nextState, event('warehouse.qr.wrong_detected', acceptance.id, problem.title, 'Чужой QR записан в список лишних сканов.', 'warehouse', 'ProblemEvent'));
  }

  if (action.type === 'warehouse.partial_accept') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    if (!acceptance) return state;
    const problem = runtimeProblem({
      objectId: acceptance.id,
      scope: 'warehouse',
      title: 'Частичная приемка',
      severity: 'warning',
      ownerRole: 'Склад',
      reason: acceptance.missingRollIds.length > 0 ? `Не найдены: ${acceptance.missingRollIds.join(', ')}.` : 'Приемка отмечена частичной вручную.',
      recovery: 'Подтвердить недостачу или досканировать оставшиеся рулоны',
    });
    const nextState = updateAcceptance({ ...state, problems: [problem, ...state.problems] }, acceptance.id, (current) => ({
      ...current,
      status: 'partial',
      scanResult: 'Частичная приемка записана',
    }));
    return appendEvent(nextState, event('warehouse.acceptance.partial_marked', acceptance.id, problem.title, 'Недостача записана без увеличения accepted count.', 'warehouse', 'ProblemEvent'));
  }

  if (action.type === 'warehouse.roll_damaged') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    const roll = acceptance?.rolls.find((item) => item.id === action.rollId);
    if (!acceptance || !roll) {
      const reason = action.reason?.trim() || `${action.rollId}: склад зафиксировал брак рулона.`;
      const problem = runtimeProblem({
        objectId: action.acceptanceId,
        scope: 'warehouse',
        title: 'Брак рулона',
        severity: 'warning',
        ownerRole: 'Директор',
        reason,
        recovery: 'Зафиксировать подтверждение брака и запросить решение по выдаче',
      });
      const defectRecord = {
        id: `DEF-${action.rollId}-${Date.now()}`,
        rollId: action.rollId,
        taskId: action.acceptanceId,
        acceptanceId: action.acceptanceId,
        sourceRole: 'warehouse' as const,
        comment: reason,
        blocking: true,
        createdAt: stampNow(),
      };
      return appendEvent(
        appendEvent(
          { ...state, problems: [problem, ...state.problems], defects: [defectRecord, ...state.defects.filter((defect) => defect.rollId !== action.rollId)] },
          event('warehouse.roll.damaged_recorded', action.acceptanceId, problem.title, problem.reason, 'warehouse', 'ProblemEvent')
        ),
        event('kpi.defect_recorded', action.rollId, 'Брак учтен в статистике', `${action.rollId}: склад зафиксировал брак рулона.`, 'warehouse', 'MasterKpiEvent')
      );
    }
    const problem = runtimeProblem({
      objectId: acceptance.id,
      scope: 'warehouse',
      title: 'Брак рулона',
      severity: 'warning',
      ownerRole: 'Директор',
      reason: action.reason?.trim() || `${roll.id}: брак упаковки или QR при приемке.`,
      recovery: 'Зафиксировать подтверждение брака и запросить решение по выдаче',
    });
    const nextState = updateAcceptance({ ...state, problems: [problem, ...state.problems] }, acceptance.id, (current) => ({
      ...current,
      status: 'scan_error',
      scanResult: 'Брак рулона записан',
      rolls: current.rolls.map((item) => item.id === roll.id ? { ...item, status: 'damaged' } : item),
    }));
    const defectRecord = {
      id: `DEF-${roll.id}-${Date.now()}`,
      rollId: roll.id,
      taskId: acceptance.sourceTaskId,
      orderId: acceptance.orderId,
      acceptanceId: acceptance.id,
      sourceRole: 'warehouse' as const,
      comment: problem.reason,
      blocking: true,
      createdAt: stampNow(),
    };
    const withDefectRecord = {
      ...nextState,
      defects: [defectRecord, ...nextState.defects.filter((defect) => defect.rollId !== roll.id)],
    };
    return appendEvent(
      appendEvent(withDefectRecord, event('warehouse.roll.damaged_recorded', acceptance.id, problem.title, problem.reason, 'warehouse', 'ProblemEvent')),
      event('kpi.defect_recorded', roll.id, 'Брак учтен в статистике', `${roll.id}: склад зафиксировал брак рулона.`, 'warehouse', 'MasterKpiEvent')
    );
  }

  if (action.type === 'warehouse.control_weight') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    const roll = acceptance?.rolls.find((item) => item.id === action.rollId);
    if (!acceptance || !roll) return state;
    if (!Number.isFinite(roll.plannedNetKg) || roll.plannedNetKg <= 0) {
      const problem = runtimeProblem({
        objectId: acceptance.id,
        scope: 'warehouse',
        title: 'Нет планового веса рулона',
        severity: 'critical',
        ownerRole: 'Зав. производства',
        reason: `${roll.id}: плановый вес не задан, контрольный процент не рассчитывается.`,
        recovery: 'Уточнить плановый вес до контрольного взвешивания',
      });
      return appendEvent(
        { ...state, problems: [problem, ...state.problems] },
        event('problem.warehouse_weight_plan_missing.created', acceptance.id, problem.title, problem.reason, 'warehouse', 'ProblemEvent')
      );
    }
    const controlWeightKg = Number((roll.plannedNetKg * 0.965).toFixed(1));
    const deviationPercent = Number(((controlWeightKg - roll.plannedNetKg) / roll.plannedNetKg * 100).toFixed(1));
    const problem = Math.abs(deviationPercent) > roll.tolerancePercent
      ? runtimeProblem({
          objectId: acceptance.id,
          scope: 'warehouse',
          title: 'Отклонение контрольного веса',
          severity: 'critical',
          ownerRole: 'Зав. производства',
          reason: `${roll.id}: ${deviationPercent}% от плана.`,
          recovery: 'Разобрать рулон до выдачи или подтвердить исключение',
        })
      : undefined;
    const nextState = updateAcceptance(
      { ...state, problems: problem ? [problem, ...state.problems] : state.problems },
      acceptance.id,
      (current) => ({
        ...current,
        status: problem ? 'scan_error' : current.status,
        scanResult: problem ? 'Контрольный вес вне допуска' : 'Контрольный вес в допуске',
        rolls: current.rolls.map((item) =>
          item.id === roll.id
            ? { ...item, controlWeightKg, deviationPercent, status: problem ? 'blocked_weight' : item.status }
            : item
        ),
      })
    );
    return appendEvent(nextState, event(problem ? 'problem.warehouse_weight_deviation.created' : 'warehouse.control_weight.captured', acceptance.id, problem?.title ?? 'Контрольный вес записан', problem?.reason ?? `${roll.id}: ${controlWeightKg} кг.`, 'warehouse', problem ? 'ProblemEvent' : 'AuditEvent'));
  }

  if (action.type === 'warehouse.delivery.close') {
    const acceptance = state.warehouseAcceptances.find((item) => item.id === action.acceptanceId);
    if (!acceptance) return state;
    const blocked = acceptance.rolls.some((roll) => roll.status === 'blocked_weight') || acceptance.acceptedRollIds.length === 0;
    if (blocked) {
      const problem = runtimeProblem({
        objectId: acceptance.id,
        scope: 'warehouse',
        title: 'Выдача заблокирована',
        severity: 'critical',
        ownerRole: 'Склад',
        reason: acceptance.acceptedRollIds.length === 0 ? 'Нет принятых рулонов.' : 'Есть рулон с отклонением контрольного веса.',
        recovery: 'Принять рулоны или подтвердить исключение у директора',
      });
      return appendEvent({ ...state, problems: [problem, ...state.problems] }, event('problem.delivery_blocked.created', acceptance.id, problem.title, problem.reason, 'warehouse', 'ProblemEvent'));
    }

    const deliveryId = `DEL-${acceptance.orderId}`;
    if (state.deliveries.some((item) => item.id === deliveryId)) return state;
    const trigger: PaymentTriggerRuntime = {
      triggerId: `PAY-${acceptance.orderId}-${Date.now()}`,
      orderId: acceptance.orderId,
      deliveryId,
      kind: 'delivery_closed',
      status: 'created',
      createdAt: stampNow(),
      installmentStartRule: 'shipment_plus_1_day',
      installmentStartsAt: 'следующие сутки после отгрузки',
    };
    return appendEvent(
      updateAcceptance(
        {
          ...state,
          deliveries: [
            {
              id: deliveryId,
              acceptanceId: acceptance.id,
              orderId: acceptance.orderId,
              status: 'closed',
              rollIds: acceptance.acceptedRollIds,
              closedAt: stampNow(),
            },
            ...state.deliveries.filter((item) => item.id !== deliveryId),
          ],
          paymentTriggers: [trigger, ...state.paymentTriggers],
          financeOrders: state.financeOrders.map((item) =>
            item.orderId === acceptance.orderId || item.orderId === `ЗН-${acceptance.orderId}`
              ? { ...item, status: 'waiting_payment' as const, source: 'warehouse_delivery' as const, paymentTriggerId: trigger.triggerId }
              : item
          ),
        },
        acceptance.id,
        (current) => ({
          ...current,
          status: 'delivery_ready',
          rolls: current.rolls.map((roll) => current.acceptedRollIds.includes(roll.id) ? { ...roll, status: 'delivered' as const } : roll),
        })
      ),
      event('finance.payment_trigger.created_from_delivery', trigger.orderId, 'Выдача закрыта', 'Финансы получили payment trigger после закрытой выдачи.', 'warehouse')
    );
  }

  if (action.type === 'director.penalty.created') {
    if (action.authorRole === 'production' && action.employeeRole !== 'Оператор') {
      return appendEvent(
        state,
        event('penalty.target_denied', action.scopeObjectId, 'Штраф не создан', 'Зав. производства может назначить штраф только оператору; штраф зав. производства остается директорским правом.', 'production', 'AuditEvent')
      );
    }
    const createdAt = stampNow();
    const penalty = {
      penaltyId: `PEN-${Date.now()}`,
      employeeId: action.employeeId,
      employeeName: action.employeeName,
      employeeRole: action.employeeRole,
      targetRole: action.employeeRole === 'Оператор' ? 'operator' as const : 'production_lead' as const,
      scopeObjectId: action.scopeObjectId,
      reason: action.reason,
      amountLabel: action.amountLabel,
      author: action.author,
      status: 'notified' as const,
      createdAt,
      history: [
        {
          id: `h-penalty-created-${Date.now()}`,
          time: createdAt,
          actorLabel: action.author,
          actionLabel: 'audit:penalty_created',
          detail: `Назначен штраф: ${action.employeeName}, ${action.amountLabel}. Причина: ${action.reason}.`,
        },
        {
          id: `h-penalty-notified-${Date.now()}`,
          time: createdAt,
          actorLabel: 'Система',
          actionLabel: 'notification:penalty_sent',
          detail: 'Сотруднику отправлено личное уведомление о штрафе.',
        },
      ],
    };
    return appendEvent(
      {
        ...state,
        penalties: [penalty, ...state.penalties],
      },
      event('audit.penalty_created', action.scopeObjectId, 'Штраф назначен', `Сотрудник: ${action.employeeName}. Сумма: ${action.amountLabel}. Уведомление отправлено.`, action.authorRole === 'production' ? 'production' : 'director', 'AuditEvent')
    );
  }

  if (action.type === 'director.penalty.updated') {
    if (action.authorRole === 'production' && action.employeeRole !== 'Оператор') {
      return appendEvent(
        state,
        event('penalty.target_denied', action.penaltyId, 'Штраф не изменен', 'Зав. производства не может перевести штраф на зав. производства.', 'production', 'AuditEvent')
      );
    }
    const previous = state.penalties.find((penalty) => penalty.penaltyId === action.penaltyId);
    if (!previous) return state;
    const updatedAt = stampNow();
    const oldValue = `${previous.employeeName}; ${previous.amountLabel}; ${previous.reason}`;
    const newValue = `${action.employeeName}; ${action.amountLabel}; ${action.reason}`;
    const nextPenalty = {
      ...previous,
      employeeId: action.employeeId,
      employeeName: action.employeeName,
      employeeRole: action.employeeRole,
      scopeObjectId: action.scopeObjectId,
      reason: action.reason,
      amountLabel: action.amountLabel,
      author: action.author,
      updatedAt,
      history: [
        {
          id: `h-penalty-updated-${Date.now()}`,
          time: updatedAt,
          actorLabel: action.author,
          actionLabel: 'audit:penalty_updated',
          detail: 'Изменены поля назначенного штрафа.',
          oldValue,
          newValue,
        },
        ...previous.history,
      ],
    };

    return appendEvent(
      {
        ...state,
        penalties: state.penalties.map((penalty) => (penalty.penaltyId === action.penaltyId ? nextPenalty : penalty)),
      },
      event('audit.penalty_updated', action.penaltyId, 'Штраф изменен', `Было: ${oldValue}; стало: ${newValue}.`, action.authorRole === 'production' ? 'production' : 'director', 'AuditEvent')
    );
  }

  if (action.type === 'director.kickback.updated') {
    const previous = state.kickbacks.find((item) => item.financeOrderId === action.financeOrderId);
    const next = {
      id: previous?.id ?? `KB-${action.financeOrderId}-${Date.now()}`,
      financeOrderId: action.financeOrderId,
      amountLabel: previous?.amountLabel ?? '18 000 ₽',
      status: action.status,
      visibility: 'director_only' as const,
      oldValue: previous ? `${previous.status}: ${previous.amountLabel}` : 'none',
      newValue: `${action.status}: ${previous?.amountLabel ?? '18 000 ₽'}`,
      updatedBy: 'Директор',
      updatedAt: stampNow(),
    };
    return appendEvent(
      {
        ...state,
        kickbacks: [next, ...state.kickbacks.filter((item) => item.financeOrderId !== action.financeOrderId)],
      },
      event('audit.kickback_changed', action.financeOrderId, 'Откат изменен', 'Прежнее и новое значение доступны только директору и разрешенным финансам.', 'director', 'AuditEvent')
    );
  }

  if (action.type === 'admin.device.created') {
    const device = normalizeDeviceContract(action.device);
    if (!device.id || state.devices.some((item) => item.id === device.id)) return state;
    return appendEvent(
      {
        ...state,
        devices: [device, ...state.devices],
      },
      event(
        'admin.device.created',
        device.id,
        device.kind === 'financeSource' ? 'Источник добавлен' : 'Устройство добавлено',
        'Админ добавил диагностический контракт без реального подключения.',
        'admin',
        'AuditEvent'
      )
    );
  }

  if (action.type === 'admin.device.updated') {
    const device = normalizeDeviceContract(action.device);
    if (!state.devices.some((item) => item.id === device.id)) return state;
    return appendEvent(
      {
        ...state,
        devices: state.devices.map((item) => (item.id === device.id ? device : item)),
      },
      event(
        'admin.device.updated',
        device.id,
        device.kind === 'financeSource' ? 'Источник изменен' : 'Устройство изменено',
        'Админ изменил диагностический контракт; производственные действия не выполнялись.',
        'admin',
        'AuditEvent'
      )
    );
  }

  if (action.type === 'admin.device.tested') {
    if (!state.devices.some((device) => device.id === action.deviceId)) return state;
    return appendEvent(
      {
        ...state,
        devices: state.devices.map((device) =>
          device.id === action.deviceId
            ? deviceTestResult(device)
            : device
        ),
      },
      event('admin.device.test_requested', action.deviceId, 'Устройство проверено', 'Диагностика записана без выполнения производственного действия.', 'admin', 'IntegrationEvent')
    );
  }

  return state;
}

function withManualTestPayload(device: DeviceMockContract): DeviceMockContract {
  return {
    ...device,
    lastSeenAt: stampNow(),
    rawPayload: device.rawPayload.includes('test=manual') ? device.rawPayload : `${device.rawPayload};test=manual`,
  };
}

function deviceTestResult(device: DeviceMockContract): DeviceMockContract {
  const tested = withManualTestPayload(device);
  if (tested.kind === 'financeSource') {
    return {
      ...tested,
      status: 'ready',
      severity: 'info',
      statusLabel: 'Учётный источник проверен',
      parsedPayload: 'Учётный источник отвечает, результат передан бухгалтерии',
    };
  }
  if (tested.status === 'offline') {
    return {
      ...tested,
      statusLabel: 'Связь не восстановлена',
      parsedPayload: 'Весы не отвечают после проверки связи.',
      recovery: 'Проверить питание, кабель/USB или Ethernet, затем передать админу смены до повторного взвешивания.',
      testActionLabel: 'Повторить проверку связи',
      secondaryActions: [{ id: 'admin-forward-owner', label: 'Передать админу смены', level: 'secondary' }],
    };
  }
  if (tested.kind === 'scanner') {
    return {
      ...tested,
      status: 'unstable',
      statusLabel: 'Нужна привязка рабочего места',
      parsedPayload: 'Сканер отвечает, но не назначен складу.',
      recovery: 'Назначить рабочее место склада или передать владельцу склада до следующей приемки.',
      testActionLabel: 'Повторить проверку привязки',
      secondaryActions: [{ id: 'admin-forward-owner', label: 'Передать складу', level: 'secondary' }],
    };
  }
  return {
    ...tested,
    status: tested.status === 'error' ? 'unstable' : tested.status,
  };
}
