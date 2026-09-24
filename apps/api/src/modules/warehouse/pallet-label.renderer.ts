import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fontkit from '@pdf-lib/fontkit';
import {
  isPalletScanToken,
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  PALLET_LABEL_PROFILE,
  type PalletLabelLayoutPublication,
  type PalletLabelSnapshotProfile,
  type PalletLabelSnapshot,
} from '@plenka/contracts';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { PALLET_LABEL_ASSETS } from './pallet-label.assets';
import { ConfigurablePalletLabelRenderer } from '../../common/pallet-label-layout/configurable-pallet-label.renderer';
import {
  formatPalletLabelCreatedAt,
  renderPalletLabelSemanticField,
} from '../../common/pallet-label-layout/pallet-label-semantic-field.renderer';
import { parsePalletLabelLayoutPublication } from '../../common/pallet-label-layout/pallet-label-layout.validator';

export const PALLET_LABEL_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 1200 },
  logical: { x: 0, y: 0, width: 1200, height: 800 },
  safe: { x: 40, y: 40, width: 1120, height: 720 },
  frame: { x: 42, y: 42, width: 1116, height: 716 },
  header: { x: 42, y: 42, width: 1116, height: 138 },
  product: { x: 42, y: 180, width: 1116, height: 154 },
  details: { x: 42, y: 334, width: 1116, height: 106 },
  metrics: { x: 42, y: 440, width: 1116, height: 130 },
  certification: { x: 42, y: 570, width: 350, height: 188 },
  storage: { x: 392, y: 570, width: 766, height: 188 },
  qr: { x: 400, y: 574, width: 180, height: 180 },
  storageText: { x: 600, y: 570, width: 558, height: 188 },
} as const;

export const COMPACT_PALLET_LABEL_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 1200 },
  safe: { x: 32, y: 32, width: 370, height: 1136 },
  frame: { x: 34, y: 34, width: 366, height: 1132 },
  header: { x: 34, y: 34, width: 366, height: 36 },
  identity: { x: 34, y: 70, width: 366, height: 190 },
  product: { x: 34, y: 260, width: 366, height: 290 },
  details: { x: 34, y: 550, width: 366, height: 80 },
  storage: { x: 34, y: 630, width: 366, height: 100 },
  metrics: { x: 34, y: 730, width: 366, height: 40 },
  qr: { x: 37, y: 803, width: 360, height: 360 },
  fields: {
    materialMark: { x: 37, y: 70, width: 360, height: 40 },
    palletId: { x: 37, y: 110, width: 360, height: 50 },
    orderNumbers: { x: 37, y: 160, width: 360, height: 30 },
    customerAliases: { x: 37, y: 190, width: 360, height: 60 },
    createdAt: { x: 37, y: 250, width: 360, height: 10 },
    productNames: { x: 37, y: 260, width: 360, height: 290 },
    article: { x: 37, y: 550, width: 360, height: 30 },
    packagingMaterial: { x: 37, y: 580, width: 360, height: 50 },
    storageConditions: { x: 37, y: 630, width: 360, height: 100 },
    packagingCount: { x: 37, y: 730, width: 180, height: 10 },
    rollCount: { x: 217, y: 730, width: 180, height: 10 },
    netKg: { x: 37, y: 740, width: 180, height: 10 },
    grossKg: { x: 217, y: 740, width: 180, height: 10 },
    productionDate: { x: 37, y: 750, width: 180, height: 10 },
    shelfLifeMonths: { x: 217, y: 750, width: 180, height: 10 },
    deliveryDate: { x: 37, y: 760, width: 180, height: 10 },
  },
} as const;

/**
 * The warehouse printer's authoritative USER form is approximately 104.1×101.6 mm at
 * 203 dpi. Square-v4 therefore owns an unrotated 800×800 raster and never passes through
 * the legacy 100×150 device transport.
 */
export const SQUARE_PALLET_LABEL_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 800 },
  safe: { x: 20, y: 20, width: 760, height: 760 },
  frame: { x: 22, y: 22, width: 756, height: 756 },
  header: { x: 36, y: 36, width: 728, height: 54 },
  identity: { x: 36, y: 104, width: 315, height: 118 },
  product: { x: 36, y: 234, width: 315, height: 190 },
  qr: { x: 36, y: 449, width: 315, height: 315 },
  details: { x: 370, y: 104, width: 394, height: 138 },
  rollCodes: { x: 370, y: 254, width: 394, height: 282 },
  storage: { x: 370, y: 548, width: 394, height: 216 },
} as const;

/**
 * Browser-only field profile for the empirically measured Windows warehouse form.
 * All ink stays in the leading 71.25 mm of the 100 mm raster; the trailing 28.75 mm is blank so
 * an early physical gap/cutter cannot remove the QR or the immutable pallet composition.
 */
export const SAFE_PALLET_LABEL_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 800 },
  safe: { x: 20, y: 20, width: 760, height: 550 },
  frame: { x: 22, y: 22, width: 756, height: 546 },
  header: { x: 36, y: 32, width: 728, height: 48 },
  identity: { x: 36, y: 92, width: 390, height: 85 },
  product: { x: 36, y: 170, width: 390, height: 140 },
  rollCodes: { x: 36, y: 320, width: 390, height: 236 },
  qr: { x: 449, y: 92, width: 315, height: 315 },
  summary: { x: 449, y: 415, width: 315, height: 141 },
} as const;

/**
 * Browser-only successor to safe-v5. The scannable/core band is intentionally unchanged
 * through y570, including the empirically accepted QR envelope. Only secondary information
 * uses the remaining physical 100 mm form, with no alternate device/export transport.
 */
export const EXTENDED_PALLET_LABEL_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 800 },
  safe: { x: 20, y: 20, width: 760, height: 760 },
  frame: { x: 22, y: 22, width: 756, height: 756 },
  header: { x: 36, y: 32, width: 728, height: 48 },
  identity: { x: 36, y: 92, width: 390, height: 85 },
  product: { x: 36, y: 170, width: 390, height: 140 },
  rollCodes: { x: 36, y: 320, width: 390, height: 236 },
  qr: { x: 449, y: 92, width: 315, height: 315 },
  summary: { x: 449, y: 415, width: 315, height: 141 },
  secondary: { x: 36, y: 590, width: 728, height: 170 },
  packaging: { x: 36, y: 594, width: 728, height: 28 },
  storage: { x: 36, y: 628, width: 728, height: 128 },
} as const;

/**
 * Compact-v2 is a physical label domain, not the unconstrained commercial-order domain.
 * Values outside this envelope must be split into separate immutable label snapshots.
 */
export const COMPACT_PALLET_LABEL_SNAPSHOT_BOUNDS = {
  minimumFontSize: 8,
  maximumAggregateCharacters: 2_549,
  textFields: {
    palletId: { minimumCharacters: 1, maximumCharacters: 200 },
    materialMark: { minimumCharacters: 1, maximumCharacters: 100 },
    article: { minimumCharacters: 1, maximumCharacters: 100, nullable: true },
    packagingMaterial: { minimumCharacters: 1, maximumCharacters: 200, nullable: true },
    productionDate: { minimumCharacters: 7, maximumCharacters: 15, nullable: true },
    deliveryDate: { minimumCharacters: 10, maximumCharacters: 10, nullable: true },
    storageConditions: { minimumCharacters: 1, maximumCharacters: 500 },
    createdAt: { minimumCharacters: 24, maximumCharacters: 24 },
  },
  collections: {
    productNames: {
      minimumItems: 1,
      maximumItems: 4,
      minimumItemCharacters: 1,
      maximumItemCharacters: 250,
      maximumAggregateCharacters: 1_000,
    },
    orderNumbers: {
      minimumItems: 0,
      maximumItems: 1,
      minimumItemCharacters: 1,
      maximumItemCharacters: 100,
      maximumAggregateCharacters: 100,
    },
    customerAliases: {
      minimumItems: 0,
      maximumItems: 1,
      minimumItemCharacters: 1,
      maximumItemCharacters: 300,
      maximumAggregateCharacters: 300,
    },
  },
  numericFields: {
    rollCount: { minimum: 1, maximum: 10_000, integer: true },
    packagingCount: { minimum: 0, maximum: 100_000, integer: true, nullable: true },
    netKg: { minimum: 0, maximum: 999_999_999.999 },
    grossKg: { minimum: 0, maximum: 999_999_999.999, nullable: true },
    shelfLifeMonths: { minimum: 12, maximum: 12, integer: true },
  },
} as const;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ImmutablePalletLabelSnapshot = DeepReadonly<PalletLabelSnapshot>;

