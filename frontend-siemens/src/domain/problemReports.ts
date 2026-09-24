import { auditEntry, factValue } from './prototypeRuntime';
import {
  OPERATOR_REPORTABLE_PROBLEM_ROUTING,
  type OperatorReportableProblemType,
} from './operatorProblem';
import type {
  AuditEntry,
  Fact,
  ProblemCase,
  ProblemReportContext,
  ProblemReportDraft,
  ProblemReportPayload,
  ProblemType,
  ReportableEntityKind,
  Role,
  Severity,
  WorkObject,
} from './types';

type ProblemDefaults = {
  type: ProblemType;
  operatorProblemType?: OperatorReportableProblemType;
  entityKind: ReportableEntityKind;
  entityId: string;
  ownerRole: string;
  targetRole?: Role;
  due: string;
  severity: Severity;
  title: string;
  stage: string;
  recovery: string;
  auditEvent: string;
  notificationRole?: Role;
  notificationTitle: string;
  notificationBody: string;
  lockedTarget?: boolean;
};

const actorLabels: Record<Role, string> = {
  commercial: 'Коммерция',
  production: 'Зав. производства',
  finance: 'Бухгалтерия',
  director: 'Директор',
  operator: 'Оператор',
  warehouse: 'Склад',
  admin: 'Админ',
};

export const problemTypeLabels: Record<ProblemType, string> = {
  production_change: 'Изменение производства',
  weight_deviation: 'Вес / отклонение',
  device_failure: 'Устройство',
  qr_exception: 'QR / этикетка',
  warehouse_exception: 'Складское исключение',
  payment_issue: 'Оплата / счет',
  source_sync: 'Источник данных',
  inventory_conflict: 'Сырье / остатки',
  access_issue: 'Доступ',
  manual_review: 'Ручной разбор',
};

export const reportableEntityLabels: Record<ReportableEntityKind, string> = {
  order: 'Заявка / заказ',
  production_order: 'Заказ-наряд',
  position: 'Позиция',
  roll: 'Рулон',
  qr_label: 'QR / этикетка',
  weight_device: 'Вес / устройство',
  warehouse_acceptance: 'Приемка склада',
  warehouse_delivery: 'Выдача склада',
  payment: 'Оплата',
  invoice: 'Счет',
  source: 'Источник',
  inventory: 'Сырье / остатки',
  access: 'Доступ',
  admin_device: 'Устройство / настройка',
  problem: 'Открытая проблема',
};

export function isProblemReportAction(actionId: string) {
  return actionId === 'operator-problem'
    || actionId === 'operator-defect'
    || actionId.startsWith('reject')
    || actionId === 'problem'
    || actionId.startsWith('problem-')
    || actionId.startsWith('production-create-problem:')
    || actionId.startsWith('finance-create-problem:')
    || actionId.startsWith('director-qr-problem:')
    || actionId.startsWith('warehouse.problem:')
    || actionId.startsWith('warehouse.return:')
    || actionId.startsWith('warehouse.roll_damaged:')
    || actionId.startsWith('warehouse-cover-recheck-problem:');
}

function objectEntityKind(object: WorkObject): ReportableEntityKind {
  if (object.kind === 'productionOrder') return 'production_order';
  if (object.kind === 'financeOrder') return 'payment';
  if (object.kind === 'warehouseJob') {
    if (object.workbench?.type === 'warehouse' && object.workbench.mode === 'delivery') return 'warehouse_delivery';
    return 'warehouse_acceptance';
  }
  if (object.kind === 'adminEntity') {
    if (object.workbench?.type === 'admin' && object.workbench.entityType === 'access') return 'access';
    if (object.workbench?.type === 'admin' && object.workbench.entityType === 'source') return 'source';
    return 'admin_device';
  }
  if (object.kind === 'operatorTask') return 'roll';
  if (object.kind === 'intake') return 'order';
  return 'problem';
}

