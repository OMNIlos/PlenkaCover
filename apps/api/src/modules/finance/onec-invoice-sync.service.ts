import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  oneCOrderReference,
  type OneCInvoiceSnapshot,
  type OneCInvoiceSyncState,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { lockInvoiceBoundaryForFinanceOrder } from '../../common/invoice-boundary/commercial-invoice-boundary';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { ONEC_ADAPTER, type OneCAdapter } from '../../integrations/onec/onec.adapter';
import type { InvoiceLinkDto } from './dto/invoice-link.dto';
import type { SourceRetryDto } from './dto/source-retry.dto';
import { lockFinanceOrderAggregate } from './finance-aggregate-lock';
import { financeAuditActor, type OneCFinanceActor } from './onec-finance-actor';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_LEASE_MARGIN_MS = 60_000;
const SOURCE_ERROR = {
  code: 'FINANCE_INVOICE_SYNC_FAILED',
  message: 'Не удалось получить счёт из 1С. Проверьте подключение и повторите запрос.',
} as const;

export type OneCInvoiceSyncActor = OneCFinanceActor;

interface ClaimedInvoiceSync {
  kind: 'claimed';
  journalId: string;
  activeScopeKey: string;
  linkedExternalId: string | null;
  orderReference: string;
}

interface ReplayedInvoiceSync {
  kind: 'replay';
  orderReference: string;
}

type InvoiceSyncClaim = ClaimedInvoiceSync | ReplayedInvoiceSync;

interface SafeInvoiceCandidate {
  externalId: string | null;
  sourceVersion: string | null;
  invoiceNumber: string;
  date: string | null;
  currency: string;
  posted: boolean;
  deleted: boolean;
}

interface SafeInvoice extends SafeInvoiceCandidate {
  counterpartyExternalId: string | null;
  organizationExternalId: string | null;
}

export interface OneCInvoiceSyncResult {
  financeOrderId: string;
  orderReference: string;
  invoiceSyncState: OneCInvoiceSyncState;
  candidateCount: number;
  candidates: SafeInvoiceCandidate[];
  invoice: SafeInvoice | null;
}

function validDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function safeCandidate(snapshot: OneCInvoiceSnapshot): SafeInvoiceCandidate {
  return {
    externalId: snapshot.externalId,
    sourceVersion: snapshot.sourceVersion,
    invoiceNumber: snapshot.parsed.invoiceNo,
    date: snapshot.parsed.date,
    currency: snapshot.parsed.currency,
    posted: snapshot.parsed.posted,
    deleted: snapshot.parsed.deleted === true,
  };
}

function safeInvoice(snapshot: OneCInvoiceSnapshot): SafeInvoice {
  return {
    ...safeCandidate(snapshot),
    counterpartyExternalId: snapshot.parsed.counterpartyExternalId,
    organizationExternalId: snapshot.parsed.organizationExternalId ?? null,
  };
}

export function classifyInvoiceCandidates(
  candidates: OneCInvoiceSnapshot[],
  linkedExternalId: string | null,
): OneCInvoiceSyncState {
  if (candidates.length === 0) return linkedExternalId ? 'stale' : 'not_found';
  if (candidates.length > 1) return 'ambiguous';

  const [candidate] = candidates;
  if (
    (linkedExternalId !== null && candidate.externalId !== linkedExternalId) ||
    candidate.parsed.deleted === true
  ) {
    return linkedExternalId ? 'stale' : 'not_found';
  }
  if (!candidate.externalId) return 'ambiguous';
  if (!candidate.parsed.posted) return linkedExternalId ? 'stale' : 'draft_found';
  return 'posted';
}

