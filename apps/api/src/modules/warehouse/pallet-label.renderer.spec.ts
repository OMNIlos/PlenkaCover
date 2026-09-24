import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as fontkit from '@pdf-lib/fontkit';
import { PALLET_LABEL_PROFILE, type PalletLabelSnapshot } from '@plenka/contracts';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { PALLET_LABEL_ASSETS } from './pallet-label.assets';
import * as palletLabelRendererModule from './pallet-label.renderer';
import {
  assertExtendedPalletLabelSnapshotRenderable,
  assertSafePalletLabelSnapshotRenderable,
  assertSquarePalletLabelSnapshotRenderable,
  COMPACT_PALLET_LABEL_LAYOUT,
  EXTENDED_PALLET_LABEL_LAYOUT,
  PALLET_LABEL_LAYOUT,
  PalletLabelRenderer,
  packMonochromeBitmap,
  SAFE_PALLET_LABEL_LAYOUT,
  SQUARE_PALLET_LABEL_LAYOUT,
} from './pallet-label.renderer';
import { PALLET_STORAGE_CONDITIONS } from './pallet-list.builder';
import {
  LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT,
  PUBLISHED_PALLET_LABEL_LAYOUT,
} from '../../common/pallet-label-layout/pallet-label-layout.validator';
import { PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS } from '../../common/pallet-label-layout/pallet-label-layout-validation-source';
import { formatPalletLabelCreatedAt } from '../../common/pallet-label-layout/pallet-label-semantic-field.renderer';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';

const SAMPLE_SNAPSHOT: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x150-v1',
  palletId: 'ПР-1407-01',
  materialMark: 'ПВД',
  productNames: ['Пленка ПВД полурукав 2000мм 150мкм', 'Пленка ПВД рукав 1500мм 120мкм'],
  article: 'ПВД-ПР-2000-150',
  rollCount: 12,
  packagingMaterial: 'Стрейч-пленка',
  packagingCount: 1,
  netKg: 486.3,
  grossKg: 501.2,
  productionDate: '06.2026–07.2026',
  shelfLifeMonths: 12,
  deliveryDate: '30.07.2026',
  storageConditions: 'Хранить в закрытом сухом помещении при температуре 5–35 °C.',
  orderNumbers: ['A-100', 'B-200', 'C-300'],
  customerAliases: ['Альфа', 'Бета', 'Гамма'],
  createdAt: '2026-07-14T12:00:00.000Z',
};

const PALLET_TOKEN = `plt_${'a'.repeat(64)}`;
const ANOTHER_PALLET_TOKEN = `plt_${'b'.repeat(64)}`;
const fontRoot = dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const probeFont = fontkit.create(readFileSync(join(fontRoot, 'ttf/DejaVuSans-Bold.ttf')));
const FONT_LAYOUT_PROTOTYPE = Object.getPrototypeOf(probeFont) as {
  layout(value: string): unknown;
};

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const blackPixels = (bitmap: Buffer): number =>
  [...bitmap].reduce((sum, byte) => sum + byte.toString(2).replaceAll('0', '').length, 0);

const isBlackPixel = (bitmap: Buffer, x: number, y: number): boolean => {
  const byte = bitmap[y * PALLET_LABEL_PROFILE.bytesPerRow + Math.floor(x / 8)];
  return (byte & (1 << (7 - (x % 8)))) !== 0;
};

const rectangleHasBlackPixel = (
  bitmap: Buffer,
  left: number,
  top: number,
  right: number,
  bottom: number,
): boolean => {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (isBlackPixel(bitmap, x, y)) return true;
    }
  }
  return false;
};

const isBlackLogicalPixel = (bitmap: Buffer, x: number, y: number): boolean =>
  isBlackPixel(bitmap, 799 - y, x);

type Bounds = { x: number; y: number; width: number; height: number };

const COMPACT_LAYOUT = {
  page: { x: 0, y: 0, width: 800, height: 1200 },
  safe: { x: 32, y: 32, width: 370, height: 1136 },
  frame: { x: 34, y: 34, width: 366, height: 1132 },
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

const NON_FIELD_RASTER_BOUNDS = [
  { x: 37, y: 36, width: 32, height: 32 },
  { x: 71, y: 36, width: 32, height: 32 },
  { x: 105, y: 36, width: 32, height: 32 },
  { x: 139, y: 36, width: 32, height: 32 },
  { x: 173, y: 36, width: 32, height: 32 },
  { x: 207, y: 36, width: 118, height: 32 },
  { x: 327, y: 36, width: 32, height: 32 },
  { x: 363, y: 36, width: 32, height: 32 },
  COMPACT_LAYOUT.qr,
] as const satisfies readonly Bounds[];

const EXPECTED_COMPACT_SNAPSHOT_BOUNDS = {
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

const fixedLength = (prefix: string, length: number, fill: string): string =>
  `${prefix}${fill.repeat(length - prefix.length)}`;

const COMPACT_SAMPLE: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x150-compact-v2',
  palletId: 'ПР-1407-01',
  materialMark: 'ПВД',
  productNames: ['Пленка ПВД полурукав 2000мм 150мкм', 'Пленка ПВД рукав 1500мм 120мкм'],
  article: 'ПВД-ПР-2000-150',
  rollCount: 42,
  packagingMaterial: 'Стрейч-пленка',
  packagingCount: 1,
  netKg: 486.3,
  grossKg: 501.2,
  productionDate: '06.2026–07.2026',
  shelfLifeMonths: 12,
  deliveryDate: '30.07.2026',
  storageConditions:
    'Хранить в закрытом сухом помещении при температуре от +5 °C до +40 °C, ' +
    'вдали от нагревательных приборов и прямых солнечных лучей.',
  orderNumbers: ['ORD-2026-001'],
  customerAliases: ['ООО Ромашка'],
  createdAt: '2026-07-14T12:00:00.000Z',
};

const SQUARE_SAMPLE: PalletLabelSnapshot = {
  ...COMPACT_SAMPLE,
  templateVersion: 'pallet-100x100-square-v4',
  palletId: 'PAL-A-2-01',
  productNames: ['Пленка полиэтиленовая рукав 29мкм'],
  rollCount: 1,
  rollCodes: ['A-2-roll-1'],
  netKg: 7.95,
  grossKg: 8.6,
  orderNumbers: ['A-2'],
  customerAliases: ['СТН-М АО'],
};

const SAFE_SAMPLE: PalletLabelSnapshot = {
  ...SQUARE_SAMPLE,
  templateVersion: 'pallet-100x100-safe-v5',
};

const EXTENDED_SAMPLE: PalletLabelSnapshot = {
  ...SQUARE_SAMPLE,
  templateVersion: 'pallet-100x100-extended-v6',
};

const MAXIMUM_SNAPSHOT: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x150-compact-v2',
  palletId: fixedLength('PALLET-', 200, '9'),
  materialMark: fixedLength('МАТЕРИАЛ-', 100, 'М'),
  productNames: Array.from({ length: 4 }, (_, index) =>
    fixedLength(`ТОВАР-${index + 1}-`, 250, 'Ш'),
  ),
  article: fixedLength('ARTICLE-', 100, 'A'),
  rollCount: 10_000,
  packagingMaterial: fixedLength('УПАКОВКА-', 200, 'У'),
  packagingCount: 100_000,
  netKg: 999_999_999.999,
  grossKg: 999_999_999.999,
  productionDate: '01.1900–12.9999',
  shelfLifeMonths: 12,
  deliveryDate: '31.12.9999',
  storageConditions: fixedLength('ХРАНЕНИЕ-', 500, 'Х'),
  orderNumbers: [fixedLength('ORDER-', 100, '9')],
  customerAliases: [fixedLength('ЗАКАЗЧИК-', 300, 'З')],
  createdAt: '9999-12-31T23:59:59.999Z',
};

const WIDEST_MAXIMUM_SNAPSHOT: PalletLabelSnapshot = {
  ...MAXIMUM_SNAPSHOT,
  palletId: 'W'.repeat(200),
  materialMark: 'W'.repeat(100),
  productNames: Array.from({ length: 4 }, () => 'W'.repeat(250)),
  article: 'W'.repeat(100),
  packagingMaterial: 'W'.repeat(200),
  storageConditions: 'W'.repeat(500),
  orderNumbers: ['W'.repeat(100)],
  customerAliases: ['W'.repeat(300)],
};

const REQUIRED_BUSINESS_FIELDS = [
  'palletId',
  'materialMark',
  'productNames',
  'article',
  'rollCount',
  'packagingMaterial',
  'packagingCount',
  'netKg',
  'grossKg',
  'productionDate',
  'shelfLifeMonths',
  'deliveryDate',
  'storageConditions',
  'orderNumbers',
  'customerAliases',
  'createdAt',
] as const;

const decodeXml = (value: string): string =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

const businessFieldValue = (
  svg: string,
  field: (typeof REQUIRED_BUSINESS_FIELDS)[number],
): string => {
  const group = svg.match(new RegExp(`<g data-business-field="${field}"[^>]*>(.*?)</g>`))?.[1];
  if (!group) throw new Error(`Missing compact business field ${field}`);
  const value = group.match(/<desc data-business-value="true">(.*?)<\/desc>/)?.[1];
  if (value === undefined) throw new Error(`Missing compact business value ${field}`);
  return decodeXml(value);
};

const bitmapToRgba = (
  bitmap: Buffer,
  width: number = PALLET_LABEL_PROFILE.widthDots,
  height: number = PALLET_LABEL_PROFILE.heightDots,
): Uint8ClampedArray => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = isBlackPixel(bitmap, x, y) ? 0 : 255;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
};

const blackPixelBounds = (bitmap: Buffer, width: number, height: number): Bounds => {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isBlackPixel(bitmap, x, y)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};

