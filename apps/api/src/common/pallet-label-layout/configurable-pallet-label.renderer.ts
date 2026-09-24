import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable } from '@nestjs/common';
import * as fontkit from '@pdf-lib/fontkit';
import type {
  PalletLabelLayoutDefinition,
  PalletLabelLayoutDefinitionV1,
  PalletLabelLayoutDefinitionV2,
  PalletLabelLayoutElementV1,
  PalletLabelLayoutElementV2,
  PalletLabelSnapshot,
} from '@plenka/contracts';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { PALLET_LABEL_ASSETS } from '../../modules/warehouse/pallet-label.assets';
import {
  formatPalletLabelCreatedAt,
  PALLET_LABEL_EMERGENCY_MIN_FONT_SIZE,
  renderPalletLabelSemanticField,
} from './pallet-label-semantic-field.renderer';

// Production tokens contain two UUIDv4 values; their pinned version/variant bits make this
// all-zero, valid-shaped sentinel impossible for the database generator to issue.
export const PALLET_LABEL_LAYOUT_PREVIEW_TOKEN = `plt_${'0'.repeat(64)}` as const;

const fontRoot = dirname(require.resolve('dejavu-fonts-ttf/package.json'));
const regularFontPath = join(fontRoot, 'ttf/DejaVuSans.ttf');
const boldFontPath = join(fontRoot, 'ttf/DejaVuSans-Bold.ttf');
const fontFiles = [regularFontPath, boldFontPath];
const boldFont = fontkit.create(readFileSync(boldFontPath));

type LegacyElementMap = Readonly<
  Record<PalletLabelLayoutElementV1['id'], PalletLabelLayoutElementV1>
>;
type EditableElementMap = Readonly<
  Partial<Record<PalletLabelLayoutElementV2['id'], PalletLabelLayoutElementV2>>
>;
type LayoutElement = PalletLabelLayoutElementV1 | PalletLabelLayoutElementV2;

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

function textWidth(value: string, fontSize: number): number {
  if (value.length === 0) return 0;
  const run = boldFont.layout(value);
  return (Math.max(run.advanceWidth, run.bbox.maxX) * fontSize) / boldFont.unitsPerEm;
}

