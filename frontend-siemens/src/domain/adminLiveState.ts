import {
  fetchAdminAccessEvents,
  fetchAdminCapabilityCatalog,
  fetchAdminDevices,
  fetchAdminIncidents,
  fetchAdminPlatformHealth,
  fetchAdminPosts,
  fetchAdminRoleTemplates,
  fetchAdminUsers,
  type AdminAccessEventList,
  type AdminAccessTemplate,
  type AdminCapabilityCatalogItem,
  type AdminDevice,
  type AdminIncident,
  type AdminPost,
  type AdminUserList,
  type OneCOverview,
  type OneCSnapshotList,
  type PlatformHealth,
} from '../api/admin';

export type AdminLiveApi = {
  users: () => Promise<AdminUserList>;
  roleTemplates: () => Promise<AdminAccessTemplate[]>;
  capabilities: () => Promise<AdminCapabilityCatalogItem[]>;
  devices: () => Promise<AdminDevice[]>;
  posts: () => Promise<AdminPost[]>;
  oneC: () => Promise<OneCOverview>;
  snapshots: () => Promise<OneCSnapshotList>;
  platformHealth: () => Promise<PlatformHealth>;
  incidents: () => Promise<AdminIncident[]>;
  accessEvents: () => Promise<AdminAccessEventList>;
  rawSnapshot: (snapshotId: string) => Promise<Record<string, unknown>>;
};

export type AdminLiveResources = {
  users: AdminUserList;
  roleTemplates: AdminAccessTemplate[];
  capabilities: AdminCapabilityCatalogItem[];
  devices: AdminDevice[];
  posts: AdminPost[];
  oneC: OneCOverview;
  snapshots: OneCSnapshotList;
  platformHealth: PlatformHealth;
  incidents: AdminIncident[];
  accessEvents: AdminAccessEventList;
  errors: Partial<Record<AdminResourceKey, string>>;
};

export type AdminResourceKey = Exclude<keyof AdminLiveResources, 'errors'>;

const disabledOneCOverview: OneCOverview = {
  connection: null,
  latestBySubject: [],
  journals: [],
  counts: {},
};
const disabledOneCSnapshots: OneCSnapshotList = {
  items: [],
  page: 1,
  pageSize: 100,
  total: 0,
};

export const adminLiveApi: AdminLiveApi = {
  users: () => fetchAdminUsers(),
  roleTemplates: fetchAdminRoleTemplates,
  capabilities: fetchAdminCapabilityCatalog,
  devices: fetchAdminDevices,
  posts: fetchAdminPosts,
  oneC: async () => disabledOneCOverview,
  snapshots: async () => disabledOneCSnapshots,
  platformHealth: fetchAdminPlatformHealth,
  incidents: () => fetchAdminIncidents(),
  accessEvents: fetchAdminAccessEvents,
  rawSnapshot: async () => {
    throw new Error('Внешний учетный контур отключен.');
  },
};

export async function loadAdminLiveResources(
  api: AdminLiveApi = adminLiveApi,
): Promise<AdminLiveResources> {
  const [
    users,
    roleTemplates,
    capabilities,
    devices,
    posts,
    oneC,
    snapshots,
    platformHealth,
    incidents,
    accessEvents,
  ] = await Promise.allSettled([
    api.users(),
    api.roleTemplates(),
    api.capabilities(),
    api.devices(),
    api.posts(),
    api.oneC(),
    api.snapshots(),
    api.platformHealth(),
    api.incidents(),
    api.accessEvents(),
  ]);
  const errors: AdminLiveResources['errors'] = {};
  const value = <T>(key: AdminResourceKey, result: PromiseSettledResult<T>, fallback: T): T => {
    if (result.status === 'fulfilled') return result.value;
    errors[key] = result.reason instanceof Error ? result.reason.message : 'Ресурс недоступен.';
    return fallback;
  };
  return {
    users: value('users', users, { items: [], page: 1, pageSize: 100, total: 0 }),
    roleTemplates: value('roleTemplates', roleTemplates, []),
    capabilities: value('capabilities', capabilities, []),
    devices: value('devices', devices, []),
    posts: value('posts', posts, []),
    oneC: value('oneC', oneC, {
      connection: null,
      latestBySubject: [],
      journals: [],
      counts: {},
    }),
    snapshots: value('snapshots', snapshots, { items: [], page: 1, pageSize: 100, total: 0 }),
    platformHealth: value('platformHealth', platformHealth, { status: 'unknown', incidents: [] }),
    incidents: value('incidents', incidents, []),
    accessEvents: value('accessEvents', accessEvents, {
      items: [],
      page: 1,
      pageSize: 100,
      total: 0,
    }),
    errors,
  };
}

export type TemporarySecret = {
  kind: 'password' | 'gateway-token';
  subject: string;
  value: string;
};

export type TemporarySecretAction =
  | { type: 'received'; secret: TemporarySecret }
  | { type: 'dismissed' };

export function reduceTemporarySecret(
  _current: TemporarySecret | null,
  action: TemporarySecretAction,
): TemporarySecret | null {
  return action.type === 'received' ? action.secret : null;
}