export type PalletLabelBitmap = {
  readonly png: Buffer;
  readonly bitmap: Buffer;
  readonly width: number;
  readonly height: number;
};

const CAPTIONS = {
  manufacturer: 'Наименование изготовителя',
  purpose: 'Наименование и назначение товара:',
  article: 'Арт.',
  quantity: 'Количество шт/на палете',
  packaging: 'Упаковочный материал',
  weight: 'Вес 1 паллета (кг) нетто/брутто',
  productionDate: 'Дата производства',
  shelfLife: 'Годен в течении',
  deliveryDate: 'Дата поставки',
  conditions: 'Дополнительные условия:',
} as const;

const COMPACT_CAPTIONS = {
  palletId: 'Паллета',
  materialMark: 'Материал',
  productNames: CAPTIONS.purpose,
  article: CAPTIONS.article,
  rollCount: CAPTIONS.quantity,
  packagingMaterial: CAPTIONS.packaging,
  packagingCount: 'Количество упаковок',
  netKg: 'Нетто, кг',
  grossKg: 'Брутто, кг',
  productionDate: CAPTIONS.productionDate,
  shelfLifeMonths: CAPTIONS.shelfLife,
  deliveryDate: CAPTIONS.deliveryDate,
  storageConditions: CAPTIONS.conditions,
  orderNumbers: 'Заказ',
  customerAliases: 'Заказчик',
  createdAt: 'Сформировано',
} as const;

type FittedText = { fontSize: number; lines: string[]; lineHeight: number };

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function wrapText(value: string, maxCharacters: number): string[] {
  if (value.length === 0) return [''];
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  const pushWord = (word: string): void => {
    if (word.length <= maxCharacters) {
      const candidate = current.length > 0 ? `${current} ${word}` : word;
      if (candidate.length <= maxCharacters) {
        current = candidate;
      } else {
        if (current.length > 0) lines.push(current);
        current = word;
      }
      return;
    }

    if (current.length > 0) {
      lines.push(current);
      current = '';
    }
    for (let offset = 0; offset < word.length; offset += maxCharacters) {
      const chunk = word.slice(offset, offset + maxCharacters);
      if (chunk.length === maxCharacters) lines.push(chunk);
      else current = chunk;
    }
  };

  for (const word of words) pushWord(word);
  if (current.length > 0) lines.push(current);
  return lines;
}

function fitProductText(value: string, width: number, height: number): FittedText {
  for (let fontSize = 26; fontSize >= 10; fontSize -= 1) {
    const lineHeight = Math.ceil(fontSize * 1.25);
    const maxCharacters = Math.max(1, Math.floor(width / (fontSize * 0.58)));
    const lines = wrapText(value, maxCharacters);
    if (lines.length * lineHeight <= height) return { fontSize, lines, lineHeight };
  }
  throw new Error('Pallet label product text exceeds template v1 capacity');
}

function fitSingleLineText(
  value: string,
  width: number,
  maximumFontSize: number,
  field: 'article' | 'packaging',
): number {
  for (let fontSize = maximumFontSize; fontSize >= 10; fontSize -= 1) {
    if (value.length * fontSize * 0.58 <= width) return fontSize;
  }
  throw new Error(`Pallet label ${field} text exceeds template v1 capacity`);
}

const text = (
  x: number,
  y: number,
  value: string,
  options: {
    size?: number;
    weight?: 'normal' | 'bold';
    style?: 'normal' | 'italic';
    fill?: string;
    anchor?: 'start' | 'middle' | 'end';
  } = {},
): string =>
  `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${options.size ?? 12}" ` +
  `font-weight="${options.weight ?? 'normal'}" font-style="${options.style ?? 'normal'}" ` +
  `fill="${options.fill ?? '#000000'}" text-anchor="${options.anchor ?? 'start'}">` +
  `${escapeXml(value)}</text>`;