function rollCodesBlock(element: PalletLabelLayoutElementV1, rollCodes: readonly string[]): string {
  const horizontalPadding = 8;
  const verticalPadding = 6;
  const columnGap = 12;
  const columns = 2;
  const rowsPerColumn = 12;
  const values = rollCodes.map((rollCode, index) => `#${index + 1} ${rollCode}`);
  if (values.length > columns * rowsPerColumn) {
    throw new Error('Pallet layout block rollCodes cannot fit more than 24 rolls');
  }

  let fittedColumns = columns;
  let fittedRows = Math.max(1, Math.min(rowsPerColumn, Math.ceil(values.length / columns)));
  let fittedCellWidth = (element.widthDots - horizontalPadding * 2 - columnGap) / fittedColumns;
  let fittedFontSize: number | null = null;
  let fittedLineHeight = 0;
  let fittedCaptionHeight = 0;
  let emergencyFit = false;
  for (let fontSize = element.maxFontSize; fontSize >= element.minFontSize; fontSize -= 1) {
    const lineHeight = Math.ceil(fontSize * 1.2);
    const captionHeight = Math.ceil(fontSize * 1.5);
    const requiredHeight = verticalPadding * 2 + captionHeight + fittedRows * lineHeight;
    if (
      requiredHeight <= element.heightDots &&
      values.every((value) => textWidth(value, fontSize) <= fittedCellWidth)
    ) {
      fittedFontSize = fontSize;
      fittedLineHeight = lineHeight;
      fittedCaptionHeight = captionHeight;
      break;
    }
  }
  if (fittedFontSize === null) {
    outer: for (
      let fontSize = element.maxFontSize;
      fontSize >= PALLET_LABEL_EMERGENCY_MIN_FONT_SIZE;
      fontSize -= 1
    ) {
      for (const candidateColumns of [1, 2]) {
        const candidateRows = Math.max(1, Math.ceil(values.length / candidateColumns));
        const gaps = columnGap * (candidateColumns - 1);
        const candidateCellWidth =
          (element.widthDots - horizontalPadding * 2 - gaps) / candidateColumns;
        const lineHeight = Math.ceil(fontSize * 1.2);
        const captionHeight = Math.ceil(fontSize * 1.5);
        const requiredHeight = verticalPadding * 2 + captionHeight + candidateRows * lineHeight;
        if (
          candidateCellWidth > 0 &&
          requiredHeight <= element.heightDots &&
          textWidth(`Рулоны на палете: ${values.length}`, fontSize) <=
            element.widthDots - horizontalPadding * 2 &&
          values.every((value) => textWidth(value, fontSize) <= candidateCellWidth)
        ) {
          fittedColumns = candidateColumns;
          fittedRows = candidateRows;
          fittedCellWidth = candidateCellWidth;
          fittedFontSize = fontSize;
          fittedLineHeight = lineHeight;
          fittedCaptionHeight = captionHeight;
          emergencyFit = true;
          break outer;
        }
      }
    }
  }
  if (fittedFontSize === null) {
    throw new Error('Pallet layout block rollCodes cannot fit the selected source');
  }

  const originX = element.xDots + horizontalPadding;
  const originY = element.yDots + verticalPadding;
  const codeElements = values.map((value, index) => {
    const column = Math.floor(index / fittedRows);
    const row = index % fittedRows;
    const x = originX + column * (fittedCellWidth + columnGap);
    const y = originY + fittedCaptionHeight + fittedFontSize! + row * fittedLineHeight;
    return `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${fittedFontSize}" font-weight="bold" fill="#000000">${escapeXml(value)}</text>`;
  });
  return (
    `<g data-layout-element="rollCodes" data-element-bounds="${element.xDots},` +
    `${element.yDots},${element.widthDots},${element.heightDots}" ` +
    `data-fit-font-size="${fittedFontSize}" ` +
    `${emergencyFit ? 'data-fit-mode="emergency" ' : ''}` +
    `data-roll-columns="${fittedColumns}" data-roll-rows="${fittedRows}">` +
    `<desc>${escapeXml(rollCodes.join('\n'))}</desc>` +
    `<text x="${originX}" y="${originY + fittedFontSize}" font-family="DejaVu Sans" ` +
    `font-size="${fittedFontSize}" font-weight="bold" fill="#000000">` +
    `Рулоны на палете: ${rollCodes.length}</text>${codeElements.join('')}</g>`
  );
}

function configurableQr(
  element: LayoutElement,
  qrToken: string,
  preview: boolean,
): string {
  const qr = QRCode.create(qrToken, {
    version: 5,
    errorCorrectionLevel: 'M',
  });
  const quietZone = 4;
  const moduleSize = 7;
  const envelopeSize = (qr.modules.size + quietZone * 2) * moduleSize;
  if (qr.modules.size !== 37 || envelopeSize !== 315) {
    throw new Error('Unexpected configurable pallet-label QR geometry');
  }

  const originX = element.xDots + quietZone * moduleSize;
  const originY = element.yDots + quietZone * moduleSize;
  const darkModules: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column) === 0) continue;
      const x = originX + column * moduleSize;
      const y = originY + row * moduleSize;
      darkModules.push(`M${x} ${y}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return (
    `<g data-layout-element="qr" ${preview ? 'data-preview-qr="true" ' : ''}data-qr-module-count="37" ` +
    `data-qr-module-size="7" shape-rendering="crispEdges">` +
    `<rect x="${element.xDots}" y="${element.yDots}" width="315" height="315" ` +
    'fill="#ffffff"/>' +
    `<path d="${darkModules.join('')}" fill="#000000"/></g>`
  );
}

function legacyElementsById(layout: PalletLabelLayoutDefinitionV1): LegacyElementMap {
  return Object.fromEntries(
    layout.elements.map((element) => [element.id, element]),
  ) as LegacyElementMap;
}

function editableElementsById(layout: PalletLabelLayoutDefinitionV2): EditableElementMap {
  return Object.fromEntries(
    layout.elements.map((element) => [element.id, element]),
  ) as EditableElementMap;
}

function display(value: string | number | null): string {
  return value === null || value === '' ? '—' : String(value);
}

type SemanticField = {
  readonly bounds: {
    readonly fixedWidthDots?: number;
    readonly height: number;
    readonly rightInsetDots?: number;
    readonly x: number;
    readonly y: number;
  };
  readonly caption: string;
  readonly field: string;
  readonly maximumFontSize: number;
  readonly minimumFontSize: number;
  readonly value: string;
};

function semanticBlock(
  element: LayoutElement,
  fields: readonly SemanticField[],
): string {
  let content: string;
  try {
    content = fields
      .map((field) =>
        renderPalletLabelSemanticField(
          field.field,
          {
            x: element.xDots + field.bounds.x,
            y: element.yDots + field.bounds.y,
            width:
              field.bounds.fixedWidthDots ??
              element.widthDots - field.bounds.x - (field.bounds.rightInsetDots ?? 0),
            height: field.bounds.height,
          },
          field.caption,
          field.value,
          Math.min(element.maxFontSize, field.maximumFontSize),
          Math.min(element.minFontSize, field.minimumFontSize),
        ),
      )
      .join('');
  } catch {
    throw new Error(`Pallet layout block ${element.id} cannot fit the selected source`);
  }
  return (
    `<g data-layout-element="${element.id}" data-element-bounds="${element.xDots},` +
    `${element.yDots},${element.widthDots},${element.heightDots}">${content}</g>`
  );
}

