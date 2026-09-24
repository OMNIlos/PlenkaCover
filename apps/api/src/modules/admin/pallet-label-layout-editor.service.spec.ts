import type { PalletLabelLayout, PalletLabelSnapshot } from '@plenka/contracts';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from './pallet-label-layout-editor.validator';
import { PalletLabelLayoutEditorRenderer } from './pallet-label-layout-editor.renderer';
import { PalletLabelLayoutEditorService } from './pallet-label-layout-editor.service';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';

const LABEL: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x100-extended-v6',
  palletId: 'PAL-A-2-06',
  materialMark: 'PE-LD',
  productNames: ['Пленка полиэтиленовая рукав 29мкм'],
  article: null,
  rollCount: 1,
  rollCodes: ['A-2-roll-1'],
  packagingMaterial: null,
  packagingCount: null,
  netKg: 7.95,
  grossKg: 8.6,
  productionDate: '08.2026',
  shelfLifeMonths: 12,
  deliveryDate: null,
  storageConditions: 'Хранить в сухом помещении.',
  orderNumbers: ['A-2'],
  customerAliases: ['СТН-М АО'],
  createdAt: '2026-08-09T12:00:00.000Z',
};

const DOCUMENT = {
  id: 'document-1',
  palletId: 'PAL-A-2-06',
  createdAt: new Date('2026-08-09T12:00:00.000Z'),
  voidedAt: null,
  rollIds: ['A-2-roll-1'],
  payload: {
    templateVersion: 'pallet-100x100-extended-v6',
    label: LABEL,
  },
};

const CONTROL_SOURCE_ID = 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206';

function prismaMock() {
  return {
    palletListDocument: {
      findMany: jest.fn().mockResolvedValue([DOCUMENT]),
      findUnique: jest.fn().mockResolvedValue(DOCUMENT),
    },
  };
}

