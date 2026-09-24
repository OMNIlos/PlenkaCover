import { createHash } from 'node:crypto';
import { parsePalletLabelLayoutPublication } from '../../common/pallet-label-layout/pallet-label-layout.validator';
import {
  PUBLISHED_PALLET_LABEL_LAYOUT,
  assertPalletLabelLayoutPublishable,
  validatePalletLabelLayout,
} from './pallet-label-layout-editor.validator';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';

type MutableLayout = {
  schemaVersion: number;
  profile: string;
  elements: Array<{
    id: string;
    kind: string;
    xDots: number;
    yDots: number;
    widthDots: number;
    heightDots: number;
    maxFontSize: number;
    minFontSize: number;
    locked: boolean;
  }>;
};

const clone = (): MutableLayout => structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);

describe('pallet-label layout editor validation', () => {
  it('publishes the exact configurable-v7 geometry agreed with the editor', () => {
    expect(PUBLISHED_PALLET_LABEL_LAYOUT).toEqual({
      schemaVersion: 2,
      profile: 'pallet-100x100-configurable-v7',
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
    });
  });

  it('accepts sandbox overlap and content below the proven cut while returning diagnostics', () => {
    const layout = clone();
    const order = layout.elements.find((element) => element.id === 'order')!;
    order.xDots = 40;
    order.yDots = 500;
    order.widthDots = 300;
    order.heightDots = 100;

    const result = validatePalletLabelLayout(layout);

    expect(result.belowProvenCut).toEqual(['order']);
    expect(result.overlaps.length).toBeGreaterThan(0);
  });

  it('accepts the canonical base and rejects every unsafe publication diagnostic', () => {
    expect(assertPalletLabelLayoutPublishable(clone())).toEqual(PUBLISHED_PALLET_LABEL_LAYOUT);

    const overlap = clone();
    const customer = overlap.elements.find((element) => element.id === 'customer')!;
    customer.xDots = 449;
    customer.yDots = 200;
    customer.widthDots = 315;
    expect(() => assertPalletLabelLayoutPublishable(overlap)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PALLET_LABEL_LAYOUT_NOT_PUBLISHABLE' }),
      }),
    );

    const unsafe = clone();
    unsafe.elements.find((element) => element.id === 'order')!.xDots = 0;
    expect(() => assertPalletLabelLayoutPublishable(unsafe)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PALLET_LABEL_LAYOUT_NOT_PUBLISHABLE' }),
      }),
    );

    const belowCut = clone();
    const storage = belowCut.elements.find((element) => element.id === 'storage')!;
    storage.yDots = 600;
    storage.heightDots = 100;
    expect(() => assertPalletLabelLayoutPublishable(belowCut)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PALLET_LABEL_LAYOUT_NOT_PUBLISHABLE' }),
      }),
    );
  });

  it('allows every optional system block to be removed without weakening the QR invariant', () => {
    for (const optionalId of ['order', 'customer', 'formedAt', 'rollCount', 'storage']) {
      const layout = clone();
      layout.elements = layout.elements.filter((element) => element.id !== optionalId);

      expect(assertPalletLabelLayoutPublishable(layout)).toEqual(layout);
    }
  });

  it('allows safe moves, enlargement, lower minimum fonts and an independent maximum font', () => {
    const layout = clone();
    layout.elements.find((element) => element.id === 'order')!.xDots = 40;
    layout.elements.find((element) => element.id === 'customer')!.widthDots = 400;
    layout.elements.find((element) => element.id === 'storage')!.heightDots = 172;
    const formedAt = layout.elements.find((element) => element.id === 'formedAt')!;
    formedAt.minFontSize = 10;
    formedAt.maxFontSize = 20;

    expect(assertPalletLabelLayoutPublishable(layout)).toEqual(layout);
  });

  it('keeps schema V1 readable for immutable history but rejects it as a new publication', () => {
    const layout = rightShiftedCompactPalletLabelLayout();
    const publication = {
      id: 'legacy-publication-1',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    };

    expect(parsePalletLabelLayoutPublication(publication)).toEqual(publication);
    expect(() => assertPalletLabelLayoutPublishable(layout)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PALLET_LABEL_LAYOUT_INVALID' }),
      }),
    );
  });

  it.each([
    ['duplicate element', (layout: MutableLayout) => layout.elements.push(layout.elements[0])],
    [
      'missing QR',
      (layout: MutableLayout) => {
        layout.elements = layout.elements.filter((element) => element.id !== 'qr');
      },
    ],
    [
      'out of canvas',
      (layout: MutableLayout) => {
        layout.elements[0].xDots = 799;
      },
    ],
    [
      'fractional geometry',
      (layout: MutableLayout) => {
        layout.elements[0].xDots = 1.5;
      },
    ],
    [
      'QR movement',
      (layout: MutableLayout) => {
        layout.elements.find((element) => element.id === 'qr')!.xDots += 1;
      },
    ],
    [
      'QR unlock',
      (layout: MutableLayout) => {
        layout.elements.find((element) => element.id === 'qr')!.locked = false;
      },
    ],
    [
      'non-QR lock',
      (layout: MutableLayout) => {
        layout.elements.find((element) => element.id === 'storage')!.locked = true;
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const layout = clone();
    mutate(layout);
    expect(() => validatePalletLabelLayout(layout)).toThrow();
  });

  it('rejects unknown fields instead of accepting arbitrary SVG-like configuration', () => {
    const layout = clone() as MutableLayout & { rawSvg?: string };
    layout.rawSvg = '<script>alert(1)</script>';

    expect(() => validatePalletLabelLayout(layout)).toThrow();
  });
});
