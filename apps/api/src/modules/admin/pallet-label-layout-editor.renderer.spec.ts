import type { PalletLabelSnapshot } from '@plenka/contracts';
import { Resvg } from '@resvg/resvg-js';
import jsQR from 'jsqr';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from './pallet-label-layout-editor.validator';
import {
  PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
  PalletLabelLayoutEditorRenderer,
} from './pallet-label-layout-editor.renderer';

const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
const label: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x100-configurable-v7',
  palletId: 'PAL-A-2-05',
  materialMark: 'PE-LD',
  productNames: ['Пленка полиэтиленовая рукав 29мкм'],
  article: 'FORBIDDEN-ARTICLE',
  rollCount: 2,
  packagingMaterial: 'FORBIDDEN-PACKAGING',
  packagingCount: 3,
  netKg: 7.95,
  grossKg: 8.6,
  productionDate: 'FORBIDDEN-PRODUCTION-DATE',
  shelfLifeMonths: 12,
  deliveryDate: 'FORBIDDEN-DELIVERY-DATE',
  storageConditions: 'Хранение в сухом помещении.',
  orderNumbers: ['A-2'],
  customerAliases: ['СТН-М АО'],
  createdAt: '2026-08-09T12:00:00.000Z',
  rollCodes: ['A-2-roll-1', 'A-2-roll-2'],
};

describe('PalletLabelLayoutEditorRenderer', () => {
  const renderer = new PalletLabelLayoutEditorRenderer();

  it('renders the six-block draft deterministically without legacy business fields', () => {
    const svg = renderer.renderSvg(label, layout);
    const first = renderer.render(label, layout);
    const second = renderer.render(label, layout);

    expect(first.equals(second)).toBe(true);
    expect(first.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(first.readUInt32BE(16)).toBe(800);
    expect(first.readUInt32BE(20)).toBe(800);
    expect(svg).toContain('Заказ: A-2');
    expect(svg).toContain('Заказчик: СТН-М АО');
    expect(svg).toContain('Сформировано: 09.08.2026 15:00 МСК');
    expect(svg).toContain('Рулонов на палете: 2');
    expect(svg).toContain('Хранение в сухом помещении.');
    expect(svg).toContain('ЧЕРНОВИК МАКЕТА · QR НЕРАБОЧИЙ');
    expect(svg).not.toContain('PAL-A-2-05');
    expect(svg).not.toContain('A-2-roll-1');
    expect(svg).not.toContain('FORBIDDEN-');
    expect(svg).not.toContain('<image');
  });

  it('keeps one locked version-5 pallet-list QR in the canonical envelope', () => {
    const svg = renderer.renderSvg(label, layout);
    const rendered = new Resvg(svg, {
      background: '#ffffff',
      fitTo: { mode: 'width', value: 800 },
    }).render();
    const decoded = jsQR(new Uint8ClampedArray(rendered.pixels), rendered.width, rendered.height, {
      inversionAttempts: 'dontInvert',
    });

    expect(svg.match(/data-preview-qr="true"/gu)).toHaveLength(1);
    expect(svg).toContain('data-qr-module-count="37"');
    expect(svg).toContain('data-qr-module-size="7"');
    expect(svg).toContain('x="449" y="36" width="315" height="315"');
    expect(decoded?.data).toBe(PALLET_LABEL_LAYOUT_PREVIEW_TOKEN);
  });

  it('does not require or consume individual roll composition', () => {
    const withoutRollCodes = { ...label, rollCodes: undefined } as unknown as PalletLabelSnapshot;
    const svg = renderer.renderSvg(withoutRollCodes, layout);

    expect(svg).toContain('Рулонов на палете: 2');
    expect(svg).not.toContain('roll-');
  });

  it('uses the enlarged base typography for short production values', () => {
    const svg = renderer.renderSvg(label, layout);
    const fittedFont = (field: string): number =>
      Number(
        svg.match(new RegExp(`data-business-field="${field}"[^>]*data-fit-font-size="(\\d+)"`))?.[1],
      );

    expect(fittedFont('orderNumbers')).toBeGreaterThanOrEqual(28);
    expect(fittedFont('customerAliases')).toBeGreaterThanOrEqual(24);
    expect(fittedFont('createdAt')).toBeGreaterThanOrEqual(14);
    expect(fittedFont('rollCount')).toBeGreaterThanOrEqual(24);
    expect(fittedFont('storageConditions')).toBeGreaterThanOrEqual(24);
  });

  it('paints the protected QR envelope last even when a draft block overlaps it', () => {
    const overlapping = structuredClone(layout);
    const storage = overlapping.elements.find((element) => element.id === 'storage')!;
    Object.assign(storage, { xDots: 449, yDots: 36, widthDots: 315, heightDots: 315 });
    const svg = renderer.renderSvg(label, overlapping);
    const rendered = new Resvg(svg, {
      background: '#ffffff',
      fitTo: { mode: 'width', value: 800 },
    }).render();
    const decoded = jsQR(new Uint8ClampedArray(rendered.pixels), rendered.width, rendered.height, {
      inversionAttempts: 'dontInvert',
    });

    expect(svg.indexOf('data-layout-element="storage"')).toBeLessThan(
      svg.indexOf('data-preview-qr="true"'),
    );
    expect(decoded?.data).toBe(PALLET_LABEL_LAYOUT_PREVIEW_TOKEN);
  });
});
