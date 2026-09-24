import jsQR from 'jsqr';
import { Resvg } from '@resvg/resvg-js';
import {
  BigBagLabelRenderer,
  BIG_BAG_BROWSER_LABEL_PROFILE,
  BIG_BAG_LABEL_RESVG_OPTIONS,
} from './bigbag-label.renderer';

const TOKEN = `bbt_${'a'.repeat(64)}`;

/** Ink pixels inside a column band, using the exact production render options. */
function inkPixelsInColumns(svg: string, fromX: number, toX: number): number {
  const { pixels } = new Resvg(svg, BIG_BAG_LABEL_RESVG_OPTIONS).render();
  const { widthPx, heightPx } = BIG_BAG_BROWSER_LABEL_PROFILE;
  let ink = 0;
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = fromX; x < toX; x += 1) {
      const offset = (y * widthPx + x) * 4;
      if (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250) ink += 1;
    }
  }
  return ink;
}

describe('BigBagLabelRenderer', () => {
  it('renders the exact 58 × 50 mm browser profile with a decodable opaque QR', () => {
    const result = new BigBagLabelRenderer().render({
      bigBagCode: 'BB-ПВД-01',
      material: 'ПВД Первичное',
      qrCode: TOKEN,
    });
    const pixels = new Resvg(result.svg).render();
    const decoded = jsQR(
      new Uint8ClampedArray(pixels.pixels),
      BIG_BAG_BROWSER_LABEL_PROFILE.widthPx,
      BIG_BAG_BROWSER_LABEL_PROFILE.heightPx,
    );

    expect(result.contentType).toBe('image/png');
    expect(result.widthPx).toBe(464);
    expect(result.heightPx).toBe(400);
    expect(result.buffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(decoded?.data).toBe(TOKEN);
    expect(result.svg).toContain('data-qr-module-size="7"');
    expect(result.svg).toContain('x="32" y="56" width="287" height="287"');
    expect(result.svg).toContain('BB-ПВД-01');
    expect(result.svg).toContain('>ПВД</text>');
    expect(result.svg).toContain('>Первичное</text>');
  });

  it('keeps a long real Big-Bag code inside the accepted 32-dot right safety margin', () => {
    const result = new BigBagLabelRenderer().render({
      bigBagCode: 'BB-ПЛЁНКА-С-АЙКОЙ-03',
      material: 'Стабилизатор ультрафиолетовый',
      qrCode: TOKEN,
    });
    // Rendered with the production options: the margin must stay clean once text really prints.
    expect(inkPixelsInColumns(result.svg, 432, BIG_BAG_BROWSER_LABEL_PROFILE.widthPx)).toBe(0);
    expect(
      inkPixelsInColumns(result.svg, BIG_BAG_BROWSER_LABEL_PROFILE.textX, 432),
    ).toBeGreaterThan(0);
    expect(result.svg).toContain('>BB-ПЛЁНКА-</text>');
    expect(result.svg).toContain('>С-АЙКОЙ-03</text>');
  });

  // The API image ships no system fonts, so a renderer that relies on them silently drops
  // every <text> and prints a bare QR without the bag code or material.
  it('rasterises the label text without depending on system fonts', () => {
    const result = new BigBagLabelRenderer().render({
      bigBagCode: 'BB-ПВД-01',
      material: 'ПВД Первичное',
      qrCode: TOKEN,
    });

    expect(BIG_BAG_LABEL_RESVG_OPTIONS.font?.loadSystemFonts).toBe(false);
    expect(BIG_BAG_LABEL_RESVG_OPTIONS.font?.fontFiles?.length).toBeGreaterThan(0);
    expect(
      inkPixelsInColumns(
        result.svg,
        BIG_BAG_BROWSER_LABEL_PROFILE.textX,
        BIG_BAG_BROWSER_LABEL_PROFILE.widthPx,
      ),
    ).toBeGreaterThan(0);
  });

  it('rejects an invalid Big-Bag token instead of printing an unscannable identity', () => {
    expect(() =>
      new BigBagLabelRenderer().render({
        bigBagCode: 'BB-1',
        material: 'ПВД',
        qrCode: 'visible-raw-id',
      }),
    ).toThrow('Invalid Big-Bag scan token');
  });
});
