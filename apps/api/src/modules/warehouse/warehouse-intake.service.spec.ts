import { WarehouseIntakeService } from './warehouse-intake.service';
import { WarehousePalletSelectionService } from './warehouse-pallet-selection.service';

const ACTOR = { userId: 'wh-1', role: 'warehouse' as const };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    taskId: 't1',
    rollCode: 'A-1024-roll-1',
    fromOrderId: 'A-1024',
    scanStatus: 'expected',
    lastScanAt: null,
    scannedByName: null,
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    mode: 'receiving',
    status: 'open',
    operationCode: 'ПР-1307-01',
    createdAt: new Date('2026-07-13T08:00:00Z'),
    updatedAt: new Date('2026-07-13T08:30:00Z'),
    rows: [row()],
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    sequence: 1,
    planKg: 41.2,
    netKg: 41.4,
    grossKg: 42.1,
    warehouseState: 'sent',
    rollDispatchItem: {
      id: 'dispatch-1',
      orderLineId: 'position-1',
      rollCode: 'A-1024-roll-1',
      filmType: 'ПВД',
      plannedLengthM: 275,
      characteristicsSnapshot: {
        filmType: 'полурукав',
        materialMark: 'ПВД',
        sizeMeters: '2000мм',
        actualThickness: '120 мкм',
        spoolType: '76 мм',
      },
      assignedOperator: { displayName: 'Оператор 1' },
      post: { id: 'post-1', name: 'Станок 1', code: 'M-1' },
      status: 'done',
      completedAt: new Date('2026-07-12T08:00:00Z'),
      productionOrder: {
        id: 'production-1',
        commercialOrder: {
          id: 'order-a',
          orderNumber: 'A-1024',
          counterparty: { displayName: 'УралПак', legalName: 'ООО «УралПак»' },
        },
      },
    },
    ...overrides,
  };
}

function palletDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pallet-doc-2',
    palletId: 'PAL-A-1024-01',
    warehousePalletId: 'pallet-1',
    origin: 'physical_pallet' as const,
    createdAt: '2026-07-14T12:00:00.000Z',
    templateVersion: 'pallet-100x150-v1' as const,
    printReady: true,
    printStatus: 'failed' as const,
    rollCount: 1,
    orderId: 'order-a',
    ...overrides,
  };
}

function setup(
  opts: {
    tasks?: any[];
    lines?: any[];
    plannedRollCounts?: Array<{ orderId: string; _sum: { rollCount: number | null } }>;
  } = {},
) {
  const tasks = opts.tasks ?? [task()];
  const prisma: any = {
    warehouseAcceptanceTask: {
      findMany: jest.fn().mockResolvedValue(tasks),
      findFirst: jest.fn().mockResolvedValue(tasks[0] ?? null),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(tasks.find((t) => t.id === where.id) ?? null),
        ),
      update: jest.fn(),
    },
    operatorRollLine: { findMany: jest.fn().mockResolvedValue(opts.lines ?? [line()]) },
    commercialOrderPosition: {
      groupBy: jest
        .fn()
        .mockResolvedValue(
          opts.plannedRollCounts ?? [{ orderId: 'order-a', _sum: { rollCount: 1 } }],
        ),
    },
    warehouseRoll: { findMany: jest.fn().mockResolvedValue([]) },
    palletListDocument: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'pallet-doc-1', createdAt: new Date(), ...data }),
        ),
    },
    scanRow: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(row({ id: 'row-x' })),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ displayName: 'Кладовщик Пётр' }) },
  };
  const audit = { record: jest.fn() };
  const palletExport = {
    export: jest.fn(),
    preview: jest.fn(),
  };
  const pallets = {
    projectForTasks: jest
      .fn()
      .mockImplementation((taskIds: string[]) =>
        Promise.resolve(
          new Map(
            taskIds.map((taskId) => [taskId, { activePallet: null, history: [], hasMore: false }]),
          ),
        ),
      ),
  };
  const service = new WarehouseIntakeService(
    prisma,
    audit as any,
    palletExport as any,
    pallets as any,
    { palletLabelProfile: 'pallet-100x150-v1' },
  );
  return { service, prisma, audit, pallets };
}

