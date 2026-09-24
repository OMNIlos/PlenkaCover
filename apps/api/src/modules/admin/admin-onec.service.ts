import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  ONEC_SUBJECT_TYPES,
  type OneCHealthResult,
  type OneCReconciliationResult,
  type OneCSubjectType,
  type Role,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OneCImportService } from '../../integrations/onec/onec-import.service';
import { ONEC_ADAPTER, type OneCAdapter } from '../../integrations/onec/onec.adapter';
import type { AdminOneCImportDto, AdminOneCSnapshotQueryDto } from './dto/admin-onec.dto';
import { OperationalChecksService } from './operational-checks.service';
import { OperationalIncidentsService } from '../../common/operational-incidents/operational-incidents.service';
import { OneCSyncService } from '../../integrations/onec/onec-sync.service';
import type { AdminOneCSyncRunsQueryDto } from './dto/admin-onec-sync.dto';

export interface AdminOneCActor {
  userId: string | null;
  role: Role;
}

const SNAPSHOT_SAFE_SELECT = {
  id: true,
  financeOrderId: true,
  subjectType: true,
  subjectId: true,
  externalId: true,
  sourceVersion: true,
  sourceKind: true,
  ownerRole: true,
  capturedAt: true,
  importedAt: true,
  checkedAt: true,
  staleness: true,
  parsed: true,
  createdAt: true,
} as const;

const SYNC_RUN_SAFE_SELECT = {
  id: true,
  mode: true,
  status: true,
  counters: true,
  errorCode: true,
  recovery: true,
  startedAt: true,
  completedAt: true,
} as const;

function safeSyncRun(run: {
  id: string;
  mode: string;
  status: string;
  counters: unknown;
  errorCode: string | null;
  recovery: string | null;
  startedAt: Date;
  completedAt: Date | null;
}) {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function conflictCount(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('conflicts' in value)) return 0;
  const conflicts = (value as { conflicts?: unknown }).conflicts;
  return typeof conflicts === 'number' && Number.isFinite(conflicts) ? conflicts : 0;
}

