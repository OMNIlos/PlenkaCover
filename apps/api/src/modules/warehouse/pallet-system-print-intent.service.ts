import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { DomainEvent } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  PalletSystemPrintIntentDto,
  PalletSystemPrintIntentKind,
  PalletSystemPrintIntentResponseDto,
} from './dto/pallet-system-print-intent.dto';

const SYSTEM_PRINT_CHANNEL = 'browser_system_print';
type IntentEventType = 'audit:pallet_list_print_requested' | 'audit:pallet_list_reprint_requested';

function eventType(kind: PalletSystemPrintIntentKind): IntentEventType {
  return kind === 'initial'
    ? 'audit:pallet_list_print_requested'
    : 'audit:pallet_list_reprint_requested';
}

type StoredIntent = Pick<DomainEvent, 'id' | 'type' | 'objectId' | 'reason' | 'createdAt'>;

function providedIntentReason(dto: PalletSystemPrintIntentDto): string | null {
  if (dto.kind === 'initial') {
    if (dto.reason !== undefined) {
      throw new BadRequestException({
        code: 'PALLET_SYSTEM_PRINT_REASON_UNEXPECTED',
        message: 'Причина указывается только для повторной системной печати.',
      });
    }
    return null;
  }

  if (dto.reason === undefined) return null;

  const reason = dto.reason.replace(/\s+/gu, ' ').trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new BadRequestException({
      code: 'PALLET_SYSTEM_REPRINT_REASON_REQUIRED',
      message: 'Для повторной системной печати укажите причину от 3 до 500 символов.',
    });
  }
  return reason;
}

@Injectable()
export class PalletSystemPrintIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    palletListDocumentId: string,
    dto: PalletSystemPrintIntentDto,
  ): Promise<PalletSystemPrintIntentResponseDto> {
    const requestId = dto.requestId.toLowerCase();
    const reason = providedIntentReason(dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pallet-system-print-intent:${requestId}`}))`;

      const replays = await tx.$queryRaw<StoredIntent[]>`
        SELECT "id", "type", "objectId", "reason", "createdAt"
        FROM "domain_events"
        WHERE "type" IN (
          'audit:pallet_list_print_requested',
          'audit:pallet_list_reprint_requested'
        )
          AND "detail"->>'channel' = 'browser_system_print'
          AND lower("detail"->>'requestId') = ${requestId}
        ORDER BY "createdAt" ASC, "id" ASC
      `;
      if (replays.length > 0) {
        for (const replay of replays) {
          this.assertCompatibleReplay(replay, palletListDocumentId, dto.kind, reason);
        }
        return this.response(replays[0]!, requestId, palletListDocumentId, dto.kind, true);
      }

      if (dto.kind === 'reprint' && reason === null) {
        throw new BadRequestException({
          code: 'PALLET_SYSTEM_REPRINT_REASON_REQUIRED',
          message: 'Для повторной системной печати укажите причину от 3 до 500 символов.',
        });
      }

      const document = await tx.palletListDocument.findUnique({
        where: { id: palletListDocumentId },
        select: { id: true, palletId: true, voidedAt: true },
      });
      if (!document) {
        throw new NotFoundException({
          code: 'PALLET_LIST_DOCUMENT_NOT_FOUND',
          message: 'Палетный лист не найден.',
        });
      }
      if (document.voidedAt) {
        throw new ConflictException({
          code: 'PALLET_LIST_DOCUMENT_VOIDED',
          message: 'Аннулированный палетный лист нельзя открыть для печати.',
        });
      }

      const event = await this.audit.record(
        {
          type: eventType(dto.kind),
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: document.id,
          ...(reason ? { reason } : {}),
          detail: {
            channel: SYSTEM_PRINT_CHANNEL,
            requestId,
            intentKind: dto.kind,
            palletId: document.palletId,
          },
        },
        tx,
      );

      return this.response(event, requestId, document.id, dto.kind, false);
    });
  }

  private assertCompatibleReplay(
    event: StoredIntent,
    palletListDocumentId: string,
    kind: PalletSystemPrintIntentKind,
    reason: string | null,
  ): void {
    if (
      event.objectId === palletListDocumentId &&
      event.type === eventType(kind) &&
      event.reason === reason
    ) {
      return;
    }
    throw new ConflictException({
      code: 'PALLET_SYSTEM_PRINT_REQUEST_CONFLICT',
      message: 'Идентификатор запроса уже использован для другой системной печати.',
    });
  }

  private response(
    event: StoredIntent,
    requestId: string,
    palletListDocumentId: string,
    kind: PalletSystemPrintIntentKind,
    replayed: boolean,
  ): PalletSystemPrintIntentResponseDto {
    return {
      eventId: event.id,
      requestId,
      palletListDocumentId,
      kind,
      status: 'intent_recorded',
      replayed,
      requestedAt: event.createdAt.toISOString(),
    };
  }
}