describe('WarehouseIntakeService.getIntake', () => {
  it('projects the full planned order roll count independently of handed-over scan rows', async () => {
    const { service, prisma } = setup({
      tasks: [task({ orderId: 'order-a', rows: [row()] })],
      plannedRollCounts: [{ orderId: 'order-a', _sum: { rollCount: 60 } }],
    });

    const view = (await service.getIntake(ACTOR.role)).tasks[0] as unknown as {
      plannedRollCount: number;
    };

    expect(view.plannedRollCount).toBe(60);
    expect(prisma.commercialOrderPosition.groupBy).toHaveBeenCalledWith({
      by: ['orderId'],
      where: { orderId: { in: ['order-a'] } },
      _sum: { rollCount: true },
    });
  });

  it('joins real roll data and projects the customer alias only', async () => {
    const { service } = setup();
    const intake = await service.getIntake(ACTOR.role);
    expect(intake.tasks).toHaveLength(1);
    const view = intake.tasks[0];
    expect(view.operationCode).toBe('ПР-1307-01');
    expect(view.orderNumber).toBe('A-1024');
    expect(view.customerAlias).toBe('УралПак');
    expect(view.activePallet).toBeNull();
    expect(view.palletHistory).toEqual([]);
    expect(view.palletHistoryHasMore).toBe(false);
    expect(view.rolls[0]).toEqual(
      expect.objectContaining({
        scanRowId: 'row-1',
        rollCode: 'A-1024-roll-1',
        orderLineId: 'position-1',
        planKg: 41.2,
        netKg: 41.4,
        scanStatus: 'expected',
        warehouseState: 'sent',
        characteristics: expect.objectContaining({
          filmType: 'полурукав',
          materialMark: 'ПВД',
          lengthMeters: '275м',
        }),
      }),
    );
    expect(JSON.stringify(intake)).not.toContain('ООО «УралПак»');
  });

  it('uses distinct projected scan row ids as exact pallet-selection targets', async () => {
    const persistedRows = [
      row({ id: 'scan-row-a', rollCode: 'ROLL-A', scanStatus: 'accepted' }),
      row({ id: 'scan-row-b', rollCode: 'ROLL-B', scanStatus: 'accepted' }),
    ];
    const baseLine = line();
    const { service } = setup({
      tasks: [task({ orderId: 'order-a', rows: persistedRows })],
      lines: persistedRows.map((scanRow, index) =>
        line({
          id: `line-${index + 1}`,
          sequence: index + 1,
          rollDispatchItem: {
            ...baseLine.rollDispatchItem,
            rollCode: scanRow.rollCode,
          },
        }),
      ),
    });

    const projectedTask = (await service.getIntake(ACTOR.role)).tasks[0];
    const projectedTargets = projectedTask.rolls.map((rollView) => ({
      rollCode: rollView.rollCode,
      scanRowId: rollView.scanRowId,
    }));

    expect(projectedTargets).toEqual([
      { rollCode: 'ROLL-A', scanRowId: 'scan-row-a' },
      { rollCode: 'ROLL-B', scanRowId: 'scan-row-b' },
    ]);

    const projectedTargetId = projectedTargets[1]?.scanRowId;
    if (typeof projectedTargetId !== 'string') {
      throw new Error('Projected pallet-selection target is missing');
    }

    const pallet = {
      id: 'pallet-1',
      palletCode: 'PAL-A-1024-01',
      orderId: 'order-a',
      sequenceNo: 1,
    };
    const commandTx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      warehouseAcceptanceTask: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1',
          mode: 'receiving',
          status: 'open',
          orderId: 'order-a',
          updatedAt: new Date('2026-07-13T08:30:00.000Z'),
        }),
      },
      scanRow: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(persistedRows.find((scanRow) => scanRow.id === where.id) ?? null),
          ),
      },
      commercialOrder: {
        findFirst: jest.fn().mockResolvedValue({ id: 'order-a', orderNumber: 'A-1024' }),
      },
      warehousePalletItem: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      warehousePallet: {
        findUnique: jest.fn().mockResolvedValue({
          ...pallet,
          status: 'open',
          openedAt: new Date('2026-07-13T08:31:00.000Z'),
          order: { orderNumber: 'A-1024' },
          items: [
            {
              rollCode: 'ROLL-B',
              position: 1,
              acceptedAt: new Date('2026-07-13T08:30:00.000Z'),
              scanRow: { scannedByName: null },
            },
          ],
          _count: { items: 1 },
        }),
      },
      warehousePalletCommand: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'command-1' }),
      },
    };
    const commandPrisma = {
      warehousePalletCommand: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest
        .fn()
        .mockImplementation((operation: (tx: typeof commandTx) => Promise<unknown>) =>
          operation(commandTx),
        ),
    };
    const commandPallets = {
      prepareOpenPallet: jest.fn().mockResolvedValue(pallet),
      attachAcceptedRoll: jest.fn().mockResolvedValue({ position: 1 }),
    };
    const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
    const selection = new WarehousePalletSelectionService(
      commandPrisma as never,
      audit as never,
      commandPallets as never,
    );

    await selection.setSelection(
      {
        userId: ACTOR.userId,
        role: ACTOR.role,
        capabilities: ['pallet_list:create'],
      },
      't1',
      projectedTargetId,
      {
        operationKey: '123e4567-e89b-42d3-a456-426614174000',
        selected: true,
      },
    );

    expect(commandTx.scanRow.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'scan-row-b' } }),
    );
    expect(commandPallets.attachAcceptedRoll).toHaveBeenCalledWith(
      commandTx,
      expect.objectContaining({
        scanRowId: 'scan-row-b',
        rollCode: 'ROLL-B',
      }),
    );
  });

  it('does not confuse the film form with the PE-LD material mark', async () => {
    const base = line();
    const { service } = setup({
      lines: [
        line({
          rollDispatchItem: {
            ...base.rollDispatchItem,
            filmType: 'Рукав',
            characteristicsSnapshot: { filmType: 'Рукав' },
          },
        }),
      ],
    });

    const intake = await service.getIntake(ACTOR.role);

    expect(intake.tasks[0].rolls[0].characteristics).toEqual(
      expect.objectContaining({ filmType: 'Рукав', materialMark: 'PE-LD' }),
    );
  });

  it('projects safe reserve characteristics from the warehouse snapshot without an operator line', async () => {
    const rawSentinel = 'RAW-RESERVE-POSITION-SENTINEL';
    const { service, prisma } = setup({ lines: [] });
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        rollCode: 'A-1024-roll-1',
        ownerCounterpartyId: null,
        reservedForOrderId: 'order-a',
        warehouseStatus: 'reserved',
        positionSnapshot: {
          filmType: 'Пленка ПВД Полотно',
          materialMark: 'ПВД',
          actualThickness: '80',
          sizeMeters: '1700',
          plannedLengthM: 275,
          spoolType: 'Толстая',
          rawPayload: rawSentinel,
        },
      },
    ]);

    const projected = (await service.getIntake(ACTOR.role)).tasks[0].rolls[0];

    expect(projected).toEqual(
      expect.objectContaining({
        rollCode: 'A-1024-roll-1',
        source: 'warehouse_reserve',
        ownership: 'reserved_for_order',
        characteristics: {
          filmType: 'Пленка ПВД Полотно',
          materialMark: 'ПВД',
          actualThickness: '80',
          sizeMeters: '1700',
          lengthMeters: '275м',
          spoolType: 'Толстая',
          article: null,
          packagingMaterial: null,
          packagingCount: null,
          deliveryDate: null,
        },
      }),
    );
    expect(JSON.stringify(projected)).not.toContain(rawSentinel);
    expect(JSON.stringify(projected)).not.toContain('rawPayload');
    expect(JSON.stringify(projected)).not.toContain('positionSnapshot');
  });

  it('computes counters, closable and the scanning status', async () => {
    const { service } = setup({
      tasks: [
        task({
          rows: [
            row({ scanStatus: 'accepted' }),
            row({ id: 'row-2', rollCode: 'A-1024-roll-2', scanStatus: 'expected' }),
            row({ id: 'row-3', rollCode: 'BAD', scanStatus: 'wrong' }),
          ],
        }),
      ],
      lines: [
        line(),
        line({
          id: 'l2',
          sequence: 2,
          rollDispatchItem: { ...line().rollDispatchItem, rollCode: 'A-1024-roll-2' },
        }),
      ],
    });
    const intake = await service.getIntake(ACTOR.role);
    const view = intake.tasks[0];
    expect(view.expected).toBe(1);
    expect(view.accepted).toBe(1);
    expect(view.errors).toBe(1);
    expect(view.closable).toBe(false);
    expect(view.status).toBe('scanning');
  });

  it('projects three orders and aliases per roll without legal or raw fields', async () => {
    const rows = [
      row({ id: 'row-1', rollCode: 'R-1', fromOrderId: 'order-a' }),
      row({ id: 'row-2', rollCode: 'R-2', fromOrderId: 'order-b' }),
      row({ id: 'row-3', rollCode: 'R-3', fromOrderId: 'order-c' }),
    ];
    const mixedLines = ['A', 'B', 'C'].map((letter, index) => {
      const rollCode = `R-${index + 1}`;
      const orderNumber = `${letter}-${(index + 1) * 100}`;
      const aliases = ['Альфа', 'Бета', 'Гамма'];
      return line({
        id: `line-${index + 1}`,
        sequence: index + 1,
        rollDispatchItem: {
          ...line().rollDispatchItem,
          id: `dispatch-${index + 1}`,
          rollCode,
          assignedOperator: { displayName: `Оператор ${index + 1}` },
          post: { id: `post-${index + 1}`, name: `Станок ${index + 1}`, code: `M-${index + 1}` },
          productionOrder: {
            id: `production-${index + 1}`,
            commercialOrder: {
              id: `order-${letter.toLowerCase()}`,
              orderNumber,
              counterparty: {
                displayName: aliases[index],
                legalName: `ООО «${aliases[index]} Юридическое»`,
              },
            },
          },
        },
      });
    });
    const { service, prisma } = setup({ tasks: [task({ rows })], lines: mixedLines });
    prisma.warehouseRoll.findMany.mockResolvedValue([
      {
        rollCode: 'R-2',
        ownerCounterpartyId: null,
        reservedForOrderId: 'order-b',
        warehouseStatus: 'reserved',
        positionSnapshot: null,
      },
    ]);

    const projected = (await service.getIntake(ACTOR.role)).tasks[0];

    expect(projected.orderNumbers).toEqual(['A-100', 'B-200', 'C-300']);
    expect(projected.customerAliases).toEqual(['Альфа', 'Бета', 'Гамма']);
    expect(projected.orderNumber).toBeNull();
    expect(projected.customerAlias).toBeNull();
    expect(projected.rolls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rollCode: 'R-2',
          orderNumber: 'B-200',
          customerAlias: 'Бета',
          source: 'warehouse_reserve',
          ownership: 'reserved_for_order',
          operatorLabel: 'Оператор 2',
          machineLabel: 'Станок 2',
        }),
      ]),
    );
    expect(JSON.stringify(projected)).not.toContain('Юридическое');
    expect(JSON.stringify(projected)).not.toContain('rawPayload');
  });

  it('maps card statuses by precedence: accepted > defect > reserve > awaiting > pallet_open', async () => {
    const { service } = setup({
      tasks: [
        task({ id: 'closed', status: 'closed', rows: [row({ scanStatus: 'accepted' })] }),
        task({ id: 'defect', rows: [row({ id: 'r2', scanStatus: 'damaged' })] }),
        task({ id: 'reserve', rows: [row({ id: 'r3', scanStatus: 'reserved' })] }),
        task({
          id: 'awaiting',
          rows: [row({ id: 'r4', rollCode: 'A-1024-roll-3', scanStatus: 'expected' })],
        }),
        task({ id: 'pallet', rows: [row({ id: 'r5', scanStatus: 'accepted' })] }),
      ],
      lines: [
        line(),
        line({
          id: 'l3',
          rollDispatchItem: { ...line().rollDispatchItem, rollCode: 'A-1024-roll-3' },
          warehouseState: 'not_ready',
        }),
      ],
    });
    const intake = await service.getIntake(ACTOR.role);
    const byId = new Map(intake.tasks.map((t) => [t.taskId, t.status]));
    expect(byId.get('closed')).toBe('accepted');
    expect(byId.get('defect')).toBe('has_defect');
    expect(byId.get('reserve')).toBe('has_reserve');
    expect(byId.get('awaiting')).toBe('awaiting_rolls');
    expect(byId.get('pallet')).toBe('pallet_open');
  });

  it('projects the newest immutable document and its last submitted/failed state', async () => {
    const { service, pallets } = setup();
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: null,
            history: [palletDocument({ templateVersion: 'pallet-100x150-compact-v2' })],
            hasMore: false,
          },
        ],
      ]),
    );

    const projected = (await service.getIntake(ACTOR.role)).tasks[0];

    expect(projected.palletList).toEqual({
      id: 'pallet-doc-2',
      createdAt: '2026-07-14T12:00:00.000Z',
      templateVersion: 'pallet-100x150-compact-v2',
      printReady: true,
      printStatus: 'failed',
    });
  });

  it('projects an uncertain physical print as needs_admin instead of success or retryable failure', async () => {
    const { service, pallets } = setup();
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: null,
            history: [
              palletDocument({
                id: 'pallet-doc-unknown',
                printStatus: 'needs_admin',
              }),
            ],
            hasMore: false,
          },
        ],
      ]),
    );

    const projected = (await service.getIntake(ACTOR.role)).tasks[0];

    expect(projected.palletList?.printStatus).toBe('needs_admin');
  });

  it('projects the active pallet, bounded history and latest document compatibility', async () => {
    const { service, pallets } = setup();
    const newest = palletDocument({
      id: 'document-01',
      palletId: 'PAL-A-100-01',
      rollCount: 5,
      printStatus: 'submitted',
    });
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: {
              id: 'pallet-2',
              palletCode: 'PAL-A-100-02',
              orderId: 'order-a',
              orderNumber: 'A-100',
              sequenceNo: 2,
              status: 'open',
              rollCount: 2,
              openedAt: '2026-07-14T13:00:00.000Z',
              rows: [
                {
                  rollCode: 'R-6',
                  position: 1,
                  acceptedAt: '2026-07-14T13:00:00.000Z',
                  scannedByName: 'Склад 1',
                },
                {
                  rollCode: 'R-7',
                  position: 2,
                  acceptedAt: '2026-07-14T13:01:00.000Z',
                  scannedByName: 'Склад 1',
                },
              ],
            },
            history: [newest],
            hasMore: false,
          },
        ],
      ]),
    );

    const projected = (await service.getIntake(ACTOR.role)).tasks[0];

    expect(projected).toMatchObject({
      activePallet: { palletCode: 'PAL-A-100-02', rollCount: 2 },
      palletHistory: [
        {
          id: 'document-01',
          palletId: 'PAL-A-100-01',
          rollCount: 5,
          orderId: 'order-a',
        },
      ],
      palletHistoryHasMore: false,
      palletList: { id: 'document-01', printStatus: 'submitted' },
    });
  });

  it('projects server-owned pallet selection for open, sealed, released, and legacy facts', async () => {
    const rows = [
      row({ id: 'unselected', rollCode: 'ROLL-UNSELECTED', scanStatus: 'accepted' }),
      row({ id: 'open', rollCode: 'ROLL-OPEN', scanStatus: 'accepted' }),
      row({ id: 'sealed', rollCode: 'ROLL-SEALED', scanStatus: 'accepted' }),
      row({ id: 'released', rollCode: 'ROLL-RELEASED', scanStatus: 'accepted' }),
    ];
    const { service, pallets } = setup({
      tasks: [task({ rows })],
      lines: rows.map((scanRow, index) =>
        line({
          id: `line-${index + 1}`,
          sequence: index + 1,
          rollDispatchItem: { ...line().rollDispatchItem, rollCode: scanRow.rollCode },
        }),
      ),
    });
    const rawSentinel = 'LEGACY-PAYLOAD-MUST-NOT-LEAK';
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: null,
            selectionsByScanRowId: new Map([
              [
                'open',
                {
                  selected: true,
                  locked: false,
                  palletId: 'pallet-open',
                  palletCode: 'PAL-A-1024-01',
                },
              ],
              [
                'sealed',
                {
                  selected: true,
                  locked: true,
                  palletId: 'pallet-sealed',
                  palletCode: 'PAL-A-1024-00',
                },
              ],
            ]),
            history: [
              palletDocument({
                id: 'legacy-document',
                origin: 'legacy',
                warehousePalletId: null,
                orderId: null,
                rollCodes: ['LEGACY-ROLL'],
                rollCodesHasMore: false,
                payload: { rawPayload: rawSentinel, qrToken: 'secret-token' },
              }),
            ],
            hasMore: false,
          },
        ],
      ]),
    );

    const projected = (await service.getIntake(ACTOR.role)).tasks[0];
    const rollByCode = new Map(projected.rolls.map((roll) => [roll.rollCode, roll]));

    expect(rollByCode.get('ROLL-UNSELECTED')).toMatchObject({
      palletSelection: { selected: false, locked: false, palletId: null, palletCode: null },
    });
    expect(rollByCode.get('ROLL-OPEN')).toMatchObject({
      palletSelection: {
        selected: true,
        locked: false,
        palletId: 'pallet-open',
        palletCode: 'PAL-A-1024-01',
      },
    });
    expect(rollByCode.get('ROLL-SEALED')).toMatchObject({
      palletSelection: {
        selected: true,
        locked: true,
        palletId: 'pallet-sealed',
        palletCode: 'PAL-A-1024-00',
      },
    });
    expect(rollByCode.get('ROLL-RELEASED')).toMatchObject({
      palletSelection: { selected: false, locked: false, palletId: null, palletCode: null },
    });
    expect(projected.palletHistory).toEqual([
      expect.objectContaining({
        id: 'legacy-document',
        origin: 'legacy',
        rollCodes: ['LEGACY-ROLL'],
        rollCodesHasMore: false,
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain(rawSentinel);
    expect(JSON.stringify(projected)).not.toContain('secret-token');
  });
});

