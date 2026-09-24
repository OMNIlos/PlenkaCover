import { PALLET_LABEL_PROFILE, type PalletLabelPrinterPayload } from '@plenka/contracts';
import { createHash } from 'node:crypto';
import { buildPrintBytes, buildZplPrintBytes, type PrinterProfile } from './label';
import { resolveLabelLayout } from './label-layout';

const PROFILE: PrinterProfile = { dpi: 203, maxWidthDots: 864 };
const BITMAP = Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes, 0xaa);

const palletPayload = (
  overrides: Partial<PalletLabelPrinterPayload> = {},
): PalletLabelPrinterPayload => ({
  kind: 'pallet_label',
  documentId: 'pl-1',
  templateVersion: PALLET_LABEL_PROFILE.templateVersion,
  widthMm: PALLET_LABEL_PROFILE.widthMm,
  heightMm: PALLET_LABEL_PROFILE.heightMm,
  dpi: PALLET_LABEL_PROFILE.dpi,
  widthDots: PALLET_LABEL_PROFILE.widthDots,
  heightDots: PALLET_LABEL_PROFILE.heightDots,
  bitmapBase64: BITMAP.toString('base64'),
  copies: PALLET_LABEL_PROFILE.copies,
  ...overrides,
});

describe('compact label physical geometry', () => {
  it.each([
    ['big_bag_label', 203, 7],
    ['big_bag_label', 300, 10],
  ] as const)(
    'keeps one dominant, readable %s QR at %i dpi',
    (kind, dpi, expectedMagnification) => {
      const layout = resolveLabelLayout(kind, dpi);

      expect(layout.qrMagnification).toBe(expectedMagnification);
      expect(layout.qrEnvelopeMm).toBeGreaterThanOrEqual(34);
      expect(layout.qrEnvelopeMm).toBeLessThanOrEqual(layout.heightMm);
      expect(layout.qrMatrixMm).toBeGreaterThanOrEqual(27.5);
      expect(layout.qrX).toBeGreaterThanOrEqual(layout.qrMagnification * 4);
      expect(layout.qrY).toBeGreaterThanOrEqual(layout.qrMagnification * 4);
      expect(layout.qrX + layout.qrEnvelopeDots).toBeLessThan(layout.textX);
      expect(layout.textX + layout.textWidthDots).toBeLessThanOrEqual(layout.widthDots);
    },
  );

  it.each([203, 300])(
    'centers a 25 mm roll QR above larger text inside 40x50 mm media at %i dpi',
    (dpi) => {
      const layout = resolveLabelLayout('roll_label', dpi);

      expect(layout.widthMm).toBe(40);
      expect(layout.heightMm).toBe(50);
      expect(layout.qrMatrixMm).toBeGreaterThanOrEqual(24.5);
      expect(layout.qrMatrixMm).toBeLessThanOrEqual(25.5);
      expect(
        Math.abs(layout.widthDots - (2 * layout.qrX + layout.qrMatrixDots)),
      ).toBeLessThanOrEqual(1);
      expect(layout.qrX - layout.qrMagnification * 4).toBeGreaterThan(0);
      expect(layout.qrY).toBeGreaterThanOrEqual(layout.qrMagnification * 4);
      expect(layout.textTop).toBeGreaterThan(
        layout.qrY + layout.qrMatrixDots + 6 * layout.qrMagnification,
      );
      expect((layout.textFontHeightDots * 25.4) / dpi).toBeGreaterThan(3.9);
      expect(layout.textX + layout.textWidthDots).toBeLessThan(layout.widthDots);
    },
  );
});

