import type { Role } from './roles';

export const OPERATIONAL_SCOPES = ['onec', 'device', 'post', 'platform'] as const;
export type OperationalScope = (typeof OPERATIONAL_SCOPES)[number];

export const OPERATIONAL_CHECK_STATUSES = ['passed', 'degraded', 'failed'] as const;
export type OperationalCheckStatus = (typeof OPERATIONAL_CHECK_STATUSES)[number];

export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export interface OperationalCheckInput {
  scope: OperationalScope;
  targetType: string;
  targetId?: string | null;
  status: OperationalCheckStatus;
  summary: Record<string, unknown>;
  diagnosticRef?: string | null;
  actorId?: string | null;
  startedAt: Date;
  completedAt: Date;
}

export interface IncidentSignal {
  fingerprint: string;
  scope: OperationalScope;
  targetType: string;
  targetId?: string | null;
  severity: IncidentSeverity;
  title: string;
  message: string;
  recovery: string;
}

export interface OperationalActor {
  userId: string | null;
  role: Role;
}
