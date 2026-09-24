import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OneCPaymentSnapshot } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { RuntimeConfig } from '../../common/runtime-config';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import { ONEC_ADAPTER, type OneCAdapter } from '../../integrations/onec/onec.adapter';
import type { PaymentSourceSyncDto } from './dto/payment-source-sync.dto';
import { financeAuditActor } from './onec-finance-actor';
import {
  matchPaymentReceipt,
  PaymentAllocationService,
  type PaymentAllocationActor,
  type PaymentReceiptWithAllocations,
  type PaymentReceiptMatch,
} from './payment-allocation.service';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE_SCOPE = 'finance-payment-source-sync';
const CLAIM_LEASE_MARGIN_MS = 60_000;
const DEFAULT_PAGE_SIZE = 250;
const MAX_PAYMENT_SYNC_ROWS = 50_000;
const PAYMENT_SOURCE_ERROR = {
  code: 'FINANCE_PAYMENT_SOURCE_SYNC_FAILED',
  message: 'Не удалось получить банковские поступления из 1С. Повторите запрос позже.',
} as const;

interface PaymentSyncClaim {
  kind: 'claimed';
  journalId: string;
}

interface PaymentSyncReplay {
  kind: 'replay';
}

type PaymentSyncJournalClient = Pick<Prisma.TransactionClient, 'syncJournal'>;

export interface PaymentSyncResult {
  imported: number;
  matched: number;
  autoApplied: number;
  proposals: number;
  ambiguous: number;
  unmatched: number;
  reversed: number;
  skipped: number;
  replayed: boolean;
}

function emptyResult(replayed = false): PaymentSyncResult {
  return {
    imported: 0,
    matched: 0,
    autoApplied: 0,
    proposals: 0,
    ambiguous: 0,
    unmatched: 0,
    reversed: 0,
    skipped: 0,
    replayed,
  };
}

function date(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function matchProjection(match: PaymentReceiptMatch, sourceIsActive: boolean) {
  const candidateFinanceOrderIds =
    'financeOrderId' in match ? [match.financeOrderId] : match.candidateFinanceOrderIds;
  if (!sourceIsActive) {
    return {
      matchState: 'reversed',
      matchKind: match.kind,
      candidateFinanceOrderIds,
    };
  }
  if (match.kind === 'invoice_ref' || match.kind === 'order_marker') {
    return { matchState: 'matched', matchKind: match.kind, candidateFinanceOrderIds };
  }
  if (match.kind === 'invoice_number_proposal') {
    return { matchState: 'proposal', matchKind: match.kind, candidateFinanceOrderIds };
  }
  return {
    matchState: match.kind,
    matchKind: match.kind,
    candidateFinanceOrderIds,
  };
}

function candidateIds(value: Prisma.JsonValue): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result.sort();
}

function sameCandidates(left: Prisma.JsonValue, right: string[]): boolean {
  const normalized = candidateIds(left);
  if (!normalized) return false;
  const expected = [...right].sort();
  return (
    normalized.length === expected.length &&
    normalized.every((candidate, index) => candidate === expected[index])
  );
}

function sameDate(left: Date | null, right: string | null): boolean {
  return left?.getTime() === date(right)?.getTime();
}

function sameSourceFact(
  existing: PaymentReceiptWithAllocations,
  snapshot: OneCPaymentSnapshot,
  sourceIsActive: boolean,
): boolean {
  return (
    existing.sourceVersion === snapshot.sourceVersion &&
    existing.number === snapshot.parsed.number &&
    sameDate(existing.receivedAt, snapshot.parsed.date) &&
    existing.amount.equals(snapshot.parsed.amount) &&
    existing.currency === (snapshot.parsed.currency ?? 'RUB') &&
    existing.counterpartyExternalId === snapshot.parsed.counterpartyExternalId &&
    existing.invoiceExternalId === (snapshot.parsed.invoiceExternalId ?? null) &&
    existing.invoiceNumberReference === (snapshot.parsed.invoiceNumberReference ?? null) &&
    existing.orderReference === (snapshot.parsed.orderReference ?? null) &&
    existing.posted === snapshot.parsed.posted &&
    existing.deleted === (snapshot.parsed.deleted === true) &&
    existing.sourceStatus === (sourceIsActive ? snapshot.staleness : 'stale')
  );
}

