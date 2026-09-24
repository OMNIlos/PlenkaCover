import { NotFoundException } from '@nestjs/common';
import { PlatformQrRecognitionService } from '../../common/platform-qr/platform-qr-recognition.service';
import { DirectorContainerTraceabilityService } from './director-container-traceability.service';
import { DirectorTraceabilityTimelineService } from './director-traceability-timeline.service';
import { DirectorTraceabilityService } from './director-traceability.service';

const ROLL_TOKEN = `prt_${'a'.repeat(64)}`;
const BIG_BAG_TOKEN = `bbt_${'b'.repeat(64)}`;
const PALLET_TOKEN = `plt_${'c'.repeat(64)}`;

function searchPrisma(overrides: Record<string, unknown> = {}) {
  return {
    rollScanToken: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    bigBagScanToken: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    palletScanToken: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    bigBagUnit: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    warehouseRoll: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rollDispatchItem: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    commercialOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    palletListDocument: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    warehouseAcceptanceTask: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    warehouseOperation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function createService(prisma: Record<string, unknown>) {
  const timeline = new DirectorTraceabilityTimelineService(prisma as never);
  return new DirectorTraceabilityService(
    prisma as never,
    new PlatformQrRecognitionService(prisma as never),
    new DirectorContainerTraceabilityService(prisma as never, timeline),
    timeline,
  );
}

describe('DirectorTraceabilityService', () => {
  it('owns a bounded business projection for events, statuses, facts and employee identity', async () => {
    const prisma = searchPrisma({
      commercialOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'order-safe-projection',
          orderNumber: 'A-11',
          title: null,
          productionIndicator: 'in_progress',
          warehouseCoverStatus: 'full_confirmed',
          paymentStatus: 'partially_paid',
          shipmentStatus: 'not_shipped',
          commercialStage: 'in_production',
          createdAt: new Date('2026-08-10T09:00:00.000Z'),
          positions: [],
        }),
      },
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'event-known',
            type: 'audit:warehouse_pallet_roll_deselected',
            label: 'audit:warehouse pallet roll deselected',
            reason: 'Повреждена упаковка',
            actorRole: 'warehouse',
            actor: { displayName: 'Анна Складова', role: 'warehouse' },
            createdAt: new Date('2026-08-10T12:00:00.000Z'),
          },
          {
            id: 'event-unknown',
            type: 'audit:new_internal_backend_code',
            label: 'manual_deselection',
            reason: null,
            actorRole: null,
            actor: null,
            createdAt: new Date('2026-08-10T11:00:00.000Z'),
          },
        ]),
      },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
      warehouseRoll: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const service = createService(prisma);

    const context = await service.getContext('order', 'order-safe-projection');

    expect(context.statuses).toEqual([
      { title: 'Производство', valueLabel: 'В производстве' },
      { title: 'Покрытие со склада', valueLabel: 'Полностью подтверждено' },
      { title: 'Оплата', valueLabel: 'Частично оплачено' },
      { title: 'Отгрузка', valueLabel: 'Не отгружено' },
      { title: 'Этап коммерции', valueLabel: 'В производстве' },
    ]);
    expect(context.timeline).toEqual([
      {
        eventId: 'event-known',
        actionLabel: 'Рулон исключён из палетного листа',
        reason: 'Повреждена упаковка',
        actor: { displayName: 'Анна Складова', roleLabel: 'Склад' },
        occurredAt: '2026-08-10T12:00:00.000Z',
      },
      {
        eventId: 'event-unknown',
        actionLabel: 'Действие аудита',
        reason: null,
        actor: { displayName: 'Система', roleLabel: 'Система' },
        occurredAt: '2026-08-10T11:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(context)).not.toMatch(
      /"(?:eventType|label|kind|source|status|type)":|audit:|manual_deselection|in_progress|full_confirmed|partially_paid|not_shipped|in_production/u,
    );
  });

  it.each([
    {
      label: 'roll',
      token: ROLL_TOKEN,
      configure: (prisma: ReturnType<typeof searchPrisma>) =>
        prisma.rollScanToken.findUnique.mockResolvedValue({
          roll: { id: 'warehouse-roll-1', rollCode: 'ROLL-001' },
        }),
      expected: {
        objectType: 'roll',
        objectId: 'warehouse-roll-1',
        displayName: 'Рулон ROLL-001',
        secondaryLabel: null,
        matchKind: 'exact',
      },
    },
    {
      label: 'Big-Bag',
      token: BIG_BAG_TOKEN,
      configure: (prisma: ReturnType<typeof searchPrisma>) =>
        prisma.bigBagScanToken.findUnique.mockResolvedValue({
          bigBag: { id: 'bag-1', code: 'BB-ПВД-01', material: 'ПВД первичный' },
        }),
      expected: {
        objectType: 'big_bag',
        objectId: 'bag-1',
        displayName: 'Big-Bag BB-ПВД-01',
        secondaryLabel: 'ПВД первичный',
        matchKind: 'exact',
      },
    },
    {
      label: 'pallet list',
      token: PALLET_TOKEN,
      configure: (prisma: ReturnType<typeof searchPrisma>) =>
        prisma.palletScanToken.findUnique.mockResolvedValue({
          document: { id: 'pallet-document-1', palletId: 'PALLET-001' },
        }),
      expected: {
        objectType: 'pallet',
        objectId: 'pallet-document-1',
        displayName: 'Палетный лист PALLET-001',
        secondaryLabel: null,
        matchKind: 'exact',
      },
    },
  ])('resolves an exact $label scanner QR without returning the token', async (testCase) => {
    const prisma = searchPrisma();
    testCase.configure(prisma);
    const service = createService(prisma);

    const result = await service.search({ q: testCase.token, cursor: undefined, limit: 20 });

    expect(result).toEqual({ items: [testCase.expected], nextCursor: null });
    expect(JSON.stringify(result)).not.toContain(testCase.token);
  });

  it('orders exact matches before prefix and contains matches with a deterministic cursor', async () => {
    const prisma = searchPrisma({
      warehouseRoll: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { id: 'roll-1', rollCode: 'ABC', warehouseStatus: 'received' },
          { id: 'roll-2', rollCode: 'ABC-002', warehouseStatus: 'received' },
          { id: 'roll-3', rollCode: 'X-ABC-X', warehouseStatus: 'received' },
        ]),
      },
      commercialOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { id: 'order-1', orderNumber: 'ORD-1', title: 'ABC' },
          { id: 'order-2', orderNumber: 'ABC-ORDER', title: null },
          { id: 'order-3', orderNumber: 'Q-ABC-X', title: null },
        ]),
      },
    });
    const service = createService(prisma);

    const first = await service.search({ q: 'abc', cursor: undefined, limit: 3 });
    const second = await service.search({
      q: 'abc',
      cursor: first.nextCursor ?? undefined,
      limit: 3,
    });

    expect(first.items.map(({ objectId, matchKind }) => [objectId, matchKind])).toEqual([
      ['order-1', 'exact'],
      ['roll-1', 'exact'],
      ['order-2', 'prefix'],
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.items.map(({ objectId, matchKind }) => [objectId, matchKind])).toEqual([
      ['roll-2', 'prefix'],
      ['order-3', 'contains'],
      ['roll-3', 'contains'],
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('supports exact roll, order, pallet, warehouse task and operation identifiers', async () => {
    const prisma = searchPrisma({
      warehouseRoll: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'shared-id', rollCode: 'ROLL-X', warehouseStatus: 'received' },
          ]),
      },
      commercialOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'shared-id', orderNumber: 'ORDER-X', title: 'Заказ' }]),
      },
      palletListDocument: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{ id: 'shared-id', palletId: 'PALLET-X' }]),
      },
      bigBagUnit: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'shared-id', code: 'BIG-BAG-X', material: 'ПВД первичный' }]),
      },
      warehouseAcceptanceTask: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'shared-id',
            operationCode: 'TASK-X',
            mode: 'receiving',
            status: 'open',
          },
        ]),
      },
      warehouseOperation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'shared-id', kind: 'scan', status: 'completed' }]),
      },
    });
    const service = createService(prisma);

    const result = await service.search({ q: 'shared-id', cursor: undefined, limit: 20 });

    expect(result.items.map((item) => item.objectType)).toEqual([
      'order',
      'roll',
      'big_bag',
      'pallet',
      'warehouse_task',
      'warehouse_operation',
    ]);
    expect(result.items.every((item) => item.matchKind === 'exact')).toBe(true);
    expect(result.items.find((item) => item.objectType === 'warehouse_task')?.secondaryLabel).toBe(
      'Приёмка · Открыто',
    );
    expect(
      result.items.find((item) => item.objectType === 'warehouse_operation')?.secondaryLabel,
    ).toBe('Сканирование QR · Завершено');
  });

  it.each(['bag-1', 'BB-ПВД-01'])('finds a Big-Bag by the exact ID or code %s', async (query) => {
    const prisma = searchPrisma({
      bigBagUnit: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'bag-1', code: 'BB-ПВД-01', material: 'ПВД первичный' }]),
      },
    });
    const service = createService(prisma);

    await expect(service.search({ q: query, cursor: undefined, limit: 20 })).resolves.toEqual({
      items: [
        {
          objectType: 'big_bag',
          objectId: 'bag-1',
          displayName: 'Big-Bag BB-ПВД-01',
          secondaryLabel: 'ПВД первичный',
          matchKind: 'exact',
        },
      ],
      nextCursor: null,
    });
  });

  it('projects bounded order context through explicit safe fields only', async () => {
    const prisma = searchPrisma({
      commercialOrder: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'order-1',
          orderNumber: 'ORD-001',
          title: 'Тестовый заказ',
          productionIndicator: 'in_progress',
          warehouseCoverStatus: 'full_confirmed',
          paymentStatus: 'partially_paid',
          shipmentStatus: 'not_shipped',
          commercialStage: 'in_production',
          createdAt: new Date('2026-07-01T10:00:00.000Z'),
          positions: [
            {
              id: 'position-1',
              filmType: 'ПВД',
              warehouseCoverStatus: 'full_confirmed',
            },
          ],
          counterparty: { legalName: 'must-not-leak' },
          financeOrder: { totalAmountRub: 123_456 },
        }),
      },
      rollDispatchItem: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'dispatch-1',
            rollCode: 'ROLL-001',
            orderLineId: 'position-1',
            status: 'done',
            updatedAt: new Date('2026-07-02T10:00:00.000Z'),
            completedAt: new Date('2026-07-02T10:00:00.000Z'),
            operatorLine: {
              id: 'line-1',
              step: 'warehouse',
              labelState: 'verified',
              warehouseState: 'received',
              rawPayload: { hidden: true },
            },
          },
        ]),
      },
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'event-1',
            type: 'audit:warehouse_roll_received',
            label: 'Рулон принят',
            reason: null,
            actorRole: 'warehouse',
            createdAt: new Date('2026-07-03T10:00:00.000Z'),
            detail: { rawPayload: 'must-not-leak' },
            oldValue: { tokenHash: 'must-not-leak' },
            newValue: { legalName: 'must-not-leak' },
            sourceSnapshotId: 'source-private',
          },
        ]),
      },
      productionProblem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'problem-1',
            type: 'quality',
            status: 'open',
            reason: 'Проверить качество',
            createdAt: new Date('2026-07-02T12:00:00.000Z'),
            resolvedAt: null,
            recovery: 'internal-only',
          },
        ]),
      },
      defectRecord: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'defect-1',
            blocking: true,
            comment: 'Повреждение кромки',
            weightKg: 2.5,
            createdAt: new Date('2026-07-02T11:00:00.000Z'),
            tokenHash: 'must-not-leak',
          },
        ]),
      },
      weightCapture: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'weight-verified',
            kind: 'roll',
            stable: true,
            deviceStatus: 'ready',
            grossKg: 102,
            spoolKg: 2,
            netKg: 100,
            toleranceOk: true,
            createdAt: new Date('2026-07-02T09:00:00.000Z'),
            rawPayload: { hidden: true },
          },
          {
            id: 'weight-unverified',
            kind: 'roll',
            stable: false,
            deviceStatus: 'unstable',
            grossKg: 999,
            spoolKg: null,
            netKg: 999,
            toleranceOk: null,
            createdAt: new Date('2026-07-02T09:30:00.000Z'),
          },
        ]),
      },
      warehouseRoll: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'warehouse-roll-1',
            rollCode: 'ROLL-001',
            warehouseStatus: 'received',
            updatedAt: new Date('2026-07-03T09:00:00.000Z'),
            token: 'must-not-leak',
            tokenHash: 'must-not-leak',
            positionSnapshot: { legalName: 'must-not-leak' },
            currentCoverageFact: {
              id: 'coverage-fact-1',
              version: 2,
              source: 'warehouse_runtime',
              createdAt: new Date('2026-07-03T08:00:00.000Z'),
              spec: { rawPayload: 'must-not-leak' },
            },
          },
        ]),
      },
      warehouseOperation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'operation-1',
            kind: 'scan',
            status: 'succeeded',
            taskId: 'task-1',
            rollCode: 'ROLL-001',
            createdAt: new Date('2026-07-03T08:30:00.000Z'),
            completedAt: new Date('2026-07-03T08:31:00.000Z'),
            safeResult: { rawPayload: 'must-not-leak' },
          },
        ]),
      },
    });
    const service = createService(prisma);

    const context = await service.getContext('order', 'order-1');

    expect(context).toMatchObject({
      objectType: 'order',
      objectId: 'order-1',
      displayName: 'Заказ ORD-001',
      statuses: [
        { title: 'Производство', valueLabel: 'В производстве' },
        { title: 'Покрытие со склада', valueLabel: 'Полностью подтверждено' },
        { title: 'Оплата', valueLabel: 'Частично оплачено' },
        { title: 'Отгрузка', valueLabel: 'Не отгружено' },
        { title: 'Этап коммерции', valueLabel: 'В производстве' },
      ],
      timeline: [
        {
          eventId: 'event-1',
          actionLabel: 'Принят складом',
          actor: { displayName: 'Склад', roleLabel: 'Склад' },
          occurredAt: '2026-07-03T10:00:00.000Z',
        },
      ],
      problems: [{ id: 'problem-1', statusLabel: 'Открыто' }],
      defects: [{ id: 'defect-1', statusLabel: 'Блокирующий', weightKg: 2.5 }],
    });
    expect(context.links.map((link) => [link.objectType, link.objectId])).toEqual([
      ['position', 'position-1'],
      ['roll', 'dispatch-1'],
    ]);
    expect(context.productionFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Статус рулона',
          valueLabel: 'Завершено',
        }),
        expect.objectContaining({
          title: 'Текущий принятый вес рулона',
          valueLabel: '100 кг',
          isCurrent: true,
        }),
      ]),
    );
    expect(context.productionFacts.some((fact) => fact.valueLabel.includes('999'))).toBe(false);
    expect(context.warehouseFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'Статус на складе', valueLabel: 'Принят складом' }),
        expect.objectContaining({ title: 'Версия подтверждения покрытия', valueLabel: '2' }),
        expect.objectContaining({ title: 'Операция склада', valueLabel: 'Сканирование QR' }),
      ]),
    );
    expect(JSON.stringify(context)).not.toMatch(
      /rawPayload|tokenHash|legalName|totalAmountRub|sourceSnapshotId|oldValue|newValue|positionSnapshot|safeResult/,
    );
  });

  it('links a client order to a reserved finished-stock roll and its source batch', async () => {
    const prisma = {
      commercialOrder: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'client-order-1',
          orderNumber: 'A-17',
          title: null,
          productionIndicator: 'not_started',
          warehouseCoverStatus: 'full_confirmed',
          paymentStatus: 'unpaid',
          shipmentStatus: 'not_shipped',
          commercialStage: 'in_work',
          createdAt: new Date('2026-07-27T08:00:00.000Z'),
          positions: [],
        }),
      },
      rollDispatchItem: { findMany: jest.fn().mockResolvedValue([]) },
      domainEvent: {
        findMany: jest.fn(async ({ where }: { where: { objectId: { in: readonly string[] } } }) =>
          where.objectId.in.includes('stock-roll-1')
            ? [
                {
                  id: 'event-stock-reserved',
                  family: 'audit',
                  type: 'audit:finished_stock_reserved',
                  objectId: 'stock-roll-1',
                  actorKind: 'system',
                  actorRole: null,
                  actorId: null,
                  systemActorKey: 'warehouse_coverage_engine',
                  label: 'Готовая продукция зарезервирована',
                  detail: {
                    orderId: 'client-order-1',
                    sourceStockOrderId: 'stock-order-1',
                    decisionId: 'decision-1',
                  },
                  oldValue: null,
                  newValue: null,
                  reason: null,
                  sourceSnapshotId: null,
                  createdAt: new Date('2026-07-27T08:01:00.000Z'),
                },
              ]
            : [],
        ),
      },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
      warehouseRoll: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'stock-roll-1',
            rollCode: 'STOCK-ROLL-001',
            warehouseStatus: 'received',
            reservedForOrderId: 'client-order-1',
            producedForStockOrderId: 'stock-order-1',
            updatedAt: new Date('2026-07-27T08:00:00.000Z'),
            producedForStockOrder: {
              id: 'stock-order-1',
              orderNumber: 'S-3',
              stockBatchCode: 'STOCK-S-3',
              requestType: 'stock_reserve',
            },
            currentCoverageFact: null,
          },
        ]),
      },
    };
    const service = createService(prisma);

    const context = await service.getContext('order', 'client-order-1');

    expect(context.links).toEqual([
      expect.objectContaining({
        objectType: 'roll',
        objectId: 'stock-roll-1',
        relationLabel: 'Выбран из свободного резерва',
        displayName: expect.stringContaining('STOCK-S-3'),
      }),
    ]);
    expect(context.timeline).toEqual([
      expect.objectContaining({
        eventId: 'event-stock-reserved',
        actionLabel: 'Рулон зарезервирован для заказа',
      }),
    ]);
    expect(prisma.domainEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          objectId: {
            in: expect.arrayContaining(['stock-roll-1']),
          },
        },
      }),
    );
  });

  it('returns a non-reflective 404 for a missing traceability object', async () => {
    const service = createService({
      commercialOrder: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    const secretLikeId = 'scanner-input-must-not-be-reflected';

    let failure: unknown;
    try {
      await service.getContext('order', secretLikeId);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(failure)).not.toContain(secretLikeId);
  });

  it('links a roll context to its order and position with safe production and warehouse facts', async () => {
    const domainEvent = { findMany: jest.fn().mockResolvedValue([]) };
    const prisma = searchPrisma({
      warehouseRoll: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'warehouse-roll-1',
          rollCode: 'ROLL-001',
          warehouseStatus: 'received',
          reservedForOrderId: null,
          reservedForPositionId: null,
          producedForStockOrderId: null,
          updatedAt: new Date('2026-07-03T09:00:00.000Z'),
          currentCoverageFact: {
            id: 'coverage-fact-1',
            version: 2,
            source: 'warehouse_runtime',
            sourceOrderId: 'order-1',
            sourcePositionId: 'position-1',
            createdAt: new Date('2026-07-03T08:00:00.000Z'),
            spec: { rawPayload: 'must-not-leak' },
          },
          scanToken: { token: 'must-not-leak' },
        }),
      },
      rollDispatchItem: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'dispatch-1',
          rollCode: 'ROLL-001',
          orderLineId: 'position-1',
          status: 'done',
          updatedAt: new Date('2026-07-02T10:00:00.000Z'),
          completedAt: new Date('2026-07-02T10:00:00.000Z'),
          operatorLine: {
            id: 'line-1',
            step: 'warehouse',
            labelState: 'verified',
            warehouseState: 'received',
          },
          productionOrder: {
            id: 'production-order-1',
            commercialOrder: {
              id: 'order-1',
              orderNumber: 'ORD-001',
              title: 'Тестовый заказ',
              productionIndicator: 'done',
              warehouseCoverStatus: 'full_confirmed',
              paymentStatus: 'unpaid',
              shipmentStatus: 'not_shipped',
              legalName: 'must-not-leak',
            },
          },
        }),
      },
      domainEvent,
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
      defectRecord: { findMany: jest.fn().mockResolvedValue([]) },
      weightCapture: { findMany: jest.fn().mockResolvedValue([]) },
      warehouseOperation: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'operation-1',
            kind: 'scan',
            status: 'succeeded',
            taskId: 'task-1',
            rollCode: 'ROLL-001',
            createdAt: new Date('2026-07-03T10:30:00.000Z'),
            completedAt: new Date('2026-07-03T10:31:00.000Z'),
          },
        ]),
      },
    });
    const service = createService(prisma);

    const context = await service.getContext('roll', 'ROLL-001');

    expect(context).toMatchObject({
      objectType: 'roll',
      objectId: 'warehouse-roll-1',
      displayName: 'Рулон ROLL-001',
      statuses: expect.arrayContaining([
        { title: 'Рулон', valueLabel: 'Завершено' },
        { title: 'Шаг оператора', valueLabel: 'На складе' },
        { title: 'Этикетка', valueLabel: 'Проверена' },
        { title: 'Склад', valueLabel: 'Принят складом' },
      ]),
      links: expect.arrayContaining([
        expect.objectContaining({ objectType: 'order', objectId: 'order-1' }),
        expect.objectContaining({ objectType: 'position', objectId: 'position-1' }),
      ]),
      productionFacts: [
        expect.objectContaining({ title: 'Статус рулона', valueLabel: 'Завершено' }),
      ],
      warehouseFacts: expect.arrayContaining([
        expect.objectContaining({ title: 'Статус на складе', valueLabel: 'Принят складом' }),
        expect.objectContaining({ title: 'Версия подтверждения покрытия', valueLabel: '2' }),
        expect.objectContaining({ title: 'Операция склада', valueLabel: 'Сканирование QR' }),
      ]),
    });
    const timelineIds = domainEvent.findMany.mock.calls[0][0].where.objectId.in;
    expect(timelineIds).toEqual(
      expect.arrayContaining(['warehouse-roll-1', 'dispatch-1', 'ROLL-001', 'line-1']),
    );
    expect(timelineIds).not.toEqual(expect.arrayContaining(['order-1', 'position-1']));
    expect(JSON.stringify(context)).not.toMatch(/rawPayload|legalName|scanToken|tokenHash/);
  });

  it('links a reserved stock roll to both its source batch and target client order', async () => {
    const prisma = {
      warehouseRoll: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'stock-roll-1',
          rollCode: 'STOCK-ROLL-001',
          warehouseStatus: 'received',
          reservedForOrderId: 'client-order-1',
          reservedForPositionId: 'client-position-1',
          producedForStockOrderId: 'stock-order-1',
          updatedAt: new Date('2026-07-27T08:00:00.000Z'),
          producedForStockOrder: {
            id: 'stock-order-1',
            orderNumber: 'S-3',
            stockBatchCode: 'STOCK-S-3',
            requestType: 'stock_reserve',
          },
          currentCoverageFact: {
            id: 'fact-1',
            version: 1,
            source: 'production_handover',
            sourceOrderId: 'stock-order-1',
            sourcePositionId: 'stock-position-1',
            createdAt: new Date('2026-07-27T07:00:00.000Z'),
          },
        }),
      },
      rollDispatchItem: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'dispatch-stock-1',
          rollCode: 'STOCK-ROLL-001',
          orderLineId: 'stock-position-1',
          status: 'done',
          updatedAt: new Date('2026-07-27T07:00:00.000Z'),
          completedAt: new Date('2026-07-27T07:00:00.000Z'),
          operatorLine: null,
          productionOrder: {
            id: 'production-stock-1',
            commercialOrder: {
              id: 'stock-order-1',
              orderNumber: 'S-3',
              title: null,
              requestType: 'stock_reserve',
              stockBatchCode: 'STOCK-S-3',
              productionIndicator: 'completed',
              warehouseCoverStatus: 'not_checked',
              paymentStatus: 'not_applicable',
              shipmentStatus: 'not_applicable',
            },
          },
        }),
      },
      commercialOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'client-order-1',
          orderNumber: 'A-17',
        }),
      },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
      warehouseOperation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = createService(prisma);

    const context = await service.getContext('roll', 'STOCK-ROLL-001');

    expect(context.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectType: 'order',
          objectId: 'stock-order-1',
          relationLabel: 'Произведён в свободный резерв',
          displayName: expect.stringContaining('STOCK-S-3'),
        }),
        expect.objectContaining({
          objectType: 'order',
          objectId: 'client-order-1',
          relationLabel: 'Зарезервирован для',
          displayName: 'Заказ A-17',
        }),
      ]),
    );
  });

  it('projects one Big-Bag with material, weights, movement, shift usage, print and scoped audit', async () => {
    const prisma = {
      bigBagUnit: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'bag-1',
          code: 'BB-ПВД-01',
          material: 'ПВД первичный',
          batchCode: 'BATCH-07',
          status: 'in_use',
          registrationStatus: 'registered',
          location: 'production',
          initialKg: 500,
          currentKg: 420,
          lastMeasuredKg: 421,
          lastMeasuredAt: new Date('2026-08-14T06:45:00.000Z'),
          lastWarehouseMeasuredKg: 425,
          lastWarehouseMeasuredAt: new Date('2026-08-14T05:55:00.000Z'),
          createdAt: new Date('2026-08-13T07:00:00.000Z'),
          movements: [
            {
              id: 'movement-1',
              kind: 'to_production',
              fromLocation: 'warehouse',
              toLocation: 'production',
              operatorReportedKg: 420,
              warehouseMeasuredKg: 425,
              differenceKg: -5,
              differencePercent: -1.176,
              actorRole: 'warehouse',
              createdAt: new Date('2026-08-14T06:00:00.000Z'),
              operationKey: 'must-not-leak',
              requestFingerprint: 'must-not-leak',
              resultSnapshot: { rawPayload: 'must-not-leak' },
            },
          ],
          shiftUsages: [
            {
              id: 'usage-1',
              startKg: 425,
              endKg: null,
              addedReason: 'Основная загрузка',
              releasedReason: null,
              createdAt: new Date('2026-08-14T06:10:00.000Z'),
              closedAt: null,
              session: {
                id: 'session-must-not-leak',
                operator: { displayName: 'Иван Оператор', login: 'must-not-leak' },
                post: { code: 'POST-2', name: 'Экструдер 2', agentSecretHash: 'must-not-leak' },
                shift: { id: 'shift-must-not-leak', label: 'Смена 14.08' },
              },
            },
          ],
          printJobs: [
            {
              id: 'print-1',
              status: 'submitted',
              reason: 'Первая этикетка',
              failureReason: null,
              createdAt: new Date('2026-08-13T07:05:00.000Z'),
              updatedAt: new Date('2026-08-13T07:06:00.000Z'),
              printerId: 'must-not-leak',
              gatewayCommandId: 'must-not-leak',
            },
          ],
          scanToken: { token: BIG_BAG_TOKEN },
        }),
      },
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'event-bag-moved',
            type: 'audit:bigbag_moved_to_production',
            label: 'Big-Bag передан в производство',
            reason: null,
            actorRole: 'warehouse',
            actor: { displayName: 'Анна Складова', role: 'warehouse' },
            createdAt: new Date('2026-08-14T06:00:00.000Z'),
          },
        ]),
      },
    };
    const service = createService(prisma);

    const context = await service.getContext('big_bag', 'bag-1');

    expect(context).toMatchObject({
      objectType: 'big_bag',
      objectId: 'bag-1',
      displayName: 'Big-Bag BB-ПВД-01',
      statuses: expect.arrayContaining([
        { title: 'Big-Bag', valueLabel: 'Используется' },
        { title: 'Регистрация', valueLabel: 'Зарегистрирован' },
        { title: 'Местоположение', valueLabel: 'На производстве' },
        { title: 'Этикетка', valueLabel: 'Передана на печать' },
      ]),
      productionFacts: expect.arrayContaining([
        expect.objectContaining({ title: 'Материал', valueLabel: 'ПВД первичный' }),
        expect.objectContaining({ title: 'Партия', valueLabel: 'BATCH-07' }),
        expect.objectContaining({ title: 'Начальный вес', valueLabel: '500 кг' }),
        expect.objectContaining({ title: 'Текущий вес', valueLabel: '420 кг' }),
        expect.objectContaining({
          title: 'Использование в смене',
          valueLabel: expect.stringMatching(/Смена 14\.08.*Иван Оператор.*425 кг/u),
        }),
      ]),
      warehouseFacts: expect.arrayContaining([
        expect.objectContaining({ title: 'Последний вес склада', valueLabel: '425 кг' }),
        expect.objectContaining({
          title: 'Движение Big-Bag',
          valueLabel: expect.stringMatching(/Со склада.*На производство.*425 кг.*420 кг/u),
        }),
        expect.objectContaining({ title: 'Печать этикетки', valueLabel: 'Передана на печать' }),
      ]),
      timeline: [
        expect.objectContaining({
          eventId: 'event-bag-moved',
          actionLabel: 'Big-Bag передан в производство',
        }),
      ],
    });
    const timelineIds = prisma.domainEvent.findMany.mock.calls[0][0].where.objectId.in;
    expect(timelineIds).toEqual(
      expect.arrayContaining(['bag-1', 'BB-ПВД-01', 'movement-1', 'usage-1', 'print-1']),
    );
    expect(timelineIds).not.toEqual(
      expect.arrayContaining(['session-must-not-leak', 'shift-must-not-leak']),
    );
    expect(JSON.stringify(context)).not.toMatch(
      /bbt_|scanToken|session-must-not-leak|shift-must-not-leak|operationKey|requestFingerprint|resultSnapshot|printerId|gatewayCommandId|rawPayload|login|agentSecret/u,
    );
  });

  it('resolves safe position and pallet contexts for every registered link target', async () => {
    const positionService = createService({
      commercialOrderPosition: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'position-1',
          filmType: 'ПВД',
          warehouseCoverStatus: 'full_confirmed',
          order: {
            id: 'order-1',
            orderNumber: 'ORD-001',
            title: 'Тестовый заказ',
          },
          recipe: { parameters: { rawPayload: 'must-not-leak' } },
        }),
      },
      rollDispatchItem: { findMany: jest.fn().mockResolvedValue([]) },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const palletPrisma = {
      palletListDocument: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pallet-document-1',
          palletId: 'PALLET-001',
          rollIds: ['warehouse-roll-1', 'dispatch-roll-2'],
          orderIds: ['order-1', 'order-2'],
          format: 'pdf',
          fieldSetStatus: 'ready',
          createdAt: new Date('2026-07-03T10:00:00.000Z'),
          voidedAt: new Date('2026-07-03T12:00:00.000Z'),
          voidReasonCode: 'print_problem',
          voidNote: null,
          payload: {
            label: {
              orderNumbers: ['LEGACY-MUST-NOT-WIN'],
              customerAliases: ['Legacy client'],
              rollCount: 99,
            },
            rawPayload: 'must-not-leak',
          },
          warehousePallet: {
            id: 'physical-pallet-1',
            palletCode: 'PALLET-001',
            status: 'voided',
            sealedAt: new Date('2026-07-03T09:55:00.000Z'),
            voidedAt: new Date('2026-07-03T12:00:00.000Z'),
          },
          printJobs: [
            {
              id: 'pallet-print-1',
              status: 'submitted',
              reason: 'Первая печать',
              failureReason: null,
              createdAt: new Date('2026-07-03T10:05:00.000Z'),
              completedAt: new Date('2026-07-03T10:06:00.000Z'),
              printerId: 'must-not-leak',
              gatewayCommandId: 'must-not-leak',
            },
          ],
        }),
      },
      commercialOrder: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'order-1',
            orderNumber: 'ORD-001',
            counterparty: { displayName: 'Альфа' },
          },
          {
            id: 'order-2',
            orderNumber: 'ORD-002',
            counterparty: { displayName: 'Бета' },
          },
        ]),
      },
      warehouseRoll: {
        findMany: jest.fn().mockResolvedValue([{ id: 'warehouse-roll-1', rollCode: 'ROLL-001' }]),
      },
      rollDispatchItem: {
        findMany: jest.fn().mockResolvedValue([{ id: 'dispatch-roll-2', rollCode: 'ROLL-002' }]),
      },
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'event-pallet-voided',
            type: 'audit:pallet_list_voided',
            label: 'Палетный лист аннулирован',
            reason: 'Ошибка состава',
            actorRole: 'warehouse',
            actor: null,
            createdAt: new Date('2026-07-03T12:00:00.000Z'),
          },
        ]),
      },
    };
    const palletService = createService(palletPrisma);

    const position = await positionService.getContext('position', 'position-1');
    const pallet = await palletService.getContext('pallet', 'PALLET-001');

    expect(position).toMatchObject({
      objectType: 'position',
      objectId: 'position-1',
      displayName: 'Позиция ПВД',
      statuses: [{ title: 'Покрытие со склада', valueLabel: 'Полностью подтверждено' }],
      links: [expect.objectContaining({ objectType: 'order', objectId: 'order-1' })],
    });
    expect(pallet).toMatchObject({
      objectType: 'pallet',
      objectId: 'pallet-document-1',
      displayName: 'Палетный лист PALLET-001',
      statuses: expect.arrayContaining([
        { title: 'Документ', valueLabel: 'Аннулирован' },
        { title: 'Палета', valueLabel: 'Аннулирована' },
        { title: 'Формат', valueLabel: 'PDF' },
        { title: 'Печать', valueLabel: 'Передана на печать' },
      ]),
      links: expect.arrayContaining([
        expect.objectContaining({
          objectType: 'order',
          objectId: 'order-1',
          displayName: 'Заказ ORD-001 · Альфа',
        }),
        expect.objectContaining({ objectType: 'roll', displayName: 'Рулон ROLL-001' }),
        expect.objectContaining({ objectType: 'roll', displayName: 'Рулон ROLL-002' }),
      ]),
      warehouseFacts: expect.arrayContaining([
        expect.objectContaining({ title: 'Количество рулонов', valueLabel: '2' }),
        expect.objectContaining({ title: 'Заказы', valueLabel: 'ORD-001, ORD-002' }),
        expect.objectContaining({ title: 'Заказчики', valueLabel: 'Альфа, Бета' }),
        expect.objectContaining({ title: 'Рулоны', valueLabel: 'ROLL-001, ROLL-002' }),
        expect.objectContaining({ title: 'Печать', valueLabel: 'Передана на печать' }),
        expect.objectContaining({ title: 'Аннулирование', valueLabel: 'Проблема печати' }),
      ]),
      timeline: [
        expect.objectContaining({
          eventId: 'event-pallet-voided',
          actionLabel: 'Палетный лист аннулирован',
        }),
      ],
    });
    const palletTimelineIds = palletPrisma.domainEvent.findMany.mock.calls[0][0].where.objectId.in;
    expect(palletTimelineIds).toEqual(
      expect.arrayContaining([
        'pallet-document-1',
        'PALLET-001',
        'physical-pallet-1',
        'pallet-print-1',
      ]),
    );
    expect(palletTimelineIds).not.toEqual(
      expect.arrayContaining(['order-1', 'order-2', 'warehouse-roll-1', 'dispatch-roll-2']),
    );
    expect(JSON.stringify({ position, pallet })).not.toMatch(
      /rawPayload|parameters|payload|LEGACY-MUST-NOT-WIN|printerId|gatewayCommandId/u,
    );
  });

  it('resolves a safe warehouse task context with canonical succeeded operation facts', async () => {
    const taskService = createService({
      warehouseAcceptanceTask: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'task-1',
          operationCode: 'ПР-2707-01',
          mode: 'receiving',
          status: 'closed',
          orderId: 'order-1',
          positionId: 'position-1',
          createdAt: new Date('2026-07-03T10:00:00.000Z'),
          updatedAt: new Date('2026-07-03T11:00:00.000Z'),
          rows: [{ id: 'row-1', rollCode: 'ROLL-001', scanStatus: 'accepted' }],
          operations: [
            {
              id: 'operation-1',
              kind: 'scan',
              status: 'succeeded',
              rollCode: 'ROLL-001',
              createdAt: new Date('2026-07-03T10:30:00.000Z'),
              completedAt: new Date('2026-07-03T10:31:00.000Z'),
              safeResult: { rawPayload: 'must-not-leak' },
            },
            {
              id: 'operation-legacy',
              kind: 'mark_damaged',
              status: 'completed',
              rollCode: 'ROLL-001',
              createdAt: new Date('2026-07-03T10:32:00.000Z'),
              completedAt: new Date('2026-07-03T10:33:00.000Z'),
              safeResult: { rawPayload: 'must-not-leak' },
            },
          ],
        }),
      },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const task = await taskService.getContext('warehouse_task', 'task-1');

    expect(task).toMatchObject({
      objectType: 'warehouse_task',
      objectId: 'task-1',
      statuses: [
        { title: 'Задача', valueLabel: 'Закрыто' },
        { title: 'Режим', valueLabel: 'Приёмка' },
      ],
      warehouseFacts: expect.arrayContaining([
        expect.objectContaining({ title: 'Операция склада', valueLabel: 'Сканирование QR' }),
        expect.objectContaining({ title: 'Операция склада', valueLabel: 'Зафиксирован дефект' }),
      ]),
    });
    expect(JSON.stringify(task)).not.toMatch(/rawPayload|safeResult/);
  });

  it('resolves a safe canonical succeeded warehouse operation context', async () => {
    const operationService = createService({
      warehouseOperation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'operation-1',
          kind: 'scan',
          status: 'succeeded',
          taskId: 'task-1',
          rollCode: 'ROLL-001',
          createdAt: new Date('2026-07-03T10:30:00.000Z'),
          completedAt: new Date('2026-07-03T10:31:00.000Z'),
          task: {
            id: 'task-1',
            operationCode: 'ПР-2707-01',
            mode: 'receiving',
            status: 'closed',
          },
          scanRow: {
            id: 'row-1',
            rollCode: 'ROLL-001',
            scanStatus: 'accepted',
          },
          safeResult: { rawPayload: 'must-not-leak' },
        }),
      },
      domainEvent: { findMany: jest.fn().mockResolvedValue([]) },
      productionProblem: { findMany: jest.fn().mockResolvedValue([]) },
    });

    const operation = await operationService.getContext('warehouse_operation', 'operation-1');

    expect(operation).toMatchObject({
      objectType: 'warehouse_operation',
      objectId: 'operation-1',
      statuses: [
        { title: 'Операция', valueLabel: 'Выполнено' },
        { title: 'Тип операции', valueLabel: 'Сканирование QR' },
      ],
      links: expect.arrayContaining([
        expect.objectContaining({ objectType: 'warehouse_task', objectId: 'task-1' }),
        expect.objectContaining({ objectType: 'roll', objectId: 'ROLL-001' }),
      ]),
      warehouseFacts: [
        expect.objectContaining({ title: 'Операция склада', valueLabel: 'Сканирование QR' }),
      ],
    });
    expect(JSON.stringify(operation)).not.toMatch(/rawPayload|safeResult/);
  });
});
