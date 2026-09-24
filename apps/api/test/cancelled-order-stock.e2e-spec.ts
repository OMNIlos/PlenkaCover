import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RollTokenService } from '../src/common/roll-token/roll-token.service';
import { deliverWarehouseRoll } from '../src/modules/warehouse/warehouse-delivery-roll-transition';
import { WarehouseRollCoverageFactService } from '../src/modules/warehouse-coverage/warehouse-roll-coverage-fact.service';
import { PRIMARY_BASE_MATERIAL_SELECTION } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Cancelled production becomes company stock (PostgreSQL + Bearer)', () => {
  jest.setTimeout(120_000);
  let app: INestApplication;
  let prisma: PrismaService;
  let facts: WarehouseRollCoverageFactService;
  const headers: Record<string, Record<string, string>> = {};
  const http = () => request(app.getHttpServer());
  const previousFlag = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;

  beforeAll(async () => {
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    prisma = module.get(PrismaService);
    facts = module.get(WarehouseRollCoverageFactService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
    for (const role of ['commercial', 'finance', 'warehouse', 'operator'] as const) {
      const login = await http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(role), password: e2eSeedPassword() })
        .expect(201);
      headers[role] = { Authorization: `Bearer ${login.body.token}` };
    }
  });

  afterAll(async () => {
    await app?.close();
    if (previousFlag === undefined) delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    else process.env.WAREHOUSE_COVERAGE_V2_ENABLED = previousFlag;
  });

  it('keeps 10 made rolls out of 30, cancels 20, and offers/reserves all 10 for another customer', async () => {
    const suffix = randomUUID().slice(0, 8);
    const specification = {
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      ...PRIMARY_BASE_MATERIAL_SELECTION,
      widthMm: 1500,
      plannedLengthM: 300,
      spoolType: '76 мм',
      birka: `CANCEL-STOCK-${suffix}`,
      plannedWeightKg: 50,
    };
    const createOrder = async (rollCount: number) => {
      const counterparty = await prisma.counterparty.create({
        data: { displayName: randomUUID() },
      });
      const response = await http()
        .post('/api/commercial/orders')
        .set(headers.commercial)
        .send({
          clientRequestId: randomUUID(),
          mode: 'submit',
          requestType: 'client_order',
          counterpartyId: counterparty.id,
          positions: [{ ...specification, rollCount }],
        })
        .expect(201);
      await http()
        .post(`/api/commercial/orders/${response.body.id}/invoice-handoff`)
        .set(headers.commercial)
        .send({})
        .expect(201);
      return prisma.commercialOrder.findUniqueOrThrow({
        where: { id: response.body.id },
        include: { financeOrder: true, coverageState: true },
      });
    };
    const order = await createOrder(30);
    await http()
      .post(`/api/finance/orders/${order.financeOrder!.id}/invoices`)
      .set(headers.finance)
      .send({ amount: 125000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);
    await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(headers.commercial)
      .send({})
      .expect(201);
    const production = await prisma.productionOrder.findUniqueOrThrow({
      where: { commercialOrderId: order.id },
      include: { dispatchItems: true },
    });
    const operator = await prisma.user.findUniqueOrThrow({
      where: { login: e2eSeedLogin('operator') },
    });
    const rollIds: string[] = [];
    const originalFacts: string[] = [];
    for (const dispatch of production.dispatchItems.slice(0, 10)) {
      const warehouseState = rollIds.length === 9 ? 'sent' : 'received';
      await prisma.$transaction(async (tx) => {
        await tx.rollDispatchItem.update({
          where: { id: dispatch.id },
          data: { status: 'ready_for_warehouse', completedAt: new Date() },
        });
        const line = await tx.operatorRollLine.upsert({
          where: { rollDispatchItemId: dispatch.id },
          create: { rollDispatchItemId: dispatch.id, step: 'warehouse', warehouseState, netKg: 50 },
          update: { step: 'warehouse', warehouseState, netKg: 50 },
        });
        const capture = await tx.weightCapture.create({
          data: {
            operatorRollLineId: line.id,
            kind: 'roll',
            stable: true,
            grossKg: 52,
            spoolKg: 2,
            netKg: 50,
            deviceStatus: 'ready',
            actorRole: 'operator',
            actorId: operator.id,
          },
        });
        const roll = await tx.warehouseRoll.create({
          data: {
            rollCode: dispatch.rollCode,
            ownerCounterpartyId: order.counterpartyId,
            warehouseStatus: warehouseState,
            receivedAt: warehouseState === 'received' ? new Date() : null,
          },
        });
        const fact = await facts.appendProductionHandoverFact(tx, {
          rollId: roll.id,
          sourceDispatchItemId: dispatch.id,
          sourceWeightCaptureId: capture.id,
        });
        expect(fact).not.toBeNull();
        await tx.warehouseRoll.update({
          where: { id: roll.id },
          data: {
            producedForOrderId: order.id,
            producedForPositionId: dispatch.orderLineId,
            producedByCoverageDecisionId: production.sourceCoverageDecisionId,
          },
        });
        rollIds.push(roll.id);
        originalFacts.push(fact!.factId);
      });
    }
    const current = await prisma.commercialOrder.findUniqueOrThrow({ where: { id: order.id } });
    const command = {
      operationKey: randomUUID(),
      expectedVersion: current.version,
      reason: 'Клиент отменил заказ',
    };
    await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.operator)
      .send(command)
      .expect(403);
    const cancelled = await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(command)
      .expect(201);
    expect(cancelled.body).toMatchObject({
      completedRollCount: 10,
      remainingCancelledRollCount: 20,
    });
    const replay = await http()
      .post(`/api/commercial/orders/${order.id}/cancellations`)
      .set(headers.commercial)
      .send(command)
      .expect(201);
    expect(replay.body).toEqual(cancelled.body);
    const stock = await prisma.warehouseRoll.findMany({ where: { id: { in: rollIds } } });
    expect(stock).toHaveLength(10);
    expect(
      stock.every((roll) => roll.ownerCounterpartyId === null && roll.reservedForOrderId === null),
    ).toBe(true);
    expect(stock.every((roll) => roll.producedForOrderId === order.id)).toBe(true);
    expect(stock.every((roll) => roll.releasedFromOrderId === order.id)).toBe(true);
    expect(
      await prisma.warehouseRollCoverageFact.count({ where: { id: { in: originalFacts } } }),
    ).toBe(10);
    const listed = await http()
      .get('/api/warehouse/finished-stock')
      .query({ batch: order.orderNumber, limit: 100 })
      .set(headers.warehouse)
      .expect(200);
    expect(listed.body.summary.totalCount).toBe(9);
    const travellingCode = stock.find((roll) => roll.warehouseStatus === 'sent')!.rollCode;
    await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'receiving',
        status: 'open',
        orderId: order.id,
        rows: { create: { rollCode: travellingCode, fromOrderId: order.orderNumber } },
      },
    });
    const label = await app.get(RollTokenService).getOrCreate(travellingCode);
    await prisma.deviceRuntime.update({
      where: { id: 'dev-scanner-1' },
      data: { status: 'ready', isEnabled: true },
    });
    await http()
      .post('/api/warehouse/intake/scans')
      .set(headers.warehouse)
      .send({ operationKey: randomUUID(), payload: label.token })
      .expect(201);
    const received = await http()
      .get('/api/warehouse/finished-stock')
      .query({ batch: order.orderNumber, limit: 100 })
      .set(headers.warehouse)
      .expect(200);
    expect(received.body.summary.totalCount).toBe(10);
    const business = await http()
      .get('/api/commercial/performance/warehouse')
      .set(headers.commercial)
      .expect(200);
    expect(business.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: order.id, kind: 'reserve', status: 'reserve' }),
      ]),
    );
    expect(
      await prisma.warehouseAcceptanceTask.count({
        where: { orderId: order.id, mode: 'delivery', status: { not: 'cancelled' } },
      }),
    ).toBe(0);
    await expect(
      prisma.$transaction((tx) =>
        deliverWarehouseRoll(
          tx,
          { mode: 'delivery', orderId: order.id, positionId: null },
          stock[0].rollCode,
        ),
      ),
    ).rejects.toThrow();
    const next = await createOrder(10);
    const available = await http()
      .get(`/api/finance/orders/${next.financeOrder!.id}/warehouse-coverage`)
      .set(headers.finance)
      .expect(200);
    expect(available.body).toMatchObject({ availability: 'verified_full', matchedRollCount: 10 });
    const coverage = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: next.id },
      include: { currentCalculation: true },
    });
    await http()
      .post(`/api/finance/orders/${next.financeOrder!.id}/warehouse-coverage/decide`)
      .set(headers.finance)
      .send({
        clientRequestId: randomUUID(),
        decision: 'use_warehouse',
        expectedGeneration: coverage.generation,
        expectedStateVersion: coverage.stateVersion,
      })
      .expect(200);
    expect(
      await prisma.warehouseRoll.count({
        where: { id: { in: rollIds }, reservedForOrderId: next.id },
      }),
    ).toBe(10);
    await http().delete(`/api/commercial/orders/${order.id}`).set(headers.commercial).expect(409);
    expect(await prisma.warehouseRoll.count({ where: { id: { in: rollIds } } })).toBe(10);
    const reserveTask = await prisma.warehouseAcceptanceTask.findFirstOrThrow({
      where: { orderId: next.id, mode: 'reserve' },
      include: { rows: true },
    });
    const physicalScan = await prisma.scanRow.update({
      where: { id: reserveTask.rows[0].id },
      data: { scanStatus: 'accepted', lastScanAt: new Date(), scannedByName: 'Склад' },
    });
    const nextVersion = await prisma.commercialOrder.findUniqueOrThrow({ where: { id: next.id } });
    await http()
      .post(`/api/commercial/orders/${next.id}/cancellations`)
      .set(headers.commercial)
      .send({
        operationKey: randomUUID(),
        expectedVersion: nextVersion.version,
        reason: 'Повторная отмена клиента',
      })
      .expect(201);
    expect(
      await prisma.warehouseRoll.count({
        where: { id: { in: rollIds }, reservedForOrderId: null },
      }),
    ).toBe(10);
    expect(await prisma.scanRow.findUnique({ where: { id: physicalScan.id } })).toEqual(
      physicalScan,
    );
    await expect(
      prisma.warehouseRoll.update({
        where: { id: rollIds[0] },
        data: { releasedFromOrderId: null },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.domainEvent.count({
        where: {
          type: 'audit:finished_stock_released_from_cancelled_order',
          objectId: { in: rollIds },
        },
      }),
    ).toBe(10);
  });
});