describe('buildPrintBytes — roll label', () => {
  const token = `prt_${'a'.repeat(64)}`;

  it('emits one complete ASCII TSPL2 job with QR + human-readable roll code', () => {
    const bytes = buildPrintBytes(
      { kind: 'roll_label', rollCode: 'A-1024-roll-1', qrCode: token },
      PROFILE,
    );
    const tspl = bytes.toString('ascii');
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(tspl).toContain('SIZE 40 mm,50 mm');
    expect(tspl).toContain('REFERENCE 0,0');
    expect(tspl).toContain(`QRCODE 61,24,L,6,A,0,M2,S7,"${token}"`);
    expect(tspl).toContain('TEXT 56,266,"1",0,2,2,"A-1024-roll-1"');
    expect(tspl.match(/^QRCODE /gmu)).toHaveLength(1);
    expect(tspl.match(/^BITMAP /gmu) ?? []).toHaveLength(0);
    expect(tspl.match(/PRINT 1,1/g)).toHaveLength(1);
  });

  it('sanitizes quotes/newlines so payloads cannot break out of TSPL strings', () => {
    const tspl = buildPrintBytes(
      { kind: 'roll_label', rollCode: 'x"\r\nPRINT 99', qrCode: token },
      PROFILE,
    ).toString('ascii');
    expect(tspl).toContain('"xPRINT 99"');
    const printLines = tspl.split('\r\n').filter((line) => line.startsWith('PRINT'));
    expect(printLines).toEqual(['PRINT 1,1']);
  });

  it('keeps a long human-readable code inside the printable width', () => {
    const tspl = buildPrintBytes(
      {
        kind: 'roll_label',
        rollCode: 'DEMO-VERY-LONG-ROLL-CODE-THAT-CANNOT-FIT-WITHOUT-CLIPPING',
        qrCode: token,
      },
      PROFILE,
    ).toString('ascii');
    const text = [...tspl.matchAll(/TEXT (\d+),(\d+),"1",0,2,2,"([^"]+)"/gu)];

    expect(text.length).toBeGreaterThan(1);
    expect(text.every((line) => Number(line[1]) >= 16)).toBe(true);
    expect(text.every((line) => Number(line[2]) + 24 <= 384)).toBe(true);
    expect(text.every((line) => Array.from(line[3]).length <= 18)).toBe(true);
    expect(text.map((line) => line[3]).join('')).toBe(
      'DEMO-VERY-LONG-ROLL-CODE-THAT-CANNOT-FIT-WITHOUT-CLIPPING',
    );
  });

  it.each([
    'QR-legacy',
    `prt_${'a'.repeat(63)}`,
    `prt_${'A'.repeat(64)}`,
    `prt_${'a'.repeat(63)}"`,
    `prt_${'a'.repeat(63)}\\`,
    `prt_${'a'.repeat(63)}\n`,
    `prt_${'a'.repeat(63)}я`,
  ])('rejects an invalid opaque QR identity instead of transforming %j', (qrCode) => {
    expect(() =>
      buildPrintBytes({ kind: 'roll_label', rollCode: 'ROLL-1', qrCode }, PROFILE),
    ).toThrow('invalid printer payload');
  });
});

