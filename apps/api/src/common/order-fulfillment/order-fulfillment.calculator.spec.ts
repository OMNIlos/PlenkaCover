import { calculateOrderFulfillment } from './order-fulfillment.calculator';
import type {
  FulfillmentOrder,
  FulfillmentTask,
  FulfillmentV1Order,
  FulfillmentV2Order,
} from './order-fulfillment.types';

function fullCoverOrder(): FulfillmentV1Order & { warehouseCoverageWorkflowVersion: 1 } {
  return {
    warehouseCoverageWorkflowVersion: 1,
    id: 'order-cover',
    orderNumber: 'A-COVER',
    positions: [
      {
        id: 'position-cover',
        rollCount: 2,
        warehouseCoverStatus: 'full_confirmed',
        coverProposals: [
          {
            id: 'proposal-cover',
            status: 'full_confirmed',
            coverQty: 2,
            reserveQty: 2,
            commercialApprovedAt: new Date('2026-07-14T09:30:00.000Z'),
            technicalApprovedAt: new Date('2026-07-14T09:40:00.000Z'),
            reservedRolls: [
              {
                id: 'roll-2',
                rollCode: 'STK-2',
                reservedForOrderId: 'order-cover',
                reservedForPositionId: 'position-cover',
                reservedByProposalId: 'proposal-cover',
              },
              {
                id: 'roll-1',
                rollCode: 'STK-1',
                reservedForOrderId: 'order-cover',
                reservedForPositionId: 'position-cover',
                reservedByProposalId: 'proposal-cover',
              },
            ],
          },
        ],
      },
    ],
    problems: [],
    resolutionCases: [],
    productionOrder: null,
  };
}

function closedReserveTask(rows = ['STK-1', 'STK-2']): FulfillmentTask {
  return {
    id: 'task-reserve',
    orderId: 'order-cover',
    positionId: 'position-cover',
    proposalId: 'proposal-cover',
    mode: 'reserve',
    status: 'closed',
    rows: rows.map((rollCode) => ({ rollCode, scanStatus: 'accepted' })),
  };
}

function productionOrder(): FulfillmentV1Order & { warehouseCoverageWorkflowVersion: 1 } {
  return {
    warehouseCoverageWorkflowVersion: 1,
    id: 'order-production',
    orderNumber: 'A-PRODUCTION',
    positions: [
      {
        id: 'position-production',
        rollCount: 2,
        warehouseCoverStatus: 'needs_production',
        coverProposals: [],
      },
    ],
    problems: [],
    resolutionCases: [],
    productionOrder: {
      dispatchItems: [
        {
          rollCode: 'PRD-2',
          orderLineId: 'position-production',
          status: 'done',
          operatorLine: { warehouseState: 'delivered' },
        },
        {
          rollCode: 'PRD-1',
          orderLineId: 'position-production',
          status: 'done',
          operatorLine: { warehouseState: 'received' },
        },
      ],
    },
  };
}

function closedReceivingTask(): FulfillmentTask {
  return {
    id: 'task-receiving',
    orderId: 'order-production',
    positionId: 'position-production',
    proposalId: null,
    mode: 'receiving',
    status: 'closed',
    rows: [
      { rollCode: 'PRD-1', scanStatus: 'accepted' },
      { rollCode: 'PRD-2', scanStatus: 'accepted' },
    ],
  };
}

function openDeliveryTask(): FulfillmentTask {
  return {
    id: 'task-delivery',
    orderId: 'order-production',
    positionId: 'position-production',
    proposalId: null,
    mode: 'delivery',
    status: 'open',
    rows: [],
  };
}

type V2FixtureOrder = Omit<FulfillmentV2Order, 'positions'> & {
  warehouseCoverageWorkflowVersion: 2;
  positions: Array<{
    id: string;
    rollCount: number;
    warehouseCoverStatus: string;
    coverProposals: Array<{
      id: string;
      status: string;
      coverQty: number;
      reserveQty: number;
      commercialApprovedAt: Date | null;
      technicalApprovedAt: Date | null;
      reservedRolls: Array<{
        id: string;
        rollCode: string;
        reservedForOrderId: string | null;
        reservedForPositionId: string | null;
        reservedByProposalId: string | null;
      }>;
    }>;
  }>;
  coverageState: {
    state: string;
    stateVersion: number;
    generation: number;
    currentCalculationId: string | null;
    currentDecisionId: string | null;
    currentCalculation: {
      id: string;
      orderId: string;
      generation: number;
      inputFingerprint: string;
      availability: string;
      requiredRollCount: number;
      matchedRollCount: number;
      matches: Array<{
        orderId: string;
        generation: number;
        positionId: string;
        rollId: string;
        coverageFactId: string;
        slotIndex: number;
        roll: {
          id: string;
          rollCode: string;
          warehouseStatus: string;
          currentCoverageFactId: string | null;
          reservedForOrderId: string | null;
          reservedForPositionId: string | null;
          reservedByProposalId: string | null;
          reservedByCoverageDecisionId: string | null;
          reservedAt: Date | null;
        };
      }>;
    } | null;
    currentDecision: {
      id: string;
      orderId: string;
      calculationId: string;
      generation: number;
      kind: string;
      inputFingerprint: string;
      expectedRollCount: number;
    } | null;
  } | null;
  productionOrder: null | {
    commercialOrderId: string;
    sourceCoverageCalculationId: string | null;
    sourceCoverageDecisionId: string | null;
    sourceCoverageInputFingerprint: string | null;
    sourceCoverageGeneration: number | null;
    dispatchItems: Array<{
      rollCode: string;
      orderLineId: string | null;
      status: string;
      operatorLine: null | { warehouseState: string };
    }>;
  };
};