function canSkipUnchangedReceipt(
  existing: PaymentReceiptWithAllocations,
  snapshot: OneCPaymentSnapshot,
  match: PaymentReceiptMatch,
  projection: ReturnType<typeof matchProjection>,
  sourceIsActive: boolean,
  autoApplyEnabled: boolean,
): boolean {
  if (!sameSourceFact(existing, snapshot, sourceIsActive)) return false;
  if (existing.matchKind === 'manual') return true;
  if (
    existing.matchState !== projection.matchState ||
    existing.matchKind !== projection.matchKind ||
    !sameCandidates(existing.candidateFinanceOrderIds, projection.candidateFinanceOrderIds)
  ) {
    return false;
  }
  if (
    !autoApplyEnabled ||
    !sourceIsActive ||
    (match.kind !== 'invoice_ref' && match.kind !== 'order_marker')
  ) {
    return true;
  }
  const allocated = existing.allocations.reduce(
    (total, allocation) => total.plus(allocation.amount),
    new Prisma.Decimal(0),
  );
  return existing.amount.minus(allocated).lte(0);
}

@Injectable()
export class OneCPaymentSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    private readonly allocation: PaymentAllocationService,
    @Inject(RUNTIME_CONFIG)
    private readonly config: Pick<
      RuntimeConfig,
      'onecTimeoutMs' | 'onecPaymentAutoApplyEnabled' | 'onecSyncPageSize'
    >,
  ) {}

  async sync(actor: PaymentAllocationActor, dto: PaymentSourceSyncDto): Promise<PaymentSyncResult> {
    const operationKey = dto.operationKey?.toLowerCase();
    if (!operationKey || !UUID_V4.test(operationKey)) {
      throw new BadRequestException('Payment sync operation key must be a UUIDv4.');
    }
    const fingerprint = requestFingerprint({ command: 'finance_payment_source_sync' });
    const claim = await this.claim(actor, operationKey, fingerprint);
    if (claim.kind === 'replay') return emptyResult(true);

    try {
      const snapshots = await this.pullAllPayments(operationKey, claim);
      const result = await this.apply(actor, operationKey, claim, snapshots);
      await this.complete(actor, operationKey, claim, result);
      return result;
    } catch {
      await this.fail(actor, operationKey, claim);
      throw new ServiceUnavailableException(PAYMENT_SOURCE_ERROR);
    }
  }

  private async pullAllPayments(
    operationKey: string,
    claim: PaymentSyncClaim,
  ): Promise<OneCPaymentSnapshot[]> {
    const pageSize = this.config.onecSyncPageSize || DEFAULT_PAGE_SIZE;
    const snapshots: OneCPaymentSnapshot[] = [];
    const externalIds = new Set<string>();
    for (let skip = 0; snapshots.length < MAX_PAYMENT_SYNC_ROWS; skip += pageSize) {
      await this.renewClaim(this.prisma, operationKey, claim);
      const page = await this.onec.pullPayments({ top: pageSize, skip });
      if (snapshots.length + page.length > MAX_PAYMENT_SYNC_ROWS) {
        throw new Error(`ONEC_PAYMENT_SYNC_LIMIT: more than ${MAX_PAYMENT_SYNC_ROWS} payments.`);
      }
      for (const snapshot of page) {
        if (snapshot.externalId) {
          if (externalIds.has(snapshot.externalId)) {
            throw new Error(`ONEC_DUPLICATE_EXTERNAL_ID: ${snapshot.externalId}`);
          }
          externalIds.add(snapshot.externalId);
        }
        snapshots.push(snapshot);
      }
      if (page.length < pageSize) return snapshots;
    }
    throw new Error(`ONEC_PAYMENT_SYNC_LIMIT: more than ${MAX_PAYMENT_SYNC_ROWS} payments.`);
  }

  private async renewClaim(
    client: PaymentSyncJournalClient,
    operationKey: string,
    claim: PaymentSyncClaim,
  ): Promise<void> {
    const now = new Date();
    const renewed = await client.syncJournal.updateMany({
      where: {
        id: claim.journalId,
        operationKey,
        activeScopeKey: ACTIVE_SCOPE,
        entity: 'payment',
        status: 'retry_requested',
      },
      data: {
        leaseExpiresAt: new Date(now.getTime() + this.config.onecTimeoutMs + CLAIM_LEASE_MARGIN_MS),
      },
    });
    if (renewed.count !== 1) throw new Error('PAYMENT_SYNC_CLAIM_LOST');
  }

  private async claim(
    actor: PaymentAllocationActor,
    operationKey: string,
    fingerprint: string,
  ): Promise<PaymentSyncClaim | PaymentSyncReplay> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.syncJournal.findUnique({ where: { operationKey } });
      if (existing) {
        if (existing.requestFingerprint !== fingerprint || existing.entity !== 'payment') {
          throw new ConflictException({
            code: 'PAYMENT_SYNC_KEY_CONFLICT',
            message: 'Ключ операции уже использован для другого запроса.',
          });
        }
        if (existing.status === 'ready') return { kind: 'replay' };
        if (existing.status === 'error') {
          throw new ServiceUnavailableException(PAYMENT_SOURCE_ERROR);
        }
        throw new ConflictException({
          code: 'PAYMENT_SYNC_IN_PROGRESS',
          message: 'Импорт банковской выписки уже выполняется.',
        });
      }

      const now = new Date();
      const active = await tx.syncJournal.findUnique({ where: { activeScopeKey: ACTIVE_SCOPE } });
      if (active) {
        const leaseExpired =
          active.entity === 'payment' &&
          active.status === 'retry_requested' &&
          active.leaseExpiresAt !== null &&
          active.leaseExpiresAt <= now;
        if (!leaseExpired) {
          throw new ConflictException({
            code: 'PAYMENT_SYNC_ACTIVE_CONFLICT',
            message: 'Другой импорт банковской выписки уже выполняется.',
          });
        }
        const expired = await tx.syncJournal.updateMany({
          where: {
            id: active.id,
            operationKey: active.operationKey,
            activeScopeKey: ACTIVE_SCOPE,
            entity: 'payment',
            status: 'retry_requested',
            leaseExpiresAt: { lte: now },
          },
          data: {
            status: 'error',
            activeScopeKey: null,
            leaseExpiresAt: null,
            recovery: 'Payment sync lease expired before completion.',
            completedAt: now,
          },
        });
        if (expired.count !== 1) {
          throw new ConflictException({
            code: 'PAYMENT_SYNC_STATE_CHANGED',
            message: 'Состояние импорта изменилось во время восстановления.',
          });
        }
        await this.audit.record(
          {
            ...financeAuditActor(actor),
            type: 'integration.onec_import_failed',
            detail: {
              operationKey: active.operationKey,
              subjectType: 'payment',
              code: 'PAYMENT_SYNC_LEASE_EXPIRED',
            },
          },
          tx,
        );
      }

      const claimed = await tx.syncJournal.createMany({
        data: [
          {
            operationKey,
            requestFingerprint: fingerprint,
            activeScopeKey: ACTIVE_SCOPE,
            entity: 'payment',
            status: 'retry_requested',
            ownerRole: actor.role,
            leaseExpiresAt: new Date(
              now.getTime() + this.config.onecTimeoutMs + CLAIM_LEASE_MARGIN_MS,
            ),
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: 'PAYMENT_SYNC_ACTIVE_CONFLICT',
          message: 'Другой импорт банковской выписки уже выполняется.',
        });
      }
      const journal = await tx.syncJournal.findUnique({ where: { operationKey } });
      if (!journal) {
        throw new ConflictException({
          code: 'PAYMENT_SYNC_CLAIM_LOST',
          message: 'Не удалось зафиксировать импорт банковской выписки.',
        });
      }
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'audit:sync_retry_requested',
          detail: { operationKey, source: '1C', subjectType: 'payment' },
        },
        tx,
      );
      return { kind: 'claimed', journalId: journal.id };
    });
  }

  private async apply(
    actor: PaymentAllocationActor,
    operationKey: string,
    claim: PaymentSyncClaim,
    snapshots: OneCPaymentSnapshot[],
  ): Promise<PaymentSyncResult> {
    const result = emptyResult();
    const orders = await this.allocation.matchOrders();
    const externalIds = [
      ...new Set(
        snapshots.flatMap((snapshot) => (snapshot.externalId ? [snapshot.externalId] : [])),
      ),
    ];
    const existingReceipts =
      externalIds.length === 0
        ? []
        : await this.prisma.paymentReceipt.findMany({
            where: { externalId: { in: externalIds } },
            include: { allocations: true },
          });
    const existingByExternalId = new Map(
      existingReceipts.map((receipt) => [receipt.externalId, receipt]),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.externalId || !Number.isFinite(snapshot.parsed.amount)) {
        result.skipped += 1;
        continue;
      }
      const externalId = snapshot.externalId;
      const sourceIsActive =
        snapshot.parsed.posted && snapshot.parsed.deleted !== true && snapshot.parsed.amount > 0;
      const match = matchPaymentReceipt(
        {
          invoiceExternalId: snapshot.parsed.invoiceExternalId ?? null,
          invoiceNumberReference: snapshot.parsed.invoiceNumberReference ?? null,
          orderReference: snapshot.parsed.orderReference ?? null,
          counterpartyExternalId: snapshot.parsed.counterpartyExternalId,
          currency: snapshot.parsed.currency ?? 'RUB',
        },
        orders,
      );
      const projection = matchProjection(match, sourceIsActive);
      const knownReceipt = existingByExternalId.get(externalId);
      if (
        knownReceipt &&
        canSkipUnchangedReceipt(
          knownReceipt,
          snapshot,
          match,
          projection,
          sourceIsActive,
          this.config.onecPaymentAutoApplyEnabled,
        )
      ) {
        result.skipped += 1;
        continue;
      }
      await this.prisma.$transaction(async (tx) => {
        await this.renewClaim(tx, operationKey, claim);
        const existing = await tx.paymentReceipt.findUnique({
          where: { externalId },
          include: { allocations: true },
        });
        const sourceChanged =
          existing !== null &&
          (existing.sourceVersion !== snapshot.sourceVersion ||
            existing.posted !== snapshot.parsed.posted ||
            existing.deleted !== (snapshot.parsed.deleted === true) ||
            !existing.amount.equals(snapshot.parsed.amount));
        if (
          existing &&
          sourceChanged &&
          existing.allocations.some((allocation) => allocation.amount.gt(0))
        ) {
          const reversals = await this.allocation.reverseReceipt(
            tx,
            actor,
            existing,
            sourceIsActive
              ? 'Финансовый факт 1С изменён; прежнее распределение компенсировано.'
              : 'Поступление отменено или снято с проведения в 1С.',
          );
          result.reversed += reversals.length;
        }

        const checkedAt = new Date();
        const sourceFingerprint = requestFingerprint({
          subjectType: 'payment',
          externalId,
          sourceVersion: snapshot.sourceVersion,
          parsed: snapshot.parsed,
        });
        const linkedOrderId = 'financeOrderId' in match ? match.financeOrderId : undefined;
        const sourceSnapshot = await tx.sourceSnapshot.upsert({
          where: { sourceFingerprint },
          create: {
            financeOrderId: linkedOrderId,
            subjectType: 'payment',
            subjectId: externalId,
            externalId,
            sourceVersion: snapshot.sourceVersion,
            sourceKind: snapshot.sourceKind,
            ownerRole: actor.role,
            capturedAt: date(snapshot.capturedAt),
            importedAt: checkedAt,
            checkedAt,
            staleness: sourceIsActive ? snapshot.staleness : 'stale',
            parsed: snapshot.parsed as unknown as Prisma.InputJsonValue,
            rawPayload: snapshot.rawPayload as Prisma.InputJsonValue,
            sourceFingerprint,
          },
          update: {
            financeOrderId: linkedOrderId,
            sourceVersion: snapshot.sourceVersion,
            capturedAt: date(snapshot.capturedAt),
            importedAt: checkedAt,
            checkedAt,
            staleness: sourceIsActive ? snapshot.staleness : 'stale',
            parsed: snapshot.parsed as unknown as Prisma.InputJsonValue,
            rawPayload: snapshot.rawPayload as Prisma.InputJsonValue,
          },
        });
        const receiptData = {
          sourceVersion: snapshot.sourceVersion,
          number: snapshot.parsed.number,
          receivedAt: date(snapshot.parsed.date),
          amount: snapshot.parsed.amount,
          currency: snapshot.parsed.currency ?? 'RUB',
          counterpartyExternalId: snapshot.parsed.counterpartyExternalId,
          invoiceExternalId: snapshot.parsed.invoiceExternalId ?? null,
          invoiceNumberReference: snapshot.parsed.invoiceNumberReference ?? null,
          orderReference: snapshot.parsed.orderReference ?? null,
          posted: snapshot.parsed.posted,
          deleted: snapshot.parsed.deleted === true,
          sourceStatus: sourceIsActive ? 'fresh' : 'stale',
          matchState: projection.matchState,
          matchKind: projection.matchKind,
          candidateFinanceOrderIds:
            projection.candidateFinanceOrderIds as unknown as Prisma.InputJsonValue,
          lastMatchedAt: checkedAt,
          capturedAt: date(snapshot.capturedAt) ?? checkedAt,
        };
        await tx.paymentReceipt.upsert({
          where: { externalId },
          create: { externalId, ...receiptData },
          update: receiptData,
        });
        const stored = await tx.paymentReceipt.findUnique({
          where: { externalId },
          include: { allocations: true },
        });
        if (!stored) throw new Error('PAYMENT_RECEIPT_UPSERT_LOST');

        result.imported += 1;
        if (match.kind === 'invoice_ref' || match.kind === 'order_marker') {
          result.matched += 1;
          if (sourceIsActive && this.config.onecPaymentAutoApplyEnabled) {
            const rows = await this.allocation.autoApply(
              tx,
              actor,
              stored as PaymentReceiptWithAllocations,
              match,
            );
            if (rows.length > 0) result.autoApplied += 1;
          }
        } else if (match.kind === 'invoice_number_proposal') {
          result.proposals += 1;
        } else if (match.kind === 'ambiguous') {
          result.ambiguous += 1;
        } else {
          result.unmatched += 1;
        }
        await this.audit.record(
          {
            ...financeAuditActor(actor),
            type: 'integration.onec_imported',
            objectId: stored.id,
            sourceSnapshotId: sourceSnapshot.id,
            detail: {
              subjectType: 'payment',
              externalId,
              sourceVersion: snapshot.sourceVersion,
              matchKind: projection.matchKind,
              sourceStatus: receiptData.sourceStatus,
            },
          },
          tx,
        );
      });
    }
    return result;
  }

  private async complete(
    actor: PaymentAllocationActor,
    operationKey: string,
    claim: PaymentSyncClaim,
    result: PaymentSyncResult,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const completed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          activeScopeKey: ACTIVE_SCOPE,
          entity: 'payment',
          status: 'retry_requested',
        },
        data: {
          status: 'ready',
          activeScopeKey: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          recovery: JSON.stringify(result),
        },
      });
      if (completed.count !== 1) throw new Error('PAYMENT_SYNC_CLAIM_LOST');
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'audit:payment_status_imported',
          detail: { operationKey, source: '1C', ...result },
        },
        tx,
      );
    });
  }

  private async fail(actor: PaymentAllocationActor, operationKey: string, claim: PaymentSyncClaim) {
    await this.prisma.$transaction(async (tx) => {
      const failed = await tx.syncJournal.updateMany({
        where: {
          id: claim.journalId,
          operationKey,
          activeScopeKey: ACTIVE_SCOPE,
          entity: 'payment',
          status: 'retry_requested',
        },
        data: {
          status: 'error',
          activeScopeKey: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          recovery: 'Check 1C availability and retry with a new operation key.',
        },
      });
      if (failed.count !== 1) return;
      await this.audit.record(
        {
          ...financeAuditActor(actor),
          type: 'integration.onec_import_failed',
          detail: { operationKey, code: 'ONEC_PAYMENT_PULL_FAILED' },
        },
        tx,
      );
    });
  }
}
