import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { RoleInboxProjectionService } from './role-inbox.service';

const createdAt = new Date('2026-07-15T08:00:00.000Z');

const actors = {
  commercial: actor('commercial'),
  finance: actor('finance'),
  operator: actor('operator'),
  warehouse: actor('warehouse'),
  director: actor('director'),
  production: actor('production_lead'),
  admin: actor('admin'),
};

function actor(role: Actor['role'], userId = `${role}-user`): Actor {
  return { userId, role, capabilities: [] };
}

function domainEvent(
  type: string,
  overrides: Partial<{
    id: string;
    objectId: string | null;
    detail: unknown;
    createdAt: Date;
    notificationReceipts: Array<{ readAt: Date }>;
  }> = {},
) {
  return {
    id: 'event-1',
    type,
    objectId: 'order-1',
    detail: null,
    createdAt,
    notificationReceipts: [],
    ...overrides,
  };
}

function order(id = 'order-1', orderNumber = 'A-1') {
  return { id, orderNumber };
}

function setup(events = [domainEvent('audit:invoice_handoff_created')]) {
  const prisma = {
    domainEvent: {
      findMany: jest.fn().mockResolvedValue(events),
      findFirst: jest.fn().mockImplementation(({ where }: { where?: { type?: string } }) =>
        where?.type === 'audit:pilot_demo_reset' ? null : (events[0] ?? null),
      ),
      count: jest.fn().mockResolvedValue(events.length),
      update: jest.fn(),
      delete: jest.fn(),
    },
    notificationReceipt: {
      upsert: jest.fn().mockResolvedValue({
        id: 'receipt-1',
        userId: 'finance-user',
        eventId: 'event-1',
        readAt: createdAt,
        acknowledgedAt: null,
      }),
    },
    commercialOrder: { findMany: jest.fn().mockResolvedValue([order()]) },
    financeOrder: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'finance-1', commercialOrderId: 'order-1', commercialOrder: order() },
        ]),
    },
    productionOrder: { findMany: jest.fn().mockResolvedValue([]) },
    warehouseAcceptanceTask: { findMany: jest.fn().mockResolvedValue([]) },
    orderResolutionCase: { findMany: jest.fn().mockResolvedValue([]) },
    rollDispatchItem: { findMany: jest.fn().mockResolvedValue([]) },
    productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
    operationalIncident: { findMany: jest.fn().mockResolvedValue([]) },
  };

  return { prisma, service: new RoleInboxProjectionService(prisma as never) };
}

