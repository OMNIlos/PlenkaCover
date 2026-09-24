import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFECT_BAG_TYPES,
  isBigBagScanToken,
  type DefectBagType,
  type OperatorShiftDefectBag,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PRINTER_ADAPTER, type PrinterAdapter } from '../../integrations/printer/printer.adapter';
import type { DefectBagPrintDto, DefectBagWeightDto } from './dto/defect-bag.dto';
import { OperatorDeviceBindingService } from './operator-device-binding.service';
import { OperatorSessionService } from './operator-session.service';
import type { OperatorActor } from './operator.service';

const MAX_DEFECT_BAG_KG = 10_000;
const PRINT_LEASE_MS = 30_000;
const DEFECT_BAG_TYPE_LABELS: Record<DefectBagType, string> = {
  secondary: 'Вторичка',
  aika: 'Айка',
  primary: 'Первичка',
};
const MOSCOW_DEFECT_BAG_DATE = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});

type SafeBagRow = {
  id: string;
  code: string;
  postSessionId: string;
  status: string;
  defectType: string | null;
  weightKg: number;
  recordedDefectKg: number;
  differenceKg: number;
  weighedAt: Date;
};

type PrintClaim = {
  kind: 'claimed';
  bag: SafeBagRow;
  jobId: string;
  leaseToken: string;
  postId: string;
  sessionId: string;
  deviceId: string;
  qrCode: string;
};

const round3 = (value: number): number => Number(value.toFixed(3));

function defectBagCode(at: Date, postCode: string, sequence: bigint): string {
  const dateParts = new Map(
    MOSCOW_DEFECT_BAG_DATE.formatToParts(at).map((part) => [part.type, part.value]),
  );
  const date = `${dateParts.get('year')}${dateParts.get('month')}${dateParts.get('day')}`;
  const post =
    postCode
      .normalize('NFKC')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 24) || 'POST';
  return `DEF-${date}-${post}-${sequence.toString().padStart(6, '0')}`;
}

