import type { AuditEntry } from '../types';
import { externalSourceLabel } from './sourceProjection';
import type { SourceSnapshotMeta } from './sourceContracts';

type ImportAuditInput = {
  objectId: string;
  actionLabel:
    | 'audit:payment_status_imported'
    | 'audit:invoice_status_imported'
    | 'audit:raw_material_reference_imported'
    | 'audit:inventory_fact_overrode_accounting_snapshot'
    | 'audit:shipment_completed'
    | 'audit:installment_schedule_created'
    | 'problem:inventory_source_conflict'
    | 'problem:payment_source_conflict';
  detail: string;
  meta: SourceSnapshotMeta;
  oldValue?: string;
  newValue?: string;
  reason?: string;
  scope?: AuditEntry['scope'];
};

export function importedFactAudit(input: ImportAuditInput): AuditEntry {
  return {
    id: `a-${input.actionLabel}-${input.objectId}-${input.meta.snapshotId}`,
    objectId: input.objectId,
    time: input.meta.importedAt.slice(11, 16),
    actorLabel: externalSourceLabel(input.meta.sourceKind),
    actionLabel: input.actionLabel,
    detail: input.detail,
    oldValue: input.oldValue,
    newValue: input.newValue,
    reason: input.reason,
    sourceSnapshot: `${externalSourceLabel(input.meta.sourceKind)} ${input.meta.snapshotId} · ${input.meta.capturedAt.slice(11, 16)}`,
    scope: input.scope,
  };
}