const changedPixelBounds = (
  first: Buffer,
  second: Buffer,
): Bounds & { count: number; right: number; bottom: number } => {
  let left: number = PALLET_LABEL_PROFILE.widthDots;
  let top: number = PALLET_LABEL_PROFILE.heightDots;
  let right = -1;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < PALLET_LABEL_PROFILE.heightDots; y += 1) {
    for (let x = 0; x < PALLET_LABEL_PROFILE.widthDots; x += 1) {
      if (isBlackPixel(first, x, y) === isBlackPixel(second, x, y)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
      count += 1;
    }
  }
  return {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
    right,
    bottom,
    count,
  };
};

const changedPixelsInBounds = (first: Buffer, second: Buffer, bounds: Bounds): number => {
  let count = 0;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (isBlackPixel(first, x, y) !== isBlackPixel(second, x, y)) count += 1;
    }
  }
  return count;
};

const aggregateSnapshotCharacters = (snapshot: PalletLabelSnapshot): number =>
  [
    snapshot.palletId,
    snapshot.materialMark,
    ...snapshot.productNames,
    snapshot.article,
    snapshot.packagingMaterial,
    snapshot.productionDate,
    snapshot.deliveryDate,
    snapshot.storageConditions,
    ...snapshot.orderNumbers,
    ...snapshot.customerAliases,
    snapshot.createdAt,
  ].reduce((total, value) => total + (value?.length ?? 0), 0);

