import { PALLET_LABEL_PROFILE, isPrinterPayload } from '@plenka/contracts';

describe('PrinterPayload runtime guard', () => {
  it('accepts only opaque Big-Bag QR identities', () => {
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        destination: 'operator',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК · 0.000 кг',
        qrCode: `bbt_${'a'.repeat(64)}`,
      }),
    ).toBe(true);
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        destination: 'office',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК',
        qrCode: `bbt_${'a'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК',
        qrCode: `bbt_${'a'.repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      isPrinterPayload({
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'DEF-session-1',
        material: 'БРАК',
        qrCode: `bbt_${'a'.repeat(63)}\n`,
      }),
    ).toBe(false);
  });

  it('accepts the fixed one-copy pallet profile', () => {
    const bytes = Buffer.alloc(100 * 1200);

    expect(
      isPrinterPayload({
        kind: 'pallet_label',
        documentId: 'pl-1',
        templateVersion: 'pallet-100x150-v1',
        widthMm: 100,
        heightMm: 150,
        dpi: 203,
        widthDots: 800,
        heightDots: 1200,
        bitmapBase64: bytes.toString('base64'),
        copies: 1,
      }),
    ).toBe(true);
    expect(PALLET_LABEL_PROFILE.bytesPerRow).toBe(100);
  });

  it.each([{ copies: 2 }, { dpi: 300 }, { widthDots: 864 }, { bitmapBase64: 'not base64!' }])(
    'rejects an incompatible pallet override: %o',
    (override) => {
      expect(
        isPrinterPayload({
          kind: 'pallet_label',
          documentId: 'pl-1',
          templateVersion: 'pallet-100x150-v1',
          widthMm: 100,
          heightMm: 150,
          dpi: 203,
          widthDots: 800,
          heightDots: 1200,
          bitmapBase64: Buffer.alloc(120_000).toString('base64'),
          copies: 1,
          ...override,
        }),
      ).toBe(false);
    },
  );
});