@Injectable()
export class AdminOneCService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ONEC_ADAPTER) private readonly onec: OneCAdapter,
    private readonly imports: OneCImportService,
    private readonly checks: OperationalChecksService,
    private readonly incidents: OperationalIncidentsService,
    private readonly sync: OneCSyncService,
  ) {}

  previewSync(actor: AdminOneCActor) {
    return this.sync.run(actor, 'preview');
  }

  runSync(actor: AdminOneCActor) {
    return this.sync.run(actor, 'apply');
  }

  async listSyncRuns(query: AdminOneCSyncRunsQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where = {
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.oneCSyncRun.findMany({
        where,
        select: SYNC_RUN_SAFE_SELECT,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.oneCSyncRun.count({ where }),
    ]);
    return { items: items.map(safeSyncRun), page, pageSize, total };
  }

  async getSyncRun(runId: string) {
    const run = await this.prisma.oneCSyncRun.findUnique({
      where: { id: runId },
      select: SYNC_RUN_SAFE_SELECT,
    });
    if (!run) throw new NotFoundException(`1С sync run ${runId} not found`);
    return safeSyncRun(run);
  }

  async reconciliation(): Promise<OneCReconciliationResult> {
    const latest = await this.prisma.oneCSyncRun.findFirst({
      select: { id: true, status: true, counters: true },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    if (!latest) {
      return {
        checkedAt: new Date().toISOString(),
        latestRunId: null,
        status: 'never_synced',
        issues: [],
      };
    }

    const counters =
      typeof latest.counters === 'object' && latest.counters !== null
        ? (latest.counters as Record<string, unknown>)
        : {};
    const subjects = new Set<string>(ONEC_SUBJECT_TYPES);
    const issues = Object.entries(counters)
      .filter(([subjectType, counter]) => subjects.has(subjectType) && conflictCount(counter) > 0)
      .slice(0, 100)
      .map(([subjectType]) => ({
        subjectType: subjectType as OneCSubjectType,
        externalId: null,
        code: 'identity_conflict' as const,
        recovery: 'Resolve the 1С identity mapping conflict and rerun preview.',
      }));

    return {
      checkedAt: new Date().toISOString(),
      latestRunId: latest.id,
      status: latest.status === 'completed' && issues.length === 0 ? 'ready' : 'attention_required',
      issues,
    };
  }

  async overview() {
    const [lastCheck, snapshots, journals] = await Promise.all([
      this.prisma.operationalCheck.findFirst({
        where: { scope: 'onec', targetType: 'connection' },
        orderBy: { completedAt: 'desc' },
      }),
      this.prisma.sourceSnapshot.findMany({
        select: SNAPSHOT_SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.syncJournal.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 }),
    ]);
    const latestBySubject = Object.values(
      snapshots.reduce<Record<string, (typeof snapshots)[number]>>((acc, snapshot) => {
        const key = snapshot.subjectType ?? 'unknown';
        if (!acc[key]) acc[key] = snapshot;
        return acc;
      }, {}),
    );
    return {
      connection: lastCheck,
      latestBySubject,
      journals,
      counts: {
        snapshots: snapshots.length,
        errors: journals.filter((item) => item.status === 'error').length,
        waiting: journals.filter((item) => item.status === 'waiting').length,
      },
    };
  }

  async check(actor: AdminOneCActor): Promise<OneCHealthResult> {
    const startedAt = new Date();
    const result = await this.onec.checkHealth();
    const completedAt = new Date();
    await this.checks.record({
      scope: 'onec',
      targetType: 'connection',
      status:
        result.status === 'ready' ? 'passed' : result.status === 'degraded' ? 'degraded' : 'failed',
      summary: { ...result },
      actorId: actor.userId,
      startedAt,
      completedAt,
    });
    await this.audit.record({
      type: 'admin.onec.check_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: 'onec',
      detail: { mode: result.mode, status: result.status, latencyMs: result.latencyMs },
    });
    if (result.status === 'unavailable') {
      await this.incidents.signal({
        fingerprint: 'onec:connection',
        scope: 'onec',
        targetType: 'connection',
        severity: 'critical',
        title: '1С недоступна',
        message: result.message ?? '1С connection check failed.',
        recovery: 'Проверить настройки и доступность 1С, затем повторить проверку.',
      });
    }
    return result;
  }

  async import(actor: AdminOneCActor, dto: AdminOneCImportDto) {
    if (dto.subjectType === 'invoice' && !dto.externalId?.trim()) {
      throw new ConflictException({
        code: 'ADMIN_ONEC_RETRY_UNMAPPED',
        message: 'Invoice import requires externalId.',
      });
    }
    await this.audit.record({
      type: 'admin.onec.import_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: dto.externalId ?? dto.subjectType,
      detail: { subjectType: dto.subjectType, externalId: dto.externalId ?? null },
    });
    const startedAt = new Date();
    try {
      const result = await this.runImport(actor, dto.subjectType, dto.externalId);
      await this.checks.record({
        scope: 'onec',
        targetType: 'import',
        targetId: dto.externalId ?? dto.subjectType,
        status: 'passed',
        summary: {
          subjectType: dto.subjectType,
          imported: Array.isArray(result) ? result.length : 1,
        },
        actorId: actor.userId,
        startedAt,
        completedAt: new Date(),
      });
      return result;
    } catch (error) {
      await this.recordImportFailure(actor, dto.subjectType, dto.externalId, startedAt);
      throw error;
    }
  }

  async retry(actor: AdminOneCActor, journalId: string) {
    const journal = await this.prisma.syncJournal.findUnique({ where: { id: journalId } });
    if (!journal) throw new NotFoundException(`Sync journal ${journalId} not found`);
    if (journal.operationKey || journal.activeScopeKey || journal.leaseExpiresAt) {
      throw new ConflictException({
        code: 'ADMIN_ONEC_FINANCE_RETRY_OWNED',
        message: 'This retry is owned by the finance command workflow and cannot be taken over.',
      });
    }
    const request = this.retryRequest(journal.entity, journal.financeOrderId);
    await this.audit.record({
      type: 'admin.onec.retry_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: journalId,
      detail: {
        subjectType: request.subjectType,
        externalId: request.externalId ?? null,
      },
    });
    try {
      const result = await this.import(actor, request);
      const updated = await this.prisma.syncJournal.update({
        where: { id: journalId },
        data: { status: 'ready', retries: { increment: 1 }, recovery: null },
      });
      return { journal: updated, result };
    } catch (error) {
      await this.prisma.syncJournal.update({
        where: { id: journalId },
        data: {
          status: 'error',
          retries: { increment: 1 },
          recovery: '1С retry failed; inspect admin diagnostics.',
        },
      });
      throw error;
    }
  }

  async listSnapshots(query: AdminOneCSnapshotQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where = {
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.staleness ? { staleness: query.staleness } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.sourceSnapshot.findMany({
        where,
        select: SNAPSHOT_SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.sourceSnapshot.count({ where }),
    ]);
    return { items, page, pageSize, total };
  }

  async rawSnapshot(snapshotId: string) {
    const snapshot = await this.prisma.sourceSnapshot.findUnique({ where: { id: snapshotId } });
    if (!snapshot) throw new NotFoundException(`Source snapshot ${snapshotId} not found`);
    return snapshot;
  }

  sourceHealth() {
    return this.prisma.syncJournal.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  private runImport(actor: AdminOneCActor, subjectType: OneCSubjectType, externalId?: string) {
    switch (subjectType) {
      case 'counterparty':
        return externalId
          ? this.imports.importCounterparty(actor, externalId)
          : this.imports.importCounterparties(actor);
      case 'invoice':
        return this.imports.importInvoice(actor, externalId!);
      case 'payment':
        return this.imports.importPayments(actor);
      case 'shipment':
        return this.imports.importShipments(actor);
      case 'stock':
        return this.imports.importStock(actor);
    }
  }

  private retryRequest(entity: string, financeOrderId: string | null): AdminOneCImportDto {
    if (entity === 'finance_order' && financeOrderId) {
      return { subjectType: 'invoice', externalId: financeOrderId };
    }
    if (['counterparty', 'payment', 'shipment', 'stock'].includes(entity)) {
      return { subjectType: entity as Exclude<OneCSubjectType, 'invoice'> };
    }
    throw new ConflictException({
      code: 'ADMIN_ONEC_RETRY_UNMAPPED',
      message: `Sync journal entity ${entity} cannot be retried automatically.`,
    });
  }

  private async recordImportFailure(
    actor: AdminOneCActor,
    subjectType: OneCSubjectType,
    externalId: string | undefined,
    startedAt: Date,
  ) {
    await this.checks.record({
      scope: 'onec',
      targetType: 'import',
      targetId: externalId ?? subjectType,
      status: 'failed',
      summary: { subjectType, errorCategory: 'adapter' },
      actorId: actor.userId,
      startedAt,
      completedAt: new Date(),
    });
    await this.incidents.signal({
      fingerprint: `onec:import:${subjectType}`,
      scope: 'onec',
      targetType: 'import',
      targetId: externalId ?? subjectType,
      severity: 'warning',
      title: `Ошибка импорта 1С: ${subjectType}`,
      message: '1С import failed; inspect admin diagnostics.',
      recovery: 'Проверить соединение и повторить импорт.',
    });
  }
}
