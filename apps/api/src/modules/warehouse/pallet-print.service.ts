import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type PalletPrintJob } from '@prisma/client';
import {
  PALLET_LABEL_PROFILE,
  type PalletLabelProfile,
  type PalletListPayload,
  type WarehousePrinterView,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { gatewayHeartbeatIsFresh } from '../../common/gateway-liveness';
import {
  deviceConnectionFingerprint,
  deviceConnectionIncident,
  gatewayCommandIncident,
  postLivenessFingerprint,
  postLivenessIncident,
} from '../../common/operational-incidents/device-incident-signals';
import { OperationalIncidentReporter } from '../../common/operational-incidents/operational-incident-reporter.service';
import { PalletTokenService } from '../../common/pallet-token/pallet-token.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  normalizePrintDeliveryUnknownReason,
  PRINTER_ADAPTER,
  type PrinterAdapter,
} from '../../integrations/printer/printer.adapter';
import type { PrintPalletListDto } from './dto/pallet-print.dto';
import { PalletLabelRenderer } from './pallet-label.renderer';
import {
  immutablePalletLabelProfile,
  isBrowserOnlyPalletLabelProfile,
} from './pallet-label-snapshot';
import type { WarehouseIntakeActor } from './warehouse-intake.service';

const WAREHOUSE_PRINTER_SELECT = {
  id: true,
  code: true,
  label: true,
  kind: true,
  connectionKind: true,
  isEnabled: true,
  status: true,
  lastSeenAt: true,
  post: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      agentStatus: true,
      lastSeenAt: true,
    },
  },
} as const;

type PrinterRow = Prisma.DeviceRuntimeGetPayload<{ select: typeof WAREHOUSE_PRINTER_SELECT }>;

export type PalletPrintResponse = {
  id: string;
  requestId: string;
  printerId: string;
  status: 'queued' | 'submitted';
  gatewayCommandId: string | null;
  message: 'Задание отправлено' | 'Задание уже выполняется';
};

type PrintDocument = {
  id: string;
  palletId: string;
  payload: unknown;
  voidedAt: Date | null;
};

type ClaimedJob = { job: PalletPrintJob; created: boolean; document: PrintDocument };

const PRINT_DOCUMENT_SELECT = {
  id: true,
  palletId: true,
  payload: true,
  voidedAt: true,
} satisfies Prisma.PalletListDocumentSelect;

const GATEWAY_PRINT_DISABLED_REASON = 'Печать через Device Gateway не включена на сервере';

