import {
  auditEntry,
  auditEntryWithValues,
  factValue,
  stampNow,
  updateFactList,
} from './prototypeRuntime';
import { operatorById } from './operators';
import type { Fact, ProblemCase, WorkObject } from './types';

function resolvedProblems(problems: ProblemCase[]) {
  return problems.map((problem) => ({ ...problem, status: 'resolved' as const }));
}

function scopedProblem(object: WorkObject, roleLabel: string, title = 'Проблема создана') {
  return {
    id: `p-${object.id}-${Date.now()}`,
    objectId: object.id,
    stage: object.statusLabel,
    title,
    severity: object.severity === 'info' ? 'warning' as const : object.severity,
    ownerRole: roleLabel,
    due: 'сегодня',
    reason: `Пользователь роли ${roleLabel} создал проблему по объекту ${object.id}.`,
    recovery: 'Назначить владельца и закрыть после выполнения доступного действия',
    status: 'open' as const,
  };
}

export function addScopedProblem(object: WorkObject, roleLabel: string, actionLabel = 'Проблема создана') {
  const problem = scopedProblem(object, roleLabel, actionLabel);
  return {
    ...object,
    severity: object.severity === 'critical' ? object.severity : 'warning' as const,
    filterTags: Array.from(new Set([...(object.filterTags ?? []), 'С проблемами'])),
    problems: [problem, ...object.problems],
    audit: [auditEntry(object.id, roleLabel, actionLabel, `${problem.reason} Восстановление: ${problem.recovery}.`), ...object.audit],
  };
}

function withUpdatedSections(object: WorkObject, updates: Record<string, string>, scope: Fact['scope'] = 'common') {
  return {
    ...object,
    facts: updateFactList(object.facts, updates, scope),
    sections: object.sections.map((section) => ({
      ...section,
      facts: updateFactList(section.facts, updates, scope),
    })),
  };
}

export function recoverProductionObject(object: WorkObject, actorLabel: string, actionLabel: string) {
  const fallbackOperator = operatorById('operator-line-a');
  const fallbackWorkplace = fallbackOperator?.workplace ?? 'Экструдер E-04';
  const fallbackOperatorName = fallbackOperator?.name ?? 'Сергей Волков';
  const currentResponsible = factValue(object, 'Ответственный');
  const needsResponsible = !currentResponsible || ['Не назначен', 'Назначить при оформлении', 'Зав. производства'].includes(currentResponsible);
  const nextObject = withUpdatedSections(
    object,
    {
      Ответственный: needsResponsible ? fallbackOperatorName : currentResponsible,
      'Рабочее место': needsResponsible ? fallbackWorkplace : factValue(object, 'Рабочее место') ?? factValue(object, 'Станок') ?? fallbackWorkplace,
      Приоритет: factValue(object, 'Приоритет') ?? 'обычный',
      'Плановый вес': factValue(object, 'Плановый вес') ?? factValue(object, 'Рулоны') ?? 'подтвержден по шаблону',
      Полнота: 'Параметры заполнены',
      'Причина изменения': 'Замена подтверждена зав. производства',
      'Что блокирует': 'Нет блокера',
    },
    'production'
  );
  return {
    ...nextObject,
    statusLabel: 'Готов к согласованию',
    nextOwner: 'Зав. производства',
    severity: 'info' as const,
    filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия'])).filter((tag) => tag !== 'Заблокированы' && tag !== 'С проблемами'),
    actions: [
      { id: `production-approve-order:${object.id}`, label: 'Согласовать заказ-наряд', level: 'recommended' as const, enabled: true },
      { id: `production-save-draft:${object.id}`, label: 'Сохранить изменения', level: 'secondary' as const, enabled: true },
      { id: `production-check-completeness:${object.id}`, label: 'Открыть проверку полноты', level: 'secondary' as const, enabled: true },
    ],
    problems: resolvedProblems(object.problems),
    audit: [
      auditEntryWithValues(object.id, actorLabel, actionLabel, 'Недостающие производственные поля заполнены; согласование заказ-наряда стало доступно.', {
        oldValue: 'blocked',
        newValue: 'ready_for_approval',
      }),
      ...object.audit,
    ],
  };
}

