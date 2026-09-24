import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type {
  WarehousePalletDeliveryScanResult,
  WarehousePalletHandoffScanResult,
} from '@plenka/contracts';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { createSealedPhysicalPalletEvidenceFixture } from './warehouse-pallet-e2e-fixture';

type AuthHeaders = { Authorization: string };

describe('Warehouse pallet handoff scan (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let warehouseAuth: AuthHeaders;
  let commercialAuth: AuthHeaders;
  let warehouseActorId: string;
  let warehouseSessionId: string;
  let previousDevRole: string | undefined;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';

    // Runtime auth configuration is captured during AppModule evaluation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const login = async (account: 'warehouse' | 'commercial'): Promise<AuthHeaders> => {
      const response = await http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
        .expect(201);
      return { Authorization: `Bearer ${response.body.token as string}` };
    };
    [warehouseAuth, commercialAuth] = await Promise.all([login('warehouse'), login('commercial')]);

    const warehouseActor = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('warehouse') },
      select: { id: true },
    });
    const evidenceSession = await prisma.session.create({
      data: {
        userId: warehouseActor.id,
        tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        purpose: 'full',
      },
      select: { id: true },
    });
    warehouseActorId = warehouseActor.id;
    warehouseSessionId = evidenceSession.id;
  });

  afterAll(async () => {
    await app.close();
    if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevRole;
  });

  async function createFixture() {
    const suffix = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Pallet handoff ${suffix}` },
    });
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `A-PALLET-HANDOFF-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    const position = await prisma.commercialOrderPosition.create({
      data: {
        orderId: order.id,
        rollCount: 1,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '78 мкм',
      },
    });
    const productionOrder = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'completed',
      },
    });
    const rollCode = `${order.orderNumber}-roll-1`;
    await prisma.rollDispatchItem.create({
      data: {
        rollCode,
        productionOrderId: productionOrder.id,
        orderLineId: position.id,
        positionSequence: 1,
        status: 'done',
        completedAt: new Date(),
        operatorLine: {
          create: { sequence: 1, step: 'warehouse', warehouseState: 'received' },
        },
      },
    });
    const receivingTask = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'closed',
        orderId: order.id,
        positionId: position.id,
        rows: {
          create: {
            rollCode,
            fromOrderId: order.orderNumber,
            scanStatus: 'accepted',
            lastScanAt: new Date(),
          },
        },
      },
      include: { rows: true },
    });
    const receivingRow = receivingTask.rows[0];
    if (!receivingRow) throw new Error('Receiving evidence row was not created');
    const receivingOperationId = `pallet-handoff-evidence-${randomUUID()}`;
    await prisma.warehouseOperation.create({
      data: {
        id: receivingOperationId,
        operationKey: randomUUID(),
        kind: 'receiving_scan',
        status: 'succeeded',
        taskId: receivingTask.id,
        scanRowId: receivingRow.id,
        rollCode,
        actorId: warehouseActorId,
        sessionId: warehouseSessionId,
        captureChannel: 'warehouse_role_action',
        requestFingerprint: '0'.repeat(64),
        safeResult: {
          operationId: receivingOperationId,
          taskId: receivingTask.id,
          rollCode,
          mode: 'receiving',
          scanStatus: 'accepted',
        },
        httpStatus: 200,
        completedAt: new Date(),
      },
    });
    await prisma.warehouseRoll.create({
      data: {
        rollCode,
        warehouseStatus: 'received',
        receivedAt: new Date(),
        reservedForOrderId: order.id,
        reservedForPositionId: position.id,
        reservedAt: new Date(),
      },
    });
    const problem = await prisma.productionProblem.create({
      data: {
        orderId: order.id,
        positionId: position.id,
        actorRole: 'production_lead',
        type: 'general',
        reason: 'shift_balance_mismatch',
        status: 'open',
      },
    });
    const resolutionCase = await prisma.orderResolutionCase.create({
      data: {
        orderId: order.id,
        problemId: problem.id,
        type: 'production_problem',
        status: 'open',
        ownerRole: 'production_lead',
        affectedPositionIds: [position.id],
        affectedRollIds: [rollCode],
        reason: 'linked production problem',
        createdByRole: 'production_lead',
      },
    });
    const financeOrder = await prisma.financeOrder.create({
      data: {
        commercialOrderId: order.id,
        invoiceStatus: 'invoiced',
        amountValue: 1000,
        invoiceIssuedAt: new Date(),
      },
    });
    const paymentSchedule = await prisma.paymentSchedule.create({
      data: {
        financeOrderId: financeOrder.id,
        kind: 'post_delivery',
        offsetDays: 30,
        amount: 1000,
        status: 'unpaid',
      },
    });
    const pallet = await createSealedPhysicalPalletEvidenceFixture(prisma, {
      id: receivingTask.id,
      orderId: order.id,
      rows: receivingTask.rows,
    });
    const token = await prisma.palletScanToken.findUniqueOrThrow({
      where: { documentId: pallet.document!.id },
      select: { token: true },
    });

    // Pallet documents, QR identities, commands and audit facts are immutable. This isolated e2e
    // aggregate intentionally remains until the guarded disposable-schema teardown.
    return {
      order,
      pallet,
      paymentSchedule,
      problem,
      resolutionCase,
      rollCode,
      token: token.token,
    };
  }

  it('creates and closes one exact delivery by scanning its pallet despite an open production problem', async () => {
    const fixture = await createFixture();
    const operationKey = randomUUID();
    const first = await http()
      .post('/api/warehouse/pallets/scans')
      .set(warehouseAuth)
      .send({ operationKey, payload: fixture.token })
      .expect(200);
    const firstResult = first.body as WarehousePalletHandoffScanResult;

    expect(firstResult).toEqual({
      operationKey,
      documentId: fixture.pallet.document!.id,
      palletId: fixture.pallet.id,
      palletCode: fixture.pallet.palletCode,
      orderId: fixture.order.id,
      deliveryTaskId: expect.any(String),
      deliveryCreated: true,
      rollCount: 1,
      replayed: false,
    });
    expect(JSON.stringify(firstResult)).not.toContain(fixture.token);

    const replay = await http()
      .post('/api/warehouse/pallets/scans')
      .set(warehouseAuth)
      .send({ operationKey, payload: fixture.token })
      .expect(200);
    expect(replay.body).toEqual({ ...firstResult, replayed: true });

    await http()
      .post('/api/warehouse/pallets/scans')
      .set(commercialAuth)
      .send({ operationKey: randomUUID(), payload: fixture.token })
      .expect(403);

    const [deliveryTasks, commands, auditEvents, problem, resolutionCase, inventory] =
      await Promise.all([
        prisma.warehouseAcceptanceTask.findMany({
          where: { deliveryScopeKey: `warehouse_delivery:${fixture.order.id}` },
          select: {
            id: true,
            mode: true,
            status: true,
            orderId: true,
            rows: {
              select: { rollCode: true, fromOrderId: true, scanStatus: true },
            },
          },
        }),
        prisma.warehousePalletCommand.findMany({
          where: { operationKey },
          select: { kind: true, resultSnapshot: true },
        }),
        prisma.domainEvent.findMany({
          where: {
            type: 'audit:warehouse_pallet_handoff_scanned',
            objectId: fixture.pallet.id,
          },
          select: { detail: true },
        }),
        prisma.productionProblem.findUniqueOrThrow({
          where: { id: fixture.problem.id },
          select: { status: true },
        }),
        prisma.orderResolutionCase.findUniqueOrThrow({
          where: { id: fixture.resolutionCase.id },
          select: { status: true },
        }),
        http()
          .get('/api/warehouse/inventory/rolls')
          .query({ q: fixture.rollCode, view: 'current', limit: 10 })
          .set(warehouseAuth)
          .expect(200),
      ]);

    expect(deliveryTasks).toEqual([
      {
        id: firstResult.deliveryTaskId,
        mode: 'delivery',
        status: 'open',
        orderId: fixture.order.id,
        rows: [
          {
            rollCode: fixture.rollCode,
            fromOrderId: fixture.order.orderNumber,
            scanStatus: 'expected',
          },
        ],
      },
    ]);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('pallet_handoff_scan');
    expect(auditEvents).toEqual([
      {
        detail: expect.objectContaining({
          orderId: fixture.order.id,
          deliveryTaskId: firstResult.deliveryTaskId,
          rollCount: 1,
          remainingOpenProductionProblemCount: 1,
        }),
      },
    ]);
    expect(problem.status).toBe('open');
    expect(resolutionCase.status).toBe('open');

    const inventoryItems = (inventory.body as { items: Array<Record<string, unknown>> }).items;
    expect(inventoryItems).toEqual([
      expect.objectContaining({
        rollCode: fixture.rollCode,
        warehouseStatus: 'received',
        nextRoute: 'delivery',
      }),
    ]);
    expect(JSON.stringify(commands)).not.toContain(fixture.token);
    expect(JSON.stringify(auditEvents)).not.toContain(fixture.token);
    expect(JSON.stringify(auditEvents)).not.toContain('shift_balance_mismatch');

    const deliveryOperationKey = randomUUID();
    const delivery = await http()
      .post('/api/warehouse/pallets/delivery-scans')
      .set(warehouseAuth)
      .send({ operationKey: deliveryOperationKey, payload: fixture.token })
      .expect(200);
    const deliveryResult = delivery.body as WarehousePalletDeliveryScanResult;
    expect(deliveryResult).toEqual({
      operationKey: deliveryOperationKey,
      documentId: fixture.pallet.document!.id,
      palletId: fixture.pallet.id,
      palletCode: fixture.pallet.palletCode,
      orderId: fixture.order.id,
      deliveryTaskId: firstResult.deliveryTaskId,
      rollCount: 1,
      newlyDeliveredRollCount: 1,
      alreadyDeliveredRollCount: 0,
      remainingRollCount: 0,
      taskStatus: 'closed',
      deliveryClosed: true,
      replayed: false,
    });
    expect(JSON.stringify(deliveryResult)).not.toContain(fixture.token);

    const deliveryReplay = await http()
      .post('/api/warehouse/pallets/delivery-scans')
      .set(warehouseAuth)
      .send({ operationKey: deliveryOperationKey, payload: fixture.token })
      .expect(200);
    expect(deliveryReplay.body).toEqual({ ...deliveryResult, replayed: true });

    const afterCloseOperationKey = randomUUID();
    const afterClose = await http()
      .post('/api/warehouse/pallets/delivery-scans')
      .set(warehouseAuth)
      .send({ operationKey: afterCloseOperationKey, payload: fixture.token })
      .expect(200);
    expect(afterClose.body).toEqual({
      ...deliveryResult,
      operationKey: afterCloseOperationKey,
      newlyDeliveredRollCount: 0,
      alreadyDeliveredRollCount: 1,
    });

    await http()
      .post('/api/warehouse/pallets/delivery-scans')
      .set(commercialAuth)
      .send({ operationKey: randomUUID(), payload: fixture.token })
      .expect(403);

    const [
      closedTask,
      deliveredRoll,
      operatorLine,
      deliveryOperations,
      deliveryCommands,
      deliveryAuditEvents,
      closeAuditEvents,
      rollAuditEvents,
      shippedOrder,
      activatedSchedule,
      openProblem,
      openResolutionCase,
      deliveredInventory,
    ] = await Promise.all([
      prisma.warehouseAcceptanceTask.findUniqueOrThrow({
        where: { id: firstResult.deliveryTaskId },
        select: {
          status: true,
          rows: {
            select: { id: true, rollCode: true, scanStatus: true, lastScanAt: true },
          },
        },
      }),
      prisma.warehouseRoll.findUniqueOrThrow({
        where: { rollCode: fixture.rollCode },
        select: { warehouseStatus: true },
      }),
      prisma.operatorRollLine.findFirstOrThrow({
        where: { rollDispatchItem: { rollCode: fixture.rollCode } },
        select: { warehouseState: true },
      }),
      prisma.warehouseOperation.findMany({
        where: {
          taskId: firstResult.deliveryTaskId,
          rollCode: fixture.rollCode,
          kind: 'delivery_scan',
          status: 'succeeded',
        },
        select: {
          taskId: true,
          scanRowId: true,
          rollCode: true,
          kind: true,
          status: true,
          safeResult: true,
        },
      }),
      prisma.warehousePalletCommand.findMany({
        where: { operationKey: { in: [deliveryOperationKey, afterCloseOperationKey] } },
        orderBy: { createdAt: 'asc' },
        select: { kind: true, resultSnapshot: true },
      }),
      prisma.domainEvent.findMany({
        where: { type: 'audit:warehouse_pallet_delivery_scanned', objectId: fixture.pallet.id },
        orderBy: { createdAt: 'asc' },
        select: { detail: true },
      }),
      prisma.domainEvent.findMany({
        where: {
          type: 'audit:warehouse_acceptance_task_closed',
          objectId: firstResult.deliveryTaskId,
        },
        select: { detail: true },
      }),
      prisma.domainEvent.findMany({
        where: { type: 'audit:warehouse_roll_shipped', objectId: fixture.rollCode },
        select: { detail: true },
      }),
      prisma.commercialOrder.findUniqueOrThrow({
        where: { id: fixture.order.id },
        select: { shipmentStatus: true, shipmentCompletedAt: true },
      }),
      prisma.paymentSchedule.findUniqueOrThrow({
        where: { id: fixture.paymentSchedule.id },
        select: { startsAt: true, dueDate: true, status: true },
      }),
      prisma.productionProblem.findUniqueOrThrow({
        where: { id: fixture.problem.id },
        select: { status: true },
      }),
      prisma.orderResolutionCase.findUniqueOrThrow({
        where: { id: fixture.resolutionCase.id },
        select: { status: true },
      }),
      http()
        .get('/api/warehouse/inventory/rolls')
        .query({ q: fixture.rollCode, view: 'current', limit: 10 })
        .set(warehouseAuth)
        .expect(200),
    ]);

    expect(closedTask.status).toBe('closed');
    expect(closedTask.rows).toEqual([
      expect.objectContaining({
        rollCode: fixture.rollCode,
        scanStatus: 'accepted',
        lastScanAt: expect.any(Date),
      }),
    ]);
    expect(deliveredRoll.warehouseStatus).toBe('delivered');
    expect(operatorLine.warehouseState).toBe('delivered');
    expect(deliveryOperations).toEqual([
      expect.objectContaining({
        taskId: firstResult.deliveryTaskId,
        scanRowId: closedTask.rows[0]!.id,
        rollCode: fixture.rollCode,
        kind: 'delivery_scan',
        status: 'succeeded',
        safeResult: expect.objectContaining({ scanStatus: 'accepted' }),
      }),
    ]);
    expect(deliveryCommands).toHaveLength(2);
    expect(deliveryCommands.every((command) => command.kind === 'pallet_delivery_scan')).toBe(true);
    expect(deliveryAuditEvents).toHaveLength(2);
    expect(deliveryAuditEvents[0]).toEqual({
      detail: expect.objectContaining({
        deliveryTaskId: firstResult.deliveryTaskId,
        newlyDeliveredRollCount: 1,
        alreadyDeliveredRollCount: 0,
        remainingOpenProductionProblemCount: 1,
        deliveryClosed: true,
      }),
    });
    expect(deliveryAuditEvents[1]).toEqual({
      detail: expect.objectContaining({
        newlyDeliveredRollCount: 0,
        alreadyDeliveredRollCount: 1,
        remainingOpenProductionProblemCount: 1,
        deliveryClosed: true,
      }),
    });
    expect(closeAuditEvents).toHaveLength(1);
    expect(rollAuditEvents).toHaveLength(1);
    expect(shippedOrder).toEqual({
      shipmentStatus: 'shipped',
      shipmentCompletedAt: expect.any(Date),
    });
    expect(activatedSchedule).toEqual({
      startsAt: shippedOrder.shipmentCompletedAt,
      dueDate: expect.any(Date),
      status: 'unpaid',
    });
    expect(openProblem.status).toBe('open');
    expect(openResolutionCase.status).toBe('open');
    expect((deliveredInventory.body as { items: Array<Record<string, unknown>> }).items).toEqual([
      expect.objectContaining({
        rollCode: fixture.rollCode,
        lifecycleStatus: 'processed',
        lifecycleStatusLabel: 'Обработан',
        warehouseStatus: 'delivered',
        nextRoute: 'completed',
        processedAt: expect.any(String),
      }),
    ]);

    const boundedArtifacts = [
      deliveryOperations,
      deliveryCommands,
      deliveryAuditEvents,
      closeAuditEvents,
      rollAuditEvents,
    ];
    expect(JSON.stringify(boundedArtifacts)).not.toContain(fixture.token);
    expect(JSON.stringify(boundedArtifacts)).not.toContain('shift_balance_mismatch');
    expect(JSON.stringify(boundedArtifacts)).not.toContain('linked production problem');
  });
});
