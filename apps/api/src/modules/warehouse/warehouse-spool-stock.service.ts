import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';

type SpoolReturnActor = {
  userId: string | null;
  role: Role;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function spoolTypeFromSnapshot(value: unknown): string | null {
  const spoolType = record(value).spoolType;
  return typeof spoolType === 'string' && spoolType.trim() ? spoolType.trim() : null;
}

@Injectable()
export class WarehouseSpoolStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async returnDefectSpool(
    actor: SpoolReturnActor,
    defectRecordId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const defect = await client.defectRecord.findUnique({
      where: { id: defectRecordId },
      select: {
        id: true,
        weightCapture: { select: { spoolKg: true } },
        line: {
          select: {
            spoolKg: true,
            rollDispatchItem: {
              select: {
                rollCode: true,
                orderLineId: true,
                characteristicsSnapshot: true,
              },
            },
          },
        },
      },
    });
    if (!defect) {
      throw new NotFoundException({
        code: 'DEFECT_SPOOL_SOURCE_NOT_FOUND',
        message: 'Запись брака не найдена.',
      });
    }

    const dispatch = defect.line.rollDispatchItem;
    const position = dispatch.orderLineId
      ? await client.commercialOrderPosition.findUnique({
          where: { id: dispatch.orderLineId },
          select: { spoolType: true },
        })
      : null;
    const spoolType =
      spoolTypeFromSnapshot(dispatch.characteristicsSnapshot) ??
      position?.spoolType?.trim() ??
      'Тип не указан';
    const tareKg = defect.weightCapture?.spoolKg ?? defect.line.spoolKg;
    if (tareKg === null || !Number.isFinite(tareKg) || tareKg <= 0) {
      throw new ConflictException({
        code: 'DEFECT_SPOOL_EVIDENCE_REQUIRED',
        message: 'Для возврата шпули нужен сохранённый положительный вес тары.',
      });
    }

    const movement = {
      defectRecordId: defect.id,
      rollCode: dispatch.rollCode,
      spoolType,
      tareKg: Number(tareKg.toFixed(3)),
      quantity: 1,
      location: 'warehouse',
      returnedByRole: actor.role,
      returnedById: actor.userId,
    } as const;
    const created = await client.spoolStockMovement.createMany({
      data: movement,
      skipDuplicates: true,
    });
    if (created.count === 1) {
      await this.audit.record(
        {
          type: 'audit:defect_spool_returned',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: dispatch.rollCode,
          newValue: {
            defectRecordId: defect.id,
            spoolType,
            tareKg: movement.tareKg,
            quantity: 1,
            location: 'warehouse',
          },
          detail: {
            defectRecordId: defect.id,
            rollId: dispatch.rollCode,
          },
        },
        client,
      );
    }

    const result = await client.spoolStockMovement.findUnique({
      where: { defectRecordId: defect.id },
    });
    if (!result) {
      throw new ConflictException({
        code: 'DEFECT_SPOOL_RETURN_UNAVAILABLE',
        message: 'Не удалось подтвердить возврат шпули на склад.',
      });
    }
    return result;
  }
}