function assertGatewayPrintableProfile(document: PrintDocument): void {
  const profile = immutablePalletLabelProfile(document.payload);
  if (!profile || !isBrowserOnlyPalletLabelProfile(profile)) return;
  throw new ConflictException({
    code: 'PALLET_LABEL_BROWSER_PRINT_ONLY',
    message: 'Квадратный палетный лист печатается из браузера рабочего места.',
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function printPayloadOf(document: PrintDocument): {
  payload: PalletListPayload;
  templateVersion: PalletLabelProfile;
} {
  const payload = asRecord(document.payload);
  const templateVersion = immutablePalletLabelProfile(document.payload);
  if (payload?.printReady !== true || !templateVersion) {
    throw new ConflictException(
      `Pallet list ${document.id} has no print-ready immutable pallet label snapshot`,
    );
  }
  assertGatewayPrintableProfile(document);
  return {
    payload: payload as unknown as PalletListPayload,
    templateVersion: templateVersion as PalletLabelProfile,
  };
}

function normalizedReason(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  const value = reason.replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value : null;
}

function safeFailureReason(reason: unknown): string {
  const value = reason instanceof Error ? reason.message : String(reason ?? 'print failed');
  return (
    value
      .replace(/bitmapBase64\s*[:=]\s*\S+/gi, '[binary omitted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'print failed'
  );
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function readinessOf(
  printer: PrinterRow,
  now: Date,
): {
  ready: boolean;
  unavailableReason: string | null;
} {
  if (printer.kind !== 'printer') {
    return { ready: false, unavailableReason: 'Устройство не является принтером' };
  }
  if (!printer.isEnabled) return { ready: false, unavailableReason: 'Принтер отключён' };
  if (!printer.post) return { ready: false, unavailableReason: 'Принтер не привязан к посту' };
  if (printer.post.status !== 'active') {
    return { ready: false, unavailableReason: 'Пост отключён' };
  }
  if (printer.status !== 'ready') {
    return { ready: false, unavailableReason: `Статус принтера: ${printer.status}` };
  }
  if (printer.post.agentStatus !== 'online') {
    return { ready: false, unavailableReason: 'Gateway поста не в сети' };
  }
  if (!gatewayHeartbeatIsFresh(printer.post.lastSeenAt, now)) {
    return { ready: false, unavailableReason: 'Нет свежего heartbeat от gateway' };
  }
  return { ready: true, unavailableReason: null };
}

/** Warehouse-safe printer discovery and idempotent direct pallet-label submission. */
@Injectable()
export class PalletPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PRINTER_ADAPTER) private readonly printer: PrinterAdapter,
    private readonly renderer: PalletLabelRenderer,
    private readonly palletTokens: PalletTokenService,
    private readonly incidents: OperationalIncidentReporter,
  ) {}

  async listPrinters(now = new Date()): Promise<WarehousePrinterView[]> {
    const printers = await this.prisma.deviceRuntime.findMany({
      where: { kind: 'printer', postId: { not: null } },
      select: WAREHOUSE_PRINTER_SELECT,
      orderBy: [{ post: { code: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
    });
    return printers.flatMap((printer) => {
      if (!printer.post) return [];
      const readiness =
        this.printer.transport === 'gateway'
          ? readinessOf(printer, now)
          : { ready: false, unavailableReason: GATEWAY_PRINT_DISABLED_REASON };
      return [
        {
          id: printer.id,
          code: printer.code,
          label: printer.label?.trim() || printer.code || printer.id,
          post: {
            id: printer.post.id,
            code: printer.post.code,
            name: printer.post.name,
          },
          status: printer.status,
          ...readiness,
        },
      ];
    });
  }

  async print(
    actor: WarehouseIntakeActor,
    documentId: string,
    dto: PrintPalletListDto,
    now = new Date(),
  ): Promise<PalletPrintResponse> {
    const document = await this.prisma.palletListDocument.findUnique({
      where: { id: documentId },
      select: PRINT_DOCUMENT_SELECT,
    });
    if (!document) throw new NotFoundException(`Pallet list ${documentId} not found`);
    this.assertDocumentActive(document);
    assertGatewayPrintableProfile(document);

    const existing = await this.prisma.palletPrintJob.findUnique({
      where: { requestId: dto.requestId },
    });
    if (existing) return this.existingResponse(existing, documentId, dto.printerId);
    if (this.printer.transport !== 'gateway') {
      throw new ServiceUnavailableException({
        code: 'WAREHOUSE_GATEWAY_PRINT_DISABLED',
        message: GATEWAY_PRINT_DISABLED_REASON,
      });
    }

    const printer = await this.prisma.deviceRuntime.findUnique({
      where: { id: dto.printerId },
      select: WAREHOUSE_PRINTER_SELECT,
    });
    if (!printer || printer.kind !== 'printer') {
      throw new NotFoundException(`Printer ${dto.printerId} not found`);
    }
    printPayloadOf(document);
    const readiness = readinessOf(printer, now);
    if (!readiness.ready) {
      await this.reportUnavailablePrinter(printer, now);
      throw new ServiceUnavailableException({
        code: 'WAREHOUSE_PRINTER_UNAVAILABLE',
        message: readiness.unavailableReason,
      });
    }

    const claim = await this.claim(actor, document, dto);
    if (!claim.created) return this.existingResponse(claim.job, documentId, dto.printerId);
    const printPayload = printPayloadOf(claim.document);

    let bitmap: Buffer;
    try {
      const { token } = await this.palletTokens.requireForDocument(claim.document.id);
      ({ bitmap } = this.renderer.renderPalletLabel(
        printPayload.payload.label,
        token,
        printPayload.templateVersion,
      ));
    } catch (error) {
      return this.fail(actor, document, claim.job, error, null, false);
    }

    let result: Awaited<ReturnType<PrinterAdapter['print']>>;
    try {
      result = await this.printer.print(
        {
          deviceId: dto.printerId,
          expectedPostId: printer.post!.id,
          expectedKind: 'printer',
        },
        {
          kind: 'pallet_label',
          documentId,
          templateVersion: printPayload.templateVersion,
          widthMm: PALLET_LABEL_PROFILE.widthMm,
          heightMm: PALLET_LABEL_PROFILE.heightMm,
          dpi: PALLET_LABEL_PROFILE.dpi,
          widthDots: PALLET_LABEL_PROFILE.widthDots,
          heightDots: PALLET_LABEL_PROFILE.heightDots,
          bitmapBase64: bitmap.toString('base64'),
          copies: PALLET_LABEL_PROFILE.copies,
        },
      );
    } catch {
      return this.deliveryUnknown(
        actor,
        document,
        claim.job,
        {
          jobId: '',
          printerId: dto.printerId,
          status: 'delivery_unknown',
          failureReason: 'printer_adapter_rejection_outcome_unknown',
        },
        printer.post!.id,
      );
    }
    if (!['printed', 'submitted', 'failed', 'delivery_unknown'].includes(result.status)) {
      return this.deliveryUnknown(
        actor,
        document,
        claim.job,
        {
          ...result,
          status: 'delivery_unknown',
          failureReason: 'printer_result_status_unknown',
        },
        printer.post!.id,
      );
    }
    if (result.status === 'delivery_unknown') {
      return this.deliveryUnknown(actor, document, claim.job, result, printer.post!.id);
    }
    if (result.status === 'failed') {
      return this.fail(
        actor,
        document,
        claim.job,
        result.failureReason,
        result.gatewayCommandId ?? null,
        true,
      );
    }

    const completedAt = new Date();
    let updated: PalletPrintJob;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const job = await tx.palletPrintJob.update({
          where: { id: claim.job.id },
          data: {
            status: 'submitted',
            gatewayCommandId: result.gatewayCommandId ?? null,
            completedAt,
          },
        });
        await this.audit.record(
          {
            type: 'audit:pallet_list_print_submitted',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: document.id,
            detail: this.auditDetail(document, job),
          },
          tx,
        );
        return job;
      });
    } catch {
      return this.deliveryUnknown(
        actor,
        document,
        claim.job,
        {
          ...result,
          status: 'delivery_unknown',
          failureReason: 'pallet_finalization_conflict_after_acknowledged_print',
        },
        printer.post!.id,
      );
    }
    await Promise.all([
      this.incidents.resolve(
        deviceConnectionFingerprint(dto.printerId),
        'Pallet printer operation succeeded.',
      ),
      this.incidents.resolve(
        postLivenessFingerprint(printer.post!.id),
        'Pallet printer gateway operation succeeded.',
      ),
    ]);
    return this.response(updated, 'submitted');
  }

  private async claim(
    actor: WarehouseIntakeActor,
    document: PrintDocument,
    dto: PrintPalletListDto,
  ): Promise<ClaimedJob> {
    const reason = normalizedReason(dto.reason);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "pallet_list_documents" WHERE "id" = ${document.id} FOR UPDATE`,
        );
        const lockedDocument = await tx.palletListDocument.findUnique({
          where: { id: document.id },
          select: PRINT_DOCUMENT_SELECT,
        });
        if (!lockedDocument) throw new NotFoundException(`Pallet list ${document.id} not found`);
        this.assertDocumentActive(lockedDocument);
        printPayloadOf(lockedDocument);

        const existing = await tx.palletPrintJob.findUnique({
          where: { requestId: dto.requestId },
        });
        if (existing) return { job: existing, created: false, document: lockedDocument };

        const uncertain = await tx.palletPrintJob.findFirst({
          where: { palletListDocumentId: document.id, status: 'delivery_unknown' },
          orderBy: { createdAt: 'desc' },
        });
        if (uncertain) throw this.deliveryUnknownException(uncertain);

        const active = await tx.palletPrintJob.findFirst({
          where: { palletListDocumentId: document.id, status: 'queued' },
          orderBy: { createdAt: 'desc' },
        });
        if (active) {
          throw new ConflictException({
            code: 'PALLET_PRINT_IN_PROGRESS',
            message: 'Предыдущее задание печати ещё выполняется.',
            printJobId: active.id,
          });
        }

        const predecessor = await tx.palletPrintJob.findFirst({
          where: { palletListDocumentId: document.id, status: 'submitted' },
          orderBy: { createdAt: 'desc' },
        });
        if (predecessor && (!reason || reason.length < 3 || reason.length > 500)) {
          throw new ConflictException('Для повторной печати укажите причину от 3 до 500 символов.');
        }
        const job = await tx.palletPrintJob.create({
          data: {
            palletListDocumentId: document.id,
            requestId: dto.requestId,
            printerId: dto.printerId,
            gatewayCommandId: null,
            status: 'queued',
            failureReason: null,
            reason: predecessor ? reason : null,
            replacesJobId: predecessor?.id ?? null,
          },
        });
        await this.audit.record(
          {
            type: predecessor
              ? 'audit:pallet_list_reprint_requested'
              : 'audit:pallet_list_print_requested',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: document.id,
            reason: predecessor ? (reason ?? undefined) : undefined,
            detail: this.auditDetail(document, job),
          },
          tx,
        );
        return { job, created: true, document: lockedDocument };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.palletPrintJob.findUnique({
        where: { requestId: dto.requestId },
      });
      if (!existing) throw error;
      return { job: existing, created: false, document };
    }
  }

  private assertDocumentActive(document: PrintDocument): void {
    if (!document.voidedAt) return;
    throw new ConflictException({
      code: 'PALLET_PRINT_DOCUMENT_VOIDED',
      message: 'Аннулированный палетный лист нельзя печатать повторно.',
      documentId: document.id,
    });
  }

  private existingResponse(
    job: PalletPrintJob,
    documentId: string,
    printerId: string,
  ): PalletPrintResponse {
    if (job.palletListDocumentId !== documentId || job.printerId !== printerId) {
      throw new ConflictException('Idempotency key is already used for another print request.');
    }
    if (job.status === 'submitted') return this.response(job, 'submitted');
    if (job.status === 'queued') return this.response(job, 'queued');
    if (job.status === 'delivery_unknown') throw this.deliveryUnknownException(job);
    throw new ServiceUnavailableException({
      code: 'PALLET_PRINT_FAILED',
      message: job.failureReason ?? 'print failed',
      printJobId: job.id,
    });
  }

  private response(job: PalletPrintJob, status: 'queued' | 'submitted'): PalletPrintResponse {
    return {
      id: job.id,
      requestId: job.requestId,
      printerId: job.printerId,
      status,
      gatewayCommandId: job.gatewayCommandId,
      message: status === 'submitted' ? 'Задание отправлено' : 'Задание уже выполняется',
    };
  }

  private async fail(
    actor: WarehouseIntakeActor,
    document: PrintDocument,
    job: PalletPrintJob,
    reason: unknown,
    gatewayCommandId: string | null,
    reportDevice: boolean,
  ): Promise<never> {
    const failureReason = safeFailureReason(reason);
    const completedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.palletPrintJob.update({
        where: { id: job.id },
        data: { status: 'failed', gatewayCommandId, failureReason, completedAt },
      });
      await this.audit.record(
        {
          type: 'audit:pallet_list_print_failed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: document.id,
          reason: failureReason,
          detail: this.auditDetail(document, failed),
        },
        tx,
      );
    });
    if (reportDevice) {
      await this.incidents.signal(deviceConnectionIncident(job.printerId, 'printer'));
    }
    throw new ServiceUnavailableException({
      code: 'PALLET_PRINT_FAILED',
      message: failureReason,
      printJobId: job.id,
    });
  }

  private async deliveryUnknown(
    actor: WarehouseIntakeActor,
    document: PrintDocument,
    job: PalletPrintJob,
    result: Awaited<ReturnType<PrinterAdapter['print']>>,
    postId: string,
  ): Promise<never> {
    const failureReason = normalizePrintDeliveryUnknownReason(result.failureReason);
    const gatewayCommandId = result.gatewayCommandId ?? null;
    const completedAt = new Date();
    const uncertain = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.palletPrintJob.update({
        where: { id: job.id },
        data: {
          status: 'delivery_unknown',
          gatewayCommandId,
          failureReason,
          completedAt,
        },
      });
      await this.audit.record(
        {
          type: 'audit:pallet_list_print_delivery_unknown',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: document.id,
          reason: failureReason,
          detail: this.auditDetail(document, updated),
        },
        tx,
      );
      return updated;
    });
    await this.incidents.signal(gatewayCommandIncident(postId, 'print_delivery_unknown'));
    throw this.deliveryUnknownException(uncertain);
  }

  private deliveryUnknownException(job: PalletPrintJob) {
    return new ConflictException({
      code: 'PALLET_PRINT_DELIVERY_UNKNOWN',
      message: 'Принтер подтвердил задание, но итог требует проверки администратором.',
      printJobId: job.id,
      gatewayCommandId: job.gatewayCommandId,
    });
  }

  private async reportUnavailablePrinter(printer: PrinterRow, now: Date): Promise<void> {
    if (!printer.isEnabled) return;
    if (!printer.post) {
      await this.incidents.signal(deviceConnectionIncident(printer.id, 'printer'));
      return;
    }
    if (printer.post.status !== 'active') return;
    if (
      printer.post.agentStatus !== 'online' ||
      !gatewayHeartbeatIsFresh(printer.post.lastSeenAt, now)
    ) {
      await this.incidents.signal(postLivenessIncident(printer.post.id));
      return;
    }
    if (printer.status !== 'ready') {
      await this.incidents.signal(deviceConnectionIncident(printer.id, 'printer'));
    }
  }

  private auditDetail(document: PrintDocument, job: PalletPrintJob): Prisma.InputJsonObject {
    return {
      palletId: document.palletId,
      printerId: job.printerId,
      printJobId: job.id,
      gatewayCommandId: job.gatewayCommandId,
      replacesJobId: job.replacesJobId,
      status: job.status,
    };
  }
}