describe('buildPrintBytes — Big-Bag label', () => {
  const token = `bbt_${'b'.repeat(64)}`;

  it('prints one immutable QR identity plus safe human-readable bag facts', () => {
    const bytes = buildPrintBytes(
      {
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'BB-PVD-01',
        material: 'ПВД Первичное',
        qrCode: token,
      },
      PROFILE,
    );
    const tspl = bytes.toString('utf8');

    expect(tspl).toContain(`QRCODE 32,56,L,7,A,0,M2,S7,"${token}"`);
    expect(tspl).toContain('BB-PVD-01');
    expect(tspl).toContain('ПВД Первичное');
    expect(tspl.match(/^QRCODE /gmu)).toHaveLength(1);
    expect(tspl.match(/PRINT 1,1/g)).toHaveLength(1);
  });

  it('renders the same opaque identity in the ZPL path', () => {
    const zpl = buildZplPrintBytes(
      {
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'BB-PVD-01',
        material: 'ПВД Первичное',
        qrCode: token,
      },
      PROFILE,
    ).toString('ascii');

    expect(zpl).toContain(`^FDLA,${token}^FS`);
    expect(zpl).toContain('^PQ1');
  });

  it('prints defect-bag facts without allowing command injection', () => {
    const payload = {
      kind: 'big_bag_label' as const,
      destination: 'operator' as const,
      bigBagCode: 'DEF-1"\r\nPRINT 99',
      material: 'БРАК · 12.345 кг^XZ\n~JA',
      qrCode: token,
    };
    const tspl = buildPrintBytes(payload, PROFILE).toString('utf8');
    const zpl = buildZplPrintBytes(payload, PROFILE).toString('ascii');

    expect(tspl).toContain('DEF-1PRINT 99');
    const printedText = [...tspl.matchAll(/TEXT [^\r\n]+,"([^"]*)"/gu)]
      .map((line) => line[1])
      .join('');
    expect(printedText).toContain('БРАК · 12.345 кг^XZ~JA');
    expect(tspl.split('\r\n').filter((line) => line.startsWith('PRINT'))).toEqual(['PRINT 1,1']);
    expect(zpl.match(/\^XZ/gu)).toHaveLength(1);
    expect(zpl).not.toContain('~JA');
    expect(zpl).toContain(`^FDLA,${token}^FS`);
  });

  it.each([203, 300])('fits the longest generated defect-bag code and weight at %i dpi', (dpi) => {
    const payload = {
      kind: 'big_bag_label' as const,
      destination: 'operator' as const,
      bigBagCode: 'DEF-20260922-ABCDEFGHIJKLMNOPQRSTUVWX-999999',
      material: 'БРАК · Первичка · 10000.000 кг',
      qrCode: token,
    };
    const profile = { dpi, maxWidthDots: 864 };
    const tspl = buildPrintBytes(payload, profile).toString('utf8');
    const zpl = buildZplPrintBytes(payload, profile).toString('ascii');
    expect(tspl).toContain('SIZE 40 mm,50 mm');
    expect(zpl).toContain(dpi === 203 ? '^PW320^LL400' : '^PW472^LL591');
    const tsplText = [...tspl.matchAll(/TEXT (\d+),(\d+),"1",0,(\d+),(\d+),"([^"]*)"/gu)];
    const zplText = [...zpl.matchAll(/\^FH\\\^FD((?:\\[0-9A-F]{2})+)\^FS/gu)];
    expect(tsplText.map((line) => line[5]).join('')).toBe(payload.bigBagCode + payload.material);
    expect(
      zplText
        .map((line) => Buffer.from(line[1].replaceAll('\\', ''), 'hex').toString('utf8'))
        .join(''),
    ).toBe(payload.bigBagCode + payload.material);
    expect(
      tsplText.every((line) => Number(line[2]) + 12 * Number(line[4]) < (48 * dpi) / 25.4),
    ).toBe(true);
    expect(tspl).toContain(`"${token}"`);
    expect(zpl).toContain(`^FDLA,${token}^FS`);
  });

  it.each([
    [
      203,
      '20d5802a4ce72f6b70d6d1c261c84fc47d4c62701616ae5594bfc62ea01af462',
      '94002fb2b91d71ae95f4b5b68ca8d48a5135c2664069219abc5e662b95d7fdc5',
    ],
    [
      300,
      'f8fb4ff5702ebae509dcbe3d65028a43186ca274004e98bcf295318561f2eafd',
      '1263ca22837d86649701316936ac9457cd069bd21a492f88905cbb43880be411',
    ],
  ] as const)('keeps warehouse print bytes unchanged at %i dpi', (dpi, tsplHash, zplHash) => {
    const payload = {
      kind: 'big_bag_label' as const,
      destination: 'warehouse' as const,
      bigBagCode: 'BB-PVD-01',
      material: 'ПВД Первичное',
      qrCode: token,
    };
    for (const [build, hash] of [
      [buildPrintBytes, tsplHash],
      [buildZplPrintBytes, zplHash],
    ] as const) {
      expect(
        createHash('sha256')
          .update(build(payload, { dpi, maxWidthDots: 1280 }))
          .digest('hex'),
      ).toBe(hash);
    }
  });
});