@Injectable()
export class OneCInvoiceSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<RuntimeConfig, 'onecTimeoutMs'>,
  ) {}

  async refresh(
    actor: OneCInvoiceSyncActor,
    financeOrderId: string,
    dto: SourceRetryDto,
  ): Promise<OneCInvoiceSyncResult> {
    const operationKey = this.operationKey(dto.operationKey);
    const fingerprint = requestFingerprint({
      command: 'finance_invoice_sync',
      financeOrderId,
    });
    const claim = await this.claim(actor, financeOrderId, operationKey, fingerprint);
    if (claim.kind === 'replay') {
      return this.currentResult(financeOrderId, claim.orderReference);
    }

    try {
      const candidates = await this.pullCandidates(claim);
      return await this.complete(actor, financeOrderId, operationKey, claim, candidates);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      await this.fail(actor, financeOrderId, operationKey, claim);
      throw new ServiceUnavailableException(SOURCE_ERROR);
    }
  }

  async link(
    actor: OneCInvoiceSyncActor,
    financeOrderId: string,
    dto: InvoiceLinkDto,
  ): Promise<OneCInvoiceSyncResult> {
    const externalId = dto.externalId?.toLowerCase();
    const invoiceNumber = dto.invoiceNumber?.trim();
    const reason = dto.reason?.trim();
    if ((externalId ? 1 : 0) + (invoiceNumber ? 1 : 0) !== 1) {
      throw new BadRequestException({
        code: 'FINANCE_INVOICE_LINK_IDENTIFIER_INVALID',
        message: 'Укажите либо Ref_Key, либо точный номер счёта.',
      });
    }
    if (!reason || reason.length < 4 || reason.length > 500) {
      throw new BadRequestException('A bounded manual invoice link reason is required.');
    }

    const operationKey = this.operationKey(dto.operationKey);
    const fingerprint = requestFingerprint({
      command: 'finance_invoice_link',
      financeOrderId,
      externalId: externalId ?? null,
      invoiceNumber: invoiceNumber ?? null,
      reason,
    });
    const claim = await this.claim(actor, financeOrderId, operationKey, fingerprint);
    if (claim.kind === 'replay') {
      return this.currentResult(financeOrderId, claim.orderReference);
    }

    try {
      if (externalId && claim.linkedExternalId && externalId !== claim.linkedExternalId) {
        throw new ConflictException({
          code: 'FINANCE_INVOICE_ALREADY_LINKED',
          message: 'К заявке уже привязан другой проведённый счёт 1С.',
        });
      }
      const candidates = externalId
        ? [await this.onec.pullInvoiceByExternalId(externalId)]
        : await this.pullByExactNumber(invoiceNumber as string);
      if (
        claim.linkedExternalId &&
        candidates.length === 1 &&
        candidates[0].externalId !== claim.linkedExternalId
      ) {
        throw new ConflictException({
          code: 'FINANCE_INVOICE_ALREADY_LINKED',
          message: 'К заявке уже привязан другой проведённый счёт 1С.',
        });
      }
      return await this.complete(actor, financeOrderId, operationKey, claim, candidates, reason);
    } catch (error) {
      await this.fail(actor, financeOrderId, operationKey, claim);
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new ServiceUnavailableException(SOURCE_ERROR);
    }
  }

  private operationKey(value: string): string {
    const operationKey = typeof value === 'string' ? value.toLowerCase() : '';
    if (!UUID_V4.test(operationKey)) {
      throw new BadRequestException('Invoice sync operation key must be a UUIDv4.');
    }
    return operationKey;
  }

  private async claim(
    actor: OneCInvoiceSyncActor,
    financeOrderId: string,
    operationKey: string,
    fingerprint: string,
  ): Promise<InvoiceSyncClaim> {
    const activeScopeKey = `finance-invoice-sync:${financeOrderId}`;
    return this.prisma.$transaction(async (tx) => {
      await lockFinanceOrderAggregate(tx, financeOrderId);
      const order = await tx.financeOrder.findUnique({
        where: { id: financeOrderId },
        include: { commercialOrder: { select: { orderNumber: true } } },
      });
      if (!order) throw new NotFoundException(`Finance order ${financeOrderId} not found`);
      const orderReference = oneCOrderReference(order.commercialOrder.orderNumber);

      const existing = await tx.syncJournal.findUnique({ where: { operationKey } });
      if (existing) {
        if (
          existing.financeOrderId !== financeOrderId ||
          existing.requestFingerprint !== fingerprint
        ) {
          throw new ConflictException({
            code: 'FINANCE_INVOICE_SYNC_KEY_CONFLICT',
            message: 'Ключ операции уже использован для другого запроса.',
          });
        }
        if (existing.status === 'ready') return { kind: 'replay', orderReference };
        if (existing.status === 'error') throw new ServiceUnavailableException(SOURCE_ERROR);
        throw new ConflictException({
          code: 'FINANCE_INVOICE_SYNC_IN_PROGRESS',
          message: 'Обновление счёта уже выполняется.',
        });
      }

      const now = new Date();
      const active = await tx.syncJournal.findUnique({ where: { activeScopeKey } });
      if (active) {
        const leaseExpired =
          active.status === 'retry_requested' &&
          active.leaseExpiresAt !== null &&
          active.leaseExpiresAt <= now;
        if (!leaseExpired) {
          throw new ConflictException({
            code: 'FINANCE_INVOICE_SYNC_ACTIVE_CONFLICT',
            message: 'Для этой заявки уже выполняется обновление счёта.',
          });
        }
        const expired = await tx.syncJournal.updateMany({
          where: {
            id: active.id,
            operationKey: active.operationKey,
            activeScopeKey,
            status: 'retry_requested',
            leaseExpiresAt: { lte: now },
          },
          data: {
            status: 'error',
            activeScopeKey: null,
            leaseExpiresAt: null,
            recovery: 'Invoice sync lease expired before completion.',
            completedAt: now,
          },
        });
        if (expired.count !== 1) {
          throw new ConflictException({
            code: 'FINANCE_INVOICE_SYNC_STATE_CHANGED',
            message: 'Состояние синхронизации изменилось во время восстановления.',
          });
        }
        await this.audit.record(
          {
            ...financeAuditActor(actor),
            type: 'integration.onec_import_failed',
            objectId: financeOrderId,
            detail: {
              operationKey: active.operationKey,
              subjectType: 'invoice',
              code: 'INVOICE_SYNC_LEASE_EXPIRED',
            },
          },
          tx,
        );
      }

      const claimed = await tx.syncJournal.createMany({
        data: [
          {
            financeOrderId,
            operationKey,
            requestFingerprint: fingerprint,
            activeScopeKey,
            entity: 'invoice',
            status: 'retry_requested',
            ownerRole: actor.role,
            leaseExpiresAt: new Date(
              now.getTime() + this.config.onecTimeoutMs + CLAIM_LEASE_MARGIN_MS,
            ),
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count === 0) {
        await this.resolveClaimCollision(
          tx,
          financeOrderId,
          operationKey,
          fingerprint,
          activeScopeKey,
        );
      }

      const journal = await tx.syncJournal.findUnique({ where: { operationKey } });
      if (!journal || journal.financeOrderId !== financeOrderId) {
        throw new ConflictException({
          code: 'FINANCE_INVOICE_SYNC_CLAIM_LOST',
          message: 'Не удалось зафиксировать запрос на обновление счёта.',
        });
      }
      await tx.financeOrder.update({
        where: { id: financeOrderId },
        data: { sourceStatus: 'retry_requested' },
      });
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'audit:sync_retry_requested',
          objectId: financeOrderId,
          oldValue: { sourceStatus: order.sourceStatus },
          newValue: { sourceStatus: 'retry_requested' },
          detail: { operationKey, source: '1C', subjectType: 'invoice' },
        },
        tx,
      );
      return {
        kind: 'claimed',
        journalId: journal.id,
        activeScopeKey,
        linkedExternalId: order.externalId,
        orderReference,
      };
    });
  }

  private async resolveClaimCollision(
    tx: Prisma.TransactionClient,
    financeOrderId: string,
    operationKey: string,
    fingerprint: string,
    activeScopeKey: string,
  ): Promise<never> {
    const sameKey = await tx.syncJournal.findUnique({ where: { operationKey } });
    if (sameKey) {
      if (sameKey.financeOrderId !== financeOrderId || sameKey.requestFingerprint !== fingerprint) {
        throw new ConflictException({
          code: 'FINANCE_INVOICE_SYNC_KEY_CONFLICT',
          message: 'Ключ операции уже использован для другого запроса.',
        });
      }
      throw new ConflictException({
        code: 'FINANCE_INVOICE_SYNC_IN_PROGRESS',
        message: 'Обновление счёта уже выполняется.',
      });
    }
    const active = await tx.syncJournal.findUnique({ where: { activeScopeKey } });
    throw new ConflictException({
      code: active ? 'FINANCE_INVOICE_SYNC_ACTIVE_CONFLICT' : 'FINANCE_INVOICE_SYNC_CLAIM_LOST',
      message: active
        ? 'Для этой заявки уже выполняется обновление счёта.'
        : 'Не удалось зафиксировать запрос на обновление счёта.',
    });
  }

  private async pullCandidates(claim: ClaimedInvoiceSync): Promise<OneCInvoiceSnapshot[]> {
    if (claim.linkedExternalId) {
      return [await this.onec.pullInvoiceByExternalId(claim.linkedExternalId)];
    }

    const exact = (await this.onec.findInvoicesByOrderReference(claim.orderReference)).filter(
      (candidate) =>
        candidate.parsed.orderReference === claim.orderReference &&
        candidate.parsed.deleted !== true,
    );
    if (exact.length !== 1 || !exact[0].externalId) return exact;
    return [await this.onec.pullInvoiceByExternalId(exact[0].externalId)];
  }

  private async pullByExactNumber(invoiceNumber: string): Promise<OneCInvoiceSnapshot[]> {
    const exact = (await this.onec.findInvoicesByExactNumber(invoiceNumber)).filter(
      (candidate) =>
        candidate.parsed.invoiceNo === invoiceNumber && candidate.parsed.deleted !== true,
    );
    if (exact.length !== 1 || !exact[0].externalId) return exact;
    return [await this.onec.pullInvoiceByExternalId(exact[0].externalId)];
  }

  private async complete(
    actor: OneCInvoiceSyncActor,
    financeOrderId: string,
    operationKey: string,
    claim: ClaimedInvoiceSync,
    candidates: OneCInvoiceSnapshot[],
    reason?: string,
  ): Promise<OneCInvoiceSyncResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockInvoiceBoundaryForFinanceOrder(tx, financeOrderId);
      const order = await tx.financeOrder.findUnique({
        where: { id: financeOrderId },
        include: { commercialOrder: { select: { orderNumber: true } } },
      });
      if (!order) throw new NotFoundException(`Finance order ${financeOrderId} not found`);

      const invoiceSyncState = classifyInvoiceCandidates(candidates, claim.linkedExternalId);
      const checkedAt = new Date();
      const snapshots = [];
      for (const candidate of candidates) {
        const sourceFingerprint = requestFingerprint({
          subjectType: 'invoice',
          externalId: candidate.externalId,
          sourceVersion: candidate.sourceVersion,
          parsed: candidate.parsed,
        });
        snapshots.push(
          await tx.sourceSnapshot.upsert({
            where: { sourceFingerprint },
            create: {
              financeOrderId,
              subjectType: 'invoice',
              subjectId: financeOrderId,
              externalId: candidate.externalId,
              sourceVersion: candidate.sourceVersion,
              sourceKind: candidate.sourceKind,
              ownerRole: actor.role,
              capturedAt: validDate(candidate.capturedAt),
              importedAt: checkedAt,
              checkedAt,
              staleness: candidate.staleness,
              parsed: candidate.parsed as unknown as Prisma.InputJsonValue,
              rawPayload: candidate.rawPayload as Prisma.InputJsonValue,
              sourceFingerprint,
            },
            update: {
              financeOrderId,
              sourceVersion: candidate.sourceVersion,
              capturedAt: validDate(candidate.capturedAt),
              importedAt: checkedAt,
              checkedAt,
              staleness: candidate.staleness,
              parsed: candidate.parsed as unknown as Prisma.InputJsonValue,
              rawPayload: candidate.rawPayload as Prisma.InputJsonValue,
            },
          }),
        );
      }

      const official = invoiceSyncState === 'posted' ? candidates[0] : null;
      const financeData: Prisma.FinanceOrderUpdateInput = {
        invoiceSyncState,
        invoiceCandidates: candidates.map(safeCandidate) as unknown as Prisma.InputJsonValue,
        invoiceSourceCheckedAt: checkedAt,
        sourceStatus: invoiceSyncState === 'stale' ? 'stale' : 'ready',
      };
      if (
        order.invoiceIssuedAt === null &&
        (order.invoiceSyncState === 'posted' || invoiceSyncState === 'posted')
      ) {
        financeData.invoiceIssuedAt = checkedAt;
      }
      if (official?.externalId) {
        Object.assign(financeData, {
          externalId: official.externalId,
          sourceVersion: official.sourceVersion,
          invoiceNumber: official.parsed.invoiceNo,
          invoiceCurrency: official.parsed.currency,
        });
      }
      await tx.financeOrder.update({ where: { id: financeOrderId }, data: financeData });

      const completed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          activeScopeKey: claim.activeScopeKey,
          status: 'retry_requested',
        },
        data: {
          status: 'ready',
          activeScopeKey: null,
          leaseExpiresAt: null,
          sourceSnapshotId: snapshots[0]?.id ?? null,
          completedAt: checkedAt,
        },
      });
      if (completed.count !== 1) {
        throw new ConflictException({
          code: 'FINANCE_INVOICE_SYNC_CLAIM_LOST',
          message: 'Состояние синхронизации изменилось до завершения запроса.',
        });
      }

      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'integration.onec_imported',
          objectId: financeOrderId,
          sourceSnapshotId: snapshots[0]?.id,
          detail: {
            operationKey,
            subjectType: 'invoice',
            state: invoiceSyncState,
            candidateCount: candidates.length,
          },
          reason,
        },
        tx,
      );
      return this.result(financeOrderId, claim.orderReference, invoiceSyncState, candidates);
    });
  }

  private async fail(
    actor: OneCInvoiceSyncActor,
    financeOrderId: string,
    operationKey: string,
    claim: ClaimedInvoiceSync,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const boundary = await lockInvoiceBoundaryForFinanceOrder(tx, financeOrderId);
      const failed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          activeScopeKey: claim.activeScopeKey,
          status: 'retry_requested',
        },
        data: {
          status: 'error',
          activeScopeKey: null,
          leaseExpiresAt: null,
          recovery: 'Check 1C availability and retry with a new operation key.',
          completedAt: new Date(),
        },
      });
      if (failed.count !== 1) return;
      const checkedAt = new Date();
      await tx.financeOrder.update({
        where: { id: financeOrderId },
        data: {
          invoiceSyncState: 'error',
          sourceStatus: 'error',
          invoiceSourceCheckedAt: checkedAt,
          ...(boundary?.invoiceSyncState === 'posted' && boundary.invoiceIssuedAt === null
            ? { invoiceIssuedAt: checkedAt }
            : {}),
        },
      });
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'integration.onec_import_failed',
          objectId: financeOrderId,
          detail: { operationKey, code: 'ONEC_INVOICE_PULL_FAILED' },
        },
        tx,
      );
    });
  }

  private result(
    financeOrderId: string,
    orderReference: string,
    invoiceSyncState: OneCInvoiceSyncState,
    candidates: OneCInvoiceSnapshot[],
  ): OneCInvoiceSyncResult {
    const official = invoiceSyncState === 'posted' ? candidates[0] : null;
    return {
      financeOrderId,
      orderReference,
      invoiceSyncState,
      candidateCount: candidates.length,
      candidates: candidates.map(safeCandidate),
      invoice: official ? safeInvoice(official) : null,
    };
  }

  private async currentResult(
    financeOrderId: string,
    orderReference: string,
  ): Promise<OneCInvoiceSyncResult> {
    const order = await this.prisma.financeOrder.findUnique({
      where: { id: financeOrderId },
      include: {
        snapshots: {
          where: { subjectType: 'invoice' },
          orderBy: { checkedAt: 'desc' },
          take: 1,
          select: { parsed: true, externalId: true, sourceVersion: true, sourceKind: true },
        },
      },
    });
    if (!order) throw new NotFoundException(`Finance order ${financeOrderId} not found`);
    const snapshot = order.snapshots[0];
    const parsed = snapshot?.parsed as unknown as OneCInvoiceSnapshot['parsed'] | undefined;
    const candidates =
      snapshot && parsed
        ? [
            {
              sourceKind: snapshot.sourceKind as OneCInvoiceSnapshot['sourceKind'],
              subjectType: 'invoice' as const,
              externalId: snapshot.externalId,
              sourceVersion: snapshot.sourceVersion,
              staleness: 'fresh' as const,
              capturedAt: order.invoiceSourceCheckedAt?.toISOString() ?? new Date(0).toISOString(),
              parsed,
              rawPayload: null,
            },
          ]
        : [];
    return this.result(
      financeOrderId,
      orderReference,
      order.invoiceSyncState as OneCInvoiceSyncState,
      candidates,
    );
  }
}
