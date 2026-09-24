import { ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ShipmentStatus } from '@plenka/contracts';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  deliveryScopeKey,
  type FulfillmentDeliveryLockProof,
  OrderFulfillmentHandoffService,
  type FulfillmentActor,
} from './order-fulfillment-handoff.service';
import type {
  FulfillmentOrder,
  FulfillmentTask,
  FulfillmentV1Order,
} from './order-fulfillment.types';

const actor: FulfillmentActor = { userId: 'warehouse-user', role: 'warehouse' };

type StoredOrder = FulfillmentOrder & {
  orderNumber: string;
  shipmentStatus: ShipmentStatus;
  readyForShipmentAt: Date | null;
};

type StoredV1Order = FulfillmentV1Order & {
  warehouseCoverageWorkflowVersion: 1;
  shipmentStatus: ShipmentStatus;
  readyForShipmentAt: Date | null;
};

type StoredTask = FulfillmentTask & {
  operationCode: string | null;
  deliveryScopeKey: string | null;
  receivingScopeKey?: string | null;
  createdAt: Date;
};

type StoredWarehouseRoll = {
  id: string;
  rollCode: string;
  reservedForOrderId: string | null;
  reservedForPositionId: string | null;
  reservedByProposalId: string | null;
  reservedByCoverageDecisionId: string | null;
  reservedAt: Date | null;
  producedForOrderId: string | null;
  producedForPositionId: string | null;
  producedByCoverageDecisionId: string | null;
  currentCoverageFactId: string | null;
  warehouseStatus: string;
};

type StoredScanRow = {
  taskId: string;
  rollCode: string;
  fromOrderId: string | null;
  scanStatus: string;
};

type FakeState = {
  orders: StoredOrder[];
  tasks: StoredTask[];
  rolls: StoredWarehouseRoll[];
  scanRows: StoredScanRow[];
  domainEvents: Array<Record<string, unknown>>;
  resolvedCoverScopes: string[];
  lockedDeliveryScopes: string[];
  lockedRollCodes: string[];
  rollRaceOnLock: {
    rollCode: string;
    warehouseStatus?: string;
    currentCoverageFactId?: string | null;
  } | null;
  raceTaskId: string | null;
  raceTaskRollCode: string | null;
};

