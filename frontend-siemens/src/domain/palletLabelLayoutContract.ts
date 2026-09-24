import {
  LEGACY_PALLET_LABEL_LAYOUT_PROFILE,
  PALLET_LABEL_LAYOUT_PROFILE,
} from './palletListProfiles';

export {
  LEGACY_PALLET_LABEL_LAYOUT_PROFILE,
  PALLET_LABEL_LAYOUT_PROFILE,
} from './palletListProfiles';

export const PALLET_LABEL_LAYOUT_SCHEMA_VERSION = 2 as const;

export const PALLET_LABEL_LAYOUT_ELEMENT_IDS = [
  'order',
  'customer',
  'formedAt',
  'rollCount',
  'qr',
  'storage',
] as const;

export const LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS = [
  'header',
  'identity',
  'product',
  'rollCodes',
  'qr',
  'summary',
  'packaging',
  'storage',
] as const;

export type PalletLabelLayoutElementId = (typeof PALLET_LABEL_LAYOUT_ELEMENT_IDS)[number];
export type LegacyPalletLabelLayoutElementId =
  (typeof LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS)[number];
export type PalletLabelLayoutElementKind = 'text' | 'qr';
export type LegacyPalletLabelLayoutElementKind = 'text' | 'list' | 'qr';

type LayoutElement<TId extends string, TKind extends string> = {
  id: TId;
  kind: TKind;
  xDots: number;
  yDots: number;
  widthDots: number;
  heightDots: number;
  maxFontSize: number;
  minFontSize: number;
  locked: boolean;
};

export type PalletLabelLayoutElement = LayoutElement<
  PalletLabelLayoutElementId,
  PalletLabelLayoutElementKind
>;
export type LegacyPalletLabelLayoutElement = LayoutElement<
  LegacyPalletLabelLayoutElementId,
  LegacyPalletLabelLayoutElementKind
>;

export type PalletLabelLayout = {
  schemaVersion: 2;
  profile: typeof PALLET_LABEL_LAYOUT_PROFILE;
  elements: PalletLabelLayoutElement[];
};

export type LegacyPalletLabelLayout = {
  schemaVersion: 1;
  profile: typeof PALLET_LABEL_LAYOUT_PROFILE;
  elements: LegacyPalletLabelLayoutElement[];
};

export type PersistedPalletLabelLayout = PalletLabelLayout | LegacyPalletLabelLayout;

export type PalletLabelEditorCanvas = {
  widthDots: number;
  heightDots: number;
  dotsPerMm: number;
  safeInsetDots: number;
  provenCutYDots: number;
};

export type PalletLabelEditorSource = {
  documentId: string;
  kind: 'control' | 'document';
  label: string;
  palletId: string;
  createdAt: string;
  rollCount: number;
};

export type PalletLabelLayoutPublication = {
  id: string;
  version: number;
  contentHash: string;
  activatedAt: string;
  layout: PersistedPalletLabelLayout;
};

export type PalletLabelEditorBootstrap = {
  schemaVersion: 2;
  profile: typeof PALLET_LABEL_LAYOUT_PROFILE;
  canvas: PalletLabelEditorCanvas;
  editorLayout: PalletLabelLayout;
  activePublication: PalletLabelLayoutPublication | null;
  sources: PalletLabelEditorSource[];
};

export type PalletLabelLayoutServerDiagnostics = {
  belowProvenCut: PalletLabelLayoutElementId[];
  outsideSafeArea: PalletLabelLayoutElementId[];
  overlaps: Array<{
    first: PalletLabelLayoutElementId;
    second: PalletLabelLayoutElementId;
  }>;
};

const EXPECTED_KIND: Record<PalletLabelLayoutElementId, PalletLabelLayoutElementKind> = {
  order: 'text',
  customer: 'text',
  formedAt: 'text',
  rollCount: 'text',
  qr: 'qr',
  storage: 'text',
};

const LEGACY_EXPECTED_KIND: Record<
  LegacyPalletLabelLayoutElementId,
  LegacyPalletLabelLayoutElementKind