function targetFromAction(actionId: string) {
  const index = actionId.indexOf(':');
  return index >= 0 ? actionId.slice(index + 1) : '';
}

function firstPositionId(object: WorkObject) {
  return object.commercialOrder?.positions[0]?.id ?? object.commercialOrder?.positions[0]?.draftId;
}

function defaultEntityId(object: WorkObject, actionId: string) {
  const explicitTarget = targetFromAction(actionId);
  if (explicitTarget) return explicitTarget;
  if (object.workbench?.type === 'operator' && object.workbench.currentRoll?.id) return object.workbench.currentRoll.id;
  return firstPositionId(object)
    ?? factValue(object, 'Рулон')
    ?? factValue(object, 'QR')
    ?? factValue(object, 'Заказ')
    ?? factValue(object, 'Номер')
    ?? object.id;
}

function duplicateFor(object: WorkObject, type: ProblemType, entityKind: ReportableEntityKind, entityId: string) {
  return object.problems.find((problem) =>
    problem.status === 'open'
    && (problem.type ?? inferLegacyType(problem)) === type
    && (problem.entityKind ?? inferLegacyEntityKind(problem)) === entityKind
    && (problem.entityId ?? problem.objectId) === entityId
  );
}

function inferLegacyType(problem: ProblemCase): ProblemType {
  const text = `${problem.stage} ${problem.title} ${problem.reason}`.toLowerCase();
  if (text.includes('qr') || text.includes('этикет')) return 'qr_exception';
  if (text.includes('вес')) return 'weight_deviation';
  if (text.includes('склад')) return 'warehouse_exception';
  if (text.includes('оплат') || text.includes('счет')) return 'payment_issue';
  if (text.includes('источник') || text.includes('синх')) return 'source_sync';
  if (text.includes('доступ')) return 'access_issue';
  return 'manual_review';
}

function inferLegacyEntityKind(problem: ProblemCase): ReportableEntityKind {
  const text = `${problem.stage} ${problem.title}`.toLowerCase();
  if (text.includes('скан') || text.includes('qr')) return 'qr_label';
  if (text.includes('вес')) return 'weight_device';
  if (text.includes('склад')) return 'warehouse_acceptance';
  if (text.includes('плат') || text.includes('счет')) return 'payment';
  if (text.includes('источник')) return 'source';
  return 'problem';
}

function baseReadOnlyFacts(object: WorkObject, defaults: ProblemDefaults): Fact[] {
  return [
    { label: 'Объект', value: `${object.title} · ${object.id}` },
    { label: 'Статус', value: object.statusLabel },
    { label: defaults.entityKind === 'source' ? 'Связанный источник' : 'Связанная сущность', value: `${reportableEntityLabels[defaults.entityKind]} · ${defaults.entityId}` },
    { label: 'Владелец', value: defaults.ownerRole },
    { label: 'Срок', value: defaults.due },
  ];
}

