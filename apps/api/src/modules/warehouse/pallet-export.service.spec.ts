import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, StreamableFile } from '@nestjs/common';
import { PALLET_LABEL_PROFILE, type PalletListPayload } from '@plenka/contracts';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { Actor } from '../../common/auth/actor';
import { PalletExportService } from './pallet-export.service';
import { PalletLabelRenderer } from './pallet-label.renderer';
import { WarehouseController } from './warehouse.controller';
import { WarehouseIntakeService } from './warehouse-intake.service';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from '../admin/pallet-label-layout-editor.validator';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';

const payload: PalletListPayload = {
  templateVersion: 'pallet-100x150-v1',
  palletId: 'ПР-1307-01',
  operationCode: 'ОП-1307',
  orderIds: ['order-42'],
  orderNumbers: ['ЗАК-42'],
  customerAliases: ['УралПак'],
  products: ['Пленка ПВД полурукав 2000мм 150мкм'],
  orderNumber: 'ЗАК-42',
  customerAlias: 'УралПак',
  scannedCount: 2,
  expectedCount: 2,
  printReady: true,
  rows: [
    {
      seq: 1,
      rollCode: 'ПР-1307-01',
      orderId: 'order-42',
      orderNumber: 'ЗАК-42',
      customerAlias: 'УралПак',
      productName: 'Пленка ПВД полурукав 2000мм 150мкм',
      planKg: 125.5,
      netKg: 124.8,
      grossKg: null,
      status: 'accepted',
    },
  ],
  totals: { rollCount: 1, plannedKg: 125.5, netKg: 124.8, grossKg: null },
  receivedBy: 'Принял склад',
  collectedBy: 'Иван Иванов',
  date: '2026-07-13T09:30:00.000Z',
  label: {
    templateVersion: 'pallet-100x150-v1',
    palletId: 'ПР-1307-01',
    materialMark: 'ПВД',
    productNames: ['Пленка ПВД полурукав 2000мм 150мкм'],
    article: null,
    rollCount: 1,
    packagingMaterial: null,
    packagingCount: null,
    netKg: 124.8,
    grossKg: null,
    productionDate: '07.2026',
    shelfLifeMonths: 12,
    deliveryDate: null,
    storageConditions: 'Хранить в сухом помещении.',
    orderNumbers: ['ЗАК-42'],
    customerAliases: ['УралПак'],
    createdAt: '2026-07-13T09:30:00.000Z',
  },
};

const document = {
  id: 'pallet-list-1',
  palletId: payload.palletId,
  payload,
  layoutPublicationId: null,
};
const PALLET_TOKEN = `plt_${'a'.repeat(64)}`;

