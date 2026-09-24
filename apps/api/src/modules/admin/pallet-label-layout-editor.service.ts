import { Injectable, Optional, UnprocessableEntityException } from '@nestjs/common';
import {
  PALLET_LABEL_LAYOUT_BLOCK_IDS,
  PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
  type PalletLabelLayoutBlockId,
  type PalletLabelLayoutEditorBootstrap,
  type PalletLabelLayoutEditorDiagnostics,
  type PublishPalletLabelLayoutCommand,
  type PublishPalletLabelLayoutResult,
} from '@plenka/contracts';
import type { Actor } from '../../common/auth/actor';
import { PalletLabelLayoutPublicationService } from '../../common/pallet-label-layout/pallet-label-layout-publication.service';
import {
  PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
  PALLET_LABEL_LAYOUT_CONTROL_SOURCE_LABEL,
  PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT,
  resolvePalletLabelLayoutValidationSource,
} from '../../common/pallet-label-layout/pallet-label-layout-validation-source';
import { PrismaService } from '../../common/prisma/prisma.service';
import { immutablePalletLabelProfile } from '../warehouse/pallet-label-snapshot';
import { PalletLabelLayoutEditorRenderer } from './pallet-label-layout-editor.renderer';
import {
  PALLET_LABEL_LAYOUT_CANVAS,
  PUBLISHED_PALLET_LABEL_LAYOUT,
  parsePalletLabelLayout,
} from './pallet-label-layout-editor.validator';

type PreviewResult = {
  png: Buffer;
  diagnostics: PalletLabelLayoutEditorDiagnostics;
};

const SOURCE_PROFILE = 'pallet-100x100-extended-v6';

function contentOverflow(error: unknown): UnprocessableEntityException {
  const match =
    error instanceof Error
      ? /^Pallet layout block (\w+) (?:has no text area|cannot fit the selected source)$/u.exec(
          error.message,
        )
      : null;
  const blockId = match?.[1];
  const knownBlock =
    typeof blockId === 'string' &&
    (PALLET_LABEL_LAYOUT_BLOCK_IDS as readonly string[]).includes(blockId)
      ? (blockId as PalletLabelLayoutBlockId)
      : null;
  return new UnprocessableEntityException({
    code: 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW',
    ...(knownBlock ? { blockId: knownBlock } : {}),
    message: knownBlock
      ? `Pallet layout block ${knownBlock} cannot fit the selected source.`
      : 'The selected source cannot fit the submitted draft layout.',
  });
}

@Injectable()
export class PalletLabelLayoutEditorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: PalletLabelLayoutEditorRenderer,
    @Optional() private readonly publications?: PalletLabelLayoutPublicationService,
  ) {}

  async bootstrap(): Promise<PalletLabelLayoutEditorBootstrap> {
    const documents = await this.prisma.palletListDocument.findMany({
      where: {
        voidedAt: null,
        payload: {
          path: ['templateVersion'],
          equals: SOURCE_PROFILE,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        palletId: true,
        createdAt: true,
        rollIds: true,
        payload: true,
      },
    });

    const documentSources = documents.flatMap((document) => {
      if (immutablePalletLabelProfile(document.payload) !== SOURCE_PROFILE) {
        return [];
      }
      if (!Array.isArray(document.rollIds)) return [];
      return [
        {
          documentId: document.id,
          kind: 'document' as const,
          label: `Палетный лист ${document.palletId}`,
          palletId: document.palletId,
          createdAt: document.createdAt.toISOString(),
          rollCount: document.rollIds.length,
        },
      ];
    });
    const sources: PalletLabelLayoutEditorBootstrap['sources'] = [
      {
        documentId: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
        kind: 'control',
        label: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_LABEL,
        palletId: PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT.palletId,
        createdAt: PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT.createdAt,
        rollCount: PALLET_LABEL_LAYOUT_CONTROL_SNAPSHOT.rollCount,
      },
      ...documentSources,
    ];

    const activePublication = (await this.publications?.active()) ?? null;
    const editorLayout =
      activePublication?.layout.schemaVersion === 2
        ? structuredClone(activePublication.layout)
        : structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    return {
      schemaVersion: 2,
      profile: PALLET_LABEL_LAYOUT_EDITOR_PROFILE,
      canvas: PALLET_LABEL_LAYOUT_CANVAS,
      editorLayout,
      activePublication,
      sources,
    };
  }

  async preview(sourceDocumentId: string, submittedLayout: unknown): Promise<PreviewResult> {
    const { layout, diagnostics } = parsePalletLabelLayout(submittedLayout);
    const source = await resolvePalletLabelLayoutValidationSource(this.prisma, sourceDocumentId);

    try {
      return {
        png: this.renderer.render(source.snapshot, layout),
        diagnostics,
      };
    } catch (error) {
      throw contentOverflow(error);
    }
  }

  publish(
    actor: Actor,
    command: PublishPalletLabelLayoutCommand,
  ): Promise<PublishPalletLabelLayoutResult> {
    if (!this.publications) throw new Error('Pallet-label publication service is unavailable');
    return this.publications.publish(actor, command);
  }
}
