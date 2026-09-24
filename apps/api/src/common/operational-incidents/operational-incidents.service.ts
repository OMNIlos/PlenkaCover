import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type OperationalIncident } from '@prisma/client';
import {
  INCIDENT_SEVERITIES,
  OPERATIONAL_SCOPES,
  type IncidentSignal,
  type OperationalActor,
} from '@plenka/contracts';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_INCIDENT_STATUSES = ['open', 'acknowledged'] as const;

export type IncidentReconcileAction =
  | { kind: 'signal'; signal: IncidentSignal }
  | { kind: 'resolve'; fingerprint: string; actor: OperationalActor; reason: string }
  | { kind: 'noop'; fingerprint: string };

export interface IncidentReconcileResult {
  kind: IncidentReconcileAction['kind'];
  fingerprint: string;
  incident: OperationalIncident | null;
}

export type IncidentSourceObserver = (
  tx: Prisma.TransactionClient,
) => Promise<readonly IncidentReconcileAction[]>;

function isFingerprintUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') {
    return false;
  }
  const meta = 'meta' in error && error.meta && typeof error.meta === 'object' ? error.meta : null;
  const target = meta && 'target' in meta ? meta.target : null;
  if (Array.isArray(target)) return target.includes('fingerprint');
  return typeof target === 'string' && target.toLowerCase().includes('fingerprint');
}