function v2WarehouseOrder(): V2FixtureOrder {
  const orderId = 'order-v2-warehouse';
  const calculationId = 'calculation-v2-warehouse';
  const decisionId = '00000000-0000-4000-8000-000000000061';
  const inputFingerprint = 'a'.repeat(64);
  const match = (
    positionId: string,
    rollId: string,
    rollCode: string,
    slotIndex: number,
  ) => ({
    orderId,
    generation: 1,
    positionId,
    rollId,
    coverageFactId: `fact-${rollId}`,
    slotIndex,
    roll: {
      id: rollId,
      rollCode,
      warehouseStatus: 'received',
      currentCoverageFactId: `fact-${rollId}`,
      reservedForOrderId: orderId,
      reservedForPositionId: positionId,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: decisionId,
      reservedAt: new Date('2026-07-24T08:00:00.000Z'),
    },
  });

  return {
    warehouseCoverageWorkflowVersion: 2,
    id: orderId,
    orderNumber: 'A-V2-WAREHOUSE',
    positions: [
      {
        id: 'position-v2-a',
        rollCount: 2,
        warehouseCoverStatus: 'not_checked',
        coverProposals: [],
      },
      {
        id: 'position-v2-b',
        rollCount: 1,
        warehouseCoverStatus: 'not_checked',
        coverProposals: [],
      },
    ],
    problems: [],
    resolutionCases: [],
    coverageState: {
      state: 'warehouse_reserved',
      stateVersion: 2,
      generation: 1,
      currentCalculationId: calculationId,
      currentDecisionId: decisionId,
      currentCalculation: {
        id: calculationId,
        orderId,
        generation: 1,
        inputFingerprint,
        availability: 'verified_full',
        requiredRollCount: 3,
        matchedRollCount: 3,
        matches: [
          match('position-v2-a', 'roll-v2-1', 'V2-STK-1', 1),
          match('position-v2-a', 'roll-v2-2', 'V2-STK-2', 2),
          match('position-v2-b', 'roll-v2-3', 'V2-STK-3', 1),
        ],
      },
      currentDecision: {
        id: decisionId,
        orderId,
        calculationId,
        generation: 1,
        kind: 'use_warehouse',
        inputFingerprint,
        expectedRollCount: 3,
      },
    },
    productionOrder: null,
  } as unknown as V2FixtureOrder;
}

function v2ReserveTask(
  order = v2WarehouseOrder(),
  overrides: Partial<FulfillmentTask> & { coverageDecisionId?: string } = {},
): FulfillmentTask {
  const decisionId = order.coverageState?.currentDecision?.id;
  if (!decisionId) throw new Error('V2 warehouse decision fixture is required');
  return {
    id: 'task-v2-reserve',
    orderId: order.id,
    positionId: null,
    proposalId: null,
    coverageDecisionId: decisionId,
    mode: 'reserve',
    status: 'closed',
    rows: ['V2-STK-1', 'V2-STK-2', 'V2-STK-3'].map((rollCode) => ({
      rollCode,
      fromOrderId: order.id,
      scanStatus: 'accepted',
    })),
    ...overrides,
  } as unknown as FulfillmentTask;
}