describe('PalletLabelRenderer', () => {
  const renderer = new PalletLabelRenderer();
  const renderV1 = (snapshot: PalletLabelSnapshot, token: string) =>
    renderer.renderPalletLabel(snapshot, token, PALLET_LABEL_PROFILE.templateVersion);
  const renderV1Svg = (snapshot: PalletLabelSnapshot, token: string) =>
    renderer.renderPalletLabelSvg(snapshot, token, PALLET_LABEL_PROFILE.templateVersion);

  it('renders one deterministic 800x1200 label, its QR and seven unique source assets', () => {
    const rendered = renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    const svg = renderV1Svg(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    const imageHrefs = [...svg.matchAll(/href="(data:image\/png;base64,[^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(rendered.width).toBe(800);
    expect(rendered.height).toBe(1200);
    expect(rendered.bitmap).toHaveLength(120_000);
    expect(rendered.png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(imageHrefs).toHaveLength(8);
    expect(new Set(imageHrefs).size).toBe(7);
    expect(imageHrefs.slice(0, 5)).toEqual([
      PALLET_LABEL_ASSETS.handling5.dataUri,
      PALLET_LABEL_ASSETS.handling4.dataUri,
      PALLET_LABEL_ASSETS.handling3.dataUri,
      PALLET_LABEL_ASSETS.handling1.dataUri,
      PALLET_LABEL_ASSETS.handling2.dataUri,
    ]);
    expect(svg).toContain(PALLET_LABEL_ASSETS.logo.dataUri);
    expect(svg).toContain('Пленка ПВД полурукав 2000мм 150мкм');
    expect(svg).toContain('Пленка ПВД рукав 1500мм 120мкм');
    expect(svg).toContain('>PE-LD</text>');
    expect(svg).toContain('ПВД-ПР-2000-150');
    expect(svg).toContain('Стрейч-пленка / 1');
    expect(svg).toContain('12 месяцев');
    expect(svg).toContain('486.300 / 501.200');
    expect(svg).toContain('06.2026–07.2026');
    expect(svg).toContain('30.07.2026');
    expect(svg).toContain('Хранить в закрытом сухом помещении');
    expect(svg).toContain('data-pallet-qr="true"');
    expect(svg).toContain('data-qr-module-count="37"');
    expect(svg).not.toContain(PALLET_TOKEN);
    expect(renderV1Svg(SAMPLE_SNAPSHOT, ANOTHER_PALLET_TOKEN)).not.toEqual(svg);
    expect(svg).not.toContain('duplicate-copy');
    expect(svg).not.toContain('…');
    expect(svg.match(/id="pallet-label-root"/g)).toHaveLength(1);
  });

  it('locks the approved rotated landscape geometry and a 40-dot hardware-safe margin', () => {
    expect(PALLET_LABEL_LAYOUT).toEqual({
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
    });
    expect(PALLET_LABEL_LAYOUT.qr.x - PALLET_LABEL_LAYOUT.storage.x).toBe(8);
    expect(PALLET_LABEL_LAYOUT.qr.y - PALLET_LABEL_LAYOUT.storage.y).toBe(4);
    expect(
      PALLET_LABEL_LAYOUT.storageText.x - (PALLET_LABEL_LAYOUT.qr.x + PALLET_LABEL_LAYOUT.qr.width),
    ).toBe(20);
    expect(
      PALLET_LABEL_LAYOUT.storage.y +
        PALLET_LABEL_LAYOUT.storage.height -
        (PALLET_LABEL_LAYOUT.qr.y + PALLET_LABEL_LAYOUT.qr.height),
    ).toBe(4);

    const svg = renderV1Svg(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    expect(svg).toContain('data-layout-orientation="landscape-rotated-clockwise"');
    expect(svg).toContain('transform="translate(800 0) rotate(90)"');

    const { bitmap } = renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    const margin = 40;
    expect(rectangleHasBlackPixel(bitmap, 0, 0, 800, margin)).toBe(false);
    expect(rectangleHasBlackPixel(bitmap, 0, 1200 - margin, 800, 1200)).toBe(false);
    expect(rectangleHasBlackPixel(bitmap, 0, margin, margin, 1200 - margin)).toBe(false);
    expect(rectangleHasBlackPixel(bitmap, 800 - margin, margin, 800, 1200 - margin)).toBe(false);
    expect(blackPixels(bitmap) / (800 * 1200)).toBeGreaterThan(0.05);
    expect(blackPixels(bitmap) / (800 * 1200)).toBeLessThan(0.55);
  });

  it('keeps the production storage conditions inside their frame and hardware-safe margin', () => {
    const production = renderV1(
      { ...SAMPLE_SNAPSHOT, storageConditions: PALLET_STORAGE_CONDITIONS },
      PALLET_TOKEN,
    ).bitmap;
    const empty = renderV1({ ...SAMPLE_SNAPSHOT, storageConditions: '' }, PALLET_TOKEN).bitmap;
    let storageTextPixels = 0;

    for (let physicalY = 0; physicalY < PALLET_LABEL_PROFILE.heightDots; physicalY += 1) {
      for (let physicalX = 0; physicalX < PALLET_LABEL_PROFILE.widthDots; physicalX += 1) {
        if (!isBlackPixel(production, physicalX, physicalY)) continue;
        if (isBlackPixel(empty, physicalX, physicalY)) continue;

        storageTextPixels += 1;
        const logicalX = physicalY;
        expect(logicalX).toBeGreaterThanOrEqual(PALLET_LABEL_LAYOUT.storageText.x);
        expect(logicalX).toBeLessThan(
          PALLET_LABEL_LAYOUT.storageText.x + PALLET_LABEL_LAYOUT.storageText.width,
        );
      }
    }

    expect(storageTextPixels).toBeGreaterThan(0);
    const margin = PALLET_LABEL_LAYOUT.safe.x;
    expect(rectangleHasBlackPixel(production, 0, 0, 800, margin)).toBe(false);
    expect(rectangleHasBlackPixel(production, 0, 1200 - margin, 800, 1200)).toBe(false);
    expect(rectangleHasBlackPixel(production, 0, margin, margin, 1200 - margin)).toBe(false);
    expect(rectangleHasBlackPixel(production, 800 - margin, margin, 800, 1200 - margin)).toBe(
      false,
    );
  });

  it('preserves the Version 5 / ECC M matrix and white quiet zone after raster rotation', () => {
    const { bitmap } = renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    const expected = QRCode.create(PALLET_TOKEN, { version: 5, errorCorrectionLevel: 'M' });
    const moduleSize = 4;
    const quietZone = 4 * moduleSize;
    const matrixX = PALLET_LABEL_LAYOUT.qr.x + quietZone;
    const matrixY = PALLET_LABEL_LAYOUT.qr.y + quietZone;

    expect(expected.modules.size).toBe(37);
    for (let row = 0; row < expected.modules.size; row += 1) {
      for (let column = 0; column < expected.modules.size; column += 1) {
        expect(
          isBlackLogicalPixel(
            bitmap,
            matrixX + column * moduleSize + 2,
            matrixY + row * moduleSize + 2,
          ),
        ).toBe(expected.modules.get(row, column) === 1);
      }
    }

    for (let y = PALLET_LABEL_LAYOUT.qr.y; y < PALLET_LABEL_LAYOUT.qr.y + 180; y += 1) {
      for (let x = PALLET_LABEL_LAYOUT.qr.x; x < PALLET_LABEL_LAYOUT.qr.x + 180; x += 1) {
        const insideMatrix =
          x >= matrixX &&
          x < matrixX + 37 * moduleSize &&
          y >= matrixY &&
          y < matrixY + 37 * moduleSize;
        if (!insideMatrix) expect(isBlackLogicalPixel(bitmap, x, y)).toBe(false);
      }
    }
  });

  it('rejects a raster that is not the fixed printer profile', () => {
    expect(() => packMonochromeBitmap(Buffer.alloc(4), 1, 1)).toThrow(
      'pallet raster must be RGBA 800x1200 or 800x800',
    );
  });

  it('is byte-deterministic and refuses to truncate over-capacity text fields', () => {
    expect(renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN).png).toEqual(
      renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN).png,
    );
    expect(() =>
      renderV1Svg({ ...SAMPLE_SNAPSHOT, productNames: ['Товар'.repeat(2_000)] }, PALLET_TOKEN),
    ).toThrow('Pallet label product text exceeds template v1 capacity');
    expect(() =>
      renderV1Svg({ ...SAMPLE_SNAPSHOT, article: 'A'.repeat(100) }, PALLET_TOKEN),
    ).toThrow('Pallet label article text exceeds template v1 capacity');
    expect(() =>
      renderV1Svg({ ...SAMPLE_SNAPSHOT, packagingMaterial: 'P'.repeat(200) }, PALLET_TOKEN),
    ).toThrow('Pallet label packaging text exceeds template v1 capacity');
    expect(() =>
      renderV1Svg(
        { ...SAMPLE_SNAPSHOT, storageConditions: 'Условия '.repeat(1_000) },
        PALLET_TOKEN,
      ),
    ).toThrow('Pallet label storage text exceeds template v1 capacity');
  });

  it('rejects anything except an exact opaque pallet token', () => {
    expect(() => renderV1(SAMPLE_SNAPSHOT, `prt_${'a'.repeat(64)}`)).toThrow(
      'Invalid pallet scan token',
    );
    expect(() => renderV1(SAMPLE_SNAPSHOT, `${PALLET_TOKEN}\n`)).toThrow(
      'Invalid pallet scan token',
    );
  });

  it('locks the exact v1 SVG, PNG and printer-bitmap bytes', () => {
    const svg = renderV1Svg(SAMPLE_SNAPSHOT, PALLET_TOKEN);
    const { png, bitmap } = renderV1(SAMPLE_SNAPSHOT, PALLET_TOKEN);

    expect(sha256(svg)).toBe('63c4cb48986639665e51308d26b5ae8fdec6fd4f76d2ddd8ceab9a20870f57d7');
    expect(sha256(png)).toBe('d3306e9ac4105fb0bc7f093af8ffcc03afb553a597c78ac8f1f0fecad3f6ee97');
    expect(sha256(bitmap)).toBe('c114f7f3ab71ac42089cfda5279570ec417890826e16ca756b887b4559739ced');
  });
});

describe('PalletLabelRenderer configurable-v7', () => {
  const renderer = new PalletLabelRenderer();
  const layout = structuredClone(LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT);
  const publication = {
    id: 'publication-1',
    version: 1,
    contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
    activatedAt: '2026-08-11T18:30:00.000Z',
    layout,
  };
  const snapshot: PalletLabelSnapshot = {
    ...EXTENDED_SAMPLE,
    templateVersion: 'pallet-100x100-configurable-v7',
  };

  it.each([
    ['2026-07-14T12:00:00.000Z', 'Сформировано: 14.07.2026 15:00 МСК'],
    ['2026-12-31T22:30:00.000Z', 'Сформировано: 01.01.2027 01:30 МСК'],
  ])('shares canonical Moscow createdAt formatting for %s', (createdAt, expected) => {
    expect(formatPalletLabelCreatedAt(createdAt)).toBe(expected);
  });

  it('renders the pinned layout with the document QR and no admin watermark', () => {
    const svg = renderer.renderPalletLabelSvg(
      snapshot,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    const rendered = renderer.renderPalletLabel(
      snapshot,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    const decoded = jsQR(bitmapToRgba(rendered.bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });

    expect(rendered).toMatchObject({ width: 800, height: 800 });
    expect(svg).not.toContain('ЧЕРНОВИК МАКЕТА');
    expect(svg).not.toContain('data-preview-qr="true"');
    expect(decoded?.data).toBe(PALLET_TOKEN);
  });

  it('maps configurable blocks to the proven extended-v6 semantic field capacities', () => {
    const svg = renderer.renderPalletLabelSvg(
      snapshot,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );

    for (const [field, bounds] of [
      ['palletId', '36,32,600,48'],
      ['orderNumbers', '36,92,390,32'],
      ['customerAliases', '36,126,390,40'],
      ['productNames', '36,170,390,84'],
      ['article', '36,258,390,30'],
      ['createdAt', '36,292,390,18'],
      ['materialMark', '449,415,315,26'],
      ['rollCount', '449,445,90,24'],
      ['netKg', '543,445,221,24'],
      ['productionDate', '449,473,315,56'],
      ['packagingMaterial', '36,594,728,28'],
      ['storageConditions', '36,628,728,128'],
    ] as const) {
      expect(svg).toContain(`data-business-field="${field}" data-field-bounds="${bounds}"`);
    }
    expect(svg).toContain('x="658" y="41" width="98" height="27"');
  });

  it.each([
    ['a 26-character unbroken article', { article: 'Ш'.repeat(26) }],
    ['a 44-character unbroken packaging value', { packagingMaterial: 'Ш'.repeat(44) }],
  ] as const)('dominates extended-v6 capacity for %s', (_caseName, override) => {
    const legacySnapshot: PalletLabelSnapshot = {
      ...PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS[0].snapshot,
      ...override,
    };
    const configurableSnapshot: PalletLabelSnapshot = {
      ...legacySnapshot,
      templateVersion: 'pallet-100x100-configurable-v7',
    };

    expect(() => assertExtendedPalletLabelSnapshotRenderable(legacySnapshot)).not.toThrow();
    expect(() =>
      renderer.renderPalletLabelSvg(
        configurableSnapshot,
        PALLET_TOKEN,
        'pallet-100x100-configurable-v7',
        publication,
      ),
    ).not.toThrow();
  });

  it('keeps a builder-shaped four-product boundary renderable at the baseline width', () => {
    const legacySnapshot: PalletLabelSnapshot = {
      ...PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS[0].snapshot,
      article: null,
      productNames: [
        'Пленка полиэтиленовая рукав 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая полурукав 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая полотно 999мкм 9999мм 9999м',
        'Пленка полиэтиленовая фальц 999мкм 9999мм 9999м',
      ],
    };
    const configurableSnapshot: PalletLabelSnapshot = {
      ...legacySnapshot,
      templateVersion: 'pallet-100x100-configurable-v7',
    };

    expect(() => assertExtendedPalletLabelSnapshotRenderable(legacySnapshot)).not.toThrow();
    expect(() =>
      renderer.renderPalletLabelSvg(
        configurableSnapshot,
        PALLET_TOKEN,
        'pallet-100x100-configurable-v7',
        publication,
      ),
    ).not.toThrow();
  });

  it('renders a safe pre-policy publication without applying new admission rules retroactively', () => {
    const historicalLayout = structuredClone(layout);
    historicalLayout.elements.find((element) => element.id === 'product')!.widthDots = 332;
    const historicalPublication = {
      ...publication,
      id: 'historical-publication-1',
      layout: historicalLayout,
      contentHash: createHash('sha256')
        .update(JSON.stringify(historicalLayout), 'utf8')
        .digest('hex'),
    };

    expect(() =>
      renderer.renderPalletLabelSvg(
        snapshot,
        PALLET_TOKEN,
        'pallet-100x100-configurable-v7',
        historicalPublication,
      ),
    ).not.toThrow();
  });

  it('renders every server-owned v6 conformance case through an approved v7 publication', () => {
    const cases = Object.fromEntries(
      PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS.map((testCase) => [testCase.id, testCase.snapshot]),
    );
    expect(PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS).toHaveLength(2);
    expect(cases['combined-builder-operational'].productNames).toHaveLength(4);
    expect(
      cases['combined-builder-operational'].productNames.every((name) => name.length >= 39),
    ).toBe(true);
    expect(cases['combined-builder-operational'].storageConditions).toHaveLength(319);
    expect(cases['combined-builder-operational'].rollCodes).toHaveLength(24);
    expect(cases['combined-wide-unbroken'].rollCodes).toHaveLength(24);

    for (const testCase of PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS) {
      expect(() => assertExtendedPalletLabelSnapshotRenderable(testCase.snapshot)).not.toThrow();
      const configurableSnapshot: PalletLabelSnapshot = {
        ...testCase.snapshot,
        templateVersion: 'pallet-100x100-configurable-v7',
      };

      expect(
        renderer.renderPalletLabelSvg(
          configurableSnapshot,
          PALLET_TOKEN,
          'pallet-100x100-configurable-v7',
          publication,
        ),
      ).toContain('<svg');
      expect(
        renderer.renderPalletLabel(
          configurableSnapshot,
          PALLET_TOKEN,
          'pallet-100x100-configurable-v7',
          publication,
        ),
      ).toMatchObject({ width: 800, height: 800 });
    }
  });

  it('fits every production conformance case into the compact right-shifted layout', () => {
    const compactLayout = rightShiftedCompactPalletLabelLayout();
    const compactPublication = {
      ...publication,
      id: 'publication-right-shifted',
      layout: compactLayout,
      contentHash: createHash('sha256').update(JSON.stringify(compactLayout), 'utf8').digest('hex'),
    };

    for (const testCase of PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS) {
      const compactSnapshot: PalletLabelSnapshot = {
        ...testCase.snapshot,
        templateVersion: 'pallet-100x100-configurable-v7',
      };
      const svg = renderer.renderPalletLabelSvg(
        compactSnapshot,
        PALLET_TOKEN,
        'pallet-100x100-configurable-v7',
        compactPublication,
      );
      const rendered = renderer.renderPalletLabel(
        compactSnapshot,
        PALLET_TOKEN,
        'pallet-100x100-configurable-v7',
        compactPublication,
      );

      expect(svg).toContain('data-element-bounds="272,40,504,32"');
      expect(svg).toContain('data-element-bounds="280,320,160,232"');
      expect(svg).toContain('data-element-bounds="424,576,352,48"');
      expect(svg).toContain('data-fit-mode="emergency"');
      expect(
        [...svg.matchAll(/data-fit-font-size="(\d+)"/gu)].every(
          ([, fontSize]) => Number(fontSize) >= 4,
        ),
      ).toBe(true);
      expect(svg).toContain(testCase.snapshot.rollCodes.at(-1)!);
      expect(rendered).toMatchObject({ width: 800, height: 800 });
    }
  });

  it('keeps combinable builder fields and wide unbroken values in the operational corpus', () => {
    const cases = Object.fromEntries(
      PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS.map((testCase) => [testCase.id, testCase.snapshot]),
    );

    expect(cases).toEqual(
      expect.objectContaining({
        'combined-builder-operational': expect.objectContaining({
          productNames: expect.arrayContaining([
            'Пленка полиэтиленовая рукав 120мкм 1500мм',
            'Пленка полиэтиленовая полурукав 90мкм 1200мм',
            'Пленка полиэтиленовая полотно 70мкм 900мм',
            'Пленка полиэтиленовая фальц 50мкм 600мм',
          ]),
          materialMark: 'ПЭВД 10803-020 / ПЭВД 15803-020 / ПЭВД 15303-003',
          storageConditions: PALLET_STORAGE_CONDITIONS,
          orderNumbers: ['ЗАКАЗ-ПРОИЗВОДСТВО-2026-08-12-000001'],
          customerAliases: ['ООО ЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗ'],
          rollCount: 24,
          rollCodes: expect.arrayContaining(['PLK-20260812-01', 'PLK-20260812-24']),
        }),
        'combined-wide-unbroken': expect.objectContaining({
          palletId: 'Ш'.repeat(13),
          materialMark: 'Ш'.repeat(25),
          article: 'Ш'.repeat(26),
          packagingMaterial: 'Ш'.repeat(44),
          orderNumbers: ['З'.repeat(38)],
          customerAliases: ['ООО ЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗЗ'],
          rollCount: 24,
          rollCodes: expect.arrayContaining([`01-${'Ш'.repeat(9)}`, `24-${'Ш'.repeat(9)}`]),
        }),
      }),
    );
  });

  it('rejects missing or hash-mismatched publication provenance', () => {
    expect(() =>
      renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, 'pallet-100x100-configurable-v7'),
    ).toThrow('invalid publication provenance');
    expect(() =>
      renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, 'pallet-100x100-configurable-v7', {
        ...publication,
        contentHash: '0'.repeat(64),
      }),
    ).toThrow('invalid publication provenance');
  });

  it('rejects hash-consistent publication content that is unsafe to publish', () => {
    const unsafeLayout = structuredClone(layout);
    unsafeLayout.elements.find((element) => element.id === 'header')!.xDots = 0;

    expect(() =>
      renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, 'pallet-100x100-configurable-v7', {
        ...publication,
        layout: unsafeLayout,
        contentHash: createHash('sha256')
          .update(JSON.stringify(unsafeLayout), 'utf8')
          .digest('hex'),
      }),
    ).toThrow('invalid publication provenance');
  });

  it('rejects non-canonical or extended publication envelopes', () => {
    const invalidEnvelopes = [
      { ...publication, id: 42 },
      { ...publication, activatedAt: '2026-08-11T18:30:00Z' },
      { ...publication, internalDeviceHint: 'must-never-be-stored' },
    ];

    for (const invalidEnvelope of invalidEnvelopes) {
      expect(() =>
        renderer.renderPalletLabelSvg(
          snapshot,
          PALLET_TOKEN,
          'pallet-100x100-configurable-v7',
          invalidEnvelope as never,
        ),
      ).toThrow('invalid publication provenance');
    }
  });
});

describe('PalletLabelRenderer configurable-v7 schema V2', () => {
  const renderer = new PalletLabelRenderer();
  const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
  const publication = {
    id: 'publication-v2-1',
    version: 2,
    contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
    activatedAt: '2026-08-14T09:00:00.000Z',
    layout,
  };
  const snapshot: PalletLabelSnapshot = {
    ...EXTENDED_SAMPLE,
    templateVersion: 'pallet-100x100-configurable-v7',
    palletId: 'FORBIDDEN-PALLET-ID',
    materialMark: 'FORBIDDEN-MATERIAL',
    productNames: ['FORBIDDEN-PRODUCT'],
    article: 'FORBIDDEN-ARTICLE',
    packagingMaterial: 'FORBIDDEN-PACKAGING',
    productionDate: '01.2099–02.2099',
    deliveryDate: '31.12.2099',
    orderNumbers: ['A-2'],
    customerAliases: ['СТН-М АО'],
    rollCount: 2,
    rollCodes: ['FORBIDDEN-ROLL-1', 'FORBIDDEN-ROLL-2'],
    createdAt: '2026-08-09T12:00:00.000Z',
    storageConditions: 'Хранение в сухом помещении.',
  };

  it('uses the pinned V2 layout and document QR for official preview and print bytes', () => {
    const svg = renderer.renderPalletLabelSvg(
      snapshot,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    const rendered = renderer.renderPalletLabel(
      snapshot,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    const decoded = jsQR(bitmapToRgba(rendered.bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });

    expect([...svg.matchAll(/data-layout-element="([^"]+)"/gu)].map((match) => match[1])).toEqual([
      'order',
      'customer',
      'formedAt',
      'rollCount',
      'storage',
      'qr',
    ]);
    expect(svg).toContain('Заказ: A-2');
    expect(svg).toContain('Заказчик: СТН-М АО');
    expect(svg).toContain('Сформировано: 09.08.2026 15:00 МСК');
    expect(svg).toContain('Рулонов на палете: 2');
    expect(svg).toContain('Хранение в сухом помещении.');
    expect(svg).not.toContain('FORBIDDEN-');
    expect(svg).not.toContain('01.2099–02.2099');
    expect(svg).not.toContain('31.12.2099');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('ЧЕРНОВИК МАКЕТА');
    expect(rendered).toMatchObject({ width: 800, height: 800 });
    expect(decoded?.data).toBe(PALLET_TOKEN);
  });

  it('renders an existing 31-roll document when the V2 layout prints only the roll count', () => {
    const rollCodes = Array.from({ length: 31 }, (_, index) => `ROLL-${index + 1}`);
    const largePallet = { ...snapshot, rollCount: 31, rollCodes };

    const svg = renderer.renderPalletLabelSvg(
      largePallet,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    const rendered = renderer.renderPalletLabel(
      largePallet,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );

    expect(svg).toContain('Рулонов на палете: 31');
    expect(svg).not.toContain('ROLL-1');
    expect(svg).not.toContain('ROLL-31');
    expect(rendered).toMatchObject({ width: 800, height: 800 });
  });
});

describe('PalletLabelRenderer compact-v2', () => {
  const renderer = new PalletLabelRenderer();
  const profile = 'pallet-100x150-compact-v2' as const;

  it('uses the exact half-width frame and doubled compact QR geometry', () => {
    expect(COMPACT_PALLET_LABEL_LAYOUT.page).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 1200,
    });
    expect(COMPACT_PALLET_LABEL_LAYOUT.frame.width).toBe(366);
    expect(COMPACT_PALLET_LABEL_LAYOUT.frame.width).toBe(732 / 2);
    expect(COMPACT_PALLET_LABEL_LAYOUT.qr).toMatchObject({
      width: 360,
      height: 360,
    });
    expect(COMPACT_PALLET_LABEL_LAYOUT.qr.width).toBe(180 * 2);
    expect(COMPACT_PALLET_LABEL_LAYOUT.qr.height).toBe(180 * 2);
    expect(COMPACT_PALLET_LABEL_LAYOUT.qr.width).toBe(COMPACT_PALLET_LABEL_LAYOUT.frame.width - 6);
    const moduleSize = 8;
    const matrixSize = 37 * moduleSize;
    const quietZone = 4 * moduleSize;
    expect(matrixSize).toBe(296);
    expect(quietZone).toBe(32);
    expect(matrixSize + quietZone * 2).toBe(COMPACT_PALLET_LABEL_LAYOUT.qr.width);
  });

  it('exports the fail-closed physical-label domain and reaches every accepted maximum', () => {
    const exportedBounds = (
      palletLabelRendererModule as unknown as {
        COMPACT_PALLET_LABEL_SNAPSHOT_BOUNDS: unknown;
      }
    ).COMPACT_PALLET_LABEL_SNAPSHOT_BOUNDS;

    expect(exportedBounds).toEqual(EXPECTED_COMPACT_SNAPSHOT_BOUNDS);
    expect(MAXIMUM_SNAPSHOT.palletId).toHaveLength(200);
    expect(MAXIMUM_SNAPSHOT.materialMark).toHaveLength(100);
    expect(MAXIMUM_SNAPSHOT.productNames).toHaveLength(4);
    expect(MAXIMUM_SNAPSHOT.productNames.every((value) => value.length === 250)).toBe(true);
    expect(MAXIMUM_SNAPSHOT.article).toHaveLength(100);
    expect(MAXIMUM_SNAPSHOT.packagingMaterial).toHaveLength(200);
    expect(MAXIMUM_SNAPSHOT.storageConditions).toHaveLength(500);
    expect(MAXIMUM_SNAPSHOT.orderNumbers).toHaveLength(1);
    expect(MAXIMUM_SNAPSHOT.orderNumbers[0]).toHaveLength(100);
    expect(MAXIMUM_SNAPSHOT.customerAliases).toHaveLength(1);
    expect(MAXIMUM_SNAPSHOT.customerAliases[0]).toHaveLength(300);
    expect(aggregateSnapshotCharacters(MAXIMUM_SNAPSHOT)).toBe(2_549);
  });

  it('requires an explicit profile and rejects a snapshot/profile mismatch before rendering', () => {
    expect(() =>
      renderer.renderPalletLabel(MAXIMUM_SNAPSHOT, PALLET_TOKEN, 'pallet-100x150-v1'),
    ).toThrow('Pallet label profile does not match immutable snapshot');
  });

  it('rejects excessive lists and strings before font shaping or QR generation', () => {
    const layoutSpy = jest.spyOn(FONT_LAYOUT_PROTOTYPE, 'layout');
    const qrSpy = jest.spyOn(QRCode, 'create');

    try {
      expect(() =>
        renderer.renderPalletLabelSvg(
          {
            ...COMPACT_SAMPLE,
            productNames: Array.from({ length: 10 }, (_, index) => `Товар ${index + 1}`),
          },
          PALLET_TOKEN,
          profile,
        ),
      ).toThrow(/productNames.*maximum 4.*split/u);
      expect(() =>
        renderer.renderPalletLabelSvg(
          {
            ...COMPACT_SAMPLE,
            customerAliases: ['З'.repeat(5_000)],
          },
          PALLET_TOKEN,
          profile,
        ),
      ).toThrow(/customerAliases\[0\].*maximum 300/u);
      expect(layoutSpy).not.toHaveBeenCalled();
      expect(qrSpy).not.toHaveBeenCalled();
    } finally {
      layoutSpy.mockRestore();
      qrSpy.mockRestore();
    }
  });

  it.each([
    ['fractional rollCount', { rollCount: 1.5 }, 'rollCount must be an integer'],
    ['oversize packagingCount', { packagingCount: 100_001 }, 'packagingCount must be at most'],
    ['non-finite netKg', { netKg: Number.NaN }, 'netKg must be finite'],
    ['non-finite grossKg', { grossKg: Number.POSITIVE_INFINITY }, 'grossKg must be finite'],
    ['invalid productionDate', { productionDate: '13.2026' }, 'productionDate must match'],
    ['invalid deliveryDate', { deliveryDate: '31.02.2026' }, 'deliveryDate must be a valid date'],
    ['invalid createdAt', { createdAt: '2026-02-30T00:00:00.000Z' }, 'createdAt must be canonical'],
    [
      'control characters',
      { customerAliases: ['ООО Ромашка\nскрытая строка'] },
      'customerAliases[0] contains control characters',
    ],
  ])('rejects %s before layout', (_caseName, changes, message) => {
    const layoutSpy = jest.spyOn(FONT_LAYOUT_PROTOTYPE, 'layout');
    const qrSpy = jest.spyOn(QRCode, 'create');

    try {
      expect(() =>
        renderer.renderPalletLabelSvg({ ...COMPACT_SAMPLE, ...changes }, PALLET_TOKEN, profile),
      ).toThrow(message);
      expect(layoutSpy).not.toHaveBeenCalled();
      expect(qrSpy).not.toHaveBeenCalled();
    } finally {
      layoutSpy.mockRestore();
      qrSpy.mockRestore();
    }
  });

  it('renders exact accepted maxima completely at a readable font size', () => {
    const rendered = renderer.renderPalletLabel(MAXIMUM_SNAPSHOT, PALLET_TOKEN, profile);
    const svg = renderer.renderPalletLabelSvg(MAXIMUM_SNAPSHOT, PALLET_TOKEN, profile);

    expect(rendered).toMatchObject({
      width: PALLET_LABEL_PROFILE.widthDots,
      height: PALLET_LABEL_PROFILE.heightDots,
    });
    expect(rendered.bitmap).toHaveLength(PALLET_LABEL_PROFILE.bitmapBytes);
    expect(svg).toContain('width="800" height="1200" viewBox="0 0 800 1200"');
    expect(svg).toContain('data-layout-orientation="portrait"');
    expect(svg).not.toContain('rotate(');
    expect(svg).not.toContain('…');
    const fittedFontSizes = [...svg.matchAll(/data-fit-font-size="(\d+)"/g)].map((match) =>
      Number(match[1]),
    );
    const imageHrefs = [...svg.matchAll(/href="(data:image\/png;base64,[^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(fittedFontSizes).toHaveLength(REQUIRED_BUSINESS_FIELDS.length);
    expect(Math.min(...fittedFontSizes)).toBe(EXPECTED_COMPACT_SNAPSHOT_BOUNDS.minimumFontSize);
    expect(imageHrefs).toHaveLength(8);
    expect(new Set(imageHrefs).size).toBe(7);
    expect(imageHrefs).toEqual([
      PALLET_LABEL_ASSETS.handling5.dataUri,
      PALLET_LABEL_ASSETS.handling4.dataUri,
      PALLET_LABEL_ASSETS.handling3.dataUri,
      PALLET_LABEL_ASSETS.handling1.dataUri,
      PALLET_LABEL_ASSETS.handling2.dataUri,
      PALLET_LABEL_ASSETS.logo.dataUri,
      PALLET_LABEL_ASSETS.certification.dataUri,
      PALLET_LABEL_ASSETS.certification.dataUri,
    ]);
    expect(svg.match(/preserveAspectRatio="xMidYMid meet"/g)).toHaveLength(8);
    for (const field of REQUIRED_BUSINESS_FIELDS) {
      expect(svg.match(new RegExp(`data-business-field="${field}"`, 'g'))).toHaveLength(1);
    }
    const expectedValues: Array<[(typeof REQUIRED_BUSINESS_FIELDS)[number], string]> = [
      ['palletId', MAXIMUM_SNAPSHOT.palletId],
      ['materialMark', MAXIMUM_SNAPSHOT.materialMark],
      ['productNames', MAXIMUM_SNAPSHOT.productNames.join(' • ')],
      ['article', MAXIMUM_SNAPSHOT.article!],
      ['rollCount', '10000'],
      ['packagingMaterial', MAXIMUM_SNAPSHOT.packagingMaterial!],
      ['packagingCount', '100000'],
      ['netKg', '999999999.999'],
      ['grossKg', '999999999.999'],
      ['productionDate', MAXIMUM_SNAPSHOT.productionDate!],
      ['shelfLifeMonths', '12 месяцев'],
      ['deliveryDate', MAXIMUM_SNAPSHOT.deliveryDate!],
      ['storageConditions', MAXIMUM_SNAPSHOT.storageConditions],
      ['orderNumbers', MAXIMUM_SNAPSHOT.orderNumbers[0]],
      ['customerAliases', MAXIMUM_SNAPSHOT.customerAliases[0]],
      ['createdAt', MAXIMUM_SNAPSHOT.createdAt],
    ];
    for (const [field, value] of expectedValues) {
      expect(businessFieldValue(svg, field)).toBe(value);
    }

    const { safe, frame } = COMPACT_LAYOUT;
    expect(rectangleHasBlackPixel(rendered.bitmap, 0, 0, 800, safe.y)).toBe(false);
    expect(rectangleHasBlackPixel(rendered.bitmap, 0, safe.y + safe.height, 800, 1200)).toBe(false);
    expect(rectangleHasBlackPixel(rendered.bitmap, 0, safe.y, safe.x, safe.y + safe.height)).toBe(
      false,
    );
    expect(
      rectangleHasBlackPixel(
        rendered.bitmap,
        safe.x + safe.width,
        safe.y,
        800,
        safe.y + safe.height,
      ),
    ).toBe(false);
    expect(isBlackPixel(rendered.bitmap, frame.x, frame.y)).toBe(true);
    expect(
      isBlackPixel(rendered.bitmap, frame.x + frame.width - 1, frame.y + frame.height - 1),
    ).toBe(true);
  });

  it('renders every accepted widest-glyph maximum at no less than 8px', () => {
    const svg = renderer.renderPalletLabelSvg(WIDEST_MAXIMUM_SNAPSHOT, PALLET_TOKEN, profile);
    const { bitmap } = renderer.renderPalletLabel(WIDEST_MAXIMUM_SNAPSHOT, PALLET_TOKEN, profile);
    const fittedFontSizes = [...svg.matchAll(/data-fit-font-size="(\d+)"/g)].map((match) =>
      Number(match[1]),
    );

    expect(bitmap).toHaveLength(PALLET_LABEL_PROFILE.bitmapBytes);
    expect(Math.min(...fittedFontSizes)).toBeGreaterThanOrEqual(
      EXPECTED_COMPACT_SNAPSHOT_BOUNDS.minimumFontSize,
    );
    expect(businessFieldValue(svg, 'palletId')).toBe(WIDEST_MAXIMUM_SNAPSHOT.palletId);
    expect(businessFieldValue(svg, 'materialMark')).toBe(WIDEST_MAXIMUM_SNAPSHOT.materialMark);
    expect(businessFieldValue(svg, 'productNames')).toBe(
      WIDEST_MAXIMUM_SNAPSHOT.productNames.join(' • '),
    );
    expect(businessFieldValue(svg, 'article')).toBe(WIDEST_MAXIMUM_SNAPSHOT.article);
    expect(businessFieldValue(svg, 'packagingMaterial')).toBe(
      WIDEST_MAXIMUM_SNAPSHOT.packagingMaterial,
    );
    expect(businessFieldValue(svg, 'storageConditions')).toBe(
      WIDEST_MAXIMUM_SNAPSHOT.storageConditions,
    );
    expect(businessFieldValue(svg, 'orderNumbers')).toBe(WIDEST_MAXIMUM_SNAPSHOT.orderNumbers[0]);
    expect(businessFieldValue(svg, 'customerAliases')).toBe(
      WIDEST_MAXIMUM_SNAPSHOT.customerAliases[0],
    );
  });

  it('prints the exact compact material mark without trimming, remapping or dropping slash', () => {
    const pvd = { ...COMPACT_SAMPLE, materialMark: 'ПВД' };
    const mapped = { ...COMPACT_SAMPLE, materialMark: 'PE-LD' };
    const slash = { ...COMPACT_SAMPLE, materialMark: ' / ' };
    const dash = { ...COMPACT_SAMPLE, materialMark: '—' };
    const pvdSvg = renderer.renderPalletLabelSvg(pvd, PALLET_TOKEN, profile);
    const slashSvg = renderer.renderPalletLabelSvg(slash, PALLET_TOKEN, profile);

    expect(businessFieldValue(pvdSvg, 'materialMark')).toBe('ПВД');
    expect(businessFieldValue(slashSvg, 'materialMark')).toBe(' / ');
    expect(renderer.renderPalletLabel(pvd, PALLET_TOKEN, profile).bitmap).not.toEqual(
      renderer.renderPalletLabel(mapped, PALLET_TOKEN, profile).bitmap,
    );
    expect(renderer.renderPalletLabel(slash, PALLET_TOKEN, profile).bitmap).not.toEqual(
      renderer.renderPalletLabel(dash, PALLET_TOKEN, profile).bitmap,
    );
  });

  it('keeps negative-left-bearing customer glyph ink inside the declared field', () => {
    const alias = 'Ὓ'.repeat(300);
    const overhanging = {
      ...COMPACT_SAMPLE,
      customerAliases: [alias],
    };
    const empty = {
      ...COMPACT_SAMPLE,
      customerAliases: [],
    };
    const svg = renderer.renderPalletLabelSvg(overhanging, PALLET_TOKEN, profile);
    const overhangingBitmap = renderer.renderPalletLabel(overhanging, PALLET_TOKEN, profile).bitmap;
    const emptyBitmap = renderer.renderPalletLabel(empty, PALLET_TOKEN, profile).bitmap;
    const changed = changedPixelBounds(overhangingBitmap, emptyBitmap);
    const field = COMPACT_LAYOUT.fields.customerAliases;

    expect(businessFieldValue(svg, 'customerAliases')).toBe(alias);
    expect(changed.count).toBeGreaterThan(0);
    expect(changed.x).toBeGreaterThanOrEqual(field.x);
    expect(changed.y).toBeGreaterThanOrEqual(field.y);
    expect(changed.right).toBeLessThan(field.x + field.width);
    expect(changed.bottom).toBeLessThan(field.y + field.height);
  });

  it('preserves exact business whitespace in source and raster output', () => {
    const exactAlias = 'ООО  «Ромашка» & Сын';
    const exact = { ...COMPACT_SAMPLE, customerAliases: [exactAlias] };
    const collapsed = { ...COMPACT_SAMPLE, customerAliases: ['ООО «Ромашка» & Сын'] };
    const svg = renderer.renderPalletLabelSvg(exact, PALLET_TOKEN, profile);
    const exactBitmap = renderer.renderPalletLabel(exact, PALLET_TOKEN, profile).bitmap;
    const collapsedBitmap = renderer.renderPalletLabel(collapsed, PALLET_TOKEN, profile).bitmap;
    const changed = changedPixelBounds(exactBitmap, collapsedBitmap);
    const field = COMPACT_LAYOUT.fields.customerAliases;

    expect(businessFieldValue(svg, 'customerAliases')).toBe(exactAlias);
    expect(svg).toContain('xml:space="preserve"');
    expect(changed.count).toBeGreaterThan(0);
    expect(changed.x).toBeGreaterThanOrEqual(field.x);
    expect(changed.y).toBeGreaterThanOrEqual(field.y);
    expect(changed.right).toBeLessThan(field.x + field.width);
    expect(changed.bottom).toBeLessThan(field.y + field.height);
  });

  it('keeps each maximum field mutation inside its own raster bounds and away from QR/assets', () => {
    const maximum = renderer.renderPalletLabel(MAXIMUM_SNAPSHOT, PALLET_TOKEN, profile).bitmap;
    const variants: Array<
      [Exclude<(typeof REQUIRED_BUSINESS_FIELDS)[number], 'shelfLifeMonths'>, PalletLabelSnapshot]
    > = [
      ['palletId', { ...MAXIMUM_SNAPSHOT, palletId: 'PALLET-ALT' }],
      ['materialMark', { ...MAXIMUM_SNAPSHOT, materialMark: 'ПНД' }],
      ['productNames', { ...MAXIMUM_SNAPSHOT, productNames: ['Другой товар'] }],
      ['article', { ...MAXIMUM_SNAPSHOT, article: 'ARTICLE-ALT' }],
      ['rollCount', { ...MAXIMUM_SNAPSHOT, rollCount: 9_999 }],
      ['packagingMaterial', { ...MAXIMUM_SNAPSHOT, packagingMaterial: 'Крафт-бумага' }],
      ['packagingCount', { ...MAXIMUM_SNAPSHOT, packagingCount: 99_999 }],
      ['netKg', { ...MAXIMUM_SNAPSHOT, netKg: 999_999_998.999 }],
      ['grossKg', { ...MAXIMUM_SNAPSHOT, grossKg: 999_999_998.999 }],
      ['productionDate', { ...MAXIMUM_SNAPSHOT, productionDate: '12.9999' }],
      ['deliveryDate', { ...MAXIMUM_SNAPSHOT, deliveryDate: '30.12.9999' }],
      ['storageConditions', { ...MAXIMUM_SNAPSHOT, storageConditions: 'Сухое помещение' }],
      ['orderNumbers', { ...MAXIMUM_SNAPSHOT, orderNumbers: ['ORDER-ALT'] }],
      ['customerAliases', { ...MAXIMUM_SNAPSHOT, customerAliases: ['ЗАКАЗЧИК-ALT'] }],
      ['createdAt', { ...MAXIMUM_SNAPSHOT, createdAt: '9999-12-30T23:59:59.999Z' }],
    ];

    for (const [fieldName, variant] of variants) {
      const changedBitmap = renderer.renderPalletLabel(variant, PALLET_TOKEN, profile).bitmap;
      const changed = changedPixelBounds(maximum, changedBitmap);
      const field = COMPACT_LAYOUT.fields[fieldName];

      expect(changed.count).toBeGreaterThan(0);
      expect(changed.x).toBeGreaterThanOrEqual(field.x);
      expect(changed.y).toBeGreaterThanOrEqual(field.y);
      expect(changed.right).toBeLessThan(field.x + field.width);
      expect(changed.bottom).toBeLessThan(field.y + field.height);
      for (const excluded of NON_FIELD_RASTER_BOUNDS) {
        expect(changedPixelsInBounds(maximum, changedBitmap, excluded)).toBe(0);
      }
    }

    const shelfLife = COMPACT_LAYOUT.fields.shelfLifeMonths;
    expect(
      rectangleHasBlackPixel(
        maximum,
        shelfLife.x,
        shelfLife.y,
        shelfLife.x + shelfLife.width,
        shelfLife.y + shelfLife.height,
      ),
    ).toBe(true);
  });

  it('contains exactly one decodable pallet QR with a four-module white quiet zone', () => {
    const { bitmap } = renderer.renderPalletLabel(COMPACT_SAMPLE, PALLET_TOKEN, profile);
    const svg = renderer.renderPalletLabelSvg(COMPACT_SAMPLE, PALLET_TOKEN, profile);
    const decoded = jsQR(
      bitmapToRgba(bitmap),
      PALLET_LABEL_PROFILE.widthDots,
      PALLET_LABEL_PROFILE.heightDots,
      { inversionAttempts: 'dontInvert' },
    );
    const expected = QRCode.create(PALLET_TOKEN, { version: 5, errorCorrectionLevel: 'M' });
    const moduleSize = 8;
    const quietZone = 4 * moduleSize;
    const matrixX = COMPACT_LAYOUT.qr.x + quietZone;
    const matrixY = COMPACT_LAYOUT.qr.y + quietZone;

    expect(svg.match(/data-pallet-qr="true"/g)).toHaveLength(1);
    expect(svg.match(/data-qr-module-count="37"/g)).toHaveLength(1);
    expect(decoded?.data).toBe(PALLET_TOKEN);
    expect(expected.modules.size).toBe(37);
    for (let row = 0; row < expected.modules.size; row += 1) {
      for (let column = 0; column < expected.modules.size; column += 1) {
        expect(
          isBlackPixel(bitmap, matrixX + column * moduleSize + 4, matrixY + row * moduleSize + 4),
        ).toBe(expected.modules.get(row, column) === 1);
      }
    }
    for (let y = COMPACT_LAYOUT.qr.y; y < COMPACT_LAYOUT.qr.y + COMPACT_LAYOUT.qr.height; y += 1) {
      for (let x = COMPACT_LAYOUT.qr.x; x < COMPACT_LAYOUT.qr.x + COMPACT_LAYOUT.qr.width; x += 1) {
        const insideMatrix =
          x >= matrixX &&
          x < matrixX + expected.modules.size * moduleSize &&
          y >= matrixY &&
          y < matrixY + expected.modules.size * moduleSize;
        if (!insideMatrix) expect(isBlackPixel(bitmap, x, y)).toBe(false);
      }
    }
  });

  it('locks deterministic compact-v2 SVG, PNG and printer-bitmap bytes', () => {
    const svg = renderer.renderPalletLabelSvg(COMPACT_SAMPLE, PALLET_TOKEN, profile);
    const { png, bitmap } = renderer.renderPalletLabel(COMPACT_SAMPLE, PALLET_TOKEN, profile);

    expect(sha256(svg)).toBe('0177d291c7e0e397ca2c1fce5d6ec4c432ff04442e7c04499078521fe640c997');
    expect(sha256(png)).toBe('58e6d6b3d0184f1bdd1ccdb7555111477ba23c984b7190d7ed7860a61e1d9b40');
    expect(sha256(bitmap)).toBe('5564120f4d05487d4aaa9138a7015ac8e48ef9d355bce2902f013ca4de53083b');
  });
});

describe('PalletLabelRenderer square-v4', () => {
  const renderer = new PalletLabelRenderer();
  const profile = 'pallet-100x100-square-v4' as const;

  it('renders the authoritative 100x100 profile without rotation or unsafe ink', () => {
    expect(SQUARE_PALLET_LABEL_LAYOUT).toEqual({
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
    });

    const svg = renderer.renderPalletLabelSvg(SQUARE_SAMPLE, PALLET_TOKEN, profile);
    const rendered = renderer.renderPalletLabel(SQUARE_SAMPLE, PALLET_TOKEN, profile);
    const ink = blackPixelBounds(rendered.bitmap, rendered.width, rendered.height);

    expect(svg).toContain('data-layout-profile="square-v4"');
    expect(svg).toContain('data-layout-orientation="square-unrotated"');
    expect(svg).not.toContain('rotate(');
    expect(rendered.width).toBe(800);
    expect(rendered.height).toBe(800);
    expect(rendered.bitmap).toHaveLength(80_000);
    expect(ink.x).toBeGreaterThanOrEqual(SQUARE_PALLET_LABEL_LAYOUT.safe.x);
    expect(ink.y).toBeGreaterThanOrEqual(SQUARE_PALLET_LABEL_LAYOUT.safe.y);
    expect(ink.x + ink.width).toBeLessThanOrEqual(
      SQUARE_PALLET_LABEL_LAYOUT.safe.x + SQUARE_PALLET_LABEL_LAYOUT.safe.width,
    );
    expect(ink.y + ink.height).toBeLessThanOrEqual(
      SQUARE_PALLET_LABEL_LAYOUT.safe.y + SQUARE_PALLET_LABEL_LAYOUT.safe.height,
    );
  });

  it('renders the complete A-2 snapshot and exactly one decodable 315-dot QR', () => {
    const svg = renderer.renderPalletLabelSvg(SQUARE_SAMPLE, PALLET_TOKEN, profile);
    const { bitmap } = renderer.renderPalletLabel(SQUARE_SAMPLE, PALLET_TOKEN, profile);
    const decoded = jsQR(bitmapToRgba(bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });

    expect(svg).toContain('PAL-A-2-01');
    expect(svg).toContain('ПАЛЕТНЫЙ ЛИСТ: PAL-A-2-01');
    expect(svg).toContain('Пленка полиэтиленовая рукав 29мкм');
    expect(svg).toContain('СТН-М АО');
    expect(svg).toContain('Рулоны на палете');
    expect(svg).toContain('A-2-roll-1');
    expect(svg).toContain('Произведено: 06.2026–07.2026');
    expect(svg).toContain('Сформировано: 14.07.2026 15:00 МСК');
    expect(svg).not.toContain(SQUARE_SAMPLE.createdAt);
    expect(svg).toContain('data-business-field="rollCodes"');
    expect(svg).toContain('<desc data-business-value="true">A-2-roll-1</desc>');
    expect(svg.match(/data-pallet-qr="true"/g)).toHaveLength(1);
    expect(svg).toContain('data-qr-module-size="7"');
    expect(SQUARE_PALLET_LABEL_LAYOUT.qr).toEqual({ x: 36, y: 449, width: 315, height: 315 });
    expect(decoded?.data).toBe(PALLET_TOKEN);
  });

  it('locks the byte-exact square-v4 output while safe-v5 evolves independently', () => {
    const svg = renderer.renderPalletLabelSvg(SQUARE_SAMPLE, PALLET_TOKEN, profile);
    const { png, bitmap } = renderer.renderPalletLabel(SQUARE_SAMPLE, PALLET_TOKEN, profile);

    expect([sha256(svg), sha256(png), sha256(bitmap)]).toEqual([
      'cf9887cfb8c78a7901bd52a1ae11c01e5f6bbfde2b2d321e6f72067c70c6657a',
      '664c4cc27bbfeb2bea6c7b2133bf86bf9258bcb7c664f8eec7bdb091c5cbe8e4',
      '01ddc9c82fee0cce911d38d3701f67b62445db673853c6bc7e59a6856ae30743',
    ]);
  });

  it('renders all 24 typical codes and rejects the first count and measured-width overflow', () => {
    const boundaryCodes = Array.from({ length: 24 }, (_, index) => `A-2-roll-${index + 1}`);
    const overflowingCodes = [...boundaryCodes, 'A-2-roll-25'];
    const longCodes = ['A'.repeat(80), 'B'.repeat(80)];
    const withCodes = (rollCodes: string[]): PalletLabelSnapshot => ({
      ...SQUARE_SAMPLE,
      rollCount: rollCodes.length,
      rollCodes,
    });

    expect(() => assertSquarePalletLabelSnapshotRenderable(withCodes(boundaryCodes))).not.toThrow();
    expect(
      renderer.renderPalletLabelSvg(withCodes(boundaryCodes), PALLET_TOKEN, profile),
    ).toContain('A-2-roll-24');
    const boundarySvg = renderer.renderPalletLabelSvg(
      withCodes(boundaryCodes),
      PALLET_TOKEN,
      profile,
    );
    const boundaryBitmap = renderer.renderPalletLabel(
      withCodes(boundaryCodes),
      PALLET_TOKEN,
      profile,
    ).bitmap;
    for (const rollCode of boundaryCodes) expect(boundarySvg).toContain(rollCode);
    expect(boundaryBitmap).toHaveLength(80_000);
    expect(() => assertSquarePalletLabelSnapshotRenderable(withCodes(overflowingCodes))).toThrow(
      /maximum 24/u,
    );
    expect(() => assertSquarePalletLabelSnapshotRenderable(withCodes(longCodes))).toThrow(
      'Square pallet label roll code exceeds one grid cell',
    );
  });

  it('requires a complete, unique composition that matches rollCount', () => {
    expect(() =>
      renderer.renderPalletLabelSvg(
        { ...SQUARE_SAMPLE, rollCodes: undefined } as unknown as PalletLabelSnapshot,
        PALLET_TOKEN,
        profile,
      ),
    ).toThrow('rollCodes must be an array');
    expect(() =>
      renderer.renderPalletLabelSvg({ ...SQUARE_SAMPLE, rollCount: 2 }, PALLET_TOKEN, profile),
    ).toThrow('rollCodes must match rollCount');
    expect(() =>
      renderer.renderPalletLabelSvg(
        { ...SQUARE_SAMPLE, rollCount: 2, rollCodes: ['A-2-roll-1', 'A-2-roll-1'] },
        PALLET_TOKEN,
        profile,
      ),
    ).toThrow('rollCodes must be unique');
  });

  it('preserves the byte-exact legacy printer bitmaps', () => {
    expect(
      sha256(renderer.renderPalletLabel(SAMPLE_SNAPSHOT, PALLET_TOKEN, 'pallet-100x150-v1').bitmap),
    ).toBe('c114f7f3ab71ac42089cfda5279570ec417890826e16ca756b887b4559739ced');
    expect(
      sha256(
        renderer.renderPalletLabel(COMPACT_SAMPLE, PALLET_TOKEN, 'pallet-100x150-compact-v2')
          .bitmap,
      ),
    ).toBe('5564120f4d05487d4aaa9138a7015ac8e48ef9d355bce2902f013ca4de53083b');
  });
});

describe('PalletLabelRenderer safe-v5', () => {
  const renderer = new PalletLabelRenderer();
  const profile = 'pallet-100x100-safe-v5' as const;

  it('keeps every ink pixel inside the leading 570 dots and leaves the cutter band blank', () => {
    expect(SAFE_PALLET_LABEL_LAYOUT).toEqual({
      page: { x: 0, y: 0, width: 800, height: 800 },
      safe: { x: 20, y: 20, width: 760, height: 550 },
      frame: { x: 22, y: 22, width: 756, height: 546 },
      header: { x: 36, y: 32, width: 728, height: 48 },
      identity: { x: 36, y: 92, width: 390, height: 85 },
      product: { x: 36, y: 170, width: 390, height: 140 },
      rollCodes: { x: 36, y: 320, width: 390, height: 236 },
      qr: { x: 449, y: 92, width: 315, height: 315 },
      summary: { x: 449, y: 415, width: 315, height: 141 },
    });

    const svg = renderer.renderPalletLabelSvg(SAFE_SAMPLE, PALLET_TOKEN, profile);
    const rendered = renderer.renderPalletLabel(SAFE_SAMPLE, PALLET_TOKEN, profile);
    const ink = blackPixelBounds(rendered.bitmap, rendered.width, rendered.height);

    expect(svg).toContain('data-layout-profile="safe-v5"');
    expect(svg).toContain('data-max-ink-y="570"');
    expect(rendered.width).toBe(800);
    expect(rendered.height).toBe(800);
    expect(ink.x).toBeGreaterThanOrEqual(SAFE_PALLET_LABEL_LAYOUT.safe.x);
    expect(ink.y).toBeGreaterThanOrEqual(SAFE_PALLET_LABEL_LAYOUT.safe.y);
    expect(ink.y + ink.height).toBeLessThanOrEqual(570);
  });

  it('moves the one large QR above the cut zone and preserves the complete A-2 composition', () => {
    const svg = renderer.renderPalletLabelSvg(SAFE_SAMPLE, PALLET_TOKEN, profile);
    const { bitmap } = renderer.renderPalletLabel(SAFE_SAMPLE, PALLET_TOKEN, profile);
    const decoded = jsQR(bitmapToRgba(bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });

    expect(SAFE_PALLET_LABEL_LAYOUT.qr).toEqual({ x: 449, y: 92, width: 315, height: 315 });
    expect(svg.match(/data-pallet-qr="true"/g)).toHaveLength(1);
    expect(svg).toContain('data-qr-module-size="7"');
    expect(svg).toContain('data-business-field="rollCodes"');
    expect(svg).toContain('<desc data-business-value="true">A-2-roll-1</desc>');
    expect(svg).toContain('Пленка полиэтиленовая рукав 29мкм');
    expect(svg).toContain('СТН-М АО');
    expect(decoded?.data).toBe(PALLET_TOKEN);
  });

  it('fits the complete canonical storage conditions above the physical cut line', () => {
    const snapshot = { ...SAFE_SAMPLE, storageConditions: PALLET_STORAGE_CONDITIONS };

    expect(() => assertSafePalletLabelSnapshotRenderable(snapshot)).not.toThrow();
    const svg = renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, profile);
    const rendered = renderer.renderPalletLabel(snapshot, PALLET_TOKEN, profile);
    const ink = blackPixelBounds(rendered.bitmap, rendered.width, rendered.height);

    expect(svg).toContain(`<desc data-business-value="true">${PALLET_STORAGE_CONDITIONS}</desc>`);
    expect(ink.y + ink.height).toBeLessThanOrEqual(570);
  });

  it('renders all 24 ordered roll codes and rejects the first overflow before persistence', () => {
    const boundaryCodes = Array.from({ length: 24 }, (_, index) => `A-2-roll-${index + 1}`);
    const withCodes = (rollCodes: string[]): PalletLabelSnapshot => ({
      ...SAFE_SAMPLE,
      rollCount: rollCodes.length,
      rollCodes,
    });

    expect(() => assertSafePalletLabelSnapshotRenderable(withCodes(boundaryCodes))).not.toThrow();
    const svg = renderer.renderPalletLabelSvg(withCodes(boundaryCodes), PALLET_TOKEN, profile);
    for (const [index, rollCode] of boundaryCodes.entries()) {
      expect(svg).toContain(`data-roll-position="${index + 1}"`);
      expect(svg).toContain(`<desc data-business-value="true">${rollCode}</desc>`);
    }
    expect(() =>
      assertSafePalletLabelSnapshotRenderable(withCodes([...boundaryCodes, 'A-2-roll-25'])),
    ).toThrow(/maximum 24/u);
    expect(() =>
      assertSafePalletLabelSnapshotRenderable(withCodes(['A'.repeat(80), 'B'.repeat(80)])),
    ).toThrow('Safe pallet label roll code exceeds one grid cell');
  });

  it('locks the immutable safe-v5 SVG, PNG and bitmap while extended-v6 evolves separately', () => {
    const svg = renderer.renderPalletLabelSvg(SAFE_SAMPLE, PALLET_TOKEN, profile);
    const { png, bitmap } = renderer.renderPalletLabel(SAFE_SAMPLE, PALLET_TOKEN, profile);

    expect([sha256(svg), sha256(png), sha256(bitmap)]).toEqual([
      '21342a40339bdbc7ad7eae8b017ae3b84b8c9063282330b5ebd18216d316c1cb',
      '29a7b7304a88f509035993f00a0cc5d654d6df32f4cb1345aea1924b64a4c840',
      '819bacfaf07db73f0f8a4e4530322cea8fd20e5069e3ebf5656a27a532a36526',
    ]);
  });
});

describe('PalletLabelRenderer extended-v6', () => {
  const renderer = new PalletLabelRenderer();
  const profile = 'pallet-100x100-extended-v6' as const;
  const coreFields = [
    'palletId',
    'orderNumbers',
    'customerAliases',
    'productNames',
    'article',
    'createdAt',
    'rollCodes',
    'materialMark',
    'rollCount',
    'netKg',
    'productionDate',
  ] as const;

  const fieldBounds = (svg: string, field: string): Bounds => {
    const match = svg.match(
      new RegExp(`data-business-field="${field}" data-field-bounds="(\\d+),(\\d+),(\\d+),(\\d+)"`),
    );
    if (!match) throw new Error(`Missing field bounds for ${field}`);
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  };

  it('preserves the exact extended-v6 bytes while sharing semantic field fitting with v7', () => {
    const svg = renderer.renderPalletLabelSvg(EXTENDED_SAMPLE, PALLET_TOKEN, profile);
    const { png, bitmap } = renderer.renderPalletLabel(EXTENDED_SAMPLE, PALLET_TOKEN, profile);

    expect([sha256(svg), sha256(png), sha256(bitmap)]).toEqual([
      '77e9beb1d10ffb2629229a5e0669f07bcf04658aad5ee20f0e38c83dfba34f7e',
      '79d316af38a43e4e58f8c439ed0df17bf546a6de6eba3440cc4a6e628465ed77',
      '4fa44fc00ab529a1f7d424885c270816f175c00e8b5c316c717605a54ee8a6ec',
    ]);
  });

  it('keeps the v5 core and exact QR above y570 while extending secondary text to y760', () => {
    expect(EXTENDED_PALLET_LABEL_LAYOUT).toEqual({
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
    });

    const svg = renderer.renderPalletLabelSvg(EXTENDED_SAMPLE, PALLET_TOKEN, profile);
    const rendered = renderer.renderPalletLabel(EXTENDED_SAMPLE, PALLET_TOKEN, profile);
    const ink = blackPixelBounds(rendered.bitmap, rendered.width, rendered.height);

    expect(svg).toContain('data-layout-profile="extended-v6"');
    expect(svg).toContain('data-core-max-ink-y="570"');
    expect(svg).toContain('data-secondary-min-y="590"');
    for (const field of coreFields) {
      const bounds = fieldBounds(svg, field);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(570);
    }
    expect(fieldBounds(svg, 'packagingMaterial').y).toBeGreaterThanOrEqual(590);
    expect(fieldBounds(svg, 'storageConditions').y).toBeGreaterThanOrEqual(590);
    expect(ink.x).toBeGreaterThanOrEqual(EXTENDED_PALLET_LABEL_LAYOUT.safe.x);
    expect(ink.y).toBeGreaterThanOrEqual(EXTENDED_PALLET_LABEL_LAYOUT.safe.y);
    expect(ink.x + ink.width).toBeLessThanOrEqual(780);
    expect(ink.y + ink.height).toBeLessThanOrEqual(780);
    expect(rectangleHasBlackPixel(rendered.bitmap, 36, 590, 764, 760)).toBe(true);
  });

  it('preserves the exact safe-v5 QR coordinates, size and single decodable payload', () => {
    const safeSvg = renderer.renderPalletLabelSvg(
      SAFE_SAMPLE,
      PALLET_TOKEN,
      'pallet-100x100-safe-v5',
    );
    const extendedSvg = renderer.renderPalletLabelSvg(EXTENDED_SAMPLE, PALLET_TOKEN, profile);
    const qrGroup = (svg: string): string =>
      svg.match(/<g data-pallet-qr="true"[\s\S]*?<\/g>/u)?.[0] ?? '';
    const { bitmap } = renderer.renderPalletLabel(EXTENDED_SAMPLE, PALLET_TOKEN, profile);
    const decoded = jsQR(bitmapToRgba(bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });

    expect(EXTENDED_PALLET_LABEL_LAYOUT.qr).toEqual(SAFE_PALLET_LABEL_LAYOUT.qr);
    expect(qrGroup(extendedSvg)).toBe(qrGroup(safeSvg));
    expect(extendedSvg.match(/data-pallet-qr="true"/g)).toHaveLength(1);
    expect(extendedSvg.match(/data-qr-module-count="37"/g)).toHaveLength(1);
    expect(extendedSvg.match(/data-qr-module-size="7"/g)).toHaveLength(1);
    expect(decoded?.data).toBe(PALLET_TOKEN);
  });

  it('renders the canonical 319-character storage text untruncated in the lower readable band', () => {
    expect(PALLET_STORAGE_CONDITIONS).toHaveLength(319);
    const snapshot = { ...EXTENDED_SAMPLE, storageConditions: PALLET_STORAGE_CONDITIONS };

    expect(() => assertExtendedPalletLabelSnapshotRenderable(snapshot)).not.toThrow();
    const svg = renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, profile);
    const storageGroup = svg.match(
      /<g data-business-field="storageConditions"[^>]*data-fit-font-size="(\d+)"[^>]*>[\s\S]*?<\/g>/u,
    );

    expect(storageGroup?.[0]).toContain(
      `<desc data-business-value="true">${PALLET_STORAGE_CONDITIONS}</desc>`,
    );
    expect(Number(storageGroup?.[1])).toBeGreaterThanOrEqual(11);
    expect(storageGroup?.[0]).not.toContain('…');
  });

  it('renders every ordered roll code from 1 through 24 and rejects the first overflow', () => {
    for (const count of [1, 24]) {
      const rollCodes = Array.from({ length: count }, (_, index) => `A-2-roll-${index + 1}`);
      const snapshot: PalletLabelSnapshot = {
        ...EXTENDED_SAMPLE,
        rollCount: count,
        rollCodes,
      };
      expect(() => assertExtendedPalletLabelSnapshotRenderable(snapshot)).not.toThrow();
      const svg = renderer.renderPalletLabelSvg(snapshot, PALLET_TOKEN, profile);
      for (const [index, rollCode] of rollCodes.entries()) {
        expect(svg).toContain(`data-roll-position="${index + 1}"`);
        expect(svg).toContain(`<desc data-business-value="true">${rollCode}</desc>`);
      }
    }

    const rollCodes = Array.from({ length: 25 }, (_, index) => `A-2-roll-${index + 1}`);
    expect(() =>
      assertExtendedPalletLabelSnapshotRenderable({
        ...EXTENDED_SAMPLE,
        rollCount: rollCodes.length,
        rollCodes,
      }),
    ).toThrow(/maximum 24/u);
  });
});
