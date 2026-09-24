import type {
  CommercialOrderPosition,
  Counterparty,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateVersion,
  CounterpartyOrderTemplateField,
  TemplateDiff,
  WorkObject,
} from './types';
import { rawMaterialStocks } from './inventoryContracts';
import type { IntakeDraftPosition } from './prototypeRuntime';

export type TemplateSortMode = 'recent' | 'popular' | 'name' | 'updated';

export const counterparties: Counterparty[] = [
  {
    id: 'cp-uralpak',
    legalName: 'УралПак',
    alias: 'ООО N1',
    inn: '0268042190',
    kpp: '026801001',
    ogrn: '1020202083500',
    legalAddress: 'РБ, Стерлитамак, адрес требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy: 'Юридическое имя видят коммерция, зав. производства и директор',
    templateIds: ['tpl-uralpak-sleeve-80', 'tpl-uralpak-sleeve-60'],
    installmentTermsSource:
      'Рассрочка: 30 календарных дней после закрытой выдачи · Вид оплаты: безналичный расчет · Источник: стандартные условия клиента',
    contacts: [
      {
        id: 'ct-uralpak-main',
        name: 'Ирина Сафина',
        role: 'Бухгалтерия клиента',
        phone: '+7 917 260-06-14',
        email: 'finance@uralpak.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-paketprom',
    legalName: 'ПакетПром',
    alias: 'ООО N4',
    inn: '0274011180',
    kpp: '027401001',
    ogrn: '1020202551000',
    legalAddress: 'РБ, адрес контрагента требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy: 'Оператор видит alias без юридического имени',
    templateIds: ['tpl-paketprom-milk-60', 'tpl-paketprom-quick'],
    installmentTermsSource:
      'Рассрочка: 14 календарных дней после закрытой выдачи · Вид оплаты: смешанная оплата · Источник: карточка клиента',
    contacts: [
      {
        id: 'ct-paketprom-main',
        name: 'Андрей Ковалев',
        role: 'Снабжение / оплата',
        phone: '+7 917 260-06-19',
        email: 'orders@paketprom.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-severpak',
    legalName: 'СеверПак',
    alias: 'ООО N7',
    inn: '0278123400',
    kpp: '027801001',
    ogrn: '1040203900000',
    legalAddress: 'Юридический адрес будет подтвержден после учётной сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy: 'Sensitive finance видит только директор',
    templateIds: ['tpl-severpak-clear-40'],
    installmentTermsSource:
      'Рассрочка: ручная проверка · Вид оплаты: наличные · Источник: бухгалтерия',
    contacts: [
      {
        id: 'ct-severpak-main',
        name: 'Марина Орлова',
        role: 'Финансовый контакт',
        phone: '+7 917 260-06-21',
        email: 'pay@severpak.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-vektorpack',
    legalName: 'ВекторПак',
    alias: 'ООО N8',
    inn: '0276012400',
    kpp: '027601001',
    ogrn: '1040204100000',
    legalAddress: 'РБ, адрес требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy:
      'Финансы видят реквизиты и контакт, производственные роли видят только безопасное имя',
    templateIds: [],
    installmentTermsSource: 'Рассрочка: по счету · Источник: ручная сверка',
    contacts: [
      {
        id: 'ct-vektorpack-main',
        name: 'Сергей Волков',
        role: 'Оплата счетов',
        phone: '+7 917 260-06-20',
        email: 'billing@vektorpack.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-gammaplenka',
    legalName: 'ГаммаПленка',
    alias: 'ООО N9',
    inn: '0277012300',
    kpp: '027701001',
    ogrn: '1040204200000',
    legalAddress: 'РБ, адрес требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy:
      'Финансы видят контакт и платежные условия; оператор и склад не видят финансовые данные',
    templateIds: [],
    installmentTermsSource:
      'Рассрочка: 30 календарных дней · Вид оплаты: bank · Источник: график платежа',
    contacts: [
      {
        id: 'ct-gammaplenka-main',
        name: 'Елена Морозова',
        role: 'Главный бухгалтер',
        phone: '+7 917 260-06-23',
        email: 'finance@gammaplenka.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-technopak',
    legalName: 'ТехноПак',
    alias: 'ООО N10',
    inn: '0279012300',
    kpp: '027901001',
    ogrn: '1040204300000',
    legalAddress: 'РБ, адрес требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy:
      'Контакт доступен коммерции и финансам; sensitive finance только бухгалтерии/директору',
    templateIds: [],
    installmentTermsSource: 'Рассрочка: по счету · Источник: карточка контрагента',
    contacts: [
      {
        id: 'ct-technopak-main',
        name: 'Ольга Белова',
        role: 'Менеджер закупок',
        phone: '+7 917 260-06-26',
        email: 'orders@technopak.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
  {
    id: 'cp-lentapak',
    legalName: 'ЛентаПак',
    alias: 'ООО N11',
    inn: '0273012300',
    kpp: '027301001',
    ogrn: '1040204400000',
    legalAddress: 'РБ, адрес требует сверки',
    source: 'mock_1C',
    syncStatus: 'needs_discovery',
    visibilityPolicy: 'Финансы видят контакт для ручной проверки источника',
    templateIds: [],
    installmentTermsSource: 'Рассрочка: ручная сверка · Источник: требует проверки',
    contacts: [
      {
        id: 'ct-lentapak-main',
        name: 'Дмитрий Лапин',
        role: 'Контакт по оплате',
        phone: '+7 917 260-06-24',
        email: 'pay@lentapak.example',
        preferred: true,
        source: 'mock_1C',
      },
    ],
  },
];

const templateFields = {
  uralpakSleeve80: [
    field('Позиции', '3 рулона, рукав 80 мкм', 'production'),
    field('Тип пленки', 'Рукав', 'production'),
    field('Толщина', '80 мкм', 'production'),
    field('Цвет', 'Прозрачный с маркировкой', 'production'),
    field('Рулоны', '3 шт. по 41.2 кг', 'production'),
    field('Сырье', 'М1 по шаблону', 'production'),
    field('Втулка', '76 мм', 'production'),
    field('Расходники', 'Скотч, этикетка, упаковка', 'production'),
    field('Условия', 'Счет после согласованного заказ-наряда', 'money'),
    field('Рассрочка', '30 календарных дней после закрытой выдачи', 'money'),
    field('Вид оплаты', 'bank', 'money'),
  ],
  uralpakSleeve60: [
    field('Позиции', '2 рулона, рукав 60 мкм', 'production'),
    field('Тип пленки', 'Рукав', 'production'),
    field('Толщина', '60 мкм', 'production'),
    field('Цвет', 'Молочный', 'production'),
    field('Рулоны', '2 шт., вес уточнить', 'production'),
    field('Сырье', 'М1 по шаблону', 'production'),
    field('Втулка', '76 мм', 'production'),
    field('Расходники', 'Скотч, этикетка', 'production'),
    field('Условия', 'Согласование без решения директора, если нет отличий', 'money'),
    field('Рассрочка', '30 календарных дней после закрытой выдачи', 'money'),
    field('Вид оплаты', 'bank', 'money'),
  ],
  paketpromMilk60: [
    field('Позиции', '2 рулона, молочная пленка', 'production'),
    field('Тип пленки', 'Полотно', 'production'),
    field('Толщина', '60 мкм', 'production'),
    field('Цвет', 'Молочный', 'production'),
    field('Рулоны', '2 шт., 78 кг план', 'production'),
    field('Сырье', 'М1 по шаблону', 'production'),
    field('Втулка', '76 мм', 'production'),
    field('Расходники', 'Скотч, этикетка', 'production'),
    field('Условия', 'Счет после согласованного заказ-наряда', 'money'),
    field('Рассрочка', '14 календарных дней после закрытой выдачи', 'money'),
    field('Вид оплаты', 'mixed', 'money'),
  ],
  paketpromQuick: [
    field('Позиции', '1 рулон, типовой повтор', 'production'),
    field('Тип пленки', 'Повтор клиента', 'production'),
    field('Толщина', '60 мкм', 'production'),
    field('Цвет', 'Молочный', 'production'),
    field('Рулоны', '1 шт., вес по заявке', 'production'),
    field('Сырье', 'М2 допускается', 'production'),
    field('Втулка', '76 мм', 'production'),
    field('Расходники', 'Скотч, этикетка', 'production'),
    field('Условия', 'Разовое применение без изменения текущих заказов', 'money'),
    field('Рассрочка', '30 календарных дней после закрытой выдачи', 'money'),
    field('Вид оплаты', 'unknown до ручной сверки', 'money'),
  ],
  severpakClear40: [
    field('Позиции', '4 рулона, полотно 40 мкм', 'production'),
    field('Тип пленки', 'Полотно', 'production'),
    field('Толщина', '40 мкм', 'production'),
    field('Цвет', 'Прозрачный', 'production'),
    field('Рулоны', '4 шт. по 35 кг', 'production'),
    field('Сырье', 'М1 первичное', 'production'),
    field('Втулка', '76 мм', 'production'),
    field('Расходники', 'Скотч, этикетка', 'production'),
    field('Условия', 'Рассрочка из карточки клиента', 'money'),
    field('Рассрочка', 'manual_review, не менять запущенные заказы без версии', 'money'),
    field('Вид оплаты', 'cash', 'money'),
  ],
};

export const counterpartyTemplates: CounterpartyOrderTemplate[] = [
  template(
    'tpl-uralpak-sleeve-80',
    'cp-uralpak',
    'УралПак · рукав 80 мкм',
    'tplv-uralpak-sleeve-80-v32',
    18,
    'сегодня 10:20',
    '2026-06-08',
  ),
  template(
    'tpl-uralpak-sleeve-60',
    'cp-uralpak',
    'УралПак · рукав 60 мкм',
    'tplv-uralpak-sleeve-60-v28',
    12,
    'вчера 17:12',
    '2026-06-07',
  ),
  template(
    'tpl-paketprom-milk-60',
    'cp-paketprom',
    'ПакетПром · молочная пленка 60',
    'tplv-paketprom-milk-60-v21',
    9,
    'сегодня 09:05',
    '2026-06-08',
  ),
  template(
    'tpl-paketprom-quick',
    'cp-paketprom',
    'ПакетПром · быстрый повтор',
    'tplv-paketprom-quick-v14',
    4,
    '2026-06-05',
    '2026-06-05',
  ),
  template(
    'tpl-severpak-clear-40',
    'cp-severpak',
    'СеверПак · полотно 40 мкм',
    'tplv-severpak-clear-40-v10',
    6,
    '2026-06-04',
    '2026-06-04',
  ),
];

export const counterpartyTemplateVersions: CounterpartyOrderTemplateVersion[] = [
  version(
    'tplv-uralpak-sleeve-80-v32',
    'tpl-uralpak-sleeve-80',
    'v3.2',
    templateFields.uralpakSleeve80,
    'Обновлены расходники после повторного заказа.',
    '2026-06-08',
  ),
  version(
    'tplv-uralpak-sleeve-60-v28',
    'tpl-uralpak-sleeve-60',
    'v2.8',
    templateFields.uralpakSleeve60,
    'Сохранена версия для повторных заказов 60 мкм.',
    '2026-06-07',
  ),
  version(
    'tplv-paketprom-milk-60-v21',
    'tpl-paketprom-milk-60',
    'v2.1',
    templateFields.paketpromMilk60,
    'Уточнен плановый вес по клиенту.',
    '2026-06-08',
  ),
  version(
    'tplv-paketprom-quick-v14',
    'tpl-paketprom-quick',
    'v1.4',
    templateFields.paketpromQuick,
    'Быстрый повтор без изменения запущенных заказов.',
    '2026-06-05',
  ),
  version(
    'tplv-severpak-clear-40-v10',
    'tpl-severpak-clear-40',
    'v1.0',
    templateFields.severpakClear40,
    'Стартовый шаблон клиента.',
    '2026-06-04',
  ),
];

export function counterpartyAlias(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  const counterparty = counterparties.find(
    (item) => item.id === normalized || item.legalName === normalized || item.alias === normalized,
  );
  if (counterparty) return counterparty.alias;
  return /^(ООО N\d+|Клиент\b|В резерв$|Без заказчика$)/u.test(normalized) ? normalized : null;
}

export function counterpartyForObject(object: WorkObject) {
  const name = factValue(object, 'Контрагент') ?? factValue(object, 'Заказчик');
  return counterparties.find((counterparty) => counterparty.legalName === name) ?? null;
}

export function activeVersionForTemplate(
  template: CounterpartyOrderTemplate,
  versions = counterpartyTemplateVersions,
) {
  return versions.find((versionItem) => versionItem.id === template.activeVersionId) ?? null;
}

export function templatesForCounterparty(
  counterpartyId: string,
  templates = counterpartyTemplates,
  includeArchived = false,
) {
  return templates.filter(
    (templateItem) =>
      templateItem.counterpartyId === counterpartyId &&
      (includeArchived || templateItem.status !== 'archived'),
  );
}

export function sortedTemplates(
  templates: CounterpartyOrderTemplate[],
  sortMode: TemplateSortMode,
  query: string,
  versions = counterpartyTemplateVersions,
) {
  const normalized = query.trim().toLowerCase();
  const searched = normalized
    ? templates.filter((templateItem) =>
        templateSearchText(templateItem, versions).includes(normalized),
      )
    : templates;

  return [...searched].sort((first, second) => {
    if (sortMode === 'popular') return second.usageCount - first.usageCount;
    if (sortMode === 'name')
      return templateDisplayName(first, versions).localeCompare(
        templateDisplayName(second, versions),
        'ru',
      );
    if (sortMode === 'updated') return second.updatedAt.localeCompare(first.updatedAt);
    return recentRank(second.lastUsedAt) - recentRank(first.lastUsedAt);
  });
}

export function templateFieldValue(fields: CounterpartyOrderTemplateField[], label: string) {
  return fields.find((fieldItem) => fieldItem.label === label)?.value.trim() ?? '';
}

export function templateNameFromFields(fields: CounterpartyOrderTemplateField[]) {
  const filmType = normalizeTemplateNamePart(templateFieldValue(fields, 'Тип пленки'));
  const thickness = normalizeTemplateNamePart(templateFieldValue(fields, 'Толщина'));
  const color = normalizeTemplateNamePart(templateFieldValue(fields, 'Цвет'));
  const position = normalizeTemplateNamePart(templateFieldValue(fields, 'Позиции'));
  const base = [filmType, thickness].filter(Boolean).join(' ');
  const descriptor = color || position;
  return [base, descriptor].filter(Boolean).join(' · ');
}

export function templateNameFromPositions(positions: readonly IntakeDraftPosition[]) {
  const first = positions[0];
  if (!first) return '';
  const base = [first.filmType.trim(), first.actualThickness.trim()].filter(Boolean).join(' ');
  const descriptor =
    positions.length > 1
      ? `${positions.length} поз.`
      : [first.birka.trim(), first.manualBirka.trim()].filter(Boolean).join(' / ');
  return [base, descriptor].filter(Boolean).join(' · ');
}

export function templateFieldsFromPositions(
  positions: readonly IntakeDraftPosition[],
): CounterpartyOrderTemplateField[] {
  if (positions.length > 1) {
    return [
      field('Позиции', `${positions.length} поз.`, 'production'),
      ...positions.map((position, index) =>
        field(
          `Позиция ${index + 1}`,
          [
            `${position.rollCount} рул.`,
            position.filmType,
            position.actualThickness,
            position.widthMm ? `${position.widthMm} мм` : '',
            position.plannedLengthM ? `${position.plannedLengthM} м` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          'production',
        ),
      ),
    ];
  }
  const position = positions[0];
  if (!position) return [];
  return [
    field('Позиции', `${position.rollCount} рул.`, 'production'),
    field('Тип пленки', position.filmType, 'production'),
    field('Толщина', position.actualThickness, 'production'),
    field('Бухгалтерская толщина', position.accountingThickness, 'production'),
    field('Ширина, мм', position.widthMm, 'production'),
    field('Метраж, м', position.plannedLengthM, 'production'),
    field('План. вес, кг', position.plannedWeightKg, 'production'),
    field('Бирка', position.birka, 'production'),
    field('Ручная бирка', position.manualBirka, 'production'),
    field('Сырье', position.rawMaterial, 'production'),
    field('Шпуля', position.spoolType, 'production'),
    field('Комментарий', position.comment, 'production'),
  ];
}

export function templateDisplayName(
  templateItem: CounterpartyOrderTemplate,
  versions = counterpartyTemplateVersions,
) {
  const versionItem = activeVersionForTemplate(templateItem, versions);
  const generated = versionItem ? templateNameFromFields(versionItem.fields) : '';
  return generated || templateItem.name;
}

export function templateDisplayModel(
  templateItem: CounterpartyOrderTemplate,
  versions = counterpartyTemplateVersions,
  counterparty?: Counterparty | null,
) {
  const versionItem = activeVersionForTemplate(templateItem, versions);
  const fields = versionItem?.fields ?? [];
  const title = templateDisplayName(templateItem, versions);
  const systemName = [counterparty?.legalName, title].filter(Boolean).join(' · ');
  const manualName = counterparty
    ? stripCounterpartyPrefix(templateItem.name, counterparty.legalName)
    : templateItem.name;
  const descriptor = [
    templateFieldValue(fields, 'Позиции') || templateFieldValue(fields, 'Количество позиций'),
    templateFieldValue(fields, 'Сырье'),
    templateFieldValue(fields, 'Втулка'),
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    systemName,
    descriptor,
    manualName: manualName && manualName !== title ? manualName : '',
  };
}

function normalizedTemplateText(value: string | undefined | null) {
  return (value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenMatchScore(
  target: string | undefined | null,
  candidate: string | undefined | null,
  weight: number,
) {
  const normalizedTarget = normalizedTemplateText(target);
  const normalizedCandidate = normalizedTemplateText(candidate);
  if (!normalizedTarget || !normalizedCandidate) return 0;
  if (normalizedCandidate.includes(normalizedTarget)) return weight;
  if (normalizedTarget.includes(normalizedCandidate)) return Math.max(1, weight - 1);
  return 0;
}

function objectTemplateText(object: WorkObject) {
  return [
    factValue(object, 'Шаблон'),
    factValue(object, 'Пленка'),
    factValue(object, 'Характеристики'),
    factValue(object, 'Толщина'),
    factValue(object, 'Цвет'),
    object.statusLabel,
    object.title,
  ]
    .filter(Boolean)
    .join(' ');
}

export type ResolvedOrderTemplate = {
  template: CounterpartyOrderTemplate | null;
  confidence: 'explicit' | 'matched' | 'none';
};

export function resolveOrderTemplateForObject(
  object: WorkObject,
  templates: CounterpartyOrderTemplate[],
  versions = counterpartyTemplateVersions,
  selectedTemplateId?: string,
): ResolvedOrderTemplate {
  const explicit = selectedTemplateId
    ? (templates.find((template) => template.id === selectedTemplateId) ?? null)
    : null;
  if (explicit) return { template: explicit, confidence: 'explicit' };

  const objectTemplate = normalizedTemplateText(factValue(object, 'Шаблон'));
  const objectThickness = factValue(object, 'Толщина');
  const objectFilm =
    factValue(object, 'Пленка') ??
    factValue(object, 'Тип пленки') ??
    factValue(object, 'Характеристики');
  const objectColor =
    factValue(object, 'Цвет') ?? factValue(object, 'Характеристики') ?? object.statusLabel;
  const objectText = objectTemplateText(object);

  const scored = templates
    .map((template) => {
      const versionItem = activeVersionForTemplate(template, versions);
      const fields = versionItem?.fields ?? [];
      const displayName = templateDisplayName(template, versions);
      const templateText = [
        template.name,
        displayName,
        ...fields.map((fieldItem) => `${fieldItem.label} ${fieldItem.value}`),
      ].join(' ');
      const score = [
        tokenMatchScore(
          objectTemplate,
          normalizedTemplateText(`${template.name} ${displayName}`),
          8,
        ),
        tokenMatchScore(objectThickness, templateFieldValue(fields, 'Толщина'), 6),
        tokenMatchScore(objectThickness, templateText, 4),
        tokenMatchScore(objectFilm, templateFieldValue(fields, 'Тип пленки'), 3),
        tokenMatchScore(objectFilm, templateText, 2),
        tokenMatchScore(objectColor, templateFieldValue(fields, 'Цвет'), 2),
        tokenMatchScore(objectText, templateText, 1),
      ].reduce((sum, value) => sum + value, 0);
      return { template, score };
    })
    .sort((first, second) => second.score - first.score);

  const best = scored[0];
  if (!best || best.score < 6) return { template: null, confidence: 'none' };
  return { template: best.template, confidence: 'matched' };
}

export function templateDiffsForObject(
  object: WorkObject,
  template: CounterpartyOrderTemplate,
  role: 'commercial' | 'production',
  versions = counterpartyTemplateVersions,
): TemplateDiff[] {
  const versionItem = activeVersionForTemplate(template, versions);
  if (!versionItem) return [];

  if (role === 'commercial') {
    if (object.id === 'З-2606-017') {
      return [
        {
          label: 'Вес',
          templateValue:
            versionItem.fields.find((fieldItem) => fieldItem.label === 'Рулоны')?.value ??
            'Вес из шаблона клиента',
          currentValue: factValue(object, 'Вес') ?? 'Не указан',
          reason:
            'Коммерция должна заполнить параметры позиции; оператора назначит зав. производства.',
          severity: 'warning',
        },
      ];
    }
    return [
      {
        label: 'Количество',
        templateValue:
          versionItem.fields.find((fieldItem) => fieldItem.label === 'Позиции')?.value ??
          'Типовой повтор',
        currentValue: factValue(object, 'Позиции') ?? 'Из заявки клиента',
        reason: 'Разовое изменение применяется только к текущему заказу.',
        severity: 'info',
      },
    ];
  }

  if (object.id === 'ЗН-2606-014') {
    return [
      {
        label: 'Сырье',
        templateValue:
          versionItem.fields.find((fieldItem) => fieldItem.label === 'Сырье')?.value ??
          'М1 по шаблону',
        currentValue: factValue(object, 'Сырье') ?? 'М2 для оставшихся рулонов',
        reason: 'М1 не хватает на весь заказ; изменение влияет на стоимость.',
        severity: 'warning',
      },
    ];
  }

  if (object.id === 'ЗН-2606-018') {
    return [
      {
        label: 'Причина замены',
        templateValue: 'Причина обязательна при замене сырья',
        currentValue: 'Не указана',
        reason: 'Блокирует согласование заказ-наряда.',
        severity: 'critical',
      },
      {
        label: 'Ответственный',
        templateValue: 'Ответственный из шаблона',
        currentValue: 'Не назначен',
        reason: 'Нужно назначить владельца до передачи дальше.',
        severity: 'critical',
      },
    ];
  }

  if (object.id === 'ЗН-2606-020') {
    const templateThickness = templateFieldValue(versionItem.fields, 'Толщина');
    const objectThickness = factValue(object, 'Толщина');
    if (
      templateThickness &&
      objectThickness &&
      normalizedTemplateText(templateThickness) === normalizedTemplateText(objectThickness)
    )
      return [];
    return [
      {
        label: 'Толщина',
        templateValue: templateThickness || 'По шаблону',
        currentValue: objectThickness ?? 'Не указана',
        reason: 'Выбран другой шаблон клиента. Для текущего заказа нужен шаблон 60 мкм.',
        severity: 'warning',
      },
    ];
  }

  return [];
}

export function positionTemplateDiffsForPosition(
  position: CommercialOrderPosition,
  template: CounterpartyOrderTemplate,
  versions = counterpartyTemplateVersions,
): TemplateDiff[] {
  const versionItem = activeVersionForTemplate(template, versions);
  if (!versionItem) return [];

  return [
    positionDiff(
      'Тип пленки',
      templateFieldValue(versionItem.fields, 'Тип пленки'),
      position.filmType,
      'Тип пленки меняет производственную инструкцию.',
    ),
    positionDiff(
      'Толщина',
      templateFieldValue(versionItem.fields, 'Толщина'),
      position.actualThickness,
      'Толщина влияет на рецептуру и плановый вес.',
    ),
    positionDiff(
      'Рулоны',
      templateFieldValue(versionItem.fields, 'Рулоны'),
      `${position.rollCount} шт.`,
      'Количество рулонов применяется только к этой позиции.',
    ),
    positionDiff(
      'Сырье',
      templateFieldValue(versionItem.fields, 'Сырье'),
      position.rawMaterialLabel,
      'Сырье должно быть подтверждено складом или correction flow.',
    ),
    positionDiff(
      'Шпуля',
      templateFieldValue(versionItem.fields, 'Втулка'),
      position.spoolType,
      'В UI используем термин "Шпуля"; в старых шаблонах поле называется "Втулка".',
    ),
  ].filter((diff): diff is TemplateDiff => Boolean(diff));
}

export function positionPatchFromTemplate(
  position: CommercialOrderPosition,
  template: CounterpartyOrderTemplate,
  versions = counterpartyTemplateVersions,
): CommercialOrderPosition {
  const versionItem = activeVersionForTemplate(template, versions);
  if (!versionItem) return position;

  const filmType = templateFieldValue(versionItem.fields, 'Тип пленки');
  const thickness = templateFieldValue(versionItem.fields, 'Толщина');
  const rawMaterial = templateFieldValue(versionItem.fields, 'Сырье');
  const resolvedStock = resolveRawMaterialStock(rawMaterial);
  const spool = templateFieldValue(versionItem.fields, 'Втулка');
  const rollCount =
    rollCountFromTemplate(templateFieldValue(versionItem.fields, 'Рулоны')) ?? position.rollCount;
  const plannedWeightKg =
    thickness === '80 мкм' ? 41.2 : thickness === '60 мкм' ? 34.5 : (position.plannedWeightKg ?? 0);
  const rawMaterialLabel = resolvedStock?.label ?? position.rawMaterialLabel;
  const rawMaterialId =
    resolvedStock?.rawMaterialId ??
    position.rawMaterials?.[0]?.rawMaterialId ??
    position.rawMaterialId ??
    rawMaterialLabel;
  const totalRecipeQty = Number((plannedWeightKg * rollCount).toFixed(1));
  const primaryQty = Number((totalRecipeQty * 0.98).toFixed(1));
  const additiveQty = Number((totalRecipeQty - primaryQty).toFixed(1));

  return {
    ...position,
    filmType: filmType || position.filmType,
    actualThickness: thickness || position.actualThickness,
    accountingThickness: thickness || position.accountingThickness,
    rawMaterialId,
    rawMaterialLabel,
    spoolType: spool ? normalizeSpoolLabel(spool) : position.spoolType,
    plannedWeightKg,
    rollCount,
    rawMaterials: [
      {
        rawMaterialId,
        label: rawMaterialLabel,
        materialKind: 'raw_material',
        nominalQty: primaryQty,
        unit: resolvedStock?.unit ?? position.rawMaterials?.[0]?.unit ?? 'кг',
        recipeSharePct: 98,
        costReferenceId: rawMaterialId.includes('10803') ? 'MCR-PVD-10803' : 'MCR-PVD-15803',
        accountingSource: 'order_entry',
      },
      {
        rawMaterialId: 'ADD-COLOR-BLUE-01',
        label: 'Добавка · краситель синий 01',
        materialKind: 'additive',
        nominalQty: additiveQty,
        unit: 'кг',
        recipeSharePct: 2,
        costReferenceId: 'MCR-ADD-COLOR-BLUE-01',
        accountingSource: 'order_entry',
      },
    ],
    recipeSnapshot: {
      ...position.recipeSnapshot,
      source: 'template',
      version: versionItem.version,
      parameters: [
        { label: 'Пленка', value: filmType || position.filmType },
        { label: 'Толщина', value: thickness || position.actualThickness },
        { label: 'Сырье', value: rawMaterialLabel },
        { label: 'Шпуля', value: spool ? normalizeSpoolLabel(spool) : position.spoolType },
      ],
    },
  };
}

export function missingRequiredTemplateFields(fields: CounterpartyOrderTemplateField[]) {
  return fields.filter((fieldItem) => {
    if (!fieldItem.required) return false;
    const value = fieldItem.value.trim();
    if (!value) return true;
    const max =
      fieldItem.label === 'Ширина, мм'
        ? 100_000
        : fieldItem.label === 'Метраж, м'
          ? 10_000_000
          : null;
    if (max === null) return false;
    const normalized = value.replace(',', '.');
    if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return true;
    const numeric = Number(normalized);
    return !Number.isFinite(numeric) || numeric <= 0 || numeric > max;
  });
}

function field(
  label: string,
  value: string,
  kind: CounterpartyOrderTemplateField['kind'],
): CounterpartyOrderTemplateField {
  return { label, value, kind, required: true };
}

function template(
  id: string,
  counterpartyId: string,
  name: string,
  activeVersionId: string,
  usageCount: number,
  lastUsedAt: string,
  updatedAt: string,
): CounterpartyOrderTemplate {
  return {
    id,
    counterpartyId,
    name,
    activeVersionId,
    status: 'active',
    ownerRole: 'Зав. производства',
    usageCount,
    lastUsedAt,
    updatedAt,
  };
}

function resolveRawMaterialStock(value?: string) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  return (
    rawMaterialStocks.find((stock) => {
      const label = normalizeText(stock.label);
      const rawId = normalizeText(stock.rawMaterialId);
      return (
        label === normalized ||
        rawId === normalized ||
        label.includes(normalized) ||
        normalized.includes(label)
      );
    }) ?? null
  );
}

function normalizeText(value?: string) {
  return (value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '');
}

function version(
  id: string,
  templateId: string,
  versionLabel: string,
  fields: CounterpartyOrderTemplateField[],
  reason: string,
  createdAt: string,
): CounterpartyOrderTemplateVersion {
  return {
    id,
    templateId,
    version: versionLabel,
    fields,
    reason,
    createdBy: 'Зав. производства',
    createdAt,
    affectsProduction: fields.some((fieldItem) => fieldItem.kind === 'production'),
    affectsMoney: fields.some((fieldItem) => fieldItem.kind === 'money'),
  };
}

function factValue(object: WorkObject, label: string) {
  return (
    object.facts.find((fact) => fact.label === label)?.value ??
    object.sections.flatMap((section) => section.facts).find((fact) => fact.label === label)?.value
  );
}

function templateSearchText(
  templateItem: CounterpartyOrderTemplate,
  versions: CounterpartyOrderTemplateVersion[],
) {
  const versionItem = activeVersionForTemplate(templateItem, versions);
  const counterparty = counterparties.find((item) => item.id === templateItem.counterpartyId);
  const display = templateDisplayModel(templateItem, versions, counterparty);
  return [
    templateItem.name,
    display.title,
    display.systemName,
    display.descriptor,
    display.manualName,
    templateItem.ownerRole,
    versionItem?.version,
    ...(versionItem?.fields.flatMap((fieldItem) => [fieldItem.label, fieldItem.value]) ?? []),
  ]
    .join(' ')
    .toLowerCase();
}

function normalizeTemplateNamePart(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^повтор клиента$/i, 'Повтор')
    .trim();
}

function stripCounterpartyPrefix(value: string, counterpartyName: string) {
  const normalized = value.trim();
  const prefix = `${counterpartyName} ·`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length).trim() : normalized;
}

function positionDiff(
  label: string,
  templateValue: string,
  currentValue: string,
  reason: string,
): TemplateDiff | null {
  if (!templateValue || normalizeComparable(templateValue) === normalizeComparable(currentValue))
    return null;
  return {
    label,
    templateValue,
    currentValue,
    reason,
    severity: ['Толщина', 'Сырье'].includes(label) ? 'warning' : 'info',
  };
}

function rollCountFromTemplate(value: string) {
  const match = value.match(/(\d+)\s*(шт|рулон|рул)/i);
  return match ? Number(match[1]) : undefined;
}

function normalizeSpoolLabel(value: string) {
  const trimmed = value.trim();
  if (/шпул/i.test(trimmed)) return trimmed;
  return `Шпуля ${trimmed}`;
}

function normalizeComparable(value: string) {
  return value
    .replace(/шпуля/gi, '')
    .replace(/втулка/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function recentRank(value: string) {
  if (value.includes('сегодня')) return 400;
  if (value.includes('вчера')) return 300;
  return Number(value.replace(/\D/g, '').slice(0, 8)) || 0;
}