> = {
  header: 'text',
  identity: 'text',
  product: 'text',
  rollCodes: 'list',
  qr: 'qr',
  summary: 'text',
  packaging: 'text',
  storage: 'text',
};

export const LOCKED_PALLET_QR = {
  xDots: 449,
  yDots: 36,
  widthDots: 315,
  heightDots: 315,
} as const;

const BASE_PALLET_LABEL_LAYOUT_ELEMENTS: readonly PalletLabelLayoutElement[] = [
  {
    id: 'order',
    kind: 'text',
    xDots: 36,
    yDots: 36,
    widthDots: 390,
    heightDots: 62,
    maxFontSize: 30,
    minFontSize: 18,
    locked: false,
  },
  {
    id: 'customer',
    kind: 'text',
    xDots: 36,
    yDots: 110,
    widthDots: 390,
    heightDots: 88,
    maxFontSize: 28,
    minFontSize: 16,
    locked: false,
  },
  {
    id: 'formedAt',
    kind: 'text',
    xDots: 36,
    yDots: 210,
    widthDots: 390,
    heightDots: 62,
    maxFontSize: 24,
    minFontSize: 14,
    locked: false,
  },
  {
    id: 'rollCount',
    kind: 'text',
    xDots: 36,
    yDots: 284,
    widthDots: 390,
    heightDots: 62,
    maxFontSize: 30,
    minFontSize: 18,
    locked: false,
  },
  {
    id: 'qr',
    kind: 'qr',
    ...LOCKED_PALLET_QR,
    maxFontSize: 0,
    minFontSize: 0,
    locked: true,
  },
  {
    id: 'storage',
    kind: 'text',
    xDots: 36,
    yDots: 380,
    widthDots: 728,
    heightDots: 170,
    maxFontSize: 28,
    minFontSize: 16,
    locked: false,
  },
];

export function createBasePalletLabelLayout(): PalletLabelLayout {
  return {
    schemaVersion: PALLET_LABEL_LAYOUT_SCHEMA_VERSION,
    profile: PALLET_LABEL_LAYOUT_PROFILE,
    elements: BASE_PALLET_LABEL_LAYOUT_ELEMENTS.map((element) => ({ ...element })),
  };
}

const LEGACY_LOCKED_PALLET_QR = {
  xDots: 449,
  yDots: 92,
  widthDots: 315,
  heightDots: 315,
} as const;

const CONTENT_HASH = /^[a-f0-9]{64}$/u;
const CANONICAL_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ELEMENT_KEYS = [
  'id',
  'kind',
  'xDots',
  'yDots',
  'widthDots',
  'heightDots',
  'maxFontSize',
  'minFontSize',
  'locked',
] as const;

function sameLayout(left: PersistedPalletLabelLayout, right: PersistedPalletLabelLayout): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finiteInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} должен быть целым числом.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} имеет неверный формат.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
) {
  const actual = Object.keys(input).sort();
  const expected = [...allowedKeys].sort();
  const unknown = actual.find((key) => !expected.includes(key));
  if (unknown) throw new Error(`${label} содержит неизвестное поле «${unknown}».`);
  const missing = expected.find((key) => !actual.includes(key));
  if (missing) throw new Error(`${label} не содержит обязательное поле «${missing}».`);
}

function isElementId(value: unknown): value is PalletLabelLayoutElementId {
  return PALLET_LABEL_LAYOUT_ELEMENT_IDS.includes(value as PalletLabelLayoutElementId);
}

function isLegacyElementId(value: unknown): value is LegacyPalletLabelLayoutElementId {
  return LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS.includes(
    value as LegacyPalletLabelLayoutElementId,
  );
}

function strictIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} имеет неверный формат.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_ISO_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} имеет неверный формат.`);
  }
  return value;
}

function parseGeometry<TId extends string, TKind extends string>(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
  id: TId,
  kind: TKind,
  lockedQr: { xDots: number; yDots: number; widthDots: number; heightDots: number },
): LayoutElement<TId, TKind> {
  const input = record(value, 'Блок макета');
  assertExactKeys(input, ELEMENT_KEYS, 'Блок макета');
  if (input.id !== id || input.kind !== kind || typeof input.locked !== 'boolean') {
    throw new Error(`Блок ${id} имеет неверный тип.`);
  }
  const element: LayoutElement<TId, TKind> = {
    id,
    kind,
    xDots: finiteInteger(input.xDots, 'X'),
    yDots: finiteInteger(input.yDots, 'Y'),
    widthDots: finiteInteger(input.widthDots, 'Ширина'),
    heightDots: finiteInteger(input.heightDots, 'Высота'),
    maxFontSize: finiteInteger(input.maxFontSize, 'Максимальный шрифт'),
    minFontSize: finiteInteger(input.minFontSize, 'Минимальный шрифт'),
    locked: input.locked,
  };

  if (
    element.xDots < 0 ||
    element.yDots < 0 ||
    element.widthDots <= 0 ||
    element.heightDots <= 0 ||
    element.xDots + element.widthDots > canvas.widthDots ||
    element.yDots + element.heightDots > canvas.heightDots
  ) {
    throw new Error(`Блок ${id} выходит за холст.`);
  }
  if (id === 'qr') {
    if (
      !element.locked ||
      element.xDots !== lockedQr.xDots ||
      element.yDots !== lockedQr.yDots ||
      element.widthDots !== lockedQr.widthDots ||
      element.heightDots !== lockedQr.heightDots ||
      element.maxFontSize !== 0 ||
      element.minFontSize !== 0
    ) {
      throw new Error('QR должен оставаться в зафиксированной геометрии.');
    }
  } else {
    if (element.locked) throw new Error(`Блок ${id} не должен быть заблокирован.`);
    if (
      element.minFontSize < 6 ||
      element.maxFontSize > 96 ||
      element.maxFontSize < element.minFontSize
    ) {
      throw new Error(`Размер шрифта блока ${id} некорректен.`);
    }
  }
  return element;
}

function parseV2Element(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayoutElement {
  const input = record(value, 'Блок макета');
  if (!isElementId(input.id)) throw new Error('Неизвестный блок макета.');
  const id = input.id;
  return parseGeometry(value, canvas, id, EXPECTED_KIND[id], LOCKED_PALLET_QR);
}

function parseLegacyElement(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): LegacyPalletLabelLayoutElement {
  const input = record(value, 'Исторический блок макета');
  if (!isLegacyElementId(input.id)) throw new Error('Неизвестный исторический блок макета.');
  const id = input.id;
  return parseGeometry(value, canvas, id, LEGACY_EXPECTED_KIND[id], LEGACY_LOCKED_PALLET_QR);
}

export function parsePalletLabelLayout(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayout {
  const input = record(value, 'Макет');
  assertExactKeys(input, ['schemaVersion', 'profile', 'elements'], 'Макет');
  if (input.schemaVersion !== PALLET_LABEL_LAYOUT_SCHEMA_VERSION) {
    throw new Error('Версия макета не поддерживается.');
  }
  if (input.profile !== PALLET_LABEL_LAYOUT_PROFILE || !Array.isArray(input.elements)) {
    throw new Error('Профиль или блоки макета не поддерживаются.');
  }
  const elements = input.elements.map((element) => parseV2Element(element, canvas));
  const byId = new Map(elements.map((element) => [element.id, element]));
  if (byId.size !== elements.length) {
    throw new Error('Каждый системный блок допускается только один раз.');
  }
  if (!byId.has('qr')) throw new Error('QR палетного листа обязателен.');

  return {
    schemaVersion: 2,
    profile: PALLET_LABEL_LAYOUT_PROFILE,
    elements: PALLET_LABEL_LAYOUT_ELEMENT_IDS.flatMap((id) => {
      const element = byId.get(id);
      return element ? [element] : [];
    }),
  };
}

function parseLegacyPalletLabelLayout(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): LegacyPalletLabelLayout {
  const input = record(value, 'Исторический макет');
  assertExactKeys(input, ['schemaVersion', 'profile', 'elements'], 'Исторический макет');
  if (
    input.schemaVersion !== 1 ||
    input.profile !== PALLET_LABEL_LAYOUT_PROFILE ||
    !Array.isArray(input.elements)
  ) {
    throw new Error('Историческая версия макета не поддерживается.');
  }
  const elements = input.elements.map((element) => parseLegacyElement(element, canvas));
  const byId = new Map(elements.map((element) => [element.id, element]));
  if (
    elements.length !== LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS.length ||
    byId.size !== elements.length ||
    LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS.some((id) => !byId.has(id))
  ) {
    throw new Error('Исторический макет должен содержать все системные блоки ровно один раз.');
  }
  return {
    schemaVersion: 1,
    profile: PALLET_LABEL_LAYOUT_PROFILE,
    elements: LEGACY_PALLET_LABEL_LAYOUT_ELEMENT_IDS.map((id) => byId.get(id)!),
  };
}

function parsePersistedPalletLabelLayout(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): PersistedPalletLabelLayout {
  const input = record(value, 'Опубликованный макет');
  if (input.schemaVersion === 1) return parseLegacyPalletLabelLayout(value, canvas);
  if (input.schemaVersion === 2) return parsePalletLabelLayout(value, canvas);
  throw new Error('Версия опубликованного макета не поддерживается.');
}

export function parsePalletLabelLayoutPublication(
  value: unknown,
  canvas: PalletLabelEditorCanvas,
): PalletLabelLayoutPublication {
  const input = record(value, 'Публикация макета');
  assertExactKeys(
    input,
    ['id', 'version', 'contentHash', 'activatedAt', 'layout'],
    'Публикация макета',
  );
  const version = finiteInteger(input.version, 'Версия публикации');
  if (version < 1) throw new Error('Версия публикации должна быть положительным целым числом.');
  if (typeof input.contentHash !== 'string' || !CONTENT_HASH.test(input.contentHash)) {
    throw new Error('Хеш публикации имеет неверный формат.');
  }
  return {
    id: strictIdentifier(input.id, 'Идентификатор публикации'),
    version,
    contentHash: input.contentHash,
    activatedAt: canonicalTimestamp(input.activatedAt, 'Дата активации'),
    layout: parsePersistedPalletLabelLayout(input.layout, canvas),
  };
}

export function parsePalletLabelLayoutServerDiagnostics(
  value: unknown,
): PalletLabelLayoutServerDiagnostics {
  const input = record(value, 'Диагностика предпросмотра');
  assertExactKeys(
    input,
    ['belowProvenCut', 'outsideSafeArea', 'overlaps'],
    'Диагностика предпросмотра',
  );
  const parseIds = (items: unknown, label: string) => {
    if (!Array.isArray(items) || !items.every(isElementId)) {
      throw new Error(`${label} имеет неверный формат.`);
    }
    return [...items] as PalletLabelLayoutElementId[];
  };
  if (!Array.isArray(input.overlaps)) throw new Error('Пересечения имеют неверный формат.');
  const overlaps = input.overlaps.map((value) => {
    const overlap = record(value, 'Пересечение');
    assertExactKeys(overlap, ['first', 'second'], 'Пересечение');
    if (!isElementId(overlap.first) || !isElementId(overlap.second)) {
      throw new Error('Пересечение содержит неизвестный блок.');
    }
    return { first: overlap.first, second: overlap.second };
  });
  return {
    belowProvenCut: parseIds(input.belowProvenCut, 'Блоки ниже границы'),
    outsideSafeArea: parseIds(input.outsideSafeArea, 'Блоки вне безопасной зоны'),
    overlaps,
  };
}

function parseCanvas(value: unknown): PalletLabelEditorCanvas {
  const input = record(value, 'Холст');
  assertExactKeys(
    input,
    ['widthDots', 'heightDots', 'dotsPerMm', 'safeInsetDots', 'provenCutYDots'],
    'Холст',
  );
  const canvas = {
    widthDots: finiteInteger(input.widthDots, 'Ширина холста'),
    heightDots: finiteInteger(input.heightDots, 'Высота холста'),
    dotsPerMm: finiteInteger(input.dotsPerMm, 'Точек на миллиметр'),
    safeInsetDots: finiteInteger(input.safeInsetDots, 'Безопасный отступ'),
    provenCutYDots: finiteInteger(input.provenCutYDots, 'Линия гарантированной печати'),
  };
  if (
    canvas.widthDots !== 800 ||
    canvas.heightDots !== 800 ||
    canvas.dotsPerMm !== 8 ||
    canvas.safeInsetDots < 0 ||
    canvas.provenCutYDots <= canvas.safeInsetDots ||
    canvas.provenCutYDots >= canvas.heightDots
  ) {
    throw new Error('Сервер вернул неподдерживаемую геометрию холста.');
  }
  return canvas;
}

function parseSources(value: unknown): PalletLabelEditorSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Сервер не вернул источник для предпросмотра.');
  }
  return value.map((sourceValue, index) => {
    const source = record(sourceValue, 'Источник');
    assertExactKeys(
      source,
      ['documentId', 'kind', 'label', 'palletId', 'createdAt', 'rollCount'],
      'Источник',
    );
    if (source.kind !== 'control' && source.kind !== 'document') {
      throw new Error('Источник предпросмотра имеет неверный формат.');
    }
    const kind: PalletLabelEditorSource['kind'] = source.kind;
    const documentId = strictIdentifier(source.documentId, 'Идентификатор источника');
    const label = strictIdentifier(source.label, 'Название источника');
    const palletId = strictIdentifier(source.palletId, 'Палета источника');
    if (
      (kind === 'control' && label !== 'Контрольный синтетический источник') ||
      (kind === 'document' && label !== `Палетный лист ${palletId}`) ||
      (index === 0 && kind !== 'control') ||
      (index > 0 && kind !== 'document')
    ) {
      throw new Error('Источник предпросмотра имеет небезопасную проекцию.');
    }
    return {
      documentId,
      kind,
      label,
      palletId,
      createdAt: canonicalTimestamp(source.createdAt, 'Дата источника'),
      rollCount: finiteInteger(source.rollCount, 'Количество рулонов'),
    };
  });
}

export function parsePalletLabelEditorBootstrap(value: unknown): PalletLabelEditorBootstrap {
  const input = record(value, 'Ответ редактора');
  const allowedKeys = [
    'schemaVersion',
    'profile',
    'canvas',
    'editorLayout',
    'activePublication',
    'sources',
  ] as const;
  const unknownKey = Object.keys(input).find((key) => !allowedKeys.includes(key as never));
  if (unknownKey) throw new Error(`Ответ редактора содержит неизвестное поле «${unknownKey}».`);
  if (input.schemaVersion !== 2 || input.profile !== PALLET_LABEL_LAYOUT_PROFILE) {
    throw new Error('Сервер вернул несовместимую версию редактора.');
  }
  const canvas = parseCanvas(input.canvas);
  const editorLayout = parsePalletLabelLayout(input.editorLayout, canvas);
  const activePublication =
    input.activePublication === undefined || input.activePublication === null
      ? null
      : parsePalletLabelLayoutPublication(input.activePublication, canvas);
  if (
    activePublication?.layout.schemaVersion === 2 &&
    !sameLayout(editorLayout, activePublication.layout)
  ) {
    throw new Error('Редакторский макет не совпадает с активной V2-публикацией.');
  }
  return {
    schemaVersion: 2,
    profile: PALLET_LABEL_LAYOUT_PROFILE,
    canvas,
    editorLayout,
    activePublication,
    sources: parseSources(input.sources),
  };
}
