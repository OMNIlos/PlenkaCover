import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import {
  attachAvailableBagToOperatorShift,
  createAvailableBigBagFixture,
  createAssignedOperatorShiftFixture,
} from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';
import { sealAndPrintCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

type Bearer = { Authorization: string };

type CreatedOrder = {
  id: string;
  orderNumber: string;
  positions: Array<{ id: string; version: number }>;
};

type CoverFixture = {
  id: string;
  version: number;
  rollIds: string[];
};

const POSITION = {
  filmType: 'Рукав',
  actualThickness: '80 мкм',
  accountingThickness: '78 мкм',
  ...PRIMARY_BASE_MATERIAL_SELECTION,
  ...STANDARD_ROLL_DIMENSIONS,
  spoolType: 'Шпуля 76 мм',
  birka: 'Прозрачная',
  plannedWeightKg: 41.2,
  recipeParameters: [
    { label: 'Сырьё', value: 'ПВД 15803-020' },
    { label: 'План. вес, кг', value: '41.2' },
  ],
} as const;

describe('Commercial workspace acceptance (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let previousDevRole: string | undefined;
  const previousDeviceEnv: Record<string, string | undefined> = {};
  const DEVICE_ENV = {
    DEVICE_GATEWAY_SCALE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
  } as const;
  let auth: Record<
    'commercial' | 'production' | 'finance' | 'warehouse' | 'operator' | 'director',
    Bearer
  >;
  let operatorId: string;
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;
  const suiteId = `${Date.now()}-${process.pid}`;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    for (const [name, value] of Object.entries(DEVICE_ENV)) {
      previousDeviceEnv[name] = process.env[name];
      process.env[name] = value;
    }
    // Import after the auth flag is fixed: the suite must never fall back to x-role.
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

    const password = e2eSeedPassword();
    const sessions = await Promise.all(
      (['commercial', 'production', 'finance', 'warehouse', 'operator', 'director'] as const).map(
        (account) =>
          http()
            .post('/api/auth/login')
            .send({ login: e2eSeedLogin(account), password })
            .expect(201),
      ),
    );
    auth = {
      commercial: { Authorization: `Bearer ${sessions[0].body.token as string}` },
      production: { Authorization: `Bearer ${sessions[1].body.token as string}` },
      finance: { Authorization: `Bearer ${sessions[2].body.token as string}` },
      warehouse: { Authorization: `Bearer ${sessions[3].body.token as string}` },
      operator: { Authorization: `Bearer ${sessions[4].body.token as string}` },
      director: { Authorization: `Bearer ${sessions[5].body.token as string}` },
    };
    operatorId = sessions[4].body.user.id as string;
  });

  afterAll(async () => {
    await restoreSimulatedDevices?.();
    await app?.close();
    if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevRole;
    for (const name of Object.keys(DEVICE_ENV)) {
      const value = previousDeviceEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function createCounterparty(label: string) {
    const response = await http()
      .post('/api/commercial/counterparties')
      .set(auth.commercial)
      .send({
        displayName: `Acceptance ${label} ${suiteId}`,
        legalName: `ООО ACCEPTANCE-SECRET ${label} ${suiteId}`,
        inn: `${Date.now()}${Math.floor(Math.random() * 10_000)}`.slice(0, 20),
      })
      .expect(201);
    return response.body as { id: string };
  }

  async function createOrder(
    label: string,
    rollCount: number,
    options: { mode?: 'draft' | 'submit'; clientRequestId?: string } = {},
  ) {
    const counterparty = await createCounterparty(label);
    const response = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: options.clientRequestId ?? randomUUID(),
        mode: options.mode ?? 'submit',
        title: `Acceptance ${label}`,
        counterpartyId: counterparty.id,
        requestType: 'client_order',
        positions: [{ ...POSITION, rollCount }],
      })
      .expect(201);
    return response.body as CreatedOrder;
  }

  async function createTwoPositionOrder(label: string) {
    const counterparty = await createCounterparty(label);
    const response = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        title: `Acceptance ${label}`,
        counterpartyId: counterparty.id,
        requestType: 'client_order',
        positions: [
          { ...POSITION, rollCount: 1 },
          {
            ...POSITION,
            filmType: 'Полотно',
            actualThickness: '100 мкм',
            accountingThickness: '100 мкм',
            plannedWeightKg: 38.4,
            recipeParameters: [
              { label: 'Сырьё', value: 'ПВД 10803-020' },
              { label: 'План. вес, кг', value: '38.4' },
            ],
            rollCount: 1,
          },
        ],
      })
      .expect(201);
    return response.body as CreatedOrder;
  }

  async function createCoverFixture(
    order: CreatedOrder,
    matchCount: number,
    sharedRollId?: string,
    positionIndex = 0,
  ): Promise<CoverFixture> {
    const position = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: order.positions[positionIndex]!.id },
    });
    const rollIds: string[] = [];
    for (let index = 0; index < matchCount; index += 1) {
      if (sharedRollId) {
        rollIds.push(sharedRollId);
        continue;
      }
      const roll = await prisma.warehouseRoll.create({
        data: {
          rollCode: `STK-${suiteId}-${randomUUID()}`,
          warehouseStatus: 'received',
          positionSnapshot: {
            filmType: position.filmType,
            actualThickness: position.actualThickness,
            birka: position.birka,
            spoolType: position.spoolType,
            plannedWeightKg: position.plannedWeightKg,
          },
        },
      });
      await prisma.rollScanToken.create({ data: { rollCode: roll.rollCode } });
      rollIds.push(roll.id);
    }
    const full = matchCount === position.rollCount;
    const proposal = await prisma.warehouseCoverProposal.create({
      data: {
        orderId: order.id,
        positionId: position.id,
        coverType: full ? 'full' : 'partial',
        coverQty: matchCount,
        reserveQty: 0,
        productionQty: position.rollCount - matchCount,
        status: full ? 'full_proposed' : 'partial_proposed',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        matches: {
          create: rollIds.map((rollId) => ({
            rollId,
            compatible: true,
            criteria: {
              filmType: {
                expected: position.filmType,
                actual: position.filmType,
                matches: true,
              },
              actualThickness: {
                expected: position.actualThickness,
                actual: position.actualThickness,
                matches: true,
              },
              birka: { expected: position.birka, actual: position.birka, matches: true },
              spoolType: {
                expected: position.spoolType,
                actual: position.spoolType,
                matches: true,
              },
              weight: {
                expected: Number(position.plannedWeightKg),
                actual: Number(position.plannedWeightKg),
                matches: true,
              },
            } as Prisma.InputJsonValue,
          })),
        },
      },
    });
    return { id: proposal.id, version: proposal.version, rollIds };
  }

  async function scanToken(rollCode: string) {
    const label = await prisma.rollScanToken.findUniqueOrThrow({
      where: { rollCode },
      select: { token: true },
    });
    return label.token;
  }

  async function createProductionOnlyCover(order: CreatedOrder, positionIndex = 0) {
    const proposal = await createCoverFixture(order, 0, undefined, positionIndex);
    const response = await http()
      .post(
        `/api/commercial/orders/${order.id}/positions/${order.positions[positionIndex]!.id}/warehouse-cover/${proposal.id}/commercial-approval`,
      )
      .set(auth.commercial)
      .send({ expectedVersion: proposal.version, route: 'production_only' })
      .expect(201);
    expect(response.body).toEqual(
      expect.objectContaining({ route: 'production_only', status: 'needs_production' }),
    );
    return response.body as { version: number };
  }

  async function finalizeCover(
    order: CreatedOrder,
    proposal: CoverFixture,
    route: 'partial_cover' | 'full_cover',
  ) {
    const commercial = await http()
      .post(
        `/api/commercial/orders/${order.id}/positions/${order.positions[0]!.id}/warehouse-cover/${proposal.id}/commercial-approval`,
      )
      .set(auth.commercial)
      .send({ expectedVersion: proposal.version, route })
      .expect(201);
    return http()
      .post(
        `/api/commercial/orders/${order.id}/positions/${order.positions[0]!.id}/warehouse-cover/${proposal.id}/technical-approval`,
      )
      .set(auth.production)
      .send({ expectedVersion: commercial.body.version as number })
      .expect(201);
  }

  async function enableFinanceHandoff(orderId: string, amount = 100_000) {
    await http()
      .post(`/api/commercial/orders/${orderId}/invoice-handoff`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    const list = await http().get('/api/finance/orders').set(auth.finance).expect(200);
    const financeOrder = (
      list.body as Array<{ id: string; commercialOrder?: { id: string } }>
    ).find((candidate) => candidate.commercialOrder?.id === orderId);
    expect(financeOrder).toBeTruthy();
    await http()
      .post(`/api/finance/orders/${financeOrder!.id}/invoices`)
      .set(auth.finance)
      .send({ amount, paymentTermsType: 'postpay_100_30d' })
      .expect(201);
    return financeOrder!.id;
  }

  async function eventCount(orderId: string, type: string) {
    return prisma.domainEvent.count({ where: { objectId: orderId, type } });
  }

  it('runs draft edit promote finance and production handoff with Bearer auth', async () => {
    const order = await createOrder('draft-flow', 1, { mode: 'draft' });
    const positionId = order.positions[0]!.id;

    const patched = await http()
      .patch(`/api/commercial/orders/${order.id}/positions/${positionId}`)
      .set(auth.commercial)
      .send({ expectedVersion: 1, rollCount: 2, comment: 'Уточнено клиентом' })
      .expect(200);
    expect(patched.body.positions[0]).toEqual(
      expect.objectContaining({ rollCount: 2, version: 2 }),
    );

    const promoted = await http()
      .post(`/api/commercial/orders/${order.id}/promote-draft`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(promoted.body).toEqual(expect.objectContaining({ commercialStage: 'incoming' }));
    expect(promoted.body.orderNumber).toMatch(/^A-/);

    await createProductionOnlyCover({ ...order, positions: [{ id: positionId, version: 2 }] });
    await enableFinanceHandoff(order.id);
    const production = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(production.body.dispatchItems).toHaveLength(2);

    const repeat = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(repeat.body.id).toBe(production.body.id);

    const persisted = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { positions: true, productionOrder: { include: { dispatchItems: true } } },
    });
    expect(persisted.positions[0]).toEqual(expect.objectContaining({ rollCount: 2, version: 2 }));
    expect(persisted.productionOrder?.dispatchItems).toHaveLength(2);
    await expect(eventCount(order.id, 'audit:commercial_draft_promoted')).resolves.toBe(1);
    await expect(eventCount(order.id, 'audit:invoice_handoff_created')).resolves.toBe(1);
    await expect(
      eventCount(production.body.id as string, 'audit:production_order_created'),
    ).resolves.toBe(1);
  });

  it('persists ordinary and explicit-delegation production-lead creator flows', async () => {
    const counterparties = await http()
      .get('/api/commercial/counterparties')
      .set(auth.production)
      .expect(200);
    const counterpartyId = (counterparties.body as Array<{ id: string }>)[0]?.id;
    expect(counterpartyId).toEqual(expect.any(String));
    const ordinaryRequestId = randomUUID();
    const ordinary = await http()
      .post('/api/commercial/orders')
      .set(auth.production)
      .send({
        clientRequestId: ordinaryRequestId,
        mode: 'submit',
        title: `Production creator acceptance ${suiteId}`,
        counterpartyId,
        requestType: 'client_order',
        positions: [{ ...POSITION, rollCount: 1 }],
      })
      .expect(201);
    const ordinaryPersisted = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: ordinary.body.id as string },
    });
    expect(ordinaryPersisted).toEqual(
      expect.objectContaining({
        clientRequestId: ordinaryRequestId,
        commercialConfirmationPolicy: 'required',
        commercialStage: 'incoming',
        creatorRole: 'production_lead',
        delegationMarker: false,
        recipeOwnerRole: 'commercial',
      }),
    );
    const ordinaryReconciled = await http()
      .get(`/api/commercial/orders/${ordinary.body.id as string}`)
      .set(auth.production)
      .expect(200);
    expect(ordinaryReconciled.body).toEqual(
      expect.objectContaining({
        id: ordinary.body.id,
        bucket: 'incoming',
        creatorRole: 'production_lead',
      }),
    );
    await expect(
      eventCount(
        ordinary.body.id as string,
        'audit:production_request_created_on_behalf_of_commercial',
      ),
    ).resolves.toBe(0);

    const clientRequestId = randomUUID();
    const payload = {
      clientRequestId,
      mode: 'submit',
      title: `Delegated acceptance ${suiteId}`,
      counterpartyId,
      requestType: 'client_order',
      onBehalfOfCommercial: true,
      positions: [{ ...POSITION, rollCount: 1 }],
    };

    const created = await http()
      .post('/api/commercial/orders')
      .set(auth.production)
      .send(payload)
      .expect(201);
    const replay = await http()
      .post('/api/commercial/orders')
      .set(auth.production)
      .send(payload)
      .expect(201);

    expect(replay.body.id).toBe(created.body.id);
    const persisted = await prisma.commercialOrder.findUniqueOrThrow({
      where: { id: created.body.id as string },
      include: { productionOrder: true },
    });
    expect(persisted).toEqual(
      expect.objectContaining({
        clientRequestId,
        commercialConfirmationPolicy: 'bypassed_by_delegation',
        commercialStage: 'incoming',
        creatorRole: 'production_lead',
        delegationMarker: true,
        recipeOwnerRole: 'commercial',
        productionOrder: null,
      }),
    );
    await expect(
      eventCount(
        created.body.id as string,
        'audit:production_request_created_on_behalf_of_commercial',
      ),
    ).resolves.toBe(1);
    await expect(
      eventCount(created.body.id as string, 'audit:commercial_recipe_snapshot_set'),
    ).resolves.toBe(1);

    await http()
      .post('/api/commercial/orders')
      .set(auth.production)
      .send({ ...payload, onBehalfOfCommercial: false })
      .expect(409);
  });

  it('completes a two-position order through one intake, pallet and delivery across roles', async () => {
    const order = await createTwoPositionOrder('two-position-delivery');
    expect(order.positions).toHaveLength(2);
    await createProductionOnlyCover(order, 0);
    await createProductionOnlyCover(order, 1);
    await enableFinanceHandoff(order.id);

    const production = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    const dispatchItems = (
      production.body.dispatchItems as Array<{
        id: string;
        rollCode: string;
        orderLineId: string;
        positionSequence: number;
      }>
    ).sort((left, right) => left.positionSequence - right.positionSequence);
    expect(dispatchItems).toHaveLength(2);
    expect(dispatchItems.map(({ orderLineId }) => orderLineId)).toEqual(
      order.positions.map(({ id }) => id),
    );

    await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `Two-position delivery shift ${suiteId}`,
    });
    for (const item of dispatchItems) {
      await http()
        .post(`/api/production/roll-dispatch/${item.rollCode}/assign`)
        .set(auth.production)
        .send({ operatorId })
        .expect(201);
    }
    await http()
      .post(`/api/production/orders/${production.body.id as string}/approve`)
      .set(auth.production)
      .expect(201);
    await http()
      .post('/api/operator/post-sessions')
      .set(auth.operator)
      .send({ postCode: 'POST-1' })
      .expect(201);
    const bigBagId = await createAvailableBigBagFixture(prisma, {
      code: `TWO-POSITION-BAG-${suiteId}`,
    });
    await attachAvailableBagToOperatorShift(app, prisma, auth.operator, 'POST-1', bigBagId);
    const restoreDevices = await enableSimulatedDevices(prisma, ['dev-scale-1', 'dev-printer-1']);

    try {
      for (const item of dispatchItems) {
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/accept`)
          .set(auth.operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/spool-weight`)
          .set(auth.operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/roll-weight`)
          .set(auth.operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/qr-print`)
          .set(auth.operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
        const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
          where: { rollCode: item.rollCode },
          select: { token: true },
        });
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/qr-verify`)
          .set(auth.operator)
          .send({ operationKey: randomUUID(), payload: printEvidence.token })
          .expect(201);
        await http()
          .post(`/api/operator/rolls/${item.rollCode}/handover`)
          .set(auth.operator)
          .send({ operationKey: randomUUID() })
          .expect(201);
      }

      const intake = await prisma.warehouseAcceptanceTask.findUniqueOrThrow({
        where: { receivingScopeKey: `commercial-order:${order.id}` },
        include: { rows: { orderBy: { rollCode: 'asc' } } },
      });
      expect(intake.rows).toHaveLength(2);
      expect(intake.rows.map(({ rollCode }) => rollCode).sort()).toEqual(
        dispatchItems.map(({ rollCode }) => rollCode).sort(),
      );
      for (const item of dispatchItems) {
        await http()
          .post(`/api/warehouse/tasks/${intake.id}/scans`)
          .set(auth.warehouse)
          .send({ operationKey: randomUUID(), payload: await scanToken(item.rollCode) })
          .expect(201);
      }
      await sealAndPrintCurrentPalletFixture(app, auth.warehouse, intake.id, {
        expectedRollCount: 2,
      });
      await http()
        .post(`/api/warehouse/tasks/${intake.id}/close`)
        .set(auth.warehouse)
        .send({ mode: 'full' })
        .expect(201);

      const delivery = await prisma.warehouseAcceptanceTask.findUniqueOrThrow({
        where: { deliveryScopeKey: `warehouse_delivery:${order.id}` },
        include: { rows: { orderBy: { rollCode: 'asc' } } },
      });
      expect(delivery.rows).toHaveLength(2);
      const currentInventory = await http()
        .get('/api/warehouse/inventory/rolls?view=current&limit=100')
        .set(auth.warehouse)
        .expect(200);
      const currentRows = (
        currentInventory.body.items as Array<{
          rollCode: string;
          nextRoute: string;
          positionId: string | null;
        }>
      ).filter(({ rollCode }) => dispatchItems.some((item) => item.rollCode === rollCode));
      expect(currentRows).toHaveLength(2);
      expect(currentRows).toEqual(
        expect.arrayContaining(
          order.positions.map(({ id }) =>
            expect.objectContaining({ positionId: id, nextRoute: 'delivery' }),
          ),
        ),
      );

      for (const row of delivery.rows) {
        await http()
          .post(`/api/warehouse/tasks/${delivery.id}/scans`)
          .set(auth.warehouse)
          .send({ operationKey: randomUUID(), payload: await scanToken(row.rollCode) })
          .expect(201);
      }
      await http()
        .post(`/api/warehouse/tasks/${delivery.id}/close`)
        .set(auth.warehouse)
        .send({ mode: 'full' })
        .expect(201);

      const refreshedInventory = await http()
        .get('/api/warehouse/inventory/rolls?view=current&limit=100')
        .set(auth.warehouse)
        .expect(200);
      const deliveredInventoryRows = (
        refreshedInventory.body.items as Array<{
          lifecycleStatus: string;
          nextRoute: string;
          processedAt: string | null;
          rollCode: string;
          warehouseStatus: string;
        }>
      ).filter(({ rollCode }) => dispatchItems.some((item) => item.rollCode === rollCode));
      expect(deliveredInventoryRows).toHaveLength(2);
      expect(deliveredInventoryRows).toEqual(
        expect.arrayContaining(
          dispatchItems.map(({ rollCode }) =>
            expect.objectContaining({
              lifecycleStatus: 'delivered',
              nextRoute: 'completed',
              processedAt: null,
              rollCode,
              warehouseStatus: 'delivered',
            }),
          ),
        ),
      );
      const commercial = await http()
        .get(`/api/commercial/orders/${order.id}`)
        .set(auth.commercial)
        .expect(200);
      expect(commercial.body.indicators).toEqual(expect.objectContaining({ shipment: 'shipped' }));
      const director = await http().get('/api/director/production').set(auth.director).expect(200);
      const directorOrder = (
        director.body as Array<{
          id: string;
          commercialOrder: { orderNumber: string };
          rollCount: number;
        }>
      ).find(({ commercialOrder }) => commercialOrder.orderNumber === order.orderNumber);
      expect(directorOrder).toEqual(expect.objectContaining({ rollCount: 2 }));
      const directorDetail = await http()
        .get(`/api/director/production/${directorOrder!.id}`)
        .set(auth.director)
        .expect(200);
      expect(directorDetail.body.dispatchItems).toEqual(
        expect.arrayContaining(
          dispatchItems.map(({ rollCode }) =>
            expect.objectContaining({ rollCode, status: 'done' }),
          ),
        ),
      );
      await expect(
        prisma.domainEvent.count({
          where: {
            type: 'audit:warehouse_roll_shipped',
            objectId: { in: dispatchItems.map(({ rollCode }) => rollCode) },
          },
        }),
      ).resolves.toBe(2);
      await expect(
        prisma.warehouseAcceptanceTask.count({
          where: { orderId: order.id, mode: 'receiving' },
        }),
      ).resolves.toBe(1);
    } finally {
      await restoreDevices();
    }
  });

  it('reserves partial cover and produces only the missing rolls', async () => {
    const order = await createOrder('partial-cover', 3);
    const proposal = await createCoverFixture(order, 1);
    const finalized = await finalizeCover(order, proposal, 'partial_cover');
    expect(finalized.body).toEqual(
      expect.objectContaining({
        status: 'partial_confirmed',
        coverQty: 1,
        productionQty: 2,
        technicalApproved: true,
      }),
    );

    await enableFinanceHandoff(order.id);
    const production = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(production.body.dispatchItems).toHaveLength(2);

    const [roll, task, dispatchItems] = await Promise.all([
      prisma.warehouseRoll.findUniqueOrThrow({ where: { id: proposal.rollIds[0]! } }),
      prisma.warehouseAcceptanceTask.findFirst({
        where: { proposalId: proposal.id },
        include: { rows: true },
      }),
      prisma.rollDispatchItem.findMany({
        where: { productionOrder: { commercialOrderId: order.id } },
        orderBy: { positionSequence: 'asc' },
      }),
    ]);
    expect(roll).toEqual(
      expect.objectContaining({
        reservedForOrderId: order.id,
        reservedForPositionId: order.positions[0]!.id,
        reservedByProposalId: proposal.id,
      }),
    );
    expect(task?.rows).toHaveLength(1);
    expect(dispatchItems.map((item) => item.positionSequence)).toEqual([2, 3]);

    await http()
      .post(`/api/warehouse/tasks/${task!.id}/scans`)
      .set(auth.warehouse)
      .send({ operationKey: randomUUID(), payload: await scanToken(roll.rollCode) })
      .expect(201);
    await http()
      .post(`/api/warehouse/tasks/${task!.id}/close`)
      .set(auth.warehouse)
      .send({ mode: 'full' })
      .expect(201);
    await expect(
      prisma.warehouseAcceptanceTask.count({
        where: { deliveryScopeKey: `warehouse_delivery:${order.id}` },
      }),
    ).resolves.toBe(0);

    const operatorShift = await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `Commercial workspace operator shift ${suiteId}`,
    });

    for (const item of dispatchItems) {
      const assignedRoll = await http()
        .post(`/api/production/roll-dispatch/${item.rollCode}/assign`)
        .set(auth.production)
        .send({ operatorId })
        .expect(201);
      expect(assignedRoll.body).toMatchObject({
        assignedOperatorId: operatorId,
        plannedShiftId: operatorShift.shiftId,
        postId: operatorShift.post.id,
        machineId: operatorShift.post.code,
        workplaceId: operatorShift.post.id,
      });
    }
    await http()
      .post(`/api/production/orders/${production.body.id as string}/approve`)
      .set(auth.production)
      .expect(201);
    await http()
      .post('/api/operator/post-sessions')
      .set(auth.operator)
      .send({ postCode: 'POST-1' })
      .expect(201);
    const bigBagId = await createAvailableBigBagFixture(prisma, {
      code: `COMMERCIAL-WORKSPACE-BAG-${suiteId}`,
    });
    await attachAvailableBagToOperatorShift(app, prisma, auth.operator, 'POST-1', bigBagId);
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);

    for (const [index, item] of dispatchItems.entries()) {
      await http()
        .post(`/api/operator/rolls/${item.rollCode}/accept`)
        .set(auth.operator)
        .send({ operationKey: randomUUID() })
        .expect(201);
      await http()
        .post(`/api/operator/rolls/${item.rollCode}/spool-weight`)
        .set(auth.operator)
        .send({ operationKey: randomUUID() })
        .expect(201);
      await http()
        .post(`/api/operator/rolls/${item.rollCode}/roll-weight`)
        .set(auth.operator)
        .send({ operationKey: randomUUID() })
        .expect(201);
      await http()
        .post(`/api/operator/rolls/${item.rollCode}/qr-print`)
        .set(auth.operator)
        .send({ operationKey: randomUUID() })
        .expect(201);
      const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
        where: { rollCode: item.rollCode },
        select: { token: true },
      });
      await http()
        .post(`/api/operator/rolls/${item.rollCode}/qr-verify`)
        .set(auth.operator)
        .send({ operationKey: randomUUID(), payload: printEvidence.token })
        .expect(201);
      const handedOver = await http()
        .post(`/api/operator/rolls/${item.rollCode}/handover`)
        .set(auth.operator)
        .send({ operationKey: randomUUID() })
        .expect(201);
      if (index === 0) {
        const earlyClose = await http()
          .post(`/api/warehouse/tasks/${handedOver.body.id as string}/close`)
          .set(auth.warehouse)
          .send({ mode: 'full' })
          .expect(409);
        expect(earlyClose.body).toEqual(
          expect.objectContaining({
            code: 'WAREHOUSE_ORDER_INTAKE_INCOMPLETE',
            missingRollCount: 1,
            missingRollCodes: [dispatchItems[1]!.rollCode],
          }),
        );
      }
    }

    const warehouseTasks = await http().get('/api/warehouse/tasks').set(auth.warehouse).expect(200);
    const productionTask = (
      warehouseTasks.body as Array<{
        id: string;
        rows: Array<{ rollCode: string }>;
      }>
    ).find((candidate) =>
      dispatchItems.every((item) =>
        candidate.rows.some((rowItem) => rowItem.rollCode === item.rollCode),
      ),
    );
    expect(productionTask).toBeTruthy();
    for (const item of dispatchItems) {
      await http()
        .post(`/api/warehouse/tasks/${productionTask!.id}/scans`)
        .set(auth.warehouse)
        .send({ operationKey: randomUUID(), payload: await scanToken(item.rollCode) })
        .expect(201);
    }
    await sealAndPrintCurrentPalletFixture(app, auth.warehouse, productionTask!.id, {
      expectedRollCount: dispatchItems.length,
    });
    await http()
      .post(`/api/warehouse/tasks/${productionTask!.id}/close`)
      .set(auth.warehouse)
      .send({ mode: 'full' })
      .expect(201);
    await expect(
      prisma.warehouseAcceptanceTask.count({
        where: { deliveryScopeKey: `warehouse_delivery:${order.id}` },
      }),
    ).resolves.toBe(1);

    const completedDetail = await http()
      .get(`/api/commercial/orders/${order.id}`)
      .set(auth.commercial)
      .expect(200);
    expect(completedDetail.body).toEqual(
      expect.objectContaining({
        bucket: 'completed',
        commercialCompletion: expect.objectContaining({
          state: 'ready_for_shipment',
          fulfilledQty: 3,
          requestedQty: 3,
          blockingReasons: [],
        }),
      }),
    );
    const completedQueue = await http()
      .get('/api/commercial/orders?bucket=completed&mode=current&limit=100')
      .set(auth.commercial)
      .expect(200);
    expect(completedQueue.body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: order.id })]),
    );
    await expect(eventCount(order.id, 'audit:warehouse_cover_technical_approved')).resolves.toBe(1);
    await expect(eventCount(order.id, 'audit:warehouse_rolls_reserved_for_order')).resolves.toBe(1);
    await expect(
      eventCount(production.body.id as string, 'audit:production_order_created'),
    ).resolves.toBe(1);
  });

  it('completes full cover without a production order', async () => {
    const order = await createOrder('full-cover', 2);
    const proposal = await createCoverFixture(order, 2);
    const finalized = await finalizeCover(order, proposal, 'full_cover');
    expect(finalized.body).toEqual(
      expect.objectContaining({
        status: 'full_confirmed',
        coverQty: 2,
        productionQty: 0,
      }),
    );

    await enableFinanceHandoff(order.id);
    const handoff = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(handoff.body).toEqual(
      expect.objectContaining({
        commercialOrderId: order.id,
        productionRequired: false,
        productionOrderId: null,
        rollCount: 0,
      }),
    );

    const [productionOrder, reservedRolls, reserveTask] = await Promise.all([
      prisma.productionOrder.findUnique({ where: { commercialOrderId: order.id } }),
      prisma.warehouseRoll.count({
        where: { reservedForOrderId: order.id, reservedByProposalId: proposal.id },
      }),
      prisma.warehouseAcceptanceTask.findFirstOrThrow({
        where: { proposalId: proposal.id, mode: 'reserve' },
        include: { rows: true },
      }),
    ]);
    expect(productionOrder).toBeNull();
    expect(reservedRolls).toBe(2);
    expect(reserveTask.rows).toHaveLength(2);

    for (const row of reserveTask.rows) {
      await http()
        .post(`/api/warehouse/tasks/${reserveTask.id}/scans`)
        .set(auth.warehouse)
        .send({ operationKey: randomUUID(), payload: await scanToken(row.rollCode) })
        .expect(201);
    }
    await http()
      .post(`/api/warehouse/tasks/${reserveTask.id}/close`)
      .set(auth.warehouse)
      .send({ mode: 'full' })
      .expect(201);

    const deliveryTask = await prisma.warehouseAcceptanceTask.findUniqueOrThrow({
      where: { deliveryScopeKey: `warehouse_delivery:${order.id}` },
      include: { rows: true },
    });
    expect(deliveryTask).toEqual(
      expect.objectContaining({
        mode: 'delivery',
        status: 'open',
        orderId: order.id,
        operationCode: `ВЫ-${order.orderNumber}`,
      }),
    );
    expect(
      deliveryTask.rows
        .map((row) => ({ rollCode: row.rollCode, scanStatus: row.scanStatus }))
        .sort((left, right) => left.rollCode.localeCompare(right.rollCode)),
    ).toEqual(
      reserveTask.rows
        .map((row) => ({ rollCode: row.rollCode, scanStatus: 'expected' }))
        .sort((left, right) => left.rollCode.localeCompare(right.rollCode)),
    );
    expect(deliveryTask.rows).toHaveLength(2);
    await expect(eventCount(order.id, 'audit:warehouse_cover_technical_approved')).resolves.toBe(1);
    await expect(eventCount(order.id, 'audit:production_order_created')).resolves.toBe(0);
  });

  it('applies an audited shortage correction only to future rolls', async () => {
    const order = await createOrder('shortage-correction', 3);
    await createProductionOnlyCover(order);
    await enableFinanceHandoff(order.id);
    const production = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    const rolls = (
      production.body.dispatchItems as Array<{
        id: string;
        rollCode: string;
        positionSequence: number;
      }>
    ).sort((left, right) => left.positionSequence - right.positionSequence);
    expect(rolls).toHaveLength(3);

    await prisma.rollDispatchItem.update({
      where: { id: rolls[0]!.id },
      data: { status: 'done', completedAt: new Date() },
    });
    const problem = await http()
      .post(`/api/production/orders/${production.body.id as string}/problems`)
      .set(auth.production)
      .send({
        positionId: order.positions[0]!.id,
        rollId: rolls[0]!.id,
        reason: 'Исходное сырьё закончилось',
        recovery: 'Закончить текущий рулон и применить согласованную замену',
      })
      .expect(201);
    expect(problem.body).toEqual(
      expect.objectContaining({
        orderId: order.id,
        positionId: order.positions[0]!.id,
        rollId: rolls[0]!.id,
      }),
    );
    const newParameters = [
      { label: 'Сырьё', value: 'ПВД 10803-020' },
      { label: 'План. вес, кг', value: '41.2' },
    ];
    const corrected = await http()
      .post(`/api/commercial/orders/${order.id}/problems/${problem.body.id as string}/correction`)
      .set(auth.commercial)
      .send({
        positionId: order.positions[0]!.id,
        fromRollId: rolls[1]!.rollCode,
        expectedRecipeVersion: 'v1',
        currentRollResolution: 'finish_old_version',
        newParameters,
        reason: 'Клиент согласовал безопасную замену сырья',
      })
      .expect(201);
    expect(corrected.body).toEqual(
      expect.objectContaining({
        problemId: problem.body.id,
        recipeVersion: 'v2',
        affectedRollIds: [rolls[1]!.rollCode, rolls[2]!.rollCode],
      }),
    );

    const persisted = await prisma.rollDispatchItem.findMany({
      where: { productionOrderId: production.body.id as string },
      orderBy: { positionSequence: 'asc' },
    });
    expect(persisted.map((item) => item.recipeVersion)).toEqual(['v1', 'v2', 'v2']);
    expect(persisted[0]!.characteristicsSnapshot).toEqual(
      expect.objectContaining({ recipeVersion: 'v1' }),
    );
    expect(persisted[1]!.characteristicsSnapshot).toEqual(
      expect.objectContaining({ recipeVersion: 'v2', recipeParameters: newParameters }),
    );
    const resolvedProblem = await prisma.productionProblem.findUniqueOrThrow({
      where: { id: problem.body.id as string },
      include: { resolutionCase: true },
    });
    expect(resolvedProblem).toEqual(
      expect.objectContaining({ status: 'resolved', resolutionCase: expect.any(Object) }),
    );
    for (const type of [
      'audit:commercial_position_correction_requested',
      'audit:correction_applies_from_roll_set',
      'audit:current_roll_resolution_set',
      'audit:recipe_correction_applied',
      'notification:commercial_correction_applied',
      'notification:operator_recipe_changed',
    ]) {
      await expect(eventCount(order.id, type)).resolves.toBe(1);
    }
  });

  it('rejects another role and hides raw and sensitive fields', async () => {
    const order = await createOrder('safe-projection', 1);
    const draft = await createOrder('hidden-draft', 1, { mode: 'draft' });

    await http()
      .post('/api/commercial/orders')
      .set(auth.finance)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: 'cp-uralpak',
        requestType: 'client_order',
        positions: [{ ...POSITION, rollCount: 1 }],
      })
      .expect(403);
    await http()
      .post('/api/commercial/orders')
      .set({ 'x-role': 'commercial' })
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: 'cp-uralpak',
        requestType: 'client_order',
        positions: [{ ...POSITION, rollCount: 1 }],
      })
      .expect(401);
    await http().get(`/api/commercial/orders/${draft.id}`).set(auth.production).expect(404);

    const productionProjection = await http()
      .get(`/api/commercial/orders/${order.id}`)
      .set(auth.production)
      .expect(200);
    expect(productionProjection.body.counterparty).toEqual(
      expect.objectContaining({ legalName: null, inn: null }),
    );
    expect(JSON.stringify(productionProjection.body)).not.toMatch(
      /ACCEPTANCE-SECRET|rawPayload|passwordHash|sourceSnapshotId/,
    );

    const materials = await http()
      .get('/api/commercial/raw-materials?limit=10')
      .set(auth.commercial)
      .expect(200);
    expect(Array.isArray(materials.body.items)).toBe(true);
    expect(JSON.stringify(materials.body)).not.toMatch(
      /rawPayload|sourceSnapshotId|unitCost|amountValue|passwordHash/,
    );
    await http().get('/api/warehouse/raw-materials').set(auth.commercial).expect(403);
  });

  it('deduplicates retries and lets one concurrent reservation win', async () => {
    const counterparty = await createCounterparty('idempotency');
    const clientRequestId = randomUUID();
    const payload = {
      clientRequestId,
      title: 'Concurrent idempotent order',
      counterpartyId: counterparty.id,
      requestType: 'client_order',
      positions: [{ ...POSITION, rollCount: 1 }],
    };
    const [first, second] = await Promise.all([
      http().post('/api/commercial/orders').set(auth.commercial).send(payload),
      http().post('/api/commercial/orders').set(auth.commercial).send(payload),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.id).toBe(second.body.id);
    expect(await prisma.commercialOrder.count({ where: { clientRequestId } })).toBe(1);
    await expect(
      eventCount(first.body.id as string, 'audit:commercial_recipe_snapshot_set'),
    ).resolves.toBe(1);

    const leftOrder = await createOrder('reservation-left', 1);
    const rightOrder = await createOrder('reservation-right', 1);
    const sharedRoll = await prisma.warehouseRoll.create({
      data: {
        rollCode: `STK-RACE-${suiteId}-${randomUUID()}`,
        warehouseStatus: 'received',
        positionSnapshot: {
          filmType: POSITION.filmType,
          actualThickness: POSITION.actualThickness,
          birka: POSITION.birka,
          spoolType: POSITION.spoolType,
          plannedWeightKg: POSITION.plannedWeightKg,
        },
      },
    });
    const [leftProposal, rightProposal] = await Promise.all([
      createCoverFixture(leftOrder, 1, sharedRoll.id),
      createCoverFixture(rightOrder, 1, sharedRoll.id),
    ]);
    const approve = (order: CreatedOrder, proposal: CoverFixture) =>
      http()
        .post(
          `/api/commercial/orders/${order.id}/positions/${order.positions[0]!.id}/warehouse-cover/${proposal.id}/commercial-approval`,
        )
        .set(auth.commercial)
        .send({ expectedVersion: 1, route: 'full_cover' })
        .expect(201);
    const leftApproved = await approve(leftOrder, leftProposal);
    const rightApproved = await approve(rightOrder, rightProposal);
    const finalize = (order: CreatedOrder, proposal: CoverFixture, version: number) =>
      http()
        .post(
          `/api/commercial/orders/${order.id}/positions/${order.positions[0]!.id}/warehouse-cover/${proposal.id}/technical-approval`,
        )
        .set(auth.production)
        .send({ expectedVersion: version });
    const outcomes = await Promise.all([
      finalize(leftOrder, leftProposal, leftApproved.body.version as number),
      finalize(rightOrder, rightProposal, rightApproved.body.version as number),
    ]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([201, 409]);

    const reserved = await prisma.warehouseRoll.findUniqueOrThrow({
      where: { id: sharedRoll.id },
    });
    const winner = reserved.reservedForOrderId === leftOrder.id ? leftOrder : rightOrder;
    const winnerProposal = winner.id === leftOrder.id ? leftProposal : rightProposal;
    const winnerVersion =
      winner.id === leftOrder.id
        ? (leftApproved.body.version as number)
        : (rightApproved.body.version as number);
    await finalize(winner, winnerProposal, winnerVersion).expect(201);

    expect([leftOrder.id, rightOrder.id]).toContain(reserved.reservedForOrderId);
    expect(
      await prisma.warehouseAcceptanceTask.count({
        where: { proposalId: { in: [leftProposal.id, rightProposal.id] } },
      }),
    ).toBe(1);
    expect(
      (await eventCount(leftOrder.id, 'audit:warehouse_cover_technical_approved')) +
        (await eventCount(rightOrder.id, 'audit:warehouse_cover_technical_approved')),
    ).toBe(1);
    expect(
      (await eventCount(leftOrder.id, 'audit:warehouse_rolls_reserved_for_order')) +
        (await eventCount(rightOrder.id, 'audit:warehouse_rolls_reserved_for_order')),
    ).toBe(1);
  });
});
