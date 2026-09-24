import type { OneCSubjectType } from './onec';

export const ONEC_SYNC_MODES = ['preview', 'apply', 'scheduled'] as const;
export type OneCSyncMode = (typeof ONEC_SYNC_MODES)[number];

export const ONEC_SYNC_STATUSES = ['running', 'completed', 'partial', 'failed'] as const;
export type OneCSyncStatus = (typeof ONEC_SYNC_STATUSES)[number];

export interface OneCSyncCounters {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
}

export type OneCSyncSubjectCounters = Partial<Record<OneCSubjectType, OneCSyncCounters>>;

/** Reader-safe run state. It intentionally excludes credentials and raw OData payloads. */
export interface OneCSyncResult {
  id: string;
  mode: OneCSyncMode;
  status: OneCSyncStatus;
  counters: OneCSyncSubjectCounters;
  errorCode: string | null;
  recovery: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface OneCReconciliationIssue {
  subjectType: OneCSubjectType;
  externalId: string | null;
  code: 'identity_conflict' | 'missing_reference' | 'duplicate_reference' | 'invalid_record';
  recovery: string;
}

export interface OneCReconciliationResult {
  checkedAt: string;
  latestRunId: string | null;
  status: 'ready' | 'attention_required' | 'never_synced';
  issues: OneCReconciliationIssue[];
}

export interface OneCNomenclatureListItem {
  externalId: string;
  code: string;
  article: string | null;
  name: string;
  kindName: string | null;
  unitName: string | null;
  archived: boolean;
}
