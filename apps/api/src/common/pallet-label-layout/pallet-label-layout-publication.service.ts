import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  type PalletLabelLayoutPublication,
  type PublishPalletLabelLayoutCommand,
  type PublishPalletLabelLayoutResult,
} from '@plenka/contracts';
import type { Actor } from '../auth/actor';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConfigurablePalletLabelRenderer,
  PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
} from './configurable-pallet-label.renderer';
import {
  PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS,
  resolvePalletLabelLayoutValidationSource,
} from './pallet-label-layout-validation-source';
import {
  assertPalletLabelLayoutPublishable,
  parsePalletLabelLayoutPublication,
  parsePersistedPalletLabelLayout,
} from './pallet-label-layout.validator';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFORMANCE_PALLET_TOKEN = `plt_${'f'.repeat(64)}`;

type PublicationRow = {
  id: string;
  version: number;
  contentHash: string;
  definition: unknown;
  activatedAt: Date;
};

type LinkedPublicationRow = PublicationRow & { profile: string };

type PublicationClient = Pick<Prisma.TransactionClient, 'palletLabelLayoutVersion'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function publicationOf(row: PublicationRow): PalletLabelLayoutPublication {
  try {
    return parsePalletLabelLayoutPublication({
      id: row.id,
      version: row.version,
      contentHash: row.contentHash,
      activatedAt: row.activatedAt.toISOString(),
      layout: row.definition,
    });
  } catch {
    throw new ConflictException({
      code: 'PALLET_LABEL_LAYOUT_PUBLICATION_CORRUPTED',
      message: 'Stored pallet-label layout publication is corrupted.',
    });
  }
}

function commandCorrupted(): never {
  throw new ConflictException({
    code: 'PALLET_LABEL_LAYOUT_COMMAND_CORRUPTED',
    message: 'Stored pallet-label publication command is corrupted.',
  });
}

function replayPublication(value: unknown): PalletLabelLayoutPublication {
  const record = asRecord(value);
  if (!record || Object.keys(record).length !== 1 || !('publication' in record)) {
    commandCorrupted();
  }
  try {
    return parsePalletLabelLayoutPublication(record.publication);
  } catch {
    commandCorrupted();
  }
}

function verifiedReplay(
  resultSnapshot: unknown,
  journalProfile: string,
  resultPublicationId: string,
  linked: LinkedPublicationRow | null,
): PalletLabelLayoutPublication {
  if (
    journalProfile !== PALLET_LABEL_CONFIGURABLE_PROFILE ||
    !linked ||
    linked.profile !== PALLET_LABEL_CONFIGURABLE_PROFILE ||
    resultPublicationId !== linked.id
  ) {
    commandCorrupted();
  }

  try {
    const snapshot = replayPublication(resultSnapshot);
    const persisted = publicationOf(linked);
    if (JSON.stringify(snapshot) !== JSON.stringify(persisted)) commandCorrupted();
    return persisted;
  } catch {
    commandCorrupted();
  }
}