function readyOrder(id = 'ready-order'): StoredV1Order {
  const positionId = `${id}-position`;
  const proposalId = `${id}-proposal`;
  return {
    warehouseCoverageWorkflowVersion: 1,
    id,
    orderNumber: 'A-1',
    shipmentStatus: 'not_shipped',
    readyForShipmentAt: null,
    positions: [
      {
        id: positionId,
        rollCount: 2,
        warehouseCoverStatus: 'full_confirmed',
        coverProposals: [
          {
            id: proposalId,
            status: 'full_confirmed',
            coverQty: 2,
            reserveQty: 2,
            commercialApprovedAt: new Date('2026-07-15T09:00:00.000Z'),
            technicalApprovedAt: new Date('2026-07-15T09:10:00.000Z'),
            reservedRolls: [
              {
                id: `${id}-roll-1`,
                rollCode: 'R-1',
                reservedForOrderId: id,
                reservedForPositionId: positionId,
                reservedByProposalId: proposalId,
              },
              {
                id: `${id}-roll-2`,
                rollCode: 'R-2',
                reservedForOrderId: id,
                reservedForPositionId: positionId,
                reservedByProposalId: proposalId,
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

function v2ReadyOrder(id = 'v2-ready-order'): StoredOrder {
  const positionId = `${id}-position`;
  const calculationId = `${id}-calculation`;
  const decisionId = '00000000-0000-4000-8000-000000000062';
  const inputFingerprint = 'c'.repeat(64);
  return {
    warehouseCoverageWorkflowVersion: 2,
    id,
    orderNumber: 'A-V2-READY',
    shipmentStatus: 'not_shipped',
    readyForShipmentAt: null,
    positions: [
      {
        id: positionId,
        rollCount: 2,
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
        orderId: id,
        generation: 1,
        inputFingerprint,
        availability: 'verified_full',
        requiredRollCount: 2,
        matchedRollCount: 2,
        matches: ['R-1', 'R-2'].map((rollCode, index) => {
          const rollId = `${id}-roll-${index + 1}`;
          return {
            orderId: id,
            generation: 1,
            positionId,
            rollId,
            coverageFactId: `${rollId}-fact`,
            slotIndex: index + 1,
            roll: {
              id: rollId,
              rollCode,
              warehouseStatus: 'received',
              currentCoverageFactId: `${rollId}-fact`,
              reservedForOrderId: id,
              reservedForPositionId: positionId,
              reservedByProposalId: null,
              reservedByCoverageDecisionId: decisionId,
              reservedAt: new Date('2026-07-24T08:00:00.000Z'),
            },
          };
        }),
      },
      currentDecision: {
        id: decisionId,
        orderId: id,
        calculationId,
        generation: 1,
        kind: 'use_warehouse',
        inputFingerprint,
        expectedRollCount: 2,
      },
    },
    productionOrder: null,
  } as unknown as StoredOrder;
}

function v2ProductionReadyOrder(id = 'v2-production-ready-order'): StoredOrder {
  const order = v2ReadyOrder(id) as unknown as {
    id: string;
    coverageState: {
      state: string;
      currentDecision: {
        id: string;
        kind: string;
        expectedRollCount: number;
      };
      currentCalculation: {
        id: string;
        inputFingerprint: string;
        generation: number;
        matches: Array<{
          roll: {
            reservedForOrderId: string | null;
            reservedForPositionId: string | null;
            reservedByCoverageDecisionId: string | null;
            reservedAt: Date | null;
          };
        }>;
      };
    };
    productionOrder: unknown;
    positions: Array<{ id: string }>;
  };
  order.coverageState.state = 'production_required';
  order.coverageState.currentDecision.kind = 'produce_all';
  order.coverageState.currentDecision.expectedRollCount = 0;
  order.coverageState.currentCalculation.matches.forEach((match) => {
    match.roll.reservedForOrderId = null;
    match.roll.reservedForPositionId = null;
    match.roll.reservedByCoverageDecisionId = null;
    match.roll.reservedAt = null;
  });
  order.productionOrder = {
    commercialOrderId: order.id,
    sourceCoverageCalculationId: order.coverageState.currentCalculation.id,
    sourceCoverageDecisionId: order.coverageState.currentDecision.id,
    sourceCoverageInputFingerprint: order.coverageState.currentCalculation.inputFingerprint,
    sourceCoverageGeneration: order.coverageState.currentCalculation.generation,
    dispatchItems: [
      {
        rollCode: 'R-1',
        orderLineId: order.positions[0]!.id,
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
      {
        rollCode: 'R-2',
        orderLineId: order.positions[0]!.id,
        status: 'done',
        operatorLine: { warehouseState: 'received' },
      },
    ],
  };
  return order as unknown as StoredOrder;
}

function reserveTask(order: StoredV1Order, status = 'closed'): StoredTask {
  const position = order.positions[0]!;
  return {
    id: `${order.id}-reserve-task`,
    orderId: order.id,
    positionId: position.id,
    proposalId: position.coverProposals[0]!.id,
    mode: 'reserve',
    status,
    rows: [
      { rollCode: 'R-1', scanStatus: 'accepted' },
      { rollCode: 'R-2', scanStatus: 'accepted' },
    ],
    operationCode: null,
    deliveryScopeKey: null,
    createdAt: new Date('2026-07-15T10:00:00.000Z'),
  };
}

function v2ReserveTask(order: StoredOrder): StoredTask {
  const coverageState = (order as unknown as { coverageState?: V2CoverageState }).coverageState;
  const decisionId = coverageState?.currentDecision?.id;
  if (!decisionId) throw new Error('V2 decision fixture is required');
  return {
    id: `${order.id}-reserve-task`,
    orderId: order.id,
    positionId: null,
    proposalId: null,
    coverageDecisionId: decisionId,
    mode: 'reserve',
    status: 'closed',
    rows: [
      { rollCode: 'R-1', fromOrderId: order.id, scanStatus: 'accepted' },
      { rollCode: 'R-2', fromOrderId: order.id, scanStatus: 'accepted' },
    ],
    operationCode: null,
    deliveryScopeKey: null,
    createdAt: new Date('2026-07-24T08:10:00.000Z'),
  } as unknown as StoredTask;
}

function v2ReceivingTask(order: StoredOrder): StoredTask {
  return {
    id: `${order.id}-receiving-task`,
    orderId: order.id,
    positionId: order.positions[0]!.id,
    proposalId: null,
    coverageDecisionId: null,
    mode: 'receiving',
    status: 'closed',
    rows: [
      { rollCode: 'R-1', fromOrderId: order.id, scanStatus: 'accepted' },
      { rollCode: 'R-2', fromOrderId: order.id, scanStatus: 'accepted' },
    ],
    operationCode: null,
    deliveryScopeKey: null,
    createdAt: new Date('2026-07-24T08:10:00.000Z'),
  };
}

type V2CoverageState = {
  currentDecision: { id: string } | null;
};

function receivedRolls(orderId: string): StoredWarehouseRoll[] {
  return [
    {
      id: 'legacy-roll-1',
      rollCode: 'R-1',
      reservedForOrderId: orderId,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      reservedAt: null,
      producedForOrderId: null,
      producedForPositionId: null,
      producedByCoverageDecisionId: null,
      currentCoverageFactId: null,
      warehouseStatus: 'received',
    },
    {
      id: 'legacy-roll-2',
      rollCode: 'R-2',
      reservedForOrderId: orderId,
      reservedForPositionId: null,
      reservedByProposalId: null,
      reservedByCoverageDecisionId: null,
      reservedAt: null,
      producedForOrderId: null,
      producedForPositionId: null,
      producedByCoverageDecisionId: null,
      currentCoverageFactId: null,
      warehouseStatus: 'received',
    },
  ];
}

function v2ReceivedRolls(order: StoredOrder): StoredWarehouseRoll[] {
  const coverageState = (
    order as unknown as {
      coverageState: {
        currentCalculation: {
          matches: Array<{
            positionId: string;
            rollId: string;
            coverageFactId: string;
            roll: {
              rollCode: string;
              reservedByCoverageDecisionId: string;
              reservedAt: Date;
            };
          }>;
        };
      };
    }
  ).coverageState;
  return coverageState.currentCalculation.matches.map((match) => ({
    id: match.rollId,
    rollCode: match.roll.rollCode,
    reservedForOrderId: order.id,
    reservedForPositionId: match.positionId,
    reservedByProposalId: null,
    reservedByCoverageDecisionId: match.roll.reservedByCoverageDecisionId,
    reservedAt: match.roll.reservedAt,
    producedForOrderId: null,
    producedForPositionId: null,
    producedByCoverageDecisionId: null,
    currentCoverageFactId: match.coverageFactId,
    warehouseStatus: 'received',
  }));
}

function v2ProductionReceivedRolls(order: StoredOrder): StoredWarehouseRoll[] {
  const coverageState = (
    order as unknown as {
      coverageState: { currentDecision: { id: string } };
    }
  ).coverageState;
  const positionId = order.positions[0]!.id;
  return receivedRolls(order.id).map((roll) => ({
    ...roll,
    reservedForOrderId: null,
    producedForOrderId: order.id,
    producedForPositionId: positionId,
    producedByCoverageDecisionId: coverageState.currentDecision.id,
    currentCoverageFactId: `${roll.id}-production-fact`,
  }));
}

function deliveryTask(order: StoredOrder, id: string, scope: string | null): StoredTask {
  return {
    id,
    orderId: order.id,
    positionId: null,
    proposalId: null,
    mode: 'delivery',
    status: 'open',
    rows: [
      { rollCode: 'R-1', fromOrderId: order.orderNumber, scanStatus: 'expected' },
      { rollCode: 'R-2', fromOrderId: order.orderNumber, scanStatus: 'expected' },
    ],
    operationCode: `ВЫ-${order.orderNumber}`,
    deliveryScopeKey: scope,
    createdAt: new Date('2026-07-15T11:00:00.000Z'),
  };
}

function normalizeCreateManyData<T>(data: T | T[]): T[] {
  return Array.isArray(data) ? data : [data];
}

function uniqueScopeViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['deliveryScopeKey'] },
  });
}

function restoreEntities<T extends { id: string }>(current: T[], snapshot: T[]): void {
  const currentById = new Map(current.map((entity) => [entity.id, entity]));
  current.splice(
    0,
    current.length,
    ...snapshot.map((saved) => {
      const existing = currentById.get(saved.id);
      if (!existing) return saved;
      Object.assign(existing, saved);
      return existing;
    }),
  );
}

function restoreFakeState(state: FakeState, snapshot: FakeState): void {
  restoreEntities(state.orders, snapshot.orders);
  restoreEntities(state.tasks, snapshot.tasks);
  state.rolls.splice(0, state.rolls.length, ...snapshot.rolls);
  state.scanRows.splice(0, state.scanRows.length, ...snapshot.scanRows);
  state.domainEvents.splice(0, state.domainEvents.length, ...snapshot.domainEvents);
  state.resolvedCoverScopes.splice(
    0,
    state.resolvedCoverScopes.length,
    ...snapshot.resolvedCoverScopes,
  );
  state.lockedDeliveryScopes.splice(
    0,
    state.lockedDeliveryScopes.length,
    ...snapshot.lockedDeliveryScopes,
  );
  state.lockedRollCodes.splice(0, state.lockedRollCodes.length, ...snapshot.lockedRollCodes);
  state.rollRaceOnLock = snapshot.rollRaceOnLock;
  state.raceTaskId = snapshot.raceTaskId;
  state.raceTaskRollCode = snapshot.raceTaskRollCode;
}

function createFakePrisma(state: FakeState) {
  let transactionSequence = 0;
  let activeTransactionId: string | null = null;
  const currentTransactionId = () => activeTransactionId ?? `autocommit-${++transactionSequence}`;
  const prisma = {
    commercialOrder: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const order = state.orders.find((candidate) => candidate.id === where.id);
        if (!order) throw new Error(`Order ${where.id} not found`);
        return order;
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { readyForShipmentAt: Date } }) => {
          const order = state.orders.find((candidate) => candidate.id === where.id);
          if (!order || order.readyForShipmentAt || order.shipmentStatus === 'shipped') {
            return { count: 0 };
          }
          order.readyForShipmentAt = data.readyForShipmentAt;
          return { count: 1 };
        },
      ),
    },
    warehouseAcceptanceTask: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            mode: { in: string[] };
            OR: Array<{ orderId?: string | null; rows?: unknown }>;
          };
        }) => {
          const orderId = where.OR[0]?.orderId as string;
          const order = state.orders.find((candidate) => candidate.id === orderId);
          return state.tasks.filter(
            (task) =>
              where.mode.in.includes(task.mode) &&
              (task.orderId === orderId ||
                (task.orderId === null &&
                  task.rows.some((row) => row.fromOrderId === order?.orderNumber))),
          );
        },
      ),
      findFirst: jest.fn(
        async ({ where }: { where: { mode: string; orderId: string } }) =>
          state.tasks
            .filter((task) => task.mode === where.mode && task.orderId === where.orderId)
            .sort(
              (left, right) =>
                left.createdAt.getTime() - right.createdAt.getTime() ||
                left.id.localeCompare(right.id),
            )[0] ?? null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; deliveryScopeKey?: null; status?: { in: string[] } };
          data: { deliveryScopeKey?: string; status?: string };
        }) => {
          const task = state.tasks.find((candidate) => candidate.id === where.id);
          if (typeof data.status === 'string') {
            if (!task || !where.status?.in?.includes(task.status)) return { count: 0 };
            task.status = data.status;
            return { count: 1 };
          }
          const scopeOccupied = state.tasks.some(
            (candidate) =>
              candidate.id !== task?.id && candidate.deliveryScopeKey === data.deliveryScopeKey,
          );
          if (
            !task ||
            task.deliveryScopeKey !== null ||
            typeof data.deliveryScopeKey !== 'string'
          ) {
            return { count: 0 };
          }
          if (scopeOccupied) throw uniqueScopeViolation();
          task.deliveryScopeKey = data.deliveryScopeKey;
          return { count: 1 };
        },
      ),
      createMany: jest.fn(
        async ({
          data,
          skipDuplicates,
        }: {
          data: Array<{
            id: string;
            mode: string;
            status: string;
            operationCode: string;
            orderId: string;
            deliveryScopeKey: string;
          }>;
          skipDuplicates: boolean;
        }) => {
          const rows = normalizeCreateManyData(data);
          if (state.raceTaskId) {
            const [candidate] = rows;
            if (candidate) {
              const order = state.orders.find((item) => item.id === candidate.orderId)!;
              const raced = deliveryTask(order, state.raceTaskId, candidate.deliveryScopeKey);
              if (state.raceTaskRollCode) raced.rows[0]!.rollCode = state.raceTaskRollCode;
              state.tasks.push(raced);
            }
            state.raceTaskId = null;
            state.raceTaskRollCode = null;
          }
          let count = 0;
          for (const row of rows) {
            const duplicate = state.tasks.some(
              (task) =>
                task.id === row.id ||
                task.operationCode === row.operationCode ||
                task.deliveryScopeKey === row.deliveryScopeKey,
            );
            if (duplicate && skipDuplicates) continue;
            if (duplicate) throw new Error('Unique constraint failed');
            state.tasks.push({
              ...row,
              positionId: null,
              proposalId: null,
              rows: [],
              createdAt: new Date('2026-07-15T12:00:00.000Z'),
            });
            count += 1;
          }
          return { count };
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { deliveryScopeKey?: string; id?: string } }) => {
          const task = state.tasks.find(
            (task) =>
              (where.deliveryScopeKey !== undefined &&
                task.deliveryScopeKey === where.deliveryScopeKey) ||
              (where.id !== undefined && task.id === where.id),
          );
          return task
            ? {
                ...task,
                coverageDecisionId: task.coverageDecisionId ?? null,
                receivingScopeKey: task.receivingScopeKey ?? null,
              }
            : null;
        },
      ),
    },
    scanRow: {
      createMany: jest.fn(async ({ data }: { data: StoredScanRow[] }) => {
        const rows = normalizeCreateManyData(data);
        state.scanRows.push(...rows);
        for (const row of rows) {
          const task = state.tasks.find((candidate) => candidate.id === row.taskId);
          if (task) {
            task.rows.push({
              rollCode: row.rollCode,
              fromOrderId: row.fromOrderId,
              scanStatus: row.scanStatus,
            });
          }
        }
        return { count: rows.length };
      }),
    },
    warehouseRoll: {
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: {
            rollCode: { in: string[] };
            reservedForOrderId?: string;
            producedForOrderId?: string;
            producedByCoverageDecisionId?: string;
            warehouseStatus?: string;
          };
        }) =>
          state.rolls
            .filter(
              (roll) =>
                where.rollCode.in.includes(roll.rollCode) &&
                (where.reservedForOrderId === undefined ||
                  roll.reservedForOrderId === where.reservedForOrderId) &&
                (where.producedForOrderId === undefined ||
                  roll.producedForOrderId === where.producedForOrderId) &&
                (where.producedByCoverageDecisionId === undefined ||
                  roll.producedByCoverageDecisionId === where.producedByCoverageDecisionId) &&
                (where.warehouseStatus === undefined ||
                  roll.warehouseStatus === where.warehouseStatus),
            )
            .map((roll) => ({ ...roll }))
            .sort((left, right) => left.rollCode.localeCompare(right.rollCode)),
      ),
    },
    orderResolutionCase: {
      updateMany: jest.fn(async ({ where }: { where: { openScopeKey: string } }) => {
        state.resolvedCoverScopes.push(where.openScopeKey);
        return { count: 0 };
      }),
    },
    domainEvent: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const event = { id: `event-${state.domainEvents.length + 1}`, ...data };
        state.domainEvents.push(event);
        return event;
      }),
    },
    $queryRaw: jest.fn(async (query: TemplateStringsArray, value?: string | string[]) => {
      const sql = query.join(' ');
      if (sql.includes('pg_advisory_xact_lock')) {
        if (typeof value !== 'string') throw new Error('Delivery scope key is required');
        state.lockedDeliveryScopes.push(value);
        return [{ locked: 1, transactionId: currentTransactionId() }];
      }
      if (sql.includes('FROM "warehouse_rolls"') && sql.includes('FOR UPDATE')) {
        if (!Array.isArray(value)) throw new Error('Fulfillment roll codes are required');
        const rollCodes = [...new Set(value)].sort((left, right) => left.localeCompare(right));
        state.lockedRollCodes.push(...rollCodes);
        if (state.rollRaceOnLock) {
          const raced = state.rolls.find(
            (candidate) => candidate.rollCode === state.rollRaceOnLock?.rollCode,
          );
          if (raced) {
            if (state.rollRaceOnLock.warehouseStatus !== undefined) {
              raced.warehouseStatus = state.rollRaceOnLock.warehouseStatus;
            }
            if (state.rollRaceOnLock.currentCoverageFactId !== undefined) {
              raced.currentCoverageFactId = state.rollRaceOnLock.currentCoverageFactId;
            }
          }
          state.rollRaceOnLock = null;
        }
        return state.rolls
          .filter((roll) => rollCodes.includes(roll.rollCode))
          .map((roll) => ({ rollCode: roll.rollCode }))
          .sort((left, right) => left.rollCode.localeCompare(right.rollCode));
      }
      if (sql.includes('txid_current')) {
        return [{ transactionId: currentTransactionId() }];
      }
      throw new Error(`Unexpected raw query: ${sql}`);
    }),
  };
  const transaction = jest.fn(
    async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(state);
      const previousTransactionId = activeTransactionId;
      activeTransactionId = `transaction-${++transactionSequence}`;
      try {
        return await work(prisma as unknown as Prisma.TransactionClient);
      } catch (error) {
        restoreFakeState(state, snapshot);
        throw error;
      } finally {
        activeTransactionId = previousTransactionId;
      }
    },
  );
  return Object.assign(prisma, { $transaction: transaction });
}

