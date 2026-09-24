import { apiGet, apiPatch, apiPost, apiPut } from './client';

export type AdminRole =
  | 'commercial'
  | 'production_lead'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';

export type AdminAccountStatus = 'active' | 'blocked' | 'password_setup';
export type AdminCapability = string;

export type AdminCapabilityCatalogItem = {
  key: AdminCapability;
  label: string;
  description: string;
  group: string;
  baseRoles: AdminRole[];
  grantable: boolean;
};

export type AdminUser = {
  id: string;
  externalId: string | null;
  login: string;
  displayName: string;
  role: AdminRole;
  status: AdminAccountStatus;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  capabilities: AdminCapability[];
  grants: AdminCapability[];
  denials: AdminCapability[];
  activeSessionCount: number;
};

export type AdminUserList = {
  items: AdminUser[];
  page: number;
  pageSize: number;
  total: number;
};

export type TemporaryPassword = { user: AdminUser; temporaryPassword: string };

export type AdminSession = {
  id: string;
  purpose: 'full' | 'password_setup';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  userAgent: string | null;
  ip: string | null;
};

export type AdminAccessTemplate = {
  id: string;
  name: string;
  role: AdminRole;
  setupStatus: 'draft' | 'active';
  capabilityGrants: AdminCapability[];
  capabilityDenials: AdminCapability[];
  version: number;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AdminDevice = {
  id: string;
  code: string | null;
  label: string | null;
  kind: 'scale' | 'scanner' | 'printer';
  connectionKind: string | null;
  driverName: string | null;
  driverVersion: string | null;
  isEnabled: boolean;
  status: string;
  ownerRole: AdminRole | null;
  lastSeenAt: string | null;
  lastProbeAt: string | null;
  lastTestAt: string | null;
  parsedPayload: unknown;
  recovery: string | null;
  postId: string | null;
  post: Pick<AdminPost, 'id' | 'code' | 'name' | 'status'> | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminPost = {
  id: string;
  code: string;
  name: string;
  status: string;
  commissioningState: 'uncommissioned' | 'commissioned';
  commissionedAt: string | null;
  agentStatus: string;
  lastSeenAt: string | null;
  agentProtocolVersion: number | null;
  agentPackageVersion: string | null;
  agentReleaseCommit: string | null;
  agentCapabilities: string[];
  agentCompatibility: 'unknown' | 'compatible' | 'upgrade_required' | 'unsupported';
  connectionState: 'online' | 'stale' | 'offline' | 'unknown';
  online: boolean;
  deviceCount: number;
  capabilityReady: boolean;
  missingCapabilities: string[];
  requiredCapabilityCount: number;
  createdAt: string;
  updatedAt: string;
  devices: AdminDevice[];
};

export type OneCHealth = {
  mode: 'mock' | 'http';
  status: 'ready' | 'degraded' | 'unavailable';
  checkedAt: string;
  latencyMs: number;
  endpointLabel?: string;
  errorCategory?: string;
  message?: string;
};

export type OneCSnapshot = {
  id: string;
  subjectType: string | null;
  subjectId: string | null;
  externalId: string | null;
  sourceVersion: string | null;
  sourceKind: string;
  ownerRole: AdminRole | null;
  capturedAt: string | null;
  importedAt: string | null;
  checkedAt: string | null;
  staleness: string;
  parsed: unknown;
  createdAt: string;
};

export type OneCSnapshotList = {
  items: OneCSnapshot[];
  page: number;
  pageSize: number;
  total: number;
};

export type OneCOverview = {
  connection: AdminOperationalCheck | null;
  latestBySubject: OneCSnapshot[];
  journals: Array<{
    id: string;
    entity: string;
    status: string;
    retries: number;
    recovery: string | null;
    updatedAt: string;
  }>;
  counts: { snapshots?: number; errors?: number; waiting?: number };
};

export type AdminOperationalCheck = {
  id: string;
  scope: string;
  targetType: string;
  targetId: string | null;
  status: string;
  latencyMs: number | null;
  summary: Record<string, unknown>;
  actorId: string | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

export type AdminIncident = {
  id: string;
  fingerprint: string;
  scope: string;
  targetType: string;
  targetId: string | null;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  title: string;
  message: string;
  recovery: string;
  detectedAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
};

export type PlatformHealth = {
  status: 'unknown' | 'checked' | 'ready' | 'degraded' | 'unavailable';
  service?: string;
  version?: string;
  uptimeSec?: number;
  checkedAt?: string;
  lastCheck?: AdminOperationalCheck | null;
  incidents?: AdminIncident[];
  components?: Record<
    string,
    { status: 'ready' | 'degraded' | 'unavailable'; latencyMs: number } & Record<string, unknown>
  >;
};

export type AdminAccessEvent = {
  id: string;
  type: string;
  objectId: string | null;
  actorId: string | null;
  actorRole: AdminRole;
  label: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  createdAt: string;
};

export type AdminAccessEventList = {
  items: AdminAccessEvent[];
  page: number;
  pageSize: number;
  total: number;
};

export type AdminConnectionQuality = {
  freshness: string;
  totalChecks: number;
  successfulChecks: number;
  successRatePct: number | null;
  medianLatencyMs: number | null;
  openIncidentCount: number;
};

const resource = (value: string) => encodeURIComponent(value);

export function fetchAdminUsers(
  query: { status?: AdminAccountStatus; search?: string; role?: AdminRole } = {},
) {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.search) params.set('search', query.search);
  if (query.role) params.set('role', query.role);
  params.set('page', '1');
  params.set('pageSize', '100');
  return apiGet<AdminUserList>(`/api/admin/users?${params.toString()}`);
}

export function createAdminUser(input: { login: string; displayName: string; role: AdminRole }) {
  return apiPost<TemporaryPassword>('/api/admin/users', input);
}

export function updateAdminUser(
  userId: string,
  input: { login?: string; displayName?: string; reason: string },
) {
  return apiPatch<AdminUser>(`/api/admin/users/${resource(userId)}`, input);
}

export function blockAdminUser(userId: string, reason: string) {
  return apiPost<AdminUser>(`/api/admin/users/${resource(userId)}/block`, { reason });
}

export function reactivateAdminUser(userId: string, reason: string) {
  return apiPost<AdminUser>(`/api/admin/users/${resource(userId)}/reactivate`, { reason });
}

export function resetAdminUserPassword(userId: string, reason: string) {
  return apiPost<TemporaryPassword>(`/api/admin/users/${resource(userId)}/reset-password`, {
    reason,
  });
}

export function fetchAdminUserSessions(userId: string) {
  return apiGet<AdminSession[]>(`/api/admin/users/${resource(userId)}/sessions`);
}

export function revokeAdminUserSessions(
  userId: string,
  input: { sessionId?: string; reason: string },
) {
  return apiPost<{ ok: true; revokedCount: number }>(
    `/api/admin/users/${resource(userId)}/sessions/revoke`,
    input,
  );
}

export function updateAdminUserAccess(
  userId: string,
  input: {
    role: AdminRole;
    grants: AdminCapability[];
    denials: AdminCapability[];
    reason: string;
  },
) {
  return apiPut<AdminUser>(`/api/admin/users/${resource(userId)}/access`, input);
}

export function applyAdminRoleTemplate(
  userId: string,
  input: { templateId?: string; role?: AdminRole; reason: string },
) {
  return apiPost<AdminUser>(`/api/admin/users/${resource(userId)}/role-template`, input);
}

export function fetchAdminRoleTemplates() {
  return apiGet<AdminAccessTemplate[]>('/api/admin/role-templates');
}

export function fetchAdminCapabilityCatalog() {
  return apiGet<AdminCapabilityCatalogItem[]>('/api/admin/capabilities');
}

export function createAdminRoleTemplate(input: {
  name: string;
  role: AdminRole;
  setupStatus: 'draft' | 'active';
  grants: AdminCapability[];
  denials: AdminCapability[];
  reason: string;
}) {
  return apiPost<AdminAccessTemplate>('/api/admin/role-templates', input);
}

export function updateAdminRoleTemplate(
  templateId: string,
  input: {
    expectedVersion: number;
    name?: string;
    role?: AdminRole;
    setupStatus?: 'draft' | 'active';
    grants?: AdminCapability[];
    denials?: AdminCapability[];
    reason: string;
  },
) {
  return apiPatch<AdminAccessTemplate>(`/api/admin/role-templates/${resource(templateId)}`, input);
}

export function fetchAdminDevices() {
  return apiGet<AdminDevice[]>('/api/admin/devices');
}

export function createAdminDevice(input: {
  code: string;
  label: string;
  kind: AdminDevice['kind'];
  connectionKind?: string;
  postId?: string;
  isEnabled?: boolean;
}) {
  return apiPost<AdminDevice>('/api/admin/devices', input);
}

export function updateAdminDevice(
  deviceId: string,
  input: { label?: string; connectionKind?: string; isEnabled?: boolean; reason: string },
) {
  return apiPatch<AdminDevice>(`/api/admin/devices/${resource(deviceId)}`, input);
}

export function bindAdminDevice(deviceId: string, input: { postId: string; reason: string }) {
  return apiPost<AdminDevice>(`/api/admin/devices/${resource(deviceId)}/bind`, input);
}

export function testAdminDevice(deviceId: string) {
  return apiPost<AdminDevice>(`/api/admin/devices/${resource(deviceId)}/test`);
}

export function recoverAdminDevice(deviceId: string, reason: string) {
  return apiPost<AdminDevice>(`/api/admin/devices/${resource(deviceId)}/recover`, { reason });
}

export function fetchAdminDeviceQuality(deviceId: string) {
  return apiGet<{ device: AdminDevice; quality: AdminConnectionQuality }>(
    `/api/admin/devices/${resource(deviceId)}/quality`,
  );
}

export function fetchAdminPosts() {
  return apiGet<AdminPost[]>('/api/admin/posts');
}

export function createAdminPost(input: { code: string; name: string; status?: string }) {
  return apiPost<AdminPost>('/api/admin/posts', input);
}

export function updateAdminPost(
  postId: string,
  input: { name?: string; status?: string; reason: string },
) {
  return apiPatch<AdminPost>(`/api/admin/posts/${resource(postId)}`, input);
}

export function rotateAdminPostToken(postId: string, reason: string) {
  return apiPost<{ postId: string; token: string }>(
    `/api/admin/posts/${resource(postId)}/rotate-token`,
    { reason },
  );
}

export function commissionAdminPost(postId: string, reason: string) {
  return apiPost<AdminPost>(`/api/admin/posts/${resource(postId)}/commission`, { reason });
}

export function fetchAdminPostQuality(postId: string) {
  return apiGet<{ post: AdminPost; quality: AdminConnectionQuality }>(
    `/api/admin/posts/${resource(postId)}/quality`,
  );
}

export function fetchAdminOneCOverview() {
  return apiGet<OneCOverview>('/api/admin/onec');
}

export function checkAdminOneC() {
  return apiPost<OneCHealth>('/api/admin/onec/check');
}

export function importAdminOneC(subjectType: string, externalId?: string) {
  return apiPost<unknown>('/api/admin/onec/imports', {
    subjectType,
    ...(externalId ? { externalId } : {}),
  });
}

export function retryAdminOneC(journalId: string) {
  return apiPost<unknown>(`/api/admin/onec/retries/${resource(journalId)}`);
}

export function fetchAdminOneCSnapshots() {
  return apiGet<OneCSnapshotList>('/api/admin/onec/snapshots?page=1&pageSize=100');
}

export function fetchAdminOneCRawSnapshot(snapshotId: string) {
  return apiGet<Record<string, unknown>>(`/api/admin/onec/snapshots/${resource(snapshotId)}/raw`);
}

export function fetchAdminPlatformHealth() {
  return apiGet<PlatformHealth>('/api/admin/platform-health');
}

export function checkAdminPlatformHealth() {
  return apiPost<PlatformHealth>('/api/admin/platform-health/check');
}

export function fetchAdminIncidents(
  query: {
    status?: AdminIncident['status'];
    severity?: AdminIncident['severity'];
    scope?: string;
  } = {},
) {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.severity) params.set('severity', query.severity);
  if (query.scope) params.set('scope', query.scope);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return apiGet<AdminIncident[]>(`/api/admin/incidents${suffix}`);
}

export function acknowledgeAdminIncident(incidentId: string, reason: string) {
  return apiPost<AdminIncident>(`/api/admin/incidents/${resource(incidentId)}/acknowledge`, {
    reason,
  });
}

export function resolveAdminIncident(incidentId: string, reason: string) {
  return apiPost<AdminIncident>(`/api/admin/incidents/${resource(incidentId)}/resolve`, {
    reason,
  });
}

export function recheckAdminIncident(incidentId: string) {
  return apiPost<unknown>(`/api/admin/incidents/${resource(incidentId)}/recheck`);
}

export function fetchAdminAccessEvents() {
  return apiGet<AdminAccessEventList>('/api/admin/access-events?page=1&pageSize=100');
}

export type AdminUnresolvedPrintJob = {
  kind: 'roll' | 'defect_bag' | 'big_bag' | 'pallet';
  printJobId: string;
  objectCode: string;
  createdAt: string;
};

export function fetchAdminUnresolvedPrintJobs(signal?: AbortSignal) {
  return apiGet<AdminUnresolvedPrintJob[]>('/api/admin/print-recovery/unresolved', { signal });
}

export function reconcileAdminPrintJob(
  job: AdminUnresolvedPrintJob,
  decision: { operationKey: string; outcome: 'label_observed' | 'not_printed'; reason: string },
) {
  const routes = {
    roll: '/api/admin/label-print-jobs',
    pallet: '/api/admin/pallet-print-jobs',
    defect_bag: '/api/admin/print-recovery/defect-bags',
    big_bag: '/api/admin/print-recovery/big-bags',
  };
  return apiPost(`${routes[job.kind]}/${encodeURIComponent(job.printJobId)}/reconcile`, decision);
}
