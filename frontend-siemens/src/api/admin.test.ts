import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from './authStorage';
import {
  acknowledgeAdminIncident,
  bindAdminDevice,
  checkAdminOneC,
  commissionAdminPost,
  createAdminUser,
  fetchAdminDevices,
  fetchAdminCapabilityCatalog,
  fetchAdminOneCRawSnapshot,
  fetchAdminUserSessions,
  fetchAdminUsers,
  revokeAdminUserSessions,
  rotateAdminPostToken,
  updateAdminUserAccess,
} from './admin';

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

beforeEach(() => clearSession());
afterEach(() => vi.unstubAllGlobals());

describe('admin live API', () => {
  it('loads safe account and device projections', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ items: [], page: 1, pageSize: 50, total: 0 }))
      .mockResolvedValueOnce(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAdminUsers({ status: 'active', search: 'ivan' });
    await fetchAdminDevices();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/admin/users?status=active&search=ivan&page=1&pageSize=100',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/devices');
  });

  it('loads the safe capability catalog from the protected admin endpoint', async () => {
    const catalog = [
      {
        key: 'order:read',
        label: 'Просмотр заявок',
        description: 'Просматривать безопасные данные заявок.',
        group: 'Коммерция',
        baseRoles: ['commercial'],
        grantable: true,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(okResponse(catalog));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAdminCapabilityCatalog()).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/capabilities',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('posts canonical account, access and device binding payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await createAdminUser({ login: 'operator.5', displayName: 'Оператор 5', role: 'operator' });
    await updateAdminUserAccess('user/5', {
      role: 'operator',
      grants: ['finance_order:read'],
      denials: [],
      reason: 'Временная сверка',
    });
    await bindAdminDevice('scale/5', { postId: 'post-5', reason: 'Перенос на станок 5' });
    await commissionAdminPost('post/5', 'Физическая приёмка завершена');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/users');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/users/user%2F5/access');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('PUT');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/admin/devices/scale%2F5/bind');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/admin/posts/post%2F5/commission');
    expect(fetchMock.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Физическая приёмка завершена' }),
      }),
    );
  });

  it('keeps sensitive raw and one-time credential routes explicit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await checkAdminOneC();
    await fetchAdminOneCRawSnapshot('snapshot/1');
    await rotateAdminPostToken('post/1', 'Плановая ротация');
    await acknowledgeAdminIncident('incident/1', 'Принято в работу');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/admin/onec/check',
      '/api/admin/onec/snapshots/snapshot%2F1/raw',
      '/api/admin/posts/post%2F1/rotate-token',
      '/api/admin/incidents/incident%2F1/acknowledge',
    ]);
  });

  it('lists safe session metadata and revokes only through the audited endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await fetchAdminUserSessions('user/5');
    await revokeAdminUserSessions('user/5', {
      sessionId: 'session/2',
      reason: 'Утерян рабочий ноутбук',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/users/user%2F5/sessions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/admin/users/user%2F5/sessions/revoke');
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sessionId: 'session/2',
          reason: 'Утерян рабочий ноутбук',
        }),
      }),
    );
  });
});