describe('buildPrintBytes — pallet label', () => {
  it('embeds the exact 1-bit bitmap in one 100x150 TSPL job', () => {
    const bytes = buildPrintBytes(palletPayload(), PROFILE);
    const bitmapOffset = bytes.indexOf(BITMAP);
    const header = bytes.subarray(0, bitmapOffset).toString('ascii');

    expect(header).toContain('SIZE 100 mm,150 mm\r\n');
    expect(header).toContain('REFERENCE 0,0\r\n');
    expect(bytes.indexOf(Buffer.from('BITMAP 0,0,100,1200,0,', 'ascii'))).toBeGreaterThanOrEqual(0);
    expect(bitmapOffset).toBeGreaterThan(0);
    expect(bytes.subarray(bitmapOffset, bitmapOffset + BITMAP.length)).toEqual(BITMAP);
    expect(bytes.toString('latin1').match(/PRINT 1,1/g)).toHaveLength(1);
  });

  it.each([
    ['invalid base64', { bitmapBase64: 'not-base64!' }, PROFILE],
    [
      'decoded bitmap length',
      { bitmapBase64: Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes - 1).toString('base64') },
      PROFILE,
    ],
    ['payload dpi', { dpi: 300 }, PROFILE],
    ['payload width', { widthDots: 799 }, PROFILE],
    ['payload height', { heightDots: 1199 }, PROFILE],
    ['copies', { copies: 2 }, PROFILE],
    ['configured max width', {}, { dpi: 203, maxWidthDots: 799 }],
    ['configured dpi', {}, { dpi: 300, maxWidthDots: 864 }],
  ])('rejects an incompatible %s', (_label, overrides, profile) => {
    expect(() =>
      buildPrintBytes(
        palletPayload(overrides as Partial<PalletLabelPrinterPayload>),
        profile as PrinterProfile,
      ),
    ).toThrow();
  });
});

describe('buildZplPrintBytes — CUPS raw USB', () => {
  const token = `prt_${'a'.repeat(64)}`;

  it('emits one complete ZPL roll-label job', () => {
    const zpl = buildZplPrintBytes(
      { kind: 'roll_label', rollCode: 'ROLL-USB-1', qrCode: token },
      PROFILE,
    ).toString('ascii');

    expect(zpl).toMatch(/^\^XA/u);
    expect(zpl).toContain('^CI28^PW320^LL400^PON^PMN^LRN^FWN,0^LH0,0^LT0^LS0');
    expect(zpl).toContain(`^FO61,24,0^BQN,2,6,L,7^FDLA,${token}^FS`);
    expect(zpl).toContain('^FO16,266,0^A0N,32,15^FB288,1,0,C,0^FH\\^FD');
    expect(zpl).toContain('\\52\\4F\\4C\\4C\\2D\\55\\53\\42\\2D\\31');
    expect(zpl.match(/\^BQN/gu)).toHaveLength(1);
    expect(zpl.match(/\^GFA/gu) ?? []).toHaveLength(0);
    expect(zpl.match(/\^PQ1/u)).toHaveLength(1);
    expect(zpl).toMatch(/\^XZ\r\n$/u);
  });

  it('hex-encodes text so ZPL control characters cannot inject another job', () => {
    const zpl = buildZplPrintBytes(
      { kind: 'roll_label', rollCode: 'x^XZ\n~JA', qrCode: token },
      PROFILE,
    ).toString('ascii');

    expect(zpl).not.toContain('x^XZ');
    expect(zpl.match(/\^XZ/gu)).toHaveLength(1);
    expect(zpl).not.toContain('~JA');
  });

  it('segments the exact pallet bitmap into ZPL graphic fields below the protocol limit', () => {
    const zpl = buildZplPrintBytes(palletPayload(), PROFILE).toString('ascii');
    const fields = [...zpl.matchAll(/\^FO0,(\d+),0\^GFA,(\d+),(\d+),100,([0-9A-F]+)\^FS/gu)];

    expect(zpl).toContain('^CI28^PW800^LL1200^PON^PMN^LRN^FWN,0^LH0,0^LT0^LS0');
    expect(fields).toHaveLength(2);
    expect(fields.map((field) => Number(field[1]))).toEqual([0, 999]);
    expect(fields.every((field) => Number(field[2]) <= 99_999)).toBe(true);
    expect(fields.every((field) => field[2] === field[3])).toBe(true);
    expect(fields.map((field) => field[4]).join('')).toBe(BITMAP.toString('hex').toUpperCase());
    expect(zpl.match(/\^PQ1/gu)).toHaveLength(1);
  });
});
