export type CompactLabelKind = 'roll_label' | 'big_bag_label' | 'operator_defect_label';

export type CompactLabelLayout = {
  kind: CompactLabelKind;
  dpi: number;
  widthMm: 40 | 58;
  heightMm: 50;
  widthDots: number;
  heightDots: number;
  qrX: number;
  qrY: number;
  qrMagnification: number;
  qrMatrixDots: number;
  qrEnvelopeDots: number;
  qrMatrixMm: number;
  qrEnvelopeMm: number;
  textX: number;
  textWidthDots: number;
  textTop: number;
  textBottom: number;
  textFontHeightDots: number;
  textFontWidthDots: number;
  textLineStepDots: number;
};

const DOTS_PER_INCH_MM = 25.4;
const LABEL_SIZE_MM = {
  roll_label: { width: 40, height: 50 },
  operator_defect_label: { width: 40, height: 50 },
  big_bag_label: { width: 58, height: 50 },
} as const;

/*
 * Scan identities are fixed-length 68-byte tokens. At error correction L they fit QR version 4:
 * 33 data modules plus the mandatory four-module quiet zone on each side. A native printer may
 * interpret the QR origin as either the matrix or its full envelope, so the command origin and
 * the reserved footprint are both kept clear of the media edge.
 */
const QR_MATRIX_MODULES = 33;
const QR_QUIET_ZONE_MODULES = 4;
const QR_ENVELOPE_MODULES = QR_MATRIX_MODULES + QR_QUIET_ZONE_MODULES * 2;
const MAX_PORTABLE_NATIVE_QR_MAGNIFICATION = 10;
const EDGE_MARGIN_MM = 4;
const TEXT_GAP_MM = 1;
const TEXT_COLUMN_MM = 13;
const TEXT_FONT_HEIGHT_MM = 2.5;
const TEXT_FONT_WIDTH_MM = 1.2;
const TEXT_LINE_GAP_MM = 0.65;

const mmToDots = (millimetres: number, dpi: number): number =>
  Math.round((millimetres * dpi) / DOTS_PER_INCH_MM);

const dotsToMm = (dots: number, dpi: number): number =>
  Math.round(((dots * DOTS_PER_INCH_MM) / dpi) * 100) / 100;

export function resolveLabelLayout(kind: CompactLabelKind, dpi: number): CompactLabelLayout {
  if (!Number.isInteger(dpi) || dpi < 150 || dpi > 600) {
    throw new Error('compact label dpi must be an integer between 150 and 600');
  }

  const { width: widthMm, height: heightMm } = LABEL_SIZE_MM[kind];
  const widthDots = mmToDots(widthMm, dpi);
  const heightDots = mmToDots(heightMm, dpi);
  if (kind !== 'big_bag_label') {
    const margin = mmToDots(2, dpi);
    const qrMagnification = Math.max(
      4,
      Math.min(
        MAX_PORTABLE_NATIVE_QR_MAGNIFICATION,
        Math.floor(mmToDots(kind === 'roll_label' ? 32 : 26, dpi) / QR_ENVELOPE_MODULES),
      ),
    );
    const qrMatrixDots = QR_MATRIX_MODULES * qrMagnification;
    const qrEnvelopeDots = QR_ENVELOPE_MODULES * qrMagnification;
    const qrY = (kind === 'roll_label' ? 0 : margin) + QR_QUIET_ZONE_MODULES * qrMagnification;
    const textFontHeightDots = mmToDots(kind === 'roll_label' ? 4 : 3, dpi);
    return {
      kind,
      dpi,
      widthMm,
      heightMm,
      widthDots,
      heightDots,
      qrX: Math.floor((widthDots - qrMatrixDots) / 2),
      qrY,
      qrMagnification,
      qrMatrixDots,
      qrEnvelopeDots,
      qrMatrixMm: dotsToMm(qrMatrixDots, dpi),
      qrEnvelopeMm: dotsToMm(qrEnvelopeDots, dpi),
      textX: margin,
      textWidthDots: widthDots - 2 * margin,
      // Native ZPL adds two module rows above the matrix; keep its lower quiet zone clear.
      textTop:
        qrY +
        qrMatrixDots +
        (QR_QUIET_ZONE_MODULES + 2) * qrMagnification +
        mmToDots(TEXT_GAP_MM, dpi),
      textBottom: heightDots - margin,
      textFontHeightDots,
      textFontWidthDots: mmToDots(kind === 'roll_label' ? 1.9 : 1.5, dpi),
      textLineStepDots: textFontHeightDots + mmToDots(0.5, dpi),
    };
  }

  const edgeMargin = Math.max(1, mmToDots(EDGE_MARGIN_MM, dpi));
  const textGap = Math.max(1, mmToDots(TEXT_GAP_MM, dpi));
  const textColumn = mmToDots(TEXT_COLUMN_MM, dpi);
  const availableQrDots = Math.min(
    heightDots - edgeMargin,
    widthDots - edgeMargin * 2 - textGap - textColumn,
  );
  const qrMagnification = Math.min(
    MAX_PORTABLE_NATIVE_QR_MAGNIFICATION,
    Math.floor(availableQrDots / QR_ENVELOPE_MODULES),
  );

  if (qrMagnification < 4) {
    throw new Error('configured dpi cannot produce a readable compact QR label');
  }

  const qrEnvelopeDots = QR_ENVELOPE_MODULES * qrMagnification;
  const qrMatrixDots = QR_MATRIX_MODULES * qrMagnification;
  const qrOriginMargin = edgeMargin;
  const safeAvailableQrDots = Math.min(
    heightDots - qrOriginMargin,
    widthDots - qrOriginMargin * 2 - textGap - textColumn,
  );
  if (qrEnvelopeDots > safeAvailableQrDots) {
    throw new Error('configured compact label cannot contain the requested QR geometry');
  }
  const qrX = qrOriginMargin;
  const qrY = Math.max(qrOriginMargin, Math.floor((heightDots - qrEnvelopeDots) / 2));
  const textX = qrX + qrEnvelopeDots + textGap;
  const textWidthDots = widthDots - textX - qrOriginMargin;
  if (textWidthDots < textColumn) {
    throw new Error('configured compact label has no safe text column');
  }
  const textFontHeightDots = Math.max(12, mmToDots(TEXT_FONT_HEIGHT_MM, dpi));
  const textFontWidthDots = Math.max(8, mmToDots(TEXT_FONT_WIDTH_MM, dpi));
  const textLineStepDots = textFontHeightDots + Math.max(3, mmToDots(TEXT_LINE_GAP_MM, dpi));

  return {
    kind,
    dpi,
    widthMm,
    heightMm,
    widthDots,
    heightDots,
    qrX,
    qrY,
    qrMagnification,
    qrMatrixDots,
    qrEnvelopeDots,
    qrMatrixMm: dotsToMm(qrMatrixDots, dpi),
    qrEnvelopeMm: dotsToMm(qrEnvelopeDots, dpi),
    textX,
    textWidthDots,
    textTop: qrOriginMargin + textLineStepDots,
    textBottom: heightDots,
    textFontHeightDots,
    textFontWidthDots,
    textLineStepDots,
  };
}
