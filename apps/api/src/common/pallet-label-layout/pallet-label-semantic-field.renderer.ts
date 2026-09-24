import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as fontkit from '@pdf-lib/fontkit';

export type PalletLabelSemanticFieldBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type FittedText = {
  readonly fontSize: number;
  readonly lines: readonly string[];
  readonly lineHeight: number;
  readonly emergency: boolean;
};

// Used only after the editor-selected range cannot preserve all content inside the published
// geometry. The renderer still tries the configured range first and never truncates text.
export const PALLET_LABEL_EMERGENCY_MIN_FONT_SIZE = 4;

const fontRoot = dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const boldFontPath = join(fontRoot, 'ttf/DejaVuSans-Bold.ttf');
const boldFont = fontkit.create(readFileSync(boldFontPath));
const MOSCOW_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU-u-nu-latn', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function boldTextRightExtent(value: string, fontSize: number): number {
  const run = boldFont.layout(value);
  return (Math.max(run.advanceWidth, run.bbox.maxX) * fontSize) / boldFont.unitsPerEm;
}

function splitLongWord(word: string, maxWidth: number, fontSize: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const character of Array.from(word)) {
    if (boldTextRightExtent(character, fontSize) > maxWidth) {
      throw new Error('Pallet label contains a glyph wider than its semantic field');
    }
    const candidate = current + character;
    if (current.length > 0 && boldTextRightExtent(candidate, fontSize) > maxWidth) {
      chunks.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function wrapText(
  value: string,
  maxWidth: number,
  fontSize: number,
  breakLongWords: boolean,
): string[] {
  if (value.length === 0) return [''];
  const lines: string[] = [];
  let current = '';

  for (const word of value.split(/\s+/u).filter(Boolean)) {
    const wordFits = boldTextRightExtent(word, fontSize) <= maxWidth;
    if (!wordFits && !breakLongWords) {
      throw new Error('Pallet label contains a word wider than its semantic field');
    }
    const chunks = wordFits ? [word] : splitLongWord(word, maxWidth, fontSize);
    for (const [index, chunk] of chunks.entries()) {
      const separator = current.length > 0 && index === 0 ? ' ' : '';
      const candidate = `${current}${separator}${chunk}`;
      if (boldTextRightExtent(candidate, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) lines.push(current);
      current = chunk;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function fitTextRange(
  value: string,
  bounds: PalletLabelSemanticFieldBounds,
  maximumFontSize: number,
  minimumFontSize: number,
  breakLongWords: boolean,
  emergency: boolean,
): FittedText | null {
  for (let fontSize = maximumFontSize; fontSize >= minimumFontSize; fontSize -= 1) {
    const lineHeight = Math.ceil(fontSize * 1.2);
    let lines: string[];
    try {
      lines = wrapText(value, bounds.width, fontSize, breakLongWords);
    } catch {
      continue;
    }
    if (lines.length * lineHeight <= bounds.height) {
      return { fontSize, lines, lineHeight, emergency };
    }
  }
  return null;
}

function fitText(
  value: string,
  bounds: PalletLabelSemanticFieldBounds,
  maximumFontSize: number,
  minimumFontSize: number,
): FittedText {
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Pallet label semantic field has no printable area');
  }
  const regular = fitTextRange(value, bounds, maximumFontSize, minimumFontSize, false, false);
  if (regular) return regular;

  const emergency = fitTextRange(
    value,
    bounds,
    maximumFontSize,
    PALLET_LABEL_EMERGENCY_MIN_FONT_SIZE,
    true,
    true,
  );
  if (emergency) return emergency;
  throw new Error('Pallet label text exceeds semantic field capacity');
}

export function formatPalletLabelCreatedAt(value: string): string {
  const parts = MOSCOW_DATE_TIME_FORMATTER.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const result = parts.find((item) => item.type === type)?.value;
    if (!result) throw new Error(`Pallet label createdAt is missing ${type}`);
    return result;
  };
  return (
    `Сформировано: ${part('day')}.${part('month')}.${part('year')} ` +
    `${part('hour')}:${part('minute')} МСК`
  );
}

export function renderPalletLabelSemanticField(
  field: string,
  bounds: PalletLabelSemanticFieldBounds,
  caption: string,
  value: string,
  maximumFontSize: number,
  minimumFontSize = 9,
): string {
  const displayValue = value.length > 0 ? value : '—';
  const content = caption.length > 0 ? `${caption}: ${displayValue}` : displayValue;
  const fitted = fitText(content, bounds, maximumFontSize, minimumFontSize);
  const textHeight = fitted.lines.length * fitted.lineHeight;
  const y = bounds.y + fitted.fontSize + Math.floor((bounds.height - textHeight) / 2);
  const spans = fitted.lines
    .map(
      (line, index) =>
        `<tspan x="${bounds.x}" dy="${index === 0 ? 0 : fitted.lineHeight}">` +
        `${escapeXml(line)}</tspan>`,
    )
    .join('');

  return (
    `<g data-business-field="${escapeXml(field)}" data-field-bounds="${bounds.x},${bounds.y},` +
    `${bounds.width},${bounds.height}" data-fit-font-size="${fitted.fontSize}"` +
    `${fitted.emergency ? ' data-fit-mode="emergency"' : ''}>` +
    `<desc data-business-value="true">${escapeXml(value)}</desc>` +
    `<text x="${bounds.x}" y="${y}" font-family="DejaVu Sans" ` +
    `font-size="${fitted.fontSize}" font-weight="bold" font-style="normal" ` +
    `fill="#000000" text-anchor="start">${spans}</text></g>`
  );
}