function setup({
  order = readyOrder(),
  taskStatus = 'closed',
  fulfillmentTasks,
  rolls = receivedRolls(order.id),
  deliveryTasks = [],
  rollRaceOnLock = null,
  raceTaskId = null,
  raceTaskRollCode = null,
}: {
  order?: StoredOrder;
  taskStatus?: string;
  fulfillmentTasks?: StoredTask[];
  rolls?: StoredWarehouseRoll[];
  deliveryTasks?: StoredTask[];
  rollRaceOnLock?: FakeState['rollRaceOnLock'];
  raceTaskId?: string | null;
  raceTaskRollCode?: string | null;
} = {}) {
  const state: FakeState = {
    orders: [order],
    tasks: [
      ...(fulfillmentTasks ?? [reserveTask(order as StoredV1Order, taskStatus)]),
      ...deliveryTasks,
    ],
    rolls,
    scanRows: [],
    domainEvents: [],
    resolvedCoverScopes: [],
    lockedDeliveryScopes: [],
    lockedRollCodes: [],
    rollRaceOnLock,
    raceTaskId,
    raceTaskRollCode,
  };
  const prisma = createFakePrisma(state);
  const audit = new AuditService(prisma as unknown as PrismaService);
  const auditRecord = jest.spyOn(audit, 'record');
  const service = new OrderFulfillmentHandoffService(prisma as unknown as PrismaService, audit);
  return { auditRecord, prisma, service, state };
}