describe('RoleInboxProjectionService', () => {
  it('bounds visible notifications by the latest pilot reset without deleting audit facts', async () => {
    const { service, prisma } = setup([]);
    const resetAt = new Date('2026-07-27T20:00:00.000Z');
    prisma.domainEvent.findFirst.mockImplementation(
      ({ where }: { where?: { type?: string } }) =>
        where?.type === 'audit:pilot_demo_reset' ? { createdAt: resetAt } : null,
    );

    await service.list(actors.production, 'production_lead', { limit: 20 });

    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ type: expect.any(Object) }),
            { createdAt: { gt: resetAt } },
          ],
          notificationReceipts: {
            none: { userId: 'production_lead-user' },
          },
        },
      }),
    );
    expect(prisma.domainEvent.count).toHaveBeenCalledWith({
      where: {
        AND: [
          expect.objectContaining({ type: expect.any(Object) }),
          { createdAt: { gt: resetAt } },
          { notificationReceipts: { none: { userId: 'production_lead-user' } } },
        ],
      },
    });
  });

  it('lists only safe Russian labels for changed order fields in the finance inbox', async () => {
    const event = domainEvent('notification:commercial_order_amended', {
      id: 'amendment-event-1',
      detail: {
        recipientRoles: ['finance'],
        orderId: 'order-1',
        financeOrderId: 'finance-1',
        changedFields: [
          'rollCount',
          'widthMm',
          'recipeParameters',
          'customerPrice=900000',
          'rollCount',
        ],
        oldValue: { rollCount: 1, customerPrice: 850_000 },
        newValue: { rollCount: 2, customerPrice: 900_000 },
        rawPayload: { token: 'do-not-expose' },
      },
    });
    const { service } = setup([event]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'amendment-event-1',
        body: 'Коммерция изменила параметры заявки: количество рулонов, ширина, параметры рецептуры. Проверьте актуальный финансовый маршрут.',
      }),
    ]);
    expect(JSON.stringify(page.items[0])).not.toMatch(
      /customerPrice|850000|900000|rawPayload|do-not-expose/u,
    );
  });

  it('keeps the generic finance body when an amendment has no safe changed fields', async () => {
    const event = domainEvent('notification:commercial_order_amended', {
      id: 'amendment-event-1',
      detail: {
        recipientRoles: ['finance'],
        orderId: 'order-1',
        financeOrderId: 'finance-1',
        field: 'commercialFinanceNote',
      },
    });
    const { service } = setup([event]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        body: 'Коммерция изменила данные заявки. Проверьте актуальный финансовый маршрут.',
      }),
    ]);
  });

  it('fans a post-error correction to related roles and only the assigned operator', async () => {
    const event = domainEvent('notification:commercial_correction_applied', {
      id: 'correction-event-1',
      detail: {
        notificationKey: 'correction:case-1:v2',
        recipientRoles: [
          'commercial',
          'production_lead',
          'operator',
          'warehouse',
          'finance',
          'director',
        ],
        recipientUserIds: ['operator-user'],
        orderId: 'order-1',
        productionOrderId: 'production-1',
        positionId: 'position-1',
        rollIds: ['ROLL-1'],
        recipeParameters: { secretFormula: '70/30' },
        invoiceAmount: 900_000,
        rawPayload: { token: 'do-not-expose' },
      },
    });
    const relatedRoles = [
      actors.commercial,
      actors.production,
      actors.operator,
      actors.warehouse,
      actors.finance,
      actors.director,
    ] as const;

    for (const relatedActor of relatedRoles) {
      const { service, prisma } = setup([event]);
      prisma.productionOrder.findMany.mockResolvedValue([
        {
          id: 'production-1',
          commercialOrderId: 'order-1',
          commercialOrder: order(),
        },
      ]);
      prisma.rollDispatchItem.findMany.mockResolvedValue([
        {
          id: 'dispatch-1',
          rollCode: 'ROLL-1',
          productionOrderId: 'production-1',
          orderLineId: 'position-1',
          assignedOperatorId: 'operator-user',
          productionOrder: { commercialOrder: order() },
        },
      ]);

      const page = await service.list(relatedActor, relatedActor.role, { limit: 20 });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toEqual(
        expect.objectContaining({
          id: 'correction-event-1',
          recipientRole: relatedActor.role,
          orderId: 'order-1',
          orderNumber: 'A-1',
          positionId: 'position-1',
        }),
      );
      expect(JSON.stringify(page.items[0])).not.toMatch(
        /secretFormula|70\/30|invoiceAmount|900000|rawPayload|do-not-expose/u,
      );
    }

    const { service: unrelatedService, prisma: unrelatedPrisma } = setup([event]);
    unrelatedPrisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        productionOrderId: 'production-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrder: { commercialOrder: order() },
      },
    ]);
    const unrelated = await unrelatedService.list(
      actor('operator', 'unrelated-operator'),
      'operator',
      { limit: 20 },
    );

    expect(unrelated.items).toEqual([]);
  });

  it('keeps a safe related-role alert visible with a null CTA when its object is unavailable', async () => {
    const event = domainEvent('notification:commercial_correction_applied', {
      objectId: 'missing-order',
      detail: {
        notificationKey: 'correction:missing:v1',
        recipientRoles: ['finance'],
        recipientUserIds: [],
        orderId: 'missing-order',
        positionId: 'position-1',
        recipeParameters: { secretFormula: '70/30' },
      },
    });
    const { service, prisma } = setup([event]);
    prisma.commercialOrder.findMany.mockResolvedValue([]);
    prisma.financeOrder.findMany.mockResolvedValue([]);
    prisma.productionOrder.findMany.mockResolvedValue([]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'event-1',
        orderId: 'missing-order',
        orderNumber: null,
        positionId: 'position-1',
        cta: null,
      }),
    ]);
    expect(JSON.stringify(page)).not.toMatch(/secretFormula|70\/30/u);
    await expect(service.markRead(actors.finance, 'finance', event.id)).resolves.toEqual({
      ok: true,
      eventId: event.id,
    });
    expect(prisma.notificationReceipt.upsert).toHaveBeenCalledWith({
      where: {
        userId_eventId: {
          userId: 'finance-user',
          eventId: event.id,
        },
      },
      create: {
        userId: 'finance-user',
        eventId: event.id,
      },
      update: {},
    });
  });

  it('projects the completed production handover as one safe order notification', async () => {
    const rollCodes = Array.from({ length: 22 }, (_, index) => `ROLL-${index + 1}`);
    const event = domainEvent('notification:production_order_fully_handed_over', {
      id: 'production-complete-event',
      detail: {
        notificationKey: 'production-order-fully-handed-over:production-1:dispatch-1,dispatch-2',
        recipientRoles: ['production_lead'],
        recipientUserIds: [],
        orderId: 'order-1',
        orderNumber: 'ORDER-A',
        productionOrderId: 'production-1',
        rollCount: rollCodes.length,
        rollIds: rollCodes,
        rawPayload: { token: 'do-not-expose' },
      },
    });
    const { service, prisma } = setup([event]);
    prisma.commercialOrder.findMany.mockResolvedValue([order('order-1', 'ORDER-A')]);
    prisma.financeOrder.findMany.mockResolvedValue([]);
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        id: 'production-1',
        commercialOrderId: 'order-1',
        commercialOrder: order('order-1', 'ORDER-A'),
      },
    ]);

    const page = await service.list(actors.production, 'production_lead', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'production-complete-event',
        title: 'Заказ ORDER-A полностью передан на склад',
        body: 'Все рулоны заказа переданы на склад. Информация о заказе доступна ниже.',
        orderId: 'order-1',
        orderNumber: 'ORDER-A',
        orderInfo: {
          orderNumber: 'ORDER-A',
          rollCount: 22,
          rollCodes: rollCodes.slice(0, 20),
          omittedRollCount: 2,
        },
        cta: {
          kind: 'production_order',
          targetId: 'production-1',
          section: 'Заказ-наряды',
        },
      }),
    ]);
    expect(JSON.stringify(page.items[0])).not.toMatch(
      /notificationKey|recipientRoles|rollIds|rawPayload|do-not-expose/u,
    );
  });

  it('projects one notification when an idempotent command repeats the same notification key', async () => {
    const detail = {
      notificationKey: 'correction:case-1:v2',
      recipientRoles: ['finance'],
      recipientUserIds: [],
      orderId: 'order-1',
      positionId: 'position-1',
    };
    const { service, prisma } = setup([
      domainEvent('notification:commercial_correction_applied', {
        id: 'correction-event-2',
        detail,
      }),
      domainEvent('notification:commercial_correction_applied', {
        id: 'correction-event-1',
        detail,
      }),
    ]);
    prisma.domainEvent.count.mockResolvedValue(2);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe('correction-event-2');
    expect(page.unreadCount).toBe(1);
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('keeps an intentional machine-change alert personal to its operator', async () => {
    const event = domainEvent('notification:operator_machine_change_requested', {
      objectId: 'assignment-1',
      detail: {
        notificationKey: 'machine-change:change-1:requested',
        recipientRoles: ['operator', 'production_lead', 'director'],
        recipientUserIds: ['operator-user'],
        changeId: 'change-1',
        operatorId: 'operator-user',
        fromPostId: 'post-1',
        toPostId: 'post-2',
        rawPayload: { token: 'do-not-expose' },
      },
    });
    const { service, prisma } = setup([event]);
    prisma.commercialOrder.findMany.mockResolvedValue([]);
    prisma.productionOrder.findMany.mockResolvedValue([]);

    const own = await service.list(actors.operator, 'operator', { limit: 20 });
    const unrelatedSetup = setup([event]);
    unrelatedSetup.prisma.domainEvent.count.mockResolvedValue(0);
    unrelatedSetup.prisma.commercialOrder.findMany.mockResolvedValue([]);
    unrelatedSetup.prisma.productionOrder.findMany.mockResolvedValue([]);
    const unrelated = await unrelatedSetup.service.list(
      actor('operator', 'unrelated-operator'),
      'operator',
      { limit: 20 },
    );

    expect(own.items).toEqual([
      expect.objectContaining({
        recipientRole: 'operator',
        taskId: 'change-1',
        orderId: null,
        cta: null,
      }),
    ]);
    expect(unrelated).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
    expect(JSON.stringify(own)).not.toMatch(/fromPostId|toPostId|rawPayload|do-not-expose/u);
    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                expect.objectContaining({
                  type: 'notification:operator_machine_change_requested',
                  AND: expect.arrayContaining([
                    {
                      detail: {
                        path: ['recipientUserIds'],
                        array_contains: 'operator-user',
                      },
                    },
                  ]),
                }),
              ]),
            },
          ]),
        }),
      }),
    );
  });

  it('projects a defect only to the explicitly related operator account', async () => {
    const event = domainEvent('problem:operator_defect_reported', {
      detail: {
        notificationKey: 'defect:problem-1:reported',
        recipientRoles: ['operator', 'production_lead', 'director'],
        recipientUserIds: ['operator-user'],
        problemId: 'problem-1',
        orderId: 'order-1',
        productionOrderId: 'production-1',
        positionId: 'position-1',
        rollId: 'ROLL-1',
      },
    });
    const { service, prisma } = setup([event]);
    prisma.productionOrder.findMany.mockResolvedValue([
      {
        id: 'production-1',
        commercialOrderId: 'order-1',
        commercialOrder: order(),
      },
    ]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        productionOrderId: 'production-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    const own = await service.list(actors.operator, 'operator', { limit: 20 });
    const unrelatedSetup = setup([event]);
    unrelatedSetup.prisma.domainEvent.count.mockResolvedValue(0);
    const unrelated = await unrelatedSetup.service.list(
      actor('operator', 'unrelated-operator'),
      'operator',
      { limit: 20 },
    );

    expect(own.items).toEqual([
      expect.objectContaining({
        recipientRole: 'operator',
        orderId: 'order-1',
        positionId: 'position-1',
        rollId: 'ROLL-1',
        cta: {
          kind: 'operator_roll',
          targetId: 'ROLL-1',
          section: 'Рулоны и заказы',
        },
      }),
    ]);
    expect(unrelated).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it('fails closed for an operator alert without explicit recipient metadata', async () => {
    const event = domainEvent('problem:operator_defect_reported', {
      detail: {
        notificationKey: 'defect:problem-1:reported',
        problemId: 'problem-1',
        orderId: 'order-1',
        rollId: 'ROLL-1',
      },
    });
    const { service, prisma } = setup([event]);
    prisma.domainEvent.count.mockResolvedValue(0);

    await expect(service.list(actors.operator, 'operator', { limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    await expect(
      service.markRead(actors.operator, 'operator', event.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('routes a penalty only to the selected employee and opens the personal penalty section', async () => {
    const event = domainEvent('notification:penalty_created', {
      objectId: 'penalty-1',
      detail: {
        targetRole: 'operator',
        employeeId: 'operator-user',
        employeeName: 'Илья Ковалёв',
        amount: 1500,
        reason: 'Недовес рулона',
        productionOrderId: 'production-order-1',
        orderNumber: 'A-501',
        rollCode: 'A-501-roll-2',
        invoiceAmount: 900_000,
        orderTotal: 1_200_000,
        paymentSchedules: [{ amount: 450_000 }],
      },
    });
    const { service, prisma } = setup([event]);
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        id: 'finance-1',
        commercialOrderId: 'order-1',
        amountValue: 900_000,
        schedules: [{ amount: 450_000 }],
        commercialOrder: order(),
      },
    ]);

    const own = await service.list(actors.operator, 'operator', { limit: 20 });
    const other = await service.list(actor('operator', 'other-operator'), 'operator', {
      limit: 20,
    });

    expect(own.items).toEqual([
      expect.objectContaining({
        eventType: 'notification:penalty_created',
        recipientRole: 'operator',
        orderId: null,
        orderNumber: 'A-501',
        rollId: 'A-501-roll-2',
        body: 'Получатель: Илья Ковалёв (оператор). Причина: Недовес рулона. Сумма: 1 500 ₽. Заказ A-501 · рулон A-501-roll-2.',
        cta: { kind: 'penalty', targetId: 'penalty-1', section: 'Штрафы' },
      }),
    ]);
    expect(other.items).toEqual([]);
    await expect(
      service.markRead(actor('operator', 'other-operator'), 'operator', event.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
    expect(prisma.financeOrder.findMany).toHaveBeenCalled();
    expect(JSON.stringify(prisma.financeOrder.findMany.mock.calls)).not.toMatch(
      /amountValue|schedules/u,
    );
    const serializedOwnInbox = JSON.stringify(own);
    expect(serializedOwnInbox).not.toMatch(
      /invoiceAmount|orderTotal|paymentSchedules|900\s?000|1\s?200\s?000|450\s?000/u,
    );
  });

  it('routes a production-lead penalty only to the selected lead', async () => {
    const event = domainEvent('notification:penalty_created', {
      objectId: 'penalty-lead-1',
      detail: {
        targetRole: 'production_lead',
        employeeId: 'production_lead-user',
        employeeName: 'Артур Кольцов',
        amount: 2000,
        reason: 'Нарушение регламента',
        sourceObjectId: 'A-501',
      },
    });
    const { service } = setup([event]);

    const page = await service.list(actors.production, 'production_lead', { limit: 20 });
    const other = await service.list(
      actor('production_lead', 'other-production-lead'),
      'production_lead',
      { limit: 20 },
    );

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        recipientRole: 'production_lead',
        body: 'Получатель: Артур Кольцов (зав. производства). Причина: Нарушение регламента. Сумма: 2 000 ₽. Объект: A-501.',
        cta: { kind: 'penalty', targetId: 'penalty-lead-1', section: 'Штрафы' },
      }),
    );
    expect(other.items).toEqual([]);
  });

  it('scopes penalty events to the employee before pagination is applied', async () => {
    const event = domainEvent('notification:penalty_created', {
      objectId: 'penalty-1',
      detail: { targetRole: 'operator', employeeId: 'operator-user', amount: 1500 },
    });
    const { service, prisma } = setup([event]);

    await service.list(actors.operator, 'operator', { limit: 20 });

    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                {
                  type: {
                    notIn: expect.arrayContaining(['notification:penalty_created']),
                  },
                },
                {
                  type: 'notification:penalty_created',
                  objectId: { not: null },
                  AND: [
                    { detail: { path: ['targetRole'], equals: 'operator' } },
                    { detail: { path: ['employeeId'], equals: 'operator-user' } },
                  ],
                },
              ]),
            },
          ]),
        }),
        take: 21,
      }),
    );
  });

  it('projects an invoice handoff to finance with a finance-order CTA', async () => {
    const { service } = setup();

    await expect(service.list(actors.finance, 'finance', { limit: 20 })).resolves.toEqual({
      items: [
        {
          id: 'event-1',
          eventIds: ['event-1'],
          eventType: 'audit:invoice_handoff_created',
          recipientRole: 'finance',
          nextOwnerRole: 'finance',
          severity: 'info',
          title: 'Новая заявка на счёт',
          body: 'Коммерция передала заявку для выставления счёта.',
          createdAt: '2026-07-15T08:00:00.000Z',
          unread: true,
          orderId: 'order-1',
          orderNumber: 'A-1',
          financeOrderId: 'finance-1',
          caseId: null,
          taskId: null,
          positionId: null,
          rollId: null,
          cta: { kind: 'finance_order', targetId: 'finance-1', section: 'Обзор' },
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    });
  });

  it('projects a warehouse cover request to the stock-reservation section', async () => {
    const event = domainEvent('audit:warehouse_cover_recheck_requested');
    const { service, prisma } = setup([event]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'case-1',
        orderId: 'order-1',
        problemId: null,
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        affectedPositionIds: ['position-1'],
        affectedRollIds: [],
        order: order(),
      },
    ]);

    const page = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        eventType: 'audit:warehouse_cover_recheck_requested',
        recipientRole: 'warehouse',
        taskId: 'case-1',
        positionId: 'position-1',
        cta: {
          kind: 'warehouse_cover',
          targetId: 'case-1',
          section: 'Запасы / резерв',
        },
      }),
    );
  });

  it('uses persisted finance-order and V2 recheck-case IDs in coverage CTAs', async () => {
    const calculation = domainEvent('audit:warehouse_coverage_calculated', {
      id: 'event-calculation',
      objectId: 'order-1',
      detail: { workflowVersion: 2, generation: 3 },
    });
    const recheck = domainEvent('audit:warehouse_coverage_recheck_requested', {
      id: 'event-recheck',
      objectId: 'order-1',
      detail: {
        workflowVersion: 2,
        orderId: 'order-1',
        caseId: 'coverage-case-1',
        generation: 3,
      },
    });
    const { service, prisma } = setup([calculation, recheck]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'coverage-case-1',
        orderId: 'order-1',
        problemId: null,
        type: 'warehouse_coverage_recheck',
        status: 'open',
        ownerRole: 'warehouse',
        affectedPositionIds: [],
        affectedRollIds: [],
        order: order(),
      },
    ]);

    const finance = await service.list(actors.finance, 'finance', { limit: 20 });
    const warehouse = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(finance.items).toEqual([
      expect.objectContaining({
        eventType: 'audit:warehouse_coverage_calculated',
        financeOrderId: 'finance-1',
        caseId: null,
        cta: { kind: 'finance_order', targetId: 'finance-1', section: 'Обзор' },
      }),
    ]);
    expect(warehouse.items).toEqual([
      expect.objectContaining({
        eventType: 'audit:warehouse_coverage_recheck_requested',
        financeOrderId: 'finance-1',
        caseId: 'coverage-case-1',
        cta: {
          kind: 'warehouse_cover',
          targetId: 'coverage-case-1',
          section: 'Запасы / резерв',
        },
      }),
    ]);
    expect(JSON.stringify([finance.items, warehouse.items])).not.toContain('WH-COVER-');
  });

  it('retains the persisted V2 recheck case ID after resolution routes back to finance', async () => {
    const resolved = domainEvent('audit:warehouse_coverage_recheck_resolved', {
      id: 'event-resolved',
      objectId: 'order-1',
      detail: {
        workflowVersion: 2,
        orderId: 'order-1',
        caseId: 'coverage-case-resolved',
        generation: 4,
      },
    });
    const { service, prisma } = setup([resolved]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'coverage-case-resolved',
        orderId: 'order-1',
        problemId: null,
        type: 'warehouse_coverage_recheck',
        status: 'resolved',
        ownerRole: 'finance',
        affectedPositionIds: [],
        affectedRollIds: [],
        order: order(),
      },
    ]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        eventType: 'audit:warehouse_coverage_recheck_resolved',
        financeOrderId: 'finance-1',
        caseId: 'coverage-case-resolved',
        cta: { kind: 'finance_order', targetId: 'finance-1', section: 'Обзор' },
      }),
    ]);
  });

  it('projects an automatic delivery task to warehouse control without financial data', async () => {
    const event = domainEvent('audit:warehouse_delivery_task_created', {
      objectId: 'delivery-1',
      detail: {
        orderId: 'order-1',
        orderNumber: 'A-1',
        warehouseTaskId: 'delivery-1',
        rollCodes: ['ROLL-1'],
        amountValue: 900_000,
      },
    });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'same-order-unrelated-task',
        orderId: 'order-1',
        positionId: null,
        proposalId: null,
        rows: [{ rollCode: 'OTHER-ROLL', fromOrderId: 'A-1' }],
      },
      {
        id: 'delivery-1',
        orderId: 'order-1',
        positionId: null,
        proposalId: null,
        rows: [{ rollCode: 'ROLL-1', fromOrderId: 'A-1' }],
      },
    ]);

    const page = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        eventType: 'audit:warehouse_delivery_task_created',
        recipientRole: 'warehouse',
        orderId: 'order-1',
        orderNumber: 'A-1',
        taskId: 'delivery-1',
        cta: { kind: 'warehouse_intake', targetId: 'delivery-1', section: 'Выдача' },
      }),
    );
    expect(JSON.stringify(page.items[0])).not.toContain('amount');
  });

  it('lists and marks an objectId-only delivery event for warehouse without leaking it', async () => {
    const event = domainEvent('audit:warehouse_delivery_task_created', {
      objectId: 'delivery-object-only',
      detail: null,
    });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'delivery-object-only',
        orderId: 'order-1',
        positionId: null,
        proposalId: null,
        rows: [{ rollCode: 'ROLL-SAFE', fromOrderId: 'A-1' }],
      },
    ]);

    const page = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        eventType: 'audit:warehouse_delivery_task_created',
        recipientRole: 'warehouse',
        orderId: 'order-1',
        orderNumber: 'A-1',
        taskId: 'delivery-object-only',
        rollId: 'ROLL-SAFE',
        cta: {
          kind: 'warehouse_intake',
          targetId: 'delivery-object-only',
          section: 'Выдача',
        },
      }),
    ]);
    await expect(service.markRead(actors.warehouse, 'warehouse', event.id)).resolves.toEqual({
      ok: true,
      eventId: event.id,
    });
    expect(prisma.notificationReceipt.upsert).toHaveBeenCalledWith({
      where: { userId_eventId: { userId: 'warehouse-user', eventId: event.id } },
      create: { userId: 'warehouse-user', eventId: event.id },
      update: {},
    });

    await expect(service.list(actors.commercial, 'commercial', { limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 1,
    });
    await expect(
      service.markRead(actors.commercial, 'commercial', event.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses only a valid warehouse-cover case when order tasks and cases collide', async () => {
    const event = domainEvent('audit:warehouse_cover_recheck_requested', {
      detail: { taskId: 'intake-task', positionId: 'cover-position' },
    });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'intake-task',
        orderId: 'order-1',
        positionId: 'intake-position',
        proposalId: null,
        rows: [{ rollCode: 'INTAKE-ROLL', fromOrderId: 'A-1' }],
      },
      {
        id: 'reserve-task',
        orderId: 'order-1',
        positionId: 'reserve-position',
        proposalId: 'proposal-1',
        rows: [{ rollCode: 'RESERVE-ROLL', fromOrderId: 'A-1' }],
      },
    ]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'correction-case',
        orderId: 'order-1',
        problemId: 'problem-1',
        type: 'production_recipe_correction',
        status: 'open',
        ownerRole: 'commercial',
        affectedPositionIds: ['wrong-position'],
        affectedRollIds: ['WRONG-ROLL'],
        order: order(),
      },
      {
        id: 'cover-case',
        orderId: 'order-1',
        problemId: null,
        type: 'warehouse_cover_check',
        status: 'open',
        ownerRole: 'warehouse',
        affectedPositionIds: ['cover-position'],
        affectedRollIds: ['COVER-ROLL'],
        order: order(),
      },
    ]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'unrelated-dispatch',
        rollCode: 'UNRELATED-ROLL',
        orderLineId: 'cover-position',
        assignedOperatorId: null,
        productionOrderId: 'unrelated-production',
        productionOrder: {
          commercialOrder: order('unrelated-order', 'Z-9'),
        },
      },
    ]);

    const page = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        orderId: 'order-1',
        taskId: 'cover-case',
        positionId: 'cover-position',
        rollId: 'COVER-ROLL',
        cta: expect.objectContaining({ targetId: 'cover-case' }),
      }),
    );
  });

  it('drops and cannot mark a cover event resolved only by unrelated order aggregates', async () => {
    const event = domainEvent('audit:warehouse_cover_recheck_requested');
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'intake-task',
        orderId: 'order-1',
        positionId: 'intake-position',
        proposalId: null,
        rows: [{ rollCode: 'INTAKE-ROLL', fromOrderId: 'A-1' }],
      },
    ]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'wrong-type',
        orderId: 'order-1',
        problemId: 'problem-1',
        type: 'material_shortage_correction',
        status: 'open',
        ownerRole: 'commercial',
        affectedPositionIds: [],
        affectedRollIds: [],
        order: order(),
      },
      {
        id: 'closed-cover',
        orderId: 'order-1',
        problemId: null,
        type: 'warehouse_cover_check',
        status: 'resolved',
        ownerRole: 'warehouse',
        affectedPositionIds: [],
        affectedRollIds: [],
        order: order(),
      },
    ]);

    await expect(service.list(actors.warehouse, 'warehouse', { limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 1,
    });
    await expect(service.markRead(actors.warehouse, 'warehouse', 'event-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('resolves warehouse intake only through the explicitly linked roll row', async () => {
    const event = domainEvent('audit:operator_roll_handed_over', {
      detail: { orderId: 'order-1', rollId: 'ROLL-1' },
    });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'same-order-unrelated-task',
        orderId: 'order-1',
        positionId: 'wrong-position',
        proposalId: null,
        rows: [{ rollCode: 'OTHER-ROLL', fromOrderId: 'A-1' }],
      },
      {
        id: 'linked-task',
        orderId: 'another-order',
        positionId: 'position-1',
        proposalId: null,
        rows: [{ rollCode: 'ROLL-1', fromOrderId: 'A-1' }],
      },
    ]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    const page = await service.list(actors.warehouse, 'warehouse', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        taskId: 'linked-task',
        positionId: 'position-1',
        rollId: 'ROLL-1',
        cta: expect.objectContaining({ targetId: 'linked-task' }),
      }),
    );
  });

  it('resolves a shipped warehouse task to finance through its order number', async () => {
    const event = domainEvent('audit:warehouse_roll_shipped', { objectId: 'task-1' });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'task-1',
        orderId: null,
        positionId: null,
        proposalId: null,
        rows: [{ rollCode: 'ROLL-1', fromOrderId: 'A-1' }],
      },
    ]);
    prisma.financeOrder.findMany.mockImplementation(async (query: unknown) =>
      JSON.stringify(query).includes('orderNumber')
        ? [{ id: 'finance-1', commercialOrderId: 'order-1', commercialOrder: order() }]
        : [],
    );

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        orderId: 'order-1',
        orderNumber: 'A-1',
        taskId: 'task-1',
        cta: expect.objectContaining({ kind: 'finance_order', targetId: 'finance-1' }),
      }),
    );
  });

  it('keeps the originating warehouse task on the deferred-payment notification', async () => {
    const event = domainEvent('audit:deferred_payment_due_scheduled', {
      objectId: 'finance-1',
      detail: {
        commercialOrderId: 'order-1',
        financeOrderId: 'finance-1',
        warehouseTaskId: 'task-1',
      },
    });
    const { service, prisma } = setup([event]);
    prisma.warehouseAcceptanceTask.findMany.mockResolvedValue([
      {
        id: 'task-1',
        orderId: 'order-1',
        positionId: 'position-1',
        proposalId: null,
        rows: [{ rollCode: 'ROLL-1', fromOrderId: 'A-1' }],
      },
    ]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items[0]).toEqual(
      expect.objectContaining({
        orderId: 'order-1',
        taskId: 'task-1',
        positionId: 'position-1',
        rollId: 'ROLL-1',
        cta: expect.objectContaining({ kind: 'finance_order', targetId: 'finance-1' }),
      }),
    );
  });

  it('uses recipient-specific presentation for the same event', async () => {
    const event = domainEvent('problem:raw_material_shortage', { detail: { caseId: 'case-1' } });
    const { service, prisma } = setup([event]);
    prisma.orderResolutionCase.findMany.mockResolvedValue([
      {
        id: 'case-1',
        orderId: 'order-1',
        problemId: null,
        type: 'material_shortage_correction',
        status: 'open',
        ownerRole: 'director',
        affectedPositionIds: [],
        affectedRollIds: [],
        order: order(),
      },
    ]);

    const commercial = await service.list(actors.commercial, 'commercial', { limit: 20 });
    const director = await service.list(actors.director, 'director', { limit: 20 });

    expect(commercial.items[0]).toEqual(
      expect.objectContaining({
        recipientRole: 'commercial',
        title: 'Не хватает сырья',
        cta: expect.objectContaining({ kind: 'commercial_order', targetId: 'order-1' }),
      }),
    );
    expect(director.items[0]).toEqual(
      expect.objectContaining({
        recipientRole: 'director',
        title: 'Сырьё блокирует выполнение',
        cta: expect.objectContaining({ kind: 'director_decision', targetId: 'case-1' }),
      }),
    );
  });

  it('uses a stable (createdAt,id) cursor when timestamps are equal', async () => {
    const newerId = domainEvent('audit:invoice_handoff_created', { id: 'event-b' });
    const olderId = domainEvent('audit:invoice_handoff_created', { id: 'event-a' });
    const { service, prisma } = setup([newerId, olderId]);

    const first = await service.list(actors.finance, 'finance', { limit: 1 });
    prisma.domainEvent.findMany.mockResolvedValueOnce([olderId]);
    const second = await service.list(actors.finance, 'finance', {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.items.map((item: { id: string }) => item.id)).toEqual(['event-b']);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items.map((item: { id: string }) => item.id)).toEqual(['event-a']);
    expect(prisma.domainEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            expect.objectContaining({ type: expect.any(Object) }),
            {
              OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'event-b' } }],
            },
          ],
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
  });

  it('removes read notifications from the operational inbox without mutating DomainEvent', async () => {
    const readEvent = domainEvent('audit:invoice_handoff_created', {
      notificationReceipts: [{ readAt: createdAt }],
    });
    const { service, prisma } = setup([readEvent]);
    prisma.domainEvent.count.mockResolvedValue(0);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });

    expect(page.items).toEqual([]);
    expect(page.unreadCount).toBe(0);
    expect(prisma.domainEvent.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.delete).not.toHaveBeenCalled();
  });

  it('upserts the same receipt identity for repeated markRead calls', async () => {
    const { service, prisma } = setup();

    const first = await service.markRead(actors.finance, 'finance', 'event-1');
    const second = await service.markRead(actors.finance, 'finance', 'event-1');

    expect(first).toEqual({ ok: true, eventId: 'event-1' });
    expect(second).toEqual(first);
    expect(prisma.notificationReceipt.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.notificationReceipt.upsert).toHaveBeenLastCalledWith({
      where: { userId_eventId: { userId: 'finance-user', eventId: 'event-1' } },
      create: { userId: 'finance-user', eventId: 'event-1' },
      update: {},
    });
    expect(prisma.domainEvent.update).not.toHaveBeenCalled();
    expect(prisma.domainEvent.delete).not.toHaveBeenCalled();
  });

  it('returns 404 and writes no receipt when the event is not routed to the recipient', async () => {
    const { service, prisma } = setup();

    await expect(
      service.markRead(actors.commercial, 'commercial', 'event-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('returns only RoleInboxItem fields and excludes sensitive source data', async () => {
    const event = domainEvent('audit:invoice_handoff_created', {
      detail: {
        rawPayload: { secret: true },
        legalName: 'ООО Секрет',
        inn: '7700000000',
        amountValue: 900_000,
        schedules: [{ amount: 450_000 }],
      },
    });
    const { service, prisma } = setup([event]);
    prisma.financeOrder.findMany.mockResolvedValue([
      {
        id: 'finance-1',
        commercialOrderId: 'order-1',
        amountValue: 900_000,
        schedules: [{ amount: 450_000 }],
        commercialOrder: {
          ...order(),
          counterparty: { legalName: 'ООО Секрет', inn: '7700000000' },
        },
      },
    ]);

    const page = await service.list(actors.finance, 'finance', { limit: 20 });
    const json = JSON.stringify(page);

    for (const forbidden of ['rawPayload', 'legalName', 'inn', 'amountValue', 'schedules']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('requires a real actor userId before reading or writing receipts', async () => {
    const { service, prisma } = setup();
    const anonymous = { ...actors.finance, userId: null };

    await expect(service.list(anonymous, 'finance', { limit: 20 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.markRead(anonymous, 'finance', 'event-1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.domainEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('rejects projecting a different recipient role than the authenticated actor', async () => {
    const { service, prisma } = setup();

    await expect(service.list(actors.commercial, 'finance', { limit: 20 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.domainEvent.findMany).not.toHaveBeenCalled();
  });

  it.each([
    'commercial',
    'production_lead',
    'operator',
    'warehouse',
    'finance',
    'director',
  ] as const)('blocks %s from listing or marking the admin inbox', async (role) => {
    const { service, prisma } = setup([
      domainEvent('admin.incident.opened', { objectId: 'incident-1' }),
    ]);
    const nonAdmin = actor(role);

    await expect(service.list(nonAdmin, 'admin', { limit: 20 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.markRead(nonAdmin, 'admin', 'event-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.domainEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.domainEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('does not expose an operator event assigned to another user', async () => {
    const event = domainEvent('audit:task_assigned', {
      objectId: 'ROLL-1',
      detail: { operatorId: 'other-operator' },
    });
    const { service, prisma } = setup([event]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    await expect(service.list(actors.operator, 'operator', { limit: 20 })).resolves.toMatchObject({
      items: [],
    });
    await expect(service.markRead(actors.operator, 'operator', 'event-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('rejects a targeted operator event without immutable recipient metadata', async () => {
    const event = domainEvent('audit:task_assigned', {
      objectId: null,
      detail: { rollId: 'ROLL-1' },
    });
    const { service, prisma } = setup([event]);
    prisma.domainEvent.findMany.mockResolvedValue([]);
    prisma.domainEvent.findFirst.mockResolvedValue(null);
    prisma.domainEvent.count.mockResolvedValue(0);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    await expect(service.list(actors.operator, 'operator', { limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    await expect(service.markRead(actors.operator, 'operator', 'event-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  type: 'audit:task_assigned',
                  objectId: { not: null },
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('projects one reassignment independently for the previous and new operator', async () => {
    const reassignment = domainEvent('audit:task_reassigned', {
      id: 'event-reassigned',
      objectId: 'ROLL-1',
      detail: {
        commercialOrderId: 'order-1',
        productionOrderId: 'production-1',
        operatorId: 'operator-b',
        previousOperatorId: 'operator-a',
        rollId: 'ROLL-1',
      },
    });
    const { service, prisma } = setup([reassignment]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-b',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    const operatorA = await service.list(actor('operator', 'operator-a'), 'operator', {
      limit: 20,
    });
    expect(operatorA.items).toEqual([
      expect.objectContaining({
        id: 'event-reassigned',
        orderId: 'order-1',
        orderNumber: 'A-1',
        positionId: null,
        rollId: null,
        cta: { kind: 'operator_queue', targetId: 'order-1', section: 'Рулоны и заказы' },
      }),
    ]);
    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedOperatorId: 'operator-a' }),
      }),
    );
    await expect(
      service.markRead(actor('operator', 'operator-a'), 'operator', reassignment.id),
    ).resolves.toEqual({ ok: true, eventId: reassignment.id });

    const operatorB = await service.list(actor('operator', 'operator-b'), 'operator', {
      limit: 20,
    });
    await expect(
      service.markRead(actor('operator', 'operator-b'), 'operator', reassignment.id),
    ).resolves.toEqual({ ok: true, eventId: reassignment.id });

    expect(operatorB.items).toEqual([
      expect.objectContaining({
        id: 'event-reassigned',
        orderId: 'order-1',
        positionId: null,
        rollId: null,
        cta: { kind: 'operator_queue', targetId: 'order-1', section: 'Рулоны и заказы' },
      }),
    ]);
    expect(prisma.notificationReceipt.upsert).toHaveBeenNthCalledWith(1, {
      where: { userId_eventId: { userId: 'operator-a', eventId: reassignment.id } },
      create: { userId: 'operator-a', eventId: reassignment.id },
      update: {},
    });
    expect(prisma.notificationReceipt.upsert).toHaveBeenNthCalledWith(2, {
      where: { userId_eventId: { userId: 'operator-b', eventId: reassignment.id } },
      create: { userId: 'operator-b', eventId: reassignment.id },
      update: {},
    });
  });

  it('keeps an unread assignment projectable and markable after ownership moves', async () => {
    const assignment = domainEvent('audit:task_assigned', {
      id: 'event-assigned-a',
      objectId: 'ROLL-1',
      detail: {
        commercialOrderId: 'order-1',
        operatorId: 'operator-a',
        productionOrderId: 'production-1',
        rollId: 'ROLL-1',
      },
    });
    const { service, prisma } = setup([assignment]);
    prisma.domainEvent.count.mockResolvedValue(1);
    prisma.rollDispatchItem.findMany.mockResolvedValue([]);

    const page = await service.list(actor('operator', 'operator-a'), 'operator', { limit: 1 });

    expect(page.unreadCount).toBe(1);
    expect(page.items.filter((item) => item.unread)).toHaveLength(page.unreadCount);
    expect(page.nextCursor).toBeNull();
    expect(page.items).toEqual([
      expect.objectContaining({
        id: assignment.id,
        orderId: 'order-1',
        orderNumber: 'A-1',
        positionId: null,
        rollId: null,
        cta: {
          kind: 'operator_queue',
          targetId: 'order-1',
          section: 'Рулоны и заказы',
        },
      }),
    ]);
    await expect(
      service.markRead(actor('operator', 'operator-a'), 'operator', assignment.id),
    ).resolves.toEqual({ ok: true, eventId: assignment.id });
    expect(prisma.rollDispatchItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ assignedOperatorId: 'operator-a' }),
      }),
    );
  });

  it('groups roll assignments into one order notification and marks every event read', async () => {
    const events = [
      domainEvent('audit:task_assigned', {
        id: 'event-roll-2',
        objectId: 'ROLL-2',
        detail: {
          commercialOrderId: 'order-1',
          operatorId: 'operator-user',
          productionOrderId: 'production-1',
          rollId: 'ROLL-2',
        },
      }),
      domainEvent('audit:task_assigned', {
        id: 'event-roll-1',
        objectId: 'ROLL-1',
        detail: {
          commercialOrderId: 'order-1',
          operatorId: 'operator-user',
          productionOrderId: 'production-1',
          rollId: 'ROLL-1',
        },
      }),
    ];
    const { service, prisma } = setup(events);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
      {
        id: 'dispatch-2',
        rollCode: 'ROLL-2',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    const page = await service.list(actors.operator, 'operator', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'event-roll-2',
        eventIds: ['event-roll-2', 'event-roll-1'],
        title: 'Назначен заказ',
        body: 'Назначено рулонов: 2. Откройте заказ и проверьте очередь.',
        orderId: 'order-1',
        rollId: null,
        cta: {
          kind: 'operator_queue',
          targetId: 'order-1',
          section: 'Рулоны и заказы',
        },
      }),
    ]);
    expect(page.unreadCount).toBe(1);

    await service.markRead(actors.operator, 'operator', page.items[0]!.id);

    expect(prisma.notificationReceipt.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.notificationReceipt.upsert).toHaveBeenNthCalledWith(1, {
      where: {
        userId_eventId: { userId: 'operator-user', eventId: 'event-roll-2' },
      },
      create: { userId: 'operator-user', eventId: 'event-roll-2' },
      update: {},
    });
    expect(prisma.notificationReceipt.upsert).toHaveBeenNthCalledWith(2, {
      where: {
        userId_eventId: { userId: 'operator-user', eventId: 'event-roll-1' },
      },
      create: { userId: 'operator-user', eventId: 'event-roll-1' },
      update: {},
    });
    expect(prisma.domainEvent.delete).not.toHaveBeenCalled();
  });

  it('keeps the former new side of a reassignment markable after a later B to C move', async () => {
    const reassignment = domainEvent('audit:task_reassigned', {
      id: 'event-reassigned-a-b',
      objectId: 'ROLL-1',
      detail: {
        commercialOrderId: 'order-1',
        operatorId: 'operator-b',
        previousOperatorId: 'operator-a',
        productionOrderId: 'production-1',
        rollId: 'ROLL-1',
      },
    });
    const { service, prisma } = setup([reassignment]);
    prisma.domainEvent.count.mockResolvedValue(1);
    prisma.rollDispatchItem.findMany.mockResolvedValue([]);

    const page = await service.list(actor('operator', 'operator-b'), 'operator', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: reassignment.id,
        positionId: null,
        rollId: null,
        cta: {
          kind: 'operator_queue',
          targetId: 'order-1',
          section: 'Рулоны и заказы',
        },
      }),
    ]);
    expect(page.items[0]!.cta).not.toBeNull();
    expect(page.items[0]!.cta!.targetId).not.toBe('ROLL-1');
    await expect(
      service.markRead(actor('operator', 'operator-b'), 'operator', reassignment.id),
    ).resolves.toEqual({ ok: true, eventId: reassignment.id });
  });

  it('uses one recipient scope for list, unread count, and markRead', async () => {
    const event = domainEvent('audit:task_assigned', {
      objectId: 'ROLL-1',
      detail: { operatorId: 'operator-user', rollId: 'ROLL-1' },
    });
    const { service, prisma } = setup([event]);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-1',
        rollCode: 'ROLL-1',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    await service.list(actors.operator, 'operator', { limit: 20 });
    await service.markRead(actors.operator, 'operator', event.id);

    const listWhere = prisma.domainEvent.findMany.mock.calls[0][0].where;
    const {
      notificationReceipts: listReceiptScope,
      ...listScope
    } = listWhere;
    const countWhere = prisma.domainEvent.count.mock.calls[0][0].where;
    const markWhere = prisma.domainEvent.findFirst.mock.calls.find(
      ([args]) => Array.isArray(args.where?.AND),
    )?.[0].where;

    expect(listScope).toEqual(
      expect.objectContaining({
        type: {
          in: expect.arrayContaining([
            'audit:task_assigned',
            'audit:task_reassigned',
            'notification:penalty_created',
          ]),
        },
        AND: expect.arrayContaining([
          {
            OR: expect.arrayContaining([
              {
                type: 'audit:task_assigned',
                objectId: { not: null },
                detail: { path: ['operatorId'], equals: 'operator-user' },
              },
              {
                type: 'audit:task_reassigned',
                objectId: { not: null },
                OR: [
                  { detail: { path: ['operatorId'], equals: 'operator-user' } },
                  { detail: { path: ['previousOperatorId'], equals: 'operator-user' } },
                ],
              },
            ]),
          },
        ]),
      }),
    );
    expect(listScope.type.in).not.toEqual(
      expect.arrayContaining([
        'audit:production_order_approved',
        'audit:roll_dispatch_assigned',
        'audit:roll_dispatch_bulk_assigned',
      ]),
    );
    expect(listReceiptScope).toEqual({ none: { userId: 'operator-user' } });
    expect(countWhere).toEqual({
      AND: [listScope, { notificationReceipts: { none: { userId: 'operator-user' } } }],
    });
    expect(markWhere).toEqual({ AND: [listScope, { id: event.id }] });
  });

  it('filters foreign assignments before take and keeps an equal-timestamp cursor', async () => {
    const foreign = domainEvent('audit:task_assigned', {
      id: 'event-z',
      objectId: 'ROLL-FOREIGN',
      detail: { operatorId: 'other-operator', rollId: 'ROLL-FOREIGN' },
    });
    const own = domainEvent('audit:task_assigned', {
      id: 'event-y',
      objectId: 'ROLL-OWN',
      detail: { operatorId: 'operator-user', rollId: 'ROLL-OWN' },
    });
    const olderOwn = domainEvent('audit:task_assigned', {
      id: 'event-x',
      objectId: 'ROLL-OLDER',
      detail: { operatorId: 'operator-user', rollId: 'ROLL-OLDER' },
    });
    const { service, prisma } = setup([foreign, own, olderOwn]);
    let scopedPage = 0;
    prisma.domainEvent.findMany.mockImplementation(async (query: unknown) => {
      const serialized = JSON.stringify(query);
      const hasRecipientScope =
        serialized.includes('"operatorId"],"equals":"operator-user"') &&
        serialized.includes('"previousOperatorId"],"equals":"operator-user"');
      if (!hasRecipientScope) return [foreign, own];
      scopedPage += 1;
      return scopedPage === 1 ? [own, olderOwn] : [olderOwn];
    });
    prisma.domainEvent.count.mockResolvedValue(2);
    prisma.rollDispatchItem.findMany.mockResolvedValue([
      {
        id: 'dispatch-own',
        rollCode: 'ROLL-OWN',
        orderLineId: 'position-1',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
      {
        id: 'dispatch-older',
        rollCode: 'ROLL-OLDER',
        orderLineId: 'position-older',
        assignedOperatorId: 'operator-user',
        productionOrderId: 'production-1',
        productionOrder: { commercialOrder: order() },
      },
    ]);

    const first = await service.list(actors.operator, 'operator', { limit: 1 });
    const decodedCursor = JSON.parse(
      Buffer.from(first.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as { id: string };
    const second = await service.list(actors.operator, 'operator', {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.items.map((item) => item.id)).toEqual(['event-y']);
    expect(decodedCursor.id).toBe('event-y');
    expect(second.items.map((item) => item.id)).toEqual(['event-x']);
    expect(prisma.domainEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ type: expect.any(Object) }),
            {
              OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'event-y' } }],
            },
          ],
          notificationReceipts: { none: { userId: 'operator-user' } },
        },
      }),
    );
  });

  it('counts all unread candidates independently for each user', async () => {
    const { service, prisma } = setup();
    prisma.domainEvent.count.mockImplementation(async (query: unknown) =>
      JSON.stringify(query).includes('finance-user') ? 0 : 1,
    );

    const firstUser = await service.list(actors.finance, 'finance', { limit: 20 });
    const secondUser = await service.list(actor('finance', 'finance-other'), 'finance', {
      limit: 20,
    });

    expect(firstUser.unreadCount).toBe(0);
    expect(secondUser.unreadCount).toBe(1);
    expect(prisma.domainEvent.count.mock.calls.map(([query]) => query.where)).toEqual([
      {
        AND: [expect.any(Object), { notificationReceipts: { none: { userId: 'finance-user' } } }],
      },
      {
        AND: [expect.any(Object), { notificationReceipts: { none: { userId: 'finance-other' } } }],
      },
    ]);
    expect(prisma.domainEvent.count.mock.calls[0][0].where.AND[0]).toEqual(
      prisma.domainEvent.count.mock.calls[1][0].where.AND[0],
    );
  });

  it.each(['problem:machine_breakdown_reported', 'problem:shift_balance_mismatch'])(
    'keeps %s on the production-order route',
    async (eventType) => {
      const event = domainEvent(eventType, {
        detail: { productionOrderId: 'production-1' },
      });
      const { service, prisma } = setup([event]);
      prisma.productionOrder.findMany.mockResolvedValue([
        {
          id: 'production-1',
          commercialOrderId: 'order-1',
          commercialOrder: order(),
        },
      ]);

      const page = await service.list(actors.production, 'production_lead', { limit: 20 });

      expect(page.items).toEqual([
        expect.objectContaining({
          eventType,
          orderId: 'order-1',
          cta: {
            kind: 'production_order',
            targetId: 'production-1',
            section: 'Проблемы',
          },
        }),
      ]);
    },
  );

  it.each([
    ['problem:production_defect_reported', 'production-problem-1'],
    ['problem:operator_defect_reported', 'operator-problem-1'],
    ['problem:warehouse_defect_reported', 'warehouse-problem-1'],
  ])('projects %s to its exact immutable production problem', async (eventType, problemId) => {
    const event = domainEvent(eventType, {
      objectId: 'order-1',
      detail: {
        problemId,
        orderId: 'order-1',
        rollId: 'ROLL-1',
        rawPayload: { token: 'secret' },
      },
    });
    const { service, prisma } = setup([event]);
    prisma.productionProblem.findMany.mockResolvedValue([
      {
        id: problemId,
        orderId: 'order-1',
        positionId: 'position-1',
        rollId: 'ROLL-1',
      },
    ]);

    const page = await service.list(actors.production, 'production_lead', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        eventType,
        orderId: 'order-1',
        orderNumber: 'A-1',
        taskId: problemId,
        positionId: 'position-1',
        rollId: 'ROLL-1',
        cta: {
          kind: 'production_problem',
          targetId: problemId,
          section: 'Проблемы',
        },
      }),
    ]);
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith({
      where: { id: { in: [problemId] } },
      select: { id: true, orderId: true, positionId: true, rollId: true },
      orderBy: { id: 'asc' },
    });
    expect(JSON.stringify(page)).not.toMatch(/rawPayload|token|secret/);
  });

  it.each([
    ['commercial', actors.commercial, 'commercial'],
    ['production_lead', actors.production, 'production_lead'],
    ['director', actors.director, 'director'],
  ] as const)(
    'projects one operator report to %s with the exact shared problem id',
    async (_label, inboxActor, recipientRole) => {
      const event = domainEvent('problem:operator_reported', {
        objectId: 'problem-shared-1',
        detail: {
          problemId: 'problem-shared-1',
          orderId: 'order-1',
          rollId: 'ROLL-1',
          requestFingerprint: 'must-not-leak',
        },
      });
      const { service, prisma } = setup([event]);
      prisma.productionProblem.findMany.mockResolvedValue([
        {
          id: 'problem-shared-1',
          orderId: 'order-1',
          positionId: 'position-1',
          rollId: 'ROLL-1',
        },
      ]);

      const page = await service.list(inboxActor, recipientRole, { limit: 20 });

      expect(page.items).toEqual([
        expect.objectContaining({
          recipientRole,
          taskId: 'problem-shared-1',
          cta: {
            kind: 'production_problem',
            targetId: 'problem-shared-1',
            section: 'Проблемы',
          },
        }),
      ]);
      expect(JSON.stringify(page)).not.toContain('requestFingerprint');
      expect(JSON.stringify(page)).not.toContain('must-not-leak');
    },
  );

  it('projects a production problem without requiring a commercial order', async () => {
    const event = domainEvent('notification:production_problem_received', {
      objectId: 'post-1',
      detail: {
        problemId: 'problem-1',
        rawPayload: { token: 'secret' },
        adapterError: 'serial stack',
      },
    });
    const { service, prisma } = setup([event]);
    prisma.commercialOrder.findMany.mockResolvedValue([]);
    prisma.productionProblem.findMany.mockResolvedValue([
      {
        id: 'problem-1',
        orderId: null,
        positionId: null,
        rollId: null,
      },
    ]);

    const page = await service.list(actors.production, 'production_lead', { limit: 20 });

    expect(page.items).toEqual([
      expect.objectContaining({
        orderId: null,
        orderNumber: null,
        taskId: 'problem-1',
        cta: {
          kind: 'production_problem',
          targetId: 'problem-1',
          section: 'Проблемы',
        },
      }),
    ]);
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['problem-1'] } },
      select: { id: true, orderId: true, positionId: true, rollId: true },
      orderBy: { id: 'asc' },
    });
    expect(JSON.stringify(page)).not.toMatch(/rawPayload|token|adapterError|serial stack/);
  });

  it.each(['admin.incident.opened', 'admin.incident.reopened'])(
    'projects and marks %s without exposing diagnostic detail',
    async (eventType) => {
      const event = domainEvent(eventType, {
        id: `event-${eventType}`,
        objectId: 'incident-1',
        detail: {
          rawPayload: { token: 'secret' },
          stack: 'adapter stack',
          credential: 'do-not-expose',
        },
      });
      const { service, prisma } = setup([event]);
      prisma.commercialOrder.findMany.mockResolvedValue([]);
      prisma.operationalIncident.findMany.mockResolvedValue([{ id: 'incident-1' }]);

      const page = await service.list(actors.admin, 'admin', { limit: 20 });

      expect(page.items).toEqual([
        expect.objectContaining({
          orderId: null,
          orderNumber: null,
          taskId: 'incident-1',
          positionId: null,
          rollId: null,
          cta: {
            kind: 'admin_incident',
            targetId: 'incident-1',
            section: 'Инциденты',
          },
        }),
      ]);
      expect(prisma.operationalIncident.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['incident-1'] } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(JSON.stringify(page)).not.toMatch(/rawPayload|token|stack|credential|do-not-expose/);
      await expect(service.markRead(actors.admin, 'admin', event.id)).resolves.toEqual({
        ok: true,
        eventId: event.id,
      });
      expect(prisma.notificationReceipt.upsert).toHaveBeenCalledWith({
        where: { userId_eventId: { userId: 'admin-user', eventId: event.id } },
        create: { userId: 'admin-user', eventId: event.id },
        update: {},
      });
    },
  );

  it.each(['admin.incident.acknowledged', 'admin.incident.resolved'])(
    'does not expose or mark %s as an admin notification',
    async (eventType) => {
      const event = domainEvent(eventType, { objectId: 'incident-1' });
      const { service, prisma } = setup([event]);
      prisma.domainEvent.count.mockResolvedValue(0);

      await expect(service.list(actors.admin, 'admin', { limit: 20 })).resolves.toEqual({
        items: [],
        nextCursor: null,
        unreadCount: 0,
      });
      await expect(service.markRead(actors.admin, 'admin', event.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
    },
  );

  it('does not mark an admin lifecycle event when its incident is missing', async () => {
    const event = domainEvent('admin.incident.reopened', { objectId: 'missing-incident' });
    const { service, prisma } = setup([event]);

    await expect(service.markRead(actors.admin, 'admin', event.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('counts a valid missing-aggregate candidate but cannot project or mark it', async () => {
    const event = domainEvent('notification:production_problem_received', {
      objectId: 'post-1',
      detail: { problemId: 'missing-problem' },
    });
    const { service, prisma } = setup([event]);
    prisma.commercialOrder.findMany.mockResolvedValue([]);
    prisma.productionProblem.findMany.mockResolvedValue([]);
    prisma.domainEvent.count.mockResolvedValue(1);

    await expect(
      service.list(actors.production, 'production_lead', { limit: 20 }),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 1,
    });
    await expect(
      service.markRead(actors.production, 'production_lead', event.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notificationReceipt.upsert).not.toHaveBeenCalled();
  });

  it('clamps the service limit and resolves each object type in batches', async () => {
    const { service, prisma } = setup();

    await service.list(actors.finance, 'finance', { limit: 500 });

    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 101 }),
    );
    for (const repository of [
      prisma.commercialOrder,
      prisma.financeOrder,
      prisma.productionOrder,
      prisma.warehouseAcceptanceTask,
      prisma.orderResolutionCase,
      prisma.rollDispatchItem,
    ]) {
      expect(repository.findMany).toHaveBeenCalledTimes(1);
    }
  });

  it('drops an event when its referenced object cannot be resolved', async () => {
    const { service, prisma } = setup();
    prisma.commercialOrder.findMany.mockResolvedValue([]);
    prisma.financeOrder.findMany.mockResolvedValue([]);

    await expect(service.list(actors.finance, 'finance', { limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
      unreadCount: 1,
    });
  });
});