@Injectable()
export class ConfigurablePalletLabelRenderer {
  renderSvg(
    label: PalletLabelSnapshot,
    layout: PalletLabelLayoutDefinition,
    options: { readonly qrToken: string; readonly watermark: boolean },
  ): string {
    this.assertQrToken(options);
    return layout.schemaVersion === 2
      ? this.renderEditableSvg(label, layout, options)
      : this.renderLegacySvg(label, layout, options);
  }

  private assertQrToken(options: { readonly qrToken: string; readonly watermark: boolean }): void {
    if (options.watermark) {
      if (options.qrToken !== PALLET_LABEL_LAYOUT_PREVIEW_TOKEN) {
        throw new Error('Invalid pallet-list draft QR token');
      }
      return;
    }
    if (
      options.qrToken === PALLET_LABEL_LAYOUT_PREVIEW_TOKEN ||
      !/^plt_[0-9a-f]{64}$/u.test(options.qrToken)
    ) {
      throw new Error('Invalid pallet-list QR token');
    }
  }

  private renderEditableSvg(
    label: PalletLabelSnapshot,
    layout: PalletLabelLayoutDefinitionV2,
    options: { readonly qrToken: string; readonly watermark: boolean },
  ): string {
    const element = editableElementsById(layout);
    if (!element.qr) throw new Error('Pallet layout V2 has no QR block');

    const wholeBlock = (
      target: PalletLabelLayoutElementV2 | undefined,
      field: string,
      caption: string,
      value: string,
    ): string =>
      target
        ? semanticBlock(target, [
            {
              field,
              bounds: { x: 0, y: 0, height: target.heightDots },
              caption,
              value,
              maximumFontSize: target.maxFontSize,
              minimumFontSize: target.minFontSize,
            },
          ])
        : '';

    return [
      '<svg id="pallet-label-layout-editor-preview" xmlns="http://www.w3.org/2000/svg" ',
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800" ',
      'viewBox="0 0 800 800">',
      `<title>${options.watermark ? 'Черновик макета' : 'Палетный лист'}</title>`,
      '<rect x="0" y="0" width="800" height="800" fill="#ffffff"/>',
      '<rect x="20" y="20" width="760" height="760" fill="none" stroke="#000000" ',
      'stroke-width="3"/>',
      wholeBlock(element.order, 'orderNumbers', 'Заказ', label.orderNumbers.join(', ')),
      wholeBlock(
        element.customer,
        'customerAliases',
        'Заказчик',
        label.customerAliases.join(', '),
      ),
      wholeBlock(element.formedAt, 'createdAt', '', formatPalletLabelCreatedAt(label.createdAt)),
      wholeBlock(
        element.rollCount,
        'rollCount',
        '',
        `Рулонов на палете: ${label.rollCount}`,
      ),
      wholeBlock(element.storage, 'storageConditions', '', label.storageConditions),
      options.watermark
        ? '<text x="400" y="790" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#666666" text-anchor="middle">ЧЕРНОВИК МАКЕТА · QR НЕРАБОЧИЙ</text>'
        : '',
      configurableQr(element.qr, options.qrToken, options.watermark),
      '</svg>',
    ].join('');
  }

