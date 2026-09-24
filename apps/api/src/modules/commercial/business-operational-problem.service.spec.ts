import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessOperationalProblemService } from './business-operational-problem.service';

const occurredAt = new Date('2026-08-07T10:00:00.000Z');
const PRODUCTION_KINDS = [
  'general',
  'raw_material_shortage',
  'defect',
  'machine_breakdown',
] as const;

function productionProblem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'problem-defect-a',
    type: 'defect',
    status: 'open',
    reason: '  Повреждение кромки  ',
    createdAt: occurredAt,
    rollId: 'ROLL-1',
    orderId: 'order-1',
    order: { orderNumber: 'ЗК-42' },
    post: null,
    defectRecord: {
      line: {
        rollDispatchItem: {
          post: { name: 'Экструдер 1', code: 'POST-1' },
        },
      },
    },
    actorId: 'actor-must-not-leak',
    resolvedById: 'resolver-must-not-leak',
    postId: 'post-must-not-leak',
    sessionId: 'session-must-not-leak',
    rawPayload: { device: 'raw-must-not-leak' },
    ...overrides,
  };
}

function overweightEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-weight',
    type: 'audit:warehouse_roll_reserved_overweight',
    objectId: 'ROLL-9',
    createdAt: occurredAt,
    detail: {
      warehouseOperationId: 'warehouse-operation-1',
      rollCode: 'ROLL-9',
      rawPayload: 'raw-must-not-leak',
      sessionId: 'session-must-not-leak',
      postId: 'post-must-not-leak',
      actorId: 'actor-must-not-leak',
    },
    actorId: 'actor-must-not-leak',
    reason: 'reason-from-event-must-not-leak',
    rawPayload: 'raw-must-not-leak',
    ...overrides,
  };
}

function validatedWeight(overrides: Record<string, unknown> = {}) {
  return {
    id: 'capture-1',
    warehouseOperationId: 'warehouse-operation-1',
    kind: 'control',
    deviceId: 'device-must-not-leak',
    deviceStatus: 'ready',
    stable: true,
    toleranceOk: false,
    grossKg: 13.3,
    spoolKg: 0.7,
    netKg: 12.6,
    postId: 'post-must-not-leak',
    postSessionId: null,
    operationId: null,
    operation: null,
    warehouseOperation: {
      id: 'warehouse-operation-1',
      kind: 'control_weight',
      status: 'succeeded',
      taskId: 'task-1',
      rollCode: 'ROLL-9',
      deviceId: 'device-must-not-leak',
      postId: 'post-must-not-leak',
      safeResult: {
        operationId: 'warehouse-operation-1',
        taskId: 'task-1',
        rollCode: 'ROLL-9',
        grossKg: 13.3,
        spoolKg: 0.7,
        netKg: 12.6,
      },
    },
    line: {
      planKg: 10,
      rollDispatchItem: {
        rollCode: 'ROLL-9',
        productionOrder: {
          commercialOrder: { id: 'order-99', orderNumber: 'ЗК-99' },
        },
        post: { name: 'Экструдер 9', code: 'POST-9' },
      },
    },
    actorId: 'actor-must-not-leak',
    sessionId: 'session-must-not-leak',
    rawPayload: 'raw-must-not-leak',
    ...overrides,
  };
}

function makeService() {
  const prisma = {
    productionProblem: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
    weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
  };

  return {
    prisma,
    service: new BusinessOperationalProblemService(prisma as never),
  };
}