describe('WarehouseIntakeService.createPalletList', () => {
  it('persists a new template-v1 snapshot with entity order ids', async () => {
    const { service, prisma, audit, pallets } = setup({
      tasks: [task({ rows: [row({ scanStatus: 'accepted' })] })],
    });
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: {
              id: 'pallet-1',
              palletCode: 'PAL-A-1024-01',
              orderId: 'order-a',
              orderNumber: 'A-1024',
              sequenceNo: 1,
              status: 'open',
              rollCount: 1,
              openedAt: '2026-07-14T12:00:00.000Z',
              rows: [
                {
                  rollCode: 'A-1024-roll-1',
                  position: 1,
                  acceptedAt: '2026-07-14T12:00:00.000Z',
                  scannedByName: 'Кладовщик Пётр',
                },
              ],
            },
            history: [],
            hasMore: false,
          },
        ],
      ]),
    );

    const document = await service.createPalletList(ACTOR, 't1');

    expect(prisma.palletListDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        palletId: 'PAL-A-1024-01',
        orderIds: ['order-a'],
        generatedByRole: 'warehouse',
        format: 'label_100x150',
        fieldSetStatus: 'template_v1',
        payload: expect.objectContaining({
          templateVersion: 'pallet-100x150-v1',
          printReady: true,
        }),
      }),
    });
    expect(document.id).toBe('pallet-doc-1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:pallet_list_created', objectId: 'pallet-doc-1' }),
    );
  });

  it.each([
    'pallet-100x100-square-v4',
    'pallet-100x100-safe-v5',
    'pallet-100x100-extended-v6',
  ] as const)('persists %s with truthful 100x100 immutable metadata', async (profile) => {
    const { service, prisma, audit } = setup();
    const rollCodes = ['A-1024-roll-1'];
    jest.spyOn(service, 'getPalletDraft').mockResolvedValue({
      templateVersion: profile,
      palletId: 'PAL-A-1024-01',
      rows: [{ seq: 1, rollCode: rollCodes[0] }],
      label: {
        templateVersion: profile,
        palletId: 'PAL-A-1024-01',
        materialMark: 'PE-LD',
        productNames: ['Пленка полиэтиленовая рукав 29мкм'],
        article: null,
        rollCount: 1,
        rollCodes,
        packagingMaterial: null,
        packagingCount: null,
        netKg: 7.95,
        grossKg: 8.6,
        productionDate: '08.2026',
        shelfLifeMonths: 12,
        deliveryDate: null,
        storageConditions: 'Хранение в закрытом сухом помещении при температуре 5–35 °C.',
        orderNumbers: ['A-1024'],
        customerAliases: ['УралПак'],
        createdAt: '2026-08-08T15:03:33.642Z',
      },
    } as never);

    await service.createPalletList(ACTOR, 't1');

    expect(prisma.palletListDocument.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        format: 'label_100x100',
        fieldSetStatus: 'template_square_v4',
      }),
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects an unrenderable square-v4 draft with 409 before persistence and audit', async () => {
    const { service, prisma, audit } = setup();
    const rollCodes = ['A'.repeat(80), 'B'.repeat(80)];
    jest.spyOn(service, 'getPalletDraft').mockResolvedValue({
      templateVersion: 'pallet-100x100-square-v4',
      palletId: 'PAL-A-1024-01',
      rows: rollCodes.map((rollCode, index) => ({ seq: index + 1, rollCode })),
      label: {
        templateVersion: 'pallet-100x100-square-v4',
        palletId: 'PAL-A-1024-01',
        materialMark: 'PE-LD',
        productNames: ['Пленка полиэтиленовая рукав 29мкм'],
        article: null,
        rollCount: rollCodes.length,
        rollCodes,
        packagingMaterial: null,
        packagingCount: null,
        netKg: 15.9,
        grossKg: 17.2,
        productionDate: '08.2026',
        shelfLifeMonths: 12,
        deliveryDate: null,
        storageConditions: 'Хранение в закрытом сухом помещении при температуре 5–35 °C.',
        orderNumbers: ['A-1024'],
        customerAliases: ['УралПак'],
        createdAt: '2026-08-08T15:03:33.642Z',
      },
    } as never);

    await expect(service.createPalletList(ACTOR, 't1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PALLET_LABEL_NOT_RENDERABLE' }),
    });
    expect(prisma.palletListDocument.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('WarehouseIntakeService.getPalletDraft', () => {
  it('builds the compatibility preview from only the active physical pallet', async () => {
    const secondLine = line({
      id: 'line-2',
      sequence: 2,
      rollDispatchItem: {
        ...line().rollDispatchItem,
        id: 'dispatch-2',
        rollCode: 'A-1024-roll-2',
      },
    });
    const { service, pallets } = setup({
      tasks: [
        task({
          rows: [
            row({ scanStatus: 'accepted' }),
            row({
              id: 'row-2',
              rollCode: 'A-1024-roll-2',
              scanStatus: 'expected',
            }),
          ],
        }),
      ],
      lines: [line(), secondLine],
    });
    pallets.projectForTasks.mockResolvedValue(
      new Map([
        [
          't1',
          {
            activePallet: {
              id: 'pallet-1',
              palletCode: 'PAL-A-1024-01',
              orderId: 'order-a',
              orderNumber: 'A-1024',
              sequenceNo: 1,
              status: 'open',
              rollCount: 1,
              openedAt: '2026-07-14T12:00:00.000Z',
              rows: [
                {
                  rollCode: 'A-1024-roll-1',
                  position: 1,
                  acceptedAt: '2026-07-14T12:00:00.000Z',
                  scannedByName: 'Кладовщик Пётр',
                },
              ],
            },
            history: [],
            hasMore: false,
          },
        ],
      ]),
    );

    const payload = await service.getPalletDraft(ACTOR, 't1');

    expect(payload.palletId).toBe('PAL-A-1024-01');
    expect(payload.rows.map((item) => item.rollCode)).toEqual(['A-1024-roll-1']);
    expect(payload.printReady).toBe(true);
  });

  it('rejects a preview when the task has no accepted roll on an active pallet', async () => {
    const { service } = setup();

    await expect(service.getPalletDraft(ACTOR, 't1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_OPEN_PALLET_NOT_FOUND' }),
    });
  });
});