  private renderLegacySvg(
    label: PalletLabelSnapshot,
    layout: PalletLabelLayoutDefinitionV1,
    options: { readonly qrToken: string; readonly watermark: boolean },
  ): string {
    const element = legacyElementsById(layout);
    const packaging = [label.packagingMaterial, label.packagingCount]
      .filter((value) => value !== null && value !== '')
      .join(' / ');
    const weights = `${label.netKg.toFixed(3)} / ${label.grossKg?.toFixed(3) ?? '—'} кг`;
    const dates = [
      label.productionDate ? `Произведено: ${label.productionDate}` : null,
      label.deliveryDate ? `Поставка: ${label.deliveryDate}` : null,
      `Срок: ${label.shelfLifeMonths} мес.`,
    ]
      .filter((value): value is string => value !== null)
      .join('  •  ');
    const rollCodes = label.rollCodes;
    if (!rollCodes || rollCodes.length !== label.rollCount) {
      throw new Error('Pallet layout preview source has no exact roll composition');
    }

    const headerLogoWidth = Math.min(98, Math.max(0, element.header.widthDots - 160));
    const headerLogoHeight = Math.min(27, Math.max(0, element.header.heightDots - 4));
    const headerLogoY =
      element.header.yDots +
      Math.min(9, Math.max(0, (element.header.heightDots - headerLogoHeight) / 2));
    const logo =
      headerLogoWidth >= 40 && headerLogoHeight >= 20
        ? `<image href="${PALLET_LABEL_ASSETS.logo.dataUri}" ` +
          `x="${element.header.xDots + element.header.widthDots - headerLogoWidth - 8}" ` +
          `y="${headerLogoY}" ` +
          `width="${headerLogoWidth}" height="${headerLogoHeight}" ` +
          'preserveAspectRatio="xMidYMid meet"/>'
        : '';

    const identityOrderHeight = Math.max(1, Math.floor((element.identity.heightDots * 32) / 74));
    const identityCustomerY = Math.max(
      identityOrderHeight,
      Math.floor((element.identity.heightDots * 34) / 74),
    );
    const productNamesHeight = Math.max(1, Math.floor((element.product.heightDots * 84) / 140));
    const productArticleY = Math.max(
      productNamesHeight,
      Math.floor((element.product.heightDots * 88) / 140),
    );
    const productArticleHeight = Math.max(1, Math.floor((element.product.heightDots * 30) / 140));
    const productCreatedAtY = Math.max(
      productArticleY + 1,
      Math.floor((element.product.heightDots * 122) / 140),
    );

    return [
      '<svg id="pallet-label-layout-editor-preview" xmlns="http://www.w3.org/2000/svg" ',
      'xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800" ',
      'viewBox="0 0 800 800">',
      `<title>${options.watermark ? 'Черновик макета' : 'Палетный лист'} ${escapeXml(label.palletId)}</title>`,
      '<rect x="0" y="0" width="800" height="800" fill="#ffffff"/>',
      '<rect x="20" y="20" width="760" height="760" fill="none" stroke="#000000" ',
      'stroke-width="3"/>',
      semanticBlock(element.header, [
        {
          field: 'palletId',
          bounds: {
            x: 0,
            y: 0,
            rightInsetDots: 128,
            height: element.header.heightDots,
          },
          caption: 'ПАЛЕТНЫЙ ЛИСТ',
          value: label.palletId,
          maximumFontSize: 34,
          minimumFontSize: 22,
        },
      ]),
      logo,
      semanticBlock(element.identity, [
        {
          field: 'orderNumbers',
          bounds: { x: 0, y: 0, height: identityOrderHeight },
          caption: 'Заказ',
          value: label.orderNumbers.join(', '),
          maximumFontSize: 22,
          minimumFontSize: 13,
        },
        {
          field: 'customerAliases',
          bounds: {
            x: 0,
            y: identityCustomerY,
            height: Math.max(1, element.identity.heightDots - identityCustomerY),
          },
          caption: 'Заказчик',
          value: label.customerAliases.join(', '),
          maximumFontSize: 20,
          minimumFontSize: 12,
        },
      ]),
      semanticBlock(element.product, [
        {
          field: 'productNames',
          bounds: { x: 0, y: 0, height: productNamesHeight },
          caption: 'Продукт',
          value: label.productNames.join(' • '),
          maximumFontSize: 23,
          minimumFontSize: 12,
        },
        {
          field: 'article',
          bounds: {
            x: 0,
            y: productArticleY,
            height: productArticleHeight,
          },
          caption: 'Артикул',
          value: display(label.article),
          maximumFontSize: 17,
          minimumFontSize: 10,
        },
        {
          field: 'createdAt',
          bounds: {
            x: 0,
            y: productCreatedAtY,
            height: Math.max(1, element.product.heightDots - productCreatedAtY),
          },
          caption: '',
          value: formatPalletLabelCreatedAt(label.createdAt),
          maximumFontSize: 11,
          minimumFontSize: 9,
        },
      ]),
      rollCodesBlock(element.rollCodes, rollCodes),
      semanticBlock(element.summary, [
        {
          field: 'materialMark',
          bounds: { x: 0, y: 0, height: 26 },
          caption: 'Материал',
          value: label.materialMark,
          maximumFontSize: 15,
          minimumFontSize: 10,
        },
        {
          field: 'rollCount',
          bounds: { x: 0, y: 30, fixedWidthDots: 90, height: 24 },
          caption: 'Рулонов',
          value: String(label.rollCount),
          maximumFontSize: 13,
          minimumFontSize: 9,
        },
        {
          field: 'netKg',
          bounds: { x: 94, y: 30, height: 24 },
          caption: 'Нетто / брутто',
          value: weights,
          maximumFontSize: 12,
          minimumFontSize: 9,
        },
        {
          field: 'productionDate',
          bounds: { x: 0, y: 58, height: 56 },
          caption: '',
          value: dates,
          maximumFontSize: 12,
          minimumFontSize: 9,
        },
      ]),
      semanticBlock(element.packaging, [
        {
          field: 'packagingMaterial',
          bounds: { x: 0, y: 0, height: element.packaging.heightDots },
          caption: 'Упаковка',
          value: packaging,
          maximumFontSize: 15,
          minimumFontSize: 11,
        },
      ]),
      semanticBlock(element.storage, [
        {
          field: 'storageConditions',
          bounds: { x: 0, y: 0, height: element.storage.heightDots },
          caption: '',
          value: label.storageConditions,
          maximumFontSize: 14,
          minimumFontSize: 11,
        },
      ]),
      options.watermark
        ? '<text x="400" y="790" font-family="DejaVu Sans" font-size="14" font-weight="bold" fill="#666666" text-anchor="middle">ЧЕРНОВИК МАКЕТА · QR НЕРАБОЧИЙ</text>'
        : '',
      configurableQr(element.qr, options.qrToken, options.watermark),
      '</svg>',
    ].join('');
  }

  render(
    label: PalletLabelSnapshot,
    layout: PalletLabelLayoutDefinition,
    options: { readonly qrToken: string; readonly watermark: boolean },
  ): Buffer {
    const rendered = new Resvg(this.renderSvg(label, layout, options), {
      background: '#ffffff',
      fitTo: { mode: 'width', value: 800 },
      font: {
        fontFiles,
        loadSystemFonts: false,
        defaultFontFamily: 'DejaVu Sans',
      },
      shapeRendering: 2,
      textRendering: 2,
    }).render();
    if (rendered.width !== 800 || rendered.height !== 800) {
      throw new Error(
        `Unexpected configurable pallet-label raster: ${rendered.width}x${rendered.height}`,
      );
    }
    return rendered.asPng();
  }
}
