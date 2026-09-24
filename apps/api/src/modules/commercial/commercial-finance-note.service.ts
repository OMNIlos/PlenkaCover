import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Role } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lockCommercialOrderAggregate } from '../warehouse-coverage/warehouse-coverage-transaction';
import type { FinanceNoteDto } from './dto/finance-note.dto';

type CommercialFinanceNoteActor = {
  userId: string | null;
  role: Role;
};

export type CommercialFinanceNoteResult = {
  id: string;
  version: number;
  commercialFinanceNote: string | null;
};

function normalizeFinanceNote(value: string | null): string | null {
  return value?.trim() || null;
}

export function commercialFinanceNoteFingerprintInput(orderId: string, dto: FinanceNoteDto) {
  return {
    orderId,
    commercialFinanceNote: normalizeFinanceNote(dto.commercialFinanceNote),
    expectedVersion: dto.expectedVersion,
  };
}

function commandResult(value: Prisma.JsonValue): CommercialFinanceNoteResult {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'number' ||
    (value.commercialFinanceNote !== null && typeof value.commercialFinanceNote !== 'string')
  ) {
    throw new ConflictException({
      code: 'COMMERCIAL_FINANCE_NOTE_REPLAY_INVALID',
      message: 'Сохранённый результат изменения комментария повреждён.',
    });
  }
  return {
    id: value.id,
    version: value.version,
    commercialFinanceNote: value.commercialFinanceNote,
  };
}

@Injectable()
export class CommercialFinanceNoteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async update(
    actor: CommercialFinanceNoteActor,
    orderId: string,
    dto: FinanceNoteDto,
  ): Promise<CommercialFinanceNoteResult> {
    const fingerprint = requestFingerprint(commercialFinanceNoteFingerprintInput(orderId, dto));
    const note = normalizeFinanceNote(dto.commercialFinanceNote);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(
          hashtextextended(${`commercial-finance-note:${dto.operationKey}`}, 0)
        )::text AS "lock"`,
      );
      await lockCommercialOrderAggregate(tx, orderId);

      const replay = await tx.commercialFinanceNoteCommand.findUnique({
        where: { operationKey: dto.operationKey },
        select: { requestFingerprint: true, result: true },
      });
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new ConflictException({
            code: 'COMMERCIAL_FINANCE_NOTE_OPERATION_KEY_CONFLICT',
            message: 'operationKey уже связан с другим изменением комментария.',
          });
        }
        return commandResult(replay.result);
      }

      const order = await tx.commercialOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          version: true,
          commercialFinanceNote: true,
          financeOrder: { select: { id: true } },
          productionOrder: { select: { id: true } },
        },
      });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      if (order.version !== dto.expectedVersion) {
        throw new ConflictException({
          code: 'COMMERCIAL_FINANCE_NOTE_VERSION_CONFLICT',
          message: 'Заявка уже изменена. Обновите её и повторите действие.',
        });
      }
      const result: CommercialFinanceNoteResult =
        order.commercialFinanceNote === note
          ? {
              id: order.id,
              version: order.version,
              commercialFinanceNote: note,
            }
          : {
              id: order.id,
              version: order.version + 1,
              commercialFinanceNote: note,
            };

      if (order.commercialFinanceNote !== note) {
        const updated = await tx.commercialOrder.updateMany({
          where: { id: order.id, version: order.version },
          data: {
            commercialFinanceNote: note,
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            code: 'COMMERCIAL_FINANCE_NOTE_VERSION_CONFLICT',
            message: 'Заявка уже изменена. Обновите её и повторите действие.',
          });
        }
        await this.audit.record(
          {
            type: 'audit:commercial_finance_note_updated',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: order.id,
            label: 'Комментарий для бухгалтерии изменён',
            oldValue: {
              commercialFinanceNote: order.commercialFinanceNote,
              version: order.version,
            },
            newValue: {
              commercialFinanceNote: note,
              version: result.version,
            },
            detail: { operationKey: dto.operationKey },
          },
          tx,
        );
        const recipientRoles: Role[] = [
          ...(order.financeOrder ? (['finance'] as const) : []),
          ...(order.productionOrder ? (['production_lead'] as const) : []),
        ];
        if (recipientRoles.length > 0) {
          await this.audit.record(
            {
              type: 'notification:commercial_order_amended',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: order.id,
              label: 'Комментарий для бухгалтерии изменён',
              detail: {
                orderId: order.id,
                orderNumber: order.orderNumber,
                field: 'commercialFinanceNote',
                recipientRoles,
              },
            },
            tx,
          );
        }
      }

      await tx.commercialFinanceNoteCommand.create({
        data: {
          orderId: order.id,
          operationKey: dto.operationKey,
          requestFingerprint: fingerprint,
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
      return result;
    });
  }
}