@Injectable()
export class OperationalIncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async reconcileFingerprints(
    fingerprints: readonly string[],
    observe: IncidentSourceObserver,
  ): Promise<IncidentReconcileResult[]> {
    const ordered = this.orderedFingerprints(fingerprints);
    if (ordered.length === 0) return [];

    return this.prisma.$transaction(async (tx) => {
      await this.lockFingerprints(tx, ordered);
      const actions = this.validateActions(ordered, await observe(tx));
      const results: IncidentReconcileResult[] = [];

      for (const fingerprint of ordered) {
        const action = actions.get(fingerprint)!;
        if (action.kind === 'noop') {
          results.push({ kind: action.kind, fingerprint, incident: null });
          continue;
        }
        if (action.kind === 'signal') {
          const incident = await this.applySignal(tx, this.safeSignal(action.signal));
          results.push({ kind: action.kind, fingerprint, incident });
          continue;
        }
        const incident = await this.applyResolution(tx, action);
        results.push({ kind: action.kind, fingerprint, incident });
      }
      return results;
    });
  }

  async signal(input: IncidentSignal): Promise<OperationalIncident> {
    const reconcile = async () => {
      const [result] = await this.reconcileFingerprints([input.fingerprint], async () => [
        { kind: 'signal', signal: input },
      ]);
      if (!result.incident) {
        throw this.invalidReconciliation('Incident signal did not produce an episode.');
      }
      return result.incident;
    };
    try {
      return await reconcile();
    } catch (error) {
      if (!isFingerprintUniqueConflict(error)) throw error;
      return reconcile();
    }
  }

  private orderedFingerprints(fingerprints: readonly string[]): string[] {
    const ordered = [...new Set(fingerprints)];
    if (
      ordered.some((fingerprint) => typeof fingerprint !== 'string' || fingerprint.length === 0)
    ) {
      throw this.invalidReconciliation('Incident fingerprints must be non-empty strings.');
    }
    return ordered.sort();
  }

  private async lockFingerprints(
    tx: Prisma.TransactionClient,
    fingerprints: readonly string[],
  ): Promise<void> {
    for (const fingerprint of fingerprints) {
      await tx.$queryRaw<Array<{ locked: boolean }>>(
        Prisma.sql`
          WITH acquired AS (
            SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))
          )
          SELECT TRUE AS "locked" FROM acquired
        `,
      );
    }
  }

  private validateActions(
    fingerprints: readonly string[],
    actions: readonly IncidentReconcileAction[],
  ): Map<string, IncidentReconcileAction> {
    if (!Array.isArray(actions)) {
      throw this.invalidReconciliation('Incident observer must return an action array.');
    }
    const expected = new Set(fingerprints);
    const validated = new Map<string, IncidentReconcileAction>();
    for (const action of actions) {
      if (
        !action ||
        typeof action !== 'object' ||
        !('kind' in action) ||
        !['signal', 'resolve', 'noop'].includes(action.kind)
      ) {
        throw this.invalidReconciliation('Incident observer returned an invalid action.');
      }
      const fingerprint =
        action.kind === 'signal'
          ? action.signal?.fingerprint
          : action.kind === 'resolve' || action.kind === 'noop'
            ? action.fingerprint
            : null;
      if (
        typeof fingerprint !== 'string' ||
        !expected.has(fingerprint) ||
        validated.has(fingerprint)
      ) {
        throw this.invalidReconciliation(
          'Incident observer actions must match each locked fingerprint exactly once.',
        );
      }
      if (action.kind === 'resolve') {
        if (
          typeof action.reason !== 'string' ||
          action.reason.trim().length === 0 ||
          !action.actor ||
          typeof action.actor !== 'object' ||
          (action.actor.userId !== null && typeof action.actor.userId !== 'string') ||
          typeof action.actor.role !== 'string'
        ) {
          throw this.invalidReconciliation('Incident recovery action is invalid.');
        }
      }
      validated.set(fingerprint, action);
    }
    if (validated.size !== expected.size) {
      throw this.invalidReconciliation(
        'Incident observer actions must match each locked fingerprint exactly once.',
      );
    }
    return validated;
  }

  private safeSignal(input: IncidentSignal): IncidentSignal {
    const strings = [
      input.fingerprint,
      input.targetType,
      input.title,
      input.message,
      input.recovery,
    ];
    if (
      strings.some((value) => typeof value !== 'string' || value.length === 0) ||
      !OPERATIONAL_SCOPES.includes(input.scope) ||
      !INCIDENT_SEVERITIES.includes(input.severity) ||
      (input.targetId !== undefined &&
        input.targetId !== null &&
        typeof input.targetId !== 'string')
    ) {
      throw this.invalidReconciliation('Incident signal does not match the safe projection.');
    }
    return {
      fingerprint: input.fingerprint,
      scope: input.scope,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      severity: input.severity,
      title: input.title,
      message: input.message,
      recovery: input.recovery,
    };
  }

  private async applySignal(
    tx: Prisma.TransactionClient,
    input: IncidentSignal,
  ): Promise<OperationalIncident> {
    const current = await tx.operationalIncident.findUnique({
      where: { fingerprint: input.fingerprint },
    });
    if (current) return this.refreshEpisode(tx, current, input);

    const created = await tx.operationalIncident.create({
      data: {
        fingerprint: input.fingerprint,
        scope: input.scope,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        severity: input.severity,
        title: input.title,
        message: input.message,
        recovery: input.recovery,
        status: 'open',
      },
    });
    await this.audit.record(
      {
        type: 'admin.incident.opened',
        actorRole: 'admin',
        objectId: created.id,
        oldValue: { status: null },
        newValue: { status: 'open' },
      },
      tx,
    );
    return created;
  }

  private async applyResolution(
    tx: Prisma.TransactionClient,
    action: Extract<IncidentReconcileAction, { kind: 'resolve' }>,
  ): Promise<OperationalIncident | null> {
    const current = await tx.operationalIncident.findUnique({
      where: { fingerprint: action.fingerprint },
    });
    if (!current || current.status === 'resolved') return null;
    try {
      return await this.transitionCurrent(tx, action.actor, current, 'resolved', action.reason);
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      const latest = await tx.operationalIncident.findUnique({
        where: { fingerprint: action.fingerprint },
      });
      if (!latest || latest.status === 'resolved') return null;
      throw error;
    }
  }

  private invalidReconciliation(message: string): ConflictException {
    return new ConflictException({
      code: 'OPERATIONAL_INCIDENT_RECONCILIATION_INVALID',
      message,
    });
  }

  list(filters: { status?: string; severity?: string; scope?: string } = {}) {
    return this.prisma.operationalIncident.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.severity ? { severity: filters.severity } : {}),
        ...(filters.scope ? { scope: filters.scope } : {}),
      },
      orderBy: [{ severity: 'desc' }, { lastSeenAt: 'desc' }],
    });
  }

  acknowledge(actor: OperationalActor, id: string, reason: string) {
    return this.transition(actor, id, 'acknowledged', reason);
  }

  resolve(actor: OperationalActor, id: string, reason: string) {
    return this.transition(actor, id, 'resolved', reason);
  }

  async resolveByFingerprint(actor: OperationalActor, fingerprint: string, reason: string) {
    const [result] = await this.reconcileFingerprints([fingerprint], async (tx) => {
      const incident = await tx.operationalIncident.findUnique({ where: { fingerprint } });
      return incident && incident.status !== 'resolved'
        ? [{ kind: 'resolve', fingerprint, actor, reason }]
        : [{ kind: 'noop', fingerprint }];
    });
    return result.incident;
  }

  private async refreshEpisode(
    tx: Prisma.TransactionClient,
    initial: OperationalIncident,
    input: IncidentSignal,
  ): Promise<OperationalIncident> {
    let current = initial;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = new Date();
      if (current.status === 'resolved') {
        const claimed = await tx.operationalIncident.updateMany({
          where: { id: current.id, status: 'resolved' },
          data: {
            scope: input.scope,
            targetType: input.targetType,
            targetId: input.targetId ?? null,
            severity: input.severity,
            title: input.title,
            message: input.message,
            recovery: input.recovery,
            lastSeenAt: now,
            status: 'open',
            detectedAt: now,
            acknowledgedAt: null,
            acknowledgedById: null,
            resolvedAt: null,
            resolvedById: null,
          },
        });
        if (claimed.count === 1) {
          await this.audit.record(
            {
              type: 'admin.incident.reopened',
              actorRole: 'admin',
              objectId: current.id,
              oldValue: { status: 'resolved' },
              newValue: { status: 'open' },
            },
            tx,
          );
          return this.findIncident(tx, current.id);
        }
      } else {
        const refreshed = await tx.operationalIncident.updateMany({
          where: { id: current.id, status: { in: [...ACTIVE_INCIDENT_STATUSES] } },
          data: {
            scope: input.scope,
            targetType: input.targetType,
            targetId: input.targetId ?? null,
            severity: input.severity,
            title: input.title,
            message: input.message,
            recovery: input.recovery,
            lastSeenAt: now,
          },
        });
        if (refreshed.count === 1) return this.findIncident(tx, current.id);
      }

      current = await this.findIncident(tx, current.id);
    }

    throw new ConflictException({
      code: 'ADMIN_INCIDENT_STATE_CONFLICT',
      message: 'Incident state changed repeatedly while processing a signal.',
    });
  }

  private async findIncident(
    tx: Pick<Prisma.TransactionClient, 'operationalIncident'>,
    id: string,
  ): Promise<OperationalIncident> {
    const incident = await tx.operationalIncident.findUnique({ where: { id } });
    if (!incident) throw new NotFoundException(`Operational incident ${id} not found`);
    return incident;
  }

  private async transition(
    actor: OperationalActor,
    id: string,
    next: 'acknowledged' | 'resolved',
    reason: string,
  ): Promise<OperationalIncident> {
    return this.prisma.$transaction(async (tx) => {
      const identified = await tx.operationalIncident.findUnique({
        where: { id },
        select: { fingerprint: true },
      });
      if (!identified) throw new NotFoundException(`Operational incident ${id} not found`);
      await this.lockFingerprints(tx, [identified.fingerprint]);
      const current = await tx.operationalIncident.findUnique({ where: { id } });
      if (!current) throw new NotFoundException(`Operational incident ${id} not found`);
      return this.transitionCurrent(tx, actor, current, next, reason);
    });
  }

  private async transitionCurrent(
    tx: Prisma.TransactionClient,
    actor: OperationalActor,
    current: OperationalIncident,
    next: 'acknowledged' | 'resolved',
    reason: string,
  ): Promise<OperationalIncident> {
    if (current.status === 'resolved') {
      throw new ConflictException({
        code: 'ADMIN_INCIDENT_STATE_CONFLICT',
        message: 'Resolved incident cannot transition without a new signal.',
      });
    }
    if (next === 'acknowledged' && current.status !== 'open') {
      throw new ConflictException({
        code: 'ADMIN_INCIDENT_STATE_CONFLICT',
        message: 'Only an open incident can be acknowledged.',
      });
    }

    const now = new Date();
    const changed = await tx.operationalIncident.updateMany({
      where:
        next === 'acknowledged'
          ? { id: current.id, status: 'open' }
          : { id: current.id, status: current.status },
      data:
        next === 'acknowledged'
          ? { status: next, acknowledgedAt: now, acknowledgedById: actor.userId }
          : { status: next, resolvedAt: now, resolvedById: actor.userId },
    });
    if (changed.count !== 1) {
      const latest = await tx.operationalIncident.findUnique({ where: { id: current.id } });
      if (!latest) throw new NotFoundException(`Operational incident ${current.id} not found`);
      throw new ConflictException({
        code: 'ADMIN_INCIDENT_STATE_CONFLICT',
        message: 'Incident state changed before the transition completed.',
      });
    }

    await this.audit.record(
      {
        type: next === 'acknowledged' ? 'admin.incident.acknowledged' : 'admin.incident.resolved',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: current.id,
        oldValue: { status: current.status },
        newValue: { status: next },
        reason,
      },
      tx,
    );
    return this.findIncident(tx, current.id);
  }
}