function rollIdsForWarehouse(object: WorkObject) {
  const workbench = object.workbench?.type === 'warehouse' ? object.workbench : null;
  if (!workbench) return [];
  return workbench.expectedRolls?.filter((roll) => roll.plannedNetKg > 0).map((roll) => roll.id) ?? workbench.accepted;
}

export function recordWarehouseRollDefectObject(object: WorkObject, actorLabel: string, rollId: string, reason: string) {
  const workbench = object.workbench?.type === 'warehouse' ? object.workbench : null;
  if (!workbench) {
    return {
      ...object,
      audit: [auditEntry(object.id, actorLabel, 'Брак рулона записан', reason), ...object.audit],
    };
  }

  return {
    ...object,
    statusLabel: 'Проблема приемки',
    severity: object.severity === 'critical' ? object.severity : 'warning' as const,
    filterTags: Array.from(new Set([...(object.filterTags ?? []), 'С проблемами'])),
    facts: updateFactList(object.facts, { 'Последний скан': `${rollId}: брак`, Брак: '1' }, 'warehouse'),
    workbench: {
      ...workbench,
      scanSeverity: 'warning' as const,
      scanResult: 'Брак рулона записан',
      lastScan: `${rollId}: брак`,
      recovery: 'Директор видит подтверждение брака и возвращает решение складу',
      nextEffect: 'Запись брака попадает в отдельную статистику качества.',
      expectedRolls: workbench.expectedRolls?.map((roll) => (
        roll.id === rollId ? { ...roll, status: 'Брак' } : roll
      )),
    },
    audit: [
      auditEntryWithValues(object.id, actorLabel, 'Брак рулона записан', reason, {
        oldValue: rollId,
        newValue: 'Брак',
      }),
      ...object.audit,
    ],
  };
}