function defaultsFor(role: Role, object: WorkObject, actionId: string): ProblemDefaults {
  const base: ProblemDefaults = {
    type: 'manual_review',
    entityKind: objectEntityKind(object),
    entityId: defaultEntityId(object, actionId),
    ownerRole: actorLabels[role],
    due: 'сегодня',
    severity: object.severity === 'info' ? 'warning' : object.severity,
    title: 'Проблема создана',
    stage: object.statusLabel,
    recovery: 'Назначить владельца и закрыть по факту',
    auditEvent: 'problem:manual_reported',
    notificationRole: role === 'director' ? undefined : 'director',
    notificationTitle: 'Проблема создана',
    notificationBody: `${actorLabels[role]} создала проблему с владельцем.`,
  };

  if (role === 'operator') {
    if (actionId === 'operator-defect') {
      return {
        ...base,
        type: 'production_change',
        entityKind: 'roll',
        ownerRole: 'Зав. производства',
        due: 'до продолжения заказа',
        severity: 'warning',
        title: 'Брак текущего рулона',
        recovery: 'Зав. производства решает продолжение',
        auditEvent: 'problem:operator_defect_reported',
        notificationRole: 'production',
        notificationTitle: 'Брак текущего рулона',
        notificationBody: 'Оператор открыл разбор брака по текущему рулону.',
      };
    }
    if (actionId === 'operator-problem') {
      return {
        ...base,
        type: 'production_change',
        operatorProblemType: 'general',
        entityKind: 'roll',
        ownerRole: 'Зав. производства',
        targetRole: 'production',
        due: 'до следующего шага',
        title: 'Проблема по текущему рулону',
        recovery: 'Зав. производства решает следующий шаг',
        auditEvent: 'problem:operator_reported',
        notificationRole: 'production',
        notificationTitle: 'Проблема оператора',
        notificationBody: 'Оператор сообщил проблему по текущему рулону.',
        lockedTarget: true,
      };
    }
    const qrAction = actionId.includes('qr') || object.statusLabel.toLowerCase().includes('qr');
    const weightAction = actionId.includes('weight') || object.statusLabel.toLowerCase().includes('вес');
    return {
      ...base,
      type: qrAction ? 'qr_exception' : weightAction ? 'weight_deviation' : 'production_change',
      entityKind: qrAction ? 'qr_label' : weightAction ? 'weight_device' : 'roll',
      ownerRole: weightAction ? 'Админ' : 'Зав. производства',
      due: 'до следующего шага',
      title: qrAction ? 'Проблема QR у оператора' : weightAction ? 'Проблема веса у оператора' : 'Проблема по текущему рулону',
      recovery: weightAction ? 'Админ проверяет устройство' : 'Зав. производства решает продолжение',
      auditEvent: weightAction ? 'problem:operator_weight_reported' : 'problem:operator_reported',
      notificationRole: weightAction ? 'admin' : 'production',
      notificationTitle: weightAction ? 'Проблема веса' : 'Проблема оператора',
      notificationBody: 'Оператор сообщил проблему по текущему физическому шагу.',
    };
  }

  if (role === 'warehouse') {
    const rollTarget = targetFromAction(actionId);
    const isRollDefect = actionId.startsWith('warehouse.roll_damaged:');
    const isReturn = actionId.startsWith('warehouse.return:') || actionId.startsWith('reject');
    const isQr = actionId.includes('problem') || actionId.includes('return') || object.statusLabel.toLowerCase().includes('qr');
    const isDelivery = object.workbench?.type === 'warehouse' && object.workbench.mode === 'delivery';
    return {
      ...base,
      type: isRollDefect || isReturn ? 'warehouse_exception' : isQr ? 'qr_exception' : 'warehouse_exception',
      entityKind: rollTarget ? 'roll' : isDelivery ? 'warehouse_delivery' : 'warehouse_acceptance',
      entityId: rollTarget || base.entityId,
      ownerRole: isRollDefect || isReturn ? 'Директор' : 'Склад',
      due: 'до закрытия складского шага',
      title: isRollDefect ? 'Брак рулона' : isReturn ? 'Складское исключение' : 'Складская проблема',
      recovery: isRollDefect
          ? 'Директор возвращает решение складу'
        : isReturn
          ? 'Директор возвращает решение складу'
          : 'Склад фиксирует исход',
      auditEvent: isRollDefect ? 'problem:warehouse_roll_defect_reported' : isReturn ? 'problem:warehouse_return_reported' : 'problem:warehouse_reported',
      notificationRole: 'director',
      notificationTitle: isRollDefect ? 'Брак рулона' : isReturn ? 'Складское исключение' : 'Складская проблема',
      notificationBody: isRollDefect ? 'Склад зафиксировал брак по ожидаемому рулону.' : 'Склад сообщил проблему по приемке, выдаче или связанному рулону.',
    };
  }

  if (role === 'production' || actionId.startsWith('production-create-problem:')) {
    return {
      ...base,
      type: 'production_change',
      entityKind: firstPositionId(object) ? 'position' : 'production_order',
      entityId: firstPositionId(object) ?? base.entityId,
      ownerRole: 'Коммерция',
      targetRole: 'commercial',
      due: 'до продолжения текущего рулона',
      title: 'Проблема из производства',
      recovery: 'Коммерция задает изменение и рулон',
      auditEvent: 'problem:production_reported_to_commercial',
      notificationRole: 'commercial',
      notificationTitle: 'Проблема из производства',
      notificationBody: 'Зав. производства сообщил проблему по позиции.',
      lockedTarget: true,
    };
  }

  if (role === 'finance') {
    const isSource = actionId.includes('sync') || object.statusLabel.toLowerCase().includes('источник') || object.statusLabel.toLowerCase().includes('синх');
    return {
      ...base,
      type: isSource ? 'source_sync' : 'payment_issue',
      entityKind: isSource ? 'source' : 'payment',
      ownerRole: isSource ? 'Админ' : 'Бухгалтерия',
      due: 'сегодня',
      title: isSource ? 'Проблема источника оплаты' : 'Финансовая проблема',
      recovery: isSource ? 'Админ проверяет источник' : 'Бухгалтерия обновляет статус',
      auditEvent: isSource ? 'problem:payment_sync_error' : 'problem:payment_overdue',
      notificationRole: isSource ? 'admin' : 'director',
      notificationTitle: isSource ? 'Проблема источника' : 'Финансовая проблема',
      notificationBody: 'Бухгалтерия сообщила проблему.',
    };
  }

  if (role === 'director' && actionId.startsWith('director-qr-problem:')) {
    return {
      ...base,
      type: 'qr_exception',
      entityKind: 'qr_label',
      ownerRole: 'Директор',
      due: 'до закрытия разбора QR',
      title: 'Проблема QR',
      recovery: 'Назначить владельца разбора и связать QR с заказом или рулоном',
      auditEvent: 'problem:director_qr_reported',
      notificationRole: 'admin',
      notificationTitle: 'QR требует разбора',
      notificationBody: 'Директор создал проблему по QR-контексту.',
    };
  }

  if (role === 'admin') {
    const isAccess = object.workbench?.type === 'admin' && object.workbench.entityType === 'access';
    const isSource = object.workbench?.type === 'admin' && object.workbench.entityType === 'source';
    return {
      ...base,
      type: isAccess ? 'access_issue' : isSource ? 'source_sync' : 'device_failure',
      entityKind: isAccess ? 'access' : isSource ? 'source' : 'admin_device',
      ownerRole: 'Админ',
      due: 'до восстановления рабочего шага',
      title: isAccess ? 'Проблема доступа' : isSource ? 'Проблема источника данных' : 'Проблема устройства',
      recovery: isAccess ? 'Админ меняет доступ' : isSource ? 'Админ проверяет источник' : 'Админ проверяет устройство',
      auditEvent: isAccess ? 'problem:access_reported' : isSource ? 'problem:source_sync_reported' : 'problem:device_reported',
      notificationRole: isAccess ? 'director' : undefined,
      notificationTitle: isAccess ? 'Проблема доступа' : isSource ? 'Проблема источника' : 'Проблема устройства',
      notificationBody: 'Админ создал диагностическую проблему.',
    };
  }

  if (role === 'commercial') {
    return {
      ...base,
      type: 'production_change',
      entityKind: firstPositionId(object) ? 'position' : 'order',
      entityId: firstPositionId(object) ?? base.entityId,
      ownerRole: 'Коммерция',
      due: 'до передачи дальше',
      title: 'Проблема заявки',
      recovery: 'Коммерция уточняет позицию',
      auditEvent: 'problem:commercial_reported',
      notificationRole: 'director',
      notificationTitle: 'Проблема заявки',
      notificationBody: 'Коммерция создала проблему по заявке или позиции.',
    };
  }

  return {
    ...base,
    ownerRole: 'Директор',
    targetRole: 'director',
    title: 'Проблема для решения',
    recovery: 'Директор назначает владельца и фиксирует исход',
    auditEvent: 'problem:director_reported',
  };
}

