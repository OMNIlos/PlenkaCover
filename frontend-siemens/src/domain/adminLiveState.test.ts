import { describe, expect, it, vi } from 'vitest';
import { loadAdminLiveResources, reduceTemporarySecret, type AdminLiveApi } from './adminLiveState';

function api(): AdminLiveApi {
  return {
    users: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0 }),
    roleTemplates: vi.fn().mockResolvedValue([]),
    capabilities: vi.fn().mockResolvedValue([
      {
        key: 'order:read',
        label: 'Просмотр заявок',
        description: 'Просматривать безопасные данные заявок.',
        group: 'Коммерция',
        baseRoles: ['commercial'],
        grantable: true,
      },
    ]),
    devices: vi.fn().mockResolvedValue([]),
    posts: vi.fn().mockResolvedValue([]),
    oneC: vi.fn().mockResolvedValue({ latestBySubject: [], journals: [], counts: {} }),
    snapshots: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
    platformHealth: vi.fn().mockResolvedValue({ status: 'unknown', incidents: [] }),
    incidents: vi.fn().mockResolvedValue([]),
    accessEvents: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 }),
    rawSnapshot: vi.fn().mockResolvedValue({ rawPayload: { secret: 'diagnostic' } }),
  };
}

describe('admin live state', () => {
  it('loads all safe admin resources in one parallel refresh without raw diagnostics', async () => {
    const client = api();

    const result = await loadAdminLiveResources(client);

    expect(result.users.items).toEqual([]);
    expect(client.users).toHaveBeenCalledOnce();
    expect(client.roleTemplates).toHaveBeenCalledOnce();
    expect(client.capabilities).toHaveBeenCalledOnce();
    expect(result.capabilities[0]?.label).toBe('Просмотр заявок');
    expect(client.devices).toHaveBeenCalledOnce();
    expect(client.posts).toHaveBeenCalledOnce();
    expect(client.oneC).toHaveBeenCalledOnce();
    expect(client.snapshots).toHaveBeenCalledOnce();
    expect(client.platformHealth).toHaveBeenCalledOnce();
    expect(client.incidents).toHaveBeenCalledOnce();
    expect(client.accessEvents).toHaveBeenCalledOnce();
    expect(client.rawSnapshot).not.toHaveBeenCalled();
    expect(client).not.toHaveProperty('notifications');
  });

  it('keeps a temporary credential in memory only until the modal is dismissed', () => {
    const received = reduceTemporarySecret(null, {
      type: 'received',
      secret: { kind: 'password', subject: 'operator.5', value: 'once-only' },
    });

    expect(received).toEqual({ kind: 'password', subject: 'operator.5', value: 'once-only' });
    expect(reduceTemporarySecret(received, { type: 'dismissed' })).toBeNull();
  });

  it('keeps healthy resources available when one independent request fails', async () => {
    const client = api();
    vi.mocked(client.devices).mockRejectedValue(new Error('gateway unavailable'));

    const result = await loadAdminLiveResources(client);

    expect(result.users.items).toEqual([]);
    expect(result.devices).toEqual([]);
    expect(result.errors.devices).toBe('gateway unavailable');
    expect(client.rawSnapshot).not.toHaveBeenCalled();
  });
});
