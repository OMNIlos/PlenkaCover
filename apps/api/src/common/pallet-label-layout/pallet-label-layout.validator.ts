import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import {
  PALLET_LABEL_LAYOUT_BLOCK_IDS,
  PALLET_LABEL_LAYOUT_DEFINITION_MAX_BYTES,
  PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
  PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS,
  type PalletLabelLayoutBlockId,
  type PalletLabelLayoutBlockKind,
  type PalletLabelLayoutDefinition,
  type PalletLabelLayoutDefinitionV1,
  type PalletLabelLayoutDefinitionV2,
  type PalletLabelLayoutEditorDiagnostics,
  type PalletLabelLayoutElementV1,
  type PalletLabelLayoutElementV2,
  type PalletLabelLayoutLegacyBlockId,
  type PalletLabelLayoutPersistedBlockId,
  type PalletLabelLayoutPublication,
} from '@plenka/contracts';

export const PALLET_LABEL_LAYOUT_CANVAS = {
  widthDots: 800,
  heightDots: 800,
  dotsPerMm: 8,
  safeInsetDots: 20,
  provenCutYDots: 570,
} as const;

/** Immutable schema V1 baseline. Runtime history and reprints may still reference it. */
export const LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT: PalletLabelLayoutDefinitionV1 = {
  schemaVersion: 1,
  profile: PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
  elements: [
    {
      id: 'header',
      kind: 'text',
      xDots: 36,
      yDots: 32,
      widthDots: 728,
      heightDots: 48,
      maxFontSize: 34,
      minFontSize: 22,
      locked: false,
    },
    {
      id: 'identity',
      kind: 'text',
      xDots: 36,
      yDots: 92,
      widthDots: 390,
      heightDots: 74,
      maxFontSize: 22,
      minFontSize: 12,
      locked: false,
    },
    {
      id: 'product',
      kind: 'text',
      xDots: 36,
      yDots: 170,
      widthDots: 390,
      heightDots: 140,
      maxFontSize: 23,
      minFontSize: 12,
      locked: false,
    },
    {
      id: 'rollCodes',
      kind: 'list',
      xDots: 36,
      yDots: 320,
      widthDots: 390,
      heightDots: 236,
      maxFontSize: 16,
      minFontSize: 9,
      locked: false,
    },
    {
      id: 'qr',
      kind: 'qr',
      xDots: 449,
      yDots: 92,
      widthDots: 315,
      heightDots: 315,
      maxFontSize: 0,
      minFontSize: 0,
      locked: true,
    },
    {
      id: 'summary',
      kind: 'text',
      xDots: 449,
      yDots: 415,
      widthDots: 315,
      heightDots: 141,
      maxFontSize: 15,
      minFontSize: 8,
      locked: false,
    },
    {
      id: 'packaging',
      kind: 'text',
      xDots: 36,
      yDots: 594,
      widthDots: 728,
      heightDots: 28,
      maxFontSize: 15,
      minFontSize: 11,
      locked: false,
    },
    {
      id: 'storage',
      kind: 'text',
      xDots: 36,
      yDots: 628,
      widthDots: 728,
      heightDots: 128,
      maxFontSize: 14,
      minFontSize: 11,
      locked: false,
    },
  ],
};

/** The only baseline offered for new drafts and publications. */
export const PUBLISHED_PALLET_LABEL_LAYOUT: PalletLabelLayoutDefinitionV2 = {
  schemaVersion: 2,
  profile: PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
  elements: [
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
      xDots: 449,
      yDots: 36,
      widthDots: 315,
      heightDots: 315,
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
  ],
};

for (const layout of [LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT, PUBLISHED_PALLET_LABEL_LAYOUT]) {
  for (const element of layout.elements) Object.freeze(element);
  Object.freeze(layout.elements);
  Object.freeze(layout);
}

const LEGACY_EXPECTED_KINDS: Readonly<
  Record<PalletLabelLayoutLegacyBlockId, PalletLabelLayoutBlockKind>
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

const EXPECTED_KINDS: Readonly<Record<PalletLabelLayoutBlockId, 'text' | 'qr'>> = {
  order: 'text',
  customer: 'text',
  formedAt: 'text',
  rollCount: 'text',
  qr: 'qr',
  storage: 'text',
};