describe('BusinessOperationalProblemService', () => {
  it('merges defects, orderless breakdowns, and overweight facts in deterministic order', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany.mockResolvedValue([
      productionProblem({
        id: 'problem-defect-a',
        status: 'open',
      }),
      productionProblem({
        id: 'problem-machine',
        type: 'machine_breakdown',
        reason: '  Обрыв ремня  ',
        rollId: null,
        order: null,
        post: { name: 'Экструдер 3', code: 'POST-3' },
        defectRecord: null,
      }),
      productionProblem({
        id: 'problem-defect-z',
        status: 'resolved',
        reason: 'Складка полотна',
        rollId: 'ROLL-2',
        order: { orderNumber: 'ЗК-43' },
        defectRecord: null,
      }),
    ]);
    prisma.domainEvent.findMany.mockResolvedValue([overweightEvent()]);
    prisma.weightCapture.findMany.mockResolvedValue([validatedWeight()]);

    const result = await service.listProblems({ filter: 'all', limit: 10 });

    expect(result).toEqual({
      items: [
        {
          id: 'event-weight',
          orderId: 'order-99',
          kind: 'weight_deviation',
          status: 'resolved',
          label: 'Перевес рулона: 12,6 кг при плане 10 кг',
          createdAt: '2026-08-07T10:00:00.000Z',
          orderNumber: 'ЗК-99',
          rollCode: 'ROLL-9',
          machineName: 'Экструдер 9',
          reason: 'Контрольный вес превысил допустимое отклонение.',
        },
        {
          id: 'problem-machine',
          orderId: 'order-1',
          kind: 'machine_breakdown',
          status: 'open',
          label: 'Поломка станка',
          createdAt: '2026-08-07T10:00:00.000Z',
          orderNumber: null,
          rollCode: null,
          machineName: 'Экструдер 3',
          reason: 'Обрыв ремня',
        },
        {
          id: 'problem-defect-z',
          orderId: 'order-1',
          kind: 'defect',
          status: 'resolved',
          label: 'Брак рулона',
          createdAt: '2026-08-07T10:00:00.000Z',
          orderNumber: 'ЗК-43',
          rollCode: 'ROLL-2',
          machineName: null,
          reason: 'Складка полотна',
        },
        {
          id: 'problem-defect-a',
          orderId: 'order-1',
          kind: 'defect',
          status: 'open',
          label: 'Брак рулона',
          createdAt: '2026-08-07T10:00:00.000Z',
          orderNumber: 'ЗК-42',
          rollCode: 'ROLL-1',
          machineName: 'Экструдер 1',
          reason: 'Повреждение кромки',
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /detail|rawPayload|sessionId|postId|actorId|resolvedById|deviceId|warehouseOperationId/i,
    );
    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: { in: PRODUCTION_KINDS },
        },
        orderBy: [{ createdAt: 'desc' }, { type: 'desc' }, { id: 'desc' }],
        take: 11,
      }),
    );
    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { type: 'audit:warehouse_roll_reserved_overweight' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 11,
      }),
    );
  });

  it('does not fabricate quantities or business references from an invalid event link', async () => {
    const { prisma, service } = makeService();
    prisma.domainEvent.findMany.mockResolvedValue([
      overweightEvent({
        id: 'event-unlinked',
        objectId: 'ROLL-UNLINKED',
        detail: {
          warehouseOperationId: 'warehouse-operation-unlinked',
          rollCode: 'ROLL-UNLINKED',
          rawPayload: { netKg: 999 },
        },
      }),
    ]);
    prisma.weightCapture.findMany.mockResolvedValue([
      validatedWeight({
        warehouseOperationId: 'warehouse-operation-unlinked',
        warehouseOperation: {
          id: 'warehouse-operation-unlinked',
          kind: 'control_weight',
          status: 'succeeded',
          taskId: 'task-1',
          rollCode: 'ROLL-DIFFERENT',
          deviceId: 'device-must-not-leak',
          postId: 'post-must-not-leak',
          safeResult: {
            operationId: 'warehouse-operation-unlinked',
            taskId: 'task-1',
            rollCode: 'ROLL-DIFFERENT',
            grossKg: 13.3,
            spoolKg: 0.7,
            netKg: 12.6,
          },
        },
      }),
    ]);

    const result = await service.listProblems({ filter: 'resolved', limit: 20 });

    expect(result.items).toEqual([
      {
        id: 'event-unlinked',
        orderId: null,
        kind: 'weight_deviation',
        status: 'resolved',
        label: 'Перевес рулона',
        createdAt: '2026-08-07T10:00:00.000Z',
        orderNumber: null,
        rollCode: 'ROLL-UNLINKED',
        machineName: null,
        reason: 'Контрольный вес превысил допустимое отклонение.',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('999');
  });

  it.each([
    ['open', { type: { in: PRODUCTION_KINDS }, status: { not: 'resolved' } }, false],
    ['resolved', { type: { in: PRODUCTION_KINDS }, status: 'resolved' }, true],
    ['all', { type: { in: PRODUCTION_KINDS } }, true],
  ] as const)('maps the %s filter across both source kinds', async (filter, where, readsEvents) => {
    const { prisma, service } = makeService();

    await service.listProblems({ filter, limit: 20 });

    expect(prisma.productionProblem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where }),
    );
    expect(prisma.domainEvent.findMany).toHaveBeenCalledTimes(readsEvents ? 1 : 0);
  });

  it('paginates across discriminators with an opaque tuple cursor', async () => {
    const { prisma, service } = makeService();
    const defectZ = productionProblem({
      id: 'problem-defect-z',
      status: 'resolved',
      defectRecord: null,
    });
    const defectA = productionProblem({
      id: 'problem-defect-a',
      status: 'resolved',
      defectRecord: null,
    });
    const machine = productionProblem({
      id: 'problem-machine',
      type: 'machine_breakdown',
      status: 'open',
      rollId: null,
      order: null,
      post: { name: 'Экструдер 3', code: 'POST-3' },
      defectRecord: null,
    });
    prisma.productionProblem.findMany
      .mockResolvedValueOnce([machine, defectZ, defectA])
      .mockResolvedValueOnce([defectZ, defectA]);
    prisma.domainEvent.findMany
      .mockResolvedValueOnce([overweightEvent()])
      .mockResolvedValueOnce([]);
    prisma.weightCapture.findMany.mockResolvedValueOnce([validatedWeight()]);

    const first = await service.listProblems({ filter: 'all', limit: 2 });

    expect(first.items.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
      'weight_deviation:event-weight',
      'machine_breakdown:problem-machine',
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain('problem-machine');
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'))).toEqual({
      createdAt: '2026-08-07T10:00:00.000Z',
      kind: 'machine_breakdown',
      id: 'problem-machine',
    });

    const second = await service.listProblems({
      filter: 'all',
      cursor: first.nextCursor!,
      limit: 2,
    });

    expect(second.items.map(({ id }) => id)).toEqual(['problem-defect-z', 'problem-defect-a']);
    expect(second.nextCursor).toBeNull();
    expect(prisma.productionProblem.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          type: { in: PRODUCTION_KINDS },
          OR: [
            { createdAt: { lt: occurredAt } },
            { createdAt: occurredAt, type: { lt: 'machine_breakdown' } },
            {
              createdAt: occurredAt,
              type: 'machine_breakdown',
              id: { lt: 'problem-machine' },
            },
          ],
        },
        take: 3,
      }),
    );
    expect(prisma.domainEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          type: 'audit:warehouse_roll_reserved_overweight',
          OR: [{ createdAt: { lt: occurredAt } }],
        },
        take: 3,
      }),
    );
  });

  it.each([
    ['cursor', { cursor: 'not-a-cursor', limit: 20 }],
    ['limit', { limit: 0 }],
    ['limit', { limit: 101 }],
    ['filter', { filter: 'invalid' }],
  ] as const)('rejects an invalid %s query before reading sources', async (_kind, query) => {
    const { prisma, service } = makeService();

    await expect(service.listProblems(query as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.productionProblem.findMany).not.toHaveBeenCalled();
    expect(prisma.domainEvent.findMany).not.toHaveBeenCalled();
    expect(prisma.weightCapture.findMany).not.toHaveBeenCalled();
  });

  it('projects general and shortage reports with the same durable problem ids', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findMany.mockResolvedValue([
      productionProblem({
        id: 'problem-general',
        type: 'general',
        reason: 'Остановка линии',
        defectRecord: null,
      }),
      productionProblem({
        id: 'problem-shortage',
        type: 'raw_material_shortage',
        reason: 'Закончился ПВД',
        defectRecord: null,
      }),
    ]);

    const result = await service.listProblems({ filter: 'open', limit: 20 });

    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'problem-general',
          kind: 'general',
          label: 'Общая проблема',
        }),
        expect.objectContaining({
          id: 'problem-shortage',
          kind: 'raw_material_shortage',
          label: 'Нехватка сырья',
        }),
      ]),
    );
  });

  it('returns the exact safe DTO by problem id and rejects non-business problem types', async () => {
    const { prisma, service } = makeService();
    prisma.productionProblem.findUnique.mockResolvedValue(
      productionProblem({
        id: 'problem-general',
        type: 'general',
        reason: '  Остановка линии  ',
        defectRecord: null,
      }),
    );

    await expect(service.getProblem('problem-general')).resolves.toEqual({
      id: 'problem-general',
      kind: 'general',
      status: 'open',
      label: 'Общая проблема',
      createdAt: '2026-08-07T10:00:00.000Z',
      orderId: 'order-1',
      orderNumber: 'ЗК-42',
      rollCode: 'ROLL-1',
      machineName: null,
      reason: 'Остановка линии',
    });
    expect(JSON.stringify(await service.getProblem('problem-general'))).not.toMatch(
      /rawPayload|actorId|resolvedById|postId|sessionId/u,
    );

    prisma.productionProblem.findUnique.mockResolvedValue(
      productionProblem({ type: 'shift_balance_mismatch' }),
    );
    await expect(service.getProblem('system-problem')).rejects.toBeInstanceOf(NotFoundException);
  });
});