describe('PalletLabelLayoutEditorService', () => {
  it('keeps a tagged synthetic control source available when every document was purged', async () => {
    const prisma = prismaMock();
    prisma.palletListDocument.findMany.mockResolvedValue([]);
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
    );

    await expect(service.bootstrap()).resolves.toMatchObject({
      sources: [
        {
          documentId: CONTROL_SOURCE_ID,
          kind: 'control',
          label: 'Контрольный синтетический источник',
          rollCount: 24,
        },
      ],
    });

    const preview = await service.preview(CONTROL_SOURCE_ID, PUBLISHED_PALLET_LABEL_LAYOUT);
    expect(preview.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(prisma.palletListDocument.findUnique).not.toHaveBeenCalled();
  });

  it('returns the exact bootstrap contract and only safe source fields', async () => {
    const prisma = prismaMock();
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
    );

    await expect(service.bootstrap()).resolves.toEqual({
      schemaVersion: 2,
      profile: 'pallet-100x100-configurable-v7',
      canvas: {
        widthDots: 800,
        heightDots: 800,
        dotsPerMm: 8,
        safeInsetDots: 20,
        provenCutYDots: 570,
      },
      editorLayout: PUBLISHED_PALLET_LABEL_LAYOUT,
      activePublication: null,
      sources: [
        {
          documentId: CONTROL_SOURCE_ID,
          kind: 'control',
          label: 'Контрольный синтетический источник',
          palletId: 'CONTROL-VALIDATION-01',
          createdAt: '2026-01-01T00:00:00.000Z',
          rollCount: 24,
        },
        {
          documentId: 'document-1',
          kind: 'document',
          label: 'Палетный лист PAL-A-2-06',
          palletId: 'PAL-A-2-06',
          createdAt: '2026-08-09T12:00:00.000Z',
          rollCount: 1,
        },
      ],
    });
    expect(prisma.palletListDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        select: {
          id: true,
          palletId: true,
          createdAt: true,
          rollIds: true,
          payload: true,
        },
      }),
    );
  });

  it('uses an active V2 publication as the editor layout without writing another version', async () => {
    const prisma = prismaMock();
    const activeLayout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    activeLayout.elements.find((element) => element.id === 'order')!.xDots = 40;
    const activePublication = {
      id: 'publication-2',
      version: 2,
      contentHash: 'a'.repeat(64),
      activatedAt: '2026-08-11T19:30:00.000Z',
      layout: activeLayout,
    };
    const publications = { active: jest.fn().mockResolvedValue(activePublication) };
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
      publications as never,
    );

    await expect(service.bootstrap()).resolves.toMatchObject({
      schemaVersion: 2,
      editorLayout: activeLayout,
      activePublication,
    });
    expect(publications.active).toHaveBeenCalledTimes(1);
  });

  it('keeps an active V1 publication unchanged and opens a clean V2 editor draft', async () => {
    const prisma = prismaMock();
    const legacyLayout = rightShiftedCompactPalletLabelLayout();
    const activePublication = {
      id: 'legacy-publication-1',
      version: 1,
      contentHash: 'b'.repeat(64),
      activatedAt: '2026-08-11T18:30:00.000Z',
      layout: legacyLayout,
    };
    const publications = {
      active: jest.fn().mockResolvedValue(activePublication),
      publish: jest.fn(),
    };
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
      publications as never,
    );

    await expect(service.bootstrap()).resolves.toMatchObject({
      schemaVersion: 2,
      editorLayout: PUBLISHED_PALLET_LABEL_LAYOUT,
      activePublication,
    });
    expect(publications.active).toHaveBeenCalledTimes(1);
    expect(publications.publish).not.toHaveBeenCalled();
  });

  it('renders an exact 800x800 PNG without ever selecting a stored pallet token', async () => {
    const prisma = prismaMock();
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
    );

    const result = await service.preview('document-1', PUBLISHED_PALLET_LABEL_LAYOUT);

    expect(result.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(result.png.readUInt32BE(16)).toBe(800);
    expect(result.png.readUInt32BE(20)).toBe(800);
    expect(result.diagnostics.belowProvenCut).toEqual([]);
    expect(prisma.palletListDocument.findUnique).toHaveBeenCalledWith({
      where: { id: 'document-1' },
      select: {
        id: true,
        palletId: true,
        voidedAt: true,
        payload: true,
      },
    });
    expect(prisma).not.toHaveProperty('palletScanToken');
  });

  it('fails closed for an unknown, voided or non-v6 source document', async () => {
    const prisma = prismaMock();
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
    );

    prisma.palletListDocument.findUnique.mockResolvedValueOnce(null);
    await expect(service.preview('missing', PUBLISHED_PALLET_LABEL_LAYOUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    prisma.palletListDocument.findUnique.mockResolvedValueOnce({
      ...DOCUMENT,
      voidedAt: new Date(),
    });
    await expect(
      service.preview('document-1', PUBLISHED_PALLET_LABEL_LAYOUT),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    prisma.palletListDocument.findUnique.mockResolvedValueOnce({
      ...DOCUMENT,
      payload: {
        ...DOCUMENT.payload,
        templateVersion: 'pallet-100x100-safe-v5',
      },
    });
    await expect(
      service.preview('document-1', PUBLISHED_PALLET_LABEL_LAYOUT),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects text that cannot fit the submitted sandbox geometry', async () => {
    const prisma = prismaMock();
    const service = new PalletLabelLayoutEditorService(
      prisma as never,
      new PalletLabelLayoutEditorRenderer(),
    );
    const layout: PalletLabelLayout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    const storage = layout.elements.find((element) => element.id === 'storage')!;
    storage.widthDots = 20;
    storage.heightDots = 1;

    const failure = service.preview('document-1', layout);
    await expect(failure).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(failure).rejects.toMatchObject({
      response: {
        code: 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW',
        blockId: 'storage',
        message: 'Pallet layout block storage cannot fit the selected source.',
      },
    });
  });
});
