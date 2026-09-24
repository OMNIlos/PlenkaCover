import { ConflictException, Injectable } from '@nestjs/common';
import {
  AlignmentType,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
} from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  type PalletLabelLayoutPublication,
} from '@plenka/contracts';
import { parsePalletLabelLayoutPublication } from '../../common/pallet-label-layout/pallet-label-layout.validator';
import { PalletTokenService } from '../../common/pallet-token/pallet-token.service';
import {
  immutablePalletLabelProfile,
  isBrowserOnlyPalletLabelProfile,
} from './pallet-label-snapshot';
import type { PalletListPayload } from './pallet-list.builder';
import { PalletLabelRenderer } from './pallet-label.renderer';

export type PalletExportFormat = 'docx' | 'pdf' | 'xlsx';

export type PalletExportDocument = {
  id: string;
  palletId: string;
  payload: PalletListPayload | null;
  layoutPublicationId: string | null;
};

export type PalletExportResult = {
  buffer: Buffer;
  contentType: string;
  filename: string;
};

const CONTENT_TYPES: Record<PalletExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MM_TO_PT = 72 / 25.4;
const PDF_WIDTH = 100 * MM_TO_PT;
const PDF_HEIGHT = 150 * MM_TO_PT;
const IMAGE_WIDTH_PX = 378;
const IMAGE_HEIGHT_PX = 567;

function transliterate(value: string): string {
  const cyrillic = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
  const latin = [
    'a',
    'b',
    'v',
    'g',
    'd',
    'e',
    'e',
    'zh',
    'z',
    'i',
    'y',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'r',
    's',
    't',
    'u',
    'f',
    'h',
    'c',
    'ch',
    'sh',
    'sch',
    '',
    'y',
    '',
    'e',
    'yu',
    'ya',
  ];
  return [...value]
    .map((character) => {
      const lower = character.toLowerCase();
      const index = cyrillic.indexOf(lower);
      if (index < 0) return character;
      const replacement = latin[index];
      return character === lower ? replacement : replacement.toUpperCase();
    })
    .join('');
}

function safeFilename(palletId: string, format: PalletExportFormat): string {
  const safeId = transliterate(palletId)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `pallet-${safeId || 'document'}.${format}`;
}

function labelOf(document: PalletExportDocument) {
  const label = document.payload?.label;
  const templateVersion = immutablePalletLabelProfile(document.payload);
  if (!label || !templateVersion) {
    throw new ConflictException(
      `Pallet list ${document.id} has no immutable pallet label snapshot`,
    );
  }
  return { label, templateVersion };
}

function invalidPublicationProvenance(documentId: string): never {
  throw new ConflictException({
    code: 'PALLET_LABEL_PUBLICATION_PROVENANCE_INVALID',
    message: `Pallet list ${documentId} has invalid layout-publication provenance.`,
  });
}

function publicationOf(
  document: PalletExportDocument,
  templateVersion: PalletListPayload['templateVersion'],
): PalletLabelLayoutPublication | undefined {
  if (templateVersion !== PALLET_LABEL_CONFIGURABLE_PROFILE) {
    if (
      document.layoutPublicationId !== null ||
      document.payload?.layoutPublication !== undefined
    ) {
      invalidPublicationProvenance(document.id);
    }
    return undefined;
  }

  let publication: PalletLabelLayoutPublication;
  try {
    publication = parsePalletLabelLayoutPublication(document.payload?.layoutPublication);
  } catch {
    invalidPublicationProvenance(document.id);
  }
  if (!document.layoutPublicationId || publication.id !== document.layoutPublicationId) {
    invalidPublicationProvenance(document.id);
  }
  return publication;
}

/** Wraps the one approved master PNG in download containers; no parallel layout exists here. */
@Injectable()
export class PalletExportService {
  constructor(
    private readonly renderer: PalletLabelRenderer,
    private readonly palletTokens: PalletTokenService,
  ) {}