export function resolveWarehouseScanObject(object: WorkObject, actorLabel: string, mode: 'scan' | 'manual' | 'partial' | 'deliveryClose' | 'reject') {
  const workbench = object.workbench?.type === 'warehouse' ? object.workbench : null;
  if (!workbench) {
    return {
      ...object,
      audit: [auditEntry(object.id, actorLabel, 'Действие склада записано', 'Статическая карточка не содержит складской workbench; действие зафиксировано в истории.'), ...object.audit],
    };
  }

  if (mode === 'reject') {
    return addScopedProblem(
      {
        ...object,
        statusLabel: 'Складское исключение',
        severity: 'warning',
      },
      actorLabel,
      'Складское исключение создано'
    );
  }

  if (mode === 'partial') {
    const nextObject = withUpdatedSections(
      object,
      {
        Статус: workbench.mode === 'delivery' ? 'Частичная выдача оформлена' : 'Частичная приемка оформлена',
        Закрытие: 'Частичное исключение записано',
        'Частичная выдача': 'Оформлена с причиной',
      },
      'warehouse'
    );
    const problem = scopedProblem(nextObject, actorLabel, workbench.mode === 'delivery' ? 'Частичная выдача' : 'Частичная приемка');
    return {
      ...nextObject,
      statusLabel: workbench.mode === 'delivery' ? 'Частичная выдача' : 'Частичная приемка',
      severity: 'warning' as const,
      filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Частичные', 'С проблемами'])),
      problems: object.problems.some((item) => item.status === 'open') ? object.problems : [problem, ...object.problems],
      workbench: {
        ...workbench,
        scanSeverity: 'warning' as const,
        scanResult: workbench.mode === 'delivery' ? 'Частичная выдача оформлена с причиной.' : 'Частичная приемка оформлена с причиной.',
        blockingReason: undefined,
        recovery: 'Открыть историю или решение директора по исключению',
        nextEffect: workbench.mode === 'delivery'
          ? 'Финансовый срок остается заблокированным до утвержденного правила частичной выдачи.'
          : 'Складское исключение записано и видно директору.',
      },
      audit: [auditEntry(object.id, actorLabel, workbench.mode === 'delivery' ? 'Частичная выдача оформлена' : 'Частичная приемка оформлена', 'Причина исключения записана; событие остается problem-backed.'), ...object.audit],
    };
  }

  const ids = rollIdsForWarehouse(object);
  const currentAccepted = workbench.accepted;
  const nextScanId = ids.find((id) => !currentAccepted.includes(id));
  const accepted = nextScanId ? Array.from(new Set([...currentAccepted, nextScanId])) : currentAccepted;
  const lastAccepted = nextScanId ?? accepted[accepted.length - 1];
  const remaining = ids.filter((id) => !accepted.includes(id));
  const allAccepted = ids.length > 0 && accepted.length >= ids.length;
  const isDelivery = workbench.mode === 'delivery';
  const statusLabel = allAccepted
    ? isDelivery || mode === 'deliveryClose' ? 'Выдано' : 'Принято'
    : isDelivery || mode === 'deliveryClose' ? 'Сканирование выдачи' : 'Сканирование приемки';
  const actionLabel = isDelivery || mode === 'deliveryClose' ? 'Выдача закрыта' : mode === 'manual' ? 'QR разобран вручную' : 'QR принят';
  const counterLabel = `${accepted.length} / ${workbench.expected}`;
  const nextObject = withUpdatedSections(
    object,
    {
      Принято: isDelivery ? factValue(object, 'Принято') ?? String(accepted.length) : String(accepted.length),
      Выдано: isDelivery ? String(accepted.length) : factValue(object, 'Выдано') ?? String(accepted.length),
      'Последний скан': lastAccepted ? `${lastAccepted} ${isDelivery ? 'выдан' : 'принят'}` : 'без расхождений',
      'Не хватает': remaining.length > 0 ? remaining.join(', ') : 'Нет',
      Лишние: 'Нет',
      Закрытие: allAccepted ? isDelivery ? 'Выдача закрыта' : 'Приемка закрыта' : 'Ждет следующие QR',
      'Срок после выдачи': isDelivery && allAccepted ? 'Запущен' : 'Не требуется',
      'Событие срока': isDelivery && allAccepted ? 'Финансовый срок сохранен' : factValue(object, 'Событие срока') ?? 'Не требуется',
    },
    'warehouse'
  );
  return {
    ...nextObject,
    statusLabel,
    nextOwner: isDelivery && allAccepted ? 'Завершено' : 'Склад',
    severity: 'info' as const,
    filterTags: allAccepted
      ? Array.from(new Set([...(object.filterTags ?? []), 'Закрытые', 'Завершены'])).filter((tag) => tag !== 'Заблокированы' && tag !== 'С проблемами' && tag !== 'Ошибки QR')
      : Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия'])).filter((tag) => tag !== 'Заблокированы' && tag !== 'С проблемами' && tag !== 'Ошибки QR' && tag !== 'Завершены'),
    actions: allAccepted
      ? [{ id: `warehouse-history:${object.id}`, label: 'Открыть историю', level: 'recommended' as const, enabled: true, actionIntent: 'inspect' as const }]
      : object.actions,
    problems: allAccepted ? resolvedProblems(object.problems) : object.problems,
    workbench: {
      ...workbench,
      scanned: accepted.length,
      accepted,
      missing: remaining,
      excess: [],
      lastScan: lastAccepted ? `${lastAccepted} ${isDelivery ? 'выдан' : 'принят'}` : 'без расхождений',
      scanSeverity: 'info' as const,
      scanResult: lastAccepted
        ? `${isDelivery ? 'QR выдан' : 'QR принят'}: ${lastAccepted}`
        : isDelivery ? 'Все ожидаемые QR выданы.' : 'Все ожидаемые QR приняты.',
      blockingReason: undefined,
      recovery: undefined,
      nextEffect: allAccepted
        ? isDelivery ? 'Mock trigger срока сохранен; склад не видит денежных деталей.' : 'Приемка закрыта, история доступна.'
        : 'Сканер ждет следующий QR по этой приемке.',
      deviceStatus: [
        { label: 'Сканер', value: 'Готов', severity: 'info' as const },
        { label: 'Счетчик', value: counterLabel, severity: 'info' as const },
      ],
      expectedRolls: workbench.expectedRolls?.map((roll) => ({
        ...roll,
        status: accepted.includes(roll.id)
          ? isDelivery ? 'Выдан' : 'Принят'
          : roll.plannedNetKg > 0 ? roll.status : 'Разобран',
      })),
    },
    audit: [
      auditEntryWithValues(object.id, actorLabel, actionLabel, lastAccepted ? `${lastAccepted}: валидный QR записан, счетчик ${counterLabel}.` : 'Сканирование закрыто без нового QR.', {
        reason: object.statusLabel,
        oldValue: object.statusLabel,
        newValue: statusLabel,
      }),
      ...object.audit,
    ],
  };
}