export function createProblemReportContext(role: Role, object: WorkObject, actionId: string): ProblemReportContext {
  const defaults = defaultsFor(role, object, actionId);
  const duplicateProblem = duplicateFor(object, defaults.type, defaults.entityKind, defaults.entityId);
  const draft: ProblemReportDraft = {
    type: defaults.type,
    operatorProblemType: defaults.operatorProblemType,
    entityKind: defaults.entityKind,
    entityId: defaults.entityId,
    ownerRole: defaults.ownerRole,
    targetRole: defaults.targetRole,
    due: defaults.due,
    severity: defaults.severity,
    reason: '',
    createLinkedDuplicate: false,
  };

  return {
    role,
    actionId,
    objectId: object.id,
    objectTitle: object.title,
    objectStatus: object.statusLabel,
    actorLabel: actorLabels[role],
    title: defaults.title,
    stage: defaults.stage,
    recovery: defaults.recovery,
    auditEvent: defaults.auditEvent,
    notificationRole: defaults.notificationRole,
    notificationTitle: defaults.notificationTitle,
    notificationBody: defaults.notificationBody,
    duplicateProblem,
    lockedTarget: Boolean(defaults.lockedTarget),
    readOnlyFacts: baseReadOnlyFacts(object, defaults),
    draft,
  };
}

