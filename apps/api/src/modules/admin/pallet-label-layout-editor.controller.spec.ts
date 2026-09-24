import { StreamableFile } from '@nestjs/common';
import type { PalletLabelLayoutEditorBootstrap } from '@plenka/contracts';
import { PalletLabelLayoutEditorController } from './pallet-label-layout-editor.controller';
import type { PalletLabelLayoutEditorService } from './pallet-label-layout-editor.service';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from './pallet-label-layout-editor.validator';
import type { Actor } from '../../common/auth/actor';

describe('PalletLabelLayoutEditorController', () => {
  const bootstrap: PalletLabelLayoutEditorBootstrap = {
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
    sources: [],
  };

  it('marks bootstrap as non-cacheable', async () => {
    const service = { bootstrap: jest.fn().mockResolvedValue(bootstrap) };
    const controller = new PalletLabelLayoutEditorController(
      service as unknown as PalletLabelLayoutEditorService,
    );
    const response = { setHeader: jest.fn() };

    await expect(controller.bootstrap(response as never)).resolves.toBe(bootstrap);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('returns an exact PNG with exposed base64url diagnostics and no-store headers', async () => {
    const diagnostics = {
      belowProvenCut: ['storage'] as const,
      outsideSafeArea: [],
      overlaps: [],
    };
    const service = {
      preview: jest.fn().mockResolvedValue({ png: Buffer.from('png'), diagnostics }),
    };
    const controller = new PalletLabelLayoutEditorController(
      service as unknown as PalletLabelLayoutEditorService,
    );
    const response = { setHeader: jest.fn() };

    const result = await controller.preview(
      { sourceDocumentId: 'document-1', layout: PUBLISHED_PALLET_LABEL_LAYOUT },
      response as never,
    );

    expect(result).toBeInstanceOf(StreamableFile);
    expect(service.preview).toHaveBeenCalledWith('document-1', PUBLISHED_PALLET_LABEL_LAYOUT);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Access-Control-Expose-Headers',
      'X-Pallet-Layout-Diagnostics',
    );
    const encoded = response.setHeader.mock.calls.find(
      ([name]: [string, string]) => name === 'X-Pallet-Layout-Diagnostics',
    )?.[1] as string;
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(diagnostics);
  });

  it('delegates publish with the authenticated actor and the complete CAS command', async () => {
    const actor: Actor = {
      userId: 'admin-1',
      role: 'admin',
      capabilities: ['pallet_label_layout:manage'],
    };
    const command = {
      operationKey: '123e4567-e89b-42d3-a456-426614174000',
      expectedActivePublicationId: null,
      sourceDocumentId: 'document-1',
      reason: 'Утверждение макета',
      layout: PUBLISHED_PALLET_LABEL_LAYOUT,
    };
    const result = { publication: { id: 'publication-1' }, replayed: false };
    const service = { publish: jest.fn().mockResolvedValue(result) };
    const controller = new PalletLabelLayoutEditorController(
      service as unknown as PalletLabelLayoutEditorService,
    );

    await expect(controller.publish(actor, command)).resolves.toBe(result);
    expect(service.publish).toHaveBeenCalledWith(actor, command);
  });
});
