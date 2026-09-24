import type { WorkObjectsByRole } from '../selectors';
import type { ActionDescriptor, AuditEntry, Fact, ProblemCase, WorkObject } from '../types';
import type {
  DeviceMockContract,
  DirectorDecisionRuntime,
  FinanceOrderRuntime,
  KickbackRuntime,
  PaymentTriggerRuntime,
  PenaltyRuntime,
  ProblemCaseRuntime,
  ProductionRuntimeState,
  RuntimeProjectionByRole,
  WarehouseAcceptanceRuntime,
  WarehouseRollRuntime,
} from './types';
import { buildQualityDefectStatsProjection, qualityDefectFacts } from './qualityStats';
import type { QualityDefectStatsProjection } from './types';

function auditFromRuntime(
  objectId: string,
  actionLabel: string,
  detail: string,
  actorLabel = 'Система',
): AuditEntry {
  return {
    id: `a-runtime-${objectId}-${actionLabel}`,
    objectId,
    time: 'сейчас',
    actorLabel,
    actionLabel,
    detail,
  };
}

function problemFromRuntime(problem: ProblemCaseRuntime): ProblemCase {
  return {
    id: problem.id,
    objectId: problem.objectId,
    stage: problem.scope,
    title: problem.title,
    severity: problem.severity,
    ownerRole: problem.ownerRole,
    due: 'до следующего шага',
    reason: problem.reason,
    recovery: problem.recovery,
    status: problem.status,
  };
}

function mergeById(base: WorkObject[], additions: WorkObject[]) {
  const ids = new Set(additions.map((item) => item.id));
  return [...additions, ...base.filter((item) => !ids.has(item.id))];
}

function objectFactValue(object: WorkObject, labels: string[]) {
  for (const label of labels) {
    const direct = object.facts.find((fact) => fact.label === label)?.value;
    if (direct) return direct;
    const nested = object.sections
      .flatMap((section) => section.facts)
      .find((fact) => fact.label === label)?.value;
    if (nested) return nested;
  }
  return undefined;
}

function financeOrderKey(object: WorkObject) {
  return objectFactValue(object, ['Номер', 'Заказ-наряд', 'Заказ']);
}

