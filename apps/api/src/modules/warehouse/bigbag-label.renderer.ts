import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { isBigBagScanToken, type BigBagLabelPrinterPayload } from '@plenka/contracts';
import { Resvg, type ResvgRenderOptions } from '@resvg/resvg-js';
import QRCode from 'qrcode';

const fontRoot = dirname(require.resolve('dejavu-fonts-ttf/package.json'));

/**
 * The API image ships no system fonts, so the bundled DejaVu faces must be loaded
 * explicitly — otherwise resvg drops every <text> and prints a bare QR.
 */
export const BIG_BAG_LABEL_RESVG_OPTIONS: ResvgRenderOptions = {
  font: {
    fontFiles: [
      join(fontRoot, 'ttf/DejaVuSansMono.ttf'),
      join(fontRoot, 'ttf/DejaVuSansMono-Bold.ttf'),
      join(fontRoot, 'ttf/DejaVuSans.ttf'),
      join(fontRoot, 'ttf/DejaVuSans-Bold.ttf'),
    ],
    loadSystemFonts: false,
    defaultFontFamily: 'DejaVu Sans Mono',
  },
};

export const BIG_BAG_BROWSER_LABEL_PROFILE = {
  widthMm: 58,
  heightMm: 50,
  dpi: 203,
  widthPx: 464,
  heightPx: 400,
  edgeMarginPx: 32,
  qrX: 32,
  qrY: 56,
  qrModuleSize: 7,
  qrEnvelopePx: 287,
  textX: 327,
  textWidthPx: 105,
} as const;

type BigBagLabelInput = Omit<BigBagLabelPrinterPayload, 'kind' | 'destination'>;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function textLines(value: string, maximumCharacters = 10): string[] {
  const words = value.replace(/\s+/gu, ' ').trim().split(' ');
  const lines: string[] = [];
  for (const word of words) {
    if (word.length > maximumCharacters) {
      for (let offset = 0; offset < word.length; offset += maximumCharacters) {
        lines.push(word.slice(offset, offset + maximumCharacters));
      }
      continue;
    }
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length <= maximumCharacters) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

function qrMarkup(token: string): string {
  if (!isBigBagScanToken(token)) throw new Error('Invalid Big-Bag scan token');
  const qr = QRCode.create(token, { version: 4, errorCorrectionLevel: 'L' });
  const moduleSize = BIG_BAG_BROWSER_LABEL_PROFILE.qrModuleSize;
  const quietZone = 4;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (qr.modules.size !== 33 || envelopeSize !== BIG_BAG_BROWSER_LABEL_PROFILE.qrEnvelopePx) {
    throw new Error('Unexpected Big-Bag QR geometry');
  }
  const envelopeX = BIG_BAG_BROWSER_LABEL_PROFILE.qrX;
  const envelopeY = BIG_BAG_BROWSER_LABEL_PROFILE.qrY;
  const originX = envelopeX + quietZone * moduleSize;
  const originY = envelopeY + quietZone * moduleSize;
  const modules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      modules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return (
    `<g data-bigbag-qr="true" data-qr-module-count="33" ` +
    `data-qr-module-size="${moduleSize}" shape-rendering="crispEdges">` +
    `<rect x="${envelopeX}" y="${envelopeY}" width="${envelopeSize}" ` +
    `height="${envelopeSize}" fill="#fff"/>` +
    `<path d="${modules.join('')}" fill="#000"/>` +
    '</g>'
  );
}

function labelText(input: BigBagLabelInput): string {
  const codeLines = textLines(input.bigBagCode);
  const lines = [...codeLines, ...textLines(input.material)].slice(0, 9);
  return lines
    .map(
      (line, index) =>
        `<text x="${BIG_BAG_BROWSER_LABEL_PROFILE.textX}" y="${74 + index * 25}" ` +
        `font-family="DejaVu Sans Mono, monospace" ` +
        `font-size="${index < codeLines.length ? 15 : 14}" ` +
        `font-weight="${index < codeLines.length ? 700 : 500}" ` +
        `fill="#000">${escapeXml(line)}</text>`,
    )
    .join('');
}

@Injectable()
export class BigBagLabelRenderer {
  render(input: BigBagLabelInput): {
    buffer: Buffer;
    contentType: 'image/png';
    widthPx: number;
    heightPx: number;
    svg: string;
  } {
    if (!input.bigBagCode.trim() || !input.material.trim()) {
      throw new Error('Big-Bag label text is required');
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${BIG_BAG_BROWSER_LABEL_PROFILE.widthPx}" ` +
      `height="${BIG_BAG_BROWSER_LABEL_PROFILE.heightPx}" ` +
      `viewBox="0 0 ${BIG_BAG_BROWSER_LABEL_PROFILE.widthPx} ${BIG_BAG_BROWSER_LABEL_PROFILE.heightPx}">` +
      `<rect width="100%" height="100%" fill="#fff"/>` +
      qrMarkup(input.qrCode) +
      `<svg x="${BIG_BAG_BROWSER_LABEL_PROFILE.textX}" y="0" ` +
      `width="${BIG_BAG_BROWSER_LABEL_PROFILE.textWidthPx}" ` +
      `height="${BIG_BAG_BROWSER_LABEL_PROFILE.heightPx}" overflow="hidden">` +
      `<g transform="translate(-${BIG_BAG_BROWSER_LABEL_PROFILE.textX} 0)">` +
      labelText(input) +
      '</g></svg>' +
      '</svg>';
    const buffer = new Resvg(svg, BIG_BAG_LABEL_RESVG_OPTIONS).render().asPng();
    return {
      buffer,
      contentType: 'image/png',
      widthPx: BIG_BAG_BROWSER_LABEL_PROFILE.widthPx,
      heightPx: BIG_BAG_BROWSER_LABEL_PROFILE.heightPx,
      svg,
    };
  }
}
