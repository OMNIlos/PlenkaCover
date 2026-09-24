import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import {
  fetchRoleInbox,
  isRoleInboxRole,
  mapRoleInboxItem,
  markRoleInboxRead,
  normalizeRoleCoverage,
  roleInboxUrl,
  type RoleInboxRole,
  type ServerRoleInboxItem,
} from './roleInbox';

function roleInboxItem(
  overrides: Partial<ServerRoleInboxItem> & {
    cta?: ServerRoleInboxItem['cta'];
  } = {},
): ServerRoleInboxItem {
  return {
    id: 'event-1',
    eventType: 'audit:production_order_created',
    recipientRole: 'production_lead',
    nextOwnerRole: 'production_lead',
    severity: 'info',
    title: 'Новый заказ-наряд',
    body: 'Коммерция передала заявку в производство.',
    createdAt: '2026-07-15T10:00:00.000Z',
    unread: true,
    orderId: 'order-1',
    orderNumber: 'З-1',
    financeOrderId: null,
    caseId: null,
    taskId: null,
    positionId: null,
    rollId: null,
    cta: {
      kind: 'production_order',
      targetId: 'production-order-1',
      section: 'Заказ-наряды',
    },
    ...overrides,
  };
}

function stubFetch(json: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => json,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('role inbox routes and transport', () => {
  beforeEach(() => {
    clearSession();
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
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it.each<[RoleInboxRole, string]>([
    ['commercial', '/api/commercial/notifications'],
    ['finance', '/api/finance/notifications'],
    ['production', '/api/production/notifications'],
    ['operator', '/api/operator/notifications'],
    ['warehouse', '/api/warehouse/notifications'],
    ['director', '/api/director/notifications'],
    ['admin', '/api/admin/notifications'],
  ])('maps %s to its exact recipient endpoint', (role, endpoint) => {
    expect(roleInboxUrl(role)).toBe(endpoint);
  });

  it('sends Bearer auth/signal, encodes cursor/limit, and keeps the complete unread total', async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch({
      items: [roleInboxItem({ unread: false })],
      nextCursor: 'next/1',
      unreadCount: 37,
    });

    const page = await fetchRoleInbox('production', {
      cursor: 'cursor/one + two',
      limit: 7,
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/production/notifications?limit=7&cursor=cursor%2Fone+%2B+two',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer production-token' }),
        signal: controller.signal,
      }),
    );
    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: 'event-1',
          recipientRole: 'production',
          objectId: 'production-order-1',
          readAt: '2026-07-15T10:00:00.000Z',
          navigation: {
            section: 'Заказ-наряды',
            objectId: 'production-order-1',
          },
        }),
      ],
      nextCursor: 'next/1',
      unreadCount: 37,
    });
    expect(page.items[0]).not.toHaveProperty('cta');
    expect(page.items[0]).not.toHaveProperty('orderId');
    expect(page.items[0]).not.toHaveProperty('nextOwnerRole');
  });

  it('recognizes all seven inbox roles, including admin', () => {
    expect(
      ['commercial', 'finance', 'production', 'operator', 'warehouse', 'director', 'admin'].every(
        isRoleInboxRole,
      ),
    ).toBe(true);
  });

  it('uses the recipient endpoint and encodes an event id before marking it read', async () => {
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
    const fetchMock = stubFetch({ ok: true, eventId: 'event/with ?#' });

    await expect(markRoleInboxRead('warehouse', 'event/with ?#')).resolves.toEqual({
      ok: true,
      eventId: 'event/with ?#',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/notifications/event%2Fwith%20%3F%23/read',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'Bearer warehouse-token' }),
      }),
    );
  });

  it('does not expose an item addressed to a different backend recipient', async () => {
    stubFetch({
      items: [
        roleInboxItem({
          recipientRole: 'commercial',
          nextOwnerRole: 'commercial',
          cta: { kind: 'commercial_order', targetId: 'order-1', section: 'В работе' },
        }),
      ],
      nextCursor: null,
    });

    await expect(fetchRoleInbox('production')).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
  });

  it('keeps a non-navigable notification when the backend returns a null CTA', async () => {
    stubFetch({
      items: [
        {
          ...roleInboxItem({
            recipientRole: 'warehouse',
            nextOwnerRole: 'warehouse',
            title: 'Рулон ожидает приёмки',
          }),
          cta: null,
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    });

    const page = await fetchRoleInbox('warehouse');

    expect(page).toEqual({
      items: [
        expect.objectContaining({
          id: 'event-1',
          recipientRole: 'warehouse',
          title: 'Рулон ожидает приёмки',
        }),
      ],
      nextCursor: null,
      unreadCount: 1,
    });
    expect(page.items[0]).not.toHaveProperty('objectId');
    expect(page.items[0]).not.toHaveProperty('navigation');
  });
});

