import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type BigBagLabelPrintJob } from '@prisma/client';
import type { BigBagLabelPrintView, Role } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BigBagLabelRenderer } from './bigbag-label.renderer';
import type { BigBagSystemPrintIntentDto } from './dto/bigbag-system-print.dto';

const SYSTEM_PRINT_CHANNEL = 'browser_system_print';

type BigBagSystemPrintActor = { userId: string | null; role: Role };

function normalizedReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const value = reason.replace(/\s+/gu, ' ').trim();
  return value.length > 0 ? value : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class WarehouseBigBagSystemPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly renderer: BigBagLabelRenderer,
  ) {}

  async preview(bigBagId: string) {
    const bag = await this.prisma.bigBagUnit.findUnique({
      where: { id: bigBagId },
      select: {
        id: true,
        code: true,
        material: true,
        scanToken: { select: { token: true } },
      },
    });
    this.assertPrintableBag(bag);
    const { svg: _svg, ...preview } = this.renderer.render({
      bigBagCode: bag.code,
      material: bag.material,
      qrCode: bag.scanToken.token,
    });
    return preview;
  }

  async record(
    actor: BigBagSystemPrintActor,
    bigBagId: string,
    dto: BigBagSystemPrintIntentDto,
  ): Promise<BigBagLabelPrintView> {
    const requestId = dto.requestId.toLowerCase();
    const reason = normalizedReason(dto.reason);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(
            hashtext(${`bigbag-system-print:${requestId}`})
          )::text AS "lock"`,
        );
        const replay = await tx.bigBagLabelPrintJob.findUnique({ where: { requestId } });
        if (replay) return this.compatibleReplay(replay, bigBagId, reason);

        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "big_bag_units" WHERE "id" = ${bigBagId} FOR UPDATE`,
        );
        const bag = await tx.bigBagUnit.findUnique({
          where: { id: bigBagId },
          select: {
            id: true,
            code: true,
            material: true,
            scanToken: { select: { token: true } },
          },
        });
        this.assertPrintableBag(bag);
        const uncertain = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId, status: 'uncertain' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (uncertain) {
          throw new ConflictException({
            code: 'BIGBAG_PRINT_OUTCOME_UNCERTAIN',
            message: 'Результат прошлой печати не подтверждён. Проверьте этикетку перед повтором.',
            printJobId: uncertain.id,
          });
        }
        const active = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId, status: 'queued' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (active) {
          throw new ConflictException({
            code: 'BIGBAG_PRINT_IN_PROGRESS',
            message: 'Предыдущее задание печати ещё выполняется.',
            printJobId: active.id,
          });
        }
        const predecessor = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId, status: { in: ['submitted', 'intent_recorded'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (predecessor && (!reason || reason.length < 3 || reason.length > 500)) {
          throw new BadRequestException({
            code: 'BIGBAG_SYSTEM_REPRINT_REASON_REQUIRED',
            message: 'Для повторной системной печати укажите причину от 3 до 500 символов.',
          });
        }
        if (!predecessor && reason) {
          throw new BadRequestException({
            code: 'BIGBAG_SYSTEM_PRINT_REASON_UNEXPECTED',
            message: 'Причина указывается только для повторной системной печати.',
          });
        }

        const job = await tx.bigBagLabelPrintJob.create({
          data: {
            requestId,
            bigBagId,
            printerId: null,
            channel: SYSTEM_PRINT_CHANNEL,
            status: 'intent_recorded',
            failureReason: null,
            reason: predecessor ? reason : null,
            replacesPrintJobId: predecessor?.id ?? null,
            gatewayCommandId: null,
            requestedById: actor.userId,
            requestedByRole: actor.role,
          },
        });
        await this.audit.record(
          {
            type: predecessor
              ? 'audit:bigbag_label_reprint_requested'
              : 'audit:bigbag_label_print_requested',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: bag.code,
            reason: predecessor ? (reason ?? undefined) : undefined,
            detail: {
              channel: SYSTEM_PRINT_CHANNEL,
              bigBagId,
              printJobId: job.id,
              replacesPrintJobId: job.replacesPrintJobId,
              requestId,
            },
          },
          tx,
        );
        return this.project(job);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.prisma.bigBagLabelPrintJob.findUnique({ where: { requestId } });
      if (!replay) throw error;
      return this.compatibleReplay(replay, bigBagId, reason);
    }
  }

  private assertPrintableBag(
    bag: {
      id: string;
      code: string;
      material: string;
      scanToken: { token: string } | null;
    } | null,
  ): asserts bag is {
    id: string;
    code: string;
    material: string;
    scanToken: { token: string };
  } {
    if (!bag) {
      throw new NotFoundException({ code: 'BIGBAG_NOT_FOUND', message: 'Big-Bag не найден.' });
    }
    if (!bag.scanToken) {
      throw new ConflictException({
        code: 'BIGBAG_QR_NOT_CREATED',
        message: 'Для Big-Bag ещё не создан QR-код.',
      });
    }
  }

  private compatibleReplay(
    job: BigBagLabelPrintJob,
    bigBagId: string,
    reason: string | null,
  ): BigBagLabelPrintView {
    if (
      job.bigBagId !== bigBagId ||
      job.channel !== SYSTEM_PRINT_CHANNEL ||
      job.printerId !== null ||
      job.reason !== reason
    ) {
      throw new ConflictException({
        code: 'BIGBAG_SYSTEM_PRINT_REQUEST_CONFLICT',
        message: 'Идентификатор запроса уже использован для другой печати.',
      });
    }
    return this.project(job);
  }

  private project(job: BigBagLabelPrintJob): BigBagLabelPrintView {
    return {
      id: job.id,
      requestId: job.requestId,
      bigBagId: job.bigBagId,
      printerId: job.printerId,
      channel: job.channel as BigBagLabelPrintView['channel'],
      status: job.status as BigBagLabelPrintView['status'],
      reason: job.reason,
      replacesPrintJobId: job.replacesPrintJobId,
      gatewayCommandId: job.gatewayCommandId,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }
}
