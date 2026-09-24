import type { ActionDescriptor, Fact, RoleTemplate, Severity, UserAccessEntry, WorkObject } from '../types';
import { roleTemplates, userAccessEntries } from './access';

type AdminEntityType = NonNullable<WorkObject['workbench']> extends infer T
  ? T extends { type: 'admin'; entityType: infer EntityType }
    ? EntityType
    : never
  : never;

type AdminFixtureInput = {
  id: string;
  entityType: AdminEntityType;
  title: string;
  status: string;
  owner: string;
  severity: Severity;
  filters: string[];
  now: string;
  why: string;
  after: string;
  action: ActionDescriptor;
  secondaryActions?: ActionDescriptor[];
  facts: Fact[];
  parsedRows: Fact[];
  rawRows: Fact[];
  evidence: Fact[];
  problem?: {
    title: string;
    stage: string;
    reason: string;
    recovery: string;
    due: string;
  };
  testResult?: string;
  lastSeen?: string;
  rawCollapsedLabel?: string;
};

function action(id: string, label: string, level: ActionDescriptor['level'] = 'recommended'): ActionDescriptor {
  return { id, label, level, enabled: true };
}

function entityLabel(entityType: AdminEntityType) {
  if (entityType === 'access') return 'Доступы';
  if (entityType === 'roleTemplate') return 'Шаблоны ролей';
  if (entityType === 'source') return 'Источники';
  return 'Устройства';
}

function buildAdminObject(input: AdminFixtureInput): WorkObject {
  const baseFacts: Fact[] = [
    { label: 'Контур', value: entityLabel(input.entityType), scope: 'admin' },
    ...input.facts,
  ];
  const problem = input.problem
    ? {
        id: `p-${input.id}`,
        objectId: input.id,
        stage: input.problem.stage,
        title: input.problem.title,
        severity: input.severity,
        ownerRole: input.owner,
        due: input.problem.due,
        reason: input.problem.reason,
        recovery: input.problem.recovery,
        status: 'open' as const,
      }
    : undefined;

  return {
    id: input.id,
    kind: 'adminEntity',
    title: input.title,
    statusLabel: input.status,
    nextOwner: input.owner,
    severity: input.severity,
    filterTags: Array.from(new Set([entityLabel(input.entityType), ...input.filters, input.severity === 'info' ? 'Завершены' : 'Требуют действия'])),
    facts: baseFacts,
    sections: [
      {
        id: `${input.id}-state`,
        title: 'Состояние',
        facts: [
          { label: 'Сейчас', value: input.now, scope: 'admin' },
          { label: 'Почему', value: input.why, scope: 'admin' },
          { label: 'После', value: input.after, scope: 'admin' },
        ],
      },
    ],
    actions: [input.action, ...(input.secondaryActions ?? []), action(`problem-${input.id}`, 'Создать проблему...', 'secondary'), action(`admin-history:${input.id}`, 'История', 'secondary')],
    problems: problem ? [problem] : [],
    audit: [
      {
        id: `a-${input.id}`,
        objectId: input.id,
        time: input.lastSeen ?? 'сейчас',
        actorLabel: input.owner,
        actionLabel: input.status,
        detail: input.now,
        reason: input.why,
        newValue: input.status,
        sourceSnapshot: input.entityType === 'source' ? 'снимок источника' : undefined,
      },
    ],
    workbench: {
      type: 'admin',
      entityType: input.entityType,
      prompt: input.now,
      status: input.status,
      owner: input.owner,
      now: input.now,
      why: input.why,
      after: input.after,
      evidence: input.evidence,
      deviceStatus: input.entityType === 'device' ? input.status : undefined,
      lastSeen: input.lastSeen ?? 'сейчас',
      testResult: input.testResult ?? input.status,
      checks: [
        { label: 'Сейчас', value: input.now, severity: input.severity },
        { label: 'Почему', value: input.why, severity: input.severity },
        { label: 'После', value: input.after, severity: 'info' },
      ],
      parsedRows: input.parsedRows,
      rawCollapsedLabel: input.rawCollapsedLabel ?? 'Диагностика',
      rawRows: input.rawRows,
      blockingReason: input.problem?.title,
      recovery: input.problem?.recovery,
      nextEffect: input.after,
    },
  };
}

function accessStatusCopy(status: UserAccessEntry['status']) {
  if (status === 'blocked') return 'Отозван';
  return 'Доступ выдан';
}