@Injectable()
export class PalletLabelLayoutPublicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly renderer: ConfigurablePalletLabelRenderer,
  ) {}

  async active(
    client: PublicationClient = this.prisma,
  ): Promise<PalletLabelLayoutPublication | null> {
    const row = await client.palletLabelLayoutVersion.findFirst({
      where: { profile: PALLET_LABEL_CONFIGURABLE_PROFILE },
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        version: true,
        contentHash: true,
        definition: true,
        activatedAt: true,
      },
    });
    return row ? publicationOf(row) : null;
  }

  async activeForNewDocument(
    client: PublicationClient = this.prisma,
  ): Promise<PalletLabelLayoutPublication | null> {
    const publication = await this.active(client);
    if (!publication) return null;
    try {
      for (const testCase of PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS) {
        this.renderer.renderSvg(testCase.snapshot, publication.layout, {
          qrToken: CONFORMANCE_PALLET_TOKEN,
          watermark: false,
        });
      }
    } catch {
      throw new ConflictException({
        code: 'PALLET_LABEL_LAYOUT_ACTIVE_CAPACITY_REDUCED',
        message:
          'The active pallet-label layout predates the current capacity policy. Publish a conforming layout before sealing new pallets.',
      });
    }
    return publication;
  }

  async publish(
    actor: Actor,
    submitted: PublishPalletLabelLayoutCommand,
  ): Promise<PublishPalletLabelLayoutResult> {
    if (!actor.userId) throw new UnauthorizedException('Authenticated user is required.');
    const actorId = actor.userId;
    const operationKey = submitted.operationKey?.trim().toLowerCase();
    const sourceDocumentId = submitted.sourceDocumentId?.trim();
    const reason = submitted.reason?.replace(/\s+/gu, ' ').trim();
    if (!UUID_V4.test(operationKey)) {
      throw new BadRequestException({
        code: 'PALLET_LABEL_LAYOUT_OPERATION_KEY_INVALID',
        message: 'operationKey must be a UUID v4.',
      });
    }
    if (!sourceDocumentId || sourceDocumentId.length > 200) {
      throw new BadRequestException({
        code: 'PALLET_LABEL_LAYOUT_SOURCE_ID_INVALID',
        message: 'sourceDocumentId is required.',
      });
    }
    if (!reason || reason.length < 3 || reason.length > 500) {
      throw new BadRequestException({
        code: 'PALLET_LABEL_LAYOUT_REASON_INVALID',
        message: 'reason must contain from 3 to 500 characters.',
      });
    }
    if (
      submitted.expectedActivePublicationId !== null &&
      (typeof submitted.expectedActivePublicationId !== 'string' ||
        submitted.expectedActivePublicationId.trim().length === 0)
    ) {
      throw new BadRequestException({
        code: 'PALLET_LABEL_LAYOUT_EXPECTED_ACTIVE_INVALID',
        message: 'expectedActivePublicationId must be null or a non-empty id.',
      });
    }
    const expectedActivePublicationId = submitted.expectedActivePublicationId;
    const layout = parsePersistedPalletLabelLayout(submitted.layout);
    const canonicalDefinition = JSON.stringify(layout);
    const requestFingerprint = sha256(
      JSON.stringify({
        expectedActivePublicationId,
        layout,
        operationKey,
        reason,
        sourceDocumentId,
      }),
    );
    const contentHash = sha256(canonicalDefinition);

    // Admission policy can tighten without invalidating an immutable command replay. This
    // read-only preflight distinguishes a historical retry before the new policy is enforced;
    // the serializable transaction still re-reads and fully verifies the command below.
    const journaledCommand = await this.prisma.palletLabelLayoutPublishCommand.findUnique({
      where: { operationKey },
      select: { id: true },
    });
    if (!journaledCommand) assertPalletLabelLayoutPublishable(layout);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`pallet-layout:${PALLET_LABEL_CONFIGURABLE_PROFILE}`}))`,
      );
      const existing = await tx.palletLabelLayoutPublishCommand.findUnique({
        where: { operationKey },
        select: {
          requestFingerprint: true,
          resultSnapshot: true,
          profile: true,
          resultPublicationId: true,
          resultPublication: {
            select: {
              id: true,
              profile: true,
              version: true,
              contentHash: true,
              definition: true,
              activatedAt: true,
            },
          },
        },
      });
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new ConflictException({
            code: 'PALLET_LABEL_LAYOUT_OPERATION_KEY_REUSED',
            message: 'operationKey was already used with another publish request.',
          });
        }
        return {
          publication: verifiedReplay(
            existing.resultSnapshot,
            existing.profile,
            existing.resultPublicationId,
            existing.resultPublication,
          ),
          replayed: true,
        };
      }

      // Defend the admission boundary even if the preflight observation changes before this
      // serializable transaction. Historical commands return above; only a new version reaches it.
      assertPalletLabelLayoutPublishable(layout);

      const active = await this.active(tx);
      if ((active?.id ?? null) !== expectedActivePublicationId) {
        throw new ConflictException({
          code: 'PALLET_LABEL_LAYOUT_ACTIVE_CONFLICT',
          message: 'The active pallet-label layout changed. Refresh and publish again.',
          activePublicationId: active?.id ?? null,
        });
      }

      const source = await resolvePalletLabelLayoutValidationSource(tx, sourceDocumentId);
      try {
        for (const snapshot of [
          source.snapshot,
          ...PALLET_LABEL_LAYOUT_CONFORMANCE_CORPUS.map((testCase) => testCase.snapshot),
        ]) {
          this.renderer.render(snapshot, layout, {
            qrToken: PALLET_LABEL_LAYOUT_PREVIEW_TOKEN,
            watermark: true,
          });
        }
      } catch {
        throw new UnprocessableEntityException({
          code: 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW',
          message: 'The selected source cannot fit the submitted layout.',
        });
      }

      const row = await tx.palletLabelLayoutVersion.create({
        data: {
          profile: PALLET_LABEL_CONFIGURABLE_PROFILE,
          version: (active?.version ?? 0) + 1,
          definition: layout as unknown as Prisma.InputJsonValue,
          contentHash,
          sourceDocumentId,
          publishedById: actorId,
          reason,
        },
        select: {
          id: true,
          version: true,
          contentHash: true,
          definition: true,
          activatedAt: true,
        },
      });
      const publication = publicationOf(row);
      await tx.palletLabelLayoutPublishCommand.create({
        data: {
          operationKey,
          requestFingerprint,
          profile: PALLET_LABEL_CONFIGURABLE_PROFILE,
          expectedActivePublicationId,
          sourceDocumentId,
          actorId,
          resultPublicationId: publication.id,
          resultSnapshot: { publication } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          type: 'audit:pallet_label_layout_published',
          actorRole: actor.role,
          actorId,
          objectId: publication.id,
          reason,
          detail: {
            profile: PALLET_LABEL_CONFIGURABLE_PROFILE,
            version: publication.version,
            contentHash: publication.contentHash,
            sourceDocumentId,
          },
        },
        tx,
      );
      return { publication, replayed: false };
    });
  }
}