describe('PalletExportService', () => {
  let renderer: PalletLabelRenderer;
  let renderPalletLabel: jest.SpyInstance;
  let palletTokens: { requireForDocument: jest.Mock };
  let service: PalletExportService;

  beforeEach(() => {
    renderer = new PalletLabelRenderer();
    renderPalletLabel = jest.spyOn(renderer, 'renderPalletLabel');
    palletTokens = {
      requireForDocument: jest
        .fn()
        .mockResolvedValue({ documentId: document.id, token: PALLET_TOKEN }),
    };
    service = new PalletExportService(renderer, palletTokens as never);
  });

  it('exports one 100x150 mm PDF page from one master PNG', async () => {
    const result = await service.export(document, 'pdf');
    const pdf = await PDFDocument.load(result.buffer);

    expect(renderPalletLabel).toHaveBeenCalledTimes(1);
    expect(renderPalletLabel).toHaveBeenCalledWith(
      payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(palletTokens.requireForDocument).toHaveBeenCalledWith(document.id);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo((100 / 25.4) * 72, 1);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo((150 / 25.4) * 72, 1);
    expect(result.contentType).toBe('application/pdf');
  });

  it('exports one 100x150 mm XLSX worksheet with one master image and a 1x1 print area', async () => {
    const result = await service.export(document, 'xlsx');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const archive = await JSZip.loadAsync(result.buffer);
    const worksheetXml = await archive.file('xl/worksheets/sheet1.xml')!.async('text');

    const [worksheet] = workbook.worksheets;
    expect(renderPalletLabel).toHaveBeenCalledTimes(1);
    expect(workbook.worksheets).toHaveLength(1);
    expect(worksheet.getImages()).toHaveLength(1);
    expect(worksheet.views?.[0]?.showGridLines).toBe(false);
    expect(worksheet.pageSetup).toEqual(
      expect.objectContaining({
        paperSize: 70,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        printArea: 'A1:A2',
        margins: {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          header: 0,
          footer: 0,
        },
      }),
    );
    expect(worksheet.getColumn(1).width).toBe(53);
    expect(worksheet.getRow(1).height).toBe(212.625);
    expect(worksheet.getRow(2).height).toBe(212.625);
    expect(worksheetXml).toMatch(/<pageSetup\b[^>]*paperWidth="100mm"/);
    expect(worksheetXml).toMatch(/<pageSetup\b[^>]*paperHeight="150mm"/);
  });

  it('exports one-image 100x150 mm DOCX with zero page margins', async () => {
    const result = await service.export(document, 'docx');
    const archive = await JSZip.loadAsync(result.buffer);
    const mediaFiles = Object.keys(archive.files).filter((path) =>
      /^word\/media\/[^/]+\.png$/i.test(path),
    );
    const documentXml = await archive.file('word/document.xml')!.async('text');

    expect(renderPalletLabel).toHaveBeenCalledTimes(1);
    expect(mediaFiles).toHaveLength(1);
    expect(documentXml.match(/<a:blip\b/g)).toHaveLength(1);
    expect(documentXml).toMatch(/<w:pgSz\b[^>]*w:w="5669"[^>]*w:h="8503"/);
    expect(documentXml).toMatch(
      /<w:pgMar\b[^>]*w:top="0"[^>]*w:right="0"[^>]*w:bottom="0"[^>]*w:left="0"/,
    );
    expect(result.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('returns the same master PNG for preview without another layout path', async () => {
    const result = await service.preview(document);
    const expected = renderPalletLabel.mock.results[0]?.value.png as Buffer;

    expect(renderPalletLabel).toHaveBeenCalledTimes(1);
    expect(renderPalletLabel).toHaveBeenCalledWith(
      payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(result).toEqual({ buffer: expected, contentType: 'image/png' });
  });

  it('renders the compact profile owned by an immutable snapshot, not the current server default', async () => {
    const compactDocument = {
      ...document,
      payload: {
        ...payload,
        templateVersion: 'pallet-100x150-compact-v2' as const,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x150-compact-v2' as const,
          rollCodes: undefined,
        },
      },
    };

    await service.preview(compactDocument);

    expect(renderPalletLabel).toHaveBeenCalledWith(
      compactDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x150-compact-v2',
    );
  });

  it('returns an exact 800x800 square-v4 PNG preview with its immutable composition', async () => {
    const squareDocument = {
      ...document,
      payload: {
        ...payload,
        templateVersion: 'pallet-100x100-square-v4' as const,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x100-square-v4' as const,
          rollCodes: ['ПР-1307-01'],
        },
      },
    };

    const result = await service.preview(squareDocument);

    expect(renderPalletLabel).toHaveBeenCalledWith(
      squareDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x100-square-v4',
    );
    expect(result.buffer.readUInt32BE(16)).toBe(800);
    expect(result.buffer.readUInt32BE(20)).toBe(800);
  });

  it('returns the browser-only 800x800 safe-v5 PNG without wrapping it for a device', async () => {
    const safeDocument = {
      ...document,
      payload: {
        ...payload,
        templateVersion: 'pallet-100x100-safe-v5' as const,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x100-safe-v5' as const,
          rollCodes: ['ПР-1307-01'],
        },
      },
    };

    const result = await service.preview(safeDocument);

    expect(renderPalletLabel).toHaveBeenCalledWith(
      safeDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x100-safe-v5',
    );
    expect(result.buffer.readUInt32BE(16)).toBe(800);
    expect(result.buffer.readUInt32BE(20)).toBe(800);
  });

  it('returns the browser-only 800x800 extended-v6 PNG through the preview path only', async () => {
    const extendedDocument = {
      ...document,
      payload: {
        ...payload,
        templateVersion: 'pallet-100x100-extended-v6' as const,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x100-extended-v6' as const,
          rollCodes: ['ПР-1307-01'],
        },
      },
    };

    const result = await service.preview(extendedDocument);

    expect(renderPalletLabel).toHaveBeenCalledWith(
      extendedDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x100-extended-v6',
    );
    expect(result.buffer.readUInt32BE(16)).toBe(800);
    expect(result.buffer.readUInt32BE(20)).toBe(800);
  });

  it('re-renders a safe pre-policy configurable-v7 publication pinned in immutable history', async () => {
    const layout = rightShiftedCompactPalletLabelLayout();
    const publication = {
      id: 'publication-1',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    };
    const configurableDocument = {
      ...document,
      layoutPublicationId: publication.id,
      payload: {
        ...payload,
        templateVersion: 'pallet-100x100-configurable-v7' as const,
        layoutPublication: publication,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x100-configurable-v7' as const,
          rollCodes: ['ПР-1307-01'],
        },
      },
    };

    const result = await service.preview(configurableDocument);

    expect(renderPalletLabel).toHaveBeenCalledWith(
      configurableDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x100-configurable-v7',
      publication,
    );
    expect(result.buffer.readUInt32BE(16)).toBe(800);
    expect(result.buffer.readUInt32BE(20)).toBe(800);
  });

  it('rejects configurable-v7 preview when relational and payload provenance differ', async () => {
    const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    const publication = {
      id: 'publication-payload',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout,
    };
    const mismatchedDocument = {
      ...document,
      layoutPublicationId: 'publication-relational',
      payload: {
        ...payload,
        templateVersion: 'pallet-100x100-configurable-v7' as const,
        layoutPublication: publication,
        label: {
          ...payload.label,
          templateVersion: 'pallet-100x100-configurable-v7' as const,
          rollCodes: ['ПР-1307-01'],
        },
      },
    };

    await expect(service.preview(mismatchedDocument)).rejects.toMatchObject({
      response: { code: 'PALLET_LABEL_PUBLICATION_PROVENANCE_INVALID' },
    });
    expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
    expect(renderPalletLabel).not.toHaveBeenCalled();
  });

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'rejects safe-v5 %s wrapping before token resolution or rendering',
    async (format) => {
      const safeDocument = {
        ...document,
        payload: {
          ...payload,
          templateVersion: 'pallet-100x100-safe-v5' as const,
          label: {
            ...payload.label,
            templateVersion: 'pallet-100x100-safe-v5' as const,
            rollCodes: ['ПР-1307-01'],
          },
        },
      };

      await expect(service.export(safeDocument, format)).rejects.toMatchObject({
        status: 409,
        response: { code: 'PALLET_LABEL_EXPORT_UNSUPPORTED' },
      });
      expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
      expect(renderPalletLabel).not.toHaveBeenCalled();
    },
  );

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'rejects square-v4 %s wrapping before token resolution or rendering',
    async (format) => {
      const squareDocument = {
        ...document,
        payload: {
          ...payload,
          templateVersion: 'pallet-100x100-square-v4' as const,
          label: {
            ...payload.label,
            templateVersion: 'pallet-100x100-square-v4' as const,
            rollCodes: ['ПР-1307-01'],
          },
        },
      };

      await expect(service.export(squareDocument, format)).rejects.toMatchObject({
        status: 409,
        response: { code: 'PALLET_LABEL_EXPORT_UNSUPPORTED' },
      });
      expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
      expect(renderPalletLabel).not.toHaveBeenCalled();
    },
  );

  it.each(['pdf', 'docx', 'xlsx'] as const)(
    'rejects extended-v6 %s wrapping before token resolution or rendering',
    async (format) => {
      const extendedDocument = {
        ...document,
        payload: {
          ...payload,
          templateVersion: 'pallet-100x100-extended-v6' as const,
          label: {
            ...payload.label,
            templateVersion: 'pallet-100x100-extended-v6' as const,
            rollCodes: ['ПР-1307-01'],
          },
        },
      };

      await expect(service.export(extendedDocument, format)).rejects.toMatchObject({
        status: 409,
        response: { code: 'PALLET_LABEL_EXPORT_UNSUPPORTED' },
      });
      expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
      expect(renderPalletLabel).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing payload profile', { ...payload, templateVersion: undefined }],
    [
      'missing label profile',
      { ...payload, label: { ...payload.label, templateVersion: undefined } },
    ],
    [
      'mismatched profiles',
      {
        ...payload,
        label: { ...payload.label, templateVersion: 'pallet-100x150-compact-v2' },
      },
    ],
    [
      'unknown profiles',
      {
        ...payload,
        templateVersion: 'pallet-unknown',
        label: { ...payload.label, templateVersion: 'pallet-unknown' },
      },
    ],
  ])('rejects a %s before resolving a token or rendering', async (_case, corruptPayload) => {
    const corruptDocument = { ...document, payload: corruptPayload } as unknown as typeof document;

    await expect(service.preview(corruptDocument)).rejects.toBeInstanceOf(ConflictException);

    expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
    expect(renderPalletLabel).not.toHaveBeenCalled();
  });

  it('renders a legacy immutable snapshot with a separate stable token and never mutates JSON', async () => {
    const originalPayload = structuredClone(payload);

    await service.preview(document);
    await service.export(document, 'pdf');

    expect(palletTokens.requireForDocument).toHaveBeenNthCalledWith(1, document.id);
    expect(palletTokens.requireForDocument).toHaveBeenNthCalledWith(2, document.id);
    expect(renderPalletLabel).toHaveBeenNthCalledWith(
      1,
      payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(renderPalletLabel).toHaveBeenNthCalledWith(
      2,
      payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(payload).toEqual(originalPayload);
    expect(JSON.stringify(payload)).not.toContain(PALLET_TOKEN);
  });

  it('rejects a document without an immutable snapshot instead of rebuilding mutable state', async () => {
    await expect(
      service.export(
        { id: 'legacy', palletId: 'legacy', payload: null, layoutPublicationId: null },
        'pdf',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.preview({
        id: 'legacy',
        palletId: 'legacy',
        payload: null,
        layoutPublicationId: null,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
    expect(renderPalletLabel).not.toHaveBeenCalled();
  });

  it('fails closed when the document-bound QR token cannot be loaded', async () => {
    palletTokens.requireForDocument.mockRejectedValue(
      new ConflictException({
        code: 'PALLET_SCAN_TOKEN_UNAVAILABLE',
        message: 'Не удалось подготовить физическую метку палеты.',
      }),
    );

    await expect(service.preview(document)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_SCAN_TOKEN_UNAVAILABLE' }),
    });
    expect(renderPalletLabel).not.toHaveBeenCalled();
  });
});

describe('pallet list export and preview orchestration', () => {
  const actor: Actor = {
    userId: 'warehouse-user',
    role: 'warehouse',
    capabilities: [],
  };

  it('loads the document, exports it and records the audit event', async () => {
    const prisma = {
      palletListDocument: { findUnique: jest.fn().mockResolvedValue(document) },
    };
    const audit = { record: jest.fn() };
    const exporter = {
      export: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF'),
        contentType: 'application/pdf',
        filename: 'pallet-pr-1307-01.pdf',
      }),
    };
    const service = new WarehouseIntakeService(
      prisma as never,
      audit as never,
      exporter as never,
      {} as never,
      { palletLabelProfile: 'pallet-100x150-v1' },
    );

    const result = await service.exportPalletList(actor, document.id, 'pdf');

    expect(exporter.export).toHaveBeenCalledWith(document, 'pdf');
    expect(audit.record).toHaveBeenCalledWith({
      type: 'audit:pallet_list_exported',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: document.id,
      detail: { format: 'pdf' },
    });
    expect(result.filename).toBe('pallet-pr-1307-01.pdf');
  });

  it('previews the persisted snapshot without recording a mutation', async () => {
    const prisma = {
      palletListDocument: { findUnique: jest.fn().mockResolvedValue(document) },
    };
    const audit = { record: jest.fn() };
    const exporter = {
      preview: jest.fn().mockReturnValue({ buffer: Buffer.from('PNG'), contentType: 'image/png' }),
    };
    const service = new WarehouseIntakeService(
      prisma as never,
      audit as never,
      exporter as never,
      {} as never,
      { palletLabelProfile: 'pallet-100x150-v1' },
    );

    const result = await service.previewPalletList(actor, document.id);

    expect(exporter.preview).toHaveBeenCalledWith(document);
    expect(result.contentType).toBe('image/png');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['preview', 'export'] as const)(
    'fails closed before %s of an annulled immutable document',
    async (operation) => {
      const voidedDocument = {
        ...document,
        voidedAt: new Date('2026-08-09T07:00:00.000Z'),
      };
      const prisma = {
        palletListDocument: { findUnique: jest.fn().mockResolvedValue(voidedDocument) },
      };
      const audit = { record: jest.fn() };
      const exporter = {
        export: jest.fn(),
        preview: jest.fn(),
      };
      const service = new WarehouseIntakeService(
        prisma as never,
        audit as never,
        exporter as never,
        {} as never,
        { palletLabelProfile: 'pallet-100x150-v1' },
      );

      const request =
        operation === 'preview'
          ? service.previewPalletList(actor, document.id)
          : service.exportPalletList(actor, document.id, 'pdf');

      await expect(request).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PALLET_LIST_DOCUMENT_VOIDED' }),
      });
      expect(exporter.preview).not.toHaveBeenCalled();
      expect(exporter.export).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('rejects an unsupported format in the controller', async () => {
    const controller = new WarehouseController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.exportPalletList(actor, document.id, 'csv', {} as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forces private preview revalidation and returns a streamable file', async () => {
    const preview = { buffer: Buffer.from('PNG'), contentType: 'image/png' as const };
    const intake = { previewPalletList: jest.fn().mockResolvedValue(preview) };
    const response = { setHeader: jest.fn() };
    const controller = new WarehouseController(
      {} as never,
      intake as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await controller.previewPalletList(actor, document.id, response as never);

    expect(intake.previewPalletList).toHaveBeenCalledWith(actor, document.id);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-cache, max-age=0, must-revalidate',
    );
    expect(result).toBeInstanceOf(StreamableFile);
  });
});