const TOP_LEVEL_KEYS = ['elements', 'profile', 'schemaVersion'] as const;
const ELEMENT_KEYS = [
  'heightDots',
  'id',
  'kind',
  'locked',
  'maxFontSize',
  'minFontSize',
  'widthDots',
  'xDots',
  'yDots',
] as const;

type PersistedElement = PalletLabelLayoutElementV1 | PalletLabelLayoutElementV2;
type InternalDiagnostics = {
  belowProvenCut: PalletLabelLayoutPersistedBlockId[];
  outsideSafeArea: PalletLabelLayoutPersistedBlockId[];
  overlaps: Array<{
    first: PalletLabelLayoutPersistedBlockId;
    second: PalletLabelLayoutPersistedBlockId;
  }>;
};

function invalid(message: string): never {
  throw new BadRequestException({
    code: 'PALLET_LABEL_LAYOUT_INVALID',
    message,
  });
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${location} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], location: string) {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    invalid(`${location} has unknown or missing fields.`);
  }
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalid(`${field} must be an integer.`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean.`);
  return value;
}

function canonicalQr(layout: PalletLabelLayoutDefinition): PersistedElement {
  return layout.elements.find((element) => element.id === 'qr')!;
}

function parseElement(
  value: unknown,
  index: number,
  allowedIds: readonly string[],
  expectedKinds: Readonly<Record<string, PalletLabelLayoutBlockKind>>,
  immutableQr: PersistedElement,
): PersistedElement {
  const location = `layout.elements[${index}]`;
  const record = asRecord(value, location);
  exactKeys(record, ELEMENT_KEYS, location);

  if (typeof record.id !== 'string' || !allowedIds.includes(record.id)) {
    invalid(`${location}.id is not supported.`);
  }
  if (record.kind !== expectedKinds[record.id]) {
    invalid(`${location}.kind does not match ${record.id}.`);
  }

  const element = {
    id: record.id,
    kind: record.kind,
    xDots: integer(record.xDots, `${location}.xDots`),
    yDots: integer(record.yDots, `${location}.yDots`),
    widthDots: integer(record.widthDots, `${location}.widthDots`),
    heightDots: integer(record.heightDots, `${location}.heightDots`),
    maxFontSize: integer(record.maxFontSize, `${location}.maxFontSize`),
    minFontSize: integer(record.minFontSize, `${location}.minFontSize`),
    locked: boolean(record.locked, `${location}.locked`),
  } as PersistedElement;

  if (element.xDots < 0 || element.yDots < 0) invalid(`${location} starts outside the canvas.`);
  if (element.widthDots <= 0 || element.heightDots <= 0) {
    invalid(`${location} must have a positive size.`);
  }
  if (
    element.xDots + element.widthDots > PALLET_LABEL_LAYOUT_CANVAS.widthDots ||
    element.yDots + element.heightDots > PALLET_LABEL_LAYOUT_CANVAS.heightDots
  ) {
    invalid(`${location} extends outside the canvas.`);
  }

  if (element.id === 'qr') {
    if (ELEMENT_KEYS.some((key) => element[key] !== immutableQr[key])) {
      invalid('The QR block is immutable in draft previews.');
    }
  } else {
    if (element.locked) invalid(`${location}.locked must be false for editable blocks.`);
    if (
      element.minFontSize < 6 ||
      element.maxFontSize > 96 ||
      element.maxFontSize < element.minFontSize
    ) {
      invalid(`${location} has an invalid font range.`);
    }
  }

  return element;
}

function parseEnvelope(value: unknown, schemaVersion: 1 | 2): Record<string, unknown> {
  const record = asRecord(value, 'layout');
  exactKeys(record, TOP_LEVEL_KEYS, 'layout');
  if (record.schemaVersion !== schemaVersion) {
    invalid(`layout.schemaVersion must be ${schemaVersion}.`);
  }
  if (record.profile !== PALLET_LABEL_LAYOUT_EDITOR_PROFILE) {
    invalid(`layout.profile must be ${PALLET_LABEL_LAYOUT_EDITOR_PROFILE}.`);
  }
  if (!Array.isArray(record.elements)) invalid('layout.elements must be an array.');
  return record;
}

function parseLegacyLayout(value: unknown): PalletLabelLayoutDefinitionV1 {
  const record = parseEnvelope(value, 1);
  const parsed = (record.elements as unknown[]).map((element, index) =>
    parseElement(
      element,
      index,
      PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS,
      LEGACY_EXPECTED_KINDS,
      canonicalQr(LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT),
    ),
  ) as PalletLabelLayoutElementV1[];
  const byId = new Map(parsed.map((element) => [element.id, element]));
  if (
    parsed.length !== PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS.length ||
    byId.size !== parsed.length ||
    PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS.some((id) => !byId.has(id))
  ) {
    invalid('Schema V1 must contain every historical block exactly once.');
  }

  return {
    schemaVersion: 1,
    profile: PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
    elements: PALLET_LABEL_LAYOUT_LEGACY_BLOCK_IDS.map((id) => byId.get(id)!),
  };
}

function parseV2Layout(value: unknown): PalletLabelLayoutDefinitionV2 {
  const record = parseEnvelope(value, 2);
  const parsed = (record.elements as unknown[]).map((element, index) =>
    parseElement(
      element,
      index,
      PALLET_LABEL_LAYOUT_BLOCK_IDS,
      EXPECTED_KINDS,
      canonicalQr(PUBLISHED_PALLET_LABEL_LAYOUT),
    ),
  ) as PalletLabelLayoutElementV2[];
  const byId = new Map(parsed.map((element) => [element.id, element]));

  if (byId.size !== parsed.length) {
    invalid('Every schema V2 system block may appear at most once.');
  }
  if (!byId.has('qr')) invalid('Schema V2 must contain the QR block exactly once.');

  return {
    schemaVersion: 2,
    profile: PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
    elements: PALLET_LABEL_LAYOUT_BLOCK_IDS.flatMap((id) => {
      const element = byId.get(id);
      return element ? [element] : [];
    }),
  };
}

function rectanglesOverlap(left: PersistedElement, right: PersistedElement) {
  return (
    left.xDots < right.xDots + right.widthDots &&
    left.xDots + left.widthDots > right.xDots &&
    left.yDots < right.yDots + right.heightDots &&
    left.yDots + left.heightDots > right.yDots
  );
}

function diagnose(elements: PersistedElement[]): InternalDiagnostics {
  const safeMin = PALLET_LABEL_LAYOUT_CANVAS.safeInsetDots;
  const safeMaxX = PALLET_LABEL_LAYOUT_CANVAS.widthDots - safeMin;
  const safeMaxY = PALLET_LABEL_LAYOUT_CANVAS.heightDots - safeMin;
  const diagnostics: InternalDiagnostics = {
    belowProvenCut: elements
      .filter(
        (element) => element.yDots + element.heightDots > PALLET_LABEL_LAYOUT_CANVAS.provenCutYDots,
      )
      .map((element) => element.id),
    outsideSafeArea: elements
      .filter(
        (element) =>
          element.xDots < safeMin ||
          element.yDots < safeMin ||
          element.xDots + element.widthDots > safeMaxX ||
          element.yDots + element.heightDots > safeMaxY,
      )
      .map((element) => element.id),
    overlaps: [],
  };

  for (let first = 0; first < elements.length; first += 1) {
    for (let second = first + 1; second < elements.length; second += 1) {
      if (rectanglesOverlap(elements[first], elements[second])) {
        diagnostics.overlaps.push({ first: elements[first].id, second: elements[second].id });
      }
    }
  }
  return diagnostics;
}

export function parsePalletLabelLayout(value: unknown): {
  layout: PalletLabelLayoutDefinitionV2;
  diagnostics: PalletLabelLayoutEditorDiagnostics;
} {
  const layout = parseV2Layout(value);
  return {
    layout,
    diagnostics: diagnose(layout.elements) as PalletLabelLayoutEditorDiagnostics,
  };
}

export const parsePalletLabelLayoutDraft = parsePalletLabelLayout;

export function validatePalletLabelLayout(value: unknown): PalletLabelLayoutEditorDiagnostics {
  return parsePalletLabelLayout(value).diagnostics;
}

function assertSerializedSize(value: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid('layout must be JSON serializable.');
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, 'utf8') > PALLET_LABEL_LAYOUT_DEFINITION_MAX_BYTES
  ) {
    invalid(`layout exceeds ${PALLET_LABEL_LAYOUT_DEFINITION_MAX_BYTES} bytes.`);
  }
}

function assertSafePublicationGeometry<T extends PalletLabelLayoutDefinition>(
  layout: T,
  diagnostics: InternalDiagnostics,
  allowedBelowCut: ReadonlySet<PalletLabelLayoutPersistedBlockId> = new Set(),
): T {
  const criticalBelowCut = diagnostics.belowProvenCut.filter(
    (blockId) => !allowedBelowCut.has(blockId),
  );
  if (
    diagnostics.outsideSafeArea.length > 0 ||
    diagnostics.overlaps.length > 0 ||
    criticalBelowCut.length > 0
  ) {
    throw new BadRequestException({
      code: 'PALLET_LABEL_LAYOUT_NOT_PUBLISHABLE',
      message: 'Layout has unsafe geometry and cannot be published.',
      diagnostics,
    });
  }
  return layout;
}

const LEGACY_LOWER_STRIP_BLOCKS = new Set<PalletLabelLayoutPersistedBlockId>([
  'packaging',
  'storage',
]);

export function parsePersistedPalletLabelLayout(value: unknown): PalletLabelLayoutDefinition {
  assertSerializedSize(value);
  const record = asRecord(value, 'layout');
  if (record.schemaVersion === 1) {
    const layout = parseLegacyLayout(value);
    return assertSafePublicationGeometry(
      layout,
      diagnose(layout.elements),
      LEGACY_LOWER_STRIP_BLOCKS,
    );
  }
  if (record.schemaVersion === 2) {
    const layout = parseV2Layout(value);
    return assertSafePublicationGeometry(layout, diagnose(layout.elements));
  }
  invalid('layout.schemaVersion must be 1 or 2.');
}

export function assertPalletLabelLayoutPublishable(value: unknown): PalletLabelLayoutDefinitionV2 {
  assertSerializedSize(value);
  const layout = parseV2Layout(value);
  return assertSafePublicationGeometry(layout, diagnose(layout.elements));
}

const PUBLICATION_KEYS = ['activatedAt', 'contentHash', 'id', 'layout', 'version'] as const;

function publicationInvalid(message: string): never {
  throw new BadRequestException({
    code: 'PALLET_LABEL_LAYOUT_PUBLICATION_INVALID',
    message,
  });
}

/** Canonical runtime boundary for persisted publication envelopes and official reprints. */
export function parsePalletLabelLayoutPublication(value: unknown): PalletLabelLayoutPublication {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    publicationInvalid('publication must be an object.');
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...PUBLICATION_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    publicationInvalid('publication has unknown or missing fields.');
  }
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > 200 ||
    record.id.trim() !== record.id
  ) {
    publicationInvalid('publication.id must be a canonical non-empty string.');
  }
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) {
    publicationInvalid('publication.version must be a positive safe integer.');
  }
  if (typeof record.contentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.contentHash)) {
    publicationInvalid('publication.contentHash must be a lowercase SHA-256 hex digest.');
  }
  if (typeof record.activatedAt !== 'string') {
    publicationInvalid('publication.activatedAt must be a canonical ISO timestamp.');
  }
  const activatedAt = new Date(record.activatedAt);
  if (Number.isNaN(activatedAt.getTime()) || activatedAt.toISOString() !== record.activatedAt) {
    publicationInvalid('publication.activatedAt must be a canonical ISO timestamp.');
  }

  const layout = parsePersistedPalletLabelLayout(record.layout);
  const contentHash = createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex');
  if (contentHash !== record.contentHash) {
    publicationInvalid('publication.contentHash does not match the canonical layout.');
  }

  return {
    id: record.id,
    version: record.version as number,
    contentHash: record.contentHash,
    activatedAt: record.activatedAt,
    layout,
  };
}
