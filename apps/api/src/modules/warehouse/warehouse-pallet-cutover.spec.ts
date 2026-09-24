import {
  parseWarehousePalletCutoverMode,
  planWarehousePalletCutover,
  WarehousePalletCutoverBlockedError,
  WarehousePalletCutoverService,
  type WarehousePalletCutoverInput,
} from './warehouse-pallet-cutover';

const acceptedRow = (
  id: string,
  rollCode: string,
  orderId: string | null,
  lastScanAt = '2026-07-31T12:00:00.000Z',
) => ({ id, rollCode, orderId, lastScanAt });

const task = (
  rows: WarehousePalletCutoverInput['tasks'][number]['rows'],
  overrides: Partial<WarehousePalletCutoverInput['tasks'][number]> = {},
): WarehousePalletCutoverInput['tasks'][number] => ({
  id: 'task-1',
  operationCode: 'ПР-3107-01',
  rows,
  ...overrides,
});

const document = (
  id: string,
  rollIds: string[],
  printStatuses: string[],
  overrides: Partial<WarehousePalletCutoverInput['documents'][number]> = {},
): WarehousePalletCutoverInput['documents'][number] => ({
  id,
  palletId: 'ПР-3107-01',
  acceptanceTaskId: null,
  rollIds,
  printStatuses,
  ...overrides,
});

describe('planWarehousePalletCutover', () => {
  it('returns a clean empty plan when no accepted rows need a pallet', () => {
    expect(planWarehousePalletCutover({ tasks: [task([])], documents: [] })).toEqual({
      tasksInspected: 1,
      palletsToCreate: [],
      documentLinks: [],
      issues: [],
    });
  });

  it('plans one open pallet in deterministic scan order for one commercial order', () => {
    const input: WarehousePalletCutoverInput = {
      tasks: [
        task([
          acceptedRow('row-c', 'ROLL-C', 'order-a', '2026-07-31T12:03:00.000Z'),
          acceptedRow('row-b', 'ROLL-B', 'order-a', '2026-07-31T12:02:00.000Z'),
          acceptedRow('row-a', 'ROLL-A', 'order-a', '2026-07-31T12:02:00.000Z'),
        ]),
      ],
      documents: [],
    };

    expect(planWarehousePalletCutover(input)).toEqual({
      tasksInspected: 1,
      palletsToCreate: [
        {
          taskId: 'task-1',
          orderId: 'order-a',
          rollCodes: ['ROLL-A', 'ROLL-B', 'ROLL-C'],
        },
      ],
      documentLinks: [],
      issues: [],
    });
  });

  it('links a submitted legacy document and excludes its rolls from the open pallet', () => {
    const plan = planWarehousePalletCutover({
      tasks: [
        task([
          acceptedRow('row-1', 'ROLL-1', 'order-a'),
          acceptedRow('row-2', 'ROLL-2', 'order-a'),
          acceptedRow('row-3', 'ROLL-3', 'order-a'),
        ]),
      ],
      documents: [document('document-1', ['ROLL-1', 'ROLL-2'], ['submitted'])],
    });

    expect(plan.documentLinks).toEqual([{ documentId: 'document-1', taskId: 'task-1' }]);
    expect(plan.palletsToCreate).toEqual([
      { taskId: 'task-1', orderId: 'order-a', rollCodes: ['ROLL-3'] },
    ]);
    expect(plan.issues).toEqual([]);
  });

  it('does not treat a failed-only legacy print as a closed pallet', () => {
    const plan = planWarehousePalletCutover({
      tasks: [
        task([
          acceptedRow('row-1', 'ROLL-1', 'order-a'),
          acceptedRow('row-2', 'ROLL-2', 'order-a'),
        ]),
      ],
      documents: [document('document-1', ['ROLL-1'], ['failed'])],
    });

    expect(plan.palletsToCreate).toEqual([
      { taskId: 'task-1', orderId: 'order-a', rollCodes: ['ROLL-1', 'ROLL-2'] },
    ]);
    expect(plan.issues).toEqual([]);
  });

  it('reports multiple remaining orders instead of picking or mixing one', () => {
    const plan = planWarehousePalletCutover({
      tasks: [
        task([
          acceptedRow('row-1', 'ROLL-1', 'order-b'),
          acceptedRow('row-2', 'ROLL-2', 'order-a'),
        ]),
      ],
      documents: [],
    });

    expect(plan.palletsToCreate).toEqual([]);
    expect(plan.issues).toEqual([
      {
        taskId: 'task-1',
        code: 'MULTIPLE_UNPRINTED_ORDERS',
        safeDetail: {
          orderIds: ['order-a', 'order-b'],
          rollCodes: ['ROLL-1', 'ROLL-2'],
        },
      },
    ]);
  });

  it('reports a roll included in multiple successfully dispatched legacy documents', () => {
    const plan = planWarehousePalletCutover({
      tasks: [task([acceptedRow('row-1', 'ROLL-1', 'order-a')])],
      documents: [
        document('document-b', ['ROLL-1'], ['delivery_unknown']),
        document('document-a', ['ROLL-1'], ['submitted']),
      ],
    });

    expect(plan.palletsToCreate).toEqual([]);
    expect(plan.issues).toEqual([
      {
        taskId: 'task-1',
        code: 'ROLL_IN_MULTIPLE_PRINTED_DOCUMENTS',
        safeDetail: {
          documentIds: ['document-a', 'document-b'],
          rollCode: 'ROLL-1',
        },
      },
    ]);
  });

  it('reports missing canonical order and an unresolved explicit task link', () => {
    const plan = planWarehousePalletCutover({
      tasks: [task([acceptedRow('row-1', 'ROLL-1', null)])],
      documents: [
        document('document-unresolved', ['ROLL-X'], ['submitted'], {
          acceptanceTaskId: 'missing-task',
          palletId: 'unrelated',
        }),
      ],
    });

    expect(plan.palletsToCreate).toEqual([]);
    expect(plan.documentLinks).toEqual([]);
    expect(plan.issues).toEqual([
      {
        taskId: 'missing-task',
        code: 'AMBIGUOUS_DOCUMENT_TASK',
        safeDetail: {
          candidateTaskIds: [],
          documentId: 'document-unresolved',
        },
      },
      {
        taskId: 'task-1',
        code: 'MISSING_ORDER',
        safeDetail: { rollCodes: ['ROLL-1'] },
      },
    ]);
  });
});

