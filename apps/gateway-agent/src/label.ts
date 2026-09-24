import {
  isPrinterPayload,
  PALLET_LABEL_PROFILE,
  type BigBagLabelPrinterPayload,
  type PalletLabelPrinterPayload,
  type PrinterPayload,
  type RollLabelPrinterPayload,
} from '@plenka/contracts';
import { resolveLabelLayout, type CompactLabelKind, type CompactLabelLayout } from './label-layout';

export type PrinterProfile = { dpi: number; maxWidthDots: number };

const TSPL_FONT_1_WIDTH_DOTS = 8;
const TSPL_FONT_1_HEIGHT_DOTS = 12;
const ZPL_GFA_MAX_BYTES = 99_999;

// TSPL2 strings live inside double quotes; strip anything that could break out of them.
const sanitize = (value: string): string => value.replace(/["\\\r\n]/g, '');

const zplHex = (value: string): string =>
  [...Buffer.from(value, 'utf8')]
    .map((byte) => `\\${byte.toString(16).padStart(2, '0').toUpperCase()}`)
    .join('');

const requireCompactLayout = (
  kind: CompactLabelKind,
  profile: PrinterProfile,
): CompactLabelLayout => {
  const layout = resolveLabelLayout(kind, profile.dpi);
  if (layout.widthDots > profile.maxWidthDots) {
    throw new Error('compact label exceeds configured printer width');
  }
  return layout;
};

const splitText = (value: string, charsPerLine: number, maxLines: number): string[] => {
  const characters = Array.from(sanitize(value));
  const lines: string[] = [];
  for (
    let offset = 0;
    offset < characters.length && lines.length < maxLines;
    offset += charsPerLine
  ) {
    lines.push(characters.slice(offset, offset + charsPerLine).join(''));
  }
  return lines;
};

const tsplTextLines = (values: readonly string[], layout: CompactLabelLayout): string[] => {
  const operator = layout.kind !== 'big_bag_label';
  const scale = operator ? Math.max(1, Math.round(layout.dpi / 100)) : layout.dpi >= 300 ? 2 : 1;
  const charWidth = TSPL_FONT_1_WIDTH_DOTS * scale;
  const lineHeight = TSPL_FONT_1_HEIGHT_DOTS * scale;
  const lineStep = lineHeight + Math.max(4, Math.round(layout.dpi / (operator ? 50 : 34)));
  const charsPerLine = Math.max(1, Math.floor(layout.textWidthDots / charWidth));
  const maxLines = Math.max(1, Math.floor((layout.textBottom - layout.textTop) / lineStep));
  const lines = values.flatMap((value, index) => [
    ...(index === 0 || operator ? [] : ['']),
    ...splitText(value, charsPerLine, maxLines),
  ]);

  return lines
    .slice(0, maxLines)
    .flatMap((line, index) =>
      line
        ? [
            `TEXT ${operator ? Math.floor((layout.widthDots - Array.from(line).length * charWidth) / 2) : layout.textX},${layout.textTop + index * lineStep},"1",0,${scale},${scale},"${line}"`,
          ]
        : [],
    );
};

const zplTextLines = (values: readonly string[], layout: CompactLabelLayout): string[] => {
  const operator = layout.kind !== 'big_bag_label';
  const charsPerLine = Math.max(1, Math.floor(layout.textWidthDots / layout.textFontWidthDots));
  const maxLines = Math.max(
    1,
    Math.floor((layout.textBottom - layout.textTop) / layout.textLineStepDots),
  );
  const lines = values.flatMap((value, index) => [
    ...(index === 0 || operator ? [] : ['']),
    ...splitText(value, charsPerLine, maxLines),
  ]);

  return lines
    .slice(0, maxLines)
    .flatMap((line, index) =>
      line
        ? [
            `^FO${layout.textX},${layout.textTop + index * layout.textLineStepDots},0` +
              `^A0N,${layout.textFontHeightDots},${layout.textFontWidthDots}` +
              (operator ? `^FB${layout.textWidthDots},1,0,C,0` : '') +
              `^FH\\^FD${zplHex(line)}^FS`,
          ]
        : [],
    );
};

function rollTspl(payload: RollLabelPrinterPayload, profile: PrinterProfile): Buffer {
  const layout = requireCompactLayout('roll_label', profile);
  return Buffer.from(
    [
      `SIZE ${layout.widthMm} mm,${layout.heightMm} mm`,
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'REFERENCE 0,0',
      'CLS',
      `QRCODE ${layout.qrX},${layout.qrY},L,${layout.qrMagnification},A,0,M2,S7,"${payload.qrCode}"`,
      ...tsplTextLines([payload.rollCode], layout),
      'PRINT 1,1',
      '',
    ].join('\r\n'),
    'ascii',
  );
}

function bigBagTspl(payload: BigBagLabelPrinterPayload, profile: PrinterProfile): Buffer {
  const layout = requireCompactLayout(
    payload.destination === 'operator' ? 'operator_defect_label' : 'big_bag_label',
    profile,
  );
  return Buffer.from(
    [
      `SIZE ${layout.widthMm} mm,${layout.heightMm} mm`,
      'GAP 2 mm,0 mm',
      'DIRECTION 1',
      'REFERENCE 0,0',
      'CODEPAGE UTF-8',
      'CLS',
      `QRCODE ${layout.qrX},${layout.qrY},L,${layout.qrMagnification},A,0,M2,S7,"${payload.qrCode}"`,
      ...tsplTextLines([payload.bigBagCode, payload.material], layout),
      'PRINT 1,1',
      '',
    ].join('\r\n'),
    'utf8',
  );
}

function palletTspl(payload: PalletLabelPrinterPayload, profile: PrinterProfile): Buffer {
  if (profile.dpi !== payload.dpi || payload.widthDots > profile.maxWidthDots) {
    throw new Error('pallet label does not match configured printer profile');
  }
  const bitmap = Buffer.from(payload.bitmapBase64, 'base64');
  if (bitmap.length !== PALLET_LABEL_PROFILE.bitmapBytes) {
    throw new Error('pallet bitmap length must be 120000 bytes');
  }
  return Buffer.concat([
    Buffer.from(
      'SIZE 100 mm,150 mm\r\n' +
        'GAP 2 mm,0 mm\r\n' +
        'DIRECTION 1\r\n' +
        'REFERENCE 0,0\r\n' +
        'CLS\r\n' +
        'BITMAP 0,0,100,1200,0,',
      'ascii',
    ),
    bitmap,
    Buffer.from('\r\nPRINT 1,1\r\n', 'ascii'),
  ]);
}

/** The sole TSPL builder: validates the shared contract and always returns raw bytes. */
export function buildPrintBytes(payload: PrinterPayload, profile: PrinterProfile): Buffer {
  if (!isPrinterPayload(payload)) throw new Error('invalid printer payload');
  if (payload.kind === 'pallet_label') return palletTspl(payload, profile);
  if (payload.kind === 'big_bag_label') return bigBagTspl(payload, profile);
  return rollTspl(payload, profile);
}

function rollZpl(payload: RollLabelPrinterPayload, profile: PrinterProfile): Buffer {
  const layout = requireCompactLayout('roll_label', profile);
  return Buffer.from(
    [
      '^XA',
      `^CI28^PW${layout.widthDots}^LL${layout.heightDots}^PON^PMN^LRN^FWN,0^LH0,0^LT0^LS0`,
      `^FO${layout.qrX},${layout.qrY},0^BQN,2,${layout.qrMagnification},L,7^FDLA,${payload.qrCode}^FS`,
      ...zplTextLines([payload.rollCode], layout),
      '^PQ1',
      '^XZ',
      '',
    ].join('\r\n'),
    'ascii',
  );
}

function bigBagZpl(payload: BigBagLabelPrinterPayload, profile: PrinterProfile): Buffer {
  const layout = requireCompactLayout(
    payload.destination === 'operator' ? 'operator_defect_label' : 'big_bag_label',
    profile,
  );
  return Buffer.from(
    [
      '^XA',
      `^CI28^PW${layout.widthDots}^LL${layout.heightDots}^PON^PMN^LRN^FWN,0^LH0,0^LT0^LS0`,
      `^FO${layout.qrX},${layout.qrY},0^BQN,2,${layout.qrMagnification},L,7^FDLA,${payload.qrCode}^FS`,
      ...zplTextLines([payload.bigBagCode, payload.material], layout),
      '^PQ1',
      '^XZ',
      '',
    ].join('\r\n'),
    'ascii',
  );
}

function palletZpl(payload: PalletLabelPrinterPayload, profile: PrinterProfile): Buffer {
  if (profile.dpi !== payload.dpi || payload.widthDots > profile.maxWidthDots) {
    throw new Error('pallet label does not match configured printer profile');
  }
  const bitmap = Buffer.from(payload.bitmapBase64, 'base64');
  if (bitmap.length !== PALLET_LABEL_PROFILE.bitmapBytes) {
    throw new Error('pallet bitmap length must be 120000 bytes');
  }
  const rowBytes = payload.widthDots / 8;
  const maxRowsPerField = Math.floor(ZPL_GFA_MAX_BYTES / rowBytes);
  const fields: string[] = [];
  for (let row = 0; row < payload.heightDots; row += maxRowsPerField) {
    const rows = Math.min(maxRowsPerField, payload.heightDots - row);
    const byteCount = rows * rowBytes;
    const chunk = bitmap.subarray(row * rowBytes, (row + rows) * rowBytes);
    fields.push(
      `^FO0,${row},0^GFA,${byteCount},${byteCount},${rowBytes},${chunk
        .toString('hex')
        .toUpperCase()}^FS`,
    );
  }
  return Buffer.from(
    `^XA\r\n^CI28^PW${payload.widthDots}^LL${payload.heightDots}^PON^PMN^LRN^FWN,0^LH0,0^LT0^LS0\r\n` +
      `${fields.join('\r\n')}\r\n` +
      '^PQ1\r\n^XZ\r\n',
    'ascii',
  );
}

/** ZPL renderer for the verified MERTECH TLP4 USB/CUPS raw path. */
export function buildZplPrintBytes(payload: PrinterPayload, profile: PrinterProfile): Buffer {
  if (!isPrinterPayload(payload)) throw new Error('invalid printer payload');
  if (payload.kind === 'pallet_label') return palletZpl(payload, profile);
  if (payload.kind === 'big_bag_label') return bigBagZpl(payload, profile);
  return rollZpl(payload, profile);
}