export function resolveAdminDiagnosticObject(object: WorkObject, actorLabel: string, actionLabel: string) {
  const workbench = object.workbench?.type === 'admin' ? object.workbench : null;
  const entityType = workbench?.entityType;
  const nextStatus = entityType === 'access'
    ? 'Доступ сохранен'
    : entityType === 'roleTemplate'
      ? 'Шаблон сохранен'
      : entityType === 'source'
        ? 'Учётный источник проверен'
        : object.id.includes('SCAN')
          ? 'Привязано'
          : 'Устройство проверено';
  const nextObject = withUpdatedSections(
    object,
    {
      Статус: nextStatus,
      'Статус доступа': nextStatus,
      [entityType === 'source' ? 'Ошибка источника' : 'Ошибка устройства']: 'Нет',
      'Система поняла': object.id === 'ADM-FIN-SOURCE-01' ? 'Учётный источник отвечает, результат передан бухгалтерии' : 'Проверка прошла успешно',
      Влияние: object.id === 'ADM-SCAN-01' ? 'Складская приемка видит устройство готовым' : 'Рабочая зона может повторить действие',
      Восстановление: 'Выполнено',
    },
    'admin'
  );
  return {
    ...nextObject,
    statusLabel: nextStatus,
    severity: 'info' as const,
    filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия'])).filter(
      (tag) => tag !== 'С проблемами' && tag !== 'Офлайн' && tag !== 'Не привязано'
    ),
    actions: [
      { id: `admin-history:${object.id}`, label: 'Открыть историю', level: 'recommended' as const, enabled: true, actionIntent: 'inspect' as const },
    ],
    problems: resolvedProblems(object.problems),
    workbench: workbench
      ? {
          ...workbench,
          prompt: `${actionLabel}: проблема закрыта в диагностике.`,
          status: nextStatus,
          deviceStatus: nextStatus,
          lastSeen: stampNow(),
          testResult: nextStatus,
          checks: workbench.checks.map((check) => ({
            ...check,
            value: check.label === 'Учётный источник' ? check.value : nextStatus,
            severity: 'info' as const,
          })),
          parsedRows: updateFactList(workbench.parsedRows, { Статус: nextStatus, Влияние: 'Действие восстановления выполнено' }, 'admin'),
          blockingReason: undefined,
          recovery: undefined,
          now: nextStatus,
          why: 'Действие админа записано в историю.',
          after: 'Профильная роль может повторить свой рабочий шаг; админ не выполнял production action.',
          nextEffect: 'Результат проверки записан в историю; профильная роль может повторить свой рабочий шаг.',
        }
      : object.workbench,
    audit: [
      auditEntryWithValues(object.id, actorLabel, actionLabel, 'Диагностическая проблема закрыта.', {
        reason: object.statusLabel,
        oldValue: object.statusLabel,
        newValue: nextStatus,
        sourceSnapshot: 'диагностика',
      }),
      ...object.audit,
    ],
  };
}