describe('role inbox presentation mapping', () => {
  it('preserves safe order information for the completed production handover', () => {
    const notification = mapRoleInboxItem(
      roleInboxItem({
        eventType: 'notification:production_order_fully_handed_over',
        title: 'Заказ ORDER-A полностью передан на склад',
        orderId: 'order-1',
        orderNumber: 'ORDER-A',
        orderInfo: {
          orderNumber: 'ORDER-A',
          rollCount: 22,
          rollCodes: Array.from({ length: 20 }, (_, index) => `ROLL-${index + 1}`),
          omittedRollCount: 2,
        },
      }),
    );

    expect(notification).toMatchObject({
      eventType: 'notification:production_order_fully_handed_over',
      title: 'Заказ ORDER-A полностью передан на склад',
      orderNumber: 'ORDER-A',
      orderInfo: {
        orderNumber: 'ORDER-A',
        rollCount: 22,
        rollCodes: Array.from({ length: 20 }, (_, index) => `ROLL-${index + 1}`),
        omittedRollCount: 2,
      },
      objectId: 'production-order-1',
    });
  });

  it('preserves exact production-problem navigation metadata', () => {
    const notification = mapRoleInboxItem(
      roleInboxItem({
        eventType: 'problem:operator_defect_reported',
        orderId: 'order-1',
        rollId: 'ROLL-1',
        cta: {
          kind: 'production_problem',
          targetId: 'problem-1',
          section: 'Проблемы',
        },
      }),
    );

    expect(notification).toMatchObject({
      recipientRole: 'production',
      objectId: 'problem-1',
      navigation: {
        kind: 'production_problem',
        section: 'Проблемы',
        problemId: 'problem-1',
        rollId: 'ROLL-1',
        orderId: 'order-1',
      },
    });
  });

  it.each(['commercial', 'director'] as const)(
    'preserves the same exact production-problem target for the %s office registry presentation',
    (recipientRole) => {
      const notification = mapRoleInboxItem(
        roleInboxItem({
          recipientRole,
          eventType: 'problem:operator_reported',
          orderId: 'order-1',
          rollId: 'ROLL-1',
          cta: {
            kind: 'production_problem',
            targetId: 'problem-1',
            section: 'Проблемы',
          },
        }),
      );

      expect(notification).toMatchObject({
        recipientRole,
        objectId: 'problem-1',
        navigation: {
          kind: 'production_problem',
          section: 'Проблемы',
          problemId: 'problem-1',
          rollId: 'ROLL-1',
        },
      });
    },
  );

  it.each<
    [
      ServerRoleInboxItem['cta']['kind'],
      ServerRoleInboxItem['recipientRole'],
      string,
      string,
      Partial<ServerRoleInboxItem>,
    ]
  >([
    ['commercial_order', 'commercial', 'В работе', 'order-1', {}],
    ['finance_order', 'finance', 'Обзор', 'finance-order-1', {}],
    ['production_order', 'production_lead', 'Заказ-наряды', 'production-order-1', {}],
    ['operator_roll', 'operator', 'Рулоны и заказы', 'ROLL-1', { rollId: 'ROLL-1' }],
    ['warehouse_intake', 'warehouse', 'Приемка', 'intake-task-1', { taskId: 'task-1' }],
    ['director_decision', 'director', 'Требуют решения', 'decision-1', {}],
    ['penalty', 'operator', 'Штрафы', 'OP-penalty-1', {}],
    ['penalty', 'production_lead', 'Штрафы', 'OP-penalty-1', {}],
  ])(
    'maps %s to an existing role section and frontend object id',
    (kind, recipientRole, section, objectId, overrides) => {
      const targetIdByKind: Record<ServerRoleInboxItem['cta']['kind'], string> = {
        commercial_order: 'order-1',
        finance_order: 'finance-order-1',
        production_order: 'production-order-1',
        operator_roll: 'ROLL-1',
        warehouse_cover: 'cover-case-1',
        warehouse_intake: 'task-1',
        director_decision: 'decision-1',
        penalty: 'penalty-1',
        production_problem: 'problem-1',
        operator_queue: 'operator-queue',
        admin_incident: 'incident-1',
      };

      expect(
        mapRoleInboxItem(
          roleInboxItem({
            recipientRole,
            nextOwnerRole: recipientRole,
            ...overrides,
            cta: { kind, targetId: targetIdByKind[kind], section },
          }),
        ),
      ).toMatchObject({
        recipientRole: recipientRole === 'production_lead' ? 'production' : recipientRole,
        objectId,
        navigation: { section, objectId },
      });
    },
  );

  it.each<
    [ServerRoleInboxItem['recipientRole'], string, string, string, Partial<ServerRoleInboxItem>]
  >([
    ['commercial', 'order-1', 'В работе', 'order-1', {}],
    [
      'production_lead',
      'order-1',
      'Заказ-наряды',
      'order-1',
      { eventType: 'audit:warehouse_cover_commercial_approved' },
    ],
    [
      'warehouse',
      'cover-case-1',
      'Запасы / резерв',
      'cover-case-1',
      { caseId: 'cover-case-1', taskId: 'cover-case-1' },
    ],
  ])(
    'maps warehouse cover for %s to that recipient queue object',
    (recipientRole, targetId, section, objectId, overrides) => {
      expect(
        mapRoleInboxItem(
          roleInboxItem({
            recipientRole,
            nextOwnerRole: recipientRole,
            ...overrides,
            cta: { kind: 'warehouse_cover', targetId, section },
          }),
        ),
      ).toMatchObject({
        recipientRole: recipientRole === 'production_lead' ? 'production' : recipientRole,
        objectId,
        navigation: { section, objectId },
      });
    },
  );

  it('does not make an unsupported director warehouse-cover presentation navigable', () => {
    const notification = mapRoleInboxItem(
      roleInboxItem({
        recipientRole: 'director',
        nextOwnerRole: 'director',
        cta: {
          kind: 'warehouse_cover',
          targetId: 'order-1',
          section: 'Требуют решения',
        },
      }),
    );

    expect(notification).not.toHaveProperty('objectId');
    expect(notification).not.toHaveProperty('navigation');
  });

  it('maps persisted financeOrderId and caseId without synthetic identifiers', () => {
    const finance = mapRoleInboxItem(
      roleInboxItem({
        recipientRole: 'finance',
        nextOwnerRole: 'finance',
        financeOrderId: 'finance-real-id',
        cta: {
          kind: 'finance_order',
          targetId: 'finance-real-id',
          section: 'Обзор',
        },
      }),
    );
    const warehouse = mapRoleInboxItem(
      roleInboxItem({
        eventType: 'audit:warehouse_coverage_recheck_requested',
        recipientRole: 'warehouse',
        nextOwnerRole: 'warehouse',
        financeOrderId: 'finance-real-id',
        caseId: 'case-real-id',
        cta: {
          kind: 'warehouse_cover',
          targetId: 'case-real-id',
          section: 'Запасы / резерв',
        },
      }),
    );

    expect(finance.objectId).toBe('finance-real-id');
    expect(warehouse.objectId).toBe('case-real-id');
    expect(JSON.stringify([finance, warehouse])).not.toMatch(/WH-COVER-/u);
  });

  it.each(['commercial', 'production', 'operator', 'director'] as const)(
    'drops protected coverage rows from the %s inbox adapter',
    (role) => {
      const projection = normalizeRoleCoverage(role, {
        workflowVersion: 2,
        state: 'awaiting_finance',
        stateVersion: 4,
        generation: 3,
        availability: 'verified_full',
        reasonCodes: ['full_cover_available'],
        nextOwner: 'finance',
        availableActions: ['use_warehouse'],
        requiredRollCount: 1,
        matchedRollCount: 1,
        uncertainRollCount: 0,
        calculatedAt: '2026-07-24T10:00:00.000Z',
        stale: false,
        financeRolls: [{ rollCode: 'SECRET-ROLL', positionId: 'secret-position' }],
        members: [{ membershipId: 'secret-membership' }],
        rows: [{ scanRowId: 'secret-row' }],
      });

      expect(JSON.stringify(projection)).not.toMatch(
        /SECRET-ROLL|financeRolls|membershipId|scanRowId/u,
      );
    },
  );

  it('opens an operator queue without retaining a foreign object selection', () => {
    const notification = mapRoleInboxItem(
      roleInboxItem({
        recipientRole: 'operator',
        nextOwnerRole: 'operator',
        rollId: null,
        cta: {
          kind: 'operator_queue',
          targetId: 'order-owned-by-another-operator',
          section: 'Рулоны и заказы',
        },
      }),
    );

    expect(notification).not.toHaveProperty('objectId');
    expect(notification.navigation).toEqual({
      kind: 'operator_queue',
      section: 'Рулоны и заказы',
    });
  });

  it('maps an administrator incident to the exact safe incident target', () => {
    const notification = mapRoleInboxItem(
      roleInboxItem({
        recipientRole: 'admin',
        nextOwnerRole: 'admin',
        orderId: null,
        cta: {
          kind: 'admin_incident',
          targetId: 'incident-17',
          section: 'Инциденты',
        },
      }),
    );

    expect(notification).toMatchObject({
      recipientRole: 'admin',
      objectId: 'incident-17',
      navigation: {
        kind: 'admin_incident',
        section: 'Инциденты',
        incidentId: 'incident-17',
      },
    });
    expect(JSON.stringify(notification)).not.toMatch(/rawPayload|adapterError|stack|token/iu);
  });
});
