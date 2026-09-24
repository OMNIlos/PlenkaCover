import type { Role } from './roles';

export const PENALTY_SNAPSHOT_TARGET_ROLES = ['operator', 'production_lead'] as const;
export type PenaltySnapshotTargetRole = (typeof PENALTY_SNAPSHOT_TARGET_ROLES)[number];

export const PENALTY_SNAPSHOT_STATUSES = ['issued', 'disputed', 'cancelled'] as const;
export type PenaltySnapshotStatus = (typeof PENALTY_SNAPSHOT_STATUSES)[number];

export type PenaltySnapshotQuery = {
  targetRole?: PenaltySnapshotTargetRole;
  status?: PenaltySnapshotStatus;
  employeeId?: string;
};

export type PenaltySnapshotItem = {
  id: string;
  employeeId: string | null;
  displayName: string | null;
  targetRole: PenaltySnapshotTargetRole;
  amountKopecks: number;
  reason: string;
  sourceObjectId: string | null;
  sourceProductionOrderId: string | null;
  sourceOrderNumber: string | null;
  sourceRollCode: string | null;
  authorRole: Role;
  status: PenaltySnapshotStatus;
  createdAt: string;
};

export type PenaltySnapshotSummary = {
  totalCount: number;
  totalAmountKopecks: number;
  topReason: string | null;
};

export type PenaltySnapshot = {
  items: PenaltySnapshotItem[];
  summary: PenaltySnapshotSummary;
};
