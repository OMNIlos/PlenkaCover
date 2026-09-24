import { createHash } from 'node:crypto';
import type { PalletLabelSnapshot } from '@plenka/contracts';
import {
  LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT,
  PUBLISHED_PALLET_LABEL_LAYOUT,
} from './pallet-label-layout.validator';
import {
  ConfigurablePalletLabelRenderer,
  PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
} from './configurable-pallet-label.renderer';

const PALLET_TOKEN = `plt_${'a'.repeat(64)}`;

const snapshot: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x100-configurable-v7',
  palletId: 'FORBIDDEN-PALLET-ID',
  materialMark: 'FORBIDDEN-MATERIAL',
  productNames: ['FORBIDDEN-PRODUCT'],
  article: 'FORBIDDEN-ARTICLE',
  rollCount: 2,
  rollCodes: ['FORBIDDEN-ROLL-1', 'FORBIDDEN-ROLL-2'],
  packagingMaterial: 'FORBIDDEN-PACKAGING',
  packagingCount: 9,
  netKg: 123.456,
  grossKg: 130.456,
  productionDate: 'FORBIDDEN-PRODUCTION-DATE',
  shelfLifeMonths: 12,
  deliveryDate: 'FORBIDDEN-DELIVERY-DATE',
  storageConditions: 'Хранение в сухом помещении.',
  orderNumbers: ['A-2'],
  customerAliases: ['СТН-М АО'],
  createdAt: '2026-08-09T12:00:00.000Z',
};

const elementIds = (svg: string): string[] =>
  [...svg.matchAll(/data-layout-element="([^"]+)"/gu)].map((match) => match[1]);

describe('ConfigurablePalletLabelRenderer schema versions', () => {
  const renderer = new ConfigurablePalletLabelRenderer();

  it('renders only the six enabled V2 system blocks and never serializes legacy values', () => {
    const svg = renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
      qrToken: PALLET_TOKEN,
      watermark: false,
    });

    expect(elementIds(svg)).toEqual(['order', 'customer', 'formedAt', 'rollCount', 'storage', 'qr']);
    expect(svg).toContain('Заказ: A-2');
    expect(svg).toContain('Заказчик: СТН-М АО');
    expect(svg).toContain('Сформировано: 09.08.2026 15:00 МСК');
    expect(svg).toContain('Рулонов на палете: 2');
    expect(svg).toContain('Хранение в сухом помещении.');
    for (const forbidden of [
      'FORBIDDEN-PALLET-ID',
      'FORBIDDEN-MATERIAL',
      'FORBIDDEN-PRODUCT',
      'FORBIDDEN-ARTICLE',
      'FORBIDDEN-ROLL-1',
      'FORBIDDEN-ROLL-2',
      'FORBIDDEN-PACKAGING',
      'FORBIDDEN-PRODUCTION-DATE',
      'FORBIDDEN-DELIVERY-DATE',
    ]) {
      expect(svg).not.toContain(forbidden);
    }
    expect(svg).not.toContain('<image');
  });

  it.each(['order', 'customer', 'formedAt', 'rollCount', 'storage'] as const)(
    'omits optional block %s completely',
    (removedId) => {
      const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
      layout.elements = layout.elements.filter((element) => element.id !== removedId);

      const svg = renderer.renderSvg(snapshot, layout, {
        qrToken: PALLET_TOKEN,
        watermark: false,
      });

      expect(elementIds(svg)).not.toContain(removedId);
      expect(elementIds(svg)).toContain('qr');
    },
  );

  it('uses only aggregate roll count and does not require roll composition in V2', () => {
    const withoutComposition = {
      ...snapshot,
      rollCodes: undefined,
    } as unknown as PalletLabelSnapshot;

    const svg = renderer.renderSvg(withoutComposition, PUBLISHED_PALLET_LABEL_LAYOUT, {
      qrToken: PALLET_TOKEN,
      watermark: false,
    });

    expect(svg).toContain('Рулонов на палете: 2');
    expect(svg).not.toContain('FORBIDDEN-ROLL');
  });

  it('accepts only a real pallet-list token for official output and the sentinel for drafts', () => {
    expect(() =>
      renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
        qrToken: 'A-2',
        watermark: false,
      }),
    ).toThrow('Invalid pallet-list QR token');
    expect(() =>
      renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
        qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
        watermark: false,
      }),
    ).toThrow('Invalid pallet-list QR token');
    expect(() =>
      renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
        qrToken: PALLET_TOKEN,
        watermark: true,
      }),
    ).toThrow('Invalid pallet-list draft QR token');

    expect(() =>
      renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
        qrToken: PALLET_TOKEN,
        watermark: false,
      }),
    ).not.toThrow();
    expect(() =>
      renderer.renderSvg(snapshot, PUBLISHED_PALLET_LABEL_LAYOUT, {
        qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
        watermark: true,
      }),
    ).not.toThrow();
  });

  it('keeps the historical schema V1 SVG byte-stable', () => {
    const svg = renderer.renderSvg(snapshot, LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT, {
      qrToken: PALLET_TOKEN,
      watermark: false,
    });

    expect(createHash('sha256').update(svg).digest('hex')).toBe(
      'b61d33fc967528dfa864e7e43dbb2e1507baf8466f62fb1356615db7672a81b0',
    );
  });
});