function v2ProductionOrder(): V2FixtureOrder {
  const order = v2WarehouseOrder();
  const calculation = order.coverageState?.currentCalculation;
  const decision = order.coverageState?.currentDecision;
  if (!order.coverageState || !calculation || !decision) {
    throw new Error('V2 coverage fixture is required');
  }
  order.id = 'order-v2-production';
  order.orderNumber = 'A-V2-PRODUCTION';
  order.positions = [
    {
      id: 'position-v2-production-a',
      rollCount: 2,
      warehouseCoverStatus: 'needs_production',
      coverProposals: [],
    },
    {
      id: 'position-v2-production-b',
      rollCount: 1,
      warehouseCoverStatus: 'needs_production',
      coverProposals: [],
    },
  ];
  order.coverageState.state = 'production_required';
  calculation.orderId = order.id;
  calculation.matches.forEach((match, index) => {
    match.orderId = order.id;
    match.positionId =
      index < 2 ? 'position-v2-production-a' : 'position-v2-production-b';
    match.roll.reservedForOrderId = null;
    match.roll.reservedForPositionId = null;
    match.roll.reservedByCoverageDecisionId = null;
    match.roll.reservedAt = null;
  });
  decision.orderId = order.id;
  decision.kind = 'produce_all';
  decision.expectedRollCount = 0;
  order.productionOrder = {
    commercialOrderId: order.id,
    sourceCoverageCalculationId: calculation.id,
    sourceCoverageDecisionId: decision.id,
    sourceCoverageInputFingerprint: calculation.inputFingerprint,
    sourceCoverageGeneration: calculation.generation,
    dispatchItems: [],
  };
  return order;
}

