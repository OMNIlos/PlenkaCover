import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { IncidentSignal } from '@plenka/contracts';
import { OperationalIncidentsService } from './operational-incidents.service';

const SYSTEM_ACTOR = { userId: null, role: 'admin' as const };

export type IncidentReporterAction =
  | { kind: 'signal'; signal: IncidentSignal }
  | { kind: 'resolve'; fingerprint: string; reason: string }
  | { kind: 'noop'; fingerprint: string };

export type IncidentReporterObserver = (
  tx: Prisma.TransactionClient,
) => Promise<readonly IncidentReporterAction[]>;

/**
 * Best-effort bridge from an already committed physical outcome to the incident projection.
 *
 * Incident storage is secondary to the durable operation journal. A projection outage must not
 * replace the caller's original device error or turn a successful physical operation into a 5xx.
 */
@Injectable()
export class OperationalIncidentReporter {
  private readonly logger = new Logger(OperationalIncidentReporter.name);

  constructor(private readonly incidents: OperationalIncidentsService) {}

  async signal(input: IncidentSignal): Promise<void> {
    try {
      await this.incidents.signal(input);
    } catch {
      this.logger.error('Operational incident signal failed; reconciliation will retry.');
    }
  }

  async resolve(fingerprint: string, reason: string): Promise<void> {
    try {
      await this.incidents.resolveByFingerprint(SYSTEM_ACTOR, fingerprint, reason);
    } catch {
      this.logger.error(
        'Operational incident recovery projection failed; reconciliation will retry.',
      );
    }
  }

  async reconcileFingerprints(
    fingerprints: readonly string[],
    observe: IncidentReporterObserver,
  ): Promise<void> {
    try {
      await this.incidents.reconcileFingerprints(fingerprints, async (tx) =>
        (await observe(tx)).map((action) =>
          action.kind === 'resolve' ? { ...action, actor: SYSTEM_ACTOR } : action,
        ),
      );
    } catch {
      this.logger.error(
        'Operational incident source reconciliation failed; reconciliation will retry.',
      );
    }
  }
}