function severityRank(severity: WorkObject['severity']) {
  if (severity === 'critical') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function moreSevere(
  left: WorkObject['severity'],
  right: WorkObject['severity'],
): WorkObject['severity'] {
  return severityRank(left) <= severityRank(right) ? left : right;
}

function enrichObjectsWithRuntimeProblems(
  objects: WorkObject[],
  runtimeProblems: ProblemCaseRuntime[],
) {
  return objects.map((object) => {
    const additions = runtimeProblems
      .filter((problem) => problem.objectId === object.id)
      .map(problemFromRuntime);
    if (additions.length === 0) return object;
    const existingProblemIds = new Set(object.problems.map((problem) => problem.id));
    const nextProblems = [
      ...additions.filter((problem) => !existingProblemIds.has(problem.id)),
      ...object.problems,
    ];
    const nextSeverity = nextProblems.reduce<WorkObject['severity']>(
      (current, problem) => moreSevere(current, problem.severity),
      object.severity,
    );
    return {
      ...object,
      severity: nextSeverity,
      problems: nextProblems,
      audit: [
        auditFromRuntime(
          object.id,
          'Проблема связана с карточкой',
          'Открытая проблема связана с карточкой директора.',
          'Система',
        ),
        ...object.audit,
      ],
    };
  });
}

function warehouseRollStatusLabel(roll: WarehouseRollRuntime) {
  if (roll.status === 'accepted') return 'Принят';
  if (roll.status === 'duplicate') return 'Дубликат';
  if (roll.status === 'wrong') return 'Чужой QR';
  if (roll.status === 'damaged') return 'Брак';
  if (roll.status === 'blocked_weight') return 'Вес вне допуска';
  if (roll.status === 'delivered') return 'Выдан';
  if (roll.status === 'missing') return 'Не найден';
  return 'Ждет скан';
}

function acceptanceActions(acceptance: WarehouseAcceptanceRuntime): ActionDescriptor[] {
  const hasBlockedWeight = acceptance.rolls.some((roll) => roll.status === 'blocked_weight');
  const allAccepted =
    acceptance.acceptedRollIds.length === acceptance.expectedRollIds.length &&
    acceptance.expectedRollIds.length > 0;
  const scanEnabled = acceptance.status !== 'delivery_ready' && !hasBlockedWeight && !allAccepted;
  const closeLabel = acceptance.status === 'delivery_ready' ? 'Закрыть выдачу' : 'Закрыть приемку';
  return [
    scanEnabled
      ? {
          id: `warehouse.scan:${acceptance.id}`,
          label: 'Сканировать QR',
          level: 'recommended',
          enabled: true,
        }
      : {
          id: `warehouse.scan-disabled:${acceptance.id}`,
          label: 'Сканировать QR',
          level: 'disabled',
          enabled: false,
          disabledReason: hasBlockedWeight
            ? 'Есть рулон с контрольным весом вне допуска'
            : allAccepted
              ? 'Все ожидаемые рулоны приняты'
              : 'Приемка закрыта',
          recoveryOwner: hasBlockedWeight ? 'Зав. производства' : 'Склад',
          recoveryAction: hasBlockedWeight
            ? 'Разобрать проблему веса'
            : `${closeLabel} или открыть историю`,
        },
    allAccepted && !hasBlockedWeight && acceptance.status !== 'delivery_ready'
      ? {
          id: `warehouse.delivery.close:${acceptance.id}`,
          label: closeLabel,
          level: 'recommended',
          enabled: true,
        }
      : {
          id: `warehouse.delivery.close-disabled:${acceptance.id}`,
          label: closeLabel,
          level: 'disabled',
          enabled: false,
          disabledReason: hasBlockedWeight
            ? 'Есть отклонение контрольного веса'
            : 'Не все ожидаемые рулоны приняты',
          recoveryOwner: hasBlockedWeight ? 'Зав. производства' : 'Склад',
          recoveryAction: hasBlockedWeight
            ? 'Разобрать проблемный рулон'
            : 'Сканировать оставшиеся QR',
        },
    {
      id: `warehouse.partial:${acceptance.id}`,
      label: 'Частичная приемка...',
      level: 'secondary',
      enabled: true,
    },
    {
      id: `warehouse.scan_duplicate:${acceptance.id}`,
      label: 'Повторный QR...',
      level: 'secondary',
      enabled: true,
    },
    {
      id: `warehouse.scan_wrong:${acceptance.id}`,
      label: 'Чужой QR...',
      level: 'secondary',
      enabled: true,
    },
    {
      id: `warehouse.problem:${acceptance.id}`,
      label: 'Создать проблему...',
      level: 'secondary',
      enabled: true,
    },
  ];
}

function qualityStatsForObject(
  object: WorkObject,
  stats: QualityDefectStatsProjection,
  scope: Fact['scope'],
) {
  if (scope === 'warehouse') return stats.byAcceptanceId[object.id] ?? stats.summary;
  if (scope === 'production') return stats.byTaskId[object.id] ?? stats.summary;
  return stats.summary;
}

function withQualitySection(
  object: WorkObject,
  stats: QualityDefectStatsProjection,
  scope: Fact['scope'],
): WorkObject {
  const objectStats = qualityStatsForObject(object, stats, scope);
  const facts = qualityDefectFacts(objectStats, scope);
  return {
    ...object,
    sections: [
      {
        id: `${object.id}-quality-defect-stats`,
        title: 'Статистика брака',
        facts,
        scope,
      },
      ...object.sections.filter((section) => section.id !== `${object.id}-quality-defect-stats`),
    ],
    workbench:
      object.workbench?.type === 'warehouse'
        ? { ...object.workbench, qualityStats: facts }
        : object.workbench,
  };
}

function acceptanceToWorkObject(
  acceptance: WarehouseAcceptanceRuntime,
  runtimeProblems: ProblemCaseRuntime[],
  defectStats: QualityDefectStatsProjection,
): WorkObject {
  const problems = runtimeProblems
    .filter((problem) => problem.objectId === acceptance.id)
    .map(problemFromRuntime);
  const acceptanceDefectStats = defectStats.byAcceptanceId[acceptance.id];
  const severity: WorkObject['severity'] = problems.some(
    (problem) => problem.severity === 'critical',
  )
    ? 'critical'
    : acceptance.missingRollIds.length > 0 && acceptance.acceptedRollIds.length > 0
      ? 'warning'
      : 'info';
  const statusLabel =
    acceptance.status === 'delivery_ready'
      ? 'Выдано'
      : acceptance.status === 'accepted'
        ? 'Принято'
        : acceptance.status === 'scan_error'
          ? 'Проблема приемки'
          : 'Готово к приемке';
  const facts: Fact[] = [
    { label: 'Заказ', value: acceptance.orderId, scope: 'warehouse' },
    {
      label: 'Режим',
      value: acceptance.status === 'delivery_ready' ? 'Выдача закрыта' : 'Приемка',
      scope: 'warehouse',
    },
    { label: 'Ожидается', value: String(acceptance.expectedRollIds.length), scope: 'warehouse' },
    { label: 'Принято', value: String(acceptance.acceptedRollIds.length), scope: 'warehouse' },
    { label: 'Последний скан', value: acceptance.lastScan, scope: 'warehouse' },
  ];
  const evidence: Fact[] = acceptance.shiftEvidence
    ? [
        { label: 'Big-bag', value: acceptance.shiftEvidence.bigBagId, scope: 'warehouse' },
        {
          label: 'Старт',
          value: acceptance.shiftEvidence.startKg
            ? `${acceptance.shiftEvidence.startKg} кг`
            : 'не введен',
          scope: 'warehouse',
        },
        {
          label: 'Финал',
          value: acceptance.shiftEvidence.endKg
            ? `${acceptance.shiftEvidence.endKg} кг`
            : 'смена не закрыта',
          scope: 'warehouse',
        },
        {
          label: 'Ожидаемый остаток',
          value: `${acceptance.shiftEvidence.expectedEndKg} кг`,
          scope: 'warehouse',
        },
        { label: 'Оператор', value: acceptance.shiftEvidence.operatorName, scope: 'warehouse' },
        { label: 'Смена', value: acceptance.shiftEvidence.id, scope: 'warehouse' },
        { label: 'Связанные заказы', value: acceptance.orderId, scope: 'warehouse' },
      ]
    : [];

  return {
    id: acceptance.id,
    kind: 'warehouseJob',
    title: `Приемка ${acceptance.id}`,
    statusLabel,
    nextOwner: statusLabel === 'Выдано' ? 'Бухгалтерия' : 'Склад',
    severity,
    filterTags: [
      'Приемка',
      statusLabel,
      severity === 'critical' ? 'С проблемами' : 'Требуют действия',
    ],
    facts,
    sections: [
      {
        id: `${acceptance.id}-scan`,
        title: 'Состояние сканирования',
        facts: [
          { label: 'Ожидается', value: `${acceptance.expectedRollIds.length} рул.` },
          { label: 'Принято', value: `${acceptance.acceptedRollIds.length}` },
          { label: 'Не хватает', value: acceptance.missingRollIds.join(', ') || 'Нет' },
          { label: 'Последний скан', value: acceptance.scanResult ?? acceptance.lastScan },
        ],
      },
    ],
    actions: acceptanceActions(acceptance),
    problems,
    audit: [
      auditFromRuntime(
        acceptance.id,
        'Приемка создана',
        'Строка создана после передачи оператором.',
        'Оператор',
      ),
    ],
    workbench: {
      type: 'warehouse',
      mode: acceptance.status === 'delivery_ready' ? 'delivery' : 'receiving',
      prompt:
        acceptance.status === 'delivery_ready'
          ? 'Выдача закрыта, финансы получили триггер.'
          : 'Сканер готов. Сканируйте ожидаемые QR.',
      expected: acceptance.expectedRollIds.length,
      scanned: acceptance.acceptedRollIds.length,
      missing: acceptance.missingRollIds,
      excess: acceptance.excessPayloads,
      accepted: acceptance.acceptedRollIds,
      lastScan: acceptance.lastScan,
      scanSeverity: severity,
      scanResult: acceptance.scanResult,
      blockingReason: problems[0]?.title,
      recovery: problems[0]?.recovery,
      nextEffect:
        acceptance.status === 'delivery_ready'
          ? 'Финансы получили payment trigger после выдачи.'
          : 'После полного скана можно закрыть выдачу.',
      deviceStatus: [
        { label: 'Сканер', value: 'Готов', severity: 'info' },
        {
          label: 'Счетчик',
          value: `${acceptance.acceptedRollIds.length} / ${acceptance.expectedRollIds.length}`,
          severity,
        },
      ],
      evidence,
      qualityStats: qualityDefectFacts(acceptanceDefectStats ?? defectStats.summary, 'warehouse'),
      expectedRolls: acceptance.rolls.map((roll) => ({
        id: roll.id,
        sequenceNumber: roll.sequenceNumber,
        status: warehouseRollStatusLabel(roll),
        filmType: roll.filmType,
        micron: roll.micron,
        sizeMeters: roll.sizeMeters,
        plannedNetKg: roll.controlWeightKg ?? roll.plannedNetKg,
        tolerancePercent: roll.tolerancePercent,
        qrCode: roll.qrCode,
      })),
    },
  };
}

function paymentTriggerToFinanceObject(trigger: PaymentTriggerRuntime): WorkObject {
  const financeId = `FIN-${trigger.orderId.replace(/^ЗН-/, '')}`;

  return {
    id: financeId,
    kind: 'financeOrder',
    title: `${financeId} · выдача подтверждена`,
    statusLabel: 'Старт рассрочки',
    nextOwner: 'Бухгалтерия',
    severity: 'warning',
    filterTags: ['Финансовые действия', 'Оплаты', 'Требуют действия'],
    facts: [
      { label: 'Заказ', value: trigger.orderId, scope: 'finance' },
      { label: 'Статус счета', value: 'Ждет счет к оплате', scope: 'finance' },
      { label: 'Статус оплаты', value: 'Импортируется из учётного снимка', scope: 'finance' },
      { label: 'Рассрочка', value: 'Со следующих суток после отгрузки', scope: 'finance' },
      { label: 'InstallmentSchedule', value: 'shipment_plus_1_day', scope: 'rawDiagnostics' },
      { label: 'Источник данных', value: 'Закрытая выдача склада', scope: 'finance' },
    ],
    sections: [
      {
        id: `${trigger.triggerId}-payment`,
        title: 'Финансовый триггер',
        facts: [
          { label: 'Выдача', value: trigger.deliveryId, scope: 'finance' },
          {
            label: 'Старт отчета',
            value: trigger.installmentStartsAt ?? 'следующие сутки после отгрузки',
            scope: 'finance',
          },
          { label: 'Действие', value: 'Выставить счет к оплате', scope: 'finance' },
        ],
      },
    ],
    actions: [
      {
        id: `finance-create-invoice:${trigger.orderId}`,
        label: 'Выставить счет',
        level: 'recommended',
        enabled: true,
      },
      {
        id: `finance-history:${trigger.orderId}`,
        label: 'Открыть историю',
        level: 'secondary',
        enabled: true,
      },
    ],
    problems: [],
    audit: [
      auditFromRuntime(
        financeId,
        'audit:installment_schedule_created',
        'Финансовая строка создана: старт рассрочки со следующих суток после отгрузки.',
        'Склад',
      ),
    ],
  };
}

function financeOrderToWorkObject(order: FinanceOrderRuntime): WorkObject {
  const isWaitingPayment =
    order.status === 'waiting_payment' || order.status === 'installment_running';
  const isOverdue = order.status === 'overdue';
  const financeActions: ActionDescriptor[] =
    isWaitingPayment || isOverdue
      ? [
          {
            id: `finance-check-payment:${order.id}`,
            label: 'Проверить оплату',
            level: 'recommended',
            enabled: true,
            helpText: isOverdue
              ? 'Проверяет поступление по просроченному счету; ручное обновление оплаты доступно отдельным действием.'
              : 'Проверяет, есть ли поступление по счету, и не закрывает оплату автоматически.',
          },
          {
            id: `finance-update-payment:${order.id}`,
            label: 'Обновить оплату вручную',
            level: 'secondary',
            enabled: true,
            confirmation: 'Нужны сумма, дата, источник и причина ручного изменения оплаты',
          },
          ...(isOverdue
            ? [
                {
                  id: `finance-create-problem:${order.id}`,
                  label: 'Создать проблему...',
                  level: 'secondary' as const,
                  enabled: true,
                  confirmation: 'Нужна причина просрочки, владелец восстановления и запись в аудит',
                },
              ]
            : []),
          {
            id: `finance-history:${order.id}`,
            label: 'Открыть историю',
            level: 'secondary',
            enabled: true,
          },
        ]
      : [
          {
            id: `finance-create-invoice:${order.id}`,
            label: 'Выставить счет',
            level: 'recommended',
            enabled: true,
          },
          {
            id: `finance-history:${order.id}`,
            label: 'Открыть историю',
            level: 'secondary',
            enabled: true,
          },
        ];
  const amountLabel = order.amountLabel ?? 'сумма уточняется';
  const amountPaidLabel = order.amountPaidLabel ?? 'нет данных';
  const amountRemainingLabel = order.amountRemainingLabel ?? amountLabel;
  const statusLabel = isOverdue
    ? 'Просрочка'
    : isWaitingPayment
      ? order.status === 'installment_running'
        ? 'Рассрочка'
        : 'Ждет оплату'
      : 'Ждет счет';
  return {
    id: order.id,
    kind: 'financeOrder',
    title: `${order.id} · ${order.orderId}`,
    statusLabel,
    nextOwner: isOverdue ? 'Директор' : 'Бухгалтерия',
    severity: isOverdue ? 'critical' : isWaitingPayment ? 'warning' : 'info',
    filterTags: [
      'Финансовые действия',
      isWaitingPayment || isOverdue ? 'Оплаты' : 'Ждут счета',
      isOverdue ? 'Просрочка' : 'Требуют действия',
    ],
    facts: [
      { label: 'Заказ-наряд', value: order.orderId, scope: 'finance' },
      {
        label: 'Заказчик',
        value: order.counterpartyLabel ?? 'Контрагент из заказ-наряда',
        scope: 'legal',
      },
      {
        label: 'Статус счета',
        value: order.status === 'waiting_invoice' ? 'Не выставлен' : 'Счет связан с выдачей',
        scope: 'finance',
      },
      {
        label: 'Статус оплаты',
        value: isOverdue
          ? 'Просрочка оплаты'
          : isWaitingPayment
            ? 'Ждет оплату из учётного снимка'
            : 'Ждет счет',
        scope: 'finance',
      },
      { label: 'Сумма', value: amountLabel, scope: 'sensitiveFinance' },
      { label: 'Оплачено', value: amountPaidLabel, scope: 'sensitiveFinance' },
      { label: 'Остаток', value: amountRemainingLabel, scope: 'sensitiveFinance' },
      {
        label: 'Дата оплаты',
        value: order.dueDateLabel ?? 'не назначена',
        scope: 'sensitiveFinance',
      },
      {
        label: 'Рассрочка',
        value: isOverdue
          ? 'Требует ручного разбора'
          : isWaitingPayment
            ? 'Со следующих суток после отгрузки'
            : 'Старт после выдачи + 1 сутки',
        scope: 'finance',
      },
      {
        label: 'Источник данных',
        value:
          order.source === 'production_approval'
            ? 'Согласованный заказ-наряд'
            : 'учётный снимок / закрытая выдача склада',
        scope: 'finance',
      },
    ],
    sections: [
      {
        id: `${order.id}-runtime`,
        title: 'Финансовое состояние',
        facts: [
          { label: 'Заказ', value: order.orderId, scope: 'finance' },
          { label: 'Сумма', value: amountLabel, scope: 'sensitiveFinance' },
          { label: 'Остаток', value: amountRemainingLabel, scope: 'sensitiveFinance' },
          {
            label: 'Дата оплаты',
            value: order.dueDateLabel ?? 'не назначена',
            scope: 'sensitiveFinance',
          },
          { label: 'Событие срока', value: order.paymentTriggerId ?? 'нет', scope: 'finance' },
        ],
      },
    ],
    actions: financeActions,
    problems: isOverdue
      ? [
          {
            id: `p-${order.id}-overdue`,
            objectId: order.id,
            stage: 'Оплата',
            title: 'Просрочка оплаты',
            severity: 'critical',
            ownerRole: 'Бухгалтерия',
            due: 'сегодня',
            reason: 'Финансовая строка имеет статус просрочки.',
            recovery: 'Проверить поступление или эскалировать директору',
            status: 'open',
          },
        ]
      : [],
    audit: [
      auditFromRuntime(
        order.id,
        order.source === 'production_approval'
          ? 'Заказ-наряд согласован'
          : 'Оплата создана после выдачи',
        'Финансовая строка пришла из текущего состояния прототипа.',
        order.source === 'production_approval' ? 'Производство' : 'Склад',
      ),
    ],
  };
}

function decisionToWorkObject(decision: DirectorDecisionRuntime): WorkObject {
  return {
    id: decision.id,
    kind: 'directorDecision',
    title: decision.summary,
    statusLabel:
      decision.scope === 'penalty'
        ? 'Штрафы'
        : decision.scope === 'warehouse'
          ? 'Склад'
          : 'Решение',
    nextOwner: decision.ownerRole,
    severity: decision.severity,
    filterTags: ['Решения', decision.scope === 'penalty' ? 'Штрафы' : 'Требуют действия'],
    facts: [
      { label: 'Объект', value: decision.objectId, scope: 'director' },
      { label: 'Что решить', value: decision.summary, scope: 'director' },
      { label: 'Доказательство', value: decision.evidence, scope: 'director' },
    ],
    sections: [
      {
        id: `${decision.id}-evidence`,
        title: 'Доказательства',
        facts: [
          { label: 'Контур', value: decision.scope, scope: 'director' },
          { label: 'Статус', value: decision.status, scope: 'director' },
        ],
      },
    ],
    actions:
      decision.status === 'open'
        ? [
            {
              id: `director-confirm-runtime:${decision.id}`,
              label: 'Подтвердить',
              level: 'peer',
              enabled: true,
            },
            {
              id: `director-return-runtime:${decision.id}`,
              label: 'Вернуть',
              level: 'peer',
              enabled: true,
            },
          ]
        : [
            {
              id: `director-history:${decision.id}`,
              label: 'Открыть историю',
              level: 'secondary',
              enabled: true,
            },
          ],
    problems: [],
    audit: [auditFromRuntime(decision.id, 'Решение создано', decision.evidence)],
  };
}

function kickbackStatusLabel(status: KickbackRuntime['status']) {
  if (status === 'confirmed') return 'Подтвержден';
  if (status === 'voided') return 'Аннулирован';
  return 'Черновик';
}

function kickbackToDirectorObject(kickback: KickbackRuntime): WorkObject {
  return {
    id: `DIR-${kickback.id}`,
    kind: 'directorDecision',
    title: `Откат ${kickback.financeOrderId}`,
    statusLabel: 'Финансы',
    nextOwner: 'Директор',
    severity: kickback.status === 'confirmed' ? 'info' : 'warning',
    filterTags: ['Решения', 'Финансы'],
    facts: [
      { label: 'Финансовая строка', value: kickback.financeOrderId, scope: 'sensitiveFinance' },
      { label: 'Сумма', value: kickback.amountLabel, scope: 'sensitiveFinance' },
      {
        label: 'Видимость',
        value:
          kickback.visibility === 'director_only'
            ? 'Только директор'
            : 'Директор + разрешенные финансы',
        scope: 'sensitiveFinance',
      },
    ],
    sections: [
      {
        id: `${kickback.id}-audit`,
        title: 'История закрытого решения',
        scope: 'sensitiveFinance',
        facts: [
          { label: 'Было', value: kickback.oldValue ?? 'нет', scope: 'sensitiveFinance' },
          {
            label: 'Стало',
            value: kickbackStatusLabel(kickback.status),
            scope: 'sensitiveFinance',
          },
        ],
      },
    ],
    actions:
      kickback.status === 'draft'
        ? [
            {
              id: `director-confirm-kickback:${kickback.financeOrderId}`,
              label: 'Подтвердить откат...',
              level: 'peer',
              enabled: true,
            },
          ]
        : [
            {
              id: `director-kickback-history:${kickback.financeOrderId}`,
              label: 'История отката',
              level: 'secondary',
              enabled: true,
              helpText:
                'Откат уже подтвержден или аннулирован; изменение возможно только через новое директорское решение.',
            },
          ],
    problems: [],
    audit: [
      auditFromRuntime(
        `DIR-${kickback.id}`,
        'Откат изменен',
        'Изменение суммы отката записано в закрытую историю.',
        kickback.updatedBy,
      ),
    ],
  };
}

function penaltyToOperatorObject(penalty: PenaltyRuntime): WorkObject {
  return {
    id: `OP-${penalty.penaltyId}`,
    kind: 'operatorTask',
    title: 'Уведомление по разбору',
    statusLabel: 'Уведомление',
    nextOwner: penalty.employeeName,
    severity: 'warning',
    filterTags: ['Уведомления', 'Требуют действия'],
    facts: [
      { label: 'Сотрудник', value: penalty.employeeName, scope: 'operator' },
      { label: 'Причина', value: penalty.reason, scope: 'operator' },
      { label: 'Действие', value: 'Ознакомиться в личном кабинете', scope: 'operator' },
    ],
    sections: [
      {
        id: `${penalty.penaltyId}-notice`,
        title: 'Ограниченное уведомление',
        facts: [
          { label: 'Объект', value: penalty.scopeObjectId, scope: 'operator' },
          {
            label: 'Контекст',
            value: 'Без финансовых и директорских sensitive данных',
            scope: 'operator',
          },
        ],
      },
    ],
    actions: [
      {
        id: `operator-penalty-ack:${penalty.penaltyId}`,
        label: 'Понятно',
        level: 'secondary',
        enabled: true,
      },
    ],
    problems: [],
    audit: [
      auditFromRuntime(
        `OP-${penalty.penaltyId}`,
        'Уведомление отправлено',
        'Оператору показано ограниченное уведомление.',
        'Директор',
      ),
    ],
  };
}

function deviceToAdminObject(device: DeviceMockContract): WorkObject {
  const severity: WorkObject['severity'] =
    device.severity ??
    (device.status === 'error' || device.status === 'offline'
      ? 'critical'
      : device.status === 'unstable'
        ? 'warning'
        : 'info');
  const deviceLabel = deviceDisplayLabel(device);
  const kindLabel = deviceKindLabel(device.kind);
  const isSource = device.kind === 'financeSource';
  const entityType = isSource ? 'source' : 'device';
  const deviceStatusLabel =
    device.status === 'ready'
      ? 'Готово'
      : device.status === 'offline'
        ? 'Офлайн'
        : device.status === 'unstable'
          ? 'Требует проверки'
          : device.status === 'error'
            ? 'Тест не пройден'
            : 'Не требуется';
  const statusLabel =
    device.statusLabel ??
    (isSource
      ? device.status === 'ready' || device.status === 'not_required'
        ? 'Учётный источник отвечает'
        : 'Учётный источник требует проверки'
      : deviceStatusLabel);
  const testActionLabel =
    device.testActionLabel ??
    (isSource ? 'Повторить проверку учётного источника' : 'Проверить устройство');
  const problemTitle = isSource
    ? statusLabel
    : device.status === 'offline'
      ? 'Устройство офлайн'
      : statusLabel;
  return {
    id: `ADM-DEVICE-${device.id}`,
    kind: 'adminEntity',
    title: deviceLabel,
    statusLabel,
    nextOwner: device.ownerRole,
    severity,
    filterTags: [
      isSource ? 'Источники' : 'Устройства',
      severity === 'info' ? 'Завершены' : 'С проблемами',
      statusLabel,
    ],
    facts: [
      { label: isSource ? 'Система' : 'Устройство', value: deviceLabel, scope: 'admin' },
      { label: 'Статус', value: statusLabel, scope: 'admin' },
      ...(device.workplaceId
        ? [
            {
              label: isSource ? 'Контур' : 'Рабочее место',
              value: device.workplaceId,
              scope: 'admin' as const,
            },
          ]
        : []),
    ],
    sections: [
      {
        id: `${device.id}-contract`,
        title: 'Контракт диагностики',
        facts: [
          { label: 'Тип', value: kindLabel, scope: 'admin' },
          { label: 'Ответственный', value: device.ownerRole, scope: 'admin' },
          ...(device.connectionKind
            ? [{ label: 'Подключение', value: device.connectionKind, scope: 'admin' as const }]
            : []),
          ...(device.sourceSystem
            ? [{ label: 'Система', value: device.sourceSystem, scope: 'admin' as const }]
            : []),
          ...(device.notes
            ? [{ label: 'Заметка', value: device.notes, scope: 'admin' as const }]
            : []),
          {
            label: 'Статус контура',
            value: 'диагностика без производственного действия',
            scope: 'admin',
          },
        ],
      },
    ],
    actions: [
      {
        id: `admin.device.tested:${device.id}`,
        label: testActionLabel,
        level: 'recommended',
        enabled: true,
      },
      ...(device.secondaryActions ?? []).map((action) => ({
        id: action.id,
        label: action.label,
        level: action.level ?? 'secondary',
        enabled: true,
      })),
      {
        id: `problem-ADM-DEVICE-${device.id}`,
        label: 'Создать проблему...',
        level: 'secondary',
        enabled: true,
      },
    ],
    problems:
      severity === 'info'
        ? []
        : [
            {
              id: `p-${device.id}`,
              objectId: `ADM-DEVICE-${device.id}`,
              type: isSource ? 'source_sync' : 'device_failure',
              entityKind: isSource ? 'source' : 'admin_device',
              entityId: device.id,
              createdByRole: 'admin',
              targetRole: 'admin',
              sourceActionId: `admin.device.tested:${device.id}`,
              stage: isSource ? 'Учётный источник' : 'Устройство',
              title: problemTitle,
              severity,
              ownerRole: 'Админ',
              due: 'до следующего действия',
              reason: device.parsedPayload,
              recovery: device.recovery,
              status: 'open',
            },
          ],
    audit: [
      auditFromRuntime(
        `ADM-DEVICE-${device.id}`,
        isSource ? 'Учётный снимок загружен' : 'Диагностика устройства загружена',
        'Сырой сигнал и распознанное состояние доступны только админу.',
        'Система',
      ),
    ],
    workbench: {
      type: 'admin',
      entityType,
      prompt: isSource
        ? 'Проверка чтения финансового учётного снимка.'
        : 'Диагностика устройства без выполнения производственного действия.',
      status: statusLabel,
      owner: device.ownerRole,
      now: isSource ? device.parsedPayload : `Устройство: ${statusLabel}.`,
      why: severity === 'info' ? 'Блокеров нет.' : device.parsedPayload,
      after: isSource
        ? 'Бухгалтерия видит финансовый снимок; админ не меняет оплату.'
        : 'Админ записывает диагностику, но не заменяет производственные действия ролей.',
      evidence: [
        { label: 'Последняя связь', value: device.lastSeenAt, scope: 'admin' },
        { label: 'Владелец', value: device.ownerRole, scope: 'admin' },
        ...(device.workplaceId
          ? [
              {
                label: isSource ? 'Контур' : 'Рабочее место',
                value: device.workplaceId,
                scope: 'admin' as const,
              },
            ]
          : []),
        { label: 'Результат', value: device.parsedPayload, scope: 'admin' },
      ],
      deviceStatus: statusLabel,
      lastSeen: device.lastSeenAt,
      testResult: device.parsedPayload,
      checks: [
        { label: 'Контур', value: isSource ? 'Учётные финансы' : 'диагностика', severity: 'info' },
        { label: 'Статус', value: statusLabel, severity },
      ],
      parsedRows: [
        { label: 'Распознано', value: device.parsedPayload, scope: 'admin' },
        ...(device.connectionKind
          ? [{ label: 'Подключение', value: device.connectionKind, scope: 'admin' as const }]
          : []),
        ...(device.notes
          ? [{ label: 'Заметка', value: device.notes, scope: 'admin' as const }]
          : []),
      ],
      rawCollapsedLabel: isSource ? 'Учётный снимок' : 'Диагностика устройства',
      rawRows: [
        {
          label: isSource ? 'Учётный снимок' : 'Служебный сигнал',
          value: device.rawPayload,
          scope: 'rawDiagnostics',
        },
      ],
      blockingReason: severity === 'info' ? undefined : device.parsedPayload,
      recovery: severity === 'info' ? undefined : device.recovery,
      nextEffect: isSource
        ? 'Бухгалтерия видит финансовый снимок; админ не меняет оплату.'
        : 'Админ записывает диагностику, но не заменяет производственные действия ролей.',
    },
  };
}

function deviceDisplayLabel(device: DeviceMockContract) {
  if (device.label) return device.label;
  if (device.kind === 'scale') return 'Весы линии';
  if (device.kind === 'scanner') return 'Сканер склада';
  if (device.kind === 'printer') return 'Принтер этикеток';
  return device.sourceSystem ?? 'Учётный источник';
}

function deviceKindLabel(kind: DeviceMockContract['kind']) {
  if (kind === 'scale') return 'Весы';
  if (kind === 'scanner') return 'Сканер';
  if (kind === 'printer') return 'Принтер';
  return 'Учётный источник: финансы';
}

export function projectRuntimeToWorkObjects(
  runtime: ProductionRuntimeState,
  base: WorkObjectsByRole,
  options: { liveFinance?: boolean } = {},
): RuntimeProjectionByRole {
  const defectStats = buildQualityDefectStatsProjection(runtime);
  const baseWithRuntimeProblems: WorkObjectsByRole = {
    commercial: enrichObjectsWithRuntimeProblems(base.commercial, runtime.problems),
    production: enrichObjectsWithRuntimeProblems(base.production, runtime.problems).map((object) =>
      withQualitySection(object, defectStats, 'production'),
    ),
    operator: enrichObjectsWithRuntimeProblems(base.operator, runtime.problems),
    warehouse: enrichObjectsWithRuntimeProblems(base.warehouse, runtime.problems).map((object) =>
      withQualitySection(object, defectStats, 'warehouse'),
    ),
    finance: enrichObjectsWithRuntimeProblems(base.finance, runtime.problems),
    director: enrichObjectsWithRuntimeProblems(base.director, runtime.problems).map((object) =>
      withQualitySection(object, defectStats, 'director'),
    ),
    admin: enrichObjectsWithRuntimeProblems(base.admin, runtime.problems),
  };
  const warehouseObjects = runtime.warehouseAcceptances.map((acceptance) =>
    acceptanceToWorkObject(acceptance, runtime.problems, defectStats),
  );
  const existingFinanceOrderKeys = new Set(
    baseWithRuntimeProblems.finance.map(financeOrderKey).filter(Boolean),
  );
  const triggerFinanceObjects = runtime.paymentTriggers
    .map(paymentTriggerToFinanceObject)
    .filter((object) => {
      const key = financeOrderKey(object);
      return !key || !existingFinanceOrderKeys.has(key);
    });
  const financeOrderObjects = runtime.financeOrders
    .map(financeOrderToWorkObject)
    .filter((object) => {
      const key = financeOrderKey(object);
      return !key || !existingFinanceOrderKeys.has(key);
    });
  const directorObjects = [
    ...runtime.directorDecisions.map(decisionToWorkObject),
    ...runtime.kickbacks.map(kickbackToDirectorObject),
  ];
  const operatorObjects = runtime.penalties
    .filter((penalty) => penalty.targetRole === 'operator')
    .map(penaltyToOperatorObject);
  const adminBaseObjects = baseWithRuntimeProblems.admin.filter((object) => {
    if (object.id === 'ADM-HISTORY-01') return true;
    const entityType = object.workbench?.type === 'admin' ? object.workbench.entityType : undefined;
    return entityType !== 'device' && entityType !== 'source';
  });
  const adminObjects = runtime.devices.map(deviceToAdminObject);

  return {
    ...baseWithRuntimeProblems,
    warehouse: mergeById(baseWithRuntimeProblems.warehouse, warehouseObjects),
    // При живом финансовом контуре демо-объекты рантайма не подмешиваются:
    // их id нет в backend, и действия по ним падали бы 404.
    finance: options.liveFinance
      ? baseWithRuntimeProblems.finance
      : mergeById(baseWithRuntimeProblems.finance, [
          ...triggerFinanceObjects,
          ...financeOrderObjects,
        ]),
    director: mergeById(baseWithRuntimeProblems.director, directorObjects),
    production: baseWithRuntimeProblems.production,
    operator: mergeById(baseWithRuntimeProblems.operator, operatorObjects),
    admin: mergeById(adminBaseObjects, adminObjects),
  };
}