@Injectable()
export class OperatorDefectBagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: OperatorSessionService,
    private readonly bindings: OperatorDeviceBindingService,
    @Inject(PRINTER_ADAPTER) private readonly printer: PrinterAdapter,
  ) {}

  async weigh(actor: OperatorActor, dto: DefectBagWeightDto): Promise<OperatorShiftDefectBag> {
    const actorId = this.requireActorId(actor);
    const weightKg = this.manualWeight(dto.weightKg);
    const defectType =
      weightKg === 0 && dto.defectType == null ? null : this.requireDefectType(dto.defectType);
    const session = await this.sessions.requireActive(actorId);
    const replay = await this.prisma.defectBag.findUnique({
      where: { weighOperationKey: dto.operationKey },
    });
    if (replay) {
      this.assertBagSession(replay, session.id);
      if (round3(replay.weightKg) !== weightKg || replay.defectType !== defectType) {
        throw this.operationKeyReused();
      }
      return this.project(replay, await this.latestPrintStatus(replay.id, this.prisma));
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockedSession = await this.sessions.lockActiveInTransaction(tx, actorId);
        if (lockedSession.id !== session.id || lockedSession.postId !== session.postId) {
          throw new ConflictException({
            code: 'DEFECT_BAG_SESSION_CHANGED',
            message: 'Сессия поста изменилась до фиксации веса.',
          });
        }
        const keyed = await tx.defectBag.findUnique({
          where: { weighOperationKey: dto.operationKey },
        });
        if (keyed) {
          this.assertBagSession(keyed, lockedSession.id);
          if (round3(keyed.weightKg) !== weightKg || keyed.defectType !== defectType) {
            throw this.operationKeyReused();
          }
          return this.project(keyed, await this.latestPrintStatus(keyed.id, tx));
        }
        const post = await tx.post.findUnique({
          where: { id: lockedSession.postId },
          select: { code: true },
        });
        if (!post) {
          throw new ConflictException({
            code: 'DEFECT_BAG_POST_UNAVAILABLE',
            message: 'Пост смены больше недоступен.',
          });
        }
        const defects = await tx.defectRecord.findMany({
          where: {
            weightCapture: {
              postSessionId: lockedSession.id,
              kind: 'roll',
              stable: true,
              netKg: { not: null },
            },
          },
          select: { weightCapture: { select: { netKg: true } } },
        });
        const recordedDefectKg = round3(
          defects.reduce((sum, defect) => sum + (defect.weightCapture?.netKg ?? 0), 0),
        );
        if (
          !Number.isFinite(recordedDefectKg) ||
          recordedDefectKg < 0 ||
          recordedDefectKg > MAX_DEFECT_BAG_KG
        ) {
          throw new ConflictException({
            code: 'DEFECT_BAG_RECORDED_WEIGHT_INVALID',
            message: 'Зафиксированный вес брака смены некорректен.',
          });
        }
        const [codeSequence] = await tx.$queryRaw<Array<{ sequence: bigint }>>(
          Prisma.sql`SELECT nextval('defect_bag_code_sequence') AS "sequence"`,
        );
        if (!codeSequence) {
          throw new ServiceUnavailableException({
            code: 'DEFECT_BAG_CODE_UNAVAILABLE',
            message: 'Не удалось сформировать номер мешка брака.',
          });
        }
        const weighedAt = new Date();
        const bag = await tx.defectBag.create({
          data: {
            code: defectBagCode(weighedAt, post.code, codeSequence.sequence),
            postSessionId: lockedSession.id,
            status: 'weighed',
            defectType,
            weightKg,
            recordedDefectKg,
            differenceKg: round3(weightKg - recordedDefectKg),
            captureChannel: 'operator_manual',
            scaleDeviceId: null,
            scaleStatus: null,
            scaleStable: null,
            weighOperationKey: dto.operationKey,
            weighedAt,
            scanToken: weightKg > 0 ? { create: {} } : undefined,
          },
        });
        await this.audit.record(
          {
            type: 'audit:defect_bag_weighed',
            actorRole: actor.role,
            actorId,
            objectId: bag.id,
            detail: {
              code: bag.code,
              postId: lockedSession.postId,
              sessionId: lockedSession.id,
              captureChannel: 'operator_manual',
              defectType,
              weightKg: bag.weightKg,
              recordedDefectKg: bag.recordedDefectKg,
              differenceKg: bag.differenceKg,
            },
          },
          tx,
        );
        return this.project(bag, null);
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const concurrent = await this.prisma.defectBag.findUnique({
        where: { weighOperationKey: dto.operationKey },
      });
      if (
        concurrent?.postSessionId === session.id &&
        round3(concurrent.weightKg) === weightKg &&
        concurrent.defectType === defectType
      ) {
        return this.project(concurrent, await this.latestPrintStatus(concurrent.id, this.prisma));
      }
      if (concurrent) throw this.operationKeyReused();
      throw error;
    }
  }

  async print(actor: OperatorActor, dto: DefectBagPrintDto): Promise<OperatorShiftDefectBag> {
    const actorId = this.requireActorId(actor);
    const reason = dto.reason?.trim() || null;
    const claim = await this.prisma
      .$transaction(async (tx) => {
        const session = await this.sessions.lockActiveInTransaction(tx, actorId);
        const bags = await tx.defectBag.findMany({
          where: { postSessionId: session.id, ...(dto.defectBagId ? { id: dto.defectBagId } : {}) },
          include: { scanToken: true },
          take: 2,
        });
        if (bags.length > 1) {
          throw new ConflictException({
            code: 'DEFECT_BAG_SELECTION_REQUIRED',
            message:
              'Выберите мешок брака для печати этикетки. Если выбора нет, обновите страницу.',
          });
        }
        const bag = bags[0];
        if (!bag) throw this.bagRequired();
        if (bag.weightKg === 0) {
          throw new ConflictException({
            code: 'DEFECT_BAG_ZERO_WEIGHT_NO_PRINT',
            message: 'При нулевом весе брака QR не печатается. Сдайте смену.',
          });
        }

        const keyed = await tx.defectBagLabelPrintJob.findUnique({
          where: { operationKey: dto.operationKey },
        });
        if (keyed) {
          if (
            keyed.defectBagId !== bag.id ||
            keyed.actorId !== actorId ||
            (keyed.reason ?? null) !== reason
          ) {
            throw this.operationKeyReused();
          }
          if (keyed.status === 'submitted') {
            return { kind: 'replay' as const, result: this.project(bag, keyed.status) };
          }
          if (keyed.status === 'failed') return { kind: 'failed' as const };
          if (keyed.status === 'delivery_unknown') return { kind: 'unknown' as const };
          if (keyed.leaseExpiresAt > new Date()) throw this.printInProgress();
          await tx.defectBagLabelPrintJob.update({
            where: { id: keyed.id },
            data: {
              status: 'delivery_unknown',
              failureReason: 'printer_delivery_outcome_unknown',
              completedAt: new Date(),
            },
          });
          await this.recordPrintOutcome(
            tx,
            actor,
            bag,
            keyed.id,
            session,
            keyed.printerId,
            'delivery_unknown',
          );
          return { kind: 'unknown' as const };
        }

        const previous = await tx.defectBagLabelPrintJob.findFirst({
          where: { defectBagId: bag.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (previous?.status === 'queued' && previous.leaseExpiresAt > new Date()) {
          throw this.printInProgress();
        }
        if (previous?.status === 'delivery_unknown') return { kind: 'unknown' as const };
        if (previous && !reason) {
          throw new BadRequestException({
            code: 'DEFECT_BAG_REPRINT_REASON_REQUIRED',
            message: 'Для повторной печати укажите фактическую причину.',
          });
        }
        if (previous?.status === 'queued') {
          await tx.defectBagLabelPrintJob.update({
            where: { id: previous.id },
            data: {
              status: 'delivery_unknown',
              failureReason: 'printer_delivery_outcome_unknown',
              completedAt: new Date(),
            },
          });
          await this.recordPrintOutcome(
            tx,
            actor,
            bag,
            previous.id,
            session,
            previous.printerId,
            'delivery_unknown',
          );
          return { kind: 'unknown' as const };
        }
        const device = await this.bindings.resolve(session.postId, 'printer', tx);
        if (!bag.scanToken || !isBigBagScanToken(bag.scanToken.token)) {
          throw new ConflictException({
            code: 'DEFECT_BAG_QR_UNAVAILABLE',
            message: 'Внутренний QR-идентификатор мешка недоступен.',
          });
        }
        const leaseToken = randomUUID();
        const job = await tx.defectBagLabelPrintJob.create({
          data: {
            operationKey: dto.operationKey,
            defectBagId: bag.id,
            printerId: device.id,
            status: 'queued',
            reason,
            replacesJobId: previous?.id ?? null,
            actorId,
            postSessionId: session.id,
            postId: session.postId,
            leaseToken,
            leaseExpiresAt: new Date(Date.now() + PRINT_LEASE_MS),
          },
        });
        await this.audit.record(
          {
            type: previous
              ? 'audit:defect_bag_label_reprint_requested'
              : 'audit:defect_bag_label_print_requested',
            actorRole: actor.role,
            actorId,
            objectId: bag.id,
            reason: reason ?? undefined,
            detail: {
              code: bag.code,
              jobId: job.id,
              deviceId: device.id,
              postId: session.postId,
              sessionId: session.id,
              defectType: this.projectDefectType(bag.defectType),
            },
          },
          tx,
        );
        return {
          kind: 'claimed' as const,
          bag,
          jobId: job.id,
          leaseToken,
          postId: session.postId,
          sessionId: session.id,
          deviceId: device.id,
          qrCode: bag.scanToken.token,
        } satisfies PrintClaim;
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw this.operationKeyReused();
        }
        throw error;
      });

    if (claim.kind === 'replay') return claim.result;
    if (claim.kind === 'failed') throw this.printFailed();
    if (claim.kind === 'unknown') throw this.printDeliveryUnknown();

    let result: Awaited<ReturnType<PrinterAdapter['print']>>;
    try {
      result = await this.printer.print(
        {
          deviceId: claim.deviceId,
          expectedPostId: claim.postId,
          expectedKind: 'printer',
        },
        {
          kind: 'big_bag_label',
          destination: 'operator',
          bigBagCode: claim.bag.code,
          material: `БРАК · ${this.defectTypeLabel(claim.bag.defectType)} · ${claim.bag.weightKg.toFixed(3)} кг`,
          qrCode: claim.qrCode,
        },
      );
    } catch {
      await this.settlePrint(actor, claim, 'delivery_unknown', null);
      throw this.printDeliveryUnknown();
    }
    const gatewayCommandId = result.gatewayCommandId ?? result.jobId ?? null;

    if (result.status === 'failed') {
      await this.settlePrint(actor, claim, 'failed', gatewayCommandId);
      throw this.printFailed();
    }
    if (
      !['printed', 'submitted'].includes(String(result.status)) ||
      result.printerId !== claim.deviceId
    ) {
      await this.settlePrint(actor, claim, 'delivery_unknown', gatewayCommandId);
      throw this.printDeliveryUnknown();
    }

    try {
      const projected = await this.prisma.$transaction(async (tx) => {
        const session = await this.sessions.lockActiveInTransaction(tx, actorId);
        if (session.id !== claim.sessionId || session.postId !== claim.postId) return null;
        const device = await this.bindings.resolve(session.postId, 'printer', tx);
        if (device.id !== claim.deviceId) return null;
        const finalized = await tx.defectBagLabelPrintJob.updateMany({
          where: { id: claim.jobId, status: 'queued', leaseToken: claim.leaseToken },
          data: {
            status: 'submitted',
            gatewayCommandId,
            failureReason: null,
            completedAt: new Date(),
          },
        });
        if (finalized.count !== 1) return null;
        const current = await tx.defectBag.findUnique({ where: { id: claim.bag.id } });
        if (!current) return null;
        const bag =
          current.status === 'weighed'
            ? await tx.defectBag.update({
                where: { id: current.id },
                data: { status: 'ready_for_warehouse' },
              })
            : current;
        await this.recordPrintOutcome(
          tx,
          actor,
          bag,
          claim.jobId,
          session,
          claim.deviceId,
          'submitted',
        );
        return this.project(bag, 'submitted');
      });
      if (projected) return projected;
    } catch {
      // The adapter acknowledged a physical print, so a failed finalization is ambiguous.
    }
    await this.settlePrint(actor, claim, 'delivery_unknown', gatewayCommandId);
    throw this.printDeliveryUnknown();
  }

  private async settlePrint(
    actor: OperatorActor,
    claim: PrintClaim,
    status: 'failed' | 'delivery_unknown',
    gatewayCommandId: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const settled = await tx.defectBagLabelPrintJob.updateMany({
        where: { id: claim.jobId, status: 'queued', leaseToken: claim.leaseToken },
        data: {
          status,
          gatewayCommandId,
          failureReason:
            status === 'failed' ? 'printer_failed' : 'printer_delivery_outcome_unknown',
          completedAt: new Date(),
        },
      });
      if (settled.count !== 1) return;
      await this.recordPrintOutcome(
        tx,
        actor,
        claim.bag,
        claim.jobId,
        { id: claim.sessionId, postId: claim.postId },
        claim.deviceId,
        status,
      );
    });
  }

  private recordPrintOutcome(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    bag: SafeBagRow,
    jobId: string,
    session: { id: string; postId: string },
    deviceId: string,
    status: 'submitted' | 'failed' | 'delivery_unknown',
  ) {
    const event =
      status === 'submitted'
        ? 'audit:defect_bag_label_print_submitted'
        : status === 'failed'
          ? 'audit:defect_bag_label_print_failed'
          : 'audit:defect_bag_label_print_delivery_unknown';
    return this.audit.record(
      {
        type: event,
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: bag.id,
        detail: {
          code: bag.code,
          jobId,
          deviceId,
          postId: session.postId,
          sessionId: session.id,
          status,
          defectType: this.projectDefectType(bag.defectType),
        },
      },
      tx,
    );
  }

  private async latestPrintStatus(
    defectBagId: string,
    client: Pick<Prisma.TransactionClient, 'defectBagLabelPrintJob'>,
  ): Promise<string | null> {
    const job = await client.defectBagLabelPrintJob.findFirst({
      where: { defectBagId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true },
    });
    return job?.status ?? null;
  }

  private project(bag: SafeBagRow, printStatus: string | null): OperatorShiftDefectBag {
    const labelState = ['submitted', 'failed', 'delivery_unknown'].includes(printStatus ?? '')
      ? (printStatus as OperatorShiftDefectBag['labelState'])
      : 'not_printed';
    return {
      id: bag.id,
      code: bag.code,
      status: bag.status as OperatorShiftDefectBag['status'],
      defectType: this.projectDefectType(bag.defectType),
      weightKg: bag.weightKg,
      recordedDefectKg: bag.recordedDefectKg,
      differenceKg: bag.differenceKg,
      labelState,
      weighedAt: bag.weighedAt.toISOString(),
    };
  }

  private manualWeight(value: number): number {
    if (!Number.isFinite(value) || value < 0 || value > MAX_DEFECT_BAG_KG) {
      throw new BadRequestException({
        code: 'DEFECT_BAG_WEIGHT_INVALID',
        message: 'Вес мешка брака должен быть от 0 до 10000 кг.',
      });
    }
    return round3(value);
  }

  private requireDefectType(value: unknown): DefectBagType {
    if (!DEFECT_BAG_TYPES.includes(value as DefectBagType)) {
      throw new BadRequestException({
        code: 'DEFECT_BAG_TYPE_INVALID',
        message: 'Выберите тип брака.',
      });
    }
    return value as DefectBagType;
  }

  private projectDefectType(value: string | null): DefectBagType | null {
    return DEFECT_BAG_TYPES.includes(value as DefectBagType) ? (value as DefectBagType) : null;
  }

  private defectTypeLabel(value: string | null): string {
    const type = this.projectDefectType(value);
    return type ? DEFECT_BAG_TYPE_LABELS[type] : 'Не указан';
  }

  private assertBagSession(bag: { postSessionId: string }, sessionId: string): void {
    if (bag.postSessionId !== sessionId) {
      throw this.operationKeyReused();
    }
  }

  private requireActorId(actor: OperatorActor): string {
    if (!actor.userId) {
      throw new UnauthorizedException({
        code: 'DEFECT_BAG_ACTOR_REQUIRED',
        message: 'Для работы с браком нужна полная сессия оператора.',
      });
    }
    return actor.userId;
  }

  private bagRequired() {
    return new ConflictException({
      code: 'DEFECT_BAG_REQUIRED',
      message: 'Сначала взвесьте мешок брака.',
    });
  }

  private printInProgress() {
    return new ConflictException({
      code: 'DEFECT_BAG_PRINT_IN_PROGRESS',
      message: 'Печать этикетки уже выполняется.',
    });
  }

  private printFailed() {
    return new ServiceUnavailableException({
      code: 'DEFECT_BAG_PRINT_FAILED',
      message: 'Принтер не подтвердил печать этикетки.',
    });
  }

  private printDeliveryUnknown() {
    return new ConflictException({
      code: 'DEFECT_BAG_PRINT_DELIVERY_UNKNOWN',
      message: 'Исход печати неизвестен. Проверьте принтер перед повтором.',
    });
  }

  private operationKeyReused() {
    return new ConflictException({
      code: 'DEFECT_BAG_OPERATION_KEY_REUSED',
      message: 'UUID операции уже использован для другого запроса.',
    });
  }
}