export function delegateAdminDiagnosticObject(object: WorkObject, actorLabel: string, actionLabel = 'Передано владельцу') {
  const workbench = object.workbench?.type === 'admin' ? object.workbench : null;
  const nextObject = withUpdatedSections(
    object,
    {
      Статус: actionLabel,
      'Статус доступа': actionLabel,
      Восстановление: 'Ожидает владельца',
    },
    'admin'
  );

  return {
    ...nextObject,
    statusLabel: actionLabel,
    actions: [
      { id: `admin-history:${object.id}`, label: 'Открыть историю', level: 'recommended' as const, enabled: true, actionIntent: 'inspect' as const },
    ],
    workbench: workbench
      ? {
          ...workbench,
          prompt: `${actionLabel}: владелец получил задачу.`,
          status: actionLabel,
          deviceStatus: actionLabel,
          lastSeen: stampNow(),
          checks: workbench.checks.map((check) => check.label === 'После'
            ? { ...check, value: 'Ожидает владельца', severity: 'info' as const }
            : check),
          parsedRows: updateFactList(workbench.parsedRows, { Статус: actionLabel, Восстановление: 'Ожидает владельца' }, 'admin'),
          now: actionLabel,
          why: workbench.blockingReason ?? workbench.why,
          after: 'Проблема не закрыта; следующий шаг у владельца.',
          nextEffect: 'Владелец видит задачу, админ не подменяет рабочий результат.',
        }
      : object.workbench,
    audit: [
      auditEntryWithValues(object.id, actorLabel, actionLabel, 'Задача передана владельцу без закрытия диагностической проблемы.', {
        reason: object.statusLabel,
        oldValue: object.statusLabel,
        newValue: actionLabel,
        sourceSnapshot: 'диагностика',
      }),
      ...object.audit,
    ],
  };
}

export function recordAdminDiagnosticIssueObject(
  object: WorkObject,
  actorLabel: string,
  params: {
    status: string;
    result: string;
    recovery: string;
    ownerActionLabel?: string;
    repeatActionId?: string;
    repeatActionLabel?: string;
  }
) {
  const workbench = object.workbench?.type === 'admin' ? object.workbench : null;
  const entityType = workbench?.entityType;
  const nextObject = withUpdatedSections(
    object,
    {
      Статус: params.status,
      [entityType === 'source' ? 'Ошибка источника' : 'Ошибка устройства']: params.result,
      'Система поняла': params.result,
      Восстановление: params.recovery,
    },
    'admin'
  );
  const severity = object.severity === 'info' ? 'warning' as const : object.severity;
  const ownerAction = params.ownerActionLabel ?? 'Передать владельцу';
  const openProblems = object.problems.length > 0
    ? object.problems.map((problem) => ({
        ...problem,
        status: 'open' as const,
        title: params.status,
        reason: params.result,
        recovery: params.recovery,
      }))
    : [];

  return {
    ...nextObject,
    statusLabel: params.status,
    severity,
    filterTags: Array.from(new Set([...(object.filterTags ?? []), 'Требуют действия', 'С проблемами'])).filter(
      (tag) => tag !== 'Завершены'
    ),
    actions: [
      { id: 'admin-forward-owner', label: ownerAction, level: 'recommended' as const, enabled: true, actionIntent: 'mutate' as const },
      ...(params.repeatActionId && params.repeatActionLabel
        ? [{ id: params.repeatActionId, label: params.repeatActionLabel, level: 'secondary' as const, enabled: true, actionIntent: 'mutate' as const }]
        : []),
      { id: `admin-history:${object.id}`, label: 'Открыть историю', level: 'secondary' as const, enabled: true, actionIntent: 'inspect' as const },
    ],
    problems: openProblems,
    workbench: workbench
      ? {
          ...workbench,
          prompt: `${params.status}: ${params.result}.`,
          status: params.status,
          deviceStatus: params.status,
          lastSeen: stampNow(),
          testResult: params.result,
          checks: workbench.checks.map((check) => ({ ...check, value: check.label === 'Контур' ? check.value : params.status, severity })),
          parsedRows: updateFactList(
            workbench.parsedRows,
            { Статус: params.status, Состояние: params.result, Восстановление: params.recovery },
            'admin'
          ),
          blockingReason: params.result,
          recovery: params.recovery,
          now: params.status,
          why: params.result,
          after: params.recovery,
          nextEffect: 'Проблема остается открытой до физической проверки или восстановления владельцем.',
        }
      : object.workbench,
    audit: [
      auditEntryWithValues(object.id, actorLabel, params.status, 'Проверка подтвердила проблему; карточка не закрыта как успешная.', {
        reason: object.statusLabel,
        oldValue: object.statusLabel,
        newValue: params.status,
        sourceSnapshot: params.result,
      }),
      ...object.audit,
    ],
  };
}