function accessObject(entry: UserAccessEntry): WorkObject {
  const template = roleTemplates.find((item) => item.id === entry.roleTemplateId);
  const status = accessStatusCopy(entry.status);
  const isBlocked = entry.status === 'blocked';

  return buildAdminObject({
    id: `ADM-USERS-${entry.id}`,
    entityType: 'access',
    title: entry.email,
    status,
    owner: isBlocked ? 'Админ + руководитель роли' : 'Админ',
    severity: isBlocked ? 'warning' : 'info',
    filters: ['Доступы', status],
    now: isBlocked ? 'Доступ отозван, вход не разрешен.' : 'Доступ выдан по email и шаблону роли.',
    why: isBlocked ? 'Доступ остановлен до решения владельца роли.' : 'Email и шаблон роли заданы.',
    after: isBlocked ? 'После передачи владелец роли решает восстановление или оставляет блокировку.' : 'После сохранения изменение попадет в историю доступа.',
    action: isBlocked ? action('admin-forward-owner', 'Передать владельцу') : action('admin-save-user-role', 'Сохранить роль'),
    facts: [
      { label: 'Email', value: entry.email, scope: 'admin' },
      { label: 'Шаблон роли', value: template?.name ?? 'Шаблон роли', scope: 'admin' },
      { label: 'Статус доступа', value: status, scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Проверка', value: isBlocked ? 'Доступ остановлен' : 'Доступ связан с шаблоном роли', scope: 'admin' },
      { label: 'Видимость', value: template ? `${template.visibleSections.length} разделов, скрытых групп: ${template.hiddenScopes.length}` : 'Шаблон не найден', scope: 'admin' },
    ],
    rawRows: [
      { label: 'email', value: entry.email, scope: 'rawDiagnostics' },
      { label: 'role_template_id', value: entry.roleTemplateId, scope: 'rawDiagnostics' },
      { label: 'status', value: entry.status, scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Назначил', value: entry.assignedBy, scope: 'admin' },
      { label: 'Время', value: entry.assignedAt, scope: 'admin' },
      { label: 'Шаблон', value: template?.name ?? 'Шаблон роли', scope: 'admin' },
    ],
    problem: isBlocked
      ? {
          stage: 'Доступ',
          title: 'Доступ заблокирован',
          reason: 'Нужно решение владельца роли перед восстановлением доступа.',
          recovery: 'Передать владельцу роли; админ не входит в рабочий контур сотрудника',
          due: 'до следующего входа сотрудника',
        }
      : undefined,
    lastSeen: entry.assignedAt,
    rawCollapsedLabel: 'Диагностика доступа',
  });
}

function templateObject(template: RoleTemplate): WorkObject {
  const needsSetup = template.setupStatus === 'needs_setup';
  return buildAdminObject({
    id: `ADM-TEMPLATE-${template.role}`,
    entityType: 'roleTemplate',
    title: template.name,
    status: needsSetup ? 'Требует настройки' : 'Шаблон выбран',
    owner: needsSetup ? 'Админ + владелец роли' : 'Админ',
    severity: needsSetup ? 'warning' : 'info',
    filters: ['Шаблоны ролей', needsSetup ? 'Требует настройки' : 'Шаблон выбран'],
    now: needsSetup ? 'Шаблон требует настройки скрытых групп перед назначением.' : 'Шаблон роли выбран и готов к назначению.',
    why: needsSetup ? 'Есть sensitive-группы, которые нужно подтвердить с владельцем роли.' : 'Разделы и скрытые группы уже описаны.',
    after: needsSetup ? 'После настройки шаблон можно назначать без ручной правки доступа.' : 'После сохранения шаблон остается доступным для назначения по email.',
    action: needsSetup ? action('admin-forward-owner', 'Передать владельцу') : action(`admin-template-save-${template.id}`, 'Сохранить шаблон'),
    secondaryActions: needsSetup ? [action(`admin-template-save-${template.id}`, 'Сохранить шаблон', 'secondary')] : undefined,
    facts: [
      { label: 'Шаблон роли', value: template.name, scope: 'admin' },
      { label: 'Разделы', value: template.visibleSections.join(', '), scope: 'admin' },
      { label: 'Скрытые группы', value: template.hiddenScopes.length > 0 ? String(template.hiddenScopes.length) : 'Нет', scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Состояние', value: needsSetup ? 'Требует настройки' : 'Выбран', scope: 'admin' },
      { label: 'Восстановление', value: needsSetup ? 'Подтвердить скрытые группы' : 'Не требуется', scope: 'admin' },
    ],
    rawRows: [
      { label: 'role_template_id', value: template.id, scope: 'rawDiagnostics' },
      { label: 'role', value: template.role, scope: 'rawDiagnostics' },
      { label: 'setup_status', value: template.setupStatus ?? 'ready', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Разделов', value: String(template.visibleSections.length), scope: 'admin' },
      { label: 'Скрытых групп', value: String(template.hiddenScopes.length), scope: 'admin' },
      { label: 'Ответственный', value: needsSetup ? 'Владелец роли' : 'Админ', scope: 'admin' },
    ],
    problem: needsSetup
      ? {
          stage: 'Шаблон роли',
          title: 'Шаблон требует настройки',
          reason: 'Перед назначением нужно подтвердить скрытые группы и владельца восстановления.',
          recovery: 'Передать владельцу роли и сохранить шаблон после подтверждения',
          due: 'до массового назначения',
        }
      : undefined,
    lastSeen: '09:40',
    rawCollapsedLabel: 'Диагностика шаблона',
  });
}

const deviceObjects: WorkObject[] = [
  buildAdminObject({
    id: 'ADM-SCALE-READY',
    entityType: 'device',
    title: 'Весы линии A-01',
    status: 'Готово',
    owner: 'Админ',
    severity: 'info',
    filters: ['Устройства', 'Готово'],
    now: 'Устройство готово к рабочему контуру.',
    why: 'Последняя проверка вернула стабильный ответ.',
    after: 'Рабочая роль может повторить свой шаг, админ не записывает производственный факт.',
    action: action('admin.device.tested:SCALE-A-01', 'Проверить стабильность'),
    facts: [
      { label: 'Устройство', value: 'Весы линии A-01', scope: 'admin' },
      { label: 'Статус', value: 'Готово', scope: 'admin' },
    ],
    parsedRows: [{ label: 'Состояние', value: 'Готово', scope: 'admin' }],
    rawRows: [
      { label: 'device_id', value: 'SCALE-A-01', scope: 'rawDiagnostics' },
      { label: 'status', value: 'ready', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последняя связь', value: '12:22', scope: 'admin' },
      { label: 'Тест', value: 'Стабильный ответ', scope: 'admin' },
    ],
    testResult: 'Стабильный ответ',
    lastSeen: '12:22',
    rawCollapsedLabel: 'Диагностика устройства',
  }),
  buildAdminObject({
    id: 'ADM-SCALE-02',
    entityType: 'device',
    title: 'Весы линии E-04',
    status: 'Офлайн',
    owner: 'Админ',
    severity: 'warning',
    filters: ['Устройства', 'Офлайн'],
    now: 'Устройство офлайн, рабочий шаг ждет восстановления.',
    why: 'Последняя связь не получена после проверки.',
    after: 'После проверки рабочая роль увидит только готовность устройства, без записи веса админом.',
    action: action('admin-check-scale', 'Проверить связь'),
    facts: [
      { label: 'Устройство', value: 'Весы линии E-04', scope: 'admin' },
      { label: 'Статус', value: 'Офлайн', scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Состояние', value: 'Офлайн', scope: 'admin' },
      { label: 'Влияние', value: 'Рабочий шаг веса ожидает устройство', scope: 'admin' },
    ],
    rawRows: [
      { label: 'device_id', value: 'E-04', scope: 'rawDiagnostics' },
      { label: 'last_signal', value: 'empty', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последняя связь', value: '11:48', scope: 'admin' },
      { label: 'Владелец', value: 'Админ', scope: 'admin' },
    ],
    problem: {
      stage: 'Устройство',
      title: 'Устройство офлайн',
      reason: 'Нужно восстановить связь до повторного рабочего шага.',
      recovery: 'Проверить питание, кабель/USB или Ethernet; передать админу смены до повторного взвешивания',
      due: 'до повторного рабочего шага',
    },
    testResult: 'Нет ответа',
    lastSeen: '11:48',
    rawCollapsedLabel: 'Диагностика устройства',
  }),
  buildAdminObject({
    id: 'ADM-SCAN-01',
    entityType: 'device',
    title: 'Сканер склада S-01',
    status: 'Требует настройки',
    owner: 'Админ',
    severity: 'critical',
    filters: ['Устройства', 'Требует настройки'],
    now: 'Устройство требует настройки: есть ответ, нет рабочей привязки.',
    why: 'Контур не понимает, к какому рабочему месту относится проверка.',
    after: 'После привязки склад увидит устройство готовым; админ не выполняет складское действие.',
    action: action('admin-bind-scanner', 'Проверить привязку'),
    facts: [
      { label: 'Устройство', value: 'Сканер склада S-01', scope: 'admin' },
      { label: 'Статус', value: 'Требует настройки', scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Состояние', value: 'Ответ есть, привязки нет', scope: 'admin' },
      { label: 'Влияние', value: 'Рабочее место склада ожидает настройку устройства', scope: 'admin' },
    ],
    rawRows: [
      { label: 'device_id', value: 'S-01', scope: 'rawDiagnostics' },
      { label: 'binding', value: 'empty', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последняя связь', value: '12:05', scope: 'admin' },
      { label: 'Результат', value: 'Ответ есть, привязки нет', scope: 'admin' },
    ],
    problem: {
      stage: 'Устройство',
      title: 'Устройство требует настройки',
      reason: 'Ответ получен, но рабочая зона не назначена.',
      recovery: 'Назначить устройство складскому рабочему месту или передать владельцу склада',
      due: 'до работы через устройство',
    },
    testResult: 'Ответ есть, привязки нет',
    lastSeen: '12:05',
    rawCollapsedLabel: 'Диагностика устройства',
  }),
  buildAdminObject({
    id: 'ADM-PRN-FAIL',
    entityType: 'device',
    title: 'Принтер этикеток P-03',
    status: 'Тест не пройден',
    owner: 'Админ',
    severity: 'warning',
    filters: ['Устройства', 'Тест не пройден'],
    now: 'Последний тест не пройден, очередь печати требует проверки.',
    why: 'Устройство вернуло ошибку источника печати.',
    after: 'После проверки профильная роль увидит доступность печати, но админ не печатает этикетку.',
    action: action('admin.device.tested:printerMock', 'Проверить очередь печати'),
    secondaryActions: [action('admin-forward-owner', 'Передать владельцу', 'secondary')],
    facts: [
      { label: 'Устройство', value: 'Принтер этикеток P-03', scope: 'admin' },
      { label: 'Статус', value: 'Тест не пройден', scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Состояние', value: 'Тест не пройден', scope: 'admin' },
      { label: 'Влияние', value: 'Печать ждет восстановления устройства', scope: 'admin' },
    ],
    rawRows: [
      { label: 'device_id', value: 'P-03', scope: 'rawDiagnostics' },
      { label: 'last_test', value: 'failed', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последняя проверка', value: '12:18', scope: 'admin' },
      { label: 'Владелец', value: 'Админ', scope: 'admin' },
    ],
    problem: {
      stage: 'Устройство',
      title: 'Тест не пройден',
      reason: 'Нужна проверка устройства и очереди источника.',
      recovery: 'Проверить устройство и передать владельцу, если ошибка повторяется',
      due: 'до печати следующей этикетки',
    },
    testResult: 'Тест не пройден',
    lastSeen: '12:18',
    rawCollapsedLabel: 'Диагностика устройства',
  }),
];

const sourceObjects: WorkObject[] = [
  buildAdminObject({
    id: 'ADM-SOURCE-HEALTH-OK',
    entityType: 'source',
    title: 'Учётный источник: оплаты',
    status: 'Учётный источник отвечает',
    owner: 'Бухгалтерия',
    severity: 'info',
    filters: ['Источники', 'Учётный источник отвечает'],
    now: 'Учётные статусы оплат читаются.',
    why: 'Последний учётный снимок по оплатам без ошибки.',
    after: 'Бухгалтерия видит статус оплаты; админ не меняет оплату.',
    action: action('admin-retry-source-health', 'Повторить проверку учётного источника'),
    facts: [
      { label: 'Система', value: 'Учётный источник: оплаты', scope: 'admin' },
      { label: 'Состояние', value: 'Учётный источник отвечает', scope: 'admin' },
    ],
    parsedRows: [{ label: 'Состояние', value: 'Учётные оплаты читаются', scope: 'admin' }],
    rawRows: [
      { label: 'source_id', value: '1c-payment-status', scope: 'rawDiagnostics' },
      { label: 'health', value: 'ok', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последний снимок', value: '12:24', scope: 'admin' },
      { label: 'Владелец', value: 'Бухгалтерия', scope: 'admin' },
    ],
    testResult: 'Учётные оплаты читаются',
    lastSeen: '12:24',
    rawCollapsedLabel: 'Учётный снимок',
  }),
  buildAdminObject({
    id: 'ADM-FIN-SOURCE-01',
    entityType: 'source',
    title: 'Учётный источник: счета',
    status: 'Учётный счет требует проверки',
    owner: 'Админ + Бухгалтерия',
    severity: 'warning',
    filters: ['Источники', 'Учётный счет требует проверки'],
    now: 'Статус учётного счета не подтвержден.',
    why: 'В учётном снимке нет однозначного статуса счета.',
    after: 'Бухгалтерия проверяет счет; админ не меняет оплату.',
    action: action('admin-retry-finance-source', 'Повторить проверку учётного источника'),
    secondaryActions: [action('admin-forward-finance-source', 'Передать бухгалтерии', 'secondary')],
    facts: [
      { label: 'Система', value: 'Учётный источник: счета', scope: 'admin' },
      { label: 'Состояние', value: 'Требует проверки', scope: 'admin' },
    ],
    parsedRows: [
      { label: 'Состояние', value: 'Счет требует проверки', scope: 'admin' },
      { label: 'Влияние', value: 'Бухгалтерия проверяет счет вручную', scope: 'admin' },
    ],
    rawRows: [
      { label: 'source_id', value: '1c-invoice-status', scope: 'rawDiagnostics' },
      { label: 'health', value: 'manual_check', scope: 'rawDiagnostics' },
    ],
    evidence: [
      { label: 'Последний снимок', value: '12:24', scope: 'admin' },
      { label: 'Владелец', value: 'Бухгалтерия', scope: 'admin' },
    ],
    problem: {
      stage: 'Учётный источник',
      title: 'Учётный счет требует проверки',
      reason: 'Учётный снимок требует ручного разбора бухгалтерией.',
      recovery: 'Повторить проверку источника и передать результат бухгалтерии',
      due: 'сегодня',
    },
    testResult: 'Учётный счет требует проверки',
    lastSeen: '12:24',
    rawCollapsedLabel: 'Учётный снимок',
  }),
];

const historyObjectBase = buildAdminObject({
  id: 'ADM-HISTORY-01',
  entityType: 'source',
  title: 'Проблемы / история',
  status: 'История',
  owner: 'Админ',
  severity: 'info',
  filters: ['Проблемы / история', 'История'],
  now: 'История действий доступна ниже первого слоя.',
  why: 'Raw diagnostics и история не должны перекрывать выбранный объект.',
  after: 'Админ видит технические подтверждения, остальные роли не получают служебные данные.',
  action: action('admin-history:ADM-HISTORY-01', 'История'),
  facts: [
    { label: 'Контур', value: 'Проблемы / история', scope: 'admin' },
    { label: 'Состояние', value: 'Collapsed', scope: 'admin' },
  ],
  parsedRows: [{ label: 'Состояние', value: 'История свернута', scope: 'admin' }],
  rawRows: [{ label: 'history_scope', value: 'admin_only', scope: 'rawDiagnostics' }],
  evidence: [
    { label: 'События', value: 'Доступы, устройства, источники', scope: 'admin' },
    { label: 'Видимость', value: 'Только админ', scope: 'admin' },
  ],
  lastSeen: 'сейчас',
  rawCollapsedLabel: 'Диагностика и история',
});

const historyObject: WorkObject = {
  ...historyObjectBase,
  filterTags: Array.from(new Set([...(historyObjectBase.filterTags ?? []).filter((tag) => tag !== 'Завершены' && tag !== 'Источники'), 'Требуют действия'])),
};

export const adminWorkObjects: WorkObject[] = [
  ...sourceObjects.filter((object) => object.severity !== 'info'),
  ...deviceObjects.filter((object) => object.severity !== 'info'),
  ...userAccessEntries.map(accessObject),
  ...roleTemplates.map(templateObject),
  ...deviceObjects.filter((object) => object.severity === 'info'),
  ...sourceObjects.filter((object) => object.severity === 'info'),
  historyObject,
];