export function problemReportPayload(context: ProblemReportContext, draft: ProblemReportDraft): ProblemReportPayload {
  const operatorRouting =
    context.role === 'operator' && context.actionId === 'operator-problem'
      ? OPERATOR_REPORTABLE_PROBLEM_ROUTING[draft.operatorProblemType ?? 'general']
      : null;
  return {
    ...draft,
    ownerRole: operatorRouting?.ownerLabel ?? draft.ownerRole,
    targetRole: operatorRouting?.targetRole ?? draft.targetRole,
    objectId: context.objectId,
    sourceActionId: context.actionId,
    createdByRole: context.role,
    actorLabel: context.actorLabel,
    title: context.title,
    stage: context.stage,
    recovery: operatorRouting?.recovery ?? context.recovery,
    auditEvent: context.auditEvent,
    notificationRole: operatorRouting?.targetRole ?? context.notificationRole,
    notificationTitle: context.notificationTitle,
    notificationBody: context.notificationBody,
    duplicateProblemId: context.duplicateProblem?.id,
  };
}

export function problemCaseFromReport(payload: ProblemReportPayload): ProblemCase {
  return {
    id: `p-${payload.objectId}-${Date.now()}`,
    objectId: payload.objectId,
    type: payload.type,
    entityKind: payload.entityKind,
    entityId: payload.entityId,
    createdByRole: payload.createdByRole,
    targetRole: payload.targetRole,
    sourceActionId: payload.sourceActionId,
    stage: payload.stage,
    title: payload.title,
    severity: payload.severity,
    ownerRole: payload.ownerRole,
    due: payload.due,
    reason: payload.reason,
    recovery: payload.recovery,
    status: 'open',
  };
}

export function addProblemReportToObject(object: WorkObject, payload: ProblemReportPayload): { object: WorkObject; problem: ProblemCase; audit: AuditEntry } {
  const problem = problemCaseFromReport(payload);
  const audit = {
    ...auditEntry(object.id, payload.actorLabel, payload.auditEvent, `${payload.reason} Восстановление: ${payload.recovery}.`),
    reason: payload.reason,
    oldValue: payload.duplicateProblemId ? `linked:${payload.duplicateProblemId}` : undefined,
    newValue: problem.title,
  };

  return {
    problem,
    audit,
    object: {
      ...object,
      severity: object.severity === 'critical' ? object.severity : payload.severity,
      filterTags: Array.from(new Set([...(object.filterTags ?? []), 'С проблемами', 'Требуют действия'])),
      problems: [problem, ...object.problems],
      audit: [audit, ...object.audit],
    },
  };
}