const multilineText = (
  x: number,
  y: number,
  lines: string[],
  lineHeight: number,
  options: {
    size: number;
    family?: 'DejaVu Sans' | 'DejaVu Sans Mono';
    weight?: 'normal' | 'bold';
    style?: 'normal' | 'italic';
    fill?: string;
    anchor?: 'start' | 'middle' | 'end';
    preserveWhitespace?: boolean;
    lineXOffsets?: readonly number[];
  },
): string => {
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${x + (options.lineXOffsets?.[index] ?? 0)}" ` +
        `dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join('');
  return (
    `<text x="${x}" y="${y}" font-family="${options.family ?? 'DejaVu Sans'}" ` +
    `font-size="${options.size}" ` +
    `font-weight="${options.weight ?? 'normal'}" font-style="${options.style ?? 'normal'}" ` +
    `fill="${options.fill ?? '#000000'}" text-anchor="${options.anchor ?? 'start'}"` +
    `${options.preserveWhitespace ? ' xml:space="preserve"' : ''}>` +
    `${spans}</text>`
  );
};

const line = (x1: number, y1: number, x2: number, y2: number, width = 2): string =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000000" stroke-width="${width}"/>`;

const image = (href: string, x: number, y: number, width: number, height: number): string =>
  `<image href="${href}" x="${x}" y="${y}" width="${width}" height="${height}" ` +
  'preserveAspectRatio="xMidYMid meet"/>';

function palletQr(token: string): string {
  if (!isPalletScanToken(token)) throw new Error('Invalid pallet scan token');

  const qr = QRCode.create(token, { version: 5, errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const moduleSize = 4;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (
    qr.modules.size !== 37 ||
    envelopeSize !== PALLET_LABEL_LAYOUT.qr.width ||
    envelopeSize !== PALLET_LABEL_LAYOUT.qr.height
  ) {
    throw new Error('Unexpected pallet QR geometry');
  }

  const originX = PALLET_LABEL_LAYOUT.qr.x + quietZone * moduleSize;
  const originY = PALLET_LABEL_LAYOUT.qr.y + quietZone * moduleSize;
  const darkModules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      darkModules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }

  return (
    `<g data-pallet-qr="true" data-qr-module-count="${qr.modules.size}" ` +
    'shape-rendering="crispEdges">' +
    `<rect x="${PALLET_LABEL_LAYOUT.qr.x}" y="${PALLET_LABEL_LAYOUT.qr.y}" ` +
    `width="${envelopeSize}" height="${envelopeSize}" fill="#ffffff"/>` +
    `<path d="${darkModules.join('')}" fill="#000000"/>` +
    '</g>'
  );
}

function compactPalletQr(token: string): string {
  if (!isPalletScanToken(token)) throw new Error('Invalid pallet scan token');

  const qr = QRCode.create(token, { version: 5, errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const moduleSize = 8;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (
    qr.modules.size !== 37 ||
    envelopeSize !== COMPACT_PALLET_LABEL_LAYOUT.qr.width ||
    envelopeSize !== COMPACT_PALLET_LABEL_LAYOUT.qr.height
  ) {
    throw new Error('Unexpected compact pallet QR geometry');
  }

  const originX = COMPACT_PALLET_LABEL_LAYOUT.qr.x + quietZone * moduleSize;
  const originY = COMPACT_PALLET_LABEL_LAYOUT.qr.y + quietZone * moduleSize;
  const darkModules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      darkModules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }

  return (
    `<g data-pallet-qr="true" data-qr-module-count="${qr.modules.size}" ` +
    'shape-rendering="crispEdges">' +
    `<rect x="${COMPACT_PALLET_LABEL_LAYOUT.qr.x}" ` +
    `y="${COMPACT_PALLET_LABEL_LAYOUT.qr.y}" width="${envelopeSize}" ` +
    `height="${envelopeSize}" fill="#ffffff"/>` +
    `<path d="${darkModules.join('')}" fill="#000000"/>` +
    '</g>'
  );
}

function squarePalletQr(token: string): string {
  if (!isPalletScanToken(token)) throw new Error('Invalid pallet scan token');

  const qr = QRCode.create(token, { version: 5, errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const moduleSize = 7;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (
    qr.modules.size !== 37 ||
    envelopeSize !== SQUARE_PALLET_LABEL_LAYOUT.qr.width ||
    envelopeSize !== SQUARE_PALLET_LABEL_LAYOUT.qr.height
  ) {
    throw new Error('Unexpected square pallet QR geometry');
  }

  const originX = SQUARE_PALLET_LABEL_LAYOUT.qr.x + quietZone * moduleSize;
  const originY = SQUARE_PALLET_LABEL_LAYOUT.qr.y + quietZone * moduleSize;
  const darkModules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      darkModules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }

  return (
    `<g data-pallet-qr="true" data-qr-module-count="${qr.modules.size}" ` +
    `data-qr-module-size="${moduleSize}" shape-rendering="crispEdges">` +
    `<rect x="${SQUARE_PALLET_LABEL_LAYOUT.qr.x}" ` +
    `y="${SQUARE_PALLET_LABEL_LAYOUT.qr.y}" width="${envelopeSize}" ` +
    `height="${envelopeSize}" fill="#ffffff"/>` +
    `<path d="${darkModules.join('')}" fill="#000000"/>` +
    '</g>'
  );
}

function safePalletQr(token: string): string {
  if (!isPalletScanToken(token)) throw new Error('Invalid pallet scan token');

  const qr = QRCode.create(token, { version: 5, errorCorrectionLevel: 'M' });
  const quietZone = 4;
  const moduleSize = 7;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (
    qr.modules.size !== 37 ||
    envelopeSize !== SAFE_PALLET_LABEL_LAYOUT.qr.width ||
    envelopeSize !== SAFE_PALLET_LABEL_LAYOUT.qr.height
  ) {
    throw new Error('Unexpected safe pallet QR geometry');
  }

  const originX = SAFE_PALLET_LABEL_LAYOUT.qr.x + quietZone * moduleSize;
  const originY = SAFE_PALLET_LABEL_LAYOUT.qr.y + quietZone * moduleSize;
  const darkModules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      darkModules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }

  return (
    `<g data-pallet-qr="true" data-qr-module-count="${qr.modules.size}" ` +
    `data-qr-module-size="${moduleSize}" shape-rendering="crispEdges">` +
    `<rect x="${SAFE_PALLET_LABEL_LAYOUT.qr.x}" ` +
    `y="${SAFE_PALLET_LABEL_LAYOUT.qr.y}" width="${envelopeSize}" ` +
    `height="${envelopeSize}" fill="#ffffff"/>` +
    `<path d="${darkModules.join('')}" fill="#000000"/>` +
    '</g>'
  );
}

const display = (value: string | number | null): string =>
  value === null || value === '' ? '' : String(value);

const displayMaterialMark = (value: string): string =>
  value
    .split(/\s*\/\s*/)
    .map((mark) => {
      const normalized = mark.trim().toUpperCase();
      if (normalized === 'ПВД' || normalized === 'ПЭВД' || normalized === 'LDPE') return 'PE-LD';
      return mark.trim();
    })
    .filter(Boolean)
    .join(' / ');

const formatWeight = (netKg: number, grossKg: number | null): string =>
  `${netKg.toFixed(3)} / ${grossKg === null ? '—' : grossKg.toFixed(3)}`;

type TextBounds = {
  readonly minimumCharacters: number;
  readonly maximumCharacters: number;
  readonly nullable?: boolean;
};

type CollectionBounds = {
  readonly minimumItems: number;
  readonly maximumItems: number;
  readonly minimumItemCharacters: number;
  readonly maximumItemCharacters: number;
  readonly maximumAggregateCharacters: number;
};

type NumericBounds = {
  readonly minimum: number;
  readonly maximum: number;
  readonly integer?: boolean;
  readonly nullable?: boolean;
};

const containsControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });

function assertCompactText(field: string, value: unknown, bounds: TextBounds): number {
  if (value === null && bounds.nullable) return 0;
  if (typeof value !== 'string') {
    throw new Error(`Compact pallet label ${field} must be a string`);
  }
  if (value.length > bounds.maximumCharacters) {
    throw new Error(
      `Compact pallet label ${field} has ${value.length} characters; ` +
        `maximum ${bounds.maximumCharacters}`,
    );
  }
  if (value.length < bounds.minimumCharacters || value.trim().length === 0) {
    throw new Error(
      `Compact pallet label ${field} must contain at least ${bounds.minimumCharacters} characters`,
    );
  }
  if (containsControlCharacter(value)) {
    throw new Error(`Compact pallet label ${field} contains control characters`);
  }
  return value.length;
}

function assertCompactCollection(field: string, value: unknown, bounds: CollectionBounds): number {
  if (!Array.isArray(value)) {
    throw new Error(`Compact pallet label ${field} must be an array`);
  }
  if (value.length < bounds.minimumItems) {
    throw new Error(`Compact pallet label ${field} requires at least ${bounds.minimumItems} items`);
  }
  if (value.length > bounds.maximumItems) {
    throw new Error(
      `Compact pallet label ${field} has ${value.length} items; maximum ` +
        `${bounds.maximumItems}; split the pallet into separate label snapshots`,
    );
  }

  let aggregateCharacters = 0;
  for (let index = 0; index < value.length; index += 1) {
    aggregateCharacters += assertCompactText(`${field}[${index}]`, value[index], {
      minimumCharacters: bounds.minimumItemCharacters,
      maximumCharacters: bounds.maximumItemCharacters,
    });
  }
  if (aggregateCharacters > bounds.maximumAggregateCharacters) {
    throw new Error(
      `Compact pallet label ${field} has ${aggregateCharacters} aggregate characters; ` +
        `maximum ${bounds.maximumAggregateCharacters}`,
    );
  }
  return aggregateCharacters;
}

function assertCompactNumber(field: string, value: unknown, bounds: NumericBounds): void {
  if (value === null && bounds.nullable) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Compact pallet label ${field} must be finite`);
  }
  if (bounds.integer && !Number.isInteger(value)) {
    throw new Error(`Compact pallet label ${field} must be an integer`);
  }
  if (value < bounds.minimum) {
    throw new Error(`Compact pallet label ${field} must be at least ${bounds.minimum}`);
  }
  if (value > bounds.maximum) {
    throw new Error(`Compact pallet label ${field} must be at most ${bounds.maximum}`);
  }
}

function assertProductionDate(value: string | null): void {
  if (value === null) return;
  if (!/^(0[1-9]|1[0-2])\.\d{4}(?:–(0[1-9]|1[0-2])\.\d{4})?$/u.test(value)) {
    throw new Error('Compact pallet label productionDate must match MM.YYYY or MM.YYYY–MM.YYYY');
  }
}

function assertDeliveryDate(value: string | null): void {
  if (value === null) return;
  const match = /^(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])\.(\d{4})$/u.exec(value);
  if (!match) {
    throw new Error('Compact pallet label deliveryDate must match DD.MM.YYYY');
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]) {
    throw new Error('Compact pallet label deliveryDate must be a valid date');
  }
}

function assertCreatedAt(value: string): void {
  const parsed = new Date(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw new Error('Compact pallet label createdAt must be canonical UTC ISO-8601');
  }
}

function validateCompactPalletLabelSnapshot(snapshot: ImmutablePalletLabelSnapshot): void {
  const { textFields, collections, numericFields, maximumAggregateCharacters } =
    COMPACT_PALLET_LABEL_SNAPSHOT_BOUNDS;
  let aggregateCharacters = 0;

  aggregateCharacters += assertCompactText('palletId', snapshot.palletId, textFields.palletId);
  aggregateCharacters += assertCompactText(
    'materialMark',
    snapshot.materialMark,
    textFields.materialMark,
  );
  aggregateCharacters += assertCompactCollection(
    'productNames',
    snapshot.productNames,
    collections.productNames,
  );
  aggregateCharacters += assertCompactText('article', snapshot.article, textFields.article);
  aggregateCharacters += assertCompactText(
    'packagingMaterial',
    snapshot.packagingMaterial,
    textFields.packagingMaterial,
  );
  aggregateCharacters += assertCompactText(
    'productionDate',
    snapshot.productionDate,
    textFields.productionDate,
  );
  aggregateCharacters += assertCompactText(
    'deliveryDate',
    snapshot.deliveryDate,
    textFields.deliveryDate,
  );
  aggregateCharacters += assertCompactText(
    'storageConditions',
    snapshot.storageConditions,
    textFields.storageConditions,
  );
  aggregateCharacters += assertCompactCollection(
    'orderNumbers',
    snapshot.orderNumbers,
    collections.orderNumbers,
  );
  aggregateCharacters += assertCompactCollection(
    'customerAliases',
    snapshot.customerAliases,
    collections.customerAliases,
  );
  aggregateCharacters += assertCompactText('createdAt', snapshot.createdAt, textFields.createdAt);

  if (aggregateCharacters > maximumAggregateCharacters) {
    throw new Error(
      `Compact pallet label snapshot has ${aggregateCharacters} aggregate characters; ` +
        `maximum ${maximumAggregateCharacters}`,
    );
  }

  assertCompactNumber('rollCount', snapshot.rollCount, numericFields.rollCount);
  assertCompactNumber('packagingCount', snapshot.packagingCount, numericFields.packagingCount);
  assertCompactNumber('netKg', snapshot.netKg, numericFields.netKg);
  assertCompactNumber('grossKg', snapshot.grossKg, numericFields.grossKg);
  assertCompactNumber('shelfLifeMonths', snapshot.shelfLifeMonths, numericFields.shelfLifeMonths);
  assertProductionDate(snapshot.productionDate);
  assertDeliveryDate(snapshot.deliveryDate);
  assertCreatedAt(snapshot.createdAt);
}

function validateSquarePalletLabelSnapshot(snapshot: ImmutablePalletLabelSnapshot): void {
  validateCompactPalletLabelSnapshot(snapshot);
  if (!Array.isArray(snapshot.rollCodes)) {
    throw new Error('Square pallet label rollCodes must be an array');
  }
  if (snapshot.rollCodes.length !== snapshot.rollCount) {
    throw new Error('Square pallet label rollCodes must match rollCount');
  }
  if (new Set(snapshot.rollCodes).size !== snapshot.rollCodes.length) {
    throw new Error('Square pallet label rollCodes must be unique');
  }
  assertCompactCollection('rollCodes', snapshot.rollCodes, {
    minimumItems: 1,
    maximumItems: 24,
    minimumItemCharacters: 1,
    maximumItemCharacters: 80,
    maximumAggregateCharacters: 960,
  });
}

const fontRoot = dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const boldFontPath = join(fontRoot, 'ttf/DejaVuSans-Bold.ttf');
const compactBoldFontPath = join(fontRoot, 'ttf/DejaVuSansMono-Bold.ttf');
const fontFiles = [
  join(fontRoot, 'ttf/DejaVuSans.ttf'),
  boldFontPath,
  join(fontRoot, 'ttf/DejaVuSans-Oblique.ttf'),
  compactBoldFontPath,
];
const boldFont = fontkit.create(readFileSync(boldFontPath));
const compactBoldFont = fontkit.create(readFileSync(compactBoldFontPath));
const STORAGE_TEXT_FONT_SIZE = 12;
const STORAGE_TEXT_RIGHT_PADDING = 12;

function boldTextRightExtent(value: string, fontSize: number): number {
  const run = boldFont.layout(value);
  return (Math.max(run.advanceWidth, run.bbox.maxX) * fontSize) / boldFont.unitsPerEm;
}

function compactBoldTextInkBounds(
  value: string,
  fontSize: number,
): { left: number; right: number } {
  if (value.length === 0) return { left: 0, right: 0 };
  const run = compactBoldFont.layout(value);
  const scale = fontSize / compactBoldFont.unitsPerEm;
  return {
    left: Math.min(0, run.bbox.minX * scale),
    right: Math.max(run.advanceWidth, run.bbox.maxX) * scale,
  };
}

function compactBoldTextInkWidth(value: string, fontSize: number): number {
  const { left, right } = compactBoldTextInkBounds(value, fontSize);
  return right - left;
}

function wrapBoldTextToWidth(value: string, maxWidth: number, fontSize: number): string[] {
  if (value.length === 0) return [''];

  const fits = (candidate: string): boolean => boldTextRightExtent(candidate, fontSize) <= maxWidth;
  const lines: string[] = [];
  let current = '';

  const pushOversizedWord = (word: string): void => {
    let chunk = '';
    for (const character of word) {
      const candidate = `${chunk}${character}`;
      if (chunk.length > 0 && !fits(candidate)) {
        lines.push(chunk);
        chunk = character;
      } else {
        chunk = candidate;
      }
      if (!fits(chunk)) {
        throw new Error('Pallet label storage text contains an unrenderable glyph');
      }
    }
    current = chunk;
  };

  for (const word of value.split(/\s+/u).filter(Boolean)) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      lines.push(current);
      current = '';
    }
    if (fits(word)) current = word;
    else pushOversizedWord(word);
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

type CompactFieldName = keyof typeof COMPACT_PALLET_LABEL_LAYOUT.fields;
const COMPACT_TEXT_FIT_CACHE_MAX_ENTRIES = 128;
const compactTextFitCache = new Map<string, FittedText>();

function wrapCompactText(value: string, maxWidth: number, fontSize: number): string[] {
  const fits = (candidate: string): boolean =>
    compactBoldTextInkWidth(candidate, fontSize) <= maxWidth;
  const lines: string[] = [];

  for (const paragraph of value.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    let current = '';
    let pendingWhitespace = '';
    const tokens = paragraph.match(/\s+|\S+/gu) ?? [];
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        pendingWhitespace += token;
        continue;
      }

      const candidate = `${current}${pendingWhitespace}${token}`;
      if (fits(candidate)) {
        current = candidate;
        pendingWhitespace = '';
        continue;
      }
      if (current.length > 0) {
        lines.push(`${current}${pendingWhitespace}`);
        current = '';
        pendingWhitespace = '';
      }

      const unbroken = `${pendingWhitespace}${token}`;
      pendingWhitespace = '';
      if (fits(unbroken)) {
        current = unbroken;
        continue;
      }

      let chunk = '';
      for (const character of unbroken) {
        const chunkCandidate = `${chunk}${character}`;
        if (chunk.length > 0 && !fits(chunkCandidate)) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk = chunkCandidate;
        }
        if (!fits(chunk)) {
          throw new Error('Compact pallet label contains an unrenderable glyph');
        }
      }
      current = chunk;
    }
    lines.push(`${current}${pendingWhitespace}`);
  }
  return lines;
}

function fitCompactText(
  field: CompactFieldName,
  value: string,
  width: number,
  height: number,
  maximumFontSize: number,
): FittedText {
  const cacheKey = `${field}\u0000${width}\u0000${height}\u0000${maximumFontSize}\u0000${value}`;
  const cached = compactTextFitCache.get(cacheKey);
  if (cached) {
    compactTextFitCache.delete(cacheKey);
    compactTextFitCache.set(cacheKey, cached);
    return cached;
  }

  for (
    let fontSize = maximumFontSize;
    fontSize >= COMPACT_PALLET_LABEL_SNAPSHOT_BOUNDS.minimumFontSize;
    fontSize -= 1
  ) {
    const lineHeight = Math.ceil(fontSize * 1.25);
    const lines = wrapCompactText(value, width, fontSize);
    if (lines.length * lineHeight <= height) {
      const fitted = { fontSize, lines, lineHeight };
      if (compactTextFitCache.size >= COMPACT_TEXT_FIT_CACHE_MAX_ENTRIES) {
        const oldestKey = compactTextFitCache.keys().next().value;
        if (oldestKey !== undefined) compactTextFitCache.delete(oldestKey);
      }
      compactTextFitCache.set(cacheKey, fitted);
      return fitted;
    }
  }
  throw new Error(`Pallet label ${field} text exceeds compact-v2 capacity`);
}

function compactField(
  field: CompactFieldName,
  caption: string,
  value: string,
  maximumFontSize: number,
): string {
  const bounds = COMPACT_PALLET_LABEL_LAYOUT.fields[field];
  const padding = 0;
  const separator = caption.endsWith(':') ? ' ' : ': ';
  const content = `${caption}${separator}${value.length > 0 ? value : '—'}`;
  const fitted = fitCompactText(
    field,
    content,
    bounds.width - padding * 2,
    bounds.height - padding * 2,
    maximumFontSize,
  );
  const textHeight = fitted.lines.length * fitted.lineHeight;
  const lineXOffsets = fitted.lines.map(
    (lineValue) => -compactBoldTextInkBounds(lineValue, fitted.fontSize).left,
  );
  const y =
    bounds.y +
    padding +
    fitted.fontSize +
    Math.floor((bounds.height - padding * 2 - textHeight) / 2);

  return (
    `<g data-business-field="${field}" data-field-bounds="${bounds.x},${bounds.y},` +
    `${bounds.width},${bounds.height}" data-fit-font-size="${fitted.fontSize}">` +
    `<desc data-business-value="true">${escapeXml(value)}</desc>` +
    multilineText(bounds.x + padding, y, fitted.lines, fitted.lineHeight, {
      size: fitted.fontSize,
      family: 'DejaVu Sans Mono',
      weight: 'bold',
      preserveWhitespace: true,
      lineXOffsets,
    }) +
    '</g>'
  );
}

type SquareFieldBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function wrapSquareText(value: string, maxWidth: number, fontSize: number): string[] {
  if (value.length === 0) return [''];
  const lines: string[] = [];
  let current = '';

  for (const word of value.split(/\s+/u).filter(Boolean)) {
    if (boldTextRightExtent(word, fontSize) > maxWidth) {
      throw new Error('Square pallet label contains a word wider than its field');
    }
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (boldTextRightExtent(candidate, fontSize) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = word;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function fitSquareText(
  value: string,
  width: number,
  height: number,
  maximumFontSize: number,
  minimumFontSize = 12,
): FittedText {
  for (let fontSize = maximumFontSize; fontSize >= minimumFontSize; fontSize -= 1) {
    const lineHeight = Math.ceil(fontSize * 1.2);
    let lines: string[];
    try {
      lines = wrapSquareText(value, width, fontSize);
    } catch {
      continue;
    }
    if (lines.length * lineHeight <= height) return { fontSize, lines, lineHeight };
  }
  throw new Error('Pallet label text exceeds square-v4 capacity');
}

function squareField(
  field: string,
  bounds: SquareFieldBounds,
  caption: string,
  value: string,
  maximumFontSize: number,
  minimumFontSize = 12,
): string {
  const displayValue = value.length > 0 ? value : '—';
  const content = caption.length > 0 ? `${caption}: ${displayValue}` : displayValue;
  const fitted = fitSquareText(
    content,
    bounds.width,
    bounds.height,
    maximumFontSize,
    minimumFontSize,
  );
  const textHeight = fitted.lines.length * fitted.lineHeight;
  const y = bounds.y + fitted.fontSize + Math.floor((bounds.height - textHeight) / 2);

  return (
    `<g data-business-field="${field}" data-field-bounds="${bounds.x},${bounds.y},` +
    `${bounds.width},${bounds.height}" data-fit-font-size="${fitted.fontSize}">` +
    `<desc data-business-value="true">${escapeXml(value)}</desc>` +
    multilineText(bounds.x, y, fitted.lines, fitted.lineHeight, {
      size: fitted.fontSize,
      weight: 'bold',
    }) +
    '</g>'
  );
}

function squareRollCodes(snapshot: ImmutablePalletLabelSnapshot): string {
  const rollCodes = snapshot.rollCodes;
  if (!rollCodes) throw new Error('Square pallet label rollCodes must be an array');
  const bounds = SQUARE_PALLET_LABEL_LAYOUT.rollCodes;
  const captionHeight = 30;
  const columnGap = 12;
  const columns = 2;
  const rowsPerColumn = 12;
  const rowHeight = Math.floor((bounds.height - captionHeight) / rowsPerColumn);
  const cellWidth = (bounds.width - columnGap) / columns;
  const fontSize = 14;
  const values = rollCodes.map((rollCode, index) => `#${index + 1} ${rollCode}`);
  if (values.length > columns * rowsPerColumn) {
    throw new Error('Square pallet label roll grid exceeds 24 codes');
  }
  for (const value of values) {
    if (boldTextRightExtent(value, fontSize) > cellWidth) {
      throw new Error('Square pallet label roll code exceeds one grid cell');
    }
  }

  const codeElements = values.map((value, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    const x = bounds.x + column * (cellWidth + columnGap);
    const y = bounds.y + captionHeight + fontSize + row * rowHeight;
    return (
      `<g data-roll-position="${index + 1}" data-roll-code="true">` +
      `<desc data-business-value="true">${escapeXml(rollCodes[index])}</desc>` +
      text(x, y, value, { size: fontSize, weight: 'bold' }) +
      '</g>'
    );
  });

  return (
    `<g data-business-field="rollCodes" data-field-bounds="${bounds.x},${bounds.y},` +
    `${bounds.width},${bounds.height}" data-fit-font-size="${fontSize}" ` +
    `data-roll-columns="${columns}" data-roll-rows="${rowsPerColumn}">` +
    `<desc data-business-value="true">${escapeXml(rollCodes.join('\n'))}</desc>` +
    text(bounds.x, bounds.y + 20, `Рулоны на палете: ${rollCodes.length}`, {
      size: 18,
      weight: 'bold',
    }) +
    codeElements.join('') +
    '</g>'
  );
}

function safeField(
  field: string,
  bounds: SquareFieldBounds,
  caption: string,
  value: string,
  maximumFontSize: number,
  minimumFontSize = 9,
): string {
  try {
    return renderPalletLabelSemanticField(
      field,
      bounds,
      caption,
      value,
      maximumFontSize,
      minimumFontSize,
    );
  } catch {
    throw new Error('Pallet label text exceeds safe-v5 capacity');
  }
}

function safeRollCodes(snapshot: ImmutablePalletLabelSnapshot): string {
  const rollCodes = snapshot.rollCodes;
  if (!rollCodes) throw new Error('Safe pallet label rollCodes must be an array');
  const bounds = SAFE_PALLET_LABEL_LAYOUT.rollCodes;
  const captionHeight = 24;
  const columnGap = 12;
  const columns = 2;
  const rowsPerColumn = 12;
  const rowHeight = Math.floor((bounds.height - captionHeight) / rowsPerColumn);
  const cellWidth = (bounds.width - columnGap) / columns;
  const fontSize = 12;
  const values = rollCodes.map((rollCode, index) => `#${index + 1} ${rollCode}`);
  if (values.length > columns * rowsPerColumn) {
    throw new Error('Safe pallet label roll grid exceeds 24 codes');
  }
  for (const value of values) {
    if (boldTextRightExtent(value, fontSize) > cellWidth) {
      throw new Error('Safe pallet label roll code exceeds one grid cell');
    }
  }

  const codeElements = values.map((value, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const row = index % rowsPerColumn;
    const x = bounds.x + column * (cellWidth + columnGap);
    const y = bounds.y + captionHeight + fontSize + row * rowHeight;
    return (
      `<g data-roll-position="${index + 1}" data-roll-code="true">` +
      `<desc data-business-value="true">${escapeXml(rollCodes[index])}</desc>` +
      text(x, y, value, { size: fontSize, weight: 'bold' }) +
      '</g>'
    );
  });

  return (
    `<g data-business-field="rollCodes" data-field-bounds="${bounds.x},${bounds.y},` +
    `${bounds.width},${bounds.height}" data-fit-font-size="${fontSize}" ` +
    `data-roll-columns="${columns}" data-roll-rows="${rowsPerColumn}">` +
    `<desc data-business-value="true">${escapeXml(rollCodes.join('\n'))}</desc>` +
    text(bounds.x, bounds.y + 18, `Рулоны на палете: ${rollCodes.length}`, {
      size: 16,
      weight: 'bold',
    }) +
    codeElements.join('') +
    '</g>'
  );
}

function renderSquarePalletLabelSvg(snapshot: ImmutablePalletLabelSnapshot, token: string): string {
  const packaging = [snapshot.packagingMaterial, snapshot.packagingCount]
    .filter((value) => value !== null && value !== '')
    .join(' / ');
  const weights = `${snapshot.netKg.toFixed(3)} / ${snapshot.grossKg?.toFixed(3) ?? '—'} кг`;
  const dates = [
    snapshot.productionDate ? `Произведено: ${snapshot.productionDate}` : null,
    snapshot.deliveryDate ? `Поставка: ${snapshot.deliveryDate}` : null,
    `Срок: ${snapshot.shelfLifeMonths} мес.`,
  ]
    .filter((value): value is string => value !== null)
    .join('  •  ');

  return [
    '<svg id="pallet-label-root" xmlns="http://www.w3.org/2000/svg" ',
    'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800" ',
    'viewBox="0 0 800 800">',
    `<title>${escapeXml(snapshot.palletId)}</title>`,
    '<rect x="0" y="0" width="800" height="800" fill="#ffffff"/>',
    '<g data-layout-profile="square-v4" data-layout-orientation="square-unrotated">',
    '<rect x="22" y="22" width="756" height="756" fill="none" ',
    'stroke="#000000" stroke-width="3"/>',
    line(22, 96, 778, 96, 2),
    line(360, 96, 360, 778, 2),
    squareField(
      'palletId',
      { x: 36, y: 36, width: 570, height: 54 },
      'ПАЛЕТНЫЙ ЛИСТ',
      snapshot.palletId,
      38,
      24,
    ),
    image(PALLET_LABEL_ASSETS.logo.dataUri, 624, 45, 132, 36),
    squareField(
      'orderNumbers',
      { x: 36, y: 104, width: 315, height: 50 },
      'Заказ',
      snapshot.orderNumbers.join(', '),
      25,
      15,
    ),
    squareField(
      'customerAliases',
      { x: 36, y: 158, width: 315, height: 64 },
      'Заказчик',
      snapshot.customerAliases.join(', '),
      22,
      14,
    ),
    squareField(
      'productNames',
      { x: 36, y: 234, width: 315, height: 118 },
      'Продукт',
      snapshot.productNames.join(' • '),
      25,
      14,
    ),
    squareField(
      'article',
      { x: 36, y: 358, width: 315, height: 64 },
      'Артикул',
      display(snapshot.article),
      20,
      12,
    ),
    squareField(
      'createdAt',
      { x: 36, y: 426, width: 315, height: 19 },
      '',
      formatPalletLabelCreatedAt(snapshot.createdAt),
      12,
      10,
    ),
    squarePalletQr(token),
    squareField(
      'materialMark',
      { x: 370, y: 104, width: 394, height: 46 },
      'Материал',
      snapshot.materialMark,
      23,
      15,
    ),
    squareField(
      'rollCount',
      { x: 370, y: 154, width: 120, height: 42 },
      'Рулонов',
      String(snapshot.rollCount),
      21,
      15,
    ),
    squareField(
      'netKg',
      { x: 500, y: 154, width: 264, height: 42 },
      'Нетто / брутто',
      weights,
      19,
      13,
    ),
    squareField('productionDate', { x: 370, y: 200, width: 394, height: 42 }, '', dates, 17, 12),
    squareRollCodes(snapshot),
    squareField(
      'packagingMaterial',
      { x: 370, y: 548, width: 394, height: 44 },
      'Упаковка',
      packaging,
      18,
      12,
    ),
    squareField(
      'storageConditions',
      { x: 370, y: 596, width: 394, height: 168 },
      'Хранение',
      snapshot.storageConditions,
      16,
      11,
    ),
    '</g>',
    '</svg>',
  ].join('');
}

function renderSafePalletLabelSvg(snapshot: ImmutablePalletLabelSnapshot, token: string): string {
  const packaging = [snapshot.packagingMaterial, snapshot.packagingCount]
    .filter((value) => value !== null && value !== '')
    .join(' / ');
  const weights = `${snapshot.netKg.toFixed(3)} / ${snapshot.grossKg?.toFixed(3) ?? '—'} кг`;
  const dates = [
    snapshot.productionDate ? `Произведено: ${snapshot.productionDate}` : null,
    snapshot.deliveryDate ? `Поставка: ${snapshot.deliveryDate}` : null,
    `Срок: ${snapshot.shelfLifeMonths} мес.`,
  ]
    .filter((value): value is string => value !== null)
    .join('  •  ');

  return [
    '<svg id="pallet-label-root" xmlns="http://www.w3.org/2000/svg" ',
    'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800" ',
    'viewBox="0 0 800 800">',
    `<title>${escapeXml(snapshot.palletId)}</title>`,
    '<rect x="0" y="0" width="800" height="800" fill="#ffffff"/>',
    '<g data-layout-profile="safe-v5" data-layout-orientation="square-unrotated" ',
    'data-max-ink-y="570">',
    '<rect x="22" y="22" width="756" height="546" fill="none" ',
    'stroke="#000000" stroke-width="3"/>',
    line(22, 84, 778, 84, 2),
    line(438, 84, 438, 568, 2),
    safeField(
      'palletId',
      { x: 36, y: 32, width: 600, height: 48 },
      'ПАЛЕТНЫЙ ЛИСТ',
      snapshot.palletId,
      34,
      22,
    ),
    image(PALLET_LABEL_ASSETS.logo.dataUri, 658, 41, 98, 27),
    safeField(
      'orderNumbers',
      { x: 36, y: 92, width: 390, height: 32 },
      'Заказ',
      snapshot.orderNumbers.join(', '),
      22,
      13,
    ),
    safeField(
      'customerAliases',
      { x: 36, y: 126, width: 390, height: 40 },
      'Заказчик',
      snapshot.customerAliases.join(', '),
      20,
      12,
    ),
    safeField(
      'productNames',
      { x: 36, y: 170, width: 390, height: 84 },
      'Продукт',
      snapshot.productNames.join(' • '),
      23,
      12,
    ),
    safeField(
      'article',
      { x: 36, y: 258, width: 390, height: 30 },
      'Артикул',
      display(snapshot.article),
      17,
      10,
    ),
    safeField(
      'createdAt',
      { x: 36, y: 292, width: 390, height: 18 },
      '',
      formatPalletLabelCreatedAt(snapshot.createdAt),
      11,
      9,
    ),
    safeRollCodes(snapshot),
    safePalletQr(token),
    safeField(
      'materialMark',
      { x: 449, y: 415, width: 145, height: 22 },
      'Материал',
      snapshot.materialMark,
      13,
      8,
    ),
    safeField(
      'packagingMaterial',
      { x: 598, y: 415, width: 166, height: 22 },
      'Упаковка',
      packaging,
      10,
      8,
    ),
    safeField(
      'rollCount',
      { x: 449, y: 439, width: 82, height: 22 },
      'Рулонов',
      String(snapshot.rollCount),
      12,
      8,
    ),
    safeField(
      'netKg',
      { x: 535, y: 439, width: 229, height: 22 },
      'Нетто / брутто',
      weights,
      11,
      8,
    ),
    safeField('productionDate', { x: 449, y: 463, width: 315, height: 22 }, '', dates, 11, 8),
    safeField(
      'storageConditions',
      { x: 449, y: 487, width: 315, height: 69 },
      '',
      snapshot.storageConditions,
      9,
      8,
    ),
    '</g>',
    '</svg>',
  ].join('');
}

function renderExtendedPalletLabelSvg(
  snapshot: ImmutablePalletLabelSnapshot,
  token: string,
): string {
  const packaging = [snapshot.packagingMaterial, snapshot.packagingCount]
    .filter((value) => value !== null && value !== '')
    .join(' / ');
  const weights = `${snapshot.netKg.toFixed(3)} / ${snapshot.grossKg?.toFixed(3) ?? '—'} кг`;
  const dates = [
    snapshot.productionDate ? `Произведено: ${snapshot.productionDate}` : null,
    snapshot.deliveryDate ? `Поставка: ${snapshot.deliveryDate}` : null,
    `Срок: ${snapshot.shelfLifeMonths} мес.`,
  ]
    .filter((value): value is string => value !== null)
    .join('  •  ');

  return [
    '<svg id="pallet-label-root" xmlns="http://www.w3.org/2000/svg" ',
    'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800" ',
    'viewBox="0 0 800 800">',
    `<title>${escapeXml(snapshot.palletId)}</title>`,
    '<rect x="0" y="0" width="800" height="800" fill="#ffffff"/>',
    '<g data-layout-profile="extended-v6" data-layout-orientation="square-unrotated" ',
    'data-core-max-ink-y="570" data-secondary-min-y="590">',
    '<rect x="22" y="22" width="756" height="756" fill="none" ',
    'stroke="#000000" stroke-width="3"/>',
    '<g data-content-band="core">',
    line(22, 84, 778, 84, 2),
    line(438, 84, 438, 568, 2),
    safeField(
      'palletId',
      { x: 36, y: 32, width: 600, height: 48 },
      'ПАЛЕТНЫЙ ЛИСТ',
      snapshot.palletId,
      34,
      22,
    ),
    image(PALLET_LABEL_ASSETS.logo.dataUri, 658, 41, 98, 27),
    safeField(
      'orderNumbers',
      { x: 36, y: 92, width: 390, height: 32 },
      'Заказ',
      snapshot.orderNumbers.join(', '),
      22,
      13,
    ),
    safeField(
      'customerAliases',
      { x: 36, y: 126, width: 390, height: 40 },
      'Заказчик',
      snapshot.customerAliases.join(', '),
      20,
      12,
    ),
    safeField(
      'productNames',
      { x: 36, y: 170, width: 390, height: 84 },
      'Продукт',
      snapshot.productNames.join(' • '),
      23,
      12,
    ),
    safeField(
      'article',
      { x: 36, y: 258, width: 390, height: 30 },
      'Артикул',
      display(snapshot.article),
      17,
      10,
    ),
    safeField(
      'createdAt',
      { x: 36, y: 292, width: 390, height: 18 },
      '',
      formatPalletLabelCreatedAt(snapshot.createdAt),
      11,
      9,
    ),
    safeRollCodes(snapshot),
    safePalletQr(token),
    safeField(
      'materialMark',
      { x: 449, y: 415, width: 315, height: 26 },
      'Материал',
      snapshot.materialMark,
      15,
      10,
    ),
    safeField(
      'rollCount',
      { x: 449, y: 445, width: 90, height: 24 },
      'Рулонов',
      String(snapshot.rollCount),
      13,
      9,
    ),
    safeField(
      'netKg',
      { x: 543, y: 445, width: 221, height: 24 },
      'Нетто / брутто',
      weights,
      12,
      9,
    ),
    safeField('productionDate', { x: 449, y: 473, width: 315, height: 56 }, '', dates, 12, 9),
    '</g>',
    '<g data-content-band="secondary">',
    line(22, 580, 778, 580, 2),
    safeField(
      'packagingMaterial',
      EXTENDED_PALLET_LABEL_LAYOUT.packaging,
      'Упаковка',
      packaging,
      15,
      11,
    ),
    safeField(
      'storageConditions',
      EXTENDED_PALLET_LABEL_LAYOUT.storage,
      'Хранение',
      snapshot.storageConditions,
      14,
      11,
    ),
    '</g>',
    '</g>',
    '</svg>',
  ].join('');
}

const SQUARE_RENDERABILITY_TOKEN = `plt_${'0'.repeat(64)}`;

/**
 * Runs the exact square-v4 composition path without rasterising or touching a device.
 * The fixed token has the same validated QR envelope as every production pallet token, so a
 * snapshot accepted here is guaranteed to pass the renderer's text and geometry capacity checks.
 */
export function assertSquarePalletLabelSnapshotRenderable(
  snapshot: ImmutablePalletLabelSnapshot,
): void {
  validateSquarePalletLabelSnapshot(snapshot);
  void renderSquarePalletLabelSvg(snapshot, SQUARE_RENDERABILITY_TOKEN);
}

/** Capacity validation for the immutable safe-v5 snapshot before it reaches persistence. */
export function assertSafePalletLabelSnapshotRenderable(
  snapshot: ImmutablePalletLabelSnapshot,
): void {
  validateSquarePalletLabelSnapshot(snapshot);
  void renderSafePalletLabelSvg(snapshot, SQUARE_RENDERABILITY_TOKEN);
}

/** Capacity validation for the immutable browser-only extended-v6 snapshot. */
export function assertExtendedPalletLabelSnapshotRenderable(
  snapshot: ImmutablePalletLabelSnapshot,
): void {
  validateSquarePalletLabelSnapshot(snapshot);
  void renderExtendedPalletLabelSvg(snapshot, SQUARE_RENDERABILITY_TOKEN);
}

function renderCompactPalletLabelSvg(
  snapshot: ImmutablePalletLabelSnapshot,
  token: string,
): string {
  const handlingAssets = [
    PALLET_LABEL_ASSETS.handling5,
    PALLET_LABEL_ASSETS.handling4,
    PALLET_LABEL_ASSETS.handling3,
    PALLET_LABEL_ASSETS.handling1,
    PALLET_LABEL_ASSETS.handling2,
  ];
  const handlingImages = handlingAssets
    .map((asset, index) => image(asset.dataUri, 37 + index * 34, 36, 32, 32))
    .join('');
  const packagingCount = display(snapshot.packagingCount);
  const grossKg = snapshot.grossKg === null ? '' : snapshot.grossKg.toFixed(3);

  return [
    '<svg id="pallet-label-root" xmlns="http://www.w3.org/2000/svg" ',
    'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="1200" ',
    'viewBox="0 0 800 1200">',
    `<title>${escapeXml(snapshot.productNames.join(' • '))}</title>`,
    '<rect x="0" y="0" width="800" height="1200" fill="#ffffff"/>',
    '<g data-layout-orientation="portrait">',
    '<rect x="34" y="34" width="366" height="1132" fill="none" ',
    'stroke="#000000" stroke-width="2"/>',
    handlingImages,
    image(PALLET_LABEL_ASSETS.logo.dataUri, 207, 36, 118, 32),
    image(PALLET_LABEL_ASSETS.certification.dataUri, 327, 36, 32, 32),
    image(PALLET_LABEL_ASSETS.certification.dataUri, 363, 36, 32, 32),
    compactField('materialMark', COMPACT_CAPTIONS.materialMark, snapshot.materialMark, 14),
    compactField('palletId', COMPACT_CAPTIONS.palletId, snapshot.palletId, 16),
    compactField(
      'orderNumbers',
      COMPACT_CAPTIONS.orderNumbers,
      snapshot.orderNumbers.join(', '),
      16,
    ),
    compactField(
      'customerAliases',
      COMPACT_CAPTIONS.customerAliases,
      snapshot.customerAliases.join(', '),
      16,
    ),
    compactField('createdAt', COMPACT_CAPTIONS.createdAt, snapshot.createdAt, 16),
    compactField(
      'productNames',
      COMPACT_CAPTIONS.productNames,
      snapshot.productNames.join(' • '),
      22,
    ),
    compactField('article', COMPACT_CAPTIONS.article, display(snapshot.article), 20),
    compactField(
      'packagingMaterial',
      COMPACT_CAPTIONS.packagingMaterial,
      display(snapshot.packagingMaterial),
      20,
    ),
    compactField(
      'storageConditions',
      COMPACT_CAPTIONS.storageConditions,
      snapshot.storageConditions,
      16,
    ),
    compactField('packagingCount', COMPACT_CAPTIONS.packagingCount, packagingCount, 16),
    compactField('rollCount', COMPACT_CAPTIONS.rollCount, String(snapshot.rollCount), 18),
    compactField('netKg', COMPACT_CAPTIONS.netKg, snapshot.netKg.toFixed(3), 18),
    compactField('grossKg', COMPACT_CAPTIONS.grossKg, grossKg, 18),
    compactField(
      'productionDate',
      COMPACT_CAPTIONS.productionDate,
      display(snapshot.productionDate),
      18,
    ),
    compactField(
      'shelfLifeMonths',
      COMPACT_CAPTIONS.shelfLifeMonths,
      `${snapshot.shelfLifeMonths} месяцев`,
      18,
    ),
    compactField('deliveryDate', COMPACT_CAPTIONS.deliveryDate, display(snapshot.deliveryDate), 18),
    compactPalletQr(token),
    '</g>',
    '</svg>',
  ].join('');
}

export function packMonochromeBitmap(rgba: Buffer, width: number, height: number): Buffer {
  const supportedRaster =
    width === PALLET_LABEL_PROFILE.widthDots &&
    (height === PALLET_LABEL_PROFILE.heightDots || height === 800);
  if (!supportedRaster || rgba.length !== width * height * 4) {
    throw new Error('pallet raster must be RGBA 800x1200 or 800x800');
  }

  const bytesPerRow = Math.ceil(width / 8);
  const output = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      const alpha = rgba[pixel + 3] / 255;
      const luminance =
        (0.2126 * rgba[pixel] + 0.7152 * rgba[pixel + 1] + 0.0722 * rgba[pixel + 2]) * alpha +
        255 * (1 - alpha);
      if (luminance < 190) {
        output[y * bytesPerRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }
  return output;
}

@Injectable()
export class PalletLabelRenderer {
  constructor(
    private readonly configurable: ConfigurablePalletLabelRenderer = new ConfigurablePalletLabelRenderer(),
  ) {}

  renderPalletLabelSvg(
    snapshot: ImmutablePalletLabelSnapshot,
    token: string,
    profile: PalletLabelSnapshotProfile,
    layoutPublication?: PalletLabelLayoutPublication,
  ): string {
    if (
      profile !== PALLET_LABEL_PROFILE.templateVersion &&
      profile !== 'pallet-100x150-compact-v2' &&
      profile !== 'pallet-100x100-square-v4' &&
      profile !== 'pallet-100x100-safe-v5' &&
      profile !== 'pallet-100x100-extended-v6' &&
      profile !== PALLET_LABEL_CONFIGURABLE_PROFILE
    ) {
      throw new Error(`Unsupported pallet label profile: ${String(profile)}`);
    }
    if (snapshot.templateVersion !== profile) {
      throw new Error('Pallet label profile does not match immutable snapshot');
    }
    if (!isPalletScanToken(token)) {
      throw new Error('Invalid pallet scan token');
    }
    if (profile !== PALLET_LABEL_CONFIGURABLE_PROFILE && layoutPublication) {
      throw new Error('Legacy pallet label cannot carry a configurable layout publication');
    }

    if (profile === PALLET_LABEL_CONFIGURABLE_PROFILE) {
      let publication: PalletLabelLayoutPublication;
      try {
        publication = parsePalletLabelLayoutPublication(layoutPublication);
      } catch {
        throw new Error('Configurable pallet label has invalid publication provenance');
      }
      if (publication.layout.schemaVersion === 1) validateSquarePalletLabelSnapshot(snapshot);
      return this.configurable.renderSvg(snapshot as PalletLabelSnapshot, publication.layout, {
        qrToken: token,
        watermark: false,
      });
    }

    if (profile === 'pallet-100x150-compact-v2') {
      validateCompactPalletLabelSnapshot(snapshot);
      return renderCompactPalletLabelSvg(snapshot, token);
    }
    if (profile === 'pallet-100x100-square-v4') {
      assertSquarePalletLabelSnapshotRenderable(snapshot);
      return renderSquarePalletLabelSvg(snapshot, token);
    }
    if (profile === 'pallet-100x100-safe-v5') {
      assertSafePalletLabelSnapshotRenderable(snapshot);
      return renderSafePalletLabelSvg(snapshot, token);
    }
    if (profile === 'pallet-100x100-extended-v6') {
      assertExtendedPalletLabelSnapshotRenderable(snapshot);
      return renderExtendedPalletLabelSvg(snapshot, token);
    }
    return this.renderV1PalletLabelSvg(snapshot, token);
  }

  private renderV1PalletLabelSvg(snapshot: ImmutablePalletLabelSnapshot, token: string): string {
    const qr = palletQr(token);
    const product = fitProductText(snapshot.productNames.join(' • '), 1080, 96);
    const productTop =
      224 + product.fontSize + (96 - product.lines.length * product.lineHeight) / 2;
    const storageLines = wrapBoldTextToWidth(
      snapshot.storageConditions,
      PALLET_LABEL_LAYOUT.storageText.width - STORAGE_TEXT_RIGHT_PADDING,
      STORAGE_TEXT_FONT_SIZE,
    );
    if (storageLines.length > 9) {
      throw new Error('Pallet label storage text exceeds template v1 capacity');
    }
    const article = display(snapshot.article);
    const packaging = [snapshot.packagingMaterial, snapshot.packagingCount]
      .filter(Boolean)
      .join(' / ');
    const articleFontSize = fitSingleLineText(article, 286, 20, 'article');
    const packagingFontSize = fitSingleLineText(packaging, 474, 20, 'packaging');
    const handlingAssets = [
      PALLET_LABEL_ASSETS.handling5,
      PALLET_LABEL_ASSETS.handling4,
      PALLET_LABEL_ASSETS.handling3,
      PALLET_LABEL_ASSETS.handling1,
      PALLET_LABEL_ASSETS.handling2,
    ];
    const handlingImages = handlingAssets
      .map((asset, index) => image(asset.dataUri, 54 + index * 118, 52, 106, 108))
      .join('');

    return [
      '<svg id="pallet-label-root" xmlns="http://www.w3.org/2000/svg" ',
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="1200" ',
      'viewBox="0 0 800 1200">',
      `<title>${escapeXml(snapshot.productNames.join(' • '))}</title>`,
      '<rect x="0" y="0" width="800" height="1200" fill="#ffffff"/>',
      '<g data-layout-orientation="landscape-rotated-clockwise" ',
      'transform="translate(800 0) rotate(90)">',
      '<rect x="42" y="42" width="1116" height="716" fill="none" ',
      'stroke="#000000" stroke-width="2"/>',
      handlingImages,
      text(700, 145, displayMaterialMark(snapshot.materialMark), {
        size: 20,
        weight: 'bold',
        anchor: 'middle',
      }),
      text(792, 65, CAPTIONS.manufacturer, { size: 11, weight: 'bold', style: 'italic' }),
      image(PALLET_LABEL_ASSETS.logo.dataUri, 790, 72, 340, 88),
      line(42, 180, 1158, 180),
      text(56, 205, CAPTIONS.purpose, { size: 13, weight: 'bold', style: 'italic' }),
      multilineText(600, productTop, product.lines, product.lineHeight, {
        size: product.fontSize,
        weight: 'bold',
        style: 'italic',
        anchor: 'middle',
      }),
      line(42, 334, 1158, 334),
      line(360, 334, 360, 440, 1),
      line(650, 334, 650, 440, 1),
      text(56, 358, CAPTIONS.article, { size: 11, style: 'italic' }),
      text(56, 414, article, { size: articleFontSize, weight: 'bold' }),
      text(505, 358, CAPTIONS.quantity, {
        size: 11,
        weight: 'bold',
        style: 'italic',
        anchor: 'middle',
      }),
      text(505, 418, String(snapshot.rollCount), {
        size: 36,
        weight: 'bold',
        fill: '#ff0000',
        anchor: 'middle',
      }),
      text(664, 358, CAPTIONS.packaging, { size: 12, weight: 'bold', style: 'italic' }),
      text(664, 414, packaging, { size: packagingFontSize, weight: 'bold' }),
      line(42, 440, 1158, 440),
      line(321, 440, 321, 570, 1),
      line(600, 440, 600, 570, 1),
      line(879, 440, 879, 570, 1),
      multilineText(56, 464, wrapText(CAPTIONS.weight, 27), 14, {
        size: 11,
        weight: 'bold',
        style: 'italic',
      }),
      text(181, 532, formatWeight(snapshot.netKg, snapshot.grossKg), {
        size: 20,
        weight: 'bold',
        anchor: 'middle',
      }),
      text(460, 464, CAPTIONS.productionDate, {
        size: 11,
        weight: 'bold',
        style: 'italic',
        anchor: 'middle',
      }),
      text(460, 532, display(snapshot.productionDate), {
        size: 20,
        fill: '#ff0000',
        anchor: 'middle',
      }),
      text(739, 464, CAPTIONS.shelfLife, {
        size: 11,
        style: 'italic',
        anchor: 'middle',
      }),
      text(739, 532, `${snapshot.shelfLifeMonths} месяцев`, {
        size: 22,
        fill: '#ff00ff',
        anchor: 'middle',
      }),
      text(1018, 464, CAPTIONS.deliveryDate, {
        size: 11,
        style: 'italic',
        anchor: 'middle',
      }),
      text(1018, 532, display(snapshot.deliveryDate), { size: 20, anchor: 'middle' }),
      line(42, 570, 1158, 570),
      image(PALLET_LABEL_ASSETS.certification.dataUri, 64, 594, 140, 140),
      image(PALLET_LABEL_ASSETS.certification.dataUri, 222, 594, 140, 140),
      line(392, 570, 392, 758, 1),
      qr,
      text(600, 598, CAPTIONS.conditions, { size: 12, weight: 'bold' }),
      multilineText(600, 624, storageLines, 14, {
        size: STORAGE_TEXT_FONT_SIZE,
        weight: 'bold',
      }),
      '</g>',
      '</svg>',
    ].join('');
  }

  renderPalletLabel(
    snapshot: ImmutablePalletLabelSnapshot,
    token: string,
    profile: PalletLabelSnapshotProfile,
    layoutPublication?: PalletLabelLayoutPublication,
  ): PalletLabelBitmap {
    const svg = this.renderPalletLabelSvg(snapshot, token, profile, layoutPublication);
    const target =
      profile === 'pallet-100x100-square-v4' ||
      profile === 'pallet-100x100-safe-v5' ||
      profile === 'pallet-100x100-extended-v6' ||
      profile === PALLET_LABEL_CONFIGURABLE_PROFILE
        ? { width: 800, height: 800 }
        : { width: PALLET_LABEL_PROFILE.widthDots, height: PALLET_LABEL_PROFILE.heightDots };
    const rendered = new Resvg(svg, {
      background: '#ffffff',
      fitTo: { mode: 'width', value: target.width },
      font: {
        fontFiles,
        loadSystemFonts: false,
        defaultFontFamily: 'DejaVu Sans',
      },
      shapeRendering: 2,
      textRendering: 2,
    }).render();
    if (rendered.width !== target.width || rendered.height !== target.height) {
      throw new Error(`Unexpected pallet raster size: ${rendered.width}x${rendered.height}`);
    }
    return {
      png: rendered.asPng(),
      bitmap: packMonochromeBitmap(rendered.pixels, rendered.width, rendered.height),
      width: target.width,
      height: target.height,
    };
  }
}
