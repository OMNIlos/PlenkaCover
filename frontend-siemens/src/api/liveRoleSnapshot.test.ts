import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from './auth';
import { clearSession, saveSession } from './authStorage';
import {
  isLiveRoleSnapshotRole,
  liveSessionFromMe,
  loadLiveRoleSnapshot,
} from './liveRoleSnapshot';
import { isRoleInboxRole } from './roleInbox';

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    userId: 'production-user',
    role: 'production_lead',
    capabilities: ['production:read'],
    displayName: 'Зав. производства',
    isActive: true,
    sessionPurpose: 'office',
    session: {
      id: 'session-1',
      purpose: 'office',
      state: 'active',
      createdAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2026-07-15T20:00:00.000Z',
      lastSeenAt: '2026-07-15T10:00:00.000Z',
    },
    workContext: {
      kind: 'office',
      assignment: { workplace: 'Цех 1', shift: 'Смена А' },
    },
    passwordChangeRequired: false,
    ...overrides,
  };
}

describe('live role profile projection', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('maps the authenticated profile to the current frontend role without fixture context', () => {
    expect(
      liveSessionFromMe(me(), 'production', 'Зав. производства', {
        notificationSound: true,
        reducedMotion: false,
      }),
    ).toMatchObject({
      id: 'production-user',
      name: 'Зав. производства',
      role: 'production',
      workplace: 'Цех 1',
      shift: 'Смена А',
      status: 'active',
      sessionState: 'active',
      notificationSound: true,
    });
  });

  it('uses the role fallback name and blocks an inactive profile', () => {
    expect(
      liveSessionFromMe(
        me({ displayName: null, isActive: false }),
        'production',
        'Зав. производства',
        { notificationSound: false, reducedMotion: true },
      ),
    ).toMatchObject({ name: 'Зав. производства', status: 'blocked', reducedMotion: true });
  });

  it('keeps seven inbox roles separate from the six shared live-snapshot roles', () => {
    expect(isRoleInboxRole('production')).toBe(true);
    expect(isRoleInboxRole('admin')).toBe(true);
    expect(isLiveRoleSnapshotRole('production')).toBe(true);
    expect(isLiveRoleSnapshotRole('admin')).toBe(false);
  });

  it('passes a cancellation signal to the inbox leg of a live snapshot', async () => {
    saveSession({
      version: 1,
      token: 'commercial-token',
      role: 'commercial',
      serverRole: 'commercial',
      userId: 'commercial-user',
      displayName: 'Коммерция',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      if (path === '/api/auth/me') {
        return Promise.resolve(
          new Response(
            JSON.stringify(
              me({
                userId: 'commercial-user',
                role: 'commercial',
                displayName: 'Коммерция',
                capabilities: ['commercial:read'],
              }),
            ),
            { status: 200 },
          ),
        );
      }
      if (path === '/api/commercial/notifications?limit=20') {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [], nextCursor: null, unreadCount: 0 }), {
            status: 200,
          }),
        );
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadLiveRoleSnapshot('commercial', { signal: controller.signal }),
    ).resolves.toMatchObject({
      role: 'commercial',
      inbox: { items: [], nextCursor: null, unreadCount: 0 },
    });
  });

  it('rejects an operator snapshot when the Big-Bag projection is unavailable', async () => {
    saveSession({
      version: 1,
      token: 'operator-token',
      role: 'operator',
      serverRole: 'operator',
      userId: 'operator-user',
      displayName: 'Оператор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      if (path === '/api/operator/big-bags') {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Big-Bag временно недоступны' }), {
            status: 503,
          }),
        );
      }
      const responses: Record<string, unknown> = {
        '/api/auth/me': me({
          userId: 'operator-user',
          role: 'operator',
          displayName: 'Оператор',
          capabilities: ['operator:read'],
        }),
        '/api/operator/notifications?limit=20': {
          items: [],
          nextCursor: null,
          unreadCount: 0,
        },
        '/api/operator/runtime': {
          shift: null,
          orders: [],
          generatedAt: '2026-07-15T10:00:00.000Z',
        },
        '/api/operator/penalties': [],
        '/api/operator/machine-changes/current': null,
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadLiveRoleSnapshot('operator', { signal: controller.signal }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'Big-Bag временно недоступны',
    });
  });

  it('puts a production-safe commercial technical action into the production snapshot', async () => {
    saveSession({
      version: 1,
      token: 'production-token',
      role: 'production',
      serverRole: 'production_lead',
      userId: 'production-user',
      displayName: 'Зав. производства',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const actionRequiredOrder = {
      id: 'commercial-order-1',
      orderNumber: 'A-701',
      requestType: 'client_order',
      stockBatchCode: null,
      counterparty: {
        id: 'counterparty-7',
        displayName: 'Клиент 7',
        legalName: null,
        inn: null,
      },
      positionCount: 2,
      requestedQty: 4,
      nextAction: {
        code: 'technical_approve_cover',
        ownerRole: 'production_lead',
        label: 'Подтвердить техническую пригодность',
        allowed: true,
      },
      updatedAt: '2026-07-15T10:00:00.000Z',
    };
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      const responses: Record<string, unknown> = {
        '/api/auth/me': me(),
        '/api/production/notifications?limit=20': { items: [], nextCursor: null },
        '/api/production/orders': [],
        '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100': {
          items: [actionRequiredOrder],
          nextCursor: null,
        },
        '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100': {
          items: [],
          nextCursor: null,
        },
        '/api/production/shifts': [],
        '/api/production/posts': [],
        '/api/production/operators/workload': [],
        '/api/penalties/snapshot': {
          items: [],
          summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
        },
        '/api/production/problems': [],
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadLiveRoleSnapshot('production');

    expect(snapshot.role).toBe('production');
    if (snapshot.role !== 'production') throw new Error('Expected production snapshot');
    expect(snapshot.orders).toEqual([
      expect.objectContaining({
        id: 'commercial-order-1',
        actions: [
          expect.objectContaining({
            id: 'production-technical-approve-cover:commercial-order-1',
          }),
        ],
      }),
    ]);
    expect(snapshot.commercialActionsState).toBe('ready');
    expect(JSON.stringify(snapshot.orders)).not.toMatch(/legalName|inn|finance|rawPayload/);
  });

  it('keeps the production snapshot usable while marking the supplemental action queue failed', async () => {
    saveSession({
      version: 1,
      token: 'production-token',
      role: 'production',
      serverRole: 'production_lead',
      userId: 'production-user',
      displayName: 'Зав. производства',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve(
          new Response(JSON.stringify({ message: 'Commercial queue unavailable' }), {
            status: 503,
          }),
        );
      }
      const responses: Record<string, unknown> = {
        '/api/auth/me': me(),
        '/api/production/notifications?limit=20': { items: [], nextCursor: null },
        '/api/production/orders': [],
        '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100': {
          items: [],
          nextCursor: null,
        },
        '/api/production/shifts': [],
        '/api/production/posts': [],
        '/api/production/operators/workload': [],
        '/api/penalties/snapshot': {
          items: [],
          summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
        },
        '/api/production/problems': [],
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadLiveRoleSnapshot('production')).resolves.toMatchObject({
      role: 'production',
      orders: [],
      commercialActionsState: 'error',
    });
  });

  it.each(['production', 'director'] as const)(
    'uses and returns the applied penalty filters in the %s periodic snapshot',
    async (role) => {
      saveSession({
        version: 1,
        token: `${role}-token`,
        role,
        serverRole: role === 'production' ? 'production_lead' : 'director',
        userId: `${role}-user`,
        displayName: role === 'production' ? 'Зав. производства' : 'Директор',
        expiresAt: '2030-01-01T00:00:00.000Z',
        passwordChangeRequired: false,
      });
      const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
        expect(init?.signal).toBe(controller.signal);
        const common: Record<string, unknown> = {
          '/api/auth/me': me({
            role: role === 'production' ? 'production_lead' : 'director',
          }),
          [`/api/${role}/notifications?limit=20`]: { items: [], nextCursor: null },
          '/api/penalties/snapshot?targetRole=operator&status=cancelled': {
            items: [],
            summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
          },
          '/api/production/orders': [],
          '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100': {
            items: [],
            nextCursor: null,
          },
          '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100': {
            items: [],
            nextCursor: null,
          },
          '/api/production/shifts': [],
          '/api/production/posts': [],
          '/api/production/problems': [],
          '/api/production/operators/workload': [],
          '/api/director/control': {
            pendingDecisions: 0,
            penalties: 0,
            overdueOrders: 0,
            penaltiesAmount: 0,
            plannedInvoicedAmount: 0,
            paidAmount: 0,
            unbilledAmount: 0,
            overdueAmount: 0,
            producedKg: 0,
            defectKg: 0,
            warehouseAcceptedRolls: 0,
          },
          '/api/director/decisions?status=pending': [],
          '/api/director/penalty-targets': [],
          '/api/director/problems': [],
        };
        if (!(path in common)) throw new Error(`Unexpected path: ${path}`);
        return Promise.resolve(new Response(JSON.stringify(common[path]), { status: 200 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();
      const filters = { targetRole: 'operator' as const, status: 'cancelled' as const };

      const result = await loadLiveRoleSnapshot(role, {
        penaltyFilters: filters,
        signal: controller.signal,
      });

      expect(result).toMatchObject({ role, penaltyFilters: filters });
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/penalties/snapshot?targetRole=operator&status=cancelled',
        expect.objectContaining({ signal: controller.signal }),
      );
    },
  );

  it('selects the current open production shift before a future planned shift', async () => {
    saveSession({
      version: 1,
      token: 'production-token',
      role: 'production',
      serverRole: 'production_lead',
      userId: 'production-user',
      displayName: 'Зав. производства',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const openShift = {
      id: 'shift-open',
      label: 'Смена А9',
      plannedStartAt: '2026-07-22T08:00:00.000Z',
      plannedEndAt: '2026-07-22T20:00:00.000Z',
      status: 'open',
      machineAssignments: [],
    };
    const futureShift = {
      id: 'shift-future',
      label: 'Следующая смена',
      plannedStartAt: '2030-07-23T08:00:00.000Z',
      plannedEndAt: '2030-07-23T20:00:00.000Z',
      status: 'planned',
      machineAssignments: [],
    };
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const responses: Record<string, unknown> = {
        '/api/auth/me': me(),
        '/api/production/notifications?limit=20': { items: [], nextCursor: null },
        '/api/production/orders': [],
        '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100': {
          items: [],
          nextCursor: null,
        },
        '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100': {
          items: [],
          nextCursor: null,
        },
        '/api/production/shifts': [futureShift, openShift],
        '/api/production/posts': [],
        '/api/production/operators/workload': [],
        '/api/penalties/snapshot': {
          items: [],
          summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
        },
        '/api/production/problems': [],
        '/api/production/shifts/shift-open/operator-machines': {
          shift: openShift,
          operators: [],
        },
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadLiveRoleSnapshot('production', { signal: controller.signal });

    expect(snapshot.role).toBe('production');
    if (snapshot.role !== 'production') throw new Error('Expected production snapshot');
    expect(snapshot.operatorMachineView?.shift.id).toBe('shift-open');
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain(
      '/api/production/shifts/shift-future/operator-machines',
    );
  });

  it('loads the director decision queue and penalty targets through one guarded snapshot', async () => {
    saveSession({
      version: 1,
      token: 'director-token',
      role: 'director',
      serverRole: 'director',
      userId: 'director-user',
      displayName: 'Директор',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const responses: Record<string, unknown> = {
        '/api/auth/me': me({
          userId: 'director-user',
          role: 'director',
          displayName: 'Директор',
          capabilities: ['director:read'],
        }),
        '/api/director/notifications?limit=20': { items: [], nextCursor: null },
        '/api/director/control': {
          pendingDecisions: 0,
          penalties: 0,
          overdueOrders: 0,
          penaltiesAmount: 0,
          plannedInvoicedAmount: 0,
          paidAmount: 0,
          unbilledAmount: 0,
          overdueAmount: 0,
          producedKg: 0,
          defectKg: 0,
          warehouseAcceptedRolls: 0,
        },
        '/api/director/decisions?status=pending': [
          {
            id: 'decision-1',
            scope: 'warehouse',
            objectId: 'problem-1',
            evidence: 'Расхождение остатка',
            ownerRole: 'warehouse',
            status: 'pending',
            severity: 'critical',
            createdAt: '2026-07-15T08:00:00.000Z',
            updatedAt: '2026-07-15T09:00:00.000Z',
          },
        ],
        '/api/penalties/snapshot': {
          items: [],
          summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
        },
        '/api/director/penalty-targets': [
          {
            id: 'operator-1',
            displayName: 'Сергей Волков',
            role: 'operator',
            isActive: true,
          },
        ],
        '/api/director/problems': [
          {
            id: 'problem-1',
            type: 'defect',
            status: 'open',
            orderId: 'order-1',
            positionId: 'position-1',
            rollId: 'ROLL-1',
            actorRole: 'operator',
            reason: 'Разрыв полотна',
            recovery: null,
            createdAt: '2026-08-16T08:30:00.000Z',
            resolvedAt: null,
            postId: 'post-1',
            post: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1', status: 'online' },
            order: { id: 'order-1', orderNumber: 'З-1' },
            defectWeightKg: 42.6,
            defectWeightCapturedAt: '2026-08-16T08:29:30.000Z',
            defectWeightSource: 'operator_scale',
          },
        ],
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadLiveRoleSnapshot('director', { signal: controller.signal });

    expect(snapshot.role).toBe('director');
    if (snapshot.role !== 'director') throw new Error('Expected director snapshot');
    expect(snapshot.penaltyTargets).toEqual([
      expect.objectContaining({ id: 'operator-1', displayName: 'Сергей Волков' }),
    ]);
    expect(snapshot.decisionObjects).toEqual([
      expect.objectContaining({
        id: 'decision-1',
        kind: 'directorDecision',
        title: 'Решение · Склад · problem-1',
      }),
    ]);
    expect(
      fetchMock.mock.calls.filter(([path]) => path === '/api/director/decisions?status=pending'),
    ).toHaveLength(1);
    expect(snapshot.problems).toEqual([
      expect.objectContaining({
        id: 'problem-1',
        defectWeightSource: 'operator_scale',
      }),
    ]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toContain('/api/director/problems');
    expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain(
      '/api/production/operators/workload',
    );
  });

  it('loads warehouse delivery and reserve tasks alongside receiving tasks', async () => {
    saveSession({
      version: 1,
      token: 'warehouse-token',
      role: 'warehouse',
      serverRole: 'warehouse',
      userId: 'warehouse-user',
      displayName: 'Склад',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const delivery = {
      id: 'delivery-1',
      mode: 'delivery',
      status: 'open',
      operationCode: null,
      orderId: 'order-1',
      positionId: null,
      proposalId: null,
      createdAt: '2026-07-15T08:00:00.000Z',
      updatedAt: '2026-07-15T08:00:00.000Z',
      lastScanResult: null,
      rows: [],
    };
    const reserve = {
      ...delivery,
      id: 'reserve-1',
      mode: 'reserve',
      orderId: 'order-2',
    };
    const coverCheck = (index: number) => ({
      caseId: `case-${index}`, orderId: `order-${index}`, orderNumber: `A-${index}`,
      customerAlias: 'Клиент', state: 'open', positions: [],
      requestedAt: delivery.createdAt, updatedAt: delivery.updatedAt,
    });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const responses: Record<string, unknown> = {
        '/api/auth/me': me({
          userId: 'warehouse-user',
          role: 'warehouse',
          displayName: 'Склад',
          capabilities: ['warehouse_task:read'],
        }),
        '/api/warehouse/notifications?limit=20': { items: [], nextCursor: null },
        '/api/warehouse/raw-materials': [],
        '/api/warehouse/cover-checks?limit=100': {
          items: Array.from({ length: 100 }, (_, index) => coverCheck(index + 1)), nextCursor: 'next-cover',
        },
        '/api/warehouse/cover-checks?limit=100&cursor=next-cover': { items: [coverCheck(101)], nextCursor: null },
        '/api/warehouse/rolls?ownership=free': [],
        '/api/warehouse/intake': {
          stats: { todayOps: 0, remainingQr: 0, errors: 0 },
          tasks: [],
          generatedAt: '2026-07-15T08:00:00.000Z',
        },
        '/api/warehouse/tasks?mode=delivery': [delivery],
        '/api/warehouse/tasks?mode=reserve': [reserve],
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await loadLiveRoleSnapshot('warehouse', { signal: controller.signal });

    expect(snapshot.role).toBe('warehouse');
    if (snapshot.role !== 'warehouse') throw new Error('Expected warehouse snapshot');
    expect(snapshot.deliveryTasks).toEqual([delivery, reserve]);
    expect(snapshot.coverChecks).toHaveLength(101);
    expect(snapshot.coverChecks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'WH-COVER-order-101' })]));
  });

  it('passes one cancellation signal to every finance snapshot request', async () => {
    saveSession({
      version: 1,
      token: 'finance-token',
      role: 'finance',
      serverRole: 'finance',
      userId: 'finance-user',
      displayName: 'Бухгалтерия',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const responses: Record<string, unknown> = {
        '/api/auth/me': me({
          userId: 'finance-user',
          role: 'finance',
          displayName: 'Бухгалтерия',
          capabilities: ['finance:read'],
        }),
        '/api/finance/notifications?limit=20': { items: [], nextCursor: null },
        '/api/finance/orders': [],
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadLiveRoleSnapshot('finance', { signal: controller.signal }),
    ).resolves.toMatchObject({ role: 'finance', orders: [] });
  });
});