describe('WarehousePalletCutoverService', () => {
  const setup = (orders = ['order-a']) => {
    const rows = orders.map((orderId, index) => ({
      id: `row-${index + 1}`,
      rollCode: `ROLL-${index + 1}`,
      lastScanAt: new Date(`2026-07-31T12:0${index}:00.000Z`),
    }));
    const taskRecord = {
      id: 'task-1',
      operationCode: 'ПР-3107-01',
      updatedAt: new Date('2026-07-31T12:10:00.000Z'),
      rows,
    };
    const operatorLines = rows.map((row, index) => ({
      rollDispatchItem: {
        rollCode: row.rollCode,
        productionOrder: {
          commercialOrder: {
            id: orders[index],
            orderNumber: `ORDER-${index + 1}`,
          },
        },
      },
    }));
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      warehouseAcceptanceTask: {
        findMany: jest.fn().mockResolvedValue([taskRecord]),
      },
      operatorRollLine: {
        findMany: jest.fn().mockResolvedValue(operatorLines),
      },
      palletListDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      warehousePallet: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ sequenceNo: 0 }),
        create: jest.fn().mockResolvedValue({
          id: 'pallet-created',
          palletCode: 'PAL-ORDER-1-01',
        }),
      },
      warehousePalletItem: {
        createMany: jest.fn().mockResolvedValue({ count: rows.length }),
      },
      domainEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
    };
    const prisma = {
      warehouseAcceptanceTask: tx.warehouseAcceptanceTask,
      operatorRollLine: tx.operatorRollLine,
      palletListDocument: tx.palletListDocument,
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const audit = {
      record: jest.fn().mockResolvedValue({ id: 'event-1' }),
    };
    const service = new WarehousePalletCutoverService(prisma as never, audit as never);
    return { audit, prisma, rows, service, tx };
  };

  it('keeps released membership history reconciled during a dry-run', async () => {
    const { prisma, service } = setup();

    await expect(service.dryRun()).resolves.toMatchObject({
      mode: 'dry-run',
      applied: false,
      tasksInspected: 1,
      palletsToCreate: [
        {
          taskId: 'task-1',
          orderId: 'order-a',
          rollCodes: ['ROLL-1'],
        },
      ],
      issues: [],
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          rows: expect.objectContaining({
            where: {
              scanStatus: 'accepted',
              palletItems: { none: {} },
            },
          }),
        }),
      }),
    );
  });

  it('blocks apply before the write transaction when the preflight is ambiguous', async () => {
    const { prisma, service } = setup(['order-b', 'order-a']);

    await expect(service.apply()).rejects.toBeInstanceOf(WarehousePalletCutoverBlockedError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rechecks under task locks and applies links, pallet items and one audit fact atomically', async () => {
    const { audit, prisma, service, tx } = setup();
    tx.palletListDocument.findMany.mockResolvedValue([
      {
        id: 'document-1',
        palletId: 'ПР-3107-01',
        acceptanceTaskId: null,
        rollIds: ['PRINTED-ROLL'],
        printJobs: [{ status: 'failed' }],
      },
    ]);

    await expect(service.apply()).resolves.toMatchObject({
      mode: 'apply',
      applied: true,
      documentsLinked: 1,
      palletsCreated: 1,
      itemsCreated: 1,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.palletListDocument.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'document-1',
        origin: 'legacy',
        acceptanceTaskId: null,
      },
      data: { acceptanceTaskId: 'task-1' },
    });
    expect(tx.warehousePallet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskId: 'task-1',
        orderId: 'order-a',
        sequenceNo: 1,
        status: 'open',
      }),
      select: { id: true, palletCode: true },
    });
    expect(tx.warehousePalletItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          palletId: 'pallet-created',
          scanRowId: 'row-1',
          orderId: 'order-a',
          rollCode: 'ROLL-1',
          position: 1,
        }),
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_pallet_cutover_applied',
        actor: {
          kind: 'system',
          systemActorKey: 'warehouse-pallet-cutover',
        },
      }),
      tx,
    );
  });

  it('is a no-op on replay after every legacy fact has already been reconciled', async () => {
    const { audit, prisma, service, tx } = setup([]);

    await expect(service.apply()).resolves.toMatchObject({
      mode: 'apply',
      applied: true,
      documentsLinked: 0,
      palletsCreated: 0,
      itemsCreated: 0,
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          rows: expect.objectContaining({
            where: {
              scanStatus: 'accepted',
              palletItems: { none: {} },
            },
          }),
        }),
      }),
    );
    expect(tx.warehousePallet.create).not.toHaveBeenCalled();
    expect(tx.warehousePalletItem.createMany).not.toHaveBeenCalled();
  });
});

describe('parseWarehousePalletCutoverMode', () => {
  it.each([
    [['--dry-run'], 'dry-run'],
    [['--apply'], 'apply'],
  ] as const)('parses %s', (argv, expected) => {
    expect(parseWarehousePalletCutoverMode([...argv])).toBe(expected);
  });

  const invalidInvocations: Array<[string[]]> = [[[]], [['--dry-run', '--apply']], [['--unknown']]];

  it.each(invalidInvocations)('rejects an unsafe or ambiguous invocation %#', (argv) => {
    expect(() => parseWarehousePalletCutoverMode(argv)).toThrow(
      'Use exactly one of --dry-run or --apply',
    );
  });
});
