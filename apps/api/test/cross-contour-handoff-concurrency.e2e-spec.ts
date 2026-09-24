import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/common/audit/audit.service';
import { OrderFulfillmentHandoffService } from '../src/common/order-fulfillment/order-fulfillment-handoff.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { DeferredPaymentService } from '../src/modules/finance/deferred-payment.service';
import { FinanceService } from '../src/modules/finance/finance.service';
import { ProductionService } from '../src/modules/production/production.service';
import { WarehouseService } from '../src/modules/warehouse/warehouse.service';
import { e2eSeedLogin } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { createSealedPhysicalPalletEvidenceFixture } from './warehouse-pallet-e2e-fixture';

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSignal(signal: Promise<void>, label: string, timeoutMs = 10_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForTableLock(
  prisma: PrismaService,
  tableName: string,
  minimumWaiters = 1,
  timeoutMs = 5_000,
) {
  const pattern = `%${tableName}%`;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const waiting = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query ILIKE ${pattern}
    `;
    if ((waiting[0]?.count ?? 0) >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a PostgreSQL lock on ${tableName}`);
}

async function waitForAdvisoryLock(prisma: PrismaService, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const waiting = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND wait_event ILIKE '%advisory%'
    `;
    if ((waiting[0]?.count ?? 0) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for a PostgreSQL advisory lock');
}

describe('Cross-contour handoff concurrency (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let finance: FinanceService;
  let deferredPayments: DeferredPaymentService;
  let fulfillmentHandoff: OrderFulfillmentHandoffService;
  let production: ProductionService;
  let warehouse: WarehouseService;
  let sequence = 0;
  const financeOrderIds = new Set<string>();
  const commercialOrderIds = new Set<string>();
  const commercialPositionIds = new Set<string>();
  const counterpartyIds = new Set<string>();
  const productionOrderIds = new Set<string>();
  const dispatchItemIds = new Set<string>();
  const rollCodes = new Set<string>();
  const assignmentIds = new Set<string>();
  const shiftIds = new Set<string>();
  const postIds = new Set<string>();
  const userIds = new Set<string>();
  const warehouseTaskIds = new Set<string>();
  const warehouseRollCodes = new Set<string>();
  const financeActor = { userId: null, role: 'finance' as const };
  const productionActor = { userId: null, role: 'production_lead' as const };
  const warehouseActor = { userId: null, role: 'warehouse' as const };
  let warehouseEvidenceIdentity:
    | { actorId: string; sessionId: string; postId: string; deviceId: string }
    | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    finance = moduleRef.get(FinanceService);
    deferredPayments = moduleRef.get(DeferredPaymentService);
    fulfillmentHandoff = moduleRef.get(OrderFulfillmentHandoffService);
    production = moduleRef.get(ProductionService);
    warehouse = moduleRef.get(WarehouseService);
    await app.init();
  });

  afterEach(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'cross-contour handoff finance fixtures',
          run: async () => {
            const financeIds = [...financeOrderIds];
            if (financeIds.length > 0) {
              await prisma.paymentOperation.deleteMany({
                where: { financeOrderId: { in: financeIds } },
              });
              await prisma.paymentSchedule.deleteMany({
                where: { financeOrderId: { in: financeIds } },
              });
              await prisma.financeOrder.deleteMany({ where: { id: { in: financeIds } } });
            }
            financeOrderIds.clear();
          },
        },
        {
          label: 'cross-contour handoff warehouse task fixtures',
          run: async () => {
            const orderIds = [...commercialOrderIds];
            if (orderIds.length > 0) {
              const generatedTasks = await prisma.warehouseAcceptanceTask.findMany({
                where: { orderId: { in: orderIds } },
                select: { id: true },
              });
              generatedTasks.forEach((task) => warehouseTaskIds.add(task.id));
            }
            const taskIds = [...warehouseTaskIds];
            if (taskIds.length > 0) {
              await prisma.weightCapture.deleteMany({
                where: { warehouseOperation: { taskId: { in: taskIds } } },
              });
              await prisma.warehouseOperation.deleteMany({ where: { taskId: { in: taskIds } } });
              await prisma.scanRow.deleteMany({ where: { taskId: { in: taskIds } } });
              await prisma.warehouseAcceptanceTask.deleteMany({ where: { id: { in: taskIds } } });
            }
            warehouseTaskIds.clear();
          },
        },
        {
          label: 'cross-contour handoff warehouse roll fixtures',
          run: async () => {
            const warehouseCodes = [...warehouseRollCodes];
            if (warehouseCodes.length > 0) {
              await prisma.warehouseRoll.deleteMany({
                where: { rollCode: { in: warehouseCodes } },
              });
            }
            warehouseRollCodes.clear();
          },
        },
        {
          label: 'cross-contour handoff dispatch fixtures',
          run: async () => {
            const dispatchIds = [...dispatchItemIds];
            if (dispatchIds.length > 0) {
              await prisma.operatorRollLine.deleteMany({
                where: { rollDispatchItemId: { in: dispatchIds } },
              });
              await prisma.rollDispatchItem.deleteMany({ where: { id: { in: dispatchIds } } });
            }
            dispatchItemIds.clear();
            rollCodes.clear();
          },
        },
        {
          label: 'cross-contour handoff production fixtures',
          run: async () => {
            const productionIds = [...productionOrderIds];
            if (productionIds.length > 0) {
              await prisma.productionOrder.deleteMany({ where: { id: { in: productionIds } } });
            }
            productionOrderIds.clear();
          },
        },
        {
          label: 'cross-contour handoff assignment fixtures',
          run: async () => {
            const assignments = [...assignmentIds];
            if (assignments.length > 0) {
              await prisma.operatorShiftMachineAssignment.deleteMany({
                where: { id: { in: assignments } },
              });
            }
            assignmentIds.clear();
          },
        },
        {
          label: 'cross-contour handoff shift fixtures',
          run: async () => {
            const shifts = [...shiftIds];
            if (shifts.length > 0) {
              await prisma.shift.deleteMany({ where: { id: { in: shifts } } });
            }
            shiftIds.clear();
          },
        },
        {
          label: 'cross-contour handoff post fixtures',
          run: async () => {
            const posts = [...postIds];
            if (posts.length > 0) {
              await prisma.post.deleteMany({ where: { id: { in: posts } } });
            }
            postIds.clear();
          },
        },
        {
          label: 'cross-contour handoff commercial fixtures',
          run: async () => {
            const orderIds = [...commercialOrderIds];
            const positionIds = [...commercialPositionIds];
            if (orderIds.length > 0) {
              await prisma.warehouseCoverProposal.deleteMany({
                where: { orderId: { in: orderIds } },
              });
            }
            if (positionIds.length > 0) {
              await prisma.commercialOrderPosition.deleteMany({
                where: { id: { in: positionIds } },
              });
            }
            if (orderIds.length > 0) {
              await prisma.commercialOrder.deleteMany({ where: { id: { in: orderIds } } });
            }
            commercialOrderIds.clear();
            commercialPositionIds.clear();
          },
        },
        {
          label: 'cross-contour handoff counterparty fixtures',
          run: async () => {
            const counterparties = [...counterpartyIds];
            if (counterparties.length > 0) {
              await prisma.counterparty.deleteMany({ where: { id: { in: counterparties } } });
            }
            counterpartyIds.clear();
          },
        },
        {
          // Immutable events and their actor users remain until guarded isolated-schema teardown.
          label: 'cross-contour handoff retained actors',
          run: () => userIds.clear(),
        },
        {
          label: 'cross-contour handoff mocks',
          run: () => {
            jest.restoreAllMocks();
          },
        },
      ],
    );
  });

  afterAll(async () => {
    await app.close();
  });

  async function createFinanceFixture(
    data: {
      invoiceStatus?: string;
      amountValue?: number;
      paymentTermsType?: string;
      invoiceIssuedAt?: Date;
    } = {},
  ) {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Handoff concurrency ${suffix}` },
    });
    counterpartyIds.add(counterparty.id);
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-HANDOFF-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    commercialOrderIds.add(order.id);
    const financeOrder = await prisma.financeOrder.create({
      data: {
        commercialOrderId: order.id,
        ...data,
      },
    });
    financeOrderIds.add(financeOrder.id);
    return { order, financeOrder };
  }

  function pauseFirstAudit() {
    const reached = deferred();
    const release = deferred();
    const originalRecord = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
      reached.resolve();
      await release.promise;
      return originalRecord(input, client);
    });
    return { reached, release };
  }

  function pauseReadyTransitionAudit() {
    const reached = deferred();
    const release = deferred();
    const originalRecord = audit.record.bind(audit);
    let paused = false;
    jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:commercial_order_ready_for_shipment' && !paused) {
        paused = true;
        reached.resolve();
        await release.promise;
      }
      return originalRecord(input, client);
    });
    return { reached, release };
  }

  async function createProductionFixture(rollCount = 1) {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Production concurrency ${suffix}` },
    });
    counterpartyIds.add(counterparty.id);
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-PRODUCTION-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    commercialOrderIds.add(order.id);
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'in_production',
      },
    });
    productionOrderIds.add(productionOrder.id);
    const shift = await prisma.shift.create({
      data: {
        label: `Shift ${suffix}`,
        plannedStartAt: new Date('2026-07-15T06:00:00.000Z'),
        plannedEndAt: new Date('2026-07-15T18:00:00.000Z'),
        status: 'planned',
      },
    });
    shiftIds.add(shift.id);
    const operators = await Promise.all(
      ['A', 'B'].map((label) =>
        prisma.user.create({
          data: {
            login: `handoff-${label.toLowerCase()}-${suffix}`,
            displayName: `Operator ${label} ${suffix}`,
            role: 'operator',
          },
        }),
      ),
    );
    operators.forEach((operator) => userIds.add(operator.id));
    const posts = await Promise.all(
      ['A', 'B'].map((label) =>
        prisma.post.create({
          data: {
            code: `HANDOFF-${label}-${suffix}`,
            name: `Handoff post ${label} ${suffix}`,
            status: 'active',
          },
        }),
      ),
    );
    posts.forEach((post) => postIds.add(post.id));
    const assignments = await Promise.all(
      operators.map((operator, index) =>
        prisma.operatorShiftMachineAssignment.create({
          data: {
            shiftId: shift.id,
            operatorId: operator.id,
            postId: posts[index]!.id,
          },
        }),
      ),
    );
    assignments.forEach((assignment) => assignmentIds.add(assignment.id));
    const rolls = await Promise.all(
      Array.from({ length: rollCount }, (_, index) =>
        prisma.rollDispatchItem.create({
          data: {
            rollCode: `A-PRODUCTION-${suffix}-roll-${index + 1}`,
            productionOrderId: productionOrder.id,
            positionSequence: index + 1,
            status: 'new',
            priority: index,
          },
        }),
      ),
    );
    rolls.forEach((roll) => {
      dispatchItemIds.add(roll.id);
      rollCodes.add(roll.rollCode);
    });
    return { order, productionOrder, shift, operators, posts, rolls };
  }

  async function createApprovalFixture(rollCount = 2) {
    const fixture = await createProductionFixture(rollCount);
    await prisma.productionOrder.update({
      where: { id: fixture.productionOrder.id },
      data: { approvalState: 'pending', indicator: 'needs_production' },
    });
    await Promise.all(
      fixture.rolls.map((roll, index) => {
        const operatorIndex = index % fixture.operators.length;
        return prisma.rollDispatchItem.update({
          where: { id: roll.id },
          data: {
            assignedOperatorId: fixture.operators[operatorIndex]!.id,
            plannedShiftId: fixture.shift.id,
            postId: fixture.posts[operatorIndex]!.id,
            machineId: fixture.posts[operatorIndex]!.code,
            queueRank: index + 1,
            plannedWeightKg: 40 + index,
            status: 'new',
          },
        });
      }),
    );
    return fixture;
  }

  async function createReadyProductionHandoffFixture() {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Fulfillment handoff concurrency ${suffix}` },
    });
    counterpartyIds.add(counterparty.id);
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-FULFILLMENT-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    commercialOrderIds.add(order.id);
    const position = await prisma.commercialOrderPosition.create({
      data: {
        orderId: order.id,
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
      },
    });
    commercialPositionIds.add(position.id);
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'completed',
      },
    });
    productionOrderIds.add(productionOrder.id);
    const roll = await prisma.rollDispatchItem.create({
      data: {
        rollCode: `${order.orderNumber}-roll-1`,
        productionOrderId: productionOrder.id,
        orderLineId: position.id,
        positionSequence: 1,
        status: 'done',
        completedAt: new Date(),
        operatorLine: {
          create: {
            sequence: 1,
            step: 'warehouse',
            warehouseState: 'received',
          },
        },
      },
      include: { operatorLine: true },
    });
    dispatchItemIds.add(roll.id);
    rollCodes.add(roll.rollCode);
    const receivingTask = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'closed',
        orderId: order.id,
        positionId: position.id,
        rows: {
          create: {
            rollCode: roll.rollCode,
            fromOrderId: order.orderNumber,
            scanStatus: 'accepted',
          },
        },
      },
      include: { rows: true },
    });
    warehouseTaskIds.add(receivingTask.id);
    const warehouseRoll = await prisma.warehouseRoll.create({
      data: {
        rollCode: roll.rollCode,
        warehouseStatus: 'received',
        reservedForOrderId: order.id,
        reservedForPositionId: position.id,
        reservedAt: new Date(),
      },
    });
    warehouseRollCodes.add(warehouseRoll.rollCode);
    return { order, position, productionOrder, roll, receivingTask, warehouseRoll };
  }

  async function createMixedCloseHandoffFixture() {
    sequence += 1;
    const suffix = `${Date.now()}-${process.pid}-${sequence}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Mixed fulfillment handoff ${suffix}` },
    });
    counterpartyIds.add(counterparty.id);
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-MIXED-FULFILLMENT-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    commercialOrderIds.add(order.id);
    const position = await prisma.commercialOrderPosition.create({
      data: {
        orderId: order.id,
        rollCount: 2,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
        warehouseCoverStatus: 'partial_confirmed',
      },
    });
    commercialPositionIds.add(position.id);
    const proposal = await prisma.warehouseCoverProposal.create({
      data: {
        orderId: order.id,
        positionId: position.id,
        coverType: 'partial',
        route: 'reserve_plus_production',
        coverQty: 1,
        reserveQty: 1,
        productionQty: 1,
        status: 'partial_confirmed',
        commercialApprovedAt: new Date(),
        technicalApprovedAt: new Date(),
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'in_production',
      },
    });
    productionOrderIds.add(productionOrder.id);
    const productionRoll = await prisma.rollDispatchItem.create({
      data: {
        rollCode: `${order.orderNumber}-production`,
        productionOrderId: productionOrder.id,
        orderLineId: position.id,
        positionSequence: 1,
        status: 'done',
        completedAt: new Date(),
        operatorLine: {
          create: {
            sequence: 1,
            step: 'warehouse',
            warehouseState: 'received',
          },
        },
      },
    });
    dispatchItemIds.add(productionRoll.id);
    rollCodes.add(productionRoll.rollCode);
    const coverRoll = await prisma.warehouseRoll.create({
      data: {
        rollCode: `${order.orderNumber}-reserve`,
        warehouseStatus: 'received',
        reservedForOrderId: order.id,
        reservedForPositionId: position.id,
        reservedByProposalId: proposal.id,
        reservedAt: new Date(),
      },
    });
    await prisma.warehouseRoll.create({
      data: {
        rollCode: productionRoll.rollCode,
        warehouseStatus: 'received',
        reservedForOrderId: order.id,
        reservedForPositionId: position.id,
        reservedAt: new Date(),
      },
    });
    warehouseRollCodes.add(coverRoll.rollCode);
    warehouseRollCodes.add(productionRoll.rollCode);
    const [reserveTask, receivingTask] = await Promise.all([
      prisma.warehouseAcceptanceTask.create({
        data: {
          mode: 'reserve',
          status: 'open',
          orderId: order.id,
          positionId: position.id,
          proposalId: proposal.id,
          rows: {
            create: {
              rollCode: coverRoll.rollCode,
              fromOrderId: order.orderNumber,
              scanStatus: 'accepted',
            },
          },
        },
        include: { rows: true },
      }),
      prisma.warehouseAcceptanceTask.create({
        data: {
          mode: 'receiving',
          status: 'open',
          orderId: order.id,
          positionId: position.id,
          rows: {
            create: {
              rollCode: productionRoll.rollCode,
              fromOrderId: order.orderNumber,
              scanStatus: 'accepted',
            },
          },
        },
        include: { rows: true },
      }),
    ]);
    await recordCompletedScanEvidence(
      reserveTask.id,
      reserveTask.rows[0]!.id,
      reserveTask.rows[0]!.rollCode,
      'reserve_scan',
    );
    await recordCompletedScanEvidence(
      receivingTask.id,
      receivingTask.rows[0]!.id,
      receivingTask.rows[0]!.rollCode,
      'receiving_scan',
    );
    await createSealedPhysicalPalletEvidenceFixture(prisma, {
      id: receivingTask.id,
      orderId: order.id,
      rows: receivingTask.rows,
    });
    // Physical pallet documents and their QR identities are immutable. Retain this complete
    // aggregate until the guarded isolated-schema teardown, just like append-only audit facts.
    counterpartyIds.delete(counterparty.id);
    commercialOrderIds.delete(order.id);
    commercialPositionIds.delete(position.id);
    productionOrderIds.delete(productionOrder.id);
    dispatchItemIds.delete(productionRoll.id);
    rollCodes.delete(productionRoll.rollCode);
    warehouseRollCodes.delete(coverRoll.rollCode);
    warehouseRollCodes.delete(productionRoll.rollCode);
    return { order, reserveTask, receivingTask };
  }

  async function blockDispatchRows(ids: string[]) {
    const reached = deferred();
    const release = deferred();
    const finished = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "roll_dispatch_items"
                   WHERE id IN (${Prisma.join(ids)})
                   ORDER BY id
                   FOR UPDATE`,
      );
      reached.resolve();
      await release.promise;
    });
    await reached.promise;
    return { release, finished };
  }

  async function createDeliveryTask(orderId: string, orderNumber: string, rollCode: string) {
    await prisma.warehouseRoll.create({
      data: { rollCode, warehouseStatus: 'delivered', reservedForOrderId: orderId },
    });
    const task = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'delivery',
        status: 'open',
        orderId,
        rows: {
          create: {
            rollCode,
            fromOrderId: orderNumber,
            scanStatus: 'accepted',
            lastScanAt: new Date(),
          },
        },
      },
      include: { rows: true },
    });
    warehouseTaskIds.add(task.id);
    warehouseRollCodes.add(rollCode);
    await recordCompletedScanEvidence(task.id, task.rows[0]!.id, rollCode, 'delivery_scan');
    return task;
  }

  async function evidenceIdentity() {
    if (warehouseEvidenceIdentity) return warehouseEvidenceIdentity;
    const [actor, post] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { login: e2eSeedLogin('warehouse') },
        select: { id: true },
      }),
      prisma.post.findUniqueOrThrow({
        where: { code: 'POST-1' },
        select: {
          id: true,
          devices: {
            where: { kind: 'scanner' },
            take: 1,
            select: { id: true },
          },
        },
      }),
    ]);
    const device = post.devices[0];
    if (!device) throw new Error('Warehouse scanner fixture is missing');
    const session = await prisma.session.create({
      data: {
        userId: actor.id,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        purpose: 'full',
        warehousePostId: post.id,
        warehousePostBoundAt: new Date(),
      },
      select: { id: true },
    });
    warehouseEvidenceIdentity = {
      actorId: actor.id,
      sessionId: session.id,
      postId: post.id,
      deviceId: device.id,
    };
    return warehouseEvidenceIdentity;
  }

  async function recordCompletedScanEvidence(
    taskId: string,
    scanRowId: string,
    rollCode: string,
    kind: 'receiving_scan' | 'reserve_scan' | 'delivery_scan',
  ) {
    const identity = await evidenceIdentity();
    const operationId = `warehouse-fixture-${randomUUID()}`;
    const operation = await prisma.warehouseOperation.create({
      data: {
        id: operationId,
        operationKey: randomUUID(),
        kind,
        status: 'succeeded',
        taskId,
        scanRowId,
        rollCode,
        ...identity,
        requestFingerprint: '0'.repeat(64),
        safeResult: {
          operationId,
          taskId,
          rollCode,
          mode: kind.replace('_scan', ''),
          scanStatus: 'accepted',
        },
        httpStatus: 200,
        completedAt: new Date(),
      },
    });
    await audit.record({
      type:
        kind === 'receiving_scan'
          ? 'audit:warehouse_roll_received'
          : kind === 'delivery_scan'
            ? 'audit:warehouse_roll_shipped'
            : 'audit:warehouse_reserve_roll_verified',
      actorRole: 'warehouse',
      actorId: identity.actorId,
      objectId: rollCode,
      detail: { warehouseOperationId: operation.id, taskId, scanRowId, rollCode },
    });
  }

  function capture<T>(request: Promise<T>): Promise<PromiseSettledResult<T>> {
    return request.then(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    );
  }

  describe('finance', () => {
    it('deduplicates identical concurrent invoice requests with exact schedule and event counts', async () => {
      const { financeOrder } = await createFinanceFixture();
      const dto = {
        amount: 1_000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d' as const,
      };
      const pause = pauseFirstAudit();

      const first = finance.createInvoice(financeActor, financeOrder.id, dto);
      await pause.reached.promise;
      const second = finance.createInvoice(financeActor, financeOrder.id, dto);
      try {
        await waitForAdvisoryLock(prisma);
      } finally {
        pause.release.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      await expect(
        prisma.paymentSchedule.count({ where: { financeOrderId: financeOrder.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:payment_policy_created' },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:invoice_status_updated' },
        }),
      ).resolves.toBe(1);
    });

    it('lets the first incompatible concurrent invoice target win and rejects the loser', async () => {
      const { financeOrder } = await createFinanceFixture();
      const pause = pauseFirstAudit();

      const first = finance.createInvoice(financeActor, financeOrder.id, {
        amount: 1_000.01,
        paymentTermsType: 'prepay_50_postpay_50_30d',
      });
      await pause.reached.promise;
      const second = capture(
        finance.createInvoice(financeActor, financeOrder.id, {
          amount: 2_000,
          paymentTermsType: 'postpay_100_30d',
        }),
      );
      try {
        await waitForAdvisoryLock(prisma);
      } finally {
        pause.release.resolve();
      }

      await expect(first).resolves.toBeDefined();
      const secondOutcome = await second;
      expect(secondOutcome.status).toBe('rejected');
      if (secondOutcome.status !== 'rejected') throw new Error('Expected an invoice conflict');
      expect(secondOutcome.reason).toBeInstanceOf(ConflictException);
      expect((secondOutcome.reason as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'FINANCE_INVOICE_RETRY_CONFLICT' }),
      );
      const persistedInvoice = await prisma.financeOrder.findUniqueOrThrow({
        where: { id: financeOrder.id },
        select: { amountValue: true, paymentTermsType: true },
      });
      expect(persistedInvoice.amountValue?.toFixed(2)).toBe('1000.01');
      expect(persistedInvoice.paymentTermsType).toBe('prepay_50_postpay_50_30d');
      await expect(
        prisma.paymentSchedule.count({ where: { financeOrderId: financeOrder.id } }),
      ).resolves.toBe(2);
    });

    it('deduplicates identical concurrent terms selection before replacing schedules', async () => {
      const invoiceIssuedAt = new Date('2026-07-11T08:00:00.000Z');
      const { financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        amountValue: 1_000.01,
        invoiceIssuedAt,
      });
      const dto = { paymentTermsType: 'prepay_50_postpay_50_30d' as const };
      const pause = pauseFirstAudit();

      const first = deferredPayments.setTerms(financeActor, financeOrder.id, dto);
      await pause.reached.promise;
      const second = deferredPayments.setTerms(financeActor, financeOrder.id, dto);
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        pause.release.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      await expect(
        prisma.paymentSchedule.count({ where: { financeOrderId: financeOrder.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:payment_policy_created' },
        }),
      ).resolves.toBe(1);
    });

    it('rejects the incompatible concurrent terms loser without replacing the winner schedules', async () => {
      const { financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        amountValue: 1_000.01,
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      const pause = pauseFirstAudit();

      const first = deferredPayments.setTerms(financeActor, financeOrder.id, {
        paymentTermsType: 'prepay_50_postpay_50_30d',
      });
      await pause.reached.promise;
      const second = capture(
        deferredPayments.setTerms(financeActor, financeOrder.id, {
          paymentTermsType: 'postpay_100_30d',
        }),
      );
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        pause.release.resolve();
      }

      await expect(first).resolves.toBeUndefined();
      const secondOutcome = await second;
      expect(secondOutcome.status).toBe('rejected');
      if (secondOutcome.status !== 'rejected') throw new Error('Expected a terms conflict');
      expect(secondOutcome.reason).toBeInstanceOf(ConflictException);
      expect((secondOutcome.reason as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'DEFERRED_PAYMENT_TERMS_RETRY_CONFLICT' }),
      );
      await expect(
        prisma.paymentSchedule.count({ where: { financeOrderId: financeOrder.id } }),
      ).resolves.toBe(2);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:payment_policy_created' },
        }),
      ).resolves.toBe(1);
    });

    it('deduplicates concurrent confirmation to one operation and one event', async () => {
      const { order, financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        paymentTermsType: 'prepay_50_postpay_50_30d',
        amountValue: 1_000.01,
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      const schedule = await prisma.paymentSchedule.create({
        data: {
          financeOrderId: financeOrder.id,
          kind: 'invoice_prepayment',
          amount: 500,
          dueDate: new Date('2026-07-11T00:00:00.000Z'),
          status: 'unpaid',
        },
      });
      await prisma.paymentSchedule.create({
        data: {
          financeOrderId: financeOrder.id,
          kind: 'post_delivery',
          amount: 500.01,
          status: 'unpaid',
        },
      });
      const pause = pauseFirstAudit();

      const first = deferredPayments.confirmSchedule(financeActor, financeOrder.id, schedule.id);
      await pause.reached.promise;
      const second = deferredPayments.confirmSchedule(financeActor, financeOrder.id, schedule.id);
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        pause.release.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      await expect(
        prisma.paymentOperation.count({ where: { financeOrderId: financeOrder.id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:payment_schedule_item_confirmed' },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.commercialOrder.findUniqueOrThrow({
          where: { id: order.id },
          select: { paymentStatus: true },
        }),
      ).resolves.toEqual({ paymentStatus: 'partial' });
    });

    it('does not let a stale terms change replace a concurrently paid schedule', async () => {
      const { order, financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        paymentTermsType: 'postpay_100_30d',
        amountValue: 1_000.01,
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      const schedule = await prisma.paymentSchedule.create({
        data: {
          financeOrderId: financeOrder.id,
          kind: 'post_delivery',
          amount: 1_000.01,
          dueDate: new Date('2026-08-10T00:00:00.000Z'),
          status: 'unpaid',
        },
      });
      const pause = pauseFirstAudit();

      const confirmation = deferredPayments.confirmSchedule(
        financeActor,
        financeOrder.id,
        schedule.id,
      );
      await pause.reached.promise;
      const termsChange = capture(
        deferredPayments.setTerms(financeActor, financeOrder.id, {
          paymentTermsType: 'prepay_50_postpay_50_30d',
          reason: 'Customer requested new terms',
        }),
      );
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        pause.release.resolve();
      }

      await expect(confirmation).resolves.toBeUndefined();
      const termsOutcome = await termsChange;
      const [schedules, operations, confirmationEvents, termsEvents, aggregate] = await Promise.all(
        [
          prisma.paymentSchedule.findMany({
            where: { financeOrderId: financeOrder.id },
            select: { id: true, kind: true, status: true },
            orderBy: { createdAt: 'asc' },
          }),
          prisma.paymentOperation.count({ where: { financeOrderId: financeOrder.id } }),
          prisma.domainEvent.count({
            where: {
              objectId: financeOrder.id,
              type: 'audit:payment_schedule_item_confirmed',
            },
          }),
          prisma.domainEvent.count({
            where: {
              objectId: financeOrder.id,
              type: 'audit:payment_policy_updated',
            },
          }),
          prisma.financeOrder.findUniqueOrThrow({
            where: { id: financeOrder.id },
            select: {
              paymentStatus: true,
              paymentTermsType: true,
              commercialOrder: { select: { paymentStatus: true } },
            },
          }),
        ],
      );

      expect({
        termsOutcome: termsOutcome.status,
        schedules,
        operations,
        confirmationEvents,
        termsEvents,
        aggregate,
      }).toEqual({
        termsOutcome: 'rejected',
        schedules: [{ id: schedule.id, kind: 'post_delivery', status: 'paid' }],
        operations: 1,
        confirmationEvents: 1,
        termsEvents: 0,
        aggregate: {
          paymentStatus: 'paid',
          paymentTermsType: 'postpay_100_30d',
          commercialOrder: { paymentStatus: 'paid' },
        },
      });
      if (termsOutcome.status !== 'rejected') throw new Error('Expected a terms conflict');
      expect(termsOutcome.reason).toBeInstanceOf(ConflictException);
      expect((termsOutcome.reason as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'DEFERRED_PAYMENT_ALREADY_STARTED' }),
      );
      await expect(
        prisma.commercialOrder.findUniqueOrThrow({
          where: { id: order.id },
          select: { paymentStatus: true },
        }),
      ).resolves.toEqual({ paymentStatus: 'paid' });
    });

    it('confirms two different dated schedules exactly once and finishes the order as paid', async () => {
      const { order, financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        paymentTermsType: 'prepay_50_postpay_50_30d',
        amountValue: 1_000.01,
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      const schedules = await Promise.all([
        prisma.paymentSchedule.create({
          data: {
            financeOrderId: financeOrder.id,
            kind: 'invoice_prepayment',
            amount: 500,
            dueDate: new Date('2026-07-11T00:00:00.000Z'),
            status: 'unpaid',
          },
        }),
        prisma.paymentSchedule.create({
          data: {
            financeOrderId: financeOrder.id,
            kind: 'post_delivery',
            amount: 500.01,
            dueDate: new Date('2026-08-10T00:00:00.000Z'),
            status: 'unpaid',
          },
        }),
      ]);
      const pause = pauseFirstAudit();

      const first = deferredPayments.confirmSchedule(
        financeActor,
        financeOrder.id,
        schedules[0]!.id,
      );
      await pause.reached.promise;
      const second = deferredPayments.confirmSchedule(
        financeActor,
        financeOrder.id,
        schedules[1]!.id,
      );
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        pause.release.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

      const [paidSchedules, operations, events, aggregate] = await Promise.all([
        prisma.paymentSchedule.count({
          where: { financeOrderId: financeOrder.id, status: 'paid' },
        }),
        prisma.paymentOperation.count({ where: { financeOrderId: financeOrder.id } }),
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:payment_schedule_item_confirmed' },
        }),
        prisma.financeOrder.findUniqueOrThrow({
          where: { id: financeOrder.id },
          select: {
            paymentStatus: true,
            commercialOrder: { select: { paymentStatus: true } },
          },
        }),
      ]);

      expect({ paidSchedules, operations, events, aggregate }).toEqual({
        paidSchedules: 2,
        operations: 2,
        events: 2,
        aggregate: {
          paymentStatus: 'paid',
          commercialOrder: { paymentStatus: 'paid' },
        },
      });
      await expect(
        prisma.commercialOrder.findUniqueOrThrow({
          where: { id: order.id },
          select: { paymentStatus: true },
        }),
      ).resolves.toEqual({ paymentStatus: 'paid' });
    });
  });

  describe('production assignment', () => {
    it('publishes each roll once when two approvals race', async () => {
      const fixture = await createApprovalFixture(2);
      const blocker = await blockDispatchRows(fixture.rolls.map((roll) => roll.id));

      const first = production.approve(productionActor, fixture.productionOrder.id);
      const second = production.approve(productionActor, fixture.productionOrder.id);
      try {
        await waitForTableLock(prisma, 'roll_dispatch_items');
      } finally {
        blocker.release.resolve();
      }
      await blocker.finished;
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      const [approvalEvents, taskEvents, operatorLines] = await Promise.all([
        prisma.domainEvent.count({
          where: {
            objectId: fixture.productionOrder.id,
            type: 'audit:production_order_approved',
          },
        }),
        prisma.domainEvent.findMany({
          where: {
            objectId: { in: fixture.rolls.map((roll) => roll.rollCode) },
            type: 'audit:task_assigned',
          },
          select: { objectId: true, detail: true },
        }),
        prisma.operatorRollLine.count({
          where: { rollDispatchItemId: { in: fixture.rolls.map((roll) => roll.id) } },
        }),
      ]);
      expect(approvalEvents).toBe(1);
      expect(operatorLines).toBe(2);
      expect(taskEvents).toHaveLength(2);
      expect(new Set(taskEvents.map((event) => event.objectId))).toEqual(
        new Set(fixture.rolls.map((roll) => roll.rollCode)),
      );
      expect(taskEvents).toEqual(
        expect.arrayContaining(
          fixture.rolls.map((roll, index) =>
            expect.objectContaining({
              objectId: roll.rollCode,
              detail: expect.objectContaining({
                commercialOrderId: fixture.order.id,
                operatorId: fixture.operators[index]!.id,
                productionOrderId: fixture.productionOrder.id,
                rollId: roll.rollCode,
              }),
            }),
          ),
        ),
      );
    });

    it('rolls approval and every task fact back when one task publication fails', async () => {
      const fixture = await createApprovalFixture(2);
      const commercialOrderBefore = await prisma.commercialOrder.findUniqueOrThrow({
        where: { id: fixture.order.id },
        select: { productionIndicator: true },
      });
      const originalRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
        const event = await originalRecord(input, client);
        if (input.type === 'audit:task_assigned') {
          throw new Error('forced approval task audit failure');
        }
        return event;
      });

      await expect(production.approve(productionActor, fixture.productionOrder.id)).rejects.toThrow(
        'forced approval task audit failure',
      );

      await expect(
        prisma.productionOrder.findUniqueOrThrow({
          where: { id: fixture.productionOrder.id },
          select: { approvalState: true, indicator: true },
        }),
      ).resolves.toEqual({ approvalState: 'pending', indicator: 'needs_production' });
      await expect(
        prisma.rollDispatchItem.findMany({
          where: { id: { in: fixture.rolls.map((roll) => roll.id) } },
          select: { status: true },
        }),
      ).resolves.toEqual([{ status: 'new' }, { status: 'new' }]);
      await expect(
        prisma.operatorRollLine.count({
          where: { rollDispatchItemId: { in: fixture.rolls.map((roll) => roll.id) } },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.commercialOrder.findUniqueOrThrow({
          where: { id: fixture.order.id },
          select: { productionIndicator: true },
        }),
      ).resolves.toEqual(commercialOrderBefore);
      await expect(
        prisma.domainEvent.count({
          where: {
            OR: [
              { objectId: fixture.productionOrder.id },
              { objectId: { in: fixture.rolls.map((roll) => roll.rollCode) } },
            ],
          },
        }),
      ).resolves.toBe(0);
    });

    it('deduplicates identical concurrent single-roll assignments and their audit facts', async () => {
      const fixture = await createProductionFixture();
      const [roll] = fixture.rolls;
      const [operator] = fixture.operators;
      const blocker = await blockDispatchRows([roll!.id]);
      const dto = { operatorId: operator!.id };

      const first = production.assignRoll(productionActor, roll!.rollCode, dto);
      const second = production.assignRoll(productionActor, roll!.rollCode, dto);
      try {
        await waitForTableLock(prisma, 'roll_dispatch_items');
      } finally {
        blocker.release.resolve();
      }
      await blocker.finished;
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      await expect(
        prisma.domainEvent.count({
          where: { objectId: roll!.rollCode, type: 'audit:roll_dispatch_assigned' },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: { objectId: roll!.rollCode, type: 'audit:task_assigned' },
        }),
      ).resolves.toBe(1);
    });

    it('serializes different-target single-roll assignments with one final owner', async () => {
      const fixture = await createProductionFixture();
      const [roll] = fixture.rolls;
      const blocker = await blockDispatchRows([roll!.id]);

      const first = production.assignRoll(productionActor, roll!.rollCode, {
        operatorId: fixture.operators[0]!.id,
      });
      let outcomes: PromiseSettledResult<Awaited<typeof first>>[] = [];
      try {
        await waitForTableLock(prisma, 'roll_dispatch_items');
        const second = production.assignRoll(productionActor, roll!.rollCode, {
          operatorId: fixture.operators[1]!.id,
        });
        await waitForTableLock(prisma, 'shifts');
        blocker.release.resolve();
        outcomes = await Promise.allSettled([first, second]);
      } finally {
        blocker.release.resolve();
      }
      await blocker.finished;
      const successful = outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? [outcome.value] : [],
      );
      expect(successful).toHaveLength(2);

      const finalRoll = await prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: roll!.id },
        select: { assignedOperatorId: true },
      });
      expect(finalRoll.assignedOperatorId).not.toBeNull();
      expect(
        successful.some(
          (assignment) => assignment.assignedOperatorId === finalRoll.assignedOperatorId,
        ),
      ).toBe(true);
      await expect(prisma.rollDispatchItem.count({ where: { id: roll!.id } })).resolves.toBe(1);

      const assignmentEvents = await prisma.domainEvent.findMany({
        where: { objectId: roll!.rollCode, type: 'audit:roll_dispatch_assigned' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(assignmentEvents).toHaveLength(2);
      expect(assignmentEvents[0]).toMatchObject({
        oldValue: { assignedOperatorId: null },
      });
      const firstTarget = (assignmentEvents[0]!.newValue as { assignedOperatorId: string })
        .assignedOperatorId;
      expect(assignmentEvents[1]).toMatchObject({
        oldValue: { assignedOperatorId: firstTarget },
        newValue: { assignedOperatorId: finalRoll.assignedOperatorId },
      });

      const taskEvents = await prisma.domainEvent.findMany({
        where: {
          objectId: roll!.rollCode,
          type: { in: ['audit:task_assigned', 'audit:task_reassigned'] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(taskEvents).toHaveLength(2);
      expect(taskEvents[0]).toMatchObject({
        type: 'audit:task_assigned',
        detail: { operatorId: firstTarget },
      });
      expect(taskEvents[1]).toMatchObject({
        type: 'audit:task_reassigned',
        detail: {
          previousOperatorId: firstTarget,
          operatorId: finalRoll.assignedOperatorId,
        },
      });
    });

    it('rolls a single assignment back when its audit fact cannot be appended', async () => {
      const fixture = await createProductionFixture();
      const [roll] = fixture.rolls;
      const [operator] = fixture.operators;
      const originalRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
        await originalRecord(input, client);
        throw new Error('forced assignment audit failure');
      });

      await expect(
        production.assignRoll(productionActor, roll!.rollCode, {
          operatorId: operator!.id,
        }),
      ).rejects.toThrow('forced assignment audit failure');

      await expect(
        prisma.rollDispatchItem.findUniqueOrThrow({
          where: { id: roll!.id },
          select: {
            assignedOperatorId: true,
            plannedShiftId: true,
            postId: true,
            machineId: true,
            status: true,
          },
        }),
      ).resolves.toEqual({
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: null,
        machineId: null,
        status: 'new',
      });
      await expect(prisma.domainEvent.count({ where: { objectId: roll!.rollCode } })).resolves.toBe(
        0,
      );
    });

    it('deduplicates an identical concurrent batch into one atomic audit fact', async () => {
      const fixture = await createProductionFixture(2);
      const [operator] = fixture.operators;
      const blocker = await blockDispatchRows(fixture.rolls.map((roll) => roll.id));
      const dto = {
        changes: fixture.rolls.map((roll) => ({
          rollId: roll.rollCode,
          operatorId: operator!.id,
          shiftId: fixture.shift.id,
          priority: 50,
        })),
      };

      const first = production.batchUpdate(productionActor, dto);
      const second = production.batchUpdate(productionActor, dto);
      try {
        await waitForTableLock(prisma, 'roll_dispatch_items');
      } finally {
        blocker.release.resolve();
      }
      await blocker.finished;
      await expect(Promise.all([first, second])).resolves.toEqual([{ updated: 2 }, { updated: 2 }]);

      await expect(
        prisma.domainEvent.count({
          where: {
            objectId: { in: fixture.rolls.map((roll) => roll.rollCode) },
            type: 'audit:roll_dispatch_bulk_assigned',
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            objectId: { in: fixture.rolls.map((roll) => roll.rollCode) },
            type: 'audit:task_assigned',
          },
        }),
      ).resolves.toBe(2);
    });

    it('serializes different-target batches without a mixed final target', async () => {
      const fixture = await createProductionFixture(2);
      const blocker = await blockDispatchRows(fixture.rolls.map((roll) => roll.id));
      const first = production.batchUpdate(productionActor, {
        changes: fixture.rolls.map((roll) => ({
          rollId: roll.rollCode,
          operatorId: fixture.operators[0]!.id,
          shiftId: fixture.shift.id,
          priority: 25,
        })),
      });
      let outcomes: PromiseSettledResult<Awaited<typeof first>>[] = [];
      try {
        await waitForTableLock(prisma, 'roll_dispatch_items');
        const second = production.batchUpdate(productionActor, {
          changes: fixture.rolls.map((roll) => ({
            rollId: roll.rollCode,
            operatorId: fixture.operators[1]!.id,
            shiftId: fixture.shift.id,
            priority: 75,
          })),
        });
        await waitForTableLock(prisma, 'shifts');
        blocker.release.resolve();
        outcomes = await Promise.allSettled([first, second]);
      } finally {
        blocker.release.resolve();
      }
      await blocker.finished;
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
      const finalRows = await prisma.rollDispatchItem.findMany({
        where: { id: { in: fixture.rolls.map((roll) => roll.id) } },
        select: { assignedOperatorId: true, priority: true },
      });
      expect(new Set(finalRows.map((row) => row.assignedOperatorId)).size).toBe(1);
      expect(new Set(finalRows.map((row) => row.priority)).size).toBe(1);
      expect(finalRows[0]!.assignedOperatorId).not.toBeNull();
      expect(finalRows.every((row) => row.priority === 75)).toBe(true);
      await expect(
        prisma.rollDispatchItem.count({
          where: { id: { in: fixture.rolls.map((roll) => roll.id) } },
        }),
      ).resolves.toBe(2);

      const bulkEvents = await prisma.domainEvent.findMany({
        where: {
          objectId: { in: fixture.rolls.map((roll) => roll.rollCode) },
          type: 'audit:roll_dispatch_bulk_assigned',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(bulkEvents).toHaveLength(2);
      const firstBulkTargets = (
        bulkEvents[0]!.detail as { assignments: Array<{ operatorId: string }> }
      ).assignments.map((assignment) => assignment.operatorId);
      const secondBulkTargets = (
        bulkEvents[1]!.detail as { assignments: Array<{ operatorId: string }> }
      ).assignments.map((assignment) => assignment.operatorId);
      expect(new Set(firstBulkTargets)).toEqual(new Set([fixture.operators[0]!.id]));
      expect(new Set(secondBulkTargets)).toEqual(new Set([finalRows[0]!.assignedOperatorId!]));

      for (const roll of fixture.rolls) {
        const taskEvents = await prisma.domainEvent.findMany({
          where: {
            objectId: roll.rollCode,
            type: { in: ['audit:task_assigned', 'audit:task_reassigned'] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        expect(taskEvents).toHaveLength(2);
        expect(taskEvents[0]).toMatchObject({
          type: 'audit:task_assigned',
          detail: { operatorId: firstBulkTargets[0] },
        });
        expect(taskEvents[1]).toMatchObject({
          type: 'audit:task_reassigned',
          detail: {
            previousOperatorId: firstBulkTargets[0],
            operatorId: finalRows[0]!.assignedOperatorId,
          },
        });
      }
    });

    it('rolls every batch row back when the bulk audit fact fails', async () => {
      const fixture = await createProductionFixture(2);
      const [operator] = fixture.operators;
      const originalRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementationOnce(async (input, client) => {
        await originalRecord(input, client);
        throw new Error('forced batch audit failure');
      });

      await expect(
        production.batchUpdate(productionActor, {
          changes: fixture.rolls.map((roll) => ({
            rollId: roll.rollCode,
            operatorId: operator!.id,
            shiftId: fixture.shift.id,
            priority: 50,
          })),
        }),
      ).rejects.toThrow('forced batch audit failure');

      const rolledBack = await prisma.rollDispatchItem.findMany({
        where: { id: { in: fixture.rolls.map((roll) => roll.id) } },
        select: { rollCode: true, assignedOperatorId: true, priority: true, status: true },
      });
      expect(new Map(rolledBack.map((roll) => [roll.rollCode, roll] as const))).toEqual(
        new Map(
          fixture.rolls.map((roll, index) => [
            roll.rollCode,
            {
              rollCode: roll.rollCode,
              assignedOperatorId: null,
              priority: index,
              status: 'new',
            },
          ]),
        ),
      );
      await expect(
        prisma.domainEvent.count({
          where: {
            objectId: { in: fixture.rolls.map((roll) => roll.rollCode) },
            type: 'audit:roll_dispatch_bulk_assigned',
          },
        }),
      ).resolves.toBe(0);
    });

    it('rolls draft and approved rows back together when approved task publication fails', async () => {
      const approved = await createProductionFixture();
      const draft = await createProductionFixture();
      await prisma.productionOrder.update({
        where: { id: draft.productionOrder.id },
        data: { approvalState: 'pending', indicator: 'needs_production' },
      });
      const rollIds = [approved.rolls[0]!.id, draft.rolls[0]!.id];
      const rollCodes = [approved.rolls[0]!.rollCode, draft.rolls[0]!.rollCode];
      const rowsBefore = await prisma.rollDispatchItem.findMany({
        where: { id: { in: rollIds } },
        select: { assignedOperatorId: true, priority: true, status: true },
        orderBy: { id: 'asc' },
      });
      const originalRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
        const event = await originalRecord(input, client);
        if (input.type === 'audit:task_assigned') {
          throw new Error('forced mixed-batch task audit failure');
        }
        return event;
      });

      await expect(
        production.batchUpdate(productionActor, {
          changes: [
            {
              rollId: approved.rolls[0]!.rollCode,
              operatorId: approved.operators[0]!.id,
              priority: 60,
            },
            {
              rollId: draft.rolls[0]!.rollCode,
              operatorId: draft.operators[0]!.id,
              priority: 70,
            },
          ],
        }),
      ).rejects.toThrow('forced mixed-batch task audit failure');

      await expect(
        prisma.rollDispatchItem.findMany({
          where: { id: { in: rollIds } },
          select: { assignedOperatorId: true, priority: true, status: true },
          orderBy: { id: 'asc' },
        }),
      ).resolves.toEqual(rowsBefore);
      await expect(
        prisma.domainEvent.count({ where: { objectId: { in: rollCodes } } }),
      ).resolves.toBe(0);
    });
  });

  describe('order fulfillment handoff', () => {
    it('serializes different final warehouse closes before reading fulfillment facts', async () => {
      const fixture = await createMixedCloseHandoffFixture();
      const originalReconcile = fulfillmentHandoff.reconcile.bind(fulfillmentHandoff);
      const bothReached = deferred();
      const release = deferred();
      let reached = 0;
      jest.spyOn(fulfillmentHandoff, 'reconcile').mockImplementation(async (...args) => {
        reached += 1;
        if (reached === 2) bothReached.resolve();
        await release.promise;
        return originalReconcile(...args);
      });

      const reserveClose = capture(
        warehouse.closeTask(warehouseActor, fixture.reserveTask.id, { mode: 'full' }),
      );
      const receivingClose = capture(
        warehouse.closeTask(warehouseActor, fixture.receivingTask.id, { mode: 'full' }),
      );
      try {
        await waitForSignal(
          bothReached.promise,
          `both fulfillment reconciles (reached=${reached})`,
        );
      } finally {
        release.resolve();
      }
      const outcomes = await Promise.all([reserveClose, receivingClose]);
      outcomes.forEach((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
      });

      const deliveryTasks = await prisma.warehouseAcceptanceTask.findMany({
        where: { deliveryScopeKey: `warehouse_delivery:${fixture.order.id}` },
      });
      deliveryTasks.forEach((task) => warehouseTaskIds.add(task.id));
      expect(deliveryTasks).toHaveLength(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:commercial_order_ready_for_shipment',
            objectId: fixture.order.id,
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:warehouse_delivery_task_created',
            objectId: deliveryTasks[0]!.id,
          },
        }),
      ).resolves.toBe(1);
    });

    it('uses an accepted row-level order link when the receiving task is unscoped', async () => {
      const fixture = await createReadyProductionHandoffFixture();
      await prisma.warehouseAcceptanceTask.update({
        where: { id: fixture.receivingTask.id },
        data: { orderId: null, positionId: null },
      });

      const result = await fulfillmentHandoff.reconcile(warehouseActor, fixture.order.id);
      if (result.deliveryTaskId) warehouseTaskIds.add(result.deliveryTaskId);

      expect(result).toEqual(
        expect.objectContaining({
          state: 'ready_for_shipment',
          deliveryTaskId: expect.any(String),
          created: true,
          reason: null,
        }),
      );
    });

    it('claims a partial legacy delivery even when a fulfilled roll is already delivered', async () => {
      const fixture = await createReadyProductionHandoffFixture();
      const legacy = await prisma.warehouseAcceptanceTask.create({
        data: {
          mode: 'delivery',
          status: 'partial',
          orderId: fixture.order.id,
          rows: {
            create: {
              rollCode: fixture.roll.rollCode,
              fromOrderId: fixture.order.orderNumber,
              scanStatus: 'accepted',
            },
          },
        },
      });
      warehouseTaskIds.add(legacy.id);
      await prisma.warehouseRoll.update({
        where: { rollCode: fixture.roll.rollCode },
        data: { warehouseStatus: 'delivered' },
      });

      const result = await fulfillmentHandoff.reconcile(warehouseActor, fixture.order.id);

      expect(result).toEqual({
        state: 'ready_for_shipment',
        deliveryTaskId: legacy.id,
        created: false,
        reason: null,
      });
      await expect(
        prisma.warehouseAcceptanceTask.findUniqueOrThrow({
          where: { id: legacy.id },
          select: { deliveryScopeKey: true },
        }),
      ).resolves.toEqual({ deliveryScopeKey: `warehouse_delivery:${fixture.order.id}` });
      await expect(
        prisma.warehouseAcceptanceTask.count({
          where: { mode: 'delivery', orderId: fixture.order.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: { type: 'audit:warehouse_delivery_task_created', objectId: legacy.id },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:commercial_order_ready_for_shipment',
            objectId: fixture.order.id,
          },
        }),
      ).resolves.toBe(1);
    });

    it('creates one delivery task and transition pair for simultaneous ready reconciles', async () => {
      const fixture = await createReadyProductionHandoffFixture();
      expect(fixture.roll).toEqual(
        expect.objectContaining({
          orderLineId: fixture.position.id,
          status: 'done',
          operatorLine: expect.objectContaining({ warehouseState: 'received' }),
        }),
      );
      expect(fixture.receivingTask).toEqual(
        expect.objectContaining({
          mode: 'receiving',
          status: 'closed',
          orderId: fixture.order.id,
          rows: [
            expect.objectContaining({
              rollCode: fixture.roll.rollCode,
              scanStatus: 'accepted',
            }),
          ],
        }),
      );
      expect(fixture.warehouseRoll).toEqual(
        expect.objectContaining({
          rollCode: fixture.roll.rollCode,
          warehouseStatus: 'received',
          reservedForOrderId: fixture.order.id,
        }),
      );

      const pause = pauseReadyTransitionAudit();
      const first = capture(fulfillmentHandoff.reconcile(warehouseActor, fixture.order.id));
      await pause.reached.promise;
      const second = capture(fulfillmentHandoff.reconcile(warehouseActor, fixture.order.id));
      let overlapFailure: unknown;
      try {
        await waitForAdvisoryLock(prisma);
      } catch (error) {
        overlapFailure = error;
      } finally {
        pause.release.resolve();
      }
      const outcomes = await Promise.all([first, second]);
      const results = outcomes.map((outcome) => {
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      });
      results.forEach((result) => {
        if (result.deliveryTaskId) warehouseTaskIds.add(result.deliveryTaskId);
      });
      if (overlapFailure) throw overlapFailure;

      expect(results[0]!.deliveryTaskId).toEqual(expect.any(String));
      expect(new Set(results.map((result) => result.deliveryTaskId))).toEqual(
        new Set([results[0]!.deliveryTaskId]),
      );
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      await expect(
        prisma.warehouseAcceptanceTask.count({
          where: { deliveryScopeKey: `warehouse_delivery:${fixture.order.id}` },
        }),
      ).resolves.toBe(1);

      const deliveryTask = await prisma.warehouseAcceptanceTask.findUniqueOrThrow({
        where: { deliveryScopeKey: `warehouse_delivery:${fixture.order.id}` },
        include: { rows: true },
      });
      warehouseTaskIds.add(deliveryTask.id);
      expect(deliveryTask).toEqual(
        expect.objectContaining({
          mode: 'delivery',
          status: 'open',
          operationCode: `ВЫ-${fixture.order.orderNumber}`,
          orderId: fixture.order.id,
          rows: [
            expect.objectContaining({
              rollCode: fixture.roll.rollCode,
              fromOrderId: fixture.order.orderNumber,
              scanStatus: 'expected',
            }),
          ],
        }),
      );
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:warehouse_delivery_task_created',
            objectId: results[0]!.deliveryTaskId!,
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:commercial_order_ready_for_shipment',
            objectId: fixture.order.id,
          },
        }),
      ).resolves.toBe(1);
    });
  });

  describe('warehouse close and deferred payment', () => {
    it('does not report a competing full close as successful while the task remains partial', async () => {
      const task = await prisma.warehouseAcceptanceTask.create({
        data: { mode: 'receiving', status: 'open' },
      });
      warehouseTaskIds.add(task.id);
      const pause = pauseFirstAudit();

      const partial = warehouse.closeTask({ userId: null, role: 'warehouse' }, task.id, {
        mode: 'partial',
      });
      await pause.reached.promise;
      const full = warehouse.closeTask({ userId: null, role: 'warehouse' }, task.id, {
        mode: 'full',
      });
      try {
        await waitForTableLock(prisma, 'warehouse_acceptance_tasks');
      } finally {
        pause.release.resolve();
      }
      await expect(Promise.all([partial, full])).resolves.toHaveLength(2);

      await expect(
        prisma.warehouseAcceptanceTask.findUniqueOrThrow({
          where: { id: task.id },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: 'closed' });
    });

    it('activates one deferred stage when two delivery tasks close for the same order', async () => {
      const { order, financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        amountValue: 1_000,
        paymentTermsType: 'postpay_100_30d',
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      await prisma.paymentSchedule.create({
        data: {
          financeOrderId: financeOrder.id,
          kind: 'post_delivery',
          amount: 1_000,
          status: 'unpaid',
        },
      });
      const tasks = await Promise.all([
        createDeliveryTask(order.id, order.orderNumber, `${order.orderNumber}-delivery-1`),
        createDeliveryTask(order.id, order.orderNumber, `${order.orderNumber}-delivery-2`),
      ]);
      const auditReached = deferred();
      const releaseFirst = deferred();
      const originalRecord = audit.record.bind(audit);
      let paused = false;
      jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
        if (input.type === 'audit:deferred_payment_due_scheduled' && !paused) {
          paused = true;
          auditReached.resolve();
          await releaseFirst.promise;
        }
        return originalRecord(input, client);
      });

      const first = warehouse.closeTask({ userId: null, role: 'warehouse' }, tasks[0]!.id, {
        mode: 'full',
      });
      await auditReached.promise;
      const second = warehouse.closeTask({ userId: null, role: 'warehouse' }, tasks[1]!.id, {
        mode: 'full',
      });
      try {
        await waitForTableLock(prisma, 'finance_orders');
      } finally {
        releaseFirst.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);

      await expect(
        prisma.domainEvent.count({
          where: { objectId: financeOrder.id, type: 'audit:deferred_payment_due_scheduled' },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            objectId: { in: tasks.flatMap((task) => task.rows.map((row) => row.rollCode)) },
            type: 'audit:warehouse_roll_shipped',
          },
        }),
      ).resolves.toBe(2);
      await expect(
        prisma.paymentSchedule.count({
          where: { financeOrderId: financeOrder.id, dueDate: { not: null } },
        }),
      ).resolves.toBe(1);
    });

    it('does not duplicate the prior shipment fact while appending its payment consequence', async () => {
      const { order, financeOrder } = await createFinanceFixture({
        invoiceStatus: 'invoiced',
        amountValue: 1_000,
        paymentTermsType: 'postpay_100_30d',
        invoiceIssuedAt: new Date('2026-07-11T08:00:00.000Z'),
      });
      await prisma.paymentSchedule.create({
        data: {
          financeOrderId: financeOrder.id,
          kind: 'post_delivery',
          amount: 1_000,
          status: 'unpaid',
        },
      });
      const task = await createDeliveryTask(
        order.id,
        order.orderNumber,
        `${order.orderNumber}-ordered-delivery`,
      );
      const calls: string[] = [];
      const originalRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
        calls.push(input.type);
        return originalRecord(input, client);
      });

      await warehouse.closeTask({ userId: null, role: 'warehouse' }, task.id, { mode: 'full' });

      expect(calls).not.toContain('audit:warehouse_roll_shipped');
      expect(calls).toContain('audit:deferred_payment_due_scheduled');
      await expect(
        prisma.domainEvent.count({
          where: {
            objectId: { in: [task.rows[0]!.rollCode, financeOrder.id] },
            type: {
              in: ['audit:warehouse_roll_shipped', 'audit:deferred_payment_due_scheduled'],
            },
          },
        }),
      ).resolves.toBe(2);
    });
  });
});