describe('calculateOrderFulfillment', () => {
  it('keeps the V1 result byte- and structure-stable', () => {
    const result = calculateOrderFulfillment(
      fullCoverOrder(),
      [closedReserveTask()],
      'not_shipped',
    );

    expect(result).toEqual({
      completion: {
        state: 'ready_for_shipment',
        requestedQty: 2,
        fulfilledQty: 2,
        blockingReasons: [],
      },
      positions: [
        {
          positionId: 'position-cover',
          coveredQty: 2,
          productionQty: 0,
          fulfilledQty: 2,
          fulfilledRollCodes: ['STK-1', 'STK-2'],
          blockingReasons: [],
        },
      ],
      fulfilledRollCodes: ['STK-1', 'STK-2'],
      shipment: 'not_shipped',
    });
    expect(JSON.stringify(result)).toBe(
      '{"completion":{"state":"ready_for_shipment","requestedQty":2,"fulfilledQty":2,' +
        '"blockingReasons":[]},"positions":[{"positionId":"position-cover","coveredQty":2,' +
        '"productionQty":0,"fulfilledQty":2,"fulfilledRollCodes":["STK-1","STK-2"],' +
        '"blockingReasons":[]}],"fulfilledRollCodes":["STK-1","STK-2"],' +
        '"shipment":"not_shipped"}',
    );
  });

  it('requires the exact closed decision-linked reserve task for V2 warehouse fulfillment', () => {
    const order = v2WarehouseOrder();
    const open = calculateOrderFulfillment(
      order,
      [v2ReserveTask(order, { status: 'open' })],
      'not_shipped',
    );
    const closed = calculateOrderFulfillment(
      order,
      [v2ReserveTask(order)],
      'not_shipped',
    );

    expect(open.completion).toMatchObject({
      state: 'incomplete',
      blockingReasons: expect.arrayContaining(['warehouse_batch_open']),
    });
    expect(closed.completion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 3,
      fulfilledQty: 3,
      blockingReasons: [],
    });
    expect(closed.positions).toEqual([
      expect.objectContaining({
        positionId: 'position-v2-a',
        coveredQty: 2,
        productionQty: 0,
        fulfilledQty: 2,
        fulfilledRollCodes: ['V2-STK-1', 'V2-STK-2'],
      }),
      expect.objectContaining({
        positionId: 'position-v2-b',
        coveredQty: 1,
        productionQty: 0,
        fulfilledQty: 1,
        fulfilledRollCodes: ['V2-STK-3'],
      }),
    ]);
  });

  it.each([undefined, null, 'A-V2-WAREHOUSE'])(
    'rejects a V2 reserve row set with non-ID %p row provenance',
    (fromOrderId) => {
      const order = v2WarehouseOrder();
      const task = v2ReserveTask(order);
      task.rows = task.rows.map((row) => ({ ...row, fromOrderId }));

      const result = calculateOrderFulfillment(order, [task], 'not_shipped');

      expect(result.completion.state).toBe('incomplete');
      expect(result.completion.blockingReasons).toContain('facts_unavailable');
    },
  );

  it('keeps a completed decision-linked reservation fulfilled after its rolls are delivered', () => {
    const order = v2WarehouseOrder();
    order.coverageState!.currentCalculation!.matches.forEach((match) => {
      match.roll.warehouseStatus = 'delivered';
    });

    const result = calculateOrderFulfillment(
      order,
      [v2ReserveTask(order)],
      'shipped',
    );

    expect(result.completion.state).toBe('shipped');
    expect(result.completion.fulfilledQty).toBe(3);
  });

  it('derives full-order production only from exact V2 decision provenance', () => {
    const order = v2ProductionOrder();
    const result = calculateOrderFulfillment(order, [], 'not_shipped');

    expect(result.positions.map((position) => position.productionQty)).toEqual([2, 1]);
    expect(result.positions.every((position) => position.coveredQty === 0)).toBe(true);
    expect(result.completion).toEqual({
      state: 'incomplete',
      requestedQty: 3,
      fulfilledQty: 0,
      blockingReasons: ['production_incomplete'],
    });
  });

  it('supports unavailable auto production with a nonzero lower bound and no persisted matches', () => {
    const order = v2ProductionOrder();
    const calculation = order.coverageState!.currentCalculation!;
    const decision = order.coverageState!.currentDecision!;
    calculation.availability = 'unavailable';
    calculation.matchedRollCount = 1;
    calculation.matches = [];
    decision.kind = 'auto_produce_all';

    const result = calculateOrderFulfillment(order, [], 'not_shipped');

    expect(result.positions.map((position) => position.productionQty)).toEqual([2, 1]);
    expect(result.completion.blockingReasons).toEqual(['production_incomplete']);
  });

  it('completes V2 production only after exact closed receiving batches', () => {
    const order = v2ProductionOrder();
    order.productionOrder!.dispatchItems = [
      {
        rollCode: 'V2-PRD-1',
        orderLineId: 'position-v2-production-a',
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
      {
        rollCode: 'V2-PRD-2',
        orderLineId: 'position-v2-production-a',
        status: 'done',
        operatorLine: { warehouseState: 'delivered' },
      },
      {
        rollCode: 'V2-PRD-3',
        orderLineId: 'position-v2-production-b',
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
    ];
    const tasks = [
      {
        id: 'v2-receiving-a',
        orderId: order.id,
        positionId: 'position-v2-production-a',
        proposalId: null,
        mode: 'receiving',
        status: 'closed',
        rows: [
          { rollCode: 'V2-PRD-1', scanStatus: 'accepted' },
          { rollCode: 'V2-PRD-2', scanStatus: 'accepted' },
        ],
      },
      {
        id: 'v2-receiving-b',
        orderId: order.id,
        positionId: 'position-v2-production-b',
        proposalId: null,
        mode: 'receiving',
        status: 'closed',
        rows: [{ rollCode: 'V2-PRD-3', scanStatus: 'accepted' }],
      },
    ] as FulfillmentTask[];

    const result = calculateOrderFulfillment(order, tasks, 'not_shipped');

    expect(result.completion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 3,
      fulfilledQty: 3,
      blockingReasons: [],
    });
    expect(result.fulfilledRollCodes).toEqual(['V2-PRD-1', 'V2-PRD-2', 'V2-PRD-3']);

    for (const poisonedTask of [
      { ...tasks[0]!, proposalId: 'legacy-proposal' },
      {
        ...tasks[0]!,
        coverageDecisionId: '00000000-0000-4000-8000-000000000099',
      },
    ]) {
      const poisoned = calculateOrderFulfillment(
        order,
        [poisonedTask, tasks[1]!],
        'not_shipped',
      );
      expect(poisoned.completion.state).toBe('incomplete');
      expect(poisoned.completion.blockingReasons).toContain('facts_unavailable');
    }
  });

  it('never derives a V2 route from an approved-looking legacy proposal', () => {
    const order = v2WarehouseOrder();
    order.coverageState = null;
    const position = order.positions[0]!;
    position.warehouseCoverStatus = 'full_confirmed';
    position.coverProposals = [
      {
        id: 'leaked-v1-proposal',
        status: 'full_confirmed',
        coverQty: 2,
        reserveQty: 2,
        commercialApprovedAt: new Date('2026-07-24T07:00:00.000Z'),
        technicalApprovedAt: new Date('2026-07-24T07:01:00.000Z'),
        reservedRolls: ['LEAK-1', 'LEAK-2'].map((rollCode) => ({
          id: `roll-${rollCode}`,
          rollCode,
          reservedForOrderId: order.id,
          reservedForPositionId: position.id,
          reservedByProposalId: 'leaked-v1-proposal',
        })),
      },
    ];
    const leakedTask = {
      id: 'leaked-v1-task',
      orderId: order.id,
      positionId: position.id,
      proposalId: 'leaked-v1-proposal',
      mode: 'reserve',
      status: 'closed',
      rows: ['LEAK-1', 'LEAK-2'].map((rollCode) => ({
        rollCode,
        scanStatus: 'accepted',
      })),
    } as FulfillmentTask;

    const result = calculateOrderFulfillment(order, [leakedTask], 'not_shipped');

    expect(result.completion.state).toBe('incomplete');
    expect(result.positions[0]).toEqual(
      expect.objectContaining({ coveredQty: 0, productionQty: 0, fulfilledQty: 0 }),
    );
  });

  it.each([
    ['wrong decision', { coverageDecisionId: '00000000-0000-4000-8000-000000000099' }],
    ['wrong order', { orderId: 'another-order' }],
    ['position-scoped task', { positionId: 'position-v2-a' }],
    ['proposal-scoped task', { proposalId: 'legacy-proposal' }],
    ['wrong mode', { mode: 'receiving' }],
    ['open task', { status: 'open' }],
    ['exception task', { status: 'exception' }],
  ])('rejects a V2 reserve task with %s provenance', (_label, override) => {
    const order = v2WarehouseOrder();
    const result = calculateOrderFulfillment(
      order,
      [v2ReserveTask(order, override)],
      'not_shipped',
    );

    expect(result.completion.state).toBe('incomplete');
  });

  it.each([
    [
      'a missing row',
      [
        { rollCode: 'V2-STK-1', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-2', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
      ],
    ],
    [
      'a duplicate row',
      [
        { rollCode: 'V2-STK-1', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-2', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-2', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
      ],
    ],
    [
      'a nonaccepted row',
      [
        { rollCode: 'V2-STK-1', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-2', fromOrderId: 'order-v2-warehouse', scanStatus: 'damaged' },
        { rollCode: 'V2-STK-3', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
      ],
    ],
    [
      'a row linked to another order',
      [
        { rollCode: 'V2-STK-1', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-2', fromOrderId: 'another-order', scanStatus: 'accepted' },
        { rollCode: 'V2-STK-3', fromOrderId: 'order-v2-warehouse', scanStatus: 'accepted' },
      ],
    ],
  ])('rejects a V2 reserve task with %s', (_label, rows) => {
    const order = v2WarehouseOrder();
    const result = calculateOrderFulfillment(
      order,
      [v2ReserveTask(order, { rows })],
      'not_shipped',
    );

    expect(result.completion.state).toBe('incomplete');
  });

  it('rejects duplicate decision-linked reserve tasks', () => {
    const order = v2WarehouseOrder();
    const task = v2ReserveTask(order);
    const result = calculateOrderFulfillment(
      order,
      [task, { ...task, id: 'duplicate-v2-task' }],
      'not_shipped',
    );

    expect(result.completion.state).toBe('incomplete');
  });

  it.each([
    [
      'calculation generation',
      (order: V2FixtureOrder) => (order.coverageState!.currentCalculation!.generation = 2),
    ],
    [
      'calculation fingerprint',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.inputFingerprint = 'd'.repeat(64)),
    ],
    [
      'calculation availability',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.availability = 'unavailable'),
    ],
    [
      'calculation required count',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.requiredRollCount = 2),
    ],
    [
      'calculation matched count',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matchedRollCount = 2),
    ],
    [
      'decision order',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecision!.orderId = 'another-order'),
    ],
    [
      'decision kind',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecision!.kind = 'produce_all'),
    ],
    [
      'decision fingerprint',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecision!.inputFingerprint = 'd'.repeat(64)),
    ],
    [
      'decision expected count',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecision!.expectedRollCount = 2),
    ],
    [
      'duplicate match roll',
      (order: V2FixtureOrder) => {
        const matches = order.coverageState!.currentCalculation!.matches;
        matches[1]!.rollId = matches[0]!.rollId;
        matches[1]!.roll.id = matches[0]!.roll.id;
      },
    ],
    [
      'duplicate match slot',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[1]!.slotIndex = 1),
    ],
    [
      'unknown match position',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.positionId =
          'another-position'),
    ],
    [
      'wrong current fact',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.currentCoverageFactId =
          'another-fact'),
    ],
    [
      'wrong reserved order',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.reservedForOrderId =
          'another-order'),
    ],
    [
      'wrong reserved position',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.reservedForPositionId =
          'another-position'),
    ],
    [
      'legacy proposal provenance',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.reservedByProposalId =
          'legacy-proposal'),
    ],
    [
      'missing reservation timestamp',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.reservedAt = null),
    ],
    [
      'nonmaterial warehouse status',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.warehouseStatus =
          'missing'),
    ],
  ])('fails closed when V2 warehouse provenance corrupts %s', (_label, mutate) => {
    const order = v2WarehouseOrder();
    mutate(order);

    const result = calculateOrderFulfillment(
      order,
      [v2ReserveTask(v2WarehouseOrder())],
      'not_shipped',
    );

    expect(result.positions.map((position) => position.coveredQty)).toEqual([0, 0]);
    expect(result.completion.blockingReasons).toContain('facts_unavailable');
  });

  it.each([
    ['stale state', (order: V2FixtureOrder) => (order.coverageState!.state = 'stale')],
    [
      'noncurrent calculation',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculationId = 'another-calculation'),
    ],
    [
      'noncurrent decision',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecisionId =
          '00000000-0000-4000-8000-000000000099'),
    ],
    [
      'wrong calculation order',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.orderId = 'another-order'),
    ],
    [
      'wrong decision calculation',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentDecision!.calculationId = 'another-calculation'),
    ],
    [
      'wrong decision generation',
      (order: V2FixtureOrder) => (order.coverageState!.currentDecision!.generation = 2),
    ],
    [
      'wrong match generation',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.generation = 2),
    ],
    [
      'wrong match order',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.orderId = 'another-order'),
    ],
    [
      'wrong reserved decision',
      (order: V2FixtureOrder) =>
        (order.coverageState!.currentCalculation!.matches[0]!.roll.reservedByCoverageDecisionId =
          '00000000-0000-4000-8000-000000000099'),
    ],
  ])('fails closed for V2 warehouse fulfillment with %s', (_label, mutate) => {
    const order = v2WarehouseOrder();
    mutate(order);

    const result = calculateOrderFulfillment(
      order,
      [v2ReserveTask(v2WarehouseOrder())],
      'not_shipped',
    );

    expect(result.completion.state).toBe('incomplete');
  });

  it.each([
    [
      'wrong production order',
      (order: V2FixtureOrder) => (order.productionOrder!.commercialOrderId = 'another-order'),
    ],
    [
      'wrong calculation',
      (order: V2FixtureOrder) =>
        (order.productionOrder!.sourceCoverageCalculationId = 'another-calculation'),
    ],
    [
      'wrong decision',
      (order: V2FixtureOrder) =>
        (order.productionOrder!.sourceCoverageDecisionId =
          '00000000-0000-4000-8000-000000000099'),
    ],
    [
      'wrong generation',
      (order: V2FixtureOrder) => (order.productionOrder!.sourceCoverageGeneration = 2),
    ],
    [
      'wrong fingerprint',
      (order: V2FixtureOrder) =>
        (order.productionOrder!.sourceCoverageInputFingerprint = 'b'.repeat(64)),
    ],
    [
      'noncurrent state',
      (order: V2FixtureOrder) => (order.coverageState!.state = 'awaiting_finance'),
    ],
  ])('does not derive V2 production quantities from %s provenance', (_label, mutate) => {
    const order = v2ProductionOrder();
    mutate(order);

    const result = calculateOrderFulfillment(order, [], 'not_shipped');

    expect(result.positions.map((position) => position.productionQty)).toEqual([0, 0]);
    expect(result.completion.state).toBe('incomplete');
  });

  it.each([
    [
      'missing production order',
      (order: V2FixtureOrder) => {
        order.productionOrder = null;
      },
    ],
    [
      'decision kind/availability mismatch',
      (order: V2FixtureOrder) => {
        order.coverageState!.currentDecision!.kind = 'auto_produce_all';
      },
    ],
    [
      'invalid expected roll count',
      (order: V2FixtureOrder) => {
        order.coverageState!.currentDecision!.expectedRollCount = 3;
      },
    ],
  ])('fails closed for V2 production with %s', (_label, mutate) => {
    const order = v2ProductionOrder();
    mutate(order);

    const result = calculateOrderFulfillment(order, [], 'not_shipped');

    expect(result.positions.map((position) => position.productionQty)).toEqual([0, 0]);
    expect(result.completion.blockingReasons).toContain('facts_unavailable');
  });

  it('fails V2 production completion closed for duplicate or unlinked dispatch facts', () => {
    const order = v2ProductionOrder();
    order.productionOrder!.dispatchItems = [
      {
        rollCode: 'V2-DUPLICATE',
        orderLineId: 'position-v2-production-a',
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
      {
        rollCode: 'V2-DUPLICATE',
        orderLineId: null,
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
    ];

    const result = calculateOrderFulfillment(order, [], 'not_shipped');

    expect(result.completion.state).toBe('incomplete');
    expect(result.completion.blockingReasons).toContain('facts_unavailable');
  });

  it('fails an unknown workflow discriminator closed instead of entering V1', () => {
    const order = fullCoverOrder() as FulfillmentV1Order & {
      warehouseCoverageWorkflowVersion: number;
    };
    order.warehouseCoverageWorkflowVersion = 3;

    const result = calculateOrderFulfillment(
      order as unknown as FulfillmentOrder,
      [closedReserveTask()],
      'not_shipped',
    );

    expect(result.positions[0]).toEqual(
      expect.objectContaining({ coveredQty: 0, productionQty: 0, fulfilledQty: 0 }),
    );
    expect(result.completion.blockingReasons).toContain('facts_unavailable');
  });

  it('fails a missing workflow discriminator closed instead of entering V1', () => {
    const order = fullCoverOrder() as FulfillmentV1Order & {
      warehouseCoverageWorkflowVersion?: number;
    };
    delete order.warehouseCoverageWorkflowVersion;

    const result = calculateOrderFulfillment(
      order as unknown as FulfillmentOrder,
      [closedReserveTask()],
      'not_shipped',
    );

    expect(result.positions[0]).toEqual(
      expect.objectContaining({ coveredQty: 0, productionQty: 0, fulfilledQty: 0 }),
    );
    expect(result.completion.blockingReasons).toContain('facts_unavailable');
  });

  it('completes a fully covered order and returns sorted fulfilled roll codes', () => {
    const result = calculateOrderFulfillment(
      fullCoverOrder(),
      [closedReserveTask()],
      'not_shipped',
    );

    expect(result).toEqual(
      expect.objectContaining({
        completion: {
          state: 'ready_for_shipment',
          requestedQty: 2,
          fulfilledQty: 2,
          blockingReasons: [],
        },
        fulfilledRollCodes: ['STK-1', 'STK-2'],
        shipment: 'not_shipped',
      }),
    );
    expect(result.positions).toEqual([
      {
        positionId: 'position-cover',
        coveredQty: 2,
        productionQty: 0,
        fulfilledQty: 2,
        fulfilledRollCodes: ['STK-1', 'STK-2'],
        blockingReasons: [],
      },
    ]);
  });

  it('ignores an open delivery task when production receiving is complete', () => {
    const result = calculateOrderFulfillment(
      productionOrder(),
      [closedReceivingTask(), openDeliveryTask()],
      'not_shipped',
    );

    expect(result.completion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
    expect(result.positions[0]).toEqual(
      expect.objectContaining({
        coveredQty: 0,
        productionQty: 2,
        fulfilledQty: 2,
        fulfilledRollCodes: ['PRD-1', 'PRD-2'],
        blockingReasons: [],
      }),
    );
  });

  it('ignores an open delivery task that references an approved cover proposal', () => {
    const deliveryTask = {
      ...openDeliveryTask(),
      orderId: 'order-cover',
      positionId: 'position-cover',
      proposalId: 'proposal-cover',
    };

    const result = calculateOrderFulfillment(
      fullCoverOrder(),
      [closedReserveTask(), deliveryTask],
      'not_shipped',
    );

    expect(result.completion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
  });

  it('keeps a mixed route incomplete while its receiving batch is open', () => {
    const order = fullCoverOrder();
    order.id = 'order-mixed';
    const position = order.positions[0];
    position.id = 'position-mixed';
    position.warehouseCoverStatus = 'partial_confirmed';
    const proposal = position.coverProposals[0];
    proposal.coverQty = 1;
    proposal.reserveQty = 1;
    proposal.status = 'partial_confirmed';
    proposal.reservedRolls = [
      {
        id: 'roll-mixed-cover',
        rollCode: 'STK-MIXED',
        reservedForOrderId: order.id,
        reservedForPositionId: position.id,
        reservedByProposalId: proposal.id,
      },
    ];
    order.productionOrder = {
      dispatchItems: [
        {
          rollCode: 'PRD-MIXED',
          orderLineId: position.id,
          status: 'done',
          operatorLine: { warehouseState: 'received' },
        },
      ],
    };
    const reserveTask = {
      ...closedReserveTask(['STK-MIXED']),
      orderId: order.id,
      positionId: position.id,
    };
    const receivingTask = {
      ...closedReceivingTask(),
      orderId: order.id,
      positionId: position.id,
      status: 'open',
      rows: [{ rollCode: 'PRD-MIXED', scanStatus: 'accepted' }],
    };

    const result = calculateOrderFulfillment(order, [reserveTask, receivingTask], 'not_shipped');

    expect(result.completion.state).toBe('incomplete');
    expect(result.positions[0].blockingReasons).toEqual(['warehouse_batch_open']);
  });

  it('derives shipped only from the independent shipment status', () => {
    const result = calculateOrderFulfillment(fullCoverOrder(), [closedReserveTask()], 'shipped');

    expect(result.completion.state).toBe('shipped');
    expect(result.shipment).toBe('shipped');
  });

  it('keeps fulfilled quantities blocked by an open problem', () => {
    const order = fullCoverOrder();
    order.problems = [{ positionId: 'position-cover', status: 'open' }];

    const result = calculateOrderFulfillment(order, [closedReserveTask()], 'not_shipped');

    expect(result.completion).toEqual({
      state: 'incomplete',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: ['blocking_problem'],
    });
    expect(result.positions[0].blockingReasons).toEqual(['blocking_problem']);
  });

  it('blocks completion when accepted reserve rows do not match the covered quantity', () => {
    const result = calculateOrderFulfillment(
      fullCoverOrder(),
      [closedReserveTask(['STK-1'])],
      'not_shipped',
    );

    expect(result.completion).toEqual({
      state: 'incomplete',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: ['warehouse_acceptance_incomplete'],
    });
  });

  it('deduplicates fulfilled roll codes across structural facts', () => {
    const order = productionOrder();
    if (!order.productionOrder) throw new Error('Production order fixture is required');
    order.productionOrder.dispatchItems.push({
      rollCode: 'PRD-1',
      orderLineId: 'position-production',
      status: 'done',
      operatorLine: { warehouseState: 'received' },
    });

    const result = calculateOrderFulfillment(order, [closedReceivingTask()], 'not_shipped');

    expect(result.fulfilledRollCodes).toEqual(['PRD-1', 'PRD-2']);
    expect(result.positions[0].fulfilledRollCodes).toEqual(['PRD-1', 'PRD-2']);
  });

  it('projects row-linked mixed tasks onto the matching positions without cross-order rows', () => {
    const order = {
      warehouseCoverageWorkflowVersion: 1,
      id: 'order-multi',
      orderNumber: 'A-MULTI',
      positions: [
        {
          id: 'position-cover',
          rollCount: 1,
          warehouseCoverStatus: 'full_confirmed',
          coverProposals: [
            {
              id: 'proposal-cover',
              status: 'full_confirmed',
              coverQty: 1,
              reserveQty: 1,
              commercialApprovedAt: new Date('2026-07-14T09:30:00.000Z'),
              technicalApprovedAt: new Date('2026-07-14T09:40:00.000Z'),
              reservedRolls: [
                {
                  id: 'warehouse-cover-roll',
                  rollCode: 'STK-MULTI',
                  reservedForOrderId: 'order-multi',
                  reservedForPositionId: 'position-cover',
                  reservedByProposalId: 'proposal-cover',
                },
              ],
            },
          ],
        },
        {
          id: 'position-production',
          rollCount: 1,
          warehouseCoverStatus: 'needs_production',
          coverProposals: [],
        },
      ],
      problems: [],
      resolutionCases: [],
      productionOrder: {
        dispatchItems: [
          {
            rollCode: 'PRD-MULTI',
            orderLineId: 'position-production',
            status: 'done',
            operatorLine: { warehouseState: 'received' },
          },
        ],
      },
    } as FulfillmentOrder;
    const tasks = [
      {
        id: 'mixed-reserve',
        orderId: null,
        positionId: null,
        proposalId: null,
        mode: 'reserve',
        status: 'closed',
        rows: [
          { rollCode: 'STK-MULTI', fromOrderId: 'A-MULTI', scanStatus: 'accepted' },
          { rollCode: 'OTHER-STOCK', fromOrderId: 'A-OTHER', scanStatus: 'accepted' },
        ],
      },
      {
        id: 'mixed-receiving',
        orderId: null,
        positionId: null,
        proposalId: null,
        mode: 'receiving',
        status: 'closed',
        rows: [
          { rollCode: 'PRD-MULTI', fromOrderId: 'A-MULTI', scanStatus: 'accepted' },
          { rollCode: 'OTHER-PRODUCTION', fromOrderId: 'A-OTHER', scanStatus: 'accepted' },
        ],
      },
    ] as unknown as FulfillmentTask[];

    const result = calculateOrderFulfillment(order, tasks, 'not_shipped');

    expect(result.completion).toEqual({
      state: 'ready_for_shipment',
      requestedQty: 2,
      fulfilledQty: 2,
      blockingReasons: [],
    });
    expect(result.positions).toEqual([
      expect.objectContaining({
        positionId: 'position-cover',
        fulfilledRollCodes: ['STK-MULTI'],
        blockingReasons: [],
      }),
      expect.objectContaining({
        positionId: 'position-production',
        fulfilledRollCodes: ['PRD-MULTI'],
        blockingReasons: [],
      }),
    ]);
  });

  it('counts each accepted roll once across duplicate row-linked tasks', () => {
    const order = {
      ...productionOrder(),
      orderNumber: 'A-PRODUCTION',
    } as FulfillmentOrder;
    const duplicate = {
      ...closedReceivingTask(),
      id: 'mixed-duplicate',
      orderId: null,
      positionId: null,
      rows: [
        { rollCode: 'PRD-1', fromOrderId: 'A-PRODUCTION', scanStatus: 'accepted' },
        { rollCode: 'PRD-1', fromOrderId: 'A-PRODUCTION', scanStatus: 'accepted' },
      ],
    } as unknown as FulfillmentTask;

    const result = calculateOrderFulfillment(order, [duplicate], 'not_shipped');

    expect(result.completion.state).toBe('incomplete');
    expect(result.positions[0]?.blockingReasons).toContain('warehouse_acceptance_incomplete');
  });
});
