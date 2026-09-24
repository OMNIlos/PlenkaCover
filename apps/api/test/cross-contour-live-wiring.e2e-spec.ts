import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import {
  attachAvailableBagToOperatorShift,
  closeOperatorSessionFixture,
  createAvailableBigBagFixture,
  createAssignedOperatorShiftFixture,
} from './operator-shift-e2e-fixture';
import { enableSimulatedDevices } from './simulated-device-fixture';
import { sealAndPrintCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

type Bearer = { Authorization: string };
type SessionName = 'commercial' | 'finance' | 'production' | 'operator' | 'warehouse' | 'director';

type CoverRequestResponse = {
  case: { id: string; orderId: string; state: string; ownerRole: string };
};

type CreatedOrder = {
  id: string;
  orderNumber: string;
  positions: Array<{ id: string; version: number }>;
};

const FIXTURE_PREFIX = 'Cross contour live wiring E2E';
const POSTPAY_ORDER_NUMBER = 'E2E-CROSS-CONTOUR-POSTPAY';
const PREPAY_ORDER_NUMBER = 'E2E-CROSS-CONTOUR-PREPAY';
const FIXTURE_ORDER_NUMBERS = [POSTPAY_ORDER_NUMBER, PREPAY_ORDER_NUMBER];

describe('Cross-contour live wiring (e2e, Bearer + PostgreSQL)', () => {
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
  let auth: Record<SessionName, Bearer>;
  let operatorId: string;
  let authSessionIds: string[] = [];
  let fixtureCounterpartyIds: string[] = [];
  let createdOperatorPostSessionId: string | null = null;
  let gatewayPostId: string | null = null;
  let gatewayCommandBaselineIds: string[] = [];
  let restoreSimulatedDevices: (() => Promise<void>) | null = null;

  const http = () => request(app.getHttpServer());

  async function cleanupFixture() {
    let createdGatewayCommandIds: string[] = [];
    if (gatewayPostId) {
      createdGatewayCommandIds = (
        await prisma.gatewayCommand.findMany({
          where: {
            postId: gatewayPostId,
            ...(gatewayCommandBaselineIds.length > 0
              ? { id: { notIn: gatewayCommandBaselineIds } }
              : {}),
          },
          select: { id: true },
        })
      ).map((command) => command.id);
      gatewayPostId = null;
      gatewayCommandBaselineIds = [];
    }
    if (createdOperatorPostSessionId) {
      await closeOperatorSessionFixture(prisma, createdOperatorPostSessionId);
      await expect(
        prisma.operatorPostSession.count({
          where: { id: createdOperatorPostSessionId, status: 'active' },
        }),
      ).resolves.toBe(0);
      createdOperatorPostSessionId = null;
    }

    const storedFixtureCounterparties = await prisma.counterparty.findMany({
      where: { displayName: { startsWith: FIXTURE_PREFIX } },
      select: { id: true },
    });
    const counterpartyIds = [
      ...new Set([
        ...fixtureCounterpartyIds,
        ...storedFixtureCounterparties.map((counterparty) => counterparty.id),
      ]),
    ];
    const orders = await prisma.commercialOrder.findMany({
      where: { orderNumber: { in: FIXTURE_ORDER_NUMBERS } },
      select: {
        id: true,
        positions: { select: { id: true, recipe: { select: { id: true } } } },
        coverProposals: { select: { id: true } },
        productionOrder: {
          select: {
            id: true,
            dispatchItems: {
              select: { id: true, rollCode: true, operatorLine: { select: { id: true } } },
            },
          },
        },
        financeOrder: { select: { id: true, schedules: { select: { id: true } } } },
      },
    });
    const orderIds = orders.map((order) => order.id);
    const positionIds = orders.flatMap((order) => order.positions.map((position) => position.id));
    const recipeIds = orders.flatMap((order) =>
      order.positions.flatMap((position) => (position.recipe ? [position.recipe.id] : [])),
    );
    const proposalIds = orders.flatMap((order) =>
      order.coverProposals.map((proposal) => proposal.id),
    );
    const productionOrderIds = orders.flatMap((order) =>
      order.productionOrder ? [order.productionOrder.id] : [],
    );
    const dispatchItems = orders.flatMap((order) => order.productionOrder?.dispatchItems ?? []);
    const dispatchItemIds = dispatchItems.map((item) => item.id);
    const rollCodes = dispatchItems.map((item) => item.rollCode);
    const warehouseTasks = await prisma.warehouseAcceptanceTask.findMany({
      where: {
        OR: [
          { orderId: { in: orderIds } },
          { rows: { some: { rollCode: { in: rollCodes } } } },
          { rows: { some: { fromOrderId: { in: FIXTURE_ORDER_NUMBERS } } } },
        ],
      },
      select: { id: true, rows: { select: { rollCode: true } } },
    });
    const warehouseTaskIds = warehouseTasks.map((task) => task.id);
    const warehouseRollCodes = [
      ...new Set([
        ...rollCodes,
        ...warehouseTasks.flatMap((task) => task.rows.map((row) => row.rollCode)),
      ]),
    ];
    const operatorLineIds = dispatchItems.flatMap((item) =>
      item.operatorLine ? [item.operatorLine.id] : [],
    );
    const financeOrderIds = orders.flatMap((order) =>
      order.financeOrder ? [order.financeOrder.id] : [],
    );
    const scheduleIds = orders.flatMap(
      (order) => order.financeOrder?.schedules.map((schedule) => schedule.id) ?? [],
    );
    const eventObjectIds = [
      ...new Set([
        ...counterpartyIds,
        ...orderIds,
        ...productionOrderIds,
        ...financeOrderIds,
        ...dispatchItemIds,
        ...rollCodes,
        ...scheduleIds,
        ...warehouseTaskIds,
        ...warehouseRollCodes,
      ]),
    ];
    const fixtureEventIds =
      eventObjectIds.length > 0
        ? (
            await prisma.domainEvent.findMany({
              where: { objectId: { in: eventObjectIds } },
              select: { id: true },
            })
          ).map((event) => event.id)
        : [];
    if (eventObjectIds.length > 0) {
      expect(fixtureEventIds.length).toBeGreaterThan(0);
    }
    // Immutable events and their receipts remain until guarded isolated-schema teardown.
    if (warehouseTaskIds.length > 0) {
      const palletDocuments = await prisma.palletListDocument.findMany({
        where: {
          acceptanceTaskId: { in: warehouseTaskIds },
        },
        select: { id: true },
      });
      const palletIds = (
        await prisma.warehousePallet.findMany({
          where: { taskId: { in: warehouseTaskIds } },
          select: { id: true },
        })
      ).map((pallet) => pallet.id);
      if (palletDocuments.length > 0) {
        const documentIds = palletDocuments.map((document) => document.id);
        await prisma.palletPrintJob.deleteMany({
          where: { palletListDocumentId: { in: documentIds } },
        });
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "pallet_scan_tokens" DISABLE TRIGGER "pallet_scan_tokens_immutable"',
          );
          try {
            await tx.palletScanToken.deleteMany({
              where: { documentId: { in: documentIds } },
            });
            await tx.palletListDocument.deleteMany({
              where: { id: { in: documentIds } },
            });
          } finally {
            await tx.$executeRawUnsafe(
              'ALTER TABLE "pallet_scan_tokens" ENABLE TRIGGER "pallet_scan_tokens_immutable"',
            );
          }
        });
      }
      if (palletIds.length > 0) {
        await prisma.warehousePalletItem.deleteMany({
          where: { palletId: { in: palletIds } },
        });
        await prisma.warehousePallet.deleteMany({ where: { id: { in: palletIds } } });
      }
      await prisma.weightCapture.deleteMany({
        where: { warehouseOperation: { taskId: { in: warehouseTaskIds } } },
      });
      await prisma.warehouseOperation.deleteMany({
        where: { taskId: { in: warehouseTaskIds } },
      });
      await prisma.scanRow.deleteMany({ where: { taskId: { in: warehouseTaskIds } } });
      await prisma.warehouseAcceptanceTask.deleteMany({
        where: { id: { in: warehouseTaskIds } },
      });
    }
    if (warehouseRollCodes.length > 0) {
      await prisma.warehouseRoll.updateMany({
        where: { rollCode: { in: warehouseRollCodes } },
        data: {
          ownerCounterpartyId: null,
          reservedForOrderId: null,
          reservedForPositionId: null,
          reservedByProposalId: null,
          reservedAt: null,
        },
      });
    }
    if (operatorLineIds.length > 0) {
      await prisma.operatorRollOperation.deleteMany({
        where: { operatorRollLineId: { in: operatorLineIds } },
      });
      await prisma.weightCapture.deleteMany({
        where: { operatorRollLineId: { in: operatorLineIds } },
      });
      await prisma.defectRecord.deleteMany({
        where: { operatorRollLineId: { in: operatorLineIds } },
      });
      await prisma.labelPrintJob.deleteMany({
        where: { operatorRollLineId: { in: operatorLineIds } },
      });
      await prisma.operatorRollLine.deleteMany({ where: { id: { in: operatorLineIds } } });
    }
    if (createdGatewayCommandIds.length > 0) {
      await prisma.gatewayCommand.deleteMany({
        where: { id: { in: createdGatewayCommandIds } },
      });
      createdGatewayCommandIds = [];
    }
    if (dispatchItemIds.length > 0 || productionOrderIds.length > 0) {
      await prisma.machineAssignment.deleteMany({
        where: {
          OR: [
            { rollDispatchItemId: { in: dispatchItemIds } },
            { productionOrderId: { in: productionOrderIds } },
          ],
        },
      });
      await prisma.rollDispatchItem.deleteMany({ where: { id: { in: dispatchItemIds } } });
      await prisma.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
    }
    if (financeOrderIds.length > 0) {
      await prisma.directorDecision.deleteMany({
        where: { objectId: { in: financeOrderIds } },
      });
      await prisma.sourceSnapshot.deleteMany({
        where: { financeOrderId: { in: financeOrderIds } },
      });
      await prisma.syncJournal.deleteMany({ where: { financeOrderId: { in: financeOrderIds } } });
      await prisma.paymentOperation.deleteMany({
        where: { financeOrderId: { in: financeOrderIds } },
      });
      await prisma.paymentSchedule.deleteMany({
        where: { financeOrderId: { in: financeOrderIds } },
      });
      await prisma.financeOrder.deleteMany({ where: { id: { in: financeOrderIds } } });
    }
    if (proposalIds.length > 0) {
      await prisma.warehouseCoverMatch.deleteMany({
        where: { proposalId: { in: proposalIds } },
      });
    }
    if (orderIds.length > 0) {
      await prisma.warehouseCoverProposal.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderResolutionCase.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.productionProblem.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    if (recipeIds.length > 0) {
      await prisma.recipeSnapshotVersion.deleteMany({
        where: { recipeSnapshotId: { in: recipeIds } },
      });
      await prisma.recipeSnapshot.deleteMany({ where: { id: { in: recipeIds } } });
    }
    if (positionIds.length > 0) {
      await prisma.commercialOrderPosition.deleteMany({ where: { id: { in: positionIds } } });
    }
    if (orderIds.length > 0) {
      await prisma.commercialOrder.deleteMany({ where: { id: { in: orderIds } } });
    }
    if (counterpartyIds.length > 0) {
      await prisma.counterparty.deleteMany({ where: { id: { in: counterpartyIds } } });
    }
    fixtureCounterpartyIds = [];
    if (fixtureEventIds.length > 0) {
      await expect(
        prisma.domainEvent.count({ where: { id: { in: fixtureEventIds } } }),
      ).resolves.toBe(fixtureEventIds.length);
    }
    if (authSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: authSessionIds } } });
      authSessionIds = [];
    }
  }

  async function createOrder(input: {
    label: string;
    orderNumber: string;
    clientRequestId: string;
    inn: string;
  }): Promise<CreatedOrder> {
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(auth.commercial)
      .send({
        displayName: `${FIXTURE_PREFIX} ${input.label}`,
        legalName: `ООО CROSS-CONTOUR-LEGAL-SECRET ${input.label}`,
        inn: input.inn,
      })
      .expect(201);
    fixtureCounterpartyIds.push(counterparty.body.id as string);
    const response = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: input.clientRequestId,
        orderNumber: input.orderNumber,
        mode: 'submit',
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            spoolType: 'втулка 76',
            plannedWeightKg: 41.2,
            recipeParameters: [
              { label: 'Сырьё', value: 'ПВД 15803-020' },
              { label: 'План. вес, кг', value: '41.2' },
            ],
          },
        ],
      })
      .expect(201);
    return response.body as CreatedOrder;
  }

  async function proposeAndApproveProductionOnly(order: CreatedOrder) {
    const proposal = await http()
      .post(`/api/warehouse/orders/${order.id}/cover-proposals`)
      .set(auth.warehouse)
      .send({
        positionId: order.positions[0]!.id,
        rollIds: [],
        comment: `Production-only cover for ${order.orderNumber}`,
      })
      .expect(201);

    const commercialControl = await http()
      .get('/api/commercial/notifications?limit=100')
      .set(auth.commercial)
      .expect(200);
    expect(
      commercialControl.body.items.filter(
        (item: { eventType: string; orderId: string }) =>
          item.eventType === 'audit:warehouse_cover_proposed' && item.orderId === order.id,
      ),
    ).toHaveLength(1);

    await http()
      .post(
        `/api/commercial/orders/${order.id}/positions/${order.positions[0]!.id}` +
          `/warehouse-cover/${proposal.body.id as string}/commercial-approval`,
      )
      .set(auth.commercial)
      .send({ expectedVersion: proposal.body.version, route: 'production_only' })
      .expect(201);
    return proposal.body as { id: string; version: number };
  }

  async function findFinanceOrder(orderId: string) {
    const response = await http().get('/api/finance/orders').set(auth.finance).expect(200);
    const financeOrder = (
      response.body as Array<{ id: string; commercialOrder?: { id: string } }>
    ).find((candidate) => candidate.commercialOrder?.id === orderId);
    expect(financeOrder).toBeTruthy();
    return financeOrder!;
  }

  async function expectNoProductionHandoff(orderId: string) {
    const queue = await http().get('/api/production/orders').set(auth.production).expect(200);
    expect(
      queue.body.some(
        (candidate: { commercialOrderId: string }) => candidate.commercialOrderId === orderId,
      ),
    ).toBe(false);
    const control = await http()
      .get('/api/production/notifications?limit=100')
      .set(auth.production)
      .expect(200);
    expect(
      control.body.items.some(
        (item: { eventType: string; orderId: string }) =>
          item.eventType === 'audit:production_order_created' && item.orderId === orderId,
      ),
    ).toBe(false);
    await expect(
      prisma.productionOrder.count({ where: { commercialOrderId: orderId } }),
    ).resolves.toBe(0);
  }

  function expectSerializedProjectionSafe(value: unknown, rawSentinels: string[] = []) {
    const forbiddenKeys = new Set(['lastScan', 'payload', 'raw', 'rawPayload', 'parsedPayload']);
    const visit = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(visit);
        return;
      }
      if (candidate && typeof candidate === 'object') {
        for (const [key, nested] of Object.entries(candidate)) {
          expect(forbiddenKeys.has(key)).toBe(false);
          visit(nested);
        }
        return;
      }
      if (typeof candidate === 'string') {
        for (const sentinel of rawSentinels) expect(candidate).not.toContain(sentinel);
      }
    };

    visit(value);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('CROSS-CONTOUR-LEGAL-SECRET');
    expect(serialized).not.toMatch(
      /"(?:legalName|inn|amountValue|amountLabel|invoiceStatus|paymentStatus|paymentTermsType|schedules|rawPayload|parsedPayload|agentTokenHash|sourceSnapshotId)"\s*:/,
    );
    for (const sentinel of rawSentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain('invoice_prepayment');
    expect(serialized).not.toContain('post_delivery');
  }

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    for (const [name, value] of Object.entries(DEVICE_ENV)) {
      previousDeviceEnv[name] = process.env[name];
      process.env[name] = value;
    }
    // Import after fixing the auth flag: x-role must not be available in this proof.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl).toBeTruthy();
    const expectedDatabase = decodeURIComponent(new URL(databaseUrl!).pathname.slice(1));
    const connectedDatabase = await prisma.$queryRaw<Array<{ database: string }>>`
      SELECT current_database() AS database
    `;
    expect(connectedDatabase).toEqual([{ database: expectedDatabase }]);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
    await cleanupFixture();

    const password = e2eSeedPassword();
    const accounts = [
      { name: 'commercial', login: e2eSeedLogin('commercial'), role: 'commercial' },
      { name: 'finance', login: e2eSeedLogin('finance'), role: 'finance' },
      { name: 'production', login: e2eSeedLogin('production'), role: 'production_lead' },
      { name: 'operator', login: e2eSeedLogin('operator'), role: 'operator' },
      { name: 'warehouse', login: e2eSeedLogin('warehouse'), role: 'warehouse' },
      { name: 'director', login: e2eSeedLogin('director'), role: 'director' },
    ] as const;
    const sessions = await Promise.all(
      accounts.map(({ login }) =>
        http().post('/api/auth/login').send({ login, password }).expect(201),
      ),
    );
    auth = Object.fromEntries(
      sessions.map((session, index) => {
        expect(session.body.user.role).toBe(accounts[index]!.role);
        return [accounts[index]!.name, { Authorization: `Bearer ${session.body.token as string}` }];
      }),
    ) as Record<SessionName, Bearer>;
    const operatorSession = sessions[accounts.findIndex((account) => account.name === 'operator')]!;
    operatorId = operatorSession.body.user.id as string;
    const authenticatedActors = await Promise.all(
      accounts.map(({ name, role }) =>
        http()
          .get('/api/auth/me')
          .set(auth[name])
          .expect(200)
          .then((response) => {
            expect(response.body.role).toBe(role);
            return response.body as { session: { id: string } };
          }),
      ),
    );
    authSessionIds = authenticatedActors.map((actor) => actor.session.id);
    await http().get('/api/warehouse/physical-posts').set(auth.warehouse).expect(404);
    await http()
      .put('/api/warehouse/post-binding')
      .set(auth.warehouse)
      .send({ postCode: 'POST-1' })
      .expect(404);
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'cross-contour simulated devices',
          run: async () => restoreSimulatedDevices?.(),
        },
        {
          label: 'cross-contour fixture',
          run: async () => {
            if (prisma) await cleanupFixture();
          },
        },
        { label: 'cross-contour application', run: async () => app?.close() },
        {
          label: 'cross-contour auth environment',
          run: () => {
            if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
            else process.env.AUTH_DEV_XROLE = previousDevRole;
            for (const name of Object.keys(DEVICE_ENV)) {
              const value = previousDeviceEnv[name];
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          },
        },
      ],
    );
  });

  it('runs cover, finance gates, production publication and operator handover', async () => {
    const order = await createOrder({
      label: 'postpay',
      orderNumber: POSTPAY_ORDER_NUMBER,
      clientRequestId: '00000000-0000-4000-8000-000000007001',
      inn: '770000007001',
    });

    const coverUrl = `/api/commercial/orders/${order.id}/warehouse-cover/recheck`;
    const [first, second] = await Promise.all([
      http().post(coverUrl).set(auth.commercial).send({}),
      http().post(coverUrl).set(auth.commercial).send({}),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const firstBody = first.body as CoverRequestResponse;
    const secondBody = second.body as CoverRequestResponse;
    expect(secondBody.case.id).toBe(firstBody.case.id);

    const coverPage = await http()
      .get('/api/warehouse/cover-checks?limit=100')
      .set(auth.warehouse)
      .expect(200);
    expect(
      coverPage.body.items.filter((item: { orderId: string }) => item.orderId === order.id),
    ).toEqual([
      expect.objectContaining({
        caseId: firstBody.case.id,
        orderId: order.id,
        state: 'open',
      }),
    ]);

    const warehouseControl = await http()
      .get('/api/warehouse/notifications?limit=100')
      .set(auth.warehouse)
      .expect(200);
    expect(
      warehouseControl.body.items.filter(
        (item: { eventType: string; orderId: string }) =>
          item.eventType === 'audit:warehouse_cover_recheck_requested' && item.orderId === order.id,
      ),
    ).toHaveLength(1);
    await http().get('/api/warehouse/notifications?limit=100').set(auth.commercial).expect(403);

    await expect(
      prisma.orderResolutionCase.count({
        where: { orderId: order.id, type: 'warehouse_cover_check' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: order.id,
          type: 'audit:warehouse_cover_recheck_requested',
        },
      }),
    ).resolves.toBe(1);

    await proposeAndApproveProductionOnly(order);

    await http()
      .post(`/api/commercial/orders/${order.id}/invoice-handoff`)
      .set(auth.commercial)
      .send({ amount: 150_000, note: 'Postpay cross-contour invoice' })
      .expect(201);
    const financeOrder = await findFinanceOrder(order.id);
    const financeControl = await http()
      .get('/api/finance/notifications?limit=100')
      .set(auth.finance)
      .expect(200);
    expect(
      financeControl.body.items.filter(
        (item: { eventType: string; orderId: string }) =>
          item.eventType === 'audit:invoice_handoff_created' && item.orderId === order.id,
      ),
    ).toHaveLength(1);

    await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(409);
    await expectNoProductionHandoff(order.id);

    await http()
      .post(`/api/finance/orders/${financeOrder.id}/invoices`)
      .set(auth.finance)
      .send({ amount: 150_000, paymentTermsType: 'postpay_100_30d' })
      .expect(201);
    await expectNoProductionHandoff(order.id);
    const postpayDetail = await http()
      .get(`/api/commercial/orders/${order.id}`)
      .set(auth.commercial)
      .expect(200);
    expect(postpayDetail.body.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );
    await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.finance)
      .send({})
      .expect(403);
    const production = await http()
      .post(`/api/commercial/orders/${order.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(production.body.commercialOrderId).toBe(order.id);

    const productionQueue = await http()
      .get('/api/production/orders')
      .set(auth.production)
      .expect(200);
    expect(
      productionQueue.body.some(
        (candidate: { commercialOrderId: string }) => candidate.commercialOrderId === order.id,
      ),
    ).toBe(true);
    const productionControl = await http()
      .get('/api/production/notifications?limit=100')
      .set(auth.production)
      .expect(200);
    expect(
      productionControl.body.items.filter(
        (item: { eventType: string; orderId: string }) =>
          item.eventType === 'audit:production_order_created' && item.orderId === order.id,
      ),
    ).toHaveLength(1);

    const prepayOrder = await createOrder({
      label: 'prepay',
      orderNumber: PREPAY_ORDER_NUMBER,
      clientRequestId: '00000000-0000-4000-8000-000000007002',
      inn: '770000007002',
    });
    await http()
      .post(`/api/commercial/orders/${prepayOrder.id}/warehouse-cover/recheck`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    await proposeAndApproveProductionOnly(prepayOrder);
    await http()
      .post(`/api/commercial/orders/${prepayOrder.id}/invoice-handoff`)
      .set(auth.commercial)
      .send({ amount: 100_000, note: 'Prepay cross-contour invoice' })
      .expect(201);
    const prepayFinanceOrder = await findFinanceOrder(prepayOrder.id);
    const invoiced = await http()
      .post(`/api/finance/orders/${prepayFinanceOrder.id}/invoices`)
      .set(auth.finance)
      .send({ amount: 100_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const prepayment = invoiced.body.schedules.find(
      (schedule: { kind: string }) => schedule.kind === 'invoice_prepayment',
    );
    expect(prepayment).toEqual(expect.objectContaining({ amount: 50_000, status: 'unpaid' }));
    await http()
      .post(`/api/commercial/orders/${prepayOrder.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(409);
    await expectNoProductionHandoff(prepayOrder.id);
    await http()
      .post(
        `/api/finance/orders/${prepayFinanceOrder.id}` +
          `/payment-schedules/${prepayment.id as string}/confirm`,
      )
      .set(auth.finance)
      .send({})
      .expect(201);
    await expectNoProductionHandoff(prepayOrder.id);
    const prepayDetail = await http()
      .get(`/api/commercial/orders/${prepayOrder.id}`)
      .set(auth.commercial)
      .expect(200);
    expect(prepayDetail.body.nextAction).toEqual(
      expect.objectContaining({ code: 'send_to_production', allowed: true }),
    );
    const prepayProduction = await http()
      .post(`/api/commercial/orders/${prepayOrder.id}/send-to-production`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    expect(prepayProduction.body.commercialOrderId).toBe(prepayOrder.id);

    const publishedQueue = await http()
      .get('/api/production/orders')
      .set(auth.production)
      .expect(200);
    const publishedControl = await http()
      .get('/api/production/notifications?limit=100')
      .set(auth.production)
      .expect(200);
    for (const publishedOrder of [order, prepayOrder]) {
      expect(
        publishedQueue.body.filter(
          (candidate: { commercialOrderId: string }) =>
            candidate.commercialOrderId === publishedOrder.id,
        ),
      ).toHaveLength(1);
      expect(
        publishedControl.body.items.filter(
          (item: { eventType: string; orderId: string }) =>
            item.eventType === 'audit:production_order_created' &&
            item.orderId === publishedOrder.id,
        ),
      ).toHaveLength(1);
    }

    const operatorShift = await createAssignedOperatorShiftFixture(prisma, {
      operatorId,
      postCode: 'POST-1',
      label: `${FIXTURE_PREFIX} operator shift`,
    });
    const postCode = operatorShift.post.code;
    gatewayPostId = operatorShift.post.id;
    gatewayCommandBaselineIds = (
      await prisma.gatewayCommand.findMany({
        where: { postId: gatewayPostId },
        select: { id: true },
      })
    ).map((command) => command.id);
    restoreSimulatedDevices = await enableSimulatedDevices(prisma, [
      'dev-scale-1',
      'dev-printer-1',
    ]);
    const deviceStateBefore = await prisma.deviceRuntime.findMany({
      where: { postId: gatewayPostId },
      select: { id: true, status: true, lastSeenAt: true, lastTestAt: true },
      orderBy: { id: 'asc' },
    });
    const roll = (production.body.dispatchItems as Array<{ id: string; rollCode: string }>)[0]!;

    const assignedRoll = await http()
      .post(`/api/production/roll-dispatch/${roll.rollCode}/assign`)
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
    await http()
      .post(`/api/production/orders/${production.body.id as string}/approve`)
      .set(auth.production)
      .send({})
      .expect(201);
    const activePostSessionBefore = await prisma.operatorPostSession.findFirst({
      where: { operatorId, status: 'active' },
      select: { id: true, postId: true },
    });
    const openedPostSession = await http()
      .post('/api/operator/post-sessions')
      .set(auth.operator)
      .send({ postCode })
      .expect(201);
    if (activePostSessionBefore) {
      expect(openedPostSession.body).toEqual(
        expect.objectContaining({
          id: activePostSessionBefore.id,
          postId: activePostSessionBefore.postId,
        }),
      );
    } else {
      createdOperatorPostSessionId = openedPostSession.body.id as string;
    }
    const bigBagId = await createAvailableBigBagFixture(prisma, {
      code: `CROSS-CONTOUR-BAG-${Date.now()}-${process.pid}`,
    });
    await attachAvailableBagToOperatorShift(app, prisma, auth.operator, postCode, bigBagId);
    const runtime = await http().get('/api/operator/runtime').set(auth.operator).expect(200);
    const runtimeOrder = runtime.body.orders.find(
      (candidate: { id: string }) => candidate.id === order.orderNumber,
    );
    expect(runtimeOrder).toBeTruthy();
    expect(
      runtimeOrder.rolls.filter((candidate: { id: string }) => candidate.id === roll.rollCode),
    ).toHaveLength(1);
    const operatorControl = await http()
      .get('/api/operator/notifications?limit=100')
      .set(auth.operator)
      .expect(200);
    expect(
      operatorControl.body.items.filter(
        (item: {
          eventType: string;
          orderId: string;
          rollId: string | null;
          cta: { kind: string; targetId: string };
        }) =>
          item.eventType === 'audit:task_assigned' &&
          item.orderId === order.id &&
          item.rollId === null &&
          item.cta.kind === 'operator_queue' &&
          item.cta.targetId === order.id,
      ),
    ).toHaveLength(1);
    for (const eventType of [
      'audit:roll_dispatch_assigned',
      'audit:roll_dispatch_bulk_assigned',
      'audit:production_order_approved',
    ]) {
      expect(
        operatorControl.body.items.some(
          (item: { eventType: string; orderId: string }) =>
            item.eventType === eventType && item.orderId === order.id,
        ),
      ).toBe(false);
    }
    expectSerializedProjectionSafe({ runtime: runtime.body, control: operatorControl.body });

    await http()
      .post(`/api/operator/rolls/${roll.rollCode}/accept`)
      .set(auth.operator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${roll.rollCode}/spool-weight`)
      .set(auth.operator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${roll.rollCode}/roll-weight`)
      .set(auth.operator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    await http()
      .post(`/api/operator/rolls/${roll.rollCode}/qr-print`)
      .set(auth.operator)
      .send({ operationKey: randomUUID() })
      .expect(201);
    const printEvidence = await prisma.rollScanToken.findUniqueOrThrow({
      where: { rollCode: roll.rollCode },
      select: { token: true },
    });
    expect(printEvidence.token).toMatch(/^prt_[0-9a-f]{64}$/u);
    await http()
      .post(`/api/operator/rolls/${roll.rollCode}/qr-verify`)
      .set(auth.operator)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    const handover = await http()
      .post(`/api/operator/rolls/${roll.rollCode}/handover`)
      .set(auth.operator)
      .send({ operationKey: randomUUID() })
      .expect(201);

    const warehouseIntake = await http()
      .get('/api/warehouse/intake')
      .set(auth.warehouse)
      .expect(200);
    const intakeTask = warehouseIntake.body.tasks.find(
      (candidate: { taskId: string }) => candidate.taskId === (handover.body.id as string),
    );
    expect(intakeTask).toBeTruthy();
    expect(
      intakeTask.rolls.filter(
        (candidate: { rollCode: string }) => candidate.rollCode === roll.rollCode,
      ),
    ).toHaveLength(1);
    const warehouseHandoverControl = await http()
      .get('/api/warehouse/notifications?limit=100')
      .set(auth.warehouse)
      .expect(200);
    expect(
      warehouseHandoverControl.body.items.filter(
        (item: { eventType: string; orderId: string; taskId: string }) =>
          item.eventType === 'audit:operator_roll_handed_over' &&
          item.orderId === order.id &&
          item.taskId === handover.body.id,
      ),
    ).toHaveLength(1);
    expectSerializedProjectionSafe({
      coverChecks: coverPage.body,
      intake: warehouseIntake.body,
      control: warehouseHandoverControl.body,
    });

    const receivingRawMarker = 'TASK7-RAW-SCAN-RECEIVING';
    const receivingRawPayload = JSON.stringify({
      v: 1,
      roll: roll.rollCode,
      raw: receivingRawMarker,
    });
    await http()
      .post(`/api/warehouse/tasks/${handover.body.id as string}/scans`)
      .set(auth.warehouse)
      .send({ operationKey: randomUUID(), payload: receivingRawPayload })
      .expect(400);
    const receivingScan = await http()
      .post(`/api/warehouse/tasks/${handover.body.id as string}/scans`)
      .set(auth.warehouse)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    expect(receivingScan.body).toEqual(
      expect.objectContaining({
        taskId: handover.body.id,
        rollCode: roll.rollCode,
        scanStatus: 'accepted',
        task: expect.objectContaining({
          taskId: handover.body.id,
          lastScanResult: expect.objectContaining({
            rollCode: roll.rollCode,
            scanStatus: 'accepted',
            scannedAt: expect.any(String),
          }),
        }),
      }),
    );
    const warehouseIntakeAfterReceive = await http()
      .get('/api/warehouse/intake')
      .set(auth.warehouse)
      .expect(200);
    const receivingTaskAfterScan = await http()
      .get(`/api/warehouse/tasks/${handover.body.id as string}`)
      .set(auth.warehouse)
      .expect(200);
    const receivingTasksAfterScan = await http()
      .get('/api/warehouse/tasks?mode=receiving')
      .set(auth.warehouse)
      .expect(200);
    for (const projection of [
      receivingScan.body,
      warehouseIntakeAfterReceive.body,
      receivingTaskAfterScan.body,
      receivingTasksAfterScan.body,
    ]) {
      expectSerializedProjectionSafe(projection, [receivingRawPayload, receivingRawMarker]);
    }
    const sealedPallet = await sealAndPrintCurrentPalletFixture(
      app,
      auth.warehouse,
      handover.body.id as string,
      { expectedRollCount: 1 },
    );
    const palletEvidence = await prisma.palletScanToken.findUniqueOrThrow({
      where: { documentId: sealedPallet.document.id },
      select: { token: true },
    });
    expect(palletEvidence.token).toMatch(/^plt_[0-9a-f]{64}$/u);
    const palletInspection = await http()
      .post('/api/warehouse/qr/inspect')
      .set(auth.warehouse)
      .send({ payload: palletEvidence.token })
      .expect(200);
    expect(palletInspection.body).toEqual({
      kind: 'pallet',
      inspectedAt: expect.any(String),
      pallet: expect.objectContaining({
        palletCode: expect.any(String),
        status: 'sealed',
        materialMark: expect.any(String),
        productNames: expect.any(Array),
        rollCount: 1,
        orderNumbers: expect.arrayContaining([POSTPAY_ORDER_NUMBER]),
        customerAliases: expect.any(Array),
        rollCodes: [roll.rollCode],
        createdAt: expect.any(String),
        sealedAt: expect.any(String),
      }),
    });
    expect(JSON.stringify(palletInspection.body)).not.toContain(palletEvidence.token);
    const closedReceiving = await http()
      .post(`/api/warehouse/tasks/${handover.body.id as string}/close`)
      .set(auth.warehouse)
      .send({ mode: 'full' })
      .expect(201);
    expectSerializedProjectionSafe(closedReceiving.body, [receivingRawPayload, receivingRawMarker]);

    const receivedRolls = await http().get('/api/warehouse/rolls').set(auth.warehouse).expect(200);
    expect(
      receivedRolls.body.filter(
        (candidate: { rollCode: string; warehouseStatus: string }) =>
          candidate.rollCode === roll.rollCode && candidate.warehouseStatus === 'received',
      ),
    ).toHaveLength(1);
    const commercialAfterReceipt = await http()
      .get('/api/commercial/notifications?limit=100')
      .set(auth.commercial)
      .expect(200);
    expect(
      commercialAfterReceipt.body.items.filter(
        (item: { eventType: string; orderId: string; taskId: string; rollId: string }) =>
          item.eventType === 'audit:warehouse_roll_received' &&
          item.orderId === order.id &&
          item.taskId === handover.body.id &&
          item.rollId === roll.rollCode,
      ),
    ).toHaveLength(1);

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
        rows: [expect.objectContaining({ rollCode: roll.rollCode, scanStatus: 'expected' })],
      }),
    );
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:warehouse_delivery_task_created',
          objectId: deliveryTask.id,
        },
      }),
    ).resolves.toBe(1);
    const warehouseDeliveryControl = await http()
      .get('/api/warehouse/notifications?limit=100')
      .set(auth.warehouse)
      .expect(200);
    expect(
      warehouseDeliveryControl.body.items.filter(
        (item: { eventType: string; orderId: string; taskId: string }) =>
          item.eventType === 'audit:warehouse_delivery_task_created' &&
          item.orderId === order.id &&
          item.taskId === deliveryTask.id,
      ),
    ).toEqual([
      expect.objectContaining({
        eventType: 'audit:warehouse_delivery_task_created',
        orderId: order.id,
        orderNumber: order.orderNumber,
        taskId: deliveryTask.id,
        cta: { kind: 'warehouse_intake', targetId: deliveryTask.id, section: 'Выдача' },
      }),
    ]);
    const deliveryRawMarker = 'TASK7-RAW-SCAN-DELIVERY';
    const deliveryRawPayload = JSON.stringify({
      v: 1,
      roll: roll.rollCode,
      raw: deliveryRawMarker,
    });
    await http()
      .post(`/api/warehouse/tasks/${deliveryTask.id}/scans`)
      .set(auth.warehouse)
      .send({ operationKey: randomUUID(), payload: deliveryRawPayload })
      .expect(400);
    const deliveryScan = await http()
      .post(`/api/warehouse/tasks/${deliveryTask.id}/scans`)
      .set(auth.warehouse)
      .send({ operationKey: randomUUID(), payload: printEvidence.token })
      .expect(201);
    expect(deliveryScan.body).toEqual(
      expect.objectContaining({
        taskId: deliveryTask.id,
        rollCode: roll.rollCode,
        scanStatus: 'accepted',
        task: expect.objectContaining({
          taskId: deliveryTask.id,
          lastScanResult: expect.objectContaining({
            rollCode: roll.rollCode,
            scanStatus: 'accepted',
            scannedAt: expect.any(String),
          }),
        }),
      }),
    );
    const deliveryTaskAfterScan = await http()
      .get(`/api/warehouse/tasks/${deliveryTask.id}`)
      .set(auth.warehouse)
      .expect(200);
    const deliveryTasksAfterScan = await http()
      .get('/api/warehouse/tasks?mode=delivery')
      .set(auth.warehouse)
      .expect(200);
    for (const projection of [
      deliveryScan.body,
      deliveryTaskAfterScan.body,
      deliveryTasksAfterScan.body,
    ]) {
      expectSerializedProjectionSafe(projection, [deliveryRawPayload, deliveryRawMarker]);
    }
    const closedDelivery = await http()
      .post(`/api/warehouse/tasks/${deliveryTask.id}/close`)
      .set(auth.warehouse)
      .send({ mode: 'full' })
      .expect(201);
    expect(closedDelivery.body).toEqual(
      expect.objectContaining({ id: deliveryTask.id, status: 'closed' }),
    );
    expectSerializedProjectionSafe(closedDelivery.body, [deliveryRawPayload, deliveryRawMarker]);

    await expect(
      prisma.commercialOrder.findUnique({
        where: { id: order.id },
        select: { id: true, shipmentStatus: true, shipmentCompletedAt: true },
      }),
    ).resolves.toEqual({
      id: order.id,
      shipmentStatus: 'shipped',
      shipmentCompletedAt: expect.any(Date),
    });
    const commercialSessionAfterShipment = await http()
      .get('/api/auth/me')
      .set(auth.commercial)
      .expect(200);
    expect(commercialSessionAfterShipment.body).toEqual(
      expect.objectContaining({ role: 'commercial', userId: expect.any(String) }),
    );

    const commercialAfterShipment = await http()
      .get(`/api/commercial/orders/${order.id}`)
      .set(auth.commercial)
      .expect(200);
    expect(commercialAfterShipment.body.indicators).toEqual(
      expect.objectContaining({ shipment: 'shipped' }),
    );
    const financeAfterShipment = await http()
      .get(`/api/finance/orders/${financeOrder.id as string}`)
      .set(auth.finance)
      .expect(200);
    expect(
      financeAfterShipment.body.schedules.filter(
        (schedule: { kind: string; status: string; dueDate: string | null }) =>
          schedule.kind === 'post_delivery' &&
          schedule.status === 'unpaid' &&
          typeof schedule.dueDate === 'string',
      ),
    ).toHaveLength(1);

    const commercialAfterShipmentControl = await http()
      .get('/api/commercial/notifications?limit=100')
      .set(auth.commercial)
      .expect(200);
    expect(
      commercialAfterShipmentControl.body.items.filter(
        (item: { eventType: string; orderId: string; taskId: string; rollId: string }) =>
          item.eventType === 'audit:warehouse_roll_shipped' &&
          item.orderId === order.id &&
          item.taskId === deliveryTask.id &&
          item.rollId === roll.rollCode,
      ),
    ).toHaveLength(1);
    const financeAfterShipmentControl = await http()
      .get('/api/finance/notifications?limit=100')
      .set(auth.finance)
      .expect(200);
    for (const eventType of [
      'audit:warehouse_roll_shipped',
      'audit:deferred_payment_due_scheduled',
    ]) {
      expect(
        financeAfterShipmentControl.body.items.filter(
          (item: { eventType: string; orderId: string; taskId: string }) =>
            item.eventType === eventType &&
            item.orderId === order.id &&
            item.taskId === deliveryTask.id,
        ),
      ).toHaveLength(1);
    }

    await http()
      .post(`/api/finance/orders/${financeOrder.id as string}/problems`)
      .set(auth.finance)
      .send({
        kind: 'overdue',
        reason: 'Cross-contour deferred payment requires action',
        evidence: `Order ${order.orderNumber} remains unpaid after shipment`,
      })
      .expect(201);
    const financeProblemControl = await http()
      .get('/api/finance/notifications?limit=100')
      .set(auth.finance)
      .expect(200);
    const directorProblemControl = await http()
      .get('/api/director/notifications?limit=100')
      .set(auth.director)
      .expect(200);
    for (const control of [financeProblemControl.body, directorProblemControl.body]) {
      expect(
        control.items.filter(
          (item: { eventType: string; orderId: string }) =>
            item.eventType === 'problem:payment_overdue' && item.orderId === order.id,
        ),
      ).toHaveLength(1);
    }

    const notificationMatrix = [
      { contour: 'commercial', owner: 'commercial', intruder: 'finance' },
      { contour: 'finance', owner: 'finance', intruder: 'commercial' },
      { contour: 'production', owner: 'production', intruder: 'warehouse' },
      { contour: 'operator', owner: 'operator', intruder: 'production' },
      { contour: 'warehouse', owner: 'warehouse', intruder: 'operator' },
      { contour: 'director', owner: 'director', intruder: 'commercial' },
    ] as const;
    const roleControls: unknown[] = [];
    for (const { contour, owner, intruder } of notificationMatrix) {
      const ownControl = await http()
        .get(`/api/${contour}/notifications?limit=100`)
        .set(auth[owner])
        .expect(200);
      roleControls.push(ownControl.body);
      await http().get(`/api/${contour}/notifications?limit=100`).set(auth[intruder]).expect(403);
    }
    expectSerializedProjectionSafe({
      controls: roleControls,
      operator: runtime.body,
      warehouse: { intake: warehouseIntakeAfterReceive.body, rolls: receivedRolls.body },
    });
    await expect(
      prisma.deviceRuntime.findMany({
        where: { postId: gatewayPostId! },
        select: { id: true, status: true, lastSeenAt: true, lastTestAt: true },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual(deviceStateBefore);
  });
});