function eventTypes(state: FakeState): string[] {
  return state.domainEvents.map((event) => String(event.type));
}

describe('OrderFulfillmentHandoffService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads and reconciles exact V2 decision, match, reservation, and task provenance', async () => {
    const order = v2ReadyOrder();
    const { auditRecord, prisma, service } = setup({
      order,
      fulfillmentTasks: [v2ReserveTask(order)],
      rolls: v2ReceivedRolls(order),
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual(
      expect.objectContaining({
        state: 'ready_for_shipment',
        deliveryTaskId: expect.any(String),
        created: true,
        reason: null,
      }),
    );
    expect(prisma.commercialOrder.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: order.id },
      select: expect.objectContaining({
        warehouseCoverageWorkflowVersion: true,
        coverageState: expect.objectContaining({
          select: expect.objectContaining({
            state: true,
            stateVersion: true,
            generation: true,
            currentCalculationId: true,
            currentDecisionId: true,
            currentCalculation: expect.any(Object),
            currentDecision: expect.any(Object),
          }),
        }),
        productionOrder: expect.objectContaining({
          select: expect.objectContaining({
            commercialOrderId: true,
            sourceCoverageCalculationId: true,
            sourceCoverageDecisionId: true,
            sourceCoverageInputFingerprint: true,
            sourceCoverageGeneration: true,
          }),
        }),
      }),
    });
    expect(prisma.warehouseAcceptanceTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ coverageDecisionId: true }),
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_delivery_task_created',
        detail: expect.objectContaining({
          workflowVersion: 2,
          generation: 1,
          rollCodes: ['R-1', 'R-2'],
          rollCount: 2,
        }),
      }),
      prisma,
    );
  });

  it('fails V2 delivery handoff closed when the final warehouse roll reread diverges', async () => {
    const order = v2ReadyOrder('v2-raced-order');
    const rolls = v2ReceivedRolls(order);
    rolls[0]!.currentCoverageFactId = 'raced-current-fact';
    const { auditRecord, prisma, service, state } = setup({
      order,
      fulfillmentTasks: [v2ReserveTask(order)],
      rolls,
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it('locks fulfilled rolls before the final reread and rejects a concurrent fact change', async () => {
    const order = v2ReadyOrder('v2-lock-raced-order');
    const { auditRecord, prisma, service, state } = setup({
      order,
      fulfillmentTasks: [v2ReserveTask(order)],
      rolls: v2ReceivedRolls(order),
      rollRaceOnLock: {
        rollCode: 'R-1',
        currentCoverageFactId: 'concurrent-fact',
      },
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(state.lockedRollCodes).toEqual(['R-1', 'R-2']);
    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('hands off exact V2 production rolls without warehouse reservation when provenance matches', async () => {
    const order = v2ProductionReadyOrder();
    const rolls = v2ProductionReceivedRolls(order);
    const { service } = setup({
      order,
      fulfillmentTasks: [v2ReceivingTask(order)],
      rolls,
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual(
      expect.objectContaining({
        state: 'ready_for_shipment',
        deliveryTaskId: expect.any(String),
        created: true,
        reason: null,
      }),
    );
    expect(rolls.every((roll) => roll.reservedByCoverageDecisionId === null)).toBe(true);
  });

  it('fails V2 production handoff closed when a received roll lacks source provenance', async () => {
    const order = v2ProductionReadyOrder();
    const rolls = v2ProductionReceivedRolls(order);
    rolls[0]!.producedByCoverageDecisionId = null;
    const { service } = setup({
      order,
      fulfillmentTasks: [v2ReceivingTask(order)],
      rolls,
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });
  });

  it('does not mutate handoff state for noncurrent V2 coverage provenance', async () => {
    const order = v2ReadyOrder('v2-noncurrent-order');
    (
      order as unknown as {
        coverageState: { currentDecisionId: string };
      }
    ).coverageState.currentDecisionId = '00000000-0000-4000-8000-000000000099';
    const { auditRecord, prisma, service, state } = setup({
      order,
      fulfillmentTasks: [v2ReserveTask(order)],
      rolls: v2ReceivedRolls(order),
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    });

    expect(prisma.warehouseRoll.findMany).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it('returns an incomplete no-op without mutating ready or audit facts', async () => {
    const order = readyOrder('incomplete-order');
    const { auditRecord, prisma, service, state } = setup({ order, taskStatus: 'open' });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual(
      expect.objectContaining({
        state: 'incomplete',
        deliveryTaskId: null,
        created: false,
        reason: 'incomplete',
      }),
    );

    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it('creates a delivery task for the exact pallet subset before the full order is complete', async () => {
    const order = readyOrder('partial-pallet-order');
    const { prisma, service, state } = setup({ order, taskStatus: 'open' });

    const result = await service.reconcilePalletScan(actor, order.id, ['R-1']);

    expect(result).toEqual({
      state: 'incomplete',
      deliveryTaskId: expect.any(String),
      created: true,
      reason: null,
    });
    expect(order.readyForShipmentAt).toBeNull();
    expect(state.tasks.find((task) => task.id === result.deliveryTaskId)?.rows).toEqual([
      { rollCode: 'R-1', fromOrderId: order.orderNumber, scanStatus: 'expected' },
    ]);
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
  });

  it('extends the same partial delivery when later rolls complete the order', async () => {
    const order = readyOrder('incremental-pallet-order');
    const { service, state } = setup({ order, taskStatus: 'open' });

    const first = await service.reconcilePalletScan(actor, order.id, ['R-1']);
    const delivery = state.tasks.find((task) => task.id === first.deliveryTaskId)!;
    delivery.status = 'partial';
    delivery.rows[0]!.scanStatus = 'accepted';
    state.rolls.find((roll) => roll.rollCode === 'R-1')!.warehouseStatus = 'delivered';
    state.tasks.find((task) => task.mode === 'reserve')!.status = 'closed';

    await expect(service.reconcilePalletScan(actor, order.id, ['R-2'])).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: first.deliveryTaskId,
      created: false,
      reason: null,
    });
    expect(delivery.status).toBe('open');
    expect(delivery.rows).toEqual([
      { rollCode: 'R-1', fromOrderId: order.orderNumber, scanStatus: 'accepted' },
      { rollCode: 'R-2', fromOrderId: order.orderNumber, scanStatus: 'expected' },
    ]);
    expect(order.readyForShipmentAt).toBeInstanceOf(Date);
    expect(eventTypes(state)).toContain('audit:warehouse_delivery_task_extended');
  });

  it('keeps strict reconciliation blocked but allows a pallet scan past its linked problem case', async () => {
    const order = readyOrder('open-production-problem-order') as StoredOrder & {
      problems: Array<{ id: string; positionId: string | null; status: string }>;
      resolutionCases: Array<{ problemId: string | null; status: string }>;
    };
    order.problems = [
      {
        id: 'production-problem-1',
        positionId: order.positions[0]!.id,
        status: 'open',
      },
    ];
    order.resolutionCases = [{ problemId: 'production-problem-1', status: 'open' }];
    const { prisma, service } = setup({ order });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    });
    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual(
      expect.objectContaining({
        state: 'ready_for_shipment',
        deliveryTaskId: expect.any(String),
        created: true,
        reason: null,
      }),
    );
    expect(prisma.commercialOrder.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: order.id },
      select: expect.objectContaining({
        problems: { select: { id: true, positionId: true, status: true } },
        resolutionCases: { select: { problemId: true, status: true } },
      }),
    });
  });

  it('keeps an unrelated open resolution case blocking the pallet-scan policy', async () => {
    const order = readyOrder('unrelated-resolution-order') as StoredOrder & {
      problems: Array<{ id: string; positionId: string | null; status: string }>;
      resolutionCases: Array<{ problemId: string | null; status: string }>;
    };
    order.problems = [
      {
        id: 'production-problem-2',
        positionId: order.positions[0]!.id,
        status: 'open',
      },
    ];
    order.resolutionCases = [
      { problemId: 'production-problem-2', status: 'open' },
      { problemId: null, status: 'open' },
    ];
    const { prisma, service } = setup({ order });

    await expect(service.reconcilePalletScan(actor, order.id, ['R-1'])).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'incomplete',
    });
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
  });

  it('atomically creates one delivery task with expected rows and owned audit facts', async () => {
    const order = readyOrder();
    const { auditRecord, prisma, service, state } = setup({ order });

    const result = await service.reconcile(actor, order.id);

    expect(result).toEqual(
      expect.objectContaining({
        state: 'ready_for_shipment',
        deliveryTaskId: expect.any(String),
        created: true,
        reason: null,
      }),
    );
    if (!result.deliveryTaskId) throw new Error('Delivery task id is required');

    expect(order.readyForShipmentAt).toBeInstanceOf(Date);
    expect(prisma.scanRow.createMany).toHaveBeenCalledWith({
      data: [
        {
          taskId: result.deliveryTaskId,
          rollCode: 'R-1',
          fromOrderId: 'A-1',
          scanStatus: 'expected',
        },
        {
          taskId: result.deliveryTaskId,
          rollCode: 'R-2',
          fromOrderId: 'A-1',
          scanStatus: 'expected',
        },
      ],
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:warehouse_delivery_task_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: result.deliveryTaskId,
        detail: expect.objectContaining({
          orderId: order.id,
          orderNumber: order.orderNumber,
          warehouseTaskId: result.deliveryTaskId,
          rollCodes: ['R-1', 'R-2'],
          rollCount: 2,
        }),
      }),
      prisma,
    );
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:commercial_order_ready_for_shipment',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: order.id,
      }),
      prisma,
    );
    expect(state.resolvedCoverScopes).toEqual([`warehouse_cover:${order.id}`]);
    expect(eventTypes(state)).toEqual([
      'audit:commercial_order_ready_for_shipment',
      'audit:warehouse_delivery_task_created',
    ]);
  });

  it('returns the same task on retry without repeating rows or audit', async () => {
    const { auditRecord, prisma, service, state } = setup();

    const first = await service.reconcile(actor, 'ready-order');
    const scanCalls = prisma.scanRow.createMany.mock.calls.length;
    const auditCalls = auditRecord.mock.calls.length;
    const second = await service.reconcile(actor, 'ready-order');

    expect(first).toEqual(
      expect.objectContaining({ created: true, deliveryTaskId: expect.any(String), reason: null }),
    );
    expect(second).toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: first.deliveryTaskId,
      created: false,
      reason: null,
    });
    expect(prisma.scanRow.createMany).toHaveBeenCalledTimes(scanCalls);
    expect(auditRecord).toHaveBeenCalledTimes(auditCalls);
    expect(eventTypes(state)).toEqual([
      'audit:commercial_order_ready_for_shipment',
      'audit:warehouse_delivery_task_created',
    ]);
  });

  it('fails closed when an existing scoped delivery has a different roll composition', async () => {
    const order = readyOrder('mismatched-existing-delivery-order');
    const existing = deliveryTask(
      order,
      'mismatched-existing-delivery',
      deliveryScopeKey(order.id),
    );
    existing.rows[1]!.rollCode = 'R-OTHER';
    const { auditRecord, prisma, service, state } = setup({
      order,
      deliveryTasks: [existing],
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it.each([
    [
      'a non-delivery mode',
      (task: StoredTask) => {
        task.mode = 'receiving';
      },
    ],
    [
      'a foreign task order',
      (task: StoredTask) => {
        task.orderId = 'foreign-order';
      },
    ],
    [
      'a position-scoped delivery',
      (task: StoredTask) => {
        task.positionId = 'position-scope';
      },
    ],
    [
      'a proposal-scoped delivery',
      (task: StoredTask) => {
        task.proposalId = 'proposal-scope';
      },
    ],
    [
      'a coverage-decision-scoped delivery',
      (task: StoredTask) => {
        task.coverageDecisionId = 'coverage-decision-scope';
      },
    ],
    [
      'a receiving-scoped delivery',
      (task: StoredTask) => {
        task.receivingScopeKey = 'warehouse_receiving:foreign';
      },
    ],
    [
      'a closed task',
      (task: StoredTask) => {
        task.status = 'closed';
      },
    ],
    [
      'a foreign row order number',
      (task: StoredTask) => {
        task.rows[0]!.fromOrderId = 'FOREIGN-ORDER';
      },
    ],
    [
      'an invalid delivery row state',
      (task: StoredTask) => {
        task.rows[0]!.scanStatus = 'damaged';
      },
    ],
  ])('rejects exact-code delivery reuse with %s', async (_label, mutate) => {
    const order = readyOrder(`invalid-existing-${_label.replaceAll(' ', '-')}`);
    const existing = deliveryTask(order, 'invalid-existing-delivery', deliveryScopeKey(order.id));
    mutate(existing);
    const { prisma, service } = setup({ order, deliveryTasks: [existing] });

    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
  });

  it('revalidates exact V2 production provenance before reusing a scoped delivery', async () => {
    const order = v2ProductionReadyOrder();
    const existing = deliveryTask(order, 'v2-existing-delivery', deliveryScopeKey(order.id));
    const rolls = v2ProductionReceivedRolls(order);
    rolls[0]!.producedForPositionId = 'foreign-position';
    const { auditRecord, prisma, service, state } = setup({
      order,
      fulfillmentTasks: [v2ReceivingTask(order)],
      rolls,
      deliveryTasks: [existing],
    });

    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(state.lockedRollCodes).toEqual(['R-1', 'R-2']);
    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('reuses an exact V2 delivery after one of its rolls was legitimately delivered', async () => {
    const order = v2ProductionReadyOrder();
    const existing = deliveryTask(order, 'v2-partial-delivery', deliveryScopeKey(order.id));
    existing.status = 'partial';
    const rolls = v2ProductionReceivedRolls(order);
    rolls[0]!.warehouseStatus = 'delivered';
    existing.rows[0]!.scanStatus = 'accepted';
    const { prisma, service, state } = setup({
      order,
      fulfillmentTasks: [v2ReceivingTask(order)],
      rolls,
      deliveryTasks: [existing],
    });

    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: existing.id,
      created: false,
      reason: null,
    });

    expect(state.lockedRollCodes).toEqual(['R-1', 'R-2']);
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
  });

  it.each([
    ['an expected row against a delivered roll', 'expected', 'delivered'],
    ['an accepted row against a received roll', 'accepted', 'received'],
  ])('rejects %s', async (_label, scanStatus, warehouseStatus) => {
    const order = v2ProductionReadyOrder();
    const existing = deliveryTask(order, 'v2-state-mismatch', deliveryScopeKey(order.id));
    existing.status = 'partial';
    existing.rows[0]!.scanStatus = scanStatus;
    const rolls = v2ProductionReceivedRolls(order);
    rolls[0]!.warehouseStatus = warehouseStatus;
    const { prisma, service } = setup({
      order,
      fulfillmentTasks: [v2ReceivingTask(order)],
      rolls,
      deliveryTasks: [existing],
    });

    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
  });

  it('claims and reuses the oldest legacy delivery task without creating rows or task audit', async () => {
    const order = readyOrder();
    const legacy = deliveryTask(order, 'legacy-delivery-task', null);
    const { auditRecord, prisma, service, state } = setup({ order, deliveryTasks: [legacy] });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: legacy.id,
      created: false,
      reason: null,
    });

    expect(legacy.deliveryScopeKey).toBe(deliveryScopeKey(order.id));
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(eventTypes(state)).toEqual(['audit:commercial_order_ready_for_shipment']);
    expect(auditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_delivery_task_created' }),
      expect.anything(),
    );
  });

  it('claims a partial legacy delivery after some fulfilled rolls were already delivered', async () => {
    const order = readyOrder();
    const legacy = deliveryTask(order, 'partial-legacy-delivery', null);
    legacy.status = 'partial';
    legacy.rows[0]!.scanStatus = 'accepted';
    const rolls = receivedRolls(order.id);
    rolls[0]!.warehouseStatus = 'delivered';
    const { auditRecord, prisma, service, state } = setup({
      order,
      rolls,
      deliveryTasks: [legacy],
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: legacy.id,
      created: false,
      reason: null,
    });

    expect(legacy.deliveryScopeKey).toBe(deliveryScopeKey(order.id));
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(eventTypes(state)).toEqual(['audit:commercial_order_ready_for_shipment']);
    expect(auditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_delivery_task_created' }),
      expect.anything(),
    );
  });

  it('returns the scoped winner without a unique update against an older legacy task', async () => {
    const order = readyOrder();
    const legacy = deliveryTask(order, 'legacy-delivery-task', null);
    legacy.operationCode = 'LEGACY-A-1';
    legacy.createdAt = new Date('2026-07-15T10:30:00.000Z');
    const winner = deliveryTask(order, 'scoped-winner', deliveryScopeKey(order.id));
    const { auditRecord, prisma, service, state } = setup({
      order,
      deliveryTasks: [legacy, winner],
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: winner.id,
      created: false,
      reason: null,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.warehouseAcceptanceTask.updateMany).not.toHaveBeenCalled();
    expect(legacy.deliveryScopeKey).toBeNull();
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(eventTypes(state)).toEqual(['audit:commercial_order_ready_for_shipment']);
    expect(auditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_delivery_task_created' }),
      expect.anything(),
    );
  });

  it('rolls back and rejects a legacy delivery task with a mismatched non-null scope', async () => {
    const order = readyOrder();
    const legacy = deliveryTask(order, 'mismatched-legacy-task', 'warehouse_delivery:other-order');
    legacy.operationCode = 'LEGACY-OTHER';
    const { prisma, service, state } = setup({ order, deliveryTasks: [legacy] });
    let failure: unknown;

    try {
      await service.reconcile(actor, order.id);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ConflictException);
    if (!(failure instanceof ConflictException)) return;
    expect(failure.getResponse()).toEqual({
      code: 'WAREHOUSE_DELIVERY_SCOPE_CONFLICT',
      message: `Delivery task ${legacy.id} has an incompatible delivery scope`,
    });
    expect(order.readyForShipmentAt).toBeNull();
    expect(state.domainEvents).toEqual([]);
    expect(state.resolvedCoverScopes).toEqual([]);
    expect(legacy.deliveryScopeKey).toBe('warehouse_delivery:other-order');
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
  });

  it('returns a diagnostic no-op when warehouse roll facts do not match', async () => {
    const order = readyOrder();
    const { auditRecord, prisma, service, state } = setup({
      order,
      rolls: receivedRolls(order.id).slice(0, 1),
    });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(prisma.warehouseAcceptanceTask.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it('rereads the unique-scope winner without creating loser-owned rows or task audit', async () => {
    const { auditRecord, prisma, service, state } = setup({ raceTaskId: 'concurrent-winner' });

    await expect(service.reconcile(actor, 'ready-order')).resolves.toEqual({
      state: 'ready_for_shipment',
      deliveryTaskId: 'concurrent-winner',
      created: false,
      reason: null,
    });

    expect(prisma.warehouseAcceptanceTask.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(eventTypes(state)).toEqual(['audit:commercial_order_ready_for_shipment']);
    expect(auditRecord).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit:warehouse_delivery_task_created' }),
      expect.anything(),
    );
  });

  it('rejects a raced unique-scope winner with a different roll composition', async () => {
    const order = readyOrder('raced-mismatch-order');
    const { auditRecord, prisma, service, state } = setup({
      order,
      raceTaskId: 'raced-mismatch-winner',
      raceTaskRollCode: 'R-OTHER',
    });

    await expect(service.reconcilePalletScan(actor, order.id)).resolves.toEqual({
      state: 'incomplete',
      deliveryTaskId: null,
      created: false,
      reason: 'roll_facts_mismatch',
    });

    expect(order.readyForShipmentAt).toBeNull();
    expect(prisma.scanRow.createMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
    expect(state.domainEvents).toEqual([]);
  });

  it('does not mutate an independently shipped order', async () => {
    const order = readyOrder('shipped-order');
    order.shipmentStatus = 'shipped';
    const { auditRecord, prisma, service } = setup({ order });

    await expect(service.reconcile(actor, order.id)).resolves.toEqual({
      state: 'shipped',
      deliveryTaskId: null,
      created: false,
      reason: 'already_shipped',
    });

    expect(prisma.warehouseRoll.findMany).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.updateMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('reuses a supplied transaction client without opening a nested transaction', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });

    const result = await service.reconcile(
      actor,
      order.id,
      prisma as unknown as Prisma.TransactionClient,
    );

    expect(result).toMatchObject({ created: true });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('uses a transaction-bound proof issued by the actual delivery advisory lock', async () => {
    const order = readyOrder();
    const { prisma, service, state } = setup({ order });

    const result = await prisma.$transaction(async (tx) => {
      const proof = await service.acquireDeliveryScopeLock(tx, order.id);
      return service.reconcile(actor, order.id, tx, proof);
    });

    expect(result).toMatchObject({ created: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(state.lockedDeliveryScopes).toEqual([deliveryScopeKey(order.id)]);
    expect(state.lockedRollCodes).toEqual(['R-1', 'R-2']);
  });

  it('rejects a forged delivery lock proof without touching order state', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });
    const forged = Object.freeze({}) as FulfillmentDeliveryLockProof;

    await expect(
      service.reconcile(actor, order.id, prisma as unknown as Prisma.TransactionClient, forged),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_DELIVERY_LOCK_PROOF_INVALID',
      }),
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.commercialOrder.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects a delivery lock proof issued by a completed transaction', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });
    let proof!: FulfillmentDeliveryLockProof;
    await prisma.$transaction(async (tx) => {
      proof = await service.acquireDeliveryScopeLock(tx, order.id);
    });

    await expect(
      prisma.$transaction((tx) => service.reconcile(actor, order.id, tx, proof)),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_DELIVERY_LOCK_TRANSACTION_MISMATCH',
      }),
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.commercialOrder.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects a delivery lock proof issued for a different order scope', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });

    await expect(
      prisma.$transaction(async (tx) => {
        const proof = await service.acquireDeliveryScopeLock(tx, 'other-order');
        return service.reconcile(actor, order.id, tx, proof);
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_DELIVERY_LOCK_SCOPE_MISMATCH',
      }),
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrder.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects a proof whose advisory lock was acquired outside an owning transaction', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });
    const client = prisma as unknown as Prisma.TransactionClient;
    const proof = await service.acquireDeliveryScopeLock(client, order.id);

    await expect(service.reconcile(actor, order.id, client, proof)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_DELIVERY_LOCK_TRANSACTION_MISMATCH',
      }),
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.commercialOrder.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects a prelocked scope proof without its owning transaction client', async () => {
    const order = readyOrder();
    const { prisma, service } = setup({ order });
    let proof!: FulfillmentDeliveryLockProof;
    await prisma.$transaction(async (tx) => {
      proof = await service.acquireDeliveryScopeLock(tx, order.id);
    });

    await expect(service.reconcile(actor, order.id, undefined, proof)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAREHOUSE_DELIVERY_PRELOCK_REQUIRES_TRANSACTION',
      }),
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.commercialOrder.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('deliveryScopeKey', () => {
  it('uses the stable warehouse delivery namespace', () => {
    expect(deliveryScopeKey('order-42')).toBe('warehouse_delivery:order-42');
  });
});
