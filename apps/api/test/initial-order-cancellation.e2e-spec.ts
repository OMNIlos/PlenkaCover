import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PRIMARY_BASE_MATERIAL_SELECTION } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Initial V2 order deletion (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(90_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let savedAuthDevXRole: string | undefined;
  let savedWarehouseCoverageV2Enabled: string | undefined;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    savedAuthDevXRole = process.env.AUTH_DEV_XROLE;
    savedWarehouseCoverageV2Enabled = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    process.env.AUTH_DEV_XROLE = 'off';
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';
    // App configuration is evaluated during import; exercise the production V2 workflow.
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
  });

  afterAll(async () => {
    await app?.close();
    if (savedAuthDevXRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = savedAuthDevXRole;
    if (savedWarehouseCoverageV2Enabled === undefined) {
      delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
    } else {
      process.env.WAREHOUSE_COVERAGE_V2_ENABLED = savedWarehouseCoverageV2Enabled;
    }
  });

  it('permanently deletes a submitted order before the first coverage calculation', async () => {
    const suffix = randomUUID().slice(0, 8);
    const login = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('commercial'), password: e2eSeedPassword() })
      .expect(201);
    const authorization = { Authorization: `Bearer ${login.body.token as string}` };
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(authorization)
      .send({ displayName: `Initial cancellation E2E ${suffix}` })
      .expect(201);
    const created = await http()
      .post('/api/commercial/orders')
      .set(authorization)
      .send({
        clientRequestId: randomUUID(),
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
            widthMm: 450,
            plannedLengthM: 1200,
          },
        ],
      })
      .expect(201);
    const beforeDeletion = await prisma.warehouseCoverageState.findUniqueOrThrow({
      where: { orderId: created.body.id },
    });
    expect(beforeDeletion).toEqual(
      expect.objectContaining({
        state: 'calculating',
        stateVersion: 1,
        generation: 0,
        currentCalculationId: null,
        currentDecisionId: null,
      }),
    );

    await http().delete(`/api/commercial/orders/${created.body.id}`).set(authorization).expect(204);

    await expect(
      prisma.commercialOrder.findUnique({ where: { id: created.body.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.warehouseCoverageState.findUnique({ where: { orderId: created.body.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.domainEvent.findFirst({
        where: { objectId: created.body.id, type: 'audit:commercial_order_deleted' },
      }),
    ).resolves.toBeTruthy();
  });

  it('commits a slow deletion after production and finance handoff', async () => {
    const suffix = randomUUID().slice(0, 8);
    const login = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('commercial'), password: e2eSeedPassword() })
      .expect(201);
    const authorization = { Authorization: `Bearer ${login.body.token as string}` };
    const order = await prisma.commercialOrder.create({
      data: {
        orderNumber: `DELETE-PRODUCTION-${suffix}`,
        creatorRole: 'commercial',
        commercialStage: 'sent_to_finance',
        productionIndicator: 'in_production',
        positions: {
          create: {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
          },
        },
      },
      include: { positions: true },
    });
    const production = await prisma.productionOrder.create({
      data: {
        commercialOrderId: order.id,
        approvalState: 'approved',
        indicator: 'in_production',
      },
    });
    const dispatch = await prisma.rollDispatchItem.create({
      data: {
        rollCode: `DELETE-${suffix}`,
        productionOrderId: production.id,
        orderLineId: order.positions[0].id,
        status: 'in_progress',
      },
    });
    const operatorLine = await prisma.operatorRollLine.create({
      data: { rollDispatchItemId: dispatch.id, step: 'production' },
    });
    const finance = await prisma.financeOrder.create({
      data: { commercialOrderId: order.id, invoiceStatus: 'invoiced' },
    });
    const epochBefore = await prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({
      where: { id: 1 },
    });

    // Reproduce a populated aggregate taking longer than Prisma's default five seconds.
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_slow_order_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(6); RETURN OLD; END; $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_slow_order_delete BEFORE DELETE ON commercial_orders
      FOR EACH ROW EXECUTE FUNCTION test_slow_order_delete()
    `);
    try {
      await http().delete(`/api/commercial/orders/${order.id}`).set(authorization).expect(204);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER test_slow_order_delete ON commercial_orders');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_slow_order_delete()');
    }

    await expect(
      prisma.commercialOrder.findUnique({ where: { id: order.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.productionOrder.findUnique({ where: { id: production.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.rollDispatchItem.findUnique({ where: { id: dispatch.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.operatorRollLine.findUnique({ where: { id: operatorLine.id } }),
    ).resolves.toBeNull();
    await expect(prisma.financeOrder.findUnique({ where: { id: finance.id } })).resolves.toBeNull();
    await expect(
      prisma.warehouseCoverageInventoryEpoch.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toEqual(expect.objectContaining({ epoch: epochBefore.epoch + 1n }));
    await expect(
      prisma.domainEvent.findFirst({
        where: { objectId: order.id, type: 'audit:commercial_order_deleted' },
      }),
    ).resolves.toBeTruthy();
  });
});