  async preview(
    document: PalletExportDocument,
  ): Promise<{ buffer: Buffer; contentType: 'image/png' }> {
    const { label, templateVersion } = labelOf(document);
    const publication = publicationOf(document, templateVersion);
    const { token } = await this.palletTokens.requireForDocument(document.id);
    const { png } = publication
      ? this.renderer.renderPalletLabel(label, token, templateVersion, publication)
      : this.renderer.renderPalletLabel(label, token, templateVersion);
    return { buffer: png, contentType: 'image/png' };
  }

  async export(
    document: PalletExportDocument,
    format: PalletExportFormat,
  ): Promise<PalletExportResult> {
    const { label, templateVersion } = labelOf(document);
    const publication = publicationOf(document, templateVersion);
    if (isBrowserOnlyPalletLabelProfile(templateVersion)) {
      throw new ConflictException({
        code: 'PALLET_LABEL_EXPORT_UNSUPPORTED',
        message: 'Квадратный палетный лист доступен в PNG-предпросмотре и печати из браузера.',
      });
    }
    const { token } = await this.palletTokens.requireForDocument(document.id);
    const { png } = publication
      ? this.renderer.renderPalletLabel(label, token, templateVersion, publication)
      : this.renderer.renderPalletLabel(label, token, templateVersion);
    const buffer = await this.wrap(png, format);
    return {
      buffer,
      contentType: CONTENT_TYPES[format],
      filename: safeFilename(document.palletId, format),
    };
  }

  private wrap(png: Buffer, format: PalletExportFormat): Promise<Buffer> {
    if (format === 'docx') return this.wrapDocx(png);
    if (format === 'pdf') return this.wrapPdf(png);
    return this.wrapXlsx(png);
  }

  private wrapDocx(png: Buffer): Promise<Buffer> {
    const document = new Document({
      sections: [
        {
          properties: {
            page: {
              size: {
                width: convertMillimetersToTwip(100),
                height: convertMillimetersToTwip(150),
                orientation: PageOrientation.PORTRAIT,
              },
              margin: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 },
            },
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 0, after: 0 },
              children: [
                new ImageRun({
                  type: 'png',
                  data: png,
                  transformation: { width: IMAGE_WIDTH_PX, height: IMAGE_HEIGHT_PX },
                  altText: {
                    title: 'Палетный лист',
                    description: 'Одна этикетка 100×150 мм',
                    name: 'pallet-label',
                  },
                }),
              ],
            }),
          ],
        },
      ],
    });
    return Packer.toBuffer(document);
  }

  private async wrapPdf(png: Buffer): Promise<Buffer> {
    const document = await PDFDocument.create();
    const image = await document.embedPng(png);
    const page = document.addPage([PDF_WIDTH, PDF_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: PDF_WIDTH, height: PDF_HEIGHT });
    return Buffer.from(await document.save());
  }

  private async wrapXlsx(png: Buffer): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Палетный лист', {
      views: [{ showGridLines: false }],
      pageSetup: {
        paperSize: 70 as ExcelJS.PaperSize,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        horizontalCentered: true,
        verticalCentered: true,
        margins: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          header: 0,
          footer: 0,
        },
      },
    });
    worksheet.pageSetup.printArea = 'A1:A2';
    worksheet.getColumn(1).width = 53;
    worksheet.getRow(1).height = 212.625;
    worksheet.getRow(2).height = 212.625;
    const imageId = workbook.addImage({ base64: png.toString('base64'), extension: 'png' });
    worksheet.addImage(imageId, {
      tl: { col: 0, row: 0 },
      ext: { width: IMAGE_WIDTH_PX, height: IMAGE_HEIGHT_PX },
    });
    const archive = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
    const worksheetPath = 'xl/worksheets/sheet1.xml';
    const worksheetFile = archive.file(worksheetPath);
    if (!worksheetFile) throw new Error('Generated pallet workbook has no first worksheet');

    const worksheetXml = await worksheetFile.async('text');
    if (!worksheetXml.includes('<pageSetup ')) {
      throw new Error('Generated pallet workbook has no page setup');
    }
    archive.file(
      worksheetPath,
      worksheetXml.replace('<pageSetup ', '<pageSetup paperWidth="100mm" paperHeight="150mm" '),
    );
    return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}
