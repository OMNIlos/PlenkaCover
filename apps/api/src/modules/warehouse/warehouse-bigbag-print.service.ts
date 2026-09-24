import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type BigBagLabelPrintJob } from '@prisma/client';
import type { BigBagLabelPrintView, Role, WarehousePrinterView } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PostDeviceReadinessService } from '../../common/device-readiness/post-device-readiness.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PRINTER_ADAPTER, type PrinterAdapter } from '../../integrations/printer/printer.adapter';
import type { PrintBigBagLabelDto } from './dto/bigbag-print.dto';
import { PalletPrintService } from './pallet-print.service';

type BigBagPrintActor = {
  userId: string | null;
  role: Role;
};

type PrintBag = {
  id: string;
  code: string;
  material: string;
  scanToken: { token: string } | null;
};

const normalizedReason = (reason: string | undefined): string | null => {
  if (reason === undefined) return null;
  const value = reason.replace(/\s+/gu, ' ').trim();
  return value.length > 0 ? value : null;
};

const safeFailureReason = (value: unknown): string =>
  (value instanceof Error ? value.message : String(value ?? 'print failed'))
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500) || 'print failed';

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class WarehouseBigBagPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PRINTER_ADAPTER) private readonly printer: PrinterAdapter,
    private readonly printerDiscovery: PalletPrintService,
    private readonly deviceReadiness: PostDeviceReadinessService,
  ) {}

  async listPrinters(now = new Date()): Promise<WarehousePrinterView[]> {
    const candidates = await this.printerDiscovery.listPrinters(now);
    return Promise.all(
      candidates.map(async (candidate) => {
        const readiness = await this.deviceReadiness.check(
          candidate.post.id,
          'warehouse.big-bag.print',
          this.prisma,
          now,
        );
        const exactDeviceReady =
          readiness.ready &&
          readiness.devices.some(
            (device) => device.id === candidate.id && device.kind === 'printer',
          );
        const ready = candidate.ready && exactDeviceReady;
        return {
          ...candidate,
          ready,
          unavailableReason: ready
            ? null
            : !candidate.ready
              ? candidate.unavailableReason
              : readiness.ready
                ? 'Выбранный принтер не является готовым устройством поста.'
                : readiness.message,
        };
      }),
    );
  }

  async print(
    actor: BigBagPrintActor,
    bigBagId: string,
    dto: PrintBigBagLabelDto,
    now = new Date(),
  ): Promise<BigBagLabelPrintView> {
    const existing = await this.prisma.bigBagLabelPrintJob.findUnique({
      where: { requestId: dto.requestId },
    });
    if (existing) return this.existing(existing, bigBagId, dto.printerId);
    if (this.printer.transport !== 'gateway') {
      throw new ServiceUnavailableException({
        code: 'WAREHOUSE_GATEWAY_PRINT_DISABLED',
        message: 'Печать через Device Gateway не включена на сервере.',
      });
    }

    const bag = await this.prisma.bigBagUnit.findUnique({
      where: { id: bigBagId },
      select: {
        id: true,
        code: true,
        material: true,
        scanToken: { select: { token: true } },
      },
    });
    if (!bag) {
      throw new NotFoundException({ code: 'BIGBAG_NOT_FOUND', message: 'Big-Bag не найден.' });
    }
    if (!bag.scanToken) {
      throw new ConflictException({
        code: 'BIGBAG_QR_NOT_CREATED',
        message: 'Для Big-Bag ещё не создан QR-код.',
      });
    }

    const availablePrinters = await this.listPrinters(now);
    const selectedPrinter = availablePrinters.find((candidate) => candidate.id === dto.printerId);
    if (!selectedPrinter) {
      throw new NotFoundException({
        code: 'WAREHOUSE_PRINTER_NOT_FOUND',
        message: 'Принтер не найден.',
      });
    }
    if (!selectedPrinter.ready) {
      throw new ServiceUnavailableException({
        code: 'WAREHOUSE_PRINTER_UNAVAILABLE',
        message: selectedPrinter.unavailableReason ?? 'Принтер недоступен.',
      });
    }

    const claim = await this.claim(actor, bag, dto);
    if (!claim.created) return this.existing(claim.job, bigBagId, dto.printerId);

    let physicalResult: Awaited<ReturnType<PrinterAdapter['print']>>;
    try {
      physicalResult = await this.printer.print(
        {
          deviceId: dto.printerId,
          expectedPostId: selectedPrinter.post.id,
          expectedKind: 'printer',
        },
        {
          kind: 'big_bag_label',
          destination: 'warehouse',
          bigBagCode: bag.code,
          material: bag.material,
          qrCode: bag.scanToken.token,
        },
      );
    } catch (error) {
      physicalResult = {
        jobId: '',
        printerId: dto.printerId,
        status: 'delivery_unknown',
        failureReason: safeFailureReason(error),
      };
    }

    const status =
      physicalResult.status === 'printed' || physicalResult.status === 'submitted'
        ? 'submitted'
        : physicalResult.status === 'delivery_unknown'
          ? 'uncertain'
          : 'failed';
    const failureReason =
      status === 'submitted' ? null : safeFailureReason(physicalResult.failureReason);
    const updated = await this.prisma.$transaction(async (tx) => {
      const job = await tx.bigBagLabelPrintJob.update({
        where: { id: claim.job.id },
        data: {
          status,
          failureReason,
          gatewayCommandId: physicalResult.gatewayCommandId ?? null,
        },
      });
      await this.audit.record(
        {
          type:
            status === 'submitted'
              ? 'audit:bigbag_label_print_submitted'
              : status === 'uncertain'
                ? 'audit:bigbag_label_print_delivery_unknown'
                : 'audit:bigbag_label_print_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: bag.code,
          reason: failureReason ?? undefined,
          detail: {
            channel: 'gateway',
            printJobId: job.id,
            printerId: job.printerId,
            status,
            gatewayCommandId: job.gatewayCommandId,
          },
        },
        tx,
      );
      return job;
    });
    return this.project(updated);
  }

  private async claim(
    actor: BigBagPrintActor,
    bag: PrintBag,
    dto: PrintBigBagLabelDto,
  ): Promise<{ job: BigBagLabelPrintJob; created: boolean }> {
    const reason = normalizedReason(dto.reason);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "big_bag_units" WHERE "id" = ${bag.id} FOR UPDATE`,
        );
        const replay = await tx.bigBagLabelPrintJob.findUnique({
          where: { requestId: dto.requestId },
        });
        if (replay) return { job: replay, created: false };

        const uncertain = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId: bag.id, status: 'uncertain' },
          orderBy: { createdAt: 'desc' },
        });
        if (uncertain) {
          throw new ConflictException({
            code: 'BIGBAG_PRINT_OUTCOME_UNCERTAIN',
            message: 'Результат прошлой печати не подтверждён. Проверьте этикетку перед повтором.',
            printJobId: uncertain.id,
          });
        }
        const active = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId: bag.id, status: 'queued' },
          orderBy: { createdAt: 'desc' },
        });
        if (active) {
          throw new ConflictException({
            code: 'BIGBAG_PRINT_IN_PROGRESS',
            message: 'Предыдущее задание печати ещё выполняется.',
            printJobId: active.id,
          });
        }
        const predecessor = await tx.bigBagLabelPrintJob.findFirst({
          where: { bigBagId: bag.id, status: { in: ['submitted', 'intent_recorded'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (predecessor && (!reason || reason.length < 3 || reason.length > 500)) {
          throw new ConflictException('Для повторной печати укажите причину от 3 до 500 символов.');
        }

        const job = await tx.bigBagLabelPrintJob.create({
          data: {
            requestId: dto.requestId,
            bigBagId: bag.id,
            printerId: dto.printerId,
            channel: 'gateway',
            status: 'queued',
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
              channel: 'gateway',
              bigBagId: bag.id,
              printJobId: job.id,
              printerId: job.printerId,
              replacesPrintJobId: job.replacesPrintJobId,
            },
          },
          tx,
        );
        return { job, created: true };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.prisma.bigBagLabelPrintJob.findUnique({
        where: { requestId: dto.requestId },
      });
      if (!replay) throw error;
      return { job: replay, created: false };
    }
  }

  private existing(
    job: BigBagLabelPrintJob,
    bigBagId: string,
    printerId: string,
  ): BigBagLabelPrintView {
    if (job.bigBagId !== bigBagId || job.printerId !== printerId || job.channel !== 'gateway') {
      throw new ConflictException({
        code: 'BIGBAG_PRINT_REQUEST_ID_CONFLICT',
        message: 'Этот requestId уже использован для другой печати.',
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
